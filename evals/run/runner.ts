import {
	type CatalogStore,
	type OcrImage,
	SCHEMA_VERSION,
	type Structurer,
} from "@receipt-extractor/core";
import { type Difficulty, LABEL_VERSION, type Label } from "./label.ts";
import {
	type CheckEffectiveness,
	catalogOutcomes,
	checkEffectiveness,
	compareReceipt,
	type Distribution,
	distribution,
	type FieldOutcomes,
	fieldAccuracy,
	isFullyCorrect,
	type Ratio,
	ratio,
	rawNameCer,
	splitUncertain,
	uncertainItems,
} from "./metrics.ts";
import { type PipelineDeps, runPipeline } from "./pipeline.ts";

export interface EvalCase {
	label: Label;
	image: OcrImage;
	/** Overrides the run's structurer for this case (canned synthetic output). */
	structurer?: Structurer;
}

export interface ReceiptResult {
	id: string;
	difficulty: Difficulty;
	/** Outcomes for fields the labeller was sure of. All main numbers use these. */
	fields: FieldOutcomes;
	/** Outcomes for fields flagged uncertain in the label. Reported separately. */
	uncertain_fields: FieldOutcomes;
	fully_correct: boolean;
	raw_name_cer: { edits: number; length: number };
	raw_name_cer_uncertain: { edits: number; length: number };
	catalog: boolean[];
	catalog_uncertain: boolean[];
	used_fallback: boolean;
	needs_review: boolean;
	/** First-pass extraction differed from the label. */
	primary_wrong: boolean;
	/** Checks flagged the first-pass extraction. */
	primary_flagged: boolean;
	failed_checks: { check: string; path?: string; message: string }[];
	cost_usd: number;
	latency_ms: number;
	/** Model + prompt version of each structuring attempt, in order. */
	attempts: { model: string; prompt_version: string }[];
	ocr: {
		provider: string;
		model: string;
		lines: number;
		/** Lines the OCR backend filtered out itself (e.g. low confidence). */
		dropped: number;
		min_confidence: number | null;
		duration_ms: number;
		cache_hit: boolean;
	};
}

export interface Summary {
	receipts: number;
	fully_correct: Ratio;
	field_accuracy: Record<string, Ratio>;
	/** Raw-name character error rate over grapheme clusters; lower is better. */
	raw_name_cer: number | null;
	catalog_match_accuracy: Ratio;
	/**
	 * Fields flagged uncertain by the labeller: excluded from everything
	 * above and scored here on their own.
	 */
	uncertain: {
		fields: number;
		field_accuracy: Record<string, Ratio>;
		raw_name_cer: number | null;
		catalog_match_accuracy: Ratio;
	};
	fallback_rate: number | null;
	needs_review_rate: number | null;
	cost_usd: Distribution;
	latency_ms: Distribution;
	checks: CheckEffectiveness;
}

export interface EvalRun {
	created_at: string;
	dataset: string;
	schema_version: string;
	label_version: string;
	git_commit: string | null;
	ocr_provider: string;
	structurer: string;
	fallback: string | null;
	/** Label ids left out of this run, with the reason. */
	skipped: { id: string; reason: string }[];
	summary: { all: Summary; easy: Summary; hard: Summary };
	receipts: ReceiptResult[];
}

export function summarize(results: readonly ReceiptResult[]): Summary {
	const edits = results.reduce((sum, r) => sum + r.raw_name_cer.edits, 0);
	const length = results.reduce((sum, r) => sum + r.raw_name_cer.length, 0);
	const catalog = results.flatMap((r) => r.catalog);
	const share = (predicate: (r: ReceiptResult) => boolean) =>
		ratio(results.filter(predicate).length, results.length).rate;
	return {
		receipts: results.length,
		fully_correct: ratio(
			results.filter((r) => r.fully_correct).length,
			results.length,
		),
		field_accuracy: fieldAccuracy(results.map((r) => r.fields)),
		uncertain: summarizeUncertain(results),
		raw_name_cer: length === 0 ? null : edits / length,
		catalog_match_accuracy: ratio(
			catalog.filter(Boolean).length,
			catalog.length,
		),
		fallback_rate: share((r) => r.used_fallback),
		needs_review_rate: share((r) => r.needs_review),
		cost_usd: distribution(results.map((r) => r.cost_usd)),
		latency_ms: distribution(results.map((r) => r.latency_ms)),
		checks: checkEffectiveness(
			results.map((r) => ({
				wrong: r.primary_wrong,
				flagged: r.primary_flagged,
			})),
		),
	};
}

function summarizeUncertain(
	results: readonly ReceiptResult[],
): Summary["uncertain"] {
	const edits = results.reduce(
		(sum, r) => sum + r.raw_name_cer_uncertain.edits,
		0,
	);
	const length = results.reduce(
		(sum, r) => sum + r.raw_name_cer_uncertain.length,
		0,
	);
	const catalog = results.flatMap((r) => r.catalog_uncertain);
	const accuracy = fieldAccuracy(results.map((r) => r.uncertain_fields));
	return {
		fields: Object.values(accuracy).reduce((sum, r) => sum + r.total, 0),
		field_accuracy: accuracy,
		raw_name_cer: length === 0 ? null : edits / length,
		catalog_match_accuracy: ratio(
			catalog.filter(Boolean).length,
			catalog.length,
		),
	};
}

export interface RunOptions {
	dataset: string;
	gitCommit?: string | null;
	/** Fresh catalog per receipt, so results do not depend on case order. */
	catalogFor: (label: Label) => CatalogStore;
	skipped?: { id: string; reason: string }[];
}

export async function runEval(
	cases: readonly EvalCase[],
	deps: Omit<PipelineDeps, "catalog" | "structurer"> & {
		structurer?: Structurer;
	},
	options: RunOptions,
): Promise<EvalRun> {
	const receipts: ReceiptResult[] = [];
	for (const { label, image, structurer: override } of cases) {
		const structurer = override ?? deps.structurer;
		if (!structurer) throw new Error(`no structurer for case ${label.id}`);
		const result = await runPipeline(image, {
			...deps,
			structurer,
			catalog: options.catalogFor(label),
		});
		const confidences = result.ocr.lines
			.map((line) => line.confidence)
			.filter((c): c is number => c !== null);
		const { certain: fields, uncertain: uncertainFields } = splitUncertain(
			compareReceipt(label.expected, result.final),
			label.uncertain,
		);
		const unsureName = uncertainItems(label.uncertain, "raw_name");
		const unsureCatalog = uncertainItems(
			label.uncertain,
			"raw_name",
			"normalized_name",
		);
		const catalog = catalogOutcomes(label.expected, result.final);
		const attempts = [result.primary, result.fallback].filter(
			(a) => a !== null,
		);
		receipts.push({
			id: label.id,
			difficulty: label.difficulty,
			fields,
			uncertain_fields: uncertainFields,
			fully_correct: isFullyCorrect(fields),
			raw_name_cer: rawNameCer(
				label.expected,
				result.final,
				(i) => !unsureName.has(i),
			),
			raw_name_cer_uncertain: rawNameCer(label.expected, result.final, (i) =>
				unsureName.has(i),
			),
			catalog: catalog.filter((_, i) => !unsureCatalog.has(i)),
			catalog_uncertain: catalog.filter((_, i) => unsureCatalog.has(i)),
			used_fallback: result.used_fallback,
			needs_review: result.final.needs_review,
			primary_wrong: !isFullyCorrect(
				splitUncertain(
					compareReceipt(label.expected, result.primary.receipt),
					label.uncertain,
				).certain,
			),
			primary_flagged: !result.primary.validation.ok,
			failed_checks: result.primary.validation.failures.map((f) => ({
				check: f.check,
				...(f.path === undefined ? {} : { path: f.path }),
				message: f.message,
			})),
			cost_usd: result.cost_usd,
			latency_ms: result.latency_ms,
			attempts: attempts.map((a) => ({
				model: a.usage.model,
				prompt_version: a.usage.prompt_version,
			})),
			ocr: {
				provider: result.ocr.provider,
				model: result.ocr.model,
				lines: result.ocr.lines.length,
				dropped: result.ocr.dropped?.length ?? 0,
				min_confidence:
					confidences.length === 0 ? null : Math.min(...confidences),
				duration_ms: result.ocr.duration_ms,
				cache_hit: result.ocr.cache_hit ?? false,
			},
		});
	}
	const only = (difficulty: Difficulty) =>
		receipts.filter((r) => r.difficulty === difficulty);
	return {
		created_at: deps.now.toISOString(),
		dataset: options.dataset,
		schema_version: SCHEMA_VERSION,
		label_version: LABEL_VERSION,
		git_commit: options.gitCommit ?? null,
		ocr_provider: deps.ocr.name,
		structurer:
			deps.structurer?.name ?? cases[0]?.structurer?.name ?? "unknown",
		fallback: deps.fallback?.name ?? null,
		skipped: options.skipped ?? [],
		summary: {
			all: summarize(receipts),
			easy: summarize(only("easy")),
			hard: summarize(only("hard")),
		},
		receipts,
	};
}
