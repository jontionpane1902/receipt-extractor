import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	type CatalogEntry,
	FakeOcrProvider,
	fakeImage,
	InMemoryCatalogStore,
	linesFromText,
} from "@receipt-extractor/core";
import { ReplayStructurer } from "./fakes.ts";
import { type SyntheticSample, SyntheticSampleSchema } from "./label.ts";
import { type EvalRun, runEval } from "./runner.ts";

export const SYNTHETIC_DIR = join(
	import.meta.dir,
	"..",
	"dataset",
	"synthetic",
);

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

/** Runs the whole eval on synthetic samples with fake OCR and a fake structurer. */
export async function runSyntheticEval(options: {
	now: Date;
	gitCommit?: string | null;
	dir?: string;
}): Promise<EvalRun> {
	const { samples, catalog } = await loadSyntheticSamples(options.dir);
	const ocr = new FakeOcrProvider();
	const structurer = new ReplayStructurer();
	for (const sample of samples) {
		ocr.set(sample.label.id, linesFromText(sample.ocr_lines));
		structurer.set(sample.label.id, sample.extraction);
	}
	return runEval(
		samples.map((sample) => ({
			label: sample.label,
			image: fakeImage(sample.label.id),
		})),
		{ ocr, structurer, now: options.now },
		{
			dataset: "synthetic",
			gitCommit: options.gitCommit ?? null,
			catalogFor: () => new InMemoryCatalogStore(catalog),
		},
	);
}
