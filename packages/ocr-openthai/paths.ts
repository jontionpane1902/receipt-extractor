import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** packages/ocr-openthai/python */
export const PYTHON_DIR = join(import.meta.dir, "python");
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const DEFAULT_MODELS_ROOT = join(REPO_ROOT, "models");
export const DEFAULT_CACHE_DIR = join(REPO_ROOT, ".cache", "ocr");
export const SETUP_HINT = "Run `bun run ocr:setup` first.";

export interface ModelPin {
	repo: string;
	revision: string;
	sha256sums_sha256: string;
	files: string[];
}

/** What python/download_weights.py wrote next to the weights. */
export interface ModelManifest {
	repo: string;
	revision: string;
	sha256sums_sha256: string;
	files: Record<string, string>;
	downloaded_at: string;
}

export function venvPython(pythonDir: string = PYTHON_DIR): string {
	return process.platform === "win32"
		? join(pythonDir, ".venv", "Scripts", "python.exe")
		: join(pythonDir, ".venv", "bin", "python");
}

export function readModelPin(pythonDir: string = PYTHON_DIR): ModelPin {
	return JSON.parse(readFileSync(join(pythonDir, "model-pin.json"), "utf8"));
}

/** Mirrors default_model_dir() in python/openthai_ocr/weights.py. */
export function pinnedModelDir(
	modelsRoot: string = DEFAULT_MODELS_ROOT,
	pin: ModelPin = readModelPin(),
): string {
	const name = pin.repo.split("/").at(-1)?.toLowerCase() ?? pin.repo;
	return join(modelsRoot, name, pin.revision);
}

/** Reads the manifest, or throws with the setup command if the model is not there. */
export function readModelManifest(modelDir: string): ModelManifest {
	const path = join(modelDir, "manifest.json");
	if (!existsSync(path)) {
		throw new Error(
			`OpenThai OCR model not found at ${modelDir}. ${SETUP_HINT}`,
		);
	}
	return JSON.parse(readFileSync(path, "utf8"));
}
