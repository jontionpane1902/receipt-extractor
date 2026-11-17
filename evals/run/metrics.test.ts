import { describe, expect, test } from "bun:test";
import { type Receipt, SCHEMA_VERSION } from "@receipt-extractor/core";
import type { ExpectedReceipt } from "./label.ts";
import {
	catalogOutcomes,
	checkEffectiveness,
	compareReceipt,
	distribution,
	fieldAccuracy,
	isFullyCorrect,
	percentile,
	rawNameCer,
} from "./metrics.ts";

function expected(): ExpectedReceipt {
	return {
		store_chain: "7-eleven",
		branch: { code: "00000", name: "สาขาทดสอบ" },
		tax_id: "9012345678902",
		receipt_number: "R1",
		datetime: "2026-11-17T14:05:00+07:00",
		items: [
			{
				raw_name: "น้ำดื่ม",
				normalized_name: "น้ำดื่ม",
				qty: 2,
				unit_price: 7,
				amount: 14,
			},
			{
				raw_name: "ขนมปัง",
				normalized_name: null,
				qty: 1,
				unit_price: 20,
				amount: 20,
			},
		],
		discounts: [],
		total: 34,
		vat: 2.22,
		payment: { method: "cash", tendered: 40 },
		change: 6,
		item_count: 3,
	};
}

function actual(over: Partial<Receipt> = {}): Receipt {
	return {
		...structuredClone(expected()),
		schema_version: SCHEMA_VERSION,
		datetime_raw: "17/11/69 14:05",
		field_confidence: {},
		needs_review: false,
		...over,
	};
}

describe("compareReceipt", () => {
	test("all fields correct for an identical extraction", () => {
		const outcomes = compareReceipt(expected(), actual());
		expect(isFullyCorrect(outcomes)).toBe(true);
		expect(outcomes["items.amount"]).toEqual([true, true]);
	});

	test("marks only the wrong fields", () => {
		const outcomes = compareReceipt(
			expected(),
			actual({ total: 43, vat: null }),
		);
		const wrong = Object.entries(outcomes)
			.filter(([, list]) => list.includes(false))
			.map(([field]) => field);
		expect(wrong).toEqual(["total", "vat"]);
	});

	test("compares money in satang and text in NFC", () => {
		const outcomes = compareReceipt(
			{ ...expected(), branch: { code: "00000", name: "café" } },
			actual({ total: 34.000000001, branch: { code: "00000", name: "café" } }),
		);
		expect(isFullyCorrect(outcomes)).toBe(true);
	});

	test("a missing item fails each of its fields and the item count", () => {
		const outcomes = compareReceipt(
			expected(),
			actual({ items: actual().items.slice(0, 1) }),
		);
		expect(outcomes["items.count"]).toEqual([false]);
		expect(outcomes["items.raw_name"]).toEqual([true, false]);
		expect(outcomes["items.amount"]).toEqual([true, false]);
	});
});

describe("fieldAccuracy", () => {
	test("micro-averages per field across receipts", () => {
		const accuracy = fieldAccuracy([
			compareReceipt(expected(), actual()),
			compareReceipt(expected(), actual({ total: 1, items: [] })),
		]);
		expect(accuracy.total).toEqual({ correct: 1, total: 2, rate: 0.5 });
		expect(accuracy["items.raw_name"]).toEqual({
			correct: 2,
			total: 4,
			rate: 0.5,
		});
	});
});

describe("rawNameCer", () => {
	test("is zero for identical names", () => {
		expect(rawNameCer(expected(), actual())).toEqual({ edits: 0, length: 8 });
	});

	test("counts edits in grapheme clusters", () => {
		const items = actual().items;
		const first = items[0];
		if (!first) throw new Error("no items");
		first.raw_name = "น้ำดืม"; // one cluster differs
		expect(rawNameCer(expected(), actual({ items }))).toEqual({
			edits: 1,
			length: 8,
		});
	});

	test("a missing item costs its full length", () => {
		expect(rawNameCer(expected(), actual({ items: [] })).edits).toBe(8);
	});
});

describe("catalogOutcomes", () => {
	test("null is correct when no match was expected", () => {
		expect(catalogOutcomes(expected(), actual())).toEqual([true, true]);
	});

	test("a wrong or unwanted normalisation is an error", () => {
		const items = actual().items;
		const [first, second] = items;
		if (!first || !second) throw new Error("no items");
		first.normalized_name = null;
		second.normalized_name = "ขนมปังแผ่น";
		expect(catalogOutcomes(expected(), actual({ items }))).toEqual([
			false,
			false,
		]);
	});
});

describe("distribution", () => {
	test("mean and nearest-rank percentiles", () => {
		const values = [10, 20, 30, 40, 100];
		expect(distribution(values)).toEqual({ mean: 40, p50: 30, p95: 100 });
		expect(percentile([5], 95)).toBe(5);
	});

	test("is null for no data rather than zero", () => {
		expect(distribution([])).toEqual({ mean: null, p50: null, p95: null });
	});
});

describe("checkEffectiveness", () => {
	test("builds the confusion matrix with recall and precision", () => {
		const result = checkEffectiveness([
			{ wrong: true, flagged: true },
			{ wrong: true, flagged: true },
			{ wrong: true, flagged: false },
			{ wrong: false, flagged: true },
			{ wrong: false, flagged: false },
		]);
		expect(result).toEqual({
			caught: 2,
			missed: 1,
			false_alarms: 1,
			clean: 1,
			recall: 2 / 3,
			precision: 2 / 3,
		});
	});

	test("rates are null when undefined", () => {
		const result = checkEffectiveness([{ wrong: false, flagged: false }]);
		expect(result.recall).toBeNull();
		expect(result.precision).toBeNull();
	});
});
