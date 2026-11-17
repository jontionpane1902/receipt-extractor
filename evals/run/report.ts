import type { EvalRun, Summary } from "./runner.ts";

const pct = (rate: number | null) =>
	rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
const num = (value: number | null, digits: number) =>
	value === null ? "n/a" : value.toFixed(digits);

function summaryLines(name: string, s: Summary): string[] {
	if (s.receipts === 0) return [`## ${name}: no receipts`, ""];
	return [
		`## ${name} (${s.receipts} receipts)`,
		`fully correct receipts   ${pct(s.fully_correct.rate)} (${s.fully_correct.correct}/${s.fully_correct.total})`,
		`raw name CER (graphemes) ${pct(s.raw_name_cer)}`,
		`catalog match accuracy   ${pct(s.catalog_match_accuracy.rate)}`,
		`fallback rate            ${pct(s.fallback_rate)}`,
		`needs_review rate        ${pct(s.needs_review_rate)}`,
		`cost per receipt (USD)   mean ${num(s.cost_usd.mean, 5)}  p95 ${num(s.cost_usd.p95, 5)}`,
		`latency per receipt (ms) p50 ${num(s.latency_ms.p50, 0)}  p95 ${num(s.latency_ms.p95, 0)}`,
		`checks vs wrong extractions: caught ${s.checks.caught}, missed ${s.checks.missed}, false alarms ${s.checks.false_alarms}, clean ${s.checks.clean}  (recall ${pct(s.checks.recall)}, precision ${pct(s.checks.precision)})`,
		"field accuracy:",
		...Object.entries(s.field_accuracy).map(
			([field, r]) =>
				`  ${field.padEnd(18)} ${pct(r.rate).padStart(6)} (${r.correct}/${r.total})`,
		),
		"",
	];
}

export function formatRun(run: EvalRun): string {
	return [
		`# eval: dataset=${run.dataset} ocr=${run.ocr_provider} structurer=${run.structurer} fallback=${run.fallback ?? "none"}`,
		`schema=${run.schema_version} labels=${run.label_version} commit=${run.git_commit ?? "unknown"} at=${run.created_at}`,
		...(run.dataset === "synthetic"
			? [
					"NOTE: synthetic data and a canned structurer. These numbers test the harness; they are not accuracy results.",
				]
			: []),
		...run.skipped.map((s) => `skipped ${s.id}: ${s.reason}`),
		"",
		"## OCR per receipt",
		...run.receipts.map(
			(r) =>
				`  ${r.id.padEnd(36)} ${String(r.ocr.lines).padStart(3)} lines  ${r.ocr.dropped} dropped  min conf ${num(r.ocr.min_confidence, 3)}  ${num(r.ocr.duration_ms, 0).padStart(5)} ms${r.ocr.cache_hit ? " (cached)" : ""}  ${r.ocr.model}${r.failed_checks.length ? `\n      flagged: ${r.failed_checks.map((f) => `${f.check}${f.path ? `(${f.path})` : ""}`).join(", ")}` : ""}`,
		),
		"",
		...summaryLines("all", run.summary.all),
		...summaryLines("easy", run.summary.easy),
		...summaryLines("hard", run.summary.hard),
	].join("\n");
}
