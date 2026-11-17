import { describe, expect, test } from "bun:test";
import { linesFromText } from "../ocr/fake.ts";
import { SAMPLE_OCR_TEXT, sampleReceipt } from "../schema/fixtures.ts";
import { checkGrounding, numbersIn, squash } from "./grounding.ts";

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

describe("helpers", () => {
	test("numbersIn returns satang values", () => {
		expect(
			[...numbersIn("2 @7.00 14.00 -5.00 1,000")].sort((a, b) => a - b),
		).toEqual([200, 500, 700, 1400, 100000]);
	});

	test("squash normalises composed forms, whitespace and case", () => {
		expect(squash(" DEMO  Tea\n")).toBe("demotea");
		expect(squash("é")).toBe("é");
	});
});
