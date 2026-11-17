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
	/**
	 * Reading-order row, when the backend reports one. Several lines can share
	 * a row: a receipt's item name and its price are usually two lines on the
	 * same row.
	 */
	row?: number;
}

/** A line the backend read but filtered out (e.g. below its confidence floor). */
export interface OcrDroppedLine extends OcrLine {
	reason: string;
}

export interface OcrResult {
	/** Lines in reading order: top to bottom, left to right. */
	lines: OcrLine[];
	/** Provider id, e.g. "fake", "openthai-local", "iapp-api". */
	provider: string;
	/** Model name/version as reported by the provider. */
	model: string;
	/**
	 * Wall-clock time the provider spent reading this image. A cached result
	 * keeps the time of the original read, so latency numbers stay honest.
	 */
	duration_ms: number;
	/** Lines the backend discarded, when it reports them. Not part of `lines`. */
	dropped?: OcrDroppedLine[];
	/** True when the result came from a cache instead of running the model. */
	cache_hit?: boolean;
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

/**
 * The page as text, for grounding checks and prompts: one printed row per
 * text line. Lines that share a `row` are joined with a space; lines without
 * a row each get their own text line.
 */
export function ocrText(result: Pick<OcrResult, "lines">): string {
	const rows: string[] = [];
	let previousRow: number | undefined;
	for (const line of result.lines) {
		if (line.row !== undefined && line.row === previousRow) {
			rows[rows.length - 1] += ` ${line.text}`;
		} else {
			rows.push(line.text);
		}
		previousRow = line.row;
	}
	return rows.join("\n");
}
