import { type Receipt, SCHEMA_VERSION } from "./receipt.ts";

/**
 * A made-up, internally consistent receipt for tests. Not a real receipt:
 * the store name, branch, products, numbers and layout are all invented.
 *
 * - The printed store name ("DemoMart") is fictional. `store_chain` is
 *   "7-eleven" only because that is the one chain value the schema has;
 *   it says which layout family the pipeline targets, not who issued this
 *   sample.
 * - The tax ID is fictional: sequential digits behind a leading 9, with a
 *   correct check digit so that validation tests stay meaningful. It was
 *   not taken from any company; any resemblance to a real ID is
 *   unintended. (Real receipts carry the operator's public tax ID, which is
 *   deliberately not reproduced here.)
 * - Product names are invented. They mix Thai and Latin text and include
 *   characters from the catalog's look-alike groups.
 */
export function sampleReceipt(overrides: Partial<Receipt> = {}): Receipt {
	return {
		schema_version: SCHEMA_VERSION,
		store_chain: "7-eleven",
		branch: { code: "00000", name: "สาขาทดสอบ" },
		tax_id: "9012345678902",
		receipt_number: "R#0000012345",
		datetime_raw: "17/11/69 14:05",
		datetime: "2026-11-17T14:05:00+07:00",
		items: [
			{
				raw_name: "น้ำดื่มตราทดสอบ 600มล",
				normalized_name: null,
				qty: 2,
				unit_price: 7,
				amount: 14,
			},
			{
				raw_name: "ขนมข้าวพองสมมติ 48ก",
				normalized_name: null,
				qty: 1,
				unit_price: 20,
				amount: 20,
			},
			{
				raw_name: "ชาเย็นหอม DEMO TEA",
				normalized_name: null,
				qty: 1,
				unit_price: 35,
				amount: 35,
			},
		],
		discounts: [{ raw_label: "ส่วนลด", amount: 5 }],
		total: 64,
		vat: 4.19,
		payment: { method: "cash", tendered: 100 },
		change: 36,
		item_count: 4,
		field_confidence: {},
		needs_review: false,
		...overrides,
	};
}

/** OCR text that the sample receipt is grounded in (one string per line). */
export const SAMPLE_OCR_TEXT: readonly string[] = [
	"DemoMart สาขาทดสอบ (00000)",
	"TAX ID 9012345678902",
	"R#0000012345 17/11/69 14:05",
	"น้ำดื่มตราทดสอบ 600มล 2 @7.00 14.00",
	"ขนมข้าวพองสมมติ 48ก 20.00",
	"ชาเย็นหอม DEMO TEA 35.00",
	"ส่วนลด -5.00",
	"ยอดสุทธิ 4 ชิ้น 64.00",
	"VAT 7% 4.19",
	"เงินสด 100.00",
	"เงินทอน 36.00",
];
