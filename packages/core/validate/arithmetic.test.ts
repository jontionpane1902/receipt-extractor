import { describe, expect, test } from "bun:test";
import { sampleReceipt } from "../schema/fixtures.ts";
import type { ReceiptItem } from "../schema/receipt.ts";
import {
	checkChange,
	checkItemCount,
	checkLineAmounts,
	checkTotal,
	checkVat,
} from "./arithmetic.ts";

const item = (over: Partial<ReceiptItem>): ReceiptItem => ({
	raw_name: "x",
	normalized_name: null,
	qty: 1,
	unit_price: 10,
	amount: 10,
	...over,
});

describe("checkLineAmounts", () => {
	test("passes on the sample receipt", () => {
		const results = checkLineAmounts(sampleReceipt());
		expect(results.map((r) => r.status)).toEqual(["pass", "pass", "pass"]);
	});

	test("fails with path, expected and actual when qty × price ≠ amount", () => {
		const [result] = checkLineAmounts(
			sampleReceipt({
				items: [item({ qty: 3, unit_price: 12.5, amount: 35 })],
			}),
		);
		expect(result).toMatchObject({
			check: "line_amount",
			status: "fail",
			path: "items[0].amount",
			expected: 37.5,
			actual: 35,
		});
		expect(result?.message).toContain("37.5");
	});

	test("is not fooled by float drift", () => {
		const [result] = checkLineAmounts(
			sampleReceipt({
				items: [item({ qty: 3, unit_price: 0.1, amount: 0.3 })],
			}),
		);
		expect(result?.status).toBe("pass");
	});

	test("skips items without a unit price", () => {
		const [result] = checkLineAmounts(
			sampleReceipt({ items: [item({ unit_price: null })] }),
		);
		expect(result?.status).toBe("skip");
	});
});

describe("checkTotal", () => {
	test("passes when lines − discounts = total", () => {
		expect(checkTotal(sampleReceipt()).status).toBe("pass");
	});

	test("fails when a discount is ignored", () => {
		const result = checkTotal(sampleReceipt({ total: 69 }));
		expect(result).toMatchObject({ status: "fail", expected: 64, actual: 69 });
	});

	test("fails on a receipt with no items", () => {
		expect(checkTotal(sampleReceipt({ items: [] })).status).toBe("fail");
	});
});

describe("checkVat", () => {
	test("passes for total × 7/107", () => {
		expect(checkVat(sampleReceipt()).status).toBe("pass");
		expect(checkVat(sampleReceipt({ total: 107, vat: 7 })).status).toBe("pass");
	});

	test("tolerates one satang of rounding, not two", () => {
		expect(checkVat(sampleReceipt({ vat: 4.18 })).status).toBe("pass");
		expect(checkVat(sampleReceipt({ vat: 4.2 })).status).toBe("pass");
		expect(checkVat(sampleReceipt({ vat: 4.21 })).status).toBe("fail");
	});

	test("fails when VAT was computed as 7% on top", () => {
		const result = checkVat(sampleReceipt({ vat: 4.48 }));
		expect(result).toMatchObject({ status: "fail", expected: 4.19 });
	});

	test("skips when VAT is not printed", () => {
		expect(checkVat(sampleReceipt({ vat: null })).status).toBe("skip");
	});
});

describe("checkChange", () => {
	test("passes when tendered − total = change", () => {
		expect(checkChange(sampleReceipt()).status).toBe("pass");
	});

	test("fails on wrong change", () => {
		const result = checkChange(sampleReceipt({ change: 46 }));
		expect(result).toMatchObject({ status: "fail", expected: 36, actual: 46 });
	});

	test("fails when tendered is less than total", () => {
		const result = checkChange(
			sampleReceipt({ payment: { method: "cash", tendered: 50 }, change: 0 }),
		);
		expect(result).toMatchObject({ status: "fail", path: "payment.tendered" });
	});

	test("skips when nothing to compare (e.g. QR payment)", () => {
		const result = checkChange(
			sampleReceipt({
				payment: { method: "qr", tendered: null },
				change: null,
			}),
		);
		expect(result.status).toBe("skip");
	});
});

describe("checkItemCount", () => {
	test("counts pieces by default", () => {
		expect(checkItemCount(sampleReceipt()).status).toBe("pass");
		expect(checkItemCount(sampleReceipt({ item_count: 3 }))).toMatchObject({
			status: "fail",
			expected: 3,
			actual: 4,
		});
	});

	test("can count lines instead", () => {
		expect(
			checkItemCount(sampleReceipt({ item_count: 3 }), "lines").status,
		).toBe("pass");
	});

	test("skips when no count is printed", () => {
		expect(checkItemCount(sampleReceipt({ item_count: null })).status).toBe(
			"skip",
		);
	});
});
