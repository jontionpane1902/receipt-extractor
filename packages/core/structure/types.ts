import type { OcrImage, OcrResult } from "../ocr/types.ts";
import type { Receipt } from "../schema/receipt.ts";

/**
 * Structuring boundary (types only for now; no LLM implementation yet).
 *
 * A Structurer turns OCR lines into a Receipt. The primary implementation
 * will be a cheap text LLM; the fallback will be Claude Haiku reading the
 * original image. Both report the model and prompt version they used so
 * every eval result can be traced to an exact configuration.
 */
export interface StructureInput {
	ocr: OcrResult;
	/** Only the vision fallback reads the image; text structurers ignore it. */
	image?: OcrImage;
}

export interface StructureUsage {
	model: string;
	prompt_version: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	duration_ms: number;
}

export interface StructureOutput {
	receipt: Receipt;
	usage: StructureUsage;
}

export interface Structurer {
	readonly name: string;
	structure(input: StructureInput): Promise<StructureOutput>;
}
