import { describe, expect, test } from "bun:test";
import { ambiguousNumbers, numbersIn, parseNumberTokens } from "./numbers.ts";

/** The single token in a text. */
function one(text: string) {
	const tokens = parseNumberTokens(text);
	expect(tokens).toHaveLength(1);
	const [token] = tokens;
	if (!token) throw new Error("no token");
	return token;
}

describe("plain numbers", () => {
	test("integers and ordinary decimals", () => {
		expect(one("12")).toMatchObject({
			value: 12,
			decimals: 0,
			notes: [],
			ambiguous: null,
		});
		expect(one("35.00")).toMatchObject({
			value: 35,
			decimals: 2,
			kind: "amount",
		});
		expect(one("7.5")).toMatchObject({ value: 7.5, decimals: 1 });
		expect(one("(4)").value).toBe(4);
	});

	test("Thai digits", () => {
		expect(one("๘๐.๗๖").value).toBe(80.76);
	});

	test("records where the token sits in the text", () => {
		const token = one("รวม 64.00 บาท");
		expect("รวม 64.00 บาท".slice(token.start, token.end)).toBe("64.00");
		expect(token.raw).toBe("64.00");
	});
});

describe("decimal comma", () => {
	test("comma followed by exactly two digits is a decimal", () => {
		expect(one("5,00")).toMatchObject({
			value: 5,
			decimals: 2,
			notes: ["decimal_comma"],
		});
		expect(one("219,75")).toMatchObject({
			value: 219.75,
			notes: ["decimal_comma"],
		});
		expect(one("0,00").value).toBe(0);
	});

	test("a genuine thousands separator still parses", () => {
		expect(one("1,250.00")).toMatchObject({
			value: 1250,
			decimals: 2,
			notes: ["thousands_separator"],
		});
		expect(one("1,250")).toMatchObject({ value: 1250, decimals: 0 });
		expect(one("12,345,678.90").value).toBe(12345678.9);
	});

	test("thousands comma plus decimal comma", () => {
		expect(one("1,250,00")).toMatchObject({
			value: 1250,
			decimals: 2,
			notes: ["thousands_separator", "decimal_comma"],
		});
	});
});

describe("stray space after the decimal point", () => {
	test("is repaired and noted", () => {
		expect(one("118. 25")).toMatchObject({
			value: 118.25,
			decimals: 2,
			notes: ["space_after_point"],
			raw: "118. 25",
		});
	});

	test("only for exactly two following digits", () => {
		expect(parseNumberTokens("118. 250").map((t) => t.value)).toEqual([
			118, 250,
		]);
		expect(parseNumberTokens("118. 2").map((t) => t.value)).toEqual([118, 2]);
	});
});

describe("amount suffix flags", () => {
	test("N and NP are captured as a flag, not part of the number", () => {
		expect(one("18.50N")).toMatchObject({
			value: 18.5,
			suffix: "N",
			raw: "18.50N",
		});
		expect(one("0.00NP")).toMatchObject({ value: 0, suffix: "NP" });
		expect(one("18,50N")).toMatchObject({
			value: 18.5,
			suffix: "N",
			notes: ["decimal_comma"],
		});
	});

	test("an unknown suffix does not break the parse and is noted", () => {
		expect(one("4.00NX")).toMatchObject({
			value: 4,
			suffix: null,
			notes: ["unknown_suffix"],
		});
	});

	test("letters after a non-amount are units or words, not flags", () => {
		const token = one("600ML");
		expect(token).toMatchObject({
			value: 600,
			suffix: null,
			notes: [],
			raw: "600",
		});
		expect(one("48N ").suffix).toBeNull();
		expect(one("12.00Nx").suffix).toBeNull();
	});
});

describe("unit price", () => {
	test("@price is a unit price, the bare number after it a line amount", () => {
		const tokens = parseNumberTokens("3 @12.00 36.00");
		expect(tokens.map((t) => [t.value, t.kind])).toEqual([
			[3, "amount"],
			[12, "unit_price"],
			[36, "amount"],
		]);
		expect(one("@ 0,50")).toMatchObject({ value: 0.5, kind: "unit_price" });
	});
});

describe("sign", () => {
	test("a leading minus is a sign; a hyphen inside a code is not", () => {
		expect(one("-5.00").value).toBe(-5);
		expect(one("ส่วนลด -12,50").value).toBe(-12.5);
		expect(parseNumberTokens("0-2000-1234").map((t) => t.value)).toEqual([
			0, 2000, 1234,
		]);
		expect(one("A-7").value).toBe(7);
	});
});

describe("ambiguous cases are flagged, not guessed", () => {
	test.each([
		["12,5", "comma is neither"],
		["1,2500", "comma is neither"],
		["12,34,567", "comma is neither"],
		["1.250", "three or more digits"],
		["1.250,00", "comma after the decimal point"],
		["17.11.69", "more than one decimal point"],
		["1,25.00", "not a valid thousands separator"],
	])("%s", (text, reason) => {
		const token = one(text);
		expect(token.value).toBeNull();
		expect(token.ambiguous).toContain(reason);
		expect(ambiguousNumbers(text)).toHaveLength(1);
		expect(numbersIn(text).size).toBe(0);
	});
});

describe("identifiers", () => {
	test("very long digit runs are not money", () => {
		expect(parseNumberTokens("1234567890123456789")).toEqual([]);
		expect(one("9012345678902").value).toBe(9012345678902);
	});
});

describe("numbersIn", () => {
	test("returns absolute satang values of every unambiguous number", () => {
		expect(
			[...numbersIn("2 @7.00 14.00 -5.00 1,000 5,00 118. 25 9.50N")].sort(
				(a, b) => a - b,
			),
		).toEqual([200, 500, 700, 950, 1400, 11825, 100000]);
	});

	test("can leave out unit prices", () => {
		const text = "3 @12.00 36.00";
		expect(numbersIn(text).has(1200)).toBe(true);
		expect(numbersIn(text, { excludeUnitPrices: true }).has(1200)).toBe(false);
		expect(numbersIn(text, { excludeUnitPrices: true }).has(3600)).toBe(true);
	});
});
