import { describe, expect, test } from "bun:test";
import {
	editDistance,
	graphemeDistance,
	graphemes,
	normalizeForCompare,
	similarity,
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
