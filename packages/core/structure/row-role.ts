import {
	DEFAULT_LOOKALIKES,
	graphemes,
	similarity,
} from "../catalog/similarity.ts";
import { parseNumberTokens } from "../validate/numbers.ts";

/**
 * Coarse role of a receipt row, used to keep item-only rules (such as
 * unit-price inference) away from rows that merely look similar.
 *
 * Totals, payment and discount rows also carry two amounts — cash and
 * change, subtotal and total — which are not unit price × quantity.
 */
export type RowRole = "item" | "totals" | "payment" | "discount";

/**
 * Labels that start a non-item row, in the forms seen on receipts. They are
 * matched fuzzily because OCR damages them (a label can lose or swap a
 * character and must still be recognised).
 */
const LABELS: readonly {
	role: Exclude<RowRole, "item">;
	words: readonly string[];
}[] = [
	{ role: "totals", words: ["total", "ยอดสุทธิ", "ยอดรวม", "subtotal"] },
	{
		role: "payment",
		words: ["cash/change", "cash", "change", "เงินสด/เงินทอน", "เงินสด", "เงินทอน"],
	},
	{ role: "discount", words: ["ส่วนลด", "discount"] },
];

/** Similarity a row's opening text needs to a label. Errs toward "not an item". */
export const ROW_LABEL_SIMILARITY = 0.6;

/**
 * @param nameText the row's text part (what would be the item name)
 * @param amountTexts the row's number parts
 *
 * Decided by, in order: a negative amount (discount); a printed piece count
 * such as "(4)" or "5 ชิ้น" beside the amounts (totals); the opening of the
 * text resembling a totals, payment or discount label. Anything else is an
 * item. A product whose name happens to resemble a label is classed as a
 * non-item, which only stops a repair from firing: the safe direction.
 */
export function rowRole(
	nameText: string,
	amountTexts: readonly string[] = [],
): RowRole {
	const tokens = amountTexts.flatMap((text) => parseNumberTokens(text));
	if (tokens.some((t) => t.value !== null && t.value < 0)) return "discount";
	if (
		amountTexts.some(
			(text) => /^\s*\(\s*\d{1,3}\s*\)\s*$/.test(text) || /\d\s*ชิ้น/.test(text),
		)
	) {
		return "totals";
	}
	const opening = graphemes(nameText.normalize("NFC").trim().toLowerCase());
	let best: { role: RowRole; score: number } = { role: "item", score: 0 };
	for (const { role, words } of LABELS) {
		for (const word of words) {
			const length = graphemes(word).length;
			// Compare the label with the same number of leading characters.
			const head = opening.slice(0, length).join("");
			const score = similarity(word, head, { lookalikes: DEFAULT_LOOKALIKES });
			if (score > best.score) best = { role, score };
		}
	}
	return best.score >= ROW_LABEL_SIMILARITY ? best.role : "item";
}
