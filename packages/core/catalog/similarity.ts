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
 * Similarity in 0..1: 1 − distance / longer length, over grapheme clusters
 * of the normalised strings. Two empty strings are identical (1).
 */
export function similarity(a: string, b: string): number {
	const ga = graphemes(normalizeForCompare(a));
	const gb = graphemes(normalizeForCompare(b));
	const longest = Math.max(ga.length, gb.length);
	return longest === 0 ? 1 : 1 - editDistance(ga, gb) / longest;
}
