import type { OcrResult } from "../ocr/types.ts";
import type { Receipt } from "../schema/receipt.ts";
import { extractedFields, lineContains } from "./grounding.ts";
import { type CheckResult, fail, pass, skip } from "./types.ts";

/** Provisional threshold; to be calibrated on real receipts in evals. */
export const DEFAULT_MIN_OCR_CONFIDENCE = 0.8;

/**
 * Confidence per field path = the lowest confidence among OCR lines that
 * contain the field's value (conservative when a value appears twice).
 * Fields with no matching line, or only lines without confidence, are
 * left out: unknown is not the same as confident.
 */
export function fieldConfidence(
	receipt: Receipt,
	ocr: Pick<OcrResult, "lines">,
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const field of extractedFields(receipt)) {
		const scores = ocr.lines
			.filter((line) => lineContains(line, field))
			.map((line) => line.confidence)
			.filter((c): c is number => c !== null);
		if (scores.length > 0) result[field.path] = Math.min(...scores);
	}
	return result;
}

/** OCR confidence of the lines feeding key fields is above the threshold. */
export function checkOcrConfidence(
	receipt: Receipt,
	ocr: Pick<OcrResult, "lines">,
	minConfidence: number = DEFAULT_MIN_OCR_CONFIDENCE,
): CheckResult[] {
	const confidence = fieldConfidence(receipt, ocr);
	return extractedFields(receipt)
		.filter((field) => field.key)
		.map((field) => {
			const score = confidence[field.path];
			if (score === undefined) {
				return skip(
					"ocr_confidence",
					"no OCR line with a confidence score contains this value",
					{ path: field.path },
				);
			}
			return score >= minConfidence
				? pass("ocr_confidence", `OCR confidence ${score.toFixed(2)}`, {
						path: field.path,
						actual: score,
					})
				: fail(
						"ocr_confidence",
						`OCR confidence ${score.toFixed(2)} is below ${minConfidence}`,
						{ path: field.path, expected: minConfidence, actual: score },
					);
		});
}
