import { describe, expect, test } from "bun:test";
import {
	combineQuantityAndPrice,
	inferUnitPriceAndQuantity,
	recoverUnitPrice,
} from "./unit-price.ts";

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

// Invented rows throughout.
describe("inferUnitPriceAndQuantity (quantity unknown)", () => {
	test("clean case: amount is a whole multiple of the unit price", () => {
		expect(inferUnitPriceAndQuantity(["@19.00", "57.00"])).toEqual({
			status: "inferred",
			unit_price: 19,
			quantity: 3,
			repair: "none",
		});
		// marker lost, or read as a letter: the number parser already ignores a leading letter
		expect(inferUnitPriceAndQuantity(["19.00", "57.00"])).toMatchObject({
			status: "inferred",
			unit_price: 19,
			quantity: 3,
			repair: "marker_missing",
		});
		expect(inferUnitPriceAndQuantity(["อ19.00", "57.00"])).toMatchObject({
			status: "inferred",
			quantity: 3,
		});
		// both numbers in one OCR line
		expect(inferUnitPriceAndQuantity(["3 @ 19.00 57.00"])).toMatchObject({
			status: "inferred",
			unit_price: 19,
			quantity: 3,
		});
	});

	test("marker misread as a leading digit", () => {
		expect(inferUnitPriceAndQuantity(["819.00", "57.00"])).toEqual({
			status: "inferred",
			unit_price: 19,
			quantity: 3,
			repair: "leading_character_removed",
		});
	});

	test("both candidates valid with different results: ambiguous, nothing chosen", () => {
		// 24.00 × 2 = 48.00, but so is 4.00 × 12 if the leading 2 was the marker.
		const result = inferUnitPriceAndQuantity(["24.00", "48.00"]);
		expect(result.status).toBe("ambiguous");
		if (result.status !== "ambiguous") throw new Error("expected ambiguity");
		expect(result.candidates.map((c) => [c.unit_price, c.quantity])).toEqual([
			[24, 2],
			[4, 12],
		]);
	});

	test("a marker that was actually read is never stripped", () => {
		expect(inferUnitPriceAndQuantity(["@24.00", "48.00"])).toMatchObject({
			status: "inferred",
			unit_price: 24,
			quantity: 2,
		});
	});

	test("non-integer ratio, quantity 1 and out-of-range quantity are unexplained", () => {
		expect(inferUnitPriceAndQuantity(["19.00", "50.00"]).status).toBe(
			"unexplained",
		);
		expect(inferUnitPriceAndQuantity(["50.00", "50.00"]).status).toBe(
			"unexplained",
		);
		expect(inferUnitPriceAndQuantity(["0.50", "100.00"]).status).toBe(
			"unexplained",
		); // 200
		expect(
			inferUnitPriceAndQuantity(["0.50", "100.00"], { maxQuantity: 500 }),
		).toMatchObject({ status: "inferred", quantity: 200 });
	});

	test("zero or negative amounts and zero prices never fire", () => {
		expect(inferUnitPriceAndQuantity(["0.00", "0.00"]).status).toBe(
			"not_applicable",
		);
		expect(inferUnitPriceAndQuantity(["60.00", "0.00"]).status).toBe(
			"not_applicable",
		);
		expect(inferUnitPriceAndQuantity(["5.00", "-10.00"]).status).toBe(
			"not_applicable",
		);
		expect(inferUnitPriceAndQuantity(["0.00", "10.00"]).status).toBe(
			"unexplained",
		);
	});

	test("needs exactly two amount-like tokens", () => {
		expect(inferUnitPriceAndQuantity(["57.00"]).status).toBe("not_applicable");
		expect(inferUnitPriceAndQuantity([]).status).toBe("not_applicable");
		expect(inferUnitPriceAndQuantity(["19.00", "57.00", "3.00"]).status).toBe(
			"not_applicable",
		);
		// a bare integer is not an amount: "(3)" beside one amount is still one amount
		expect(inferUnitPriceAndQuantity(["(3)", "57.00"]).status).toBe(
			"not_applicable",
		);
	});

	test("does not fire on totals, payment or discount rows", () => {
		// Each of these has two amounts where one divides the other.
		for (const role of ["totals", "payment", "discount"] as const) {
			expect(inferUnitPriceAndQuantity(["50.00", "100.00"], { role })).toEqual({
				status: "not_applicable",
				reason: `${role} row`,
			});
		}
	});
});

describe("combineQuantityAndPrice (trust order)", () => {
	const inferred = inferUnitPriceAndQuantity(["19.00", "57.00"]);
	const unknown = { quantity: null, quantity_source: null };

	test("unknown quantity: both values are taken from the inference and marked inferred", () => {
		expect(combineQuantityAndPrice(unknown, null, null, inferred)).toEqual({
			quantity: 3,
			quantity_source: "inferred",
			unit_price: 19,
			unit_price_source: "inferred",
			conflict: false,
			unresolved: null,
		});
	});

	test("a confirmed price (known quantity) is the higher-trust result", () => {
		const known = { quantity: 3, quantity_source: "dropped" as const };
		const confirmed = recoverUnitPrice("19.00", 3, 57);
		expect(
			combineQuantityAndPrice(known, null, confirmed, inferred),
		).toMatchObject({
			quantity: 3,
			quantity_source: "dropped",
			unit_price: 19,
			unit_price_source: "confirmed",
			conflict: false,
		});
	});

	test("a read quantity wins; a disagreeing inference only raises a conflict", () => {
		const read = { quantity: 2, quantity_source: "printed" as const };
		expect(combineQuantityAndPrice(read, null, null, inferred)).toEqual({
			quantity: 2,
			quantity_source: "printed",
			unit_price: null,
			unit_price_source: null,
			conflict: true,
			unresolved: null,
		});
		const recovered = { quantity: 1, quantity_source: "dropped" as const };
		expect(
			combineQuantityAndPrice(recovered, null, null, inferred),
		).toMatchObject({
			quantity: 1,
			quantity_source: "dropped",
			conflict: true,
		});
	});

	test("a unit price read with its marker stays 'read'; only the quantity is inferred", () => {
		const withMarker = inferUnitPriceAndQuantity(["@19.00", "57.00"]);
		expect(
			combineQuantityAndPrice(unknown, 19, null, withMarker),
		).toMatchObject({
			quantity: 3,
			quantity_source: "inferred",
			unit_price: 19,
			unit_price_source: "read",
		});
	});

	test("ambiguous and unexplained rows change nothing and are flagged", () => {
		expect(
			combineQuantityAndPrice(
				unknown,
				null,
				null,
				inferUnitPriceAndQuantity(["24.00", "48.00"]),
			),
		).toMatchObject({
			quantity: null,
			unit_price: null,
			unresolved: "ambiguous",
		});
		expect(
			combineQuantityAndPrice(
				unknown,
				null,
				null,
				inferUnitPriceAndQuantity(["19.00", "50.00"]),
			),
		).toMatchObject({
			quantity: null,
			unit_price: null,
			unresolved: "unexplained",
		});
	});

	test("a single-amount row with no quantity stays unknown: quantity 1 is not assumed", () => {
		expect(
			combineQuantityAndPrice(
				unknown,
				null,
				null,
				inferUnitPriceAndQuantity(["57.00"]),
			),
		).toEqual({
			quantity: null,
			quantity_source: null,
			unit_price: null,
			unit_price_source: null,
			conflict: false,
			unresolved: null,
		});
	});
});
