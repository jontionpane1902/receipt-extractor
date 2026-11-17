import { describe, expect, test } from "bun:test";
import { linesFromText } from "../ocr/fake.ts";
import { SAMPLE_OCR_TEXT, sampleReceipt } from "../schema/fixtures.ts";
import { checkOcrConfidence, fieldConfidence } from "./confidence.ts";

const withConfidence = (overrides: Record<number, number | null>) => ({
	lines: linesFromText(
		SAMPLE_OCR_TEXT.map((text, i) =>
			i in overrides ? { text, confidence: overrides[i] ?? null } : text,
		),
	),
});

describe("fieldConfidence", () => {
	test("maps each field to the confidence of the line containing it", () => {
		const confidence = fieldConfidence(
			sampleReceipt(),
			withConfidence({ 1: 0.91, 7: 0.55 }),
		);
		expect(confidence.tax_id).toBe(0.91);
		expect(confidence.total).toBe(0.55);
		expect(confidence["items[0].raw_name"]).toBe(0.99);
	});

	test("takes the lowest score when a value appears on several lines", () => {
		// 20.00 is only on the snack line; 35.00 only on the tea line.
		const confidence = fieldConfidence(
			sampleReceipt(),
			withConfidence({ 4: 0.6 }),
		);
		expect(confidence["items[1].amount"]).toBe(0.6);
		expect(confidence["items[2].amount"]).toBe(0.99);
	});

	test("omits fields whose lines have no confidence", () => {
		const confidence = fieldConfidence(
			sampleReceipt(),
			withConfidence({ 1: null }),
		);
		expect("tax_id" in confidence).toBe(false);
	});
});

describe("checkOcrConfidence", () => {
	test("passes when all key-field lines are confident", () => {
		const results = checkOcrConfidence(sampleReceipt(), withConfidence({}));
		expect(results.every((r) => r.status === "pass")).toBe(true);
		expect(results.map((r) => r.path)).toContain("total");
	});

	test("fails only the fields fed by a low-confidence line", () => {
		const results = checkOcrConfidence(
			sampleReceipt(),
			withConfidence({ 7: 0.55 }),
		);
		const failed = results.filter((r) => r.status === "fail");
		expect(failed).toMatchObject([{ path: "total", actual: 0.55 }]);
	});

	test("threshold is configurable", () => {
		const results = checkOcrConfidence(
			sampleReceipt(),
			withConfidence({ 7: 0.55 }),
			0.5,
		);
		expect(results.some((r) => r.status === "fail")).toBe(false);
	});

	test("skips, rather than passes, when confidence is unknown", () => {
		const results = checkOcrConfidence(
			sampleReceipt(),
			withConfidence({ 1: null }),
		);
		expect(results.find((r) => r.path === "tax_id")?.status).toBe("skip");
	});
});
