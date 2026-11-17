import { describe, expect, test } from "bun:test";
import {
	FakeOcrProvider,
	fakeImage,
	InMemoryCatalogStore,
	linesFromText,
} from "@receipt-extractor/core";
import { ReplayStructurer } from "./fakes.ts";
import { runPipeline } from "./pipeline.ts";
import { formatRun } from "./report.ts";
import { loadSyntheticSamples, runSyntheticEval } from "./synthetic.ts";

const NOW = new Date("2026-11-18T09:00:00+07:00");

describe("synthetic eval run (fake OCR, fake structurer, no network)", () => {
	test("every synthetic sample matches the documented label format", async () => {
		const { samples } = await loadSyntheticSamples();
		expect(samples.length).toBeGreaterThanOrEqual(4);
		expect(samples.every((s) => s.label.image === null)).toBe(true);
	});

	test("computes all metrics", async () => {
		const run = await runSyntheticEval({ now: NOW, gitCommit: "test" });
		const { all, easy, hard } = run.summary;

		expect(all.receipts).toBe(4);
		expect(easy.receipts).toBe(2);
		expect(hard.receipts).toBe(2);

		// 001 is right; 002 wrong total, 003 wrong raw name, 004 wrong method.
		expect(all.fully_correct).toMatchObject({ correct: 1, total: 4 });
		expect(all.field_accuracy.total).toMatchObject({ correct: 3, total: 4 });
		expect(all.field_accuracy["payment.method"]?.rate).toBe(0.75);
		expect(all.field_accuracy["items.raw_name"]).toMatchObject({
			correct: 11,
			total: 12,
		});
		expect(all.field_accuracy.datetime?.rate).toBe(1); // BE date resolved by code

		// One grapheme cluster wrong across all raw names.
		expect(all.raw_name_cer).toBeGreaterThan(0);
		expect(all.raw_name_cer).toBeLessThan(0.02);
		expect(easy.raw_name_cer).toBe(0);

		// The catalog recovers the misread name, so every item matches.
		expect(all.catalog_match_accuracy.rate).toBe(1);

		// Checks catch the wrong total and the low-confidence misread, miss
		// the payment method, and raise no false alarm on the clean receipt.
		expect(all.checks).toMatchObject({
			caught: 2,
			missed: 1,
			false_alarms: 0,
			clean: 1,
		});
		expect(all.checks.recall).toBeCloseTo(2 / 3, 10);
		expect(all.checks.precision).toBe(1);

		expect(all.fallback_rate).toBe(0); // no fallback configured
		expect(all.needs_review_rate).toBe(0.5);
		expect(all.cost_usd.mean).toBe(0);
		expect(all.latency_ms.p95).not.toBeNull();
	});

	test("records provenance with every result", async () => {
		const run = await runSyntheticEval({ now: NOW, gitCommit: "abc1234" });
		expect(run).toMatchObject({
			dataset: "synthetic",
			git_commit: "abc1234",
			ocr_provider: "fake",
		});
		expect(run.schema_version).toContain("provisional");
		for (const receipt of run.receipts) {
			expect(receipt.attempts[0]).toEqual({
				model: "fake-replay",
				prompt_version: "none",
			});
			expect(receipt.ocr.provider).toBe("fake");
		}
	});

	test("explains which checks flagged a receipt", async () => {
		const run = await runSyntheticEval({ now: NOW });
		const wrongTotal = run.receipts.find((r) => r.id.includes("wrong-total"));
		const checks = new Set(wrongTotal?.failed_checks.map((f) => f.check));
		expect(checks).toEqual(new Set(["total_sum", "vat", "change"]));
	});

	test("the report labels synthetic numbers as not being accuracy results", async () => {
		const text = formatRun(await runSyntheticEval({ now: NOW }));
		expect(text).toContain("not accuracy results");
		expect(text).toContain("recall 66.7%");
	});
});

describe("runPipeline fallback", () => {
	test("falls back when checks fail, and reports needs_review if still failing", async () => {
		const { samples, catalog } = await loadSyntheticSamples();
		const bad = samples.find((s) => s.label.id.includes("wrong-total"));
		const good = samples.find((s) => s.label.id.includes("clean"));
		if (!bad || !good) throw new Error("synthetic samples missing");

		const ocr = new FakeOcrProvider({ x: linesFromText(bad.ocr_lines) });
		const primary = new ReplayStructurer("primary");
		primary.set("x", bad.extraction);
		const fixing = new ReplayStructurer("vision");
		fixing.set("x", good.extraction);
		const deps = {
			ocr,
			structurer: primary,
			catalog: new InMemoryCatalogStore(catalog),
			now: NOW,
		};

		const recovered = await runPipeline(fakeImage("x"), {
			...deps,
			fallback: fixing,
		});
		expect(recovered.used_fallback).toBe(true);
		expect(recovered.final.total).toBe(64);
		expect(recovered.final.needs_review).toBe(false);

		const stillBad = await runPipeline(fakeImage("x"), {
			...deps,
			fallback: primary,
		});
		expect(stillBad.used_fallback).toBe(true);
		expect(stillBad.final.needs_review).toBe(true);

		const noFallbackNeeded = await runPipeline(fakeImage("x"), {
			...deps,
			structurer: fixing,
			fallback: primary,
		});
		expect(noFallbackNeeded.used_fallback).toBe(false);
	});
});
