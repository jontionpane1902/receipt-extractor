import { join } from "node:path";
import { parseArgs } from "node:util";
import type { OcrProvider } from "@receipt-extractor/core";
import { formatRun } from "./report.ts";
import { runSyntheticEval } from "./synthetic.ts";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		dataset: { type: "string", default: "synthetic" },
		/** fake (default, offline) | openthai-local (real model, needs `bun run ocr:setup`) */
		ocr: { type: "string", default: "fake" },
		"ocr-backend": { type: "string" },
		"no-ocr-cache": { type: "boolean", default: false },
		"no-write": { type: "boolean", default: false },
	},
});

if (values.dataset !== "synthetic") {
	console.error(
		`Dataset "${values.dataset}" is not runnable yet: only "synthetic" works until an LLM structurer and real labels exist. See evals/README.md.`,
	);
	process.exit(2);
}

function gitCommit(): string | null {
	const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
	return result.success ? result.stdout.toString().trim() : null;
}

/** Real providers are imported only when asked for, so the default run stays offline. */
async function openOcr(): Promise<{
	provider?: OcrProvider;
	close(): Promise<void>;
}> {
	if (values.ocr === "fake") return { close: async () => {} };
	if (values.ocr !== "openthai-local") {
		console.error(
			`Unknown --ocr "${values.ocr}". Use "fake" or "openthai-local".`,
		);
		process.exit(2);
	}
	const backend = values["ocr-backend"];
	if (
		backend !== undefined &&
		backend !== "openvino" &&
		backend !== "onnxruntime"
	) {
		console.error(
			`Unknown --ocr-backend "${backend}". Use "openvino" or "onnxruntime".`,
		);
		process.exit(2);
	}
	const { createLocalOpenThaiOcr } = await import(
		"@receipt-extractor/ocr-openthai"
	);
	const local = createLocalOpenThaiOcr(backend ? { backend } : {});
	return {
		provider: values["no-ocr-cache"] ? local.local : local.provider,
		close: local.close,
	};
}

const ocr = await openOcr();
try {
	const run = await runSyntheticEval({
		now: new Date(),
		gitCommit: gitCommit(),
		...(ocr.provider ? { ocr: ocr.provider } : {}),
	});
	console.log(formatRun(run));

	if (!values["no-write"]) {
		const stamp = run.created_at.replace(/[:.]/g, "-");
		const file = join(
			import.meta.dir,
			"..",
			"results",
			`synthetic-${run.ocr_provider}-${stamp}.json`,
		);
		await Bun.write(file, `${JSON.stringify(run, null, "\t")}\n`);
		console.log(`written: ${file} (git-ignored)`);
	}
} finally {
	await ocr.close();
}
