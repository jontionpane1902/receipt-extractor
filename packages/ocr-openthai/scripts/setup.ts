/**
 * One-command setup for the local OpenThai OCR provider:
 *
 *   bun run ocr:setup
 *
 * 1. creates a project-local virtual environment (python/.venv),
 * 2. installs the pinned, hash-locked dependencies into it,
 * 3. downloads the pinned model revision and verifies its checksums.
 *
 * Nothing is installed outside this repository. Requires `uv`
 * (https://docs.astral.sh/uv/) and a Python matching python/.python-version.
 */
import { PYTHON_DIR, venvPython } from "../paths.ts";

function run(label: string, command: string[]): void {
	console.log(`\n> ${label}`);
	const result = Bun.spawnSync(command, {
		cwd: PYTHON_DIR,
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (!result.success) {
		console.error(`\nfailed: ${command.join(" ")}`);
		process.exit(result.exitCode ?? 1);
	}
}

if (!Bun.which("uv")) {
	console.error(
		"uv is required but was not found on PATH.\nInstall it (https://docs.astral.sh/uv/getting-started/installation/) and run this again.",
	);
	process.exit(1);
}

run("create virtual environment (python/.venv)", [
	"uv",
	"venv",
	"--allow-existing",
	".venv",
]);
run("install pinned dependencies", [
	"uv",
	"pip",
	"sync",
	"--python",
	venvPython(),
	"--require-hashes",
	"requirements.txt",
]);
run("download and verify model weights", [venvPython(), "download_weights.py"]);
console.log("\nLocal OCR is ready. Try: bun run test:ocr");
