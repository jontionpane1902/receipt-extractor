import { describe, expect, test } from "bun:test";
import type { OcrDroppedLine, OcrLine, Quad } from "../ocr/types.ts";
import {
	quantityCandidatesFromDropped,
	resolveQuantities,
} from "./quantity.ts";

const box = (x: number, row: number): Quad => [
	{ x, y: row * 40 },
	{ x: x + 20, y: row * 40 },
	{ x: x + 20, y: row * 40 + 30 },
	{ x, y: row * 40 + 30 },
];
const kept = (text: string, row: number, x: number): OcrLine => ({
	text,
	row,
	box: box(x, row),
	confidence: 0.95,
});
const dropped = (
	text: string,
	row: number,
	x: number,
	over: Partial<OcrDroppedLine> = {},
): OcrDroppedLine => ({
	text,
	row,
	box: box(x, row),
	confidence: 0.7,
	reason: "low_confidence",
	...over,
});

describe("quantityCandidatesFromDropped", () => {
	const lines = [
		kept("ขนมปังสังขยา", 0, 60),
		kept("15.00", 0, 400),
		kept("ชาเขียวเย็น", 1, 60),
		kept("50.00", 1, 400),
		kept("รวม", 2, 10),
	];

	test("a dropped digit left of the row's text is a quantity candidate", () => {
		const found = quantityCandidatesFromDropped({
			lines,
			dropped: [
				dropped("1", 0, 10),
				dropped("2", 1, 10, { reason: "too_short", confidence: 0.99 }),
			],
		});
		expect(found.get(0)).toEqual({
			row: 0,
			qty: 1,
			confidence: 0.7,
			dropped_reason: "low_confidence",
		});
		expect(found.get(1)).toMatchObject({ qty: 2, dropped_reason: "too_short" });
	});

	test("ignores dropped text that is not a small whole number", () => {
		const found = quantityCandidatesFromDropped({
			lines,
			dropped: [
				dropped("]", 0, 10),
				dropped("s", 1, 10),
				dropped("0", 0, 10),
				dropped("123", 1, 10),
				dropped("1.5", 1, 10),
			],
		});
		expect(found.size).toBe(0);
	});

	test("ignores a digit that is not at the start of the row", () => {
		const found = quantityCandidatesFromDropped({
			lines,
			dropped: [dropped("3", 0, 200), dropped("1", 2, 300)],
		});
		expect(found.size).toBe(0);
	});

	test("two digit-lines on one row are ambiguous: no candidate", () => {
		const found = quantityCandidatesFromDropped({
			lines,
			dropped: [dropped("1", 0, 10), dropped("7", 0, 30)],
		});
		expect(found.has(0)).toBe(false);
	});

	test("needs geometry and a kept line on the same row", () => {
		expect(
			quantityCandidatesFromDropped({
				lines,
				dropped: [{ ...dropped("1", 0, 10), box: null }, dropped("1", 9, 10)],
			}).size,
		).toBe(0);
		expect(quantityCandidatesFromDropped({ lines }).size).toBe(0);
	});
});

describe("resolveQuantities", () => {
	const d = (qty: number) => ({
		qty,
		source: "dropped" as const,
		confidence: 0.7,
	});
	const p = (qty: number) => ({ qty, source: "printed" as const });

	test("recovered quantities are low trust until the item count confirms them", () => {
		const unverified = resolveQuantities([d(1), d(2)], null);
		expect(unverified.status).toBe("unverified");
		expect(unverified.quantities.map((q) => q.trust)).toEqual(["low", "low"]);

		const confirmed = resolveQuantities([d(1), d(2), p(1)], 4);
		expect(confirmed.status).toBe("confirmed");
		expect(confirmed.quantities.map((q) => [q.qty, q.source, q.trust])).toEqual(
			[
				[1, "dropped", "confirmed"],
				[2, "dropped", "confirmed"],
				[1, "printed", "normal"],
			],
		);
	});

	test("a contradiction with the printed count is a mismatch, nothing is confirmed", () => {
		const result = resolveQuantities([d(1), d(7)], 3);
		expect(result.status).toBe("mismatch");
		expect(result.quantities.map((q) => q.trust)).toEqual(["low", "low"]);
		expect(resolveQuantities([d(2), null, null], 3).status).toBe("mismatch");
	});

	test("missing quantities are deduced as 1 when the count leaves no other option", () => {
		const result = resolveQuantities([d(1), null, d(3), null, null], 7);
		expect(result.status).toBe("deduced");
		expect(result.quantities.map((q) => [q.qty, q.source])).toEqual([
			[1, "dropped"],
			[1, "deduced"],
			[3, "dropped"],
			[1, "deduced"],
			[1, "deduced"],
		]);
		expect(result.quantities.every((q) => q.trust === "confirmed")).toBe(true);
	});

	test("a single missing quantity is the remainder", () => {
		const result = resolveQuantities([p(1), null, d(1)], 6);
		expect(result.status).toBe("deduced");
		expect(result.quantities[1]).toMatchObject({ qty: 4, source: "deduced" });
	});

	test("several missing quantities with pieces to spare are left unknown", () => {
		const result = resolveQuantities([d(1), null, null], 5);
		expect(result.status).toBe("unresolved");
		expect(result.quantities.map((q) => q.qty)).toEqual([1, null, null]);
	});

	test("nothing known and no count: everything stays unknown", () => {
		const result = resolveQuantities([null, null], null);
		expect(result.quantities).toEqual([
			{ qty: null, source: null, trust: null, confidence: null },
			{ qty: null, source: null, trust: null, confidence: null },
		]);
	});
});
