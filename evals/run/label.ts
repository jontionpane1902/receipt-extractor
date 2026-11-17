import { ReceiptSchema } from "@receipt-extractor/core";
import { z } from "zod";

/** Bump when the label file format changes. Recorded in every result. */
export const LABEL_VERSION = "0.2.0-provisional";

/**
 * Ground truth for one receipt: the receipt schema minus fields that are
 * produced by the pipeline rather than read from the paper.
 */
export const ExpectedReceiptSchema = ReceiptSchema.omit({
	schema_version: true,
	datetime_raw: true,
	field_confidence: true,
	needs_review: true,
});
export type ExpectedReceipt = z.infer<typeof ExpectedReceiptSchema>;

export const DifficultySchema = z.enum(["easy", "hard"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

/** Paths accepted in a label's `uncertain` list. */
export const UNCERTAIN_PATH =
	/^(?:store_chain|branch\.code|branch\.name|tax_id|receipt_number|datetime|total|vat|payment\.method|payment\.tendered|change|item_count|discounts|items\[\d+\]\.(?:raw_name|normalized_name|qty|unit_price|amount))$/;

export const LabelSchema = z
	.object({
		label_version: z.literal(LABEL_VERSION),
		/** Stable id, also the file name: <id>.json. */
		id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
		difficulty: DifficultySchema,
		/** Why it is easy/hard: crumpled, faded, long, promo lines, ... */
		tags: z.array(z.string()).default([]),
		/**
		 * Image, relative to evals/dataset/: a redacted photo for real labels, a
		 * generated picture for synthetic ones. Null when there is no image (the
		 * sample then only runs on the fake OCR provider).
		 */
		image: z.string().nullable(),
		notes: z.string().optional(),
		/**
		 * Field paths the labeller could not read with confidence, e.g.
		 * "branch.name" or "items[2].raw_name". The value in `expected` is the
		 * labeller's best reading. Uncertain fields are scored and reported
		 * separately and never count toward the main accuracy numbers: a label
		 * that may itself be wrong must not make the pipeline look worse (or
		 * better) than it is.
		 */
		uncertain: z.array(z.string().regex(UNCERTAIN_PATH)).default([]),
		expected: ExpectedReceiptSchema,
	})
	.superRefine((label, context) => {
		for (const path of label.uncertain) {
			const index = /^items\[(\d+)\]/.exec(path)?.[1];
			if (index !== undefined && Number(index) >= label.expected.items.length) {
				context.addIssue({
					code: "custom",
					path: ["uncertain"],
					message: `${path} points past the last item`,
				});
			}
		}
	});
export type Label = z.infer<typeof LabelSchema>;

/**
 * Synthetic sample: an invented label plus canned OCR lines and a canned
 * structurer output. Exercises the runner and metrics end to end without
 * real receipts, models or network. Results on these are NOT accuracy
 * numbers and must never be reported as such.
 */
export const SyntheticSampleSchema = z.object({
	label: LabelSchema,
	ocr_lines: z.array(
		z.object({
			text: z.string(),
			confidence: z.number().nullable().optional(),
		}),
	),
	/** What the fake structurer returns for these OCR lines. */
	extraction: ReceiptSchema,
});
export type SyntheticSample = z.infer<typeof SyntheticSampleSchema>;
