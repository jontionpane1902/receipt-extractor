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
	const PIECES = { countRule: "pieces" as const };

	describe("default: the counting rule is unknown, the count is a soft signal", () => {
		test("recovered quantities are low trust without a count", () => {
			const result = resolveQuantities([d(1), d(2)], null);
			expect(result.status).toBe("unverified");
			expect(result.quantities.map((q) => q.trust)).toEqual(["low", "low"]);
		});

		test("the count can confirm quantities that are all known and add up", () => {
			const result = resolveQuantities([d(1), d(2), p(1)], 4);
			expect(result.status).toBe("confirmed");
			expect(result.quantities.map((q) => [q.qty, q.source, q.trust])).toEqual([
				[1, "dropped", "confirmed"],
				[2, "dropped", "confirmed"],
				[1, "printed", "normal"],
			]);
		});

		test("the count never invents a missing quantity", () => {
			// Under a pieces rule these would all be deduced; here nothing is.
			for (const [items, count] of [
				[[d(1), null, d(3), null, null], 7],
				[[p(1), null, d(1)], 6],
				[[null, null, null], 3],
			] as const) {
				const result = resolveQuantities(items, count);
				expect(result.status).toBe("unverified");
				expect(result.quantities.map((q) => q.qty)).toEqual(
					items.map((item) => item?.qty ?? null),
				);
				expect(result.quantities.some((q) => q.source === "deduced")).toBe(
					false,
				);
				expect(result.quantities.some((q) => q.trust === "confirmed")).toBe(
					false,
				);
			}
		});

		test("a count that counts something else does not contradict correct quantities", () => {
			// Seven rows worth eight pieces, but the receipt prints 5: the
			// quantities are right and the count follows another rule.
			const result = resolveQuantities(
				[p(1), p(1), p(1), p(1), p(1), p(2), p(1)],
				5,
			);
			expect(result.status).toBe("unverified");
			expect(result.message).toContain("not established");
			expect(result.quantities.map((q) => q.qty)).toEqual([
				1, 1, 1, 1, 1, 2, 1,
			]);
		});

		test("a count that happens to fit a wrong partial deduction is not used", () => {
			// Two of four quantities recovered (sum 3), printed count 5: a
			// pieces rule would "deduce" 1 + 1 and confirm everything.
			const soft = resolveQuantities([d(1), d(2), null, null], 5);
			expect(soft.status).toBe("unverified");
			expect(soft.quantities.map((q) => q.qty)).toEqual([1, 2, null, null]);
			expect(
				resolveQuantities([d(1), d(2), null, null], 5, PIECES).status,
			).toBe("deduced");
		});
	});

	describe("pieces rule, for a layout where the count is established", () => {
		test("a contradiction is a mismatch, nothing is confirmed", () => {
			const result = resolveQuantities([d(1), d(7)], 3, PIECES);
			expect(result.status).toBe("mismatch");
			expect(result.quantities.map((q) => q.trust)).toEqual(["low", "low"]);
			expect(resolveQuantities([d(2), null, null], 3, PIECES).status).toBe(
				"mismatch",
			);
		});

		test("missing quantities are deduced as 1 when the count leaves no other option", () => {
			const result = resolveQuantities(
				[d(1), null, d(3), null, null],
				7,
				PIECES,
			);
			expect(result.status).toBe("deduced");
			expect(result.quantities.map((q) => [q.qty, q.source])).toEqual([
				[1, "dropped"],
				[1, "deduced"],
				[3, "dropped"],
				[1, "deduced"],
				[1, "deduced"],
			]);
			expect(result.quantities.every((q) => q.trust === "confirmed")).toBe(
				true,
			);
		});

		test("a single missing quantity is the remainder", () => {
			const result = resolveQuantities([p(1), null, d(1)], 6, PIECES);
			expect(result.status).toBe("deduced");
			expect(result.quantities[1]).toMatchObject({ qty: 4, source: "deduced" });
		});

		test("several missing quantities with pieces to spare are left unknown", () => {
			const result = resolveQuantities([d(1), null, null], 5, PIECES);
			expect(result.status).toBe("unresolved");
			expect(result.quantities.map((q) => q.qty)).toEqual([1, null, null]);
		});
	});

	test("nothing known and no count: everything stays unknown", () => {
		const result = resolveQuantities([null, null], null);
		expect(result.quantities).toEqual([
			{ qty: null, source: null, trust: null, confidence: null },
			{ qty: null, source: null, trust: null, confidence: null },
		]);
	});
});
