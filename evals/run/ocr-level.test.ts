import { describe, expect, test } from "bun:test";
import {
	type OcrDroppedLine,
	type OcrLine,
	type OcrResult,
	type Quad,
	thaiIdCheckDigit,
} from "@receipt-extractor/core";
import { LABEL_VERSION, LabelSchema } from "./label.ts";
import {
	evaluateOcrAgainstLabel,
	formatOcrLevelReport,
	standaloneIntegers,
} from "./ocr-level.ts";

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

		// Default: the count is a soft signal. Recovered quantities stay low
		// trust and the missing one is not invented.
		expect(
			items.map((i) => [i.quantity.qty, i.quantity.source, i.quantity.trust]),
		).toEqual([
			[1, "dropped", "low"],
			[3, "dropped", "low"],
			[null, null, null],
		]);
		expect(items.map((i) => i.qty_ok)).toEqual([true, true, false]);
		expect(quantity.status).toBe("unverified");
		// Shown alongside: what assuming "count = pieces" would give.
		expect(
			items.map((i) => [i.quantity_if_pieces.qty, i.quantity_if_pieces.source]),
		).toEqual([
			[1, "dropped"],
			[3, "dropped"],
			[1, "deduced"],
		]);
		expect(items.every((i) => i.qty_ok_if_pieces)).toBe(true);

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
		expect(catalog[1]?.price_source).toBe("ocr");
		// Quantity not recovered for item 2: its amount is used as the price, flagged.
		expect(catalog[2]?.price_source).toBe("assumed_qty_1");
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
		expect(quantity.status).toBe("unverified");
	});

	test("discounts, a dropped item row and a dropped item count are reported", async () => {
		const withDiscount = LabelSchema.parse({
			...label,
			expected: {
				...label.expected,
				discounts: [{ raw_label: "ส่วนลดสมาชิก", amount: 4.5 }],
				total: 67,
				change: 33,
			},
		});
		const noisy: OcrResult = {
			...ocr,
			lines: [
				...ocr.lines.filter((l) => l.row !== 3 && l.text !== "(5)"),
				line("ส่วนลดสมาชิก", 8, 60),
				line("4,50", 8, 400),
				line("67.00", 9, 400),
				line("33.00", 9, 300),
			],
			dropped: [
				...(ocr.dropped ?? []),
				{ ...line("ชาเขียวเยน", 3, 60, 0.75), reason: "low_confidence" },
				{ ...line("5 ชิ้น", 5, 200, 0.7), reason: "low_confidence" },
			],
		};
		const report = await evaluateOcrAgainstLabel(withDiscount, noisy, NOW);
		const scalar = (path: string) =>
			report.scalars.find((s) => s.path === path);

		expect(scalar("discounts")).toMatchObject({ found: true });
		expect(scalar("item_count")?.found).toBe(false);
		expect(scalar("item_count")?.detail).toContain("dropped");
		expect(report.items[1]).toMatchObject({ row: null, ocr_name: null });
		expect(report.items[1]?.dropped_match?.similarity).toBeGreaterThan(0.8);
		// The dropped count is still not allowed to invent quantities.
		expect(report.quantity.status).toBe("unverified");
		expect(formatOcrLevelReport(report)).toContain(
			"row dropped by the OCR filter",
		);
	});

	test("an item count is only read from a number that stands on its own", async () => {
		expect([...standaloneIntegers("Total (5) 71,50")]).toEqual([5]);
		expect([...standaloneIntegers("ยอดสุทธิ 5 ชิ้น 71.50")]).toEqual([5]);
		// glued to a letter, part of a name, inside a phone number, a time or a date
		expect(
			standaloneIntegers("ผ5 ขนม21 0-2000-1234 09:30 14/08/69 R0000012345")
				.size,
		).toBe(0);

		// The real "(5)" is lost and a stray 5 is glued to a misread letter.
		const junk: OcrResult = {
			...ocr,
			lines: [
				...ocr.lines.filter((l) => l.text !== "(5)"),
				line("** ผ5", 9, 10),
			],
		};
		const report = await evaluateOcrAgainstLabel(label, junk, NOW);
		expect(report.scalars.find((s) => s.path === "item_count")?.found).toBe(
			false,
		);
		expect(report.quantity_if_pieces.status).toBe("unverified");
	});

	test("a unit price without its marker is accepted only when qty × it = amount", async () => {
		// Row 3 of the invented receipt: "@12.00" read as "812.00".
		const misread: OcrResult = {
			...ocr,
			lines: ocr.lines.map((l) =>
				l.text === "@12.00" ? { ...l, text: "812.00" } : l,
			),
		};
		const ok = await evaluateOcrAgainstLabel(label, misread, NOW);
		expect(ok.items[1]).toMatchObject({
			ocr_unit_price: 12,
			unit_price_repair: "leading_character_removed",
		});
		expect(ok.checks.filter((c) => c.check === "line_amount")[1]?.status).toBe(
			"pass",
		);

		// Without the recovered quantity the strict path has no proof, so it
		// gives no unit price (the inferred path is measured separately).
		const noQty = await evaluateOcrAgainstLabel(
			label,
			{ ...misread, dropped: [] },
			NOW,
			{ inferUnitPrice: false },
		);
		expect(noQty.items[1]).toMatchObject({
			ocr_unit_price: null,
			unit_price_repair: null,
		});
	});

	test("with no quantity at all, unit price and quantity are inferred and marked so", async () => {
		const noDigits: OcrResult = {
			...ocr,
			lines: ocr.lines.map((l) =>
				l.text === "@12.00" ? { ...l, text: "812.00" } : l,
			),
			dropped: [],
		};
		const on = await evaluateOcrAgainstLabel(label, noDigits, NOW);
		expect(on.items[1]).toMatchObject({
			ocr_unit_price: 12,
			unit_price_source: "inferred",
			unit_price_repair: "leading_character_removed",
			qty_ok: true,
			quantity_conflict: false,
		});
		expect(on.items[1]?.quantity).toMatchObject({
			qty: 3,
			source: "inferred",
			trust: "low",
		});
		expect(on.catalog[1]?.price_source).toBe("inferred");
		// single-amount rows are not assumed to be quantity 1
		expect(on.items[0]?.quantity.qty).toBeNull();

		const off = await evaluateOcrAgainstLabel(label, noDigits, NOW, {
			inferUnitPrice: false,
		});
		expect(off.items[1]).toMatchObject({
			ocr_unit_price: null,
			unit_price_source: null,
		});
		expect(off.items[1]?.quantity.qty).toBeNull();
	});

	test("an inference that disagrees with a recovered quantity is a conflict, not an overwrite", async () => {
		// The dropped digit says 2; the amounts say 3 × 12.00 = 36.00.
		const conflicting: OcrResult = {
			...ocr,
			lines: ocr.lines.map((l) =>
				l.text === "@12.00" ? { ...l, text: "อ12.00" } : l,
			),
			dropped: [droppedDigit("1", 2), droppedDigit("2", 3)],
		};
		const report = await evaluateOcrAgainstLabel(label, conflicting, NOW);
		expect(report.items[1]?.quantity).toMatchObject({
			qty: 2,
			source: "dropped",
		});
		expect(report.items[1]).toMatchObject({
			quantity_conflict: true,
			ocr_unit_price: null,
		});
	});

	test("layout fit: arithmetic checks run on the label's own values", async () => {
		const { label_checks } = await evaluateOcrAgainstLabel(label, ocr, NOW);
		const of = (check: string) => label_checks.filter((c) => c.check === check);
		expect(of("total_sum")[0]?.status).toBe("pass");
		expect(of("change")[0]?.status).toBe("pass");
		// default (soft), strict pieces, strict lines: 5 pieces on 3 lines, printed 5.
		expect(of("item_count").map((c) => c.status)).toEqual([
			"pass",
			"pass",
			"fail",
		]);
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
