import { describe, expect, test } from "bun:test";
import { linesFromText } from "../ocr/fake.ts";
import { SAMPLE_OCR_TEXT, sampleReceipt } from "../schema/fixtures.ts";
import { checkGrounding, squash } from "./grounding.ts";

const ocr = { lines: linesFromText(SAMPLE_OCR_TEXT) };
const failures = (results: ReturnType<typeof checkGrounding>) =>
	results.filter((r) => r.status === "fail");

describe("checkGrounding", () => {
	test("passes when every value appears in the OCR text", () => {
		const results = checkGrounding(sampleReceipt(), ocr);
		expect(failures(results)).toEqual([]);
		expect(results.length).toBeGreaterThan(10);
	});

	test("fails for a name the LLM 'fixed'", () => {
		const receipt = sampleReceipt();
		const first = receipt.items[0];
		if (!first) throw new Error("fixture has no items");
		first.raw_name = "น้ำดื่มตราทดสอบ 600 มิลลิลิตร";
		expect(failures(checkGrounding(receipt, ocr))).toMatchObject([
			{ check: "grounding", path: "items[0].raw_name" },
		]);
	});

	test("fails for a number that is not printed anywhere", () => {
		const result = failures(checkGrounding(sampleReceipt({ total: 46 }), ocr));
		expect(result).toMatchObject([{ path: "total", actual: 46 }]);
	});

	test("ignores spacing and letter-case differences in text", () => {
		const receipt = sampleReceipt();
		const third = receipt.items[2];
		if (!third) throw new Error("fixture is missing item 3");
		third.raw_name = "ชาเย็นหอม  demo tea";
		expect(failures(checkGrounding(receipt, ocr))).toEqual([]);
	});

	test("does not require quantity 1 to be printed, but does for others", () => {
		const receipt = sampleReceipt();
		const first = receipt.items[0];
		if (!first) throw new Error("fixture has no items");
		first.qty = 9;
		const paths = failures(checkGrounding(receipt, ocr)).map((r) => r.path);
		expect(paths).toEqual(["items[0].qty"]);
	});

	test("matches numbers by value: thousands separators and Thai digits", () => {
		const text = { lines: linesFromText(["รวม 1,234.50", "VAT ๘๐.๗๖"]) };
		const receipt = sampleReceipt({
			branch: { code: null, name: null },
			tax_id: null,
			receipt_number: null,
			datetime_raw: null,
			items: [],
			discounts: [],
			total: 1234.5,
			vat: 80.76,
			payment: { method: "unknown", tendered: null },
			change: null,
			item_count: null,
		});
		expect(failures(checkGrounding(receipt, text))).toEqual([]);
	});
});

describe("grounding with receipt-style numbers", () => {
	const bare = (over: object) =>
		sampleReceipt({
			branch: { code: null, name: null },
			tax_id: null,
			receipt_number: null,
			datetime_raw: null,
			items: [],
			discounts: [],
			total: 0,
			vat: null,
			payment: { method: "unknown", tendered: null },
			change: null,
			item_count: null,
			...over,
		});

	test("grounds a decimal comma, a spaced decimal and a suffixed amount", () => {
		const text = {
			lines: linesFromText(["รวม 219,75", "เงินทอน 80. 25", "นม 18,50N"]),
		};
		const receipt = bare({
			total: 219.75,
			change: 80.25,
			items: [
				{
					raw_name: "นม",
					normalized_name: null,
					qty: 1,
					unit_price: null,
					amount: 18.5,
				},
			],
		});
		expect(failures(checkGrounding(receipt, text))).toEqual([]);
	});

	test("a decimal comma is not read as a number a hundred times larger", () => {
		const text = { lines: linesFromText(["รวม 5,00"]) };
		expect(failures(checkGrounding(bare({ total: 500 }), text))).toMatchObject([
			{ path: "total" },
		]);
		expect(failures(checkGrounding(bare({ total: 5 }), text))).toEqual([]);
	});

	test("an @unit price does not ground a line amount", () => {
		const text = { lines: linesFromText(["ขนม 3 @12.00 36.00"]) };
		const item = {
			raw_name: "ขนม",
			normalized_name: null,
			qty: 3,
			unit_price: 12,
		};
		expect(
			failures(
				checkGrounding(
					bare({ total: 36, items: [{ ...item, amount: 36 }] }),
					text,
				),
			),
		).toEqual([]);
		// The structurer put the unit price where the amount belongs.
		expect(
			failures(
				checkGrounding(
					bare({ total: 36, items: [{ ...item, amount: 12 }] }),
					text,
				),
			).map((f) => f.path),
		).toEqual(["items[0].amount"]);
	});

	test("an ambiguous number grounds nothing", () => {
		const text = { lines: linesFromText(["รวม 12,5"]) };
		expect(failures(checkGrounding(bare({ total: 12.5 }), text))).toHaveLength(
			1,
		);
		expect(failures(checkGrounding(bare({ total: 125 }), text))).toHaveLength(
			1,
		);
	});
});

describe("helpers", () => {
	test("squash normalises composed forms, whitespace and case", () => {
		expect(squash(" DEMO  Tea\n")).toBe("demotea");
		expect(squash("é")).toBe("é");
	});
});
