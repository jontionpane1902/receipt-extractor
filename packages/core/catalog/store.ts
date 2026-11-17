import type { StoreChain } from "../schema/receipt.ts";
import { normalizeForCompare } from "./similarity.ts";

export type CatalogStatus = "unconfirmed" | "confirmed";

/**
 * One product name as observed on receipts. The catalog is learned only
 * from receipts (no scraping), keyed by store chain + name.
 */
export interface CatalogEntry {
	store_chain: StoreChain;
	/** Name as first observed (or as confirmed by a human). */
	name: string;
	/** Most recent unit price in baht. */
	last_price: number;
	times_seen: number;
	status: CatalogStatus;
}

/**
 * Storage boundary for the catalog. Core only knows this interface; the
 * API will implement it on D1/Drizzle. Lookups are by chain + name,
 * compared through `catalogKey`.
 */
export interface CatalogStore {
	get(chain: StoreChain, name: string): Promise<CatalogEntry | null>;
	list(chain: StoreChain): Promise<CatalogEntry[]>;
	put(entry: CatalogEntry): Promise<void>;
}

export function catalogKey(chain: StoreChain, name: string): string {
	return `${chain}\u0000${normalizeForCompare(name)}`;
}

export class InMemoryCatalogStore implements CatalogStore {
	readonly #entries = new Map<string, CatalogEntry>();

	constructor(entries: readonly CatalogEntry[] = []) {
		for (const entry of entries) {
			this.#entries.set(catalogKey(entry.store_chain, entry.name), {
				...entry,
			});
		}
	}

	async get(chain: StoreChain, name: string): Promise<CatalogEntry | null> {
		const entry = this.#entries.get(catalogKey(chain, name));
		return entry ? { ...entry } : null;
	}

	async list(chain: StoreChain): Promise<CatalogEntry[]> {
		return [...this.#entries.values()]
			.filter((entry) => entry.store_chain === chain)
			.map((entry) => ({ ...entry }));
	}

	async put(entry: CatalogEntry): Promise<void> {
		this.#entries.set(catalogKey(entry.store_chain, entry.name), { ...entry });
	}
}
