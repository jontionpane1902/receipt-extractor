import { join } from "node:path";
import { parseArgs } from "node:util";
import type { OcrProvider } from "@receipt-extractor/core";
import { LabelSchema } from "./label.ts";
import { evaluateOcrAgainstLabel, formatOcrLevelReport } from "./ocr-level.ts";
import { formatRun } from "./report.ts";
import { DATASET_DIR, runSyntheticEval } from "./synthetic.ts";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		dataset: { type: "string", default: "synthetic" },
		/** fake (default, offline) | openthai-local (real model, needs `bun run ocr:setup`) */
		ocr: { type: "string", default: "fake" },
		"ocr-backend": { type: "string" },
		"no-ocr-cache": { type: "boolean", default: false },
		"no-write": { type: "boolean", default: false },
		/** OCR-level eval of one label file against its image. Prints only; never writes results. */
		label: { type: "string" },
		"hide-text": { type: "boolean", default: false },
		/** With --label: score this file instead of the label's image (e.g. a rescan). PDFs are rendered locally. */
		image: { type: "string" },
		"pdf-scale": { type: "string" },
		"pdf-page": { type: "string" },
	},
});

if (values.label === undefined && values.dataset !== "synthetic") {
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

if (values.label !== undefined) {
	if (values.ocr === "fake") {
		console.error(
			"--label needs a real OCR provider: add --ocr openthai-local",
		);
		process.exit(2);
	}
	const label = LabelSchema.parse(await Bun.file(values.label).json());
	if (label.image === null && values.image === undefined) {
		console.error("label has no image");
		process.exit(2);
	}
	const { isPdf, renderPdfPage } = await import(
		"@receipt-extractor/ocr-openthai"
	);
	let imagePath = values.image ?? join(DATASET_DIR, label.image ?? "");
	if (await isPdf(imagePath)) {
		const pdf = await renderPdfPage(imagePath, {
			...(values["pdf-scale"] ? { scale: Number(values["pdf-scale"]) } : {}),
			...(values["pdf-page"] ? { page: Number(values["pdf-page"]) } : {}),
		});
		console.log(
			`pdf: page ${pdf.page} of ${pdf.page_count}, embedded image ${pdf.images.map((i) => `${i.width}x${i.height}`).join(", ") || "none"}, rendered ${pdf.render.width}x${pdf.render.height} px (${pdf.render.mode})`,
		);
		imagePath = pdf.render.png;
	}
	const provider = await openOcr();
	try {
		if (!provider.provider) throw new Error("no OCR provider");
		const result = await provider.provider.recognize({
			bytes: new Uint8Array(await Bun.file(imagePath).arrayBuffer()),
			mime_type: "application/octet-stream",
		});
		const report = await evaluateOcrAgainstLabel(label, result, new Date());
		console.log(
			formatOcrLevelReport(report, { showText: !values["hide-text"] }),
		);
	} finally {
		await provider.close();
	}
	process.exit(0);
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
