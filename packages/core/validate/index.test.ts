import { describe, expect, test } from "bun:test";
import { linesFromText } from "../ocr/fake.ts";
import { SAMPLE_OCR_TEXT, sampleReceipt } from "../schema/fixtures.ts";
import { validateReceipt } from "./index.ts";

const NOW = new Date("2026-11-17T15:00:00+07:00");
const ocr = { lines: linesFromText(SAMPLE_OCR_TEXT) };

describe("validateReceipt", () => {
	test("a consistent, grounded receipt passes every check", () => {
		const report = validateReceipt(sampleReceipt(), ocr, { now: NOW });
		expect(report.failures).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.checks.every((c) => c.message.length > 0)).toBe(true);
	});

	test("a misread total is caught by several independent checks", () => {
		const report = validateReceipt(sampleReceipt({ total: 84 }), ocr, {
			now: NOW,
		});
		expect(report.ok).toBe(false);
		const failed = new Set(report.failures.map((f) => f.check));
		expect(failed).toEqual(
			new Set(["total_sum", "vat", "change", "grounding"]),
		);
	});

	test("a warning-only failure is reported but does not block", () => {
		const taxLine = "TAX ID 9012345678907";
		const report = validateReceipt(
			sampleReceipt({ tax_id: "9012345678907" }),
			{
				lines: linesFromText(
					SAMPLE_OCR_TEXT.map((t, i) => (i === 1 ? taxLine : t)),
				),
			},
			{ now: NOW },
		);
		expect(report.failures.map((f) => f.check)).toEqual(["tax_id_checksum"]);
		expect(report.ok).toBe(true);
	});

	test("options are passed through", () => {
		const report = validateReceipt(sampleReceipt({ item_count: 3 }), ocr, {
			now: NOW,
			itemCountMode: "pieces",
		});
		// Strict pieces mode: 4 pieces against a printed 3 is an error. (3 is
		// also not printed as a number in the OCR text, so grounding fails too.)
		expect(report.failures.map((f) => f.check)).toEqual([
			"item_count",
			"grounding",
		]);
		expect(report.failures[0]?.severity).toBe("error");
	});

	test("an item count that fits neither reading warns but does not block", () => {
		const text = SAMPLE_OCR_TEXT.map((t) => t.replace("4 ชิ้น", "2 ชิ้น"));
		const report = validateReceipt(
			sampleReceipt({ item_count: 2 }),
			{ lines: linesFromText(text) },
			{ now: NOW },
		);
		expect(report.failures).toMatchObject([
			{ check: "item_count", severity: "warning" },
		]);
		expect(report.ok).toBe(true);
	});
});
