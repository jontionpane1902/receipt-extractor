import type { OcrLine, OcrResult } from "../ocr/types.ts";
import { type Receipt, toSatang } from "../schema/receipt.ts";
import { thaiDigitsToAscii } from "./date.ts";
import { numbersIn } from "./numbers.ts";
import { type CheckResult, fail, pass, skip } from "./types.ts";

export interface ExtractedField {
	path: string;
	kind: "text" | "number";
	/**
	 * For numbers: an "amount" must be printed as an amount, so a matching
	 * @unit-price token does not ground it; a "unit_price" or "count" may
	 * match any printed number.
	 */
	role?: "amount" | "unit_price" | "count";
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
	const number = (
		path: string,
		value: number | null,
		role: NonNullable<ExtractedField["role"]>,
		key = false,
	) => {
		if (value !== null) fields.push({ path, kind: "number", role, value, key });
	};

	text("branch.code", receipt.branch.code);
	text("branch.name", receipt.branch.name);
	text("tax_id", receipt.tax_id, true);
	text("receipt_number", receipt.receipt_number);
	text("datetime_raw", receipt.datetime_raw, true);
	receipt.items.forEach((item, i) => {
		text(`items[${i}].raw_name`, item.raw_name, true);
		if (item.qty !== 1) number(`items[${i}].qty`, item.qty, "count");
		number(`items[${i}].unit_price`, item.unit_price, "unit_price");
		number(`items[${i}].amount`, item.amount, "amount", true);
	});
	receipt.discounts.forEach((discount, i) => {
		number(`discounts[${i}].amount`, discount.amount, "amount");
	});
	number("total", receipt.total, "amount", true);
	number("vat", receipt.vat, "amount");
	number("payment.tendered", receipt.payment.tendered, "amount");
	number("change", receipt.change, "amount");
	number("item_count", receipt.item_count, "count");
	return fields;
}

/** NFC, ASCII digits, lower case, all whitespace removed. */
export function squash(text: string): string {
	return thaiDigitsToAscii(text.normalize("NFC"))
		.toLowerCase()
		.replace(/\s+/g, "");
}

function numbersFor(field: ExtractedField, text: string): Set<number> {
	return numbersIn(text, { excludeUnitPrices: field.role === "amount" });
}

/** Does this OCR line contain the field's value? */
export function lineContains(line: OcrLine, field: ExtractedField): boolean {
	return field.kind === "number"
		? numbersFor(field, line.text).has(toSatang(field.value as number))
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
	const pageText = ocr.lines.map((line) => line.text).join("\n");

	return fields.map((field) => {
		const grounded =
			field.kind === "number"
				? numbersFor(field, pageText).has(toSatang(field.value as number))
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
