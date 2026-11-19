import { toSatang } from "../schema/receipt.ts";
import { parseNumberTokens } from "../validate/numbers.ts";

/**
 * Unit-price recovery for a row that prints "qty  name  @unit  amount".
 *
 * OCR rarely reads the "@" marker: it is lost, read as a letter, or read as
 * a digit glued onto the price ("@19.00" → "819.00"). Without the marker
 * the token looks like a second amount.
 *
 * The token is accepted as the unit price only when arithmetic proves it:
 * the quantity is known and greater than 1, the line amount is known and
 * positive, and qty × candidate = amount exactly. One leading character
 * may be removed from the token to get there (the misread marker). Nothing
 * is ever repaired on resemblance alone.
 */
export type UnitPriceRepair =
	/** The token already reads as the unit price; only the "@" was lost or misread as a non-digit. */
	| "marker_missing"
	/** The first character of the token was the misread marker and was removed. */
	| "leading_character_removed";

export interface RecoveredUnitPrice {
	unit_price: number;
	repair: UnitPriceRepair;
}

/** The first two-decimal, unambiguous number in a text, as satang. */
function firstPrice(text: string): number | null {
	const token = parseNumberTokens(text).find(
		(t) => t.decimals === 2 && t.value !== null && t.value >= 0,
	);
	return token?.value === null || token === undefined
		? null
		: toSatang(token.value);
}

/**
 * @param candidateText OCR text of the token between the name and the amount
 * @param qty quantity for the row, kept or recovered; null when unknown
 * @param amount line amount in baht; null when unknown
 */
export function recoverUnitPrice(
	candidateText: string,
	qty: number | null,
	amount: number | null,
): RecoveredUnitPrice | null {
	// A zero amount proves nothing: qty × 0 = 0 for any misreading.
	if (qty === null || !Number.isInteger(qty) || qty < 2) return null;
	if (amount === null || amount <= 0) return null;
	const target = toSatang(amount);
	const text = candidateText.trim();

	const asRead = firstPrice(text);
	if (asRead !== null && asRead > 0 && asRead * qty === target) {
		return { unit_price: asRead / 100, repair: "marker_missing" };
	}
	const stripped = firstPrice([...text].slice(1).join(""));
	if (stripped !== null && stripped > 0 && stripped * qty === target) {
		return { unit_price: stripped / 100, repair: "leading_character_removed" };
	}
	return null;
}
