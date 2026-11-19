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

/**
 * Inferred path (lower trust): when the quantity is NOT known, a row with
 * exactly two amounts may still explain itself, because the line amount
 * must be a whole multiple of the unit price.
 *
 * Unlike `recoverUnitPrice`, nothing here is confirmed by an independent
 * reading: the quantity is deduced from the same two numbers. The result
 * is therefore marked as inferred, never overrides a quantity that was
 * read or recovered, and is refused whenever more than one explanation
 * fits.
 */
export interface UnitPriceCandidate {
	unit_price: number;
	quantity: number;
	repair: UnitPriceRepair | "none";
}

export type UnitPriceInference =
	/** Exactly one candidate explains the row. */
	| ({ status: "inferred" } & UnitPriceCandidate)
	/** Several different candidates explain the row: nothing is chosen. */
	| { status: "ambiguous"; candidates: UnitPriceCandidate[] }
	/** Two amounts, but no whole-number quantity links them. */
	| { status: "unexplained" }
	/** The rule does not apply to this row. */
	| { status: "not_applicable"; reason: string };

export interface InferUnitPriceOptions {
	/** Largest quantity accepted. Default 99. */
	maxQuantity?: number;
	/**
	 * What kind of row this is (see `rowRole`). The rule only fires on
	 * "item": totals, payment and discount rows also carry two amounts
	 * (cash and change, subtotal and total) that are not price × quantity.
	 */
	role?: "item" | "totals" | "payment" | "discount";
}

export const DEFAULT_MAX_INFERRED_QUANTITY = 99;

/**
 * @param amountTexts OCR texts of the row after the name, left to right
 */
export function inferUnitPriceAndQuantity(
	amountTexts: readonly string[],
	options: InferUnitPriceOptions = {},
): UnitPriceInference {
	const role = options.role ?? "item";
	if (role !== "item") {
		return { status: "not_applicable", reason: `${role} row` };
	}
	const maxQuantity = options.maxQuantity ?? DEFAULT_MAX_INFERRED_QUANTITY;

	const found = amountTexts.flatMap((text) =>
		parseNumberTokens(text)
			.filter((token) => token.decimals === 2 && token.value !== null)
			.map((token) => ({ text, token })),
	);
	if (found.length !== 2) {
		return {
			status: "not_applicable",
			reason: `${found.length} amount-like token(s), needs exactly 2`,
		};
	}
	const [first, second] = found;
	if (!first || !second) return { status: "unexplained" };
	const amount = toSatang(second.token.value ?? 0);
	if (amount <= 0) {
		return { status: "not_applicable", reason: "line amount is not positive" };
	}

	const candidates: UnitPriceCandidate[] = [];
	const consider = (
		satang: number | null,
		repair: UnitPriceCandidate["repair"],
	) => {
		if (satang === null || satang <= 0 || amount % satang !== 0) return;
		const quantity = amount / satang;
		if (quantity < 2 || quantity > maxQuantity) return;
		if (candidates.some((c) => toSatang(c.unit_price) === satang)) return;
		candidates.push({ unit_price: satang / 100, quantity, repair });
	};

	const asRead = toSatang(first.token.value ?? 0);
	const markerRead = first.token.kind === "unit_price";
	consider(asRead, markerRead ? "none" : "marker_missing");
	if (!markerRead) {
		// The whitespace-delimited word holding the token, minus one leading
		// character: the "@" read as a digit or letter.
		const start = first.text.lastIndexOf(" ", first.token.start) + 1;
		const word = first.text.slice(start, first.token.end);
		consider(
			firstPrice([...word].slice(1).join("")),
			"leading_character_removed",
		);
	}

	const [only] = candidates;
	if (candidates.length === 1 && only) return { status: "inferred", ...only };
	return candidates.length === 0
		? { status: "unexplained" }
		: { status: "ambiguous", candidates };
}

/** How a unit price was obtained, highest trust first. */
export type UnitPriceSource =
	/** Printed with its "@" marker and read as such. */
	| "read"
	/** Marker lost, but a known quantity × price = amount proves it. */
	| "confirmed"
	/** Deduced together with the quantity from the row's two amounts. */
	| "inferred";

export interface ItemQuantityAndPrice {
	quantity: number | null;
	/** "printed" (kept OCR line), "dropped" (recovered), "inferred" (arithmetic) or null (unknown). */
	quantity_source: "printed" | "dropped" | "deduced" | "inferred" | null;
	unit_price: number | null;
	unit_price_source: UnitPriceSource | null;
	/** An inferred quantity disagreed with one that was read or recovered; the latter was kept. */
	conflict: boolean;
	/** "ambiguous" or "unexplained" when the row has two amounts that the rule could not resolve. */
	unresolved: "ambiguous" | "unexplained" | null;
}

/**
 * Combines what was read with what arithmetic says, in trust order:
 * a read unit price, then a confirmed one (known quantity), then an
 * inferred one. A quantity that was read or recovered is never replaced:
 * if the inference disagrees, the read value stays and `conflict` is set.
 */
export function combineQuantityAndPrice(
	known: {
		quantity: number | null;
		quantity_source: "printed" | "dropped" | "deduced" | null;
	},
	readUnitPrice: number | null,
	confirmed: RecoveredUnitPrice | null,
	inference: UnitPriceInference | null,
): ItemQuantityAndPrice {
	const base: ItemQuantityAndPrice = {
		quantity: known.quantity,
		quantity_source: known.quantity === null ? null : known.quantity_source,
		unit_price: null,
		unit_price_source: null,
		conflict: false,
		unresolved: null,
	};

	if (readUnitPrice !== null) {
		base.unit_price = readUnitPrice;
		base.unit_price_source = "read";
	} else if (confirmed) {
		base.unit_price = confirmed.unit_price;
		base.unit_price_source = "confirmed";
	}
	if (!inference || inference.status === "not_applicable") return base;
	if (inference.status !== "inferred") {
		// A confirmed or read price already explains the row.
		if (base.unit_price === null) base.unresolved = inference.status;
		return base;
	}
	if (known.quantity !== null) {
		if (known.quantity !== inference.quantity) base.conflict = true;
		return base;
	}
	base.quantity = inference.quantity;
	base.quantity_source = "inferred";
	if (base.unit_price === null) {
		base.unit_price = inference.unit_price;
		base.unit_price_source = "inferred";
	}
	return base;
}
