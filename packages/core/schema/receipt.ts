import { z } from "zod";

/**
 * PROVISIONAL receipt schema.
 *
 * The field list follows the agreed design, but the real 7-Eleven Thailand
 * layout has not been confirmed against physical receipts yet. Expect field
 * names, optionality and the meaning of `item_count` to change. Bump
 * SCHEMA_VERSION on every change: eval results record it.
 *
 * Money is stored as decimal baht (e.g. 25.5). Compare amounts through
 * `toSatang` — never with `===` on the raw floats.
 */
export const SCHEMA_VERSION = "0.1.0-provisional";

export const StoreChainSchema = z.enum(["7-eleven", "unknown"]);
export type StoreChain = z.infer<typeof StoreChainSchema>;

const money = z.number().finite();

export const ReceiptItemSchema = z.object({
	/** Name exactly as read from the receipt. Never overwritten. */
	raw_name: z.string().min(1),
	/** Catalog name, set only by the catalog matcher. Null when no safe match. */
	normalized_name: z.string().nullable(),
	qty: z.number().positive(),
	/** Null when the receipt prints only the line amount. */
	unit_price: money.nullable(),
	amount: money,
});
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;

export const DiscountSchema = z.object({
	raw_label: z.string(),
	/** Positive number of baht taken off the total. */
	amount: money.nonnegative(),
});
export type Discount = z.infer<typeof DiscountSchema>;

export const PaymentMethodSchema = z.enum([
	"cash",
	"card",
	"qr",
	"wallet",
	"other",
	"unknown",
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PaymentSchema = z.object({
	method: PaymentMethodSchema,
	/** Amount handed over (cash) or charged. Null when not printed. */
	tendered: money.nullable(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const ReceiptSchema = z.object({
	schema_version: z.literal(SCHEMA_VERSION),
	store_chain: StoreChainSchema,
	branch: z.object({
		code: z.string().nullable(),
		name: z.string().nullable(),
	}),
	/** 13-digit Thai tax ID of the seller, digits only. */
	tax_id: z.string().nullable(),
	receipt_number: z.string().nullable(),
	/** Date/time text exactly as printed (may be Buddhist era). */
	datetime_raw: z.string().nullable(),
	/**
	 * Gregorian ISO 8601 with +07:00 offset. Filled by code from
	 * `datetime_raw` (see validate/date.ts), not by the LLM.
	 */
	datetime: z.string().nullable(),
	items: z.array(ReceiptItemSchema),
	discounts: z.array(DiscountSchema),
	total: money,
	vat: money.nullable(),
	payment: PaymentSchema,
	change: money.nullable(),
	/** Item count printed on the receipt (provisional: total pieces). */
	item_count: z.number().int().nonnegative().nullable(),
	/**
	 * Confidence 0..1 per field path, e.g. "total", "items[0].raw_name".
	 * Derived from OCR line confidence; absent means unknown.
	 */
	field_confidence: z.record(z.string(), z.number().min(0).max(1)),
	needs_review: z.boolean(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/** Baht → integer satang, the only safe way to compare money values. */
export function toSatang(baht: number): number {
	return Math.round(baht * 100);
}
