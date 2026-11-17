import { join } from "node:path";

/** Command that runs the stub worker with this same Bun binary. */
export function stubCommand(
	mode = "ok",
	revision = "stubrev",
): readonly [string, ...string[]] {
	return [
		process.execPath,
		join(import.meta.dir, "stub-worker.ts"),
		"--mode",
		mode,
		"--revision",
		revision,
	];
}

export const image = (text: string) => ({
	bytes: new TextEncoder().encode(text),
	mime_type: "image/png",
});
