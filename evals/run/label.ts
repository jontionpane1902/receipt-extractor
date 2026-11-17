import { ReceiptSchema } from "@receipt-extractor/core";
import { z } from "zod";

/** Bump when the label file format changes. Recorded in every result. */
export const LABEL_VERSION = "0.1.0-provisional";

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

export const LabelSchema = z.object({
	label_version: z.literal(LABEL_VERSION),
	/** Stable id, also the file name: <id>.json. */
	id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	difficulty: DifficultySchema,
	/** Why it is easy/hard: crumpled, faded, long, promo lines, ... */
	tags: z.array(z.string()).default([]),
	/** Redacted image, relative to evals/dataset/. Null for synthetic samples. */
	image: z.string().nullable(),
	notes: z.string().optional(),
	expected: ExpectedReceiptSchema,
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
