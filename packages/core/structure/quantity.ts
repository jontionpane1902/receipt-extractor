import { leftEdge } from "../ocr/rows.ts";
import type { OcrResult } from "../ocr/types.ts";

/**
 * Quantity recovery.
 *
 * Receipts print a quantity at the start of every item row, but an OCR
 * backend may filter out such one-character lines (too short, or low
 * confidence) and report them only as `dropped`. They are still evidence.
 * This module turns them into lower-trust quantity candidates and lets the
 * printed item count confirm them or fill the gaps by arithmetic — never
 * by assumption.
 */
export interface QuantityCandidate {
	row: number;
	qty: number;
	/** The dropped line's OCR confidence. */
	confidence: number | null;
	/** Why the backend dropped the line, e.g. "too_short". */
	dropped_reason: string;
}

/**
 * Dropped lines that are a 1–2 digit number at the very start of a row
 * that also has kept text. Needs box geometry to know the digit is the
 * leftmost thing on the row; a row with several such digits, or without
 * boxes, yields no candidate.
 */
export function quantityCandidatesFromDropped(
	ocr: Pick<OcrResult, "lines" | "dropped">,
): Map<number, QuantityCandidate> {
	const firstKeptEdge = new Map<number, number | null>();
	for (const line of ocr.lines) {
		if (line.row === undefined) continue;
		const edge = leftEdge(line);
		const known = firstKeptEdge.get(line.row);
		if (!firstKeptEdge.has(line.row)) firstKeptEdge.set(line.row, edge);
		else if (known !== null && known !== undefined && edge !== null) {
			firstKeptEdge.set(line.row, Math.min(known, edge));
		} else firstKeptEdge.set(line.row, null);
	}

	const found = new Map<number, QuantityCandidate | null>();
	for (const line of ocr.dropped ?? []) {
		const text = line.text.trim();
		if (line.row === undefined || !/^[0-9]{1,2}$/.test(text)) continue;
		const qty = Number(text);
		const keptEdge = firstKeptEdge.get(line.row);
		const edge = leftEdge(line);
		if (
			qty < 1 ||
			keptEdge === null ||
			keptEdge === undefined ||
			edge === null
		) {
			continue;
		}
		if (edge >= keptEdge) continue; // not at the start of the row
		// Two digit-lines on one row: cannot tell which is the quantity.
		found.set(
			line.row,
			found.has(line.row)
				? null
				: {
						row: line.row,
						qty,
						confidence: line.confidence,
						dropped_reason: line.reason,
					},
		);
	}
	const candidates = new Map<number, QuantityCandidate>();
	for (const [row, candidate] of found) {
		if (candidate) candidates.set(row, candidate);
	}
	return candidates;
}

/**
 * Where a quantity came from, highest trust first: "printed" (a kept OCR
 * line), "dropped" (recovered from a line the OCR backend filtered out),
 * "deduced" (from an established item count), "inferred" (from the row's
 * own two amounts; see unit-price.ts).
 */
export type QuantitySource = "printed" | "dropped" | "deduced" | "inferred";

/** What is known about one item's quantity before reconciliation. */
export interface QuantityInput {
	qty: number;
	/** "printed": read as a normal OCR line. "dropped": recovered from a dropped line. */
	source: "printed" | "dropped";
	confidence?: number | null;
}

export interface ResolvedQuantity {
	qty: number | null;
	source: QuantitySource | null;
	/**
	 * "normal": read from kept OCR text. "low": recovered or deduced and not
	 * confirmed by the item count. "confirmed": recovered or deduced, and
	 * the printed item count agrees.
	 */
	trust: "normal" | "low" | "confirmed" | null;
	confidence: number | null;
}

export type QuantityStatus =
	/** Every quantity is known and they add up to the printed count. */
	| "confirmed"
	/** Missing quantities were filled by arithmetic from the printed count. */
	| "deduced"
	/** Known quantities contradict the printed count. */
	| "mismatch"
	/** Several quantities are missing and the count does not pin them down. */
	| "unresolved"
	/** No printed count to check against. */
	| "unverified";

export interface QuantityResolution {
	status: QuantityStatus;
	quantities: ResolvedQuantity[];
	message: string;
}

/**
 * What the printed item count is known to mean for this receipt.
 * - "unknown" (default): the count may confirm quantities but never
 *   invents or contradicts them. Real layouts differ: on one the count was
 *   every piece including promotion rows, on another it was neither the
 *   pieces nor the lines.
 * - "pieces": the count is established as the sum of all row quantities.
 *   Only then may missing quantities be deduced from it, and a different
 *   sum reported as a mismatch.
 */
export type ItemCountRule = "unknown" | "pieces";

export interface ResolveQuantitiesOptions {
	countRule?: ItemCountRule;
}

/**
 * Reconciles per-item quantities (in item order, null = unknown) with the
 * printed item count.
 *
 * With the default "unknown" rule the count is a soft signal: if every
 * quantity is known and they add up to it, they are confirmed; otherwise
 * nothing changes and the status is "unverified".
 *
 * With the "pieces" rule, deduction happens only when arithmetic leaves
 * one answer: quantities are whole numbers ≥ 1, so if the count exceeds
 * the known sum by exactly the number of missing items, each missing one
 * is 1; and a single missing item must be the remainder. Anything else is
 * left unknown.
 */
export function resolveQuantities(
	items: readonly (QuantityInput | null)[],
	itemCount: number | null,
	options: ResolveQuantitiesOptions = {},
): QuantityResolution {
	const base: ResolvedQuantity[] = items.map((item) =>
		item
			? {
					qty: item.qty,
					source: item.source,
					trust: item.source === "printed" ? "normal" : "low",
					confidence: item.confidence ?? null,
				}
			: { qty: null, source: null, trust: null, confidence: null },
	);
	const missing = items.filter((item) => item === null).length;
	if (itemCount === null) {
		return {
			status: "unverified",
			quantities: base,
			message: "no printed item count to confirm quantities against",
		};
	}
	const known = items.reduce((sum, item) => sum + (item?.qty ?? 0), 0);
	const remainder = itemCount - known;
	const confirm = (list: ResolvedQuantity[]): ResolvedQuantity[] =>
		list.map((q) => (q.trust === "low" ? { ...q, trust: "confirmed" } : q));

	if (options.countRule !== "pieces") {
		return missing === 0 && remainder === 0
			? {
					status: "confirmed",
					quantities: confirm(base),
					message: `quantities add up to the printed count ${itemCount}`,
				}
			: {
					status: "unverified",
					quantities: base,
					message: `printed count ${itemCount} does not settle the quantities (known sum ${known}, ${missing} missing) and its counting rule is not established: nothing deduced`,
				};
	}

	if (missing === 0) {
		return remainder === 0
			? {
					status: "confirmed",
					quantities: confirm(base),
					message: `quantities add up to the printed count ${itemCount}`,
				}
			: {
					status: "mismatch",
					quantities: base,
					message: `quantities add up to ${known}, receipt prints ${itemCount}`,
				};
	}
	if (remainder < missing) {
		return {
			status: "mismatch",
			quantities: base,
			message: `known quantities add up to ${known} with ${missing} still missing, but the receipt prints only ${itemCount}`,
		};
	}
	if (remainder === missing || missing === 1) {
		const fill = missing === 1 ? remainder : 1;
		return {
			status: "deduced",
			quantities: confirm(
				base.map((q) =>
					q.qty === null
						? { qty: fill, source: "deduced", trust: "low", confidence: null }
						: q,
				),
			),
			message: `${missing} missing ${missing === 1 ? "quantity" : "quantities"} deduced as ${fill} from the printed count ${itemCount}`,
		};
	}
	return {
		status: "unresolved",
		quantities: base,
		message: `${missing} quantities are missing and ${remainder} pieces remain: more than one split is possible`,
	};
}
