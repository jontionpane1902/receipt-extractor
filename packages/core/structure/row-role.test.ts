import { describe, expect, test } from "bun:test";
import { rowRole } from "./row-role.ts";
import { inferUnitPriceAndQuantity } from "./unit-price.ts";

describe("rowRole", () => {
	test("item rows", () => {
		expect(rowRole("ขนมปังสังขยา", ["15.00"])).toBe("item");
		expect(rowRole("ชาเขียวเย็น", ["@12.00", "36.00"])).toBe("item");
		expect(rowRole("MILK TEA 500ML", ["25.00"])).toBe("item");
	});

	test("totals rows, in either language and with a piece count", () => {
		expect(rowRole("Total", ["(3)", "42.00"])).toBe("totals");
		expect(rowRole("ยอดสุทธิ", ["3 ชิ้น", "45.00"])).toBe("totals");
		expect(rowRole("ยอดรวม", ["52.00"])).toBe("totals");
		// the count alone is enough when OCR has destroyed the label
		expect(rowRole("xxxxx", ["6 ชิ้น", "120.00"])).toBe("totals");
	});

	test("payment rows", () => {
		expect(rowRole("Cash/Change", ["100.00", "50.00"])).toBe("payment");
		expect(rowRole("เงินสด", ["500.00"])).toBe("payment");
		expect(rowRole("เงินทอน", ["20.50"])).toBe("payment");
		expect(rowRole("เงินสด/เงินทอน", ["100.00", "30.00"])).toBe("payment");
	});

	test("discount rows: by label or by a negative amount", () => {
		expect(rowRole("ส่วนลดสมาชิก", ["3.00"])).toBe("discount");
		expect(rowRole("ขนมปังสังขยา", ["-15.00"])).toBe("discount");
	});

	test("labels damaged by OCR are still recognised", () => {
		expect(rowRole("Cash/Chanqe", ["100.00", "50.00"])).toBe("payment");
		expect(rowRole("เงินสค/เงินทอบ", ["100.00", "30.00"])).toBe("payment");
		expect(rowRole("ยอคสุทธี", ["45.00"])).toBe("totals");
		expect(rowRole("Tota1", ["42.00"])).toBe("totals");
	});
});

describe("unit-price inference is kept off non-item rows", () => {
	const fire = (name: string, amounts: string[]) =>
		inferUnitPriceAndQuantity(amounts, { role: rowRole(name, amounts) }).status;

	test("fires on an item row", () => {
		expect(fire("ชาเขียวเย็น", ["19.00", "57.00"])).toBe("inferred");
	});

	test("cash and change where one divides the other", () => {
		// tendered 50.00, change... printed as two amounts on one payment row
		expect(fire("Cash/Change", ["50.00", "100.00"])).toBe("not_applicable");
		expect(fire("เงินสด/เงินทอน", ["20.00", "40.00"])).toBe("not_applicable");
	});

	test("subtotal and total on one row, and a discount", () => {
		expect(fire("ยอดรวม", ["26.00", "52.00"])).toBe("not_applicable");
		expect(fire("Total", ["21.00", "42.00"])).toBe("not_applicable");
		expect(fire("ส่วนลด", ["5.00", "10.00"])).toBe("not_applicable");
		expect(fire("ขนมปังสังขยา", ["5.00", "-10.00"])).toBe("not_applicable");
	});
});
