import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type OcrCacheKey,
	type OcrCacheStore,
	type OcrResult,
	parseOcrResult,
} from "@receipt-extractor/core";

const CACHE_FORMAT = 1;

/**
 * OCR results as JSON files: <dir>/<variant>/<image sha256>.json.
 *
 * The directory must be git-ignored: OCR text of a real receipt is as
 * private as the receipt. An unreadable, corrupt or mismatching file is
 * treated as a miss, never as a result.
 */
export class DiskOcrCacheStore implements OcrCacheStore {
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	pathFor(key: OcrCacheKey): string {
		if (!/^[0-9a-f]{64}$/.test(key.image_sha256)) {
			throw new Error(`not a SHA-256 hex digest: ${key.image_sha256}`);
		}
		// The variant holds a repo name and revision; keep it a single safe folder name.
		const folder = key.variant
			.replace(/[^A-Za-z0-9._@+-]/g, "_")
			.replace(/^\.+/, "_");
		return join(this.#dir, folder, `${key.image_sha256}.json`);
	}

	async get(key: OcrCacheKey): Promise<OcrResult | null> {
		let text: string;
		try {
			text = await readFile(this.pathFor(key), "utf8");
		} catch {
			return null;
		}
		try {
			const entry = JSON.parse(text);
			if (
				entry?.format !== CACHE_FORMAT ||
				entry.variant !== key.variant ||
				entry.image_sha256 !== key.image_sha256
			) {
				return null;
			}
			return parseOcrResult(entry.result);
		} catch {
			return null;
		}
	}

	async set(key: OcrCacheKey, result: OcrResult): Promise<void> {
		const path = this.pathFor(key);
		await mkdir(dirname(path), { recursive: true });
		const entry = { format: CACHE_FORMAT, ...key, result };
		// Write then rename, so a crash never leaves a half-written entry.
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(entry, null, "\t")}\n`);
		await rename(temporary, path);
	}
}
