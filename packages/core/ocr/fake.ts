import type {
	OcrImage,
	OcrLine,
	OcrProvider,
	OcrResult,
	Quad,
} from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Stand-in "image" for the fake provider: the bytes are just the fixture id.
 * Keeps tests and the eval skeleton free of real image files.
 */
export function fakeImage(id: string): OcrImage {
	return { bytes: encoder.encode(id), mime_type: "application/x-fake-image" };
}

export interface FakeLineInput {
	text: string;
	confidence?: number | null | undefined;
}

/**
 * Builds OCR lines from plain text with synthetic boxes stacked top to
 * bottom (one 40px row per line). Confidence defaults to 0.99.
 */
export function linesFromText(
	lines: readonly (string | FakeLineInput)[],
): OcrLine[] {
	return lines.map((input, index) => {
		const line = typeof input === "string" ? { text: input } : input;
		const top = index * 40;
		const width = Math.max(1, line.text.length) * 12;
		const box: Quad = [
			{ x: 0, y: top },
			{ x: width, y: top },
			{ x: width, y: top + 32 },
			{ x: 0, y: top + 32 },
		];
		return {
			text: line.text,
			box,
			confidence: line.confidence === undefined ? 0.99 : line.confidence,
		};
	});
}

/** In-memory OCR provider for tests and the eval skeleton. No I/O. */
export class FakeOcrProvider implements OcrProvider {
	readonly name = "fake";
	readonly #fixtures = new Map<string, OcrLine[]>();

	constructor(fixtures: Record<string, OcrLine[]> = {}) {
		for (const [id, lines] of Object.entries(fixtures)) this.set(id, lines);
	}

	set(id: string, lines: OcrLine[]): void {
		this.#fixtures.set(id, lines);
	}

	async recognize(image: OcrImage): Promise<OcrResult> {
		const id = decoder.decode(image.bytes);
		const lines = this.#fixtures.get(id);
		if (!lines) {
			throw new Error(`FakeOcrProvider: no fixture registered for "${id}"`);
		}
		return {
			lines: structuredClone(lines),
			provider: this.name,
			model: "fake-ocr-0",
			duration_ms: 0,
		};
	}
}
