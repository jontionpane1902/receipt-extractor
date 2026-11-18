const segmenter = new Intl.Segmenter("th", { granularity: "grapheme" });

/**
 * Splits text into grapheme clusters (user-perceived characters).
 *
 * Thai stacks vowels and tone marks on a consonant: "น้ำ" is 3 code points
 * but one cluster. Comparing by code point would count a single misread
 * stacked character as several edits and skew similarity for Thai names.
 */
export function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * Canonical form used for comparing and keying names: NFC, trimmed,
 * whitespace collapsed, Latin lower-cased. The stored name is never
 * replaced by this form.
 */
export function normalizeForCompare(name: string): string {
	return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Levenshtein distance over arbitrary tokens. */
export function editDistance(
	a: readonly string[],
	b: readonly string[],
): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitution =
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			const deletion = (previous[j] ?? 0) + 1;
			const insertion = (current[j - 1] ?? 0) + 1;
			current.push(Math.min(substitution, deletion, insertion));
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/** Edit distance between two strings counted in grapheme clusters. */
export function graphemeDistance(a: string, b: string): number {
	return editDistance(graphemes(a), graphemes(b));
}

/**
 * Characters that thermal print makes OCR confuse with each other.
 * Swapping one for another inside a cluster costs `cost` instead of 1.
 */
export interface LookalikeGroup {
	/** Single characters, as they appear after normalisation (Latin in lower case). */
	chars: readonly string[];
	/** 0..1. Lower = more forgiving. */
	cost: number;
}

export const LOOKALIKE_COST = 0.25;

/**
 * Default look-alike table: only confusions actually observed between
 * owner-labelled receipts and the OCR model's reading of them.
 *
 * Admission rule: a pair is added when it was seen on at least two
 * different receipts, or at least three times in total. Pairs are kept as
 * separate two-character groups unless every member was seen confused
 * with every other, so that A/B and B/C never imply A/C.
 *
 * First receipt (thermal print, shapes one small stroke apart):
 *   ข / ช        notch on the head
 *   พ / ฟ / ห    tail or middle stroke
 *   ด / ต        notch on the head
 *   ื / ี        upper vowels one small stroke apart
 *
 * Added after four labelled receipts (six captures):
 *   จ / ด, ค / ด, ค / จ, จ / ล, จ / ฯ   round-headed letters collapsing,
 *                                      mostly on low-resolution photos
 *   ล / อ, ย / อ                        open versus closed bowl
 *   น / พ, น / ฟ, ต / ห                 seen on one clear receipt, 4–5 times each
 *
 * Every entry makes two different names look more alike. Re-run the
 * catalog eval on all labelled receipts after any change and check for
 * false merges.
 */
export const DEFAULT_LOOKALIKES: readonly LookalikeGroup[] = [
	{ chars: ["ข", "ช"], cost: LOOKALIKE_COST },
	{ chars: ["พ", "ฟ", "ห"], cost: LOOKALIKE_COST },
	{ chars: ["ด", "ต"], cost: LOOKALIKE_COST },
	{ chars: ["ื", "ี"], cost: LOOKALIKE_COST },
	{ chars: ["จ", "ด"], cost: LOOKALIKE_COST },
	{ chars: ["ค", "ด"], cost: LOOKALIKE_COST },
	{ chars: ["ค", "จ"], cost: LOOKALIKE_COST },
	{ chars: ["จ", "ล"], cost: LOOKALIKE_COST },
	{ chars: ["จ", "ฯ"], cost: LOOKALIKE_COST },
	{ chars: ["ล", "อ"], cost: LOOKALIKE_COST },
	{ chars: ["ย", "อ"], cost: LOOKALIKE_COST },
	{ chars: ["น", "พ"], cost: LOOKALIKE_COST },
	{ chars: ["น", "ฟ"], cost: LOOKALIKE_COST },
	{ chars: ["ต", "ห"], cost: LOOKALIKE_COST },
];

/** No substitutions: every differing cluster costs a full edit. */
export const NO_LOOKALIKES: readonly LookalikeGroup[] = [];

function pairCosts(groups: readonly LookalikeGroup[]): Map<string, number> {
	const costs = new Map<string, number>();
	for (const group of groups) {
		for (const a of group.chars) {
			for (const b of group.chars) {
				if (a === b) continue;
				const key = `${a}\u0000${b}`;
				costs.set(key, Math.min(costs.get(key) ?? 1, group.cost));
			}
		}
	}
	return costs;
}

/**
 * Cost of replacing one grapheme cluster with another: 0 if equal; the sum
 * of look-alike costs (at most 1) if the clusters have the same number of
 * code points and differ only by look-alike characters in the same
 * positions; otherwise 1.
 */
function clusterCost(a: string, b: string, costs: Map<string, number>): number {
	if (a === b) return 0;
	if (costs.size === 0) return 1;
	const pa = [...a];
	const pb = [...b];
	if (pa.length !== pb.length) return 1;
	let total = 0;
	for (let i = 0; i < pa.length; i++) {
		if (pa[i] === pb[i]) continue;
		const cost = costs.get(`${pa[i]}\u0000${pb[i]}`);
		if (cost === undefined) return 1;
		total += cost;
	}
	return Math.min(1, total);
}

/** Levenshtein distance with a per-pair substitution cost in 0..1. */
export function weightedEditDistance(
	a: readonly string[],
	b: readonly string[],
	substitution: (x: string, y: string) => number,
): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current.push(
				Math.min(
					(previous[j - 1] ?? 0) + substitution(a[i - 1] ?? "", b[j - 1] ?? ""),
					(previous[j] ?? 0) + 1,
					(current[j - 1] ?? 0) + 1,
				),
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

export interface SimilarityOptions {
	/** Look-alike table; omit for plain edit distance. */
	lookalikes?: readonly LookalikeGroup[];
}

/**
 * Similarity in 0..1: 1 − distance / longer length, over grapheme clusters
 * of the normalised strings. Two empty strings are identical (1). With a
 * look-alike table, a cluster that differs only by look-alike characters
 * counts as a fraction of an edit.
 */
export function similarity(
	a: string,
	b: string,
	options: SimilarityOptions = {},
): number {
	const ga = graphemes(normalizeForCompare(a));
	const gb = graphemes(normalizeForCompare(b));
	const longest = Math.max(ga.length, gb.length);
	if (longest === 0) return 1;
	const costs = pairCosts(options.lookalikes ?? NO_LOOKALIKES);
	const distance =
		costs.size === 0
			? editDistance(ga, gb)
			: weightedEditDistance(ga, gb, (x, y) => clusterCost(x, y, costs));
	return 1 - distance / longest;
}
