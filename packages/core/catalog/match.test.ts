import { describe, expect, test } from "bun:test";
import { sampleReceipt } from "../schema/fixtures.ts";
import { matchName, normalizeItems, observeName } from "./match.ts";
import { NO_LOOKALIKES } from "./similarity.ts";
import { type CatalogEntry, InMemoryCatalogStore } from "./store.ts";

const CHAIN = "7-eleven" as const;
const GOOD = "ขนมข้าวพองสมมติรสดั้งเดิม 48ก";
/** The same invented name with one cluster misread ("ต" → "ด"). */
const MISREAD = "ขนมข้าวพองสมมดิรสดั้งเดิม 48ก";

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
	store_chain: CHAIN,
	name: GOOD,
	last_price: 20,
	times_seen: 10,
	status: "unconfirmed",
	...over,
});

describe("matchName", () => {
	test("exact name matches whatever the entry's status or count", async () => {
		const store = new InMemoryCatalogStore([entry({ times_seen: 1 })]);
		const result = await matchName(store, CHAIN, `  ${GOOD} `, 20);
		expect(result).toMatchObject({ kind: "exact", normalized_name: GOOD });
	});

	test("fuzzy-matches a misread toward a frequently seen entry at the same price", async () => {
		const store = new InMemoryCatalogStore([entry({ times_seen: 10 })]);
		const result = await matchName(store, CHAIN, MISREAD, 20);
		expect(result.kind).toBe("fuzzy");
		expect(result.normalized_name).toBe(GOOD);
		expect(result.similarity).toBeGreaterThan(0.9);
	});

	test("fuzzy-matches toward a confirmed entry even if rarely seen", async () => {
		const store = new InMemoryCatalogStore([
			entry({ times_seen: 1, status: "confirmed" }),
		]);
		expect((await matchName(store, CHAIN, MISREAD, 20)).kind).toBe("fuzzy");
	});

	test("never corrects toward an unconfirmed entry seen once or twice", async () => {
		for (const times_seen of [1, 2]) {
			const store = new InMemoryCatalogStore([entry({ times_seen })]);
			const result = await matchName(store, CHAIN, MISREAD, 20, {
				minTimesSeen: 1, // even when a caller tries to lower the bar
			});
			expect(result).toMatchObject({ kind: "none", normalized_name: null });
		}
	});

	test("does not match below the default times-seen threshold", async () => {
		const store = new InMemoryCatalogStore([entry({ times_seen: 4 })]);
		expect((await matchName(store, CHAIN, MISREAD, 20)).kind).toBe("none");
	});

	test("requires the same price", async () => {
		const store = new InMemoryCatalogStore([entry({ last_price: 22 })]);
		expect((await matchName(store, CHAIN, MISREAD, 20)).kind).toBe("none");
		expect((await matchName(store, CHAIN, MISREAD, null)).kind).toBe("none");
	});

	test("requires high similarity", async () => {
		const store = new InMemoryCatalogStore([entry({})]);
		const result = await matchName(store, CHAIN, "ขนมรสสาหร่ายทะเล 48ก", 20);
		expect(result.kind).toBe("none");
	});

	test("does not cross store chains", async () => {
		const store = new InMemoryCatalogStore([entry({})]);
		expect((await matchName(store, "unknown", MISREAD, 20)).kind).toBe("none");
	});

	test("refuses to choose between two equally similar entries", async () => {
		const store = new InMemoryCatalogStore([
			entry({ name: "นมสดตราสมมติ 200มล A" }),
			entry({ name: "นมสดตราสมมติ 200มล B" }),
		]);
		const result = await matchName(store, CHAIN, "นมสดตราสมมติ 200มล C", 20, {
			minSimilarity: 0.8,
		});
		expect(result.kind).toBe("none");
		expect(result.reason).toContain("ambiguous");
	});

	test("picks the most similar trusted entry", async () => {
		const store = new InMemoryCatalogStore([
			entry({}),
			entry({ name: "ขนมข้าวพองสมมติรสดั้งเดิม 75ก" }),
		]);
		const result = await matchName(store, CHAIN, MISREAD, 20);
		expect(result.normalized_name).toBe(GOOD);
	});
});

describe("matchName with look-alike substitutions (invented names)", () => {
	// 11 grapheme clusters. Three look-alike misreads: ข→ช, ด→ต, ฟ→ห.
	const TRUE_NAME = "ขนมดาวฟ้าทอง";
	const NOISY = "ชนมตาวห้าทอง";
	// A different product: three real character differences, same length.
	const OTHER_PRODUCT = "กนมลาวม้าทอง";
	const store = () =>
		new InMemoryCatalogStore([entry({ name: TRUE_NAME, status: "confirmed" })]);

	test("a noisy reading does not match by plain edit distance", async () => {
		const result = await matchName(store(), CHAIN, NOISY, 20, {
			lookalikes: NO_LOOKALIKES,
		});
		expect(result.kind).toBe("none");
	});

	test("the same reading matches its true name with the default table", async () => {
		const result = await matchName(store(), CHAIN, NOISY, 20);
		expect(result).toMatchObject({ kind: "fuzzy", normalized_name: TRUE_NAME });
		expect(result.similarity).toBeCloseTo(1 - 0.75 / 11, 10);
	});

	test("a name with as many real differences is not merged at the same threshold", async () => {
		expect((await matchName(store(), CHAIN, OTHER_PRODUCT, 20)).kind).toBe(
			"none",
		);
	});

	test("two catalog products one real character apart stay distinct", async () => {
		const both = new InMemoryCatalogStore([
			entry({ name: "ขนมดาวฟ้าทอง 40ก", status: "confirmed" }),
			entry({ name: "ขนมดาวฟ้าทอง 90ก", status: "confirmed" }),
		]);
		// Look-alike noise on the name, the distinguishing digit read correctly.
		const result = await matchName(both, CHAIN, "ชนมตาวห้าทอง 90ก", 20);
		expect(result).toMatchObject({
			kind: "fuzzy",
			normalized_name: "ขนมดาวฟ้าทอง 90ก",
		});
	});

	test("the safety floors still apply", async () => {
		const rarelySeen = new InMemoryCatalogStore([
			entry({ name: TRUE_NAME, times_seen: 2 }),
		]);
		expect((await matchName(rarelySeen, CHAIN, NOISY, 20)).kind).toBe("none");
		expect((await matchName(store(), CHAIN, NOISY, 25)).kind).toBe("none");
		expect((await matchName(store(), CHAIN, NOISY, null)).kind).toBe("none");
	});

	test("look-alike twins at the same price are refused as ambiguous", async () => {
		const twins = new InMemoryCatalogStore([
			entry({ name: "ขนมดาว", status: "confirmed" }),
			entry({ name: "ชนมดาว", status: "confirmed" }),
		]);
		const result = await matchName(twins, CHAIN, "หนมดาว", 20, {
			minSimilarity: 0.8,
		});
		expect(result.kind).toBe("none");
	});
});

describe("observeName", () => {
	test("adds a new name as unconfirmed, seen once", async () => {
		const store = new InMemoryCatalogStore();
		const created = await observeName(store, CHAIN, " ชาเย็นหอม  DEMO TEA ", 35);
		expect(created).toEqual({
			store_chain: CHAIN,
			name: "ชาเย็นหอม DEMO TEA",
			last_price: 35,
			times_seen: 1,
			status: "unconfirmed",
		});
	});

	test("counts repeat sightings, updates price, keeps name and status", async () => {
		const store = new InMemoryCatalogStore([
			entry({ times_seen: 2, status: "confirmed" }),
		]);
		const updated = await observeName(store, CHAIN, GOOD.toUpperCase(), 22);
		expect(updated).toMatchObject({
			name: GOOD,
			last_price: 22,
			times_seen: 3,
			status: "confirmed",
		});
		expect(await store.list(CHAIN)).toHaveLength(1);
	});

	test("a name becomes a fuzzy target only after enough sightings", async () => {
		const store = new InMemoryCatalogStore();
		for (let seen = 1; seen <= 5; seen++) {
			await observeName(store, CHAIN, GOOD, 20);
			const { kind } = await matchName(store, CHAIN, MISREAD, 20);
			expect(kind).toBe(seen >= 5 ? "fuzzy" : "none");
		}
	});
});

describe("normalizeItems", () => {
	test("sets normalized_name and never touches raw_name", async () => {
		const receipt = sampleReceipt();
		const second = receipt.items[1];
		if (!second) throw new Error("fixture is missing item 2");
		second.raw_name = MISREAD;
		const store = new InMemoryCatalogStore([entry({})]);

		const result = await normalizeItems(store, receipt);

		expect(result.items[1]).toMatchObject({
			raw_name: MISREAD,
			normalized_name: GOOD,
		});
		expect(result.items[0]?.normalized_name).toBeNull();
		expect(result.items.map((i) => i.raw_name)).toEqual(
			receipt.items.map((i) => i.raw_name),
		);
		expect(receipt.items[1]?.normalized_name).toBeNull(); // input not mutated
	});
});

describe("InMemoryCatalogStore", () => {
	test("returns copies, so callers cannot mutate stored entries", async () => {
		const store = new InMemoryCatalogStore([entry({})]);
		const found = await store.get(CHAIN, GOOD);
		if (found) found.times_seen = 999;
		expect((await store.get(CHAIN, GOOD))?.times_seen).toBe(10);
	});
});
