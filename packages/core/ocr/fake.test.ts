import { describe, expect, test } from "bun:test";
import { FakeOcrProvider, fakeImage, linesFromText } from "./fake.ts";
import { type OcrProvider, ocrText } from "./types.ts";

describe("FakeOcrProvider", () => {
	const provider: OcrProvider = new FakeOcrProvider({
		r1: linesFromText(["DemoMart", { text: "ยอดสุทธิ 64.00", confidence: 0.42 }]),
	});

	test("returns registered lines in order with box and confidence", async () => {
		const result = await provider.recognize(fakeImage("r1"));
		expect(result.provider).toBe("fake");
		expect(result.lines.map((l) => l.text)).toEqual([
			"DemoMart",
			"ยอดสุทธิ 64.00",
		]);
		expect(result.lines[0]?.confidence).toBe(0.99);
		expect(result.lines[1]?.confidence).toBe(0.42);
		expect(result.lines[0]?.box).toHaveLength(4);
		const firstTop = result.lines[0]?.box?.[0].y ?? 0;
		const secondTop = result.lines[1]?.box?.[0].y ?? 0;
		expect(secondTop).toBeGreaterThan(firstTop);
	});

	test("rejects unknown images instead of inventing text", async () => {
		await expect(provider.recognize(fakeImage("missing"))).rejects.toThrow(
			/no fixture/,
		);
	});

	test("callers cannot mutate stored fixtures", async () => {
		const first = await provider.recognize(fakeImage("r1"));
		const line = first.lines[0];
		if (line) line.text = "tampered";
		const second = await provider.recognize(fakeImage("r1"));
		expect(second.lines[0]?.text).toBe("DemoMart");
	});

	test("supports backends without confidence", () => {
		const lines = linesFromText([{ text: "x", confidence: null }]);
		expect(lines[0]?.confidence).toBeNull();
	});
});

describe("ocrText", () => {
	test("joins lines with newlines", () => {
		expect(ocrText({ lines: linesFromText(["a", "b"]) })).toBe("a\nb");
	});
});
