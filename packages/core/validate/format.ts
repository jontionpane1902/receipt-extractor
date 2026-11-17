import type { Receipt } from "../schema/receipt.ts";
import { type CheckResult, fail, pass, skip } from "./types.ts";

/**
 * Check digit of a 13-digit Thai ID: weights 13..2 over the first twelve
 * digits, then (11 − sum mod 11) mod 10.
 */
export function thaiIdCheckDigit(first12: string): number {
	let sum = 0;
	for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
	return (11 - (sum % 11)) % 10;
}

export type TaxIdWindowStatus =
	/** Exactly 13 digits were given; nothing to choose. */
	| "exact"
	/** More than 13 digits, and exactly one 13-digit window has a valid check digit. */
	| "selected"
	/** More than 13 digits, and no window has a valid check digit. */
	| "none_valid"
	/** More than 13 digits, and several different windows are valid. */
	| "ambiguous"
	/** Too many extra digits for the check digit to be meaningful. */
	| "too_long"
	/** Fewer than 13 digits, or not digits at all. */
	| "not_found";

export interface TaxIdWindow {
	status: TaxIdWindowStatus;
	/** The tax ID to use, or null when it must be flagged instead. */
	tax_id: string | null;
	/** Every distinct 13-digit window with a valid check digit. */
	valid_windows: string[];
	message: string;
}

/**
 * Each extra digit adds a window with a 1-in-10 chance of a valid check
 * digit by accident, so only a small overrun is trusted.
 */
export const MAX_EXTRA_TAX_ID_DIGITS = 2;

/**
 * Picks the tax ID out of a digit run that OCR made too long, typically
 * because a neighbouring character ("#", ":", "I") was read as a digit and
 * glued on. Pass the digits found where the tax ID is printed, not any
 * long number on the receipt.
 *
 * Never guesses: with zero or several valid windows the result has no
 * tax_id and says why.
 */
export function selectTaxIdWindow(digits: string): TaxIdWindow {
	const none = (status: TaxIdWindowStatus, message: string): TaxIdWindow => ({
		status,
		tax_id: null,
		valid_windows: [],
		message,
	});
	if (!/^\d{13,}$/.test(digits)) {
		return none("not_found", "fewer than 13 consecutive digits");
	}
	const isValid = (window: string) =>
		thaiIdCheckDigit(window.slice(0, 12)) === Number(window[12]);
	if (digits.length === 13) {
		return {
			status: "exact",
			tax_id: digits,
			valid_windows: isValid(digits) ? [digits] : [],
			message: isValid(digits)
				? "13 digits with a valid check digit"
				: "13 digits; check digit is not valid",
		};
	}
	const extra = digits.length - 13;
	if (extra > MAX_EXTRA_TAX_ID_DIGITS) {
		return none(
			"too_long",
			`${digits.length} consecutive digits: too many to pick a tax ID by check digit`,
		);
	}
	const windows = new Set<string>();
	for (let start = 0; start <= extra; start++) {
		const window = digits.slice(start, start + 13);
		if (isValid(window)) windows.add(window);
	}
	const valid = [...windows];
	const [only] = valid;
	if (valid.length === 1 && only !== undefined) {
		return {
			status: "selected",
			tax_id: only,
			valid_windows: valid,
			message: `${digits.length} digits read; one 13-digit window has a valid check digit`,
		};
	}
	return {
		status: valid.length === 0 ? "none_valid" : "ambiguous",
		tax_id: null,
		valid_windows: valid,
		message:
			valid.length === 0
				? `${digits.length} digits read; no 13-digit window has a valid check digit`
				: `${digits.length} digits read; ${valid.length} different windows have a valid check digit`,
	};
}

/**
 * Tax ID is exactly 13 digits (error) and its check digit is valid
 * (warning only: the mod-11 rule is the national-ID rule and has not been
 * verified here for every class of juristic tax ID).
 */
export function checkTaxId(receipt: Receipt): CheckResult[] {
	const path = "tax_id";
	const taxId = receipt.tax_id;
	if (taxId === null) {
		return [
			fail("tax_id_format", "no tax ID was extracted", { path }),
			skip("tax_id_checksum", "no tax ID to check", {
				path,
				severity: "warning",
			}),
		];
	}
	if (!/^\d{13}$/.test(taxId)) {
		return [
			fail("tax_id_format", `tax ID must be 13 digits, got "${taxId}"`, {
				path,
				actual: taxId,
			}),
			skip("tax_id_checksum", "format is invalid", {
				path,
				severity: "warning",
			}),
		];
	}
	const expected = thaiIdCheckDigit(taxId.slice(0, 12));
	const actual = Number(taxId[12]);
	return [
		pass("tax_id_format", "tax ID has 13 digits", { path }),
		expected === actual
			? pass("tax_id_checksum", "check digit is valid", {
					path,
					severity: "warning",
				})
			: fail(
					"tax_id_checksum",
					`check digit should be ${expected}, got ${actual} (possible misread digit)`,
					{ path, severity: "warning", expected, actual },
				),
	];
}
