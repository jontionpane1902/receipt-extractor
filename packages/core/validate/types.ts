export type CheckId =
	| "line_amount"
	| "total_sum"
	| "vat"
	| "change"
	| "item_count"
	| "date_parse"
	| "date_not_future"
	| "tax_id_format"
	| "tax_id_checksum"
	| "grounding"
	| "ocr_confidence";

export type CheckStatus = "pass" | "fail" | "skip";

/**
 * "error" failures send the receipt to the fallback / needs_review.
 * "warning" failures are recorded but do not block on their own.
 */
export type CheckSeverity = "error" | "warning";

export interface CheckResult {
	check: CheckId;
	status: CheckStatus;
	severity: CheckSeverity;
	/** Field path the result is about, e.g. "items[1].amount". */
	path?: string;
	/** Human-readable reason; always present, also for pass and skip. */
	message: string;
	expected?: string | number;
	actual?: string | number;
}

export function pass(
	check: CheckId,
	message: string,
	extra: Partial<CheckResult> = {},
): CheckResult {
	return { check, status: "pass", severity: "error", message, ...extra };
}

export function fail(
	check: CheckId,
	message: string,
	extra: Partial<CheckResult> = {},
): CheckResult {
	return { check, status: "fail", severity: "error", message, ...extra };
}

export function skip(
	check: CheckId,
	message: string,
	extra: Partial<CheckResult> = {},
): CheckResult {
	return { check, status: "skip", severity: "error", message, ...extra };
}
