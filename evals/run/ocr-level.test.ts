import { describe, expect, test } from "bun:test";
import {
	type OcrDroppedLine,
	type OcrLine,
	type OcrResult,
	type Quad,
	thaiIdCheckDigit,
} from "@receipt-extractor/core";
import { LABEL_VERSION, LabelSchema } from "./label.ts";
import { evaluateOcrAgainstLabel, formatOcrLevelReport } from "./ocr-level.ts";

// Everything here is invented: names, numbers and layout.
const NOW = new Date("2026-11-18T09:00:00+07:00");

const isValid = (id: string) =>
	thaiIdCheckDigit(id.slice(0, 12)) === Number(id[12]);
/** An invented tax ID whose check digit is valid, and stays unique with a "1" glued in front. */
const TAX_ID = ["310050012345", "310050012346", "310050012347"]
	.map((first12) => `${first12}${thaiIdCheckDigit(first12)}`)
	.find((id) => !isValid(`1${id}`.slice(0, 13))) as string;

const box = (x: number, row: number): Quad => [
	{ x, y: row * 40 },
	{ x: x + 30, y: row * 40 },
	{ x: x + 30, y: row * 40 + 30 },
	{ x, y: row * 40 + 30 },
];
const line = (
	text: string,
	row: number,
	x: number,
	confidence = 0.9,
): OcrLine => ({
	text,
	row,
	box: box(x, row),
	confidence,
});
const droppedDigit = (text: string, row: number): OcrDroppedLine => ({
	...line(text, row, 10, 0.7),
	reason: "too_short",
});

/** What a noisy OCR pass might return for the invented receipt below. */
const ocr: OcrResult = {
	provider: "test",
	model: "test-model",
	duration_ms: 123,
	lines: [
		line("ร้านทดสอบ (00123)", 0, 60),
		line(`TAE1${TAX_ID} (VAT)`, 1, 60), // "#" misread as a digit glued to the ID
		line("ชนมตาวห้าทอง", 2, 60), // look-alike misreads of ขนมดาวฟ้าทอง
		line("15,00", 2, 400), // decimal comma
		line("ชาเขียวเย็น", 3, 60),
		line("@12.00", 3, 300),
		line("36.00", 3, 400),
		line("บะหมี่กงสำเร็จรป", 4, 60), // real misreads
		line("20. 50", 4, 400), // stray space
		line("Total", 5, 10),
		line("(5)", 5, 200),
		line("71,50", 5, 400),
		line("Cash/Change", 6, 10),
		line("100.00", 6, 300),
		line("28.50", 6, 400),
		line("R0000012345 14/08/69 09:30", 7, 10), // "#" lost
	],
	dropped: [droppedDigit("1", 2), droppedDigit("3", 3), droppedDigit("]", 4)],
};

const label = LabelSchema.parse({
	label_version: LABEL_VERSION,
	id: "invented-0001",
	difficulty: "hard",
	image: null,
	uncertain: ["branch.name", "items[2].raw_name"],
	expected: {
		store_chain: "7-eleven",
		branch: { code: "00123", name: "ร้านทดสอบ" },
		tax_id: TAX_ID,
		receipt_number: "R#0000012345",
		datetime: "2026-08-14T09:30:00+07:00",
		items: [
			{
				raw_name: "ขนมดาวฟ้าทอง",
				normalized_name: null,
				qty: 1,
				unit_price: null,
				amount: 15,
			},
			{
				raw_name: "ชาเขียวเย็น",
				normalized_name: null,
				qty: 3,
				unit_price: 12,
				amount: 36,
			},
			{
				raw_name: "บะหมี่กึ่งสำเร็จรูป",
				normalized_name: null,
				qty: 1,
				unit_price: null,
				amount: 20.5,
			},
		],
		discounts: [],
		total: 71.5,
		vat: null,
		payment: { method: "cash", tendered: 100 },
		change: 28.5,
		item_count: 5,
	},
});

describe("evaluateOcrAgainstLabel (invented receipt)", () => {
	test("header and totals: reports what can be read from the OCR output", async () => {
		const report = await evaluateOcrAgainstLabel(label, ocr, NOW);
		const scalar = (path: string) =>
			report.scalars.find((s) => s.path === path);

		expect(scalar("branch.code")?.found).toBe(true);
		expect(scalar("branch.name")).toMatchObject({
			found: true,
			uncertain: true,
		});
		expect(scalar("tax_id")?.found).toBe(true);
		expect(scalar("tax_id")?.detail).toContain("selected");
		expect(scalar("receipt_number")).toMatchObject({ found: false });
		expect(scalar("receipt_number")?.detail).toContain("digits found");
		expect(scalar("datetime")?.found).toBe(true);
		expect(scalar("datetime")?.detail).toContain("BE");
		expect(scalar("total")?.found).toBe(true); // decimal comma
		expect(scalar("change")?.found).toBe(true);
		expect(scalar("payment.tendered")?.found).toBe(true);
		expect(scalar("item_count")?.found).toBe(true);
		expect(scalar("vat")?.found).toBeNull();
		expect(scalar("payment.method")?.found).toBeNull(); // not measurable on OCR text
	});

	test("items: aligned by name, amounts parsed, quantities recovered and deduced", async () => {
		const { items, quantity, cer } = await evaluateOcrAgainstLabel(
			label,
			ocr,
			NOW,
		);

		expect(items.map((i) => i.row)).toEqual([2, 3, 4]);
		expect(items.map((i) => i.name_exact)).toEqual([false, true, false]);
		expect(items.map((i) => i.amount_ok)).toEqual([true, true, true]);
		expect(items[0]?.amount_notes).toEqual(["decimal_comma"]);
		expect(items[2]?.amount_notes).toEqual(["space_after_point"]);
		expect(items[1]?.ocr_unit_price).toBe(12); // @price is not the amount
		expect(items[1]?.ocr_amount).toBe(36);

		expect(items.map((i) => [i.quantity.qty, i.quantity.source])).toEqual([
			[1, "dropped"],
			[3, "dropped"],
			[1, "deduced"],
		]);
		expect(
			items.every((i) => i.qty_ok && i.quantity.trust === "confirmed"),
		).toBe(true);
		expect(quantity.status).toBe("deduced");

		// 3 of 11 clusters wrong in the certain names (item 1 is exact);
		// the uncertain name is counted apart.
		expect(items[0]?.cer).toEqual({ edits: 3, length: 11 });
		expect(cer.certain).toBeCloseTo(3 / (11 + (items[1]?.cer.length ?? 0)), 10);
		expect(cer.uncertain).toBeGreaterThan(0);
	});

	test("validation runs on the receipt assembled from OCR readings", async () => {
		const { checks, validation_ok } = await evaluateOcrAgainstLabel(
			label,
			ocr,
			NOW,
		);
		const status = (check: string) =>
			checks.filter((c) => c.check === check).map((c) => c.status);

		expect(status("total_sum")).toEqual(["pass"]);
		expect(status("change")).toEqual(["pass"]);
		expect(status("item_count")).toEqual(["pass"]);
		expect(status("line_amount")).toEqual(["skip", "pass", "skip"]);
		expect(status("vat")).toEqual(["skip"]);
		expect(status("date_parse")).toEqual(["pass"]);
		expect(status("tax_id_format")).toEqual(["pass"]);
		expect(status("grounding").every((s) => s === "pass")).toBe(true);
		expect(validation_ok).toBe(true);
	});

	test("catalog: look-alike noise reaches its true name only with the table", async () => {
		const { catalog } = await evaluateOcrAgainstLabel(label, ocr, NOW);
		expect(catalog[0]?.before).toMatchObject({ correct: false, kind: "none" });
		expect(catalog[0]?.after).toMatchObject({ correct: true, kind: "fuzzy" });
		expect(catalog[0]?.after.similarity).toBeGreaterThan(
			catalog[0]?.before.similarity ?? 1,
		);
		expect(catalog[1]?.before).toMatchObject({ correct: true, kind: "exact" });
		expect(catalog[1]?.price_used).toBe(12);
		// Real character errors are not rescued by the look-alike table.
		expect(catalog[2]?.before.similarity).toBe(
			catalog[2]?.after.similarity ?? -1,
		);
		expect(catalog[2]?.uncertain_name).toBe(true);
	});

	test("an item with no similar OCR row is reported, not invented", async () => {
		const missing = { ...ocr, lines: ocr.lines.filter((l) => l.row !== 3) };
		const { items, quantity } = await evaluateOcrAgainstLabel(
			label,
			missing,
			NOW,
		);
		expect(items[1]).toMatchObject({
			row: null,
			ocr_name: null,
			amount_ok: false,
		});
		expect(items[1]?.cer.edits).toBe(items[1]?.cer.length ?? -1);
		expect(["unresolved", "mismatch", "deduced"]).toContain(quantity.status);
	});

	test("the report states what was measured; --hide-text prints no receipt text", async () => {
		const report = await evaluateOcrAgainstLabel(label, ocr, NOW);
		const full = formatOcrLevelReport(report);
		expect(full).toContain("No structuring step exists yet");
		expect(full).toContain("ขนมดาวฟ้าทอง");
		expect(full).toContain("matched: 1/3 before, 2/3 after");

		const hidden = formatOcrLevelReport(report, { showText: false });
		expect(hidden).not.toMatch(/[฀-๿]/);
		expect(hidden).toContain("matched: 1/3 before, 2/3 after");
	});
});
