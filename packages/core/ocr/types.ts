/**
 * OCR boundary: image in → lines with box and confidence out.
 *
 * Every OCR backend (local OpenThai weights, iApp hosted API, a container,
 * the in-memory fake) implements `OcrProvider`. Nothing else in the codebase
 * may depend on a specific backend.
 */

export interface Point {
	x: number;
	y: number;
}

/**
 * Four corners in input-image pixel coordinates, ordered
 * top-left, top-right, bottom-right, bottom-left (the OpenThai 2.0 runtime's
 * order). A quad rather than x/y/w/h because receipt photos are skewed.
 */
export type Quad = readonly [Point, Point, Point, Point];

export interface OcrLine {
	text: string;
	/** Null when the backend does not return geometry. */
	box: Quad | null;
	/**
	 * 0..1, or null when the backend does not report it. Consumers must treat
	 * null as "unknown", never as high confidence.
	 */
	confidence: number | null;
}

export interface OcrResult {
	/** Lines in reading order: top to bottom, left to right. */
	lines: OcrLine[];
	/** Provider id, e.g. "fake", "openthai-local", "iapp-api". */
	provider: string;
	/** Model name/version as reported by the provider. */
	model: string;
	/** Wall-clock time spent in the provider. */
	duration_ms: number;
}

export interface OcrImage {
	bytes: Uint8Array;
	/** e.g. "image/jpeg", "image/png". */
	mime_type: string;
}

export interface OcrProvider {
	readonly name: string;
	recognize(image: OcrImage): Promise<OcrResult>;
}

/** All line texts joined with newlines, for grounding checks and prompts. */
export function ocrText(result: Pick<OcrResult, "lines">): string {
	return result.lines.map((line) => line.text).join("\n");
}
