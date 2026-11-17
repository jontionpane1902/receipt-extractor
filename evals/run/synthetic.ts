import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type CatalogEntry,
	FakeOcrProvider,
	fakeImage,
	InMemoryCatalogStore,
	linesFromText,
	type OcrProvider,
} from "@receipt-extractor/core";
import { CannedStructurer } from "./fakes.ts";
import { type SyntheticSample, SyntheticSampleSchema } from "./label.ts";
import { type EvalCase, type EvalRun, runEval } from "./runner.ts";

export const DATASET_DIR = join(import.meta.dir, "..", "dataset");
export const SYNTHETIC_DIR = join(DATASET_DIR, "synthetic");

const MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

export async function loadSyntheticSamples(
	dir: string = SYNTHETIC_DIR,
): Promise<{ samples: SyntheticSample[]; catalog: CatalogEntry[] }> {
	const sampleDir = join(dir, "samples");
	const files = (await readdir(sampleDir))
		.filter((file) => file.endsWith(".json"))
		.sort();
	const samples = await Promise.all(
		files.map(async (file) =>
			SyntheticSampleSchema.parse(await Bun.file(join(sampleDir, file)).json()),
		),
	);
	const catalog = (await Bun.file(
		join(dir, "catalog.json"),
	).json()) as CatalogEntry[];
	return { samples, catalog };
}

/**
 * Runs the eval on the synthetic samples with a canned structurer.
 *
 * - No `ocr` given (default): the in-memory fake provider serves each
 *   sample's canned OCR lines. Fully offline.
 * - `ocr` given: that provider reads the sample's image. Samples without an
 *   image cannot be read by a real provider and are reported as skipped.
 */
export async function runSyntheticEval(options: {
	now: Date;
	gitCommit?: string | null;
	dir?: string;
	datasetDir?: string;
	ocr?: OcrProvider;
}): Promise<EvalRun> {
	const { samples, catalog } = await loadSyntheticSamples(options.dir);
	const datasetDir = options.datasetDir ?? DATASET_DIR;
	const fake = new FakeOcrProvider();
	const cases: EvalCase[] = [];
	const skipped: { id: string; reason: string }[] = [];

	for (const sample of samples) {
		const { label } = sample;
		const structurer = new CannedStructurer(sample.extraction);
		if (!options.ocr) {
			fake.set(label.id, linesFromText(sample.ocr_lines));
			cases.push({ label, image: fakeImage(label.id), structurer });
		} else if (label.image === null) {
			skipped.push({
				id: label.id,
				reason: "no image: sample exists only as canned OCR lines",
			});
		} else {
			const extension = label.image.split(".").at(-1)?.toLowerCase() ?? "";
			cases.push({
				label,
				image: {
					bytes: new Uint8Array(
						await Bun.file(join(datasetDir, label.image)).arrayBuffer(),
					),
					mime_type: MIME_TYPES[extension] ?? "application/octet-stream",
				},
				structurer,
			});
		}
	}

	return runEval(
		cases,
		{ ocr: options.ocr ?? fake, now: options.now },
		{
			dataset: "synthetic",
			gitCommit: options.gitCommit ?? null,
			catalogFor: () => new InMemoryCatalogStore(catalog),
			skipped,
		},
	);
}
