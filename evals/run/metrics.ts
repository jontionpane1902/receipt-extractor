import {
	editDistance,
	graphemes,
	type Receipt,
	toSatang,
} from "@receipt-extractor/core";
import type { ExpectedReceipt } from "./label.ts";

/** Field name → was it extracted correctly. Item fields: one entry per expected item. */
export type FieldOutcomes = Record<string, boolean[]>;

const sameMoney = (a: number | null, b: number | null) =>
	a === null || b === null ? a === b : toSatang(a) === toSatang(b);

const sameText = (a: string | null, b: string | null) =>
	a === null || b === null
		? a === b
		: a.normalize("NFC") === b.normalize("NFC");

/**
 * Compares an extraction with its label, field by field.
 *
 * Items are aligned by position (receipts are read top to bottom); a
 * missing item counts every one of its fields as wrong, and extra items
 * are caught by `items.count`. normalized_name is scored separately as
 * catalog accuracy, not here.
 */
export function compareReceipt(
	expected: ExpectedReceipt,
	actual: Receipt,
): FieldOutcomes {
	const sum = (xs: { amount: number }[]) =>
		xs.reduce((total, x) => total + toSatang(x.amount), 0);
	const outcomes: FieldOutcomes = {
		store_chain: [expected.store_chain === actual.store_chain],
		"branch.code": [sameText(expected.branch.code, actual.branch.code)],
		"branch.name": [sameText(expected.branch.name, actual.branch.name)],
		tax_id: [sameText(expected.tax_id, actual.tax_id)],
		receipt_number: [sameText(expected.receipt_number, actual.receipt_number)],
		datetime: [expected.datetime === actual.datetime],
		total: [sameMoney(expected.total, actual.total)],
		vat: [sameMoney(expected.vat, actual.vat)],
		"payment.method": [expected.payment.method === actual.payment.method],
		"payment.tendered": [
			sameMoney(expected.payment.tendered, actual.payment.tendered),
		],
		change: [sameMoney(expected.change, actual.change)],
		item_count: [expected.item_count === actual.item_count],
		"discounts.total": [sum(expected.discounts) === sum(actual.discounts)],
		"items.count": [expected.items.length === actual.items.length],
		"items.raw_name": [],
		"items.qty": [],
		"items.unit_price": [],
		"items.amount": [],
	};
	expected.items.forEach((want, index) => {
		const got = actual.items[index];
		outcomes["items.raw_name"]?.push(
			got !== undefined && sameText(want.raw_name, got.raw_name),
		);
		outcomes["items.qty"]?.push(got !== undefined && want.qty === got.qty);
		outcomes["items.unit_price"]?.push(
			got !== undefined && sameMoney(want.unit_price, got.unit_price),
		);
		outcomes["items.amount"]?.push(
			got !== undefined && sameMoney(want.amount, got.amount),
		);
	});
	return outcomes;
}

export function isFullyCorrect(outcomes: FieldOutcomes): boolean {
	return Object.values(outcomes).every((list) => list.every(Boolean));
}

export interface Ratio {
	correct: number;
	total: number;
	/** correct / total, or null when total is 0. */
	rate: number | null;
}

export function ratio(correct: number, total: number): Ratio {
	return { correct, total, rate: total === 0 ? null : correct / total };
}

/** Micro-averaged accuracy per field across receipts. */
export function fieldAccuracy(all: FieldOutcomes[]): Record<string, Ratio> {
	const merged: Record<string, boolean[]> = {};
	for (const outcomes of all) {
		for (const [field, list] of Object.entries(outcomes)) {
			merged[field] = [...(merged[field] ?? []), ...list];
		}
	}
	return Object.fromEntries(
		Object.entries(merged).map(([field, list]) => [
			field,
			ratio(list.filter(Boolean).length, list.length),
		]),
	);
}

export interface CerCounts {
	/** Grapheme-cluster edits between expected and extracted raw names. */
	edits: number;
	/** Grapheme clusters in the expected raw names. */
	length: number;
}

/**
 * Character error rate inputs for raw item names, counted in grapheme
 * clusters (consistent with catalog matching; see docs). Names are
 * compared as printed — only NFC is applied. A missing item costs its
 * whole length.
 */
export function rawNameCer(
	expected: ExpectedReceipt,
	actual: Receipt,
): CerCounts {
	let edits = 0;
	let length = 0;
	expected.items.forEach((want, index) => {
		const reference = graphemes(want.raw_name.normalize("NFC"));
		const hypothesis = graphemes(
			(actual.items[index]?.raw_name ?? "").normalize("NFC"),
		);
		edits += editDistance(reference, hypothesis);
		length += reference.length;
	});
	return { edits, length };
}

/** Per expected item: does normalized_name equal the labelled catalog name (null = "no match expected"). */
export function catalogOutcomes(
	expected: ExpectedReceipt,
	actual: Receipt,
): boolean[] {
	return expected.items.map((want, index) => {
		const got = actual.items[index];
		return (
			got !== undefined && sameText(want.normalized_name, got.normalized_name)
		);
	});
}

export interface Distribution {
	mean: number | null;
	p50: number | null;
	p95: number | null;
}

/** Nearest-rank percentile. */
export function percentile(
	values: readonly number[],
	p: number,
): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
	return sorted[rank - 1] ?? null;
}

export function distribution(values: readonly number[]): Distribution {
	return {
		mean:
			values.length === 0
				? null
				: values.reduce((sum, v) => sum + v, 0) / values.length,
		p50: percentile(values, 50),
		p95: percentile(values, 95),
	};
}

/**
 * How well the validation checks catch wrong extractions.
 * "Positive" = the checks flagged the first-pass extraction.
 */
export interface CheckEffectiveness {
	/** wrong and flagged */
	caught: number;
	/** wrong but not flagged — the dangerous case */
	missed: number;
	/** correct but flagged — costs a needless fallback */
	false_alarms: number;
	/** correct and not flagged */
	clean: number;
	/** caught / (caught + missed) */
	recall: number | null;
	/** caught / (caught + false_alarms) */
	precision: number | null;
}

export function checkEffectiveness(
	receipts: readonly { wrong: boolean; flagged: boolean }[],
): CheckEffectiveness {
	const count = (wrong: boolean, flagged: boolean) =>
		receipts.filter((r) => r.wrong === wrong && r.flagged === flagged).length;
	const caught = count(true, true);
	const missed = count(true, false);
	const falseAlarms = count(false, true);
	return {
		caught,
		missed,
		false_alarms: falseAlarms,
		clean: count(false, false),
		recall: ratio(caught, caught + missed).rate,
		precision: ratio(caught, caught + falseAlarms).rate,
	};
}
