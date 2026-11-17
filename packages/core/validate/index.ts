import type { OcrResult } from "../ocr/types.ts";
import type { Receipt } from "../schema/receipt.ts";
import {
	checkChange,
	checkItemCount,
	checkLineAmounts,
	checkTotal,
	checkVat,
	type ItemCountMode,
} from "./arithmetic.ts";
import { checkOcrConfidence } from "./confidence.ts";
import { checkDate } from "./date.ts";
import { checkTaxId } from "./format.ts";
import { checkGrounding } from "./grounding.ts";
import type { CheckResult } from "./types.ts";

export * from "./arithmetic.ts";
export * from "./confidence.ts";
export * from "./date.ts";
export * from "./format.ts";
export * from "./grounding.ts";
export * from "./numbers.ts";
export * from "./types.ts";

export interface ValidateOptions {
	/** Injected clock, so results are reproducible. */
	now: Date;
	minOcrConfidence?: number;
	itemCountMode?: ItemCountMode;
}

export interface ValidationReport {
	/** True when no check failed with severity "error". */
	ok: boolean;
	checks: CheckResult[];
	/** Failed checks of any severity. */
	failures: CheckResult[];
}

/** Runs every check. Pure: no I/O, no clock other than `options.now`. */
export function validateReceipt(
	receipt: Receipt,
	ocr: Pick<OcrResult, "lines">,
	options: ValidateOptions,
): ValidationReport {
	const checks: CheckResult[] = [
		...checkLineAmounts(receipt),
		checkTotal(receipt),
		checkVat(receipt),
		checkChange(receipt),
		checkItemCount(receipt, options.itemCountMode),
		...checkDate(receipt, options.now),
		...checkTaxId(receipt),
		...checkGrounding(receipt, ocr),
		...checkOcrConfidence(receipt, ocr, options.minOcrConfidence),
	];
	const failures = checks.filter((check) => check.status === "fail");
	return {
		ok: !failures.some((check) => check.severity === "error"),
		checks,
		failures,
	};
}
