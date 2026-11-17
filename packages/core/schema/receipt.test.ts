import { describe, expect, test } from "bun:test";
import { sampleReceipt } from "./fixtures.ts";
import { ReceiptSchema, SCHEMA_VERSION, toSatang } from "./receipt.ts";

describe("ReceiptSchema", () => {
	test("accepts the sample receipt", () => {
		expect(ReceiptSchema.safeParse(sampleReceipt()).success).toBe(true);
	});

	test("is explicitly marked provisional", () => {
		expect(SCHEMA_VERSION).toContain("provisional");
	});

	test("keeps raw_name and normalized_name as separate fields", () => {
		const receipt = sampleReceipt();
		const first = receipt.items[0];
		if (!first) throw new Error("fixture has no items");
		first.normalized_name = "น้ำดื่มตราทดสอบ 600 มล.";
		const parsed = ReceiptSchema.parse(receipt);
		expect(parsed.items[0]?.raw_name).toBe("น้ำดื่มตราทดสอบ 600มล");
		expect(parsed.items[0]?.normalized_name).toBe("น้ำดื่มตราทดสอบ 600 มล.");
	});

	test("rejects an empty raw_name, zero qty and out-of-range confidence", () => {
		const base = sampleReceipt();
		const item = base.items[0];
		if (!item) throw new Error("fixture has no items");
		expect(
			ReceiptSchema.safeParse({
				...base,
				items: [{ ...item, raw_name: "" }],
			}).success,
		).toBe(false);
		expect(
			ReceiptSchema.safeParse({ ...base, items: [{ ...item, qty: 0 }] })
				.success,
		).toBe(false);
		expect(
			ReceiptSchema.safeParse({ ...base, field_confidence: { total: 1.2 } })
				.success,
		).toBe(false);
	});

	test("rejects a different schema version", () => {
		expect(
			ReceiptSchema.safeParse({ ...sampleReceipt(), schema_version: "9.9.9" })
				.success,
		).toBe(false);
	});
});

describe("toSatang", () => {
	test("avoids float drift", () => {
		expect(toSatang(0.1 + 0.2)).toBe(30);
		expect(toSatang(4.19)).toBe(419);
		expect(toSatang(64)).toBe(6400);
	});
});
