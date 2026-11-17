import { type Receipt, type StoreChain, toSatang } from "../schema/receipt.ts";
import { similarity } from "./similarity.ts";
import type { CatalogEntry, CatalogStore } from "./store.ts";

export interface MatchOptions {
	/** Minimum grapheme similarity for a fuzzy match. */
	minSimilarity: number;
	/**
	 * An unconfirmed entry must have been seen at least this often to be a
	 * fuzzy-match target. Values below MIN_TIMES_SEEN_FLOOR are raised to it.
	 */
	minTimesSeen: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
	minSimilarity: 0.85,
	minTimesSeen: 5,
};

/**
 * Hard floor: an unconfirmed name seen once or twice may itself be an OCR
 * error, so it is never a correction target, whatever the options say.
 */
export const MIN_TIMES_SEEN_FLOOR = 3;

export type MatchKind = "exact" | "fuzzy" | "none";

export interface MatchResult {
	kind: MatchKind;
	/** Catalog name to use as normalized_name; null when there is no safe match. */
	normalized_name: string | null;
	/** Similarity to the chosen entry (1 for exact, 0 for none). */
	similarity: number;
	/** Why this result was chosen — kept for eval/debug output. */
	reason: string;
}

const NONE = (reason: string): MatchResult => ({
	kind: "none",
	normalized_name: null,
	similarity: 0,
	reason,
});

function isTrusted(entry: CatalogEntry, minTimesSeen: number): boolean {
	return (
		entry.status === "confirmed" ||
		entry.times_seen >= Math.max(minTimesSeen, MIN_TIMES_SEEN_FLOOR)
	);
}

/**
 * Finds the catalog name a raw receipt name should normalise to.
 *
 * 1. Exact name (after NFC/whitespace/case normalisation) → that entry.
 * 2. Otherwise a fuzzy match, only toward entries that are confirmed or
 *    frequently seen, AND have the same unit price, AND are highly similar
 *    by grapheme clusters.
 * 3. Two different trusted entries tying for best → no match (ambiguous).
 *
 * Deliberately conservative: a wrong "correction" is worse than leaving
 * normalized_name empty. Never changes raw_name.
 */
export async function matchName(
	store: CatalogStore,
	chain: StoreChain,
	rawName: string,
	unitPrice: number | null,
	options: Partial<MatchOptions> = {},
): Promise<MatchResult> {
	const { minSimilarity, minTimesSeen } = {
		...DEFAULT_MATCH_OPTIONS,
		...options,
	};

	const exact = await store.get(chain, rawName);
	if (exact) {
		return {
			kind: "exact",
			normalized_name: exact.name,
			similarity: 1,
			reason: "name already in catalog",
		};
	}
	if (unitPrice === null) {
		return NONE("no unit price to confirm a fuzzy match");
	}

	const price = toSatang(unitPrice);
	const candidates = (await store.list(chain))
		.filter((entry) => isTrusted(entry, minTimesSeen))
		.filter((entry) => toSatang(entry.last_price) === price)
		.map((entry) => ({ entry, score: similarity(rawName, entry.name) }))
		.filter((candidate) => candidate.score >= minSimilarity)
		.sort((a, b) => b.score - a.score);

	const [best, runnerUp] = candidates;
	if (!best) {
		return NONE("no trusted entry with the same price is similar enough");
	}
	if (runnerUp && runnerUp.score === best.score) {
		return NONE(
			`ambiguous: "${best.entry.name}" and "${runnerUp.entry.name}" are equally similar`,
		);
	}
	return {
		kind: "fuzzy",
		normalized_name: best.entry.name,
		similarity: best.score,
		reason: `${best.entry.status} entry seen ${best.entry.times_seen}×, same price`,
	};
}

/**
 * Records one sighting of a name at a price. New names start unconfirmed
 * with times_seen = 1; existing ones are counted and their price updated.
 * A human-confirmed entry stays confirmed.
 *
 * Call this only for receipts that passed validation, with the raw name:
 * the catalog must count what was actually printed.
 */
export async function observeName(
	store: CatalogStore,
	chain: StoreChain,
	rawName: string,
	unitPrice: number,
): Promise<CatalogEntry> {
	const existing = await store.get(chain, rawName);
	const entry: CatalogEntry = existing
		? {
				...existing,
				last_price: unitPrice,
				times_seen: existing.times_seen + 1,
			}
		: {
				store_chain: chain,
				name: rawName.normalize("NFC").trim().replace(/\s+/g, " "),
				last_price: unitPrice,
				times_seen: 1,
				status: "unconfirmed",
			};
	await store.put(entry);
	return entry;
}

/**
 * Returns a copy of the receipt with normalized_name set on each item
 * from the catalog. raw_name is left exactly as extracted.
 */
export async function normalizeItems(
	store: CatalogStore,
	receipt: Receipt,
	options: Partial<MatchOptions> = {},
): Promise<Receipt> {
	const items = await Promise.all(
		receipt.items.map(async (item) => {
			const unitPrice =
				item.unit_price ?? (item.qty === 1 ? item.amount : null);
			const match = await matchName(
				store,
				receipt.store_chain,
				item.raw_name,
				unitPrice,
				options,
			);
			return { ...item, normalized_name: match.normalized_name };
		}),
	);
	return { ...receipt, items };
}
