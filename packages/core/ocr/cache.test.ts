import { describe, expect, test } from "bun:test";
import {
	CachedOcrProvider,
	InMemoryOcrCacheStore,
	sha256Hex,
} from "./cache.ts";
import { linesFromText } from "./fake.ts";
import { parseOcrResult } from "./schema.ts";
import type { OcrImage, OcrProvider, OcrResult } from "./types.ts";
import { ocrText } from "./types.ts";

const image = (text: string): OcrImage => ({
	bytes: new TextEncoder().encode(text),
	mime_type: "image/png",
});

/** Counts calls and returns the image text as one line. */
class CountingProvider implements OcrProvider {
	readonly name = "counting";
	calls = 0;
	failNext = false;

	async recognize(input: OcrImage): Promise<OcrResult> {
		this.calls++;
		if (this.failNext) {
			this.failNext = false;
			throw new Error("boom");
		}
		return {
			lines: linesFromText([new TextDecoder().decode(input.bytes)]),
			provider: this.name,
			model: "m",
			duration_ms: 250,
		};
	}
}

describe("sha256Hex", () => {
	test("matches a known digest", async () => {
		expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("CachedOcrProvider", () => {
	test("reads an image once, then serves it from the cache", async () => {
		const inner = new CountingProvider();
		const cached = new CachedOcrProvider(
			inner,
			new InMemoryOcrCacheStore(),
			"rev1",
		);

		const first = await cached.recognize(image("a"));
		const second = await cached.recognize(image("a"));

		expect(inner.calls).toBe(1);
		expect(first.cache_hit).toBe(false);
		expect(second.cache_hit).toBe(true);
		expect(second.lines).toEqual(first.lines);
		expect(cached.name).toBe("counting");
	});

	test("a hit keeps the original OCR duration", async () => {
		const cached = new CachedOcrProvider(
			new CountingProvider(),
			new InMemoryOcrCacheStore(),
			"rev1",
		);
		await cached.recognize(image("a"));
		expect((await cached.recognize(image("a"))).duration_ms).toBe(250);
	});

	test("different images are different entries", async () => {
		const inner = new CountingProvider();
		const cached = new CachedOcrProvider(
			inner,
			new InMemoryOcrCacheStore(),
			"rev1",
		);
		await cached.recognize(image("a"));
		const other = await cached.recognize(image("b"));
		expect(inner.calls).toBe(2);
		expect(other.lines[0]?.text).toBe("b");
	});

	test("a new model revision does not reuse old results", async () => {
		const inner = new CountingProvider();
		const store = new InMemoryOcrCacheStore();
		await new CachedOcrProvider(inner, store, "rev1").recognize(image("a"));
		const next = await new CachedOcrProvider(inner, store, "rev2").recognize(
			image("a"),
		);
		expect(inner.calls).toBe(2);
		expect(next.cache_hit).toBe(false);
	});

	test("failures are not cached", async () => {
		const inner = new CountingProvider();
		const cached = new CachedOcrProvider(
			inner,
			new InMemoryOcrCacheStore(),
			"rev1",
		);
		inner.failNext = true;
		await expect(cached.recognize(image("a"))).rejects.toThrow("boom");
		expect((await cached.recognize(image("a"))).cache_hit).toBe(false);
		expect(inner.calls).toBe(2);
	});

	test("callers cannot mutate cached entries", async () => {
		const cached = new CachedOcrProvider(
			new CountingProvider(),
			new InMemoryOcrCacheStore(),
			"rev1",
		);
		const first = await cached.recognize(image("a"));
		const line = first.lines[0];
		if (line) line.text = "tampered";
		expect((await cached.recognize(image("a"))).lines[0]?.text).toBe("a");
	});
});

describe("parseOcrResult", () => {
	const valid: OcrResult = {
		lines: [
			{
				...linesFromText(["x"])[0],
				text: "x",
				box: null,
				confidence: 0.5,
				row: 0,
			},
		],
		provider: "p",
		model: "m",
		duration_ms: 1,
		dropped: [
			{ text: "y", box: null, confidence: 0.1, reason: "low_confidence" },
		],
	};

	test("round-trips a valid result", () => {
		expect(parseOcrResult(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
	});

	test("rejects malformed data instead of guessing", () => {
		expect(parseOcrResult(null)).toBeNull();
		expect(parseOcrResult({ ...valid, lines: [{ text: "x" }] })).toBeNull();
		expect(
			parseOcrResult({
				...valid,
				lines: [{ text: "x", box: null, confidence: 1.5 }],
			}),
		).toBeNull();
		expect(
			parseOcrResult({
				...valid,
				lines: [{ text: "x", box: [{ x: 0, y: 0 }], confidence: 1 }],
			}),
		).toBeNull();
	});
});

describe("ocrText with rows", () => {
	test("joins lines that share a row, like the printed receipt", () => {
		const lines = [
			{ text: "กาแฟเย็น", box: null, confidence: 1, row: 0 },
			{ text: "35.00", box: null, confidence: 1, row: 0 },
			{ text: "ส่วนลด", box: null, confidence: 1, row: 1 },
			{ text: "-5.00", box: null, confidence: 1, row: 1 },
			{ text: "no row a", box: null, confidence: 1 },
			{ text: "no row b", box: null, confidence: 1 },
		];
		expect(ocrText({ lines })).toBe(
			"กาแฟเย็น 35.00\nส่วนลด -5.00\nno row a\nno row b",
		);
	});
});
