import {
	type CatalogStore,
	type OcrImage,
	SCHEMA_VERSION,
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
} from "./metrics.ts";
import { type PipelineDeps, runPipeline } from "./pipeline.ts";

export interface EvalCase {
	label: Label;
	image: OcrImage;
}

export interface ReceiptResult {
	id: string;
	difficulty: Difficulty;
	fields: FieldOutcomes;
	fully_correct: boolean;
	raw_name_cer: { edits: number; length: number };
	catalog: boolean[];
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
	ocr: { provider: string; model: string };
}

export interface Summary {
	receipts: number;
	fully_correct: Ratio;
	field_accuracy: Record<string, Ratio>;
	/** Raw-name character error rate over grapheme clusters; lower is better. */
	raw_name_cer: number | null;
	catalog_match_accuracy: Ratio;
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

export interface RunOptions {
	dataset: string;
	gitCommit?: string | null;
	/** Fresh catalog per receipt, so results do not depend on case order. */
	catalogFor: (label: Label) => CatalogStore;
}

export async function runEval(
	cases: readonly EvalCase[],
	deps: Omit<PipelineDeps, "catalog">,
	options: RunOptions,
): Promise<EvalRun> {
	const receipts: ReceiptResult[] = [];
	for (const { label, image } of cases) {
		const result = await runPipeline(image, {
			...deps,
			catalog: options.catalogFor(label),
		});
		const fields = compareReceipt(label.expected, result.final);
		const attempts = [result.primary, result.fallback].filter(
			(a) => a !== null,
		);
		receipts.push({
			id: label.id,
			difficulty: label.difficulty,
			fields,
			fully_correct: isFullyCorrect(fields),
			raw_name_cer: rawNameCer(label.expected, result.final),
			catalog: catalogOutcomes(label.expected, result.final),
			used_fallback: result.used_fallback,
			needs_review: result.final.needs_review,
			primary_wrong: !isFullyCorrect(
				compareReceipt(label.expected, result.primary.receipt),
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
			ocr: { provider: result.ocr.provider, model: result.ocr.model },
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
		structurer: deps.structurer.name,
		fallback: deps.fallback?.name ?? null,
		summary: {
			all: summarize(receipts),
			easy: summarize(only("easy")),
			hard: summarize(only("hard")),
		},
		receipts,
	};
}
