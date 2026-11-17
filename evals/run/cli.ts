import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatRun } from "./report.ts";
import { runSyntheticEval } from "./synthetic.ts";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		dataset: { type: "string", default: "synthetic" },
		"no-write": { type: "boolean", default: false },
	},
});

if (values.dataset !== "synthetic") {
	console.error(
		`Dataset "${values.dataset}" is not runnable yet: only "synthetic" works until a real OCR provider and LLM structurer exist. See evals/README.md.`,
	);
	process.exit(2);
}

function gitCommit(): string | null {
	const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
	return result.success ? result.stdout.toString().trim() : null;
}

const run = await runSyntheticEval({ now: new Date(), gitCommit: gitCommit() });
console.log(formatRun(run));

if (!values["no-write"]) {
	const stamp = run.created_at.replace(/[:.]/g, "-");
	const file = join(
		import.meta.dir,
		"..",
		"results",
		`synthetic-${stamp}.json`,
	);
	await Bun.write(file, `${JSON.stringify(run, null, "\t")}\n`);
	console.log(`written: ${file} (git-ignored)`);
}
