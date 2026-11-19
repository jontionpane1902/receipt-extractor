import { describe, expect, test } from "bun:test";
import { recoverUnitPrice } from "./unit-price.ts";

// Invented rows: "qty name @unit amount".
describe("recoverUnitPrice", () => {
	test("marker lost entirely: the token is the unit price when qty × it = amount", () => {
		expect(recoverUnitPrice("12.50", 4, 50)).toEqual({
			unit_price: 12.5,
			repair: "marker_missing",
		});
		// decimal comma and a marker misread as a letter are handled by the number parser
		expect(recoverUnitPrice("12,50", 4, 50)?.unit_price).toBe(12.5);
		expect(recoverUnitPrice("อ12.50", 4, 50)).toEqual({
			unit_price: 12.5,
			repair: "marker_missing",
		});
	});

	test("marker read as a digit: one leading character is removed", () => {
		expect(recoverUnitPrice("812.50", 4, 50)).toEqual({
			unit_price: 12.5,
			repair: "leading_character_removed",
		});
		expect(recoverUnitPrice("019.00", 3, 57)?.unit_price).toBe(19);
	});

	test("never repairs when the arithmetic does not agree", () => {
		expect(recoverUnitPrice("812.50", 3, 50)).toBeNull();
		expect(recoverUnitPrice("13.50", 4, 50)).toBeNull();
		// removing two characters would work, but only one is allowed
		expect(recoverUnitPrice("8812.50", 4, 50)).toBeNull();
	});

	test("needs a known quantity above 1", () => {
		expect(recoverUnitPrice("12.50", null, 50)).toBeNull();
		expect(recoverUnitPrice("50.00", 1, 50)).toBeNull();
		expect(recoverUnitPrice("12.50", 2.5, 31.25)).toBeNull();
	});

	test("needs a known, positive amount: zero proves nothing", () => {
		expect(recoverUnitPrice("12.50", 4, null)).toBeNull();
		expect(recoverUnitPrice("0.00", 3, 0)).toBeNull();
		expect(recoverUnitPrice("60.00", 3, 0)).toBeNull();
	});

	test("ignores tokens that are not a two-decimal price", () => {
		expect(recoverUnitPrice("25", 2, 50)).toBeNull();
		expect(recoverUnitPrice("ขนม", 2, 50)).toBeNull();
		expect(recoverUnitPrice("", 2, 50)).toBeNull();
	});

	test("the as-read value wins over stripping when both would agree", () => {
		// 2 × 11.00 = 22.00; stripping the first 1 would give 1.00
		expect(recoverUnitPrice("11.00", 2, 22)).toEqual({
			unit_price: 11,
			repair: "marker_missing",
		});
	});
});
