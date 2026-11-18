import { toSatang } from "../schema/receipt.ts";
import { thaiDigitsToAscii } from "./date.ts";

/**
 * Receipt-aware number reading, shared by structuring, grounding and
 * validation.
 *
 * Thermal print and OCR bend numbers in a few predictable ways. This
 * module undoes the ones with a single sensible reading and refuses to
 * guess the rest:
 *
 *   9,50        decimal comma                    → 9.50
 *   118. 25     stray space after the point      → 118.25
 *   1,250.00    genuine thousands separator      → 1250.00
 *   18.50N      amount with a suffix flag        → 18.50, suffix "N"
 *   18.500      suffix letter misread as a zero  → 18.50, suffix unknown, flagged
 *   @7.00       unit price, not a line amount    → 7.00, kind "unit_price"
 *   12,5  1.255  1.2.3                           → ambiguous, value null
 */
export type NumberNote =
	| "decimal_comma"
	| "space_after_point"
	| "thousands_separator"
	| "unknown_suffix"
	/**
	 * Two decimals followed by one extra "0": receipts print amounts with
	 * exactly two decimals, and OCR reads a trailing suffix letter as a
	 * zero. The value is the two-decimal amount; which letter it was is
	 * NOT guessed (`suffix` stays null).
	 */
	| "suffix_misread_as_digit";

/**
 * Suffix flags printed straight after an amount (one or two capital
 * letters). Seen so far: N, NP and V. Their meaning is layout-specific and
 * is not interpreted here.
 */
export const DEFAULT_SUFFIXES: readonly string[] = ["N", "NP", "V"];
/** @deprecated use DEFAULT_SUFFIXES */
export const KNOWN_SUFFIXES = DEFAULT_SUFFIXES;
export type AmountSuffix = string;

export interface ParseNumberOptions {
	/** Suffix flags to recognise. Default: DEFAULT_SUFFIXES. */
	suffixes?: readonly string[];
	/**
	 * Read "18.500" as 18.50 with a misread suffix (default true). Turn off
	 * for text where three decimals are meaningful.
	 */
	repairTrailingZero?: boolean;
}

export interface NumberToken {
	/** Exactly what was in the text, including "@", sign and suffix. */
	raw: string;
	start: number;
	end: number;
	/** Signed value in baht, or null when the token is ambiguous. */
	value: number | null;
	/** Digits after the decimal separator (0 for an integer). */
	decimals: number;
	/** "unit_price" when written as @price; otherwise "amount". */
	kind: "amount" | "unit_price";
	suffix: AmountSuffix | null;
	/** Repairs applied to reach `value`; a consumer may treat them as lower trust. */
	notes: NumberNote[];
	/** Why no value was assigned, or null when the reading is unambiguous. */
	ambiguous: string | null;
}

const TOKEN =
	/(@\s?)?(-)?(\d(?:[\d.,]*\d)?)(?:\.\s(\d{2})(?![\d.,]))?([A-Z]{1,2}(?![A-Za-z0-9]))?/g;

/** Longer digit runs are identifiers (tax ID, codes), not money. */
const MAX_DIGITS = 15;

const isDigits = (text: string) => /^\d+$/.test(text);

/** "1,250" / "12,345,678": first group 1–3 digits, the rest exactly 3. */
function validThousands(groups: readonly string[]): boolean {
	const [first, ...rest] = groups;
	return (
		first !== undefined &&
		/^\d{1,3}$/.test(first) &&
		rest.length > 0 &&
		rest.every((group) => /^\d{3}$/.test(group))
	);
}

interface Reading {
	integer: string;
	fraction: string;
	notes: NumberNote[];
}

function read(
	blob: string,
	spaced: string | undefined,
	repairTrailingZero: boolean,
): Reading | string {
	const dots = blob.split(".").length - 1;
	const notes: NumberNote[] = [];

	/** Integer part with optional thousands commas → plain digits, or null. */
	const integerPart = (text: string): string | null => {
		if (isDigits(text)) return text;
		const groups = text.split(",");
		if (!validThousands(groups)) return null;
		notes.push("thousands_separator");
		return groups.join("");
	};

	if (spaced !== undefined) {
		if (dots > 0) return "more than one decimal point";
		const integer = integerPart(blob);
		if (integer === null) return "comma is not a valid thousands separator";
		notes.push("space_after_point");
		return { integer, fraction: spaced, notes };
	}
	if (dots > 1) return "more than one decimal point";
	if (dots === 1) {
		const [head = "", tail = ""] = blob.split(".");
		if (!isDigits(tail)) return "comma after the decimal point";
		const misreadSuffix =
			repairTrailingZero && tail.length === 3 && tail.endsWith("0");
		if (tail.length > 2 && !misreadSuffix) {
			return "three or more digits after the point: decimal or thousands?";
		}
		const integer = integerPart(head);
		if (integer === null) return "comma is not a valid thousands separator";
		if (misreadSuffix) notes.push("suffix_misread_as_digit");
		return { integer, fraction: tail.slice(0, 2), notes };
	}
	if (!blob.includes(",")) return { integer: blob, fraction: "", notes };

	const groups = blob.split(",");
	if (validThousands(groups)) {
		notes.push("thousands_separator");
		return { integer: groups.join(""), fraction: "", notes };
	}
	const fraction = groups.at(-1) ?? "";
	if (fraction.length === 2) {
		const integer = integerPart(groups.slice(0, -1).join(","));
		if (integer !== null) {
			notes.push("decimal_comma");
			return { integer, fraction, notes };
		}
	}
	return "comma is neither a thousands separator nor a two-digit decimal";
}

/** Every number in a piece of receipt text, in order. Thai digits are accepted. */
export function parseNumberTokens(
	text: string,
	options: ParseNumberOptions = {},
): NumberToken[] {
	const suffixes = options.suffixes ?? DEFAULT_SUFFIXES;
	const repairTrailingZero = options.repairTrailingZero ?? true;
	const ascii = thaiDigitsToAscii(text);
	const tokens: NumberToken[] = [];
	for (const match of ascii.matchAll(TOKEN)) {
		const [raw, at, minus, blob = "", spaced, letters] = match;
		const start = match.index;
		const before = ascii[start - 1] ?? " ";
		// A hyphen between digits or letters joins them (phone numbers,
		// codes); it is a minus sign only at the start of a number.
		const negative = minus !== undefined && !/[0-9A-Za-z]/.test(before);
		if (blob.replace(/[.,]/g, "").length + (spaced?.length ?? 0) > MAX_DIGITS) {
			continue;
		}

		const reading = read(blob, spaced, repairTrailingZero);
		const token: NumberToken = {
			raw,
			start,
			end: start + raw.length,
			value: null,
			decimals: 0,
			kind: at === undefined ? "amount" : "unit_price",
			suffix: null,
			notes: [],
			ambiguous: null,
		};
		if (typeof reading === "string") {
			token.ambiguous = reading;
		} else {
			const magnitude = Number(
				reading.fraction
					? `${reading.integer}.${reading.fraction}`
					: reading.integer,
			);
			token.value = negative ? -magnitude : magnitude;
			token.decimals = reading.fraction.length;
			token.notes = reading.notes;
		}
		// A suffix flag only follows a full amount (two decimals). Letters
		// after anything else are units or words ("330ML"), not flags.
		if (letters !== undefined && token.decimals === 2) {
			const known = suffixes.find((suffix) => suffix === letters);
			if (known) token.suffix = known;
			else token.notes.push("unknown_suffix");
		} else if (letters !== undefined) {
			token.raw = raw.slice(0, raw.length - letters.length);
			token.end -= letters.length;
		}
		tokens.push(token);
	}
	return tokens;
}

export interface NumbersInOptions extends ParseNumberOptions {
	/** Leave out @unit-price tokens: use when looking for a line amount or total. */
	excludeUnitPrices?: boolean;
}

/**
 * Unambiguous numbers in a text as absolute satang values
 * ("1,234.50" → 123450, "5,00" → 500, "-5.00" → 500).
 */
export function numbersIn(
	text: string,
	options: NumbersInOptions = {},
): Set<number> {
	const found = new Set<number>();
	for (const token of parseNumberTokens(text, options)) {
		if (token.value === null) continue;
		if (options.excludeUnitPrices && token.kind === "unit_price") continue;
		found.add(Math.abs(toSatang(token.value)));
	}
	return found;
}

/** Tokens that could not be read safely; callers should surface these, not drop them. */
export function ambiguousNumbers(
	text: string,
	options: ParseNumberOptions = {},
): NumberToken[] {
	return parseNumberTokens(text, options).filter(
		(token) => token.ambiguous !== null,
	);
}
