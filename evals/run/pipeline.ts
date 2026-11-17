import {
	type CatalogStore,
	fieldConfidence,
	normalizeItems,
	type OcrImage,
	type OcrProvider,
	type OcrResult,
	type Receipt,
	type Structurer,
	type StructureUsage,
	type ValidationReport,
	validateReceipt,
	withResolvedDatetime,
} from "@receipt-extractor/core";

/**
 * Minimal orchestration of the agreed pipeline, so evals can run before
 * the real structurers exist:
 *
 *   OCR → structurer → code post-processing → checks
 *       → (checks fail) fallback structurer with the image → checks
 *       → (still failing) needs_review
 *
 * This will move into packages/core once the LLM structurers are built;
 * the eval runner should then call that instead.
 */
export interface PipelineDeps {
	ocr: OcrProvider;
	structurer: Structurer;
	/** Vision fallback; omit to measure the first pass alone. */
	fallback?: Structurer;
	catalog: CatalogStore;
	now: Date;
}

export interface Attempt {
	receipt: Receipt;
	validation: ValidationReport;
	usage: StructureUsage;
}

export interface PipelineResult {
	ocr: OcrResult;
	primary: Attempt;
	fallback: Attempt | null;
	/** The receipt the pipeline would return. */
	final: Receipt;
	used_fallback: boolean;
	cost_usd: number;
	latency_ms: number;
}

async function attempt(
	structurer: Structurer,
	ocr: OcrResult,
	image: OcrImage,
	deps: PipelineDeps,
): Promise<Attempt> {
	const { receipt: raw, usage } = await structurer.structure({ ocr, image });
	let receipt = withResolvedDatetime(raw, deps.now);
	receipt = await normalizeItems(deps.catalog, receipt);
	receipt = { ...receipt, field_confidence: fieldConfidence(receipt, ocr) };
	const validation = validateReceipt(receipt, ocr, { now: deps.now });
	return { receipt, validation, usage };
}

export async function runPipeline(
	image: OcrImage,
	deps: PipelineDeps,
): Promise<PipelineResult> {
	const started = performance.now();
	const ocr = await deps.ocr.recognize(image);
	const ocrWall = performance.now() - started;
	const primary = await attempt(deps.structurer, ocr, image, deps);

	let fallback: Attempt | null = null;
	if (!primary.validation.ok && deps.fallback) {
		fallback = await attempt(deps.fallback, ocr, image, deps);
	}
	const chosen = fallback ?? primary;

	return {
		ocr,
		primary,
		fallback,
		final: { ...chosen.receipt, needs_review: !chosen.validation.ok },
		used_fallback: fallback !== null,
		cost_usd: primary.usage.cost_usd + (fallback?.usage.cost_usd ?? 0),
		// Count the OCR time of the original read even when the result came
		// from the cache, so cached runs do not report flattering latency.
		latency_ms: performance.now() - started - ocrWall + ocr.duration_ms,
	};
}
