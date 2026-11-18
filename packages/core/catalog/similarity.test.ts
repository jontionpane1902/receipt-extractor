import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LOOKALIKES,
	editDistance,
	graphemeDistance,
	graphemes,
	normalizeForCompare,
	similarity,
	weightedEditDistance,
} from "./similarity.ts";

describe("graphemes", () => {
	test("keeps Thai stacked vowels and tone marks with their consonant", () => {
		expect(graphemes("น้ำดื่ม")).toEqual(["น้ำ", "ดื่", "ม"]);
		expect(graphemes("ที่")).toEqual(["ที่"]);
		expect([..."ที่"]).toHaveLength(3); // code points, for contrast
	});

	test("splits Latin text per letter", () => {
		expect(graphemes("Cafe")).toEqual(["C", "a", "f", "e"]);
	});
});

describe("graphemeDistance", () => {
	test("a misread stacked character is one edit, not one per code point", () => {
		// "ดื่" (3 code points) misread as "ด" — one cluster substituted.
		expect(graphemeDistance("น้ำดื่ม", "น้ำดม")).toBe(1);
		expect(editDistance([..."น้ำดื่ม"], [..."น้ำดม"])).toBe(2);
	});

	test("basic edit distances", () => {
		expect(graphemeDistance("", "")).toBe(0);
		expect(graphemeDistance("abc", "")).toBe(3);
		expect(graphemeDistance("kitten", "sitting")).toBe(3);
	});
});

describe("similarity", () => {
	test("is 1 for identical names and ignores case, spacing and Unicode form", () => {
		expect(similarity("DEMO Tea", "demo  tea ")).toBe(1);
		expect(similarity("café", "café")).toBe(1);
		expect(similarity("", "")).toBe(1);
	});

	test("is 0 for completely different names", () => {
		expect(similarity("abc", "xyz")).toBe(0);
	});

	test("scores a one-cluster Thai misread by clusters", () => {
		// 3 clusters, 1 wrong → 1 − 1/3.
		expect(similarity("น้ำดื่ม", "น้ำดืม")).toBeCloseTo(2 / 3, 10);
	});

	test("is symmetric", () => {
		expect(similarity("ขนมข้าวพองสมมติ", "ขนมข้าวพองสมมดิ")).toBe(
			similarity("ขนมข้าวพองสมมดิ", "ขนมข้าวพองสมมติ"),
		);
	});
});

describe("normalizeForCompare", () => {
	test("trims, collapses whitespace and lower-cases", () => {
		expect(normalizeForCompare("  DEMO   Tea\t")).toBe("demo tea");
	});
});

describe("look-alike substitutions", () => {
	const withTable = { lookalikes: DEFAULT_LOOKALIKES };

	test("off by default: similarity() is plain edit distance", () => {
		expect(similarity("ขนม", "ชนม")).toBeCloseTo(2 / 3, 10);
	});

	test("a look-alike consonant costs a quarter of an edit", () => {
		expect(similarity("ขนม", "ชนม", withTable)).toBeCloseTo(1 - 0.25 / 3, 10);
		expect(similarity("ดาว", "ตาว", withTable)).toBeCloseTo(1 - 0.25 / 3, 10);
	});

	test("groups work in every direction", () => {
		for (const [a, b] of [
			["พา", "ฟา"],
			["ฟา", "หา"],
			["หา", "พา"],
		] as const) {
			expect(similarity(a, b, withTable)).toBeCloseTo(1 - 0.25 / 2, 10);
			expect(similarity(b, a, withTable)).toBe(similarity(a, b, withTable));
		}
	});

	test("works inside a stacked cluster, keeping the other marks", () => {
		// "ดื่" vs "ดี่": same consonant and tone mark, look-alike vowel.
		expect(similarity("ดื่ม", "ดี่ม", withTable)).toBeCloseTo(1 - 0.25 / 2, 10);
		// consonant and vowel both look-alikes in one cluster: costs add up.
		expect(similarity("ดื่ม", "ตี่ม", withTable)).toBeCloseTo(1 - 0.5 / 2, 10);
	});

	test("a real difference still costs a full edit", () => {
		expect(similarity("ขนม", "กนม", withTable)).toBeCloseTo(2 / 3, 10);
		// Different tone mark on a look-alike consonant: not a pure look-alike.
		expect(similarity("ข้า", "ช่า", withTable)).toBeCloseTo(1 / 2, 10);
		// Missing mark: clusters have different lengths.
		expect(similarity("ดื่ม", "ดืม", withTable)).toBeCloseTo(1 / 2, 10);
	});

	test("identical names are still exactly 1, different ones below 1", () => {
		expect(similarity("ข้าวผัด", "ข้าวผัด", withTable)).toBe(1);
		expect(similarity("ข้าวผัด", "ช้าวผัต", withTable)).toBeLessThan(1);
	});

	test("the default table is small and every cost is a fraction of an edit", () => {
		expect(DEFAULT_LOOKALIKES.length).toBeLessThanOrEqual(16);
		for (const group of DEFAULT_LOOKALIKES) {
			expect(group.cost).toBeGreaterThan(0);
			expect(group.cost).toBeLessThan(1);
		}
	});

	test("pairs added from later receipts cost a fraction of an edit", () => {
		for (const [a, b] of [
			["จาน", "ดาน"],
			["คาว", "ดาว"],
			["ลาย", "อาย"],
			["นาง", "พาง"],
			["ตาม", "หาม"],
		] as const) {
			expect(similarity(a, b, withTable)).toBeCloseTo(1 - 0.25 / 3, 10);
		}
	});

	test("pairs do not chain: A/B and B/C do not make A/C a look-alike", () => {
		// ล/อ and ย/อ are in the table; ล/ย is not.
		expect(similarity("ลาน", "ยาน", withTable)).toBeCloseTo(2 / 3, 10);
		// น/พ and พ/ห are in the table; น/ห is not.
		expect(similarity("นาม", "หาม", withTable)).toBeCloseTo(2 / 3, 10);
	});

	test("a custom table can be supplied", () => {
		// Names are lower-cased before comparing, so list Latin letters in lower case.
		const custom = [{ chars: ["0", "o"], cost: 0.1 }];
		expect(similarity("A0", "AO", { lookalikes: custom })).toBeCloseTo(
			0.95,
			10,
		);
		expect(similarity("ขนม", "ชนม", { lookalikes: custom })).toBeCloseTo(
			2 / 3,
			10,
		);
	});
});

describe("weightedEditDistance", () => {
	test("equals plain edit distance with 0/1 costs", () => {
		const plain = (x: string, y: string) => (x === y ? 0 : 1);
		expect(weightedEditDistance([..."kitten"], [..."sitting"], plain)).toBe(3);
		expect(weightedEditDistance([], [..."abc"], plain)).toBe(3);
	});
});
