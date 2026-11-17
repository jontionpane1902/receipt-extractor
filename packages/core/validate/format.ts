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
