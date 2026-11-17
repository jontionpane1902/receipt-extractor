import type { OcrLine, OcrResult } from "../ocr/types.ts";
import { type Receipt, toSatang } from "../schema/receipt.ts";
import { thaiDigitsToAscii } from "./date.ts";
import { type CheckResult, fail, pass, skip } from "./types.ts";

export interface ExtractedField {
	path: string;
	kind: "text" | "number";
	value: string | number;
	/** Key fields also get the OCR confidence check. */
	key: boolean;
}

/**
 * Every extracted value that must be traceable to the OCR text.
 * Quantity 1 is exempt: receipts usually omit it (provisional).
 */
export function extractedFields(receipt: Receipt): ExtractedField[] {
	const fields: ExtractedField[] = [];
	const text = (path: string, value: string | null, key = false) => {
		if (value !== null && value !== "") {
			fields.push({ path, kind: "text", value, key });
		}
	};
	const number = (path: string, value: number | null, key = false) => {
		if (value !== null) fields.push({ path, kind: "number", value, key });
	};

	text("branch.code", receipt.branch.code);
	text("branch.name", receipt.branch.name);
	text("tax_id", receipt.tax_id, true);
	text("receipt_number", receipt.receipt_number);
	text("datetime_raw", receipt.datetime_raw, true);
	receipt.items.forEach((item, i) => {
		text(`items[${i}].raw_name`, item.raw_name, true);
		if (item.qty !== 1) number(`items[${i}].qty`, item.qty);
		number(`items[${i}].unit_price`, item.unit_price);
		number(`items[${i}].amount`, item.amount, true);
	});
	receipt.discounts.forEach((discount, i) => {
		number(`discounts[${i}].amount`, discount.amount);
	});
	number("total", receipt.total, true);
	number("vat", receipt.vat);
	number("payment.tendered", receipt.payment.tendered);
	number("change", receipt.change);
	number("item_count", receipt.item_count);
	return fields;
}

/** NFC, ASCII digits, lower case, all whitespace removed. */
export function squash(text: string): string {
	return thaiDigitsToAscii(text.normalize("NFC"))
		.toLowerCase()
		.replace(/\s+/g, "");
}

/** Numbers printed in a text, as satang ("1,234.50" → 123450). */
export function numbersIn(text: string): Set<number> {
	const found = new Set<number>();
	const ascii = thaiDigitsToAscii(text);
	for (const match of ascii.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
		found.add(toSatang(Number(match[0].replaceAll(",", ""))));
	}
	return found;
}

/** Does this OCR line contain the field's value? */
export function lineContains(line: OcrLine, field: ExtractedField): boolean {
	return field.kind === "number"
		? numbersIn(line.text).has(toSatang(field.value as number))
		: squash(line.text).includes(squash(String(field.value)));
}

/**
 * Grounding: every extracted number and name must appear in the raw OCR
 * text. Catches values the LLM invented or "fixed". Necessary, not
 * sufficient: a value can appear in the text and still be the wrong one.
 * One result per field.
 */
export function checkGrounding(
	receipt: Receipt,
	ocr: Pick<OcrResult, "lines">,
): CheckResult[] {
	const fields = extractedFields(receipt);
	if (fields.length === 0) {
		return [skip("grounding", "nothing was extracted")];
	}
	const fullText = squash(ocr.lines.map((line) => line.text).join(" "));
	const allNumbers = numbersIn(ocr.lines.map((line) => line.text).join("\n"));

	return fields.map((field) => {
		const grounded =
			field.kind === "number"
				? allNumbers.has(toSatang(field.value as number))
				: fullText.includes(squash(String(field.value)));
		return grounded
			? pass("grounding", "value appears in OCR text", { path: field.path })
			: fail(
					"grounding",
					`${field.kind === "number" ? "number" : "text"} "${field.value}" does not appear in the OCR text`,
					{ path: field.path, actual: field.value },
				);
	});
}
