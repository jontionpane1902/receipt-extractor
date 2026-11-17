import type { OcrImage, OcrProvider, OcrResult } from "./types.ts";

/**
 * Storage boundary for cached OCR results. Core only knows this interface;
 * a disk implementation lives with the local provider.
 */
export interface OcrCacheStore {
	get(key: OcrCacheKey): Promise<OcrResult | null>;
	set(key: OcrCacheKey, result: OcrResult): Promise<void>;
}

export interface OcrCacheKey {
	/** What produced the result: provider + model revision (+ backend). */
	variant: string;
	/** SHA-256 of the image bytes, lower-case hex. */
	image_sha256: string;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export class InMemoryOcrCacheStore implements OcrCacheStore {
	readonly #entries = new Map<string, OcrResult>();

	async get(key: OcrCacheKey): Promise<OcrResult | null> {
		const hit = this.#entries.get(`${key.variant}\u0000${key.image_sha256}`);
		return hit ? structuredClone(hit) : null;
	}

	async set(key: OcrCacheKey, result: OcrResult): Promise<void> {
		this.#entries.set(
			`${key.variant}\u0000${key.image_sha256}`,
			structuredClone(result),
		);
	}
}

/**
 * Wraps a provider so the same image is read once per model revision.
 *
 * The key is the image's SHA-256 plus `variant`, which must change whenever
 * the output could change (model revision, backend). Iterating on prompts
 * then costs no OCR time, and a new model revision never serves stale text.
 * Failures are never cached.
 */
export class CachedOcrProvider implements OcrProvider {
	readonly name: string;
	readonly #inner: OcrProvider;
	readonly #store: OcrCacheStore;
	readonly #variant: string;

	constructor(inner: OcrProvider, store: OcrCacheStore, variant: string) {
		this.name = inner.name;
		this.#inner = inner;
		this.#store = store;
		this.#variant = variant;
	}

	async recognize(image: OcrImage): Promise<OcrResult> {
		const key: OcrCacheKey = {
			variant: this.#variant,
			image_sha256: await sha256Hex(image.bytes),
		};
		const hit = await this.#store.get(key);
		if (hit) return { ...hit, cache_hit: true };
		const result = await this.#inner.recognize(image);
		const { cache_hit: _ignored, ...storable } = result;
		await this.#store.set(key, storable);
		return { ...storable, cache_hit: false };
	}
}
