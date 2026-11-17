import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CachedOcrProvider,
	groupRows,
	InMemoryOcrCacheStore,
	type OcrLine,
} from "@receipt-extractor/core";
import { type CliDeps, formatText, main, USAGE } from "./cli.ts";
import { OpenThaiLocalProvider } from "./provider.ts";
import { stubCommand } from "./test/stub.ts";

const dir = await mkdtemp(join(tmpdir(), "ocr-cli-test-"));
const imagePath = join(dir, "receipt.JPG");
await writeFile(imagePath, "hello");
afterAll(() => rm(dir, { recursive: true, force: true }));

/** CLI wired to the stub worker instead of Python, capturing its output. */
function harness(mode = "ok") {
	const out: string[] = [];
	const err: string[] = [];
	const store = new InMemoryOcrCacheStore();
	const opened: { cache: boolean; backend?: string }[] = [];
	const providers: OpenThaiLocalProvider[] = [];
	const deps: CliDeps = {
		open(options) {
			opened.push(options);
			const local = new OpenThaiLocalProvider({ command: stubCommand(mode) });
			providers.push(local);
			return {
				provider: options.cache
					? new CachedOcrProvider(local, store, "stub")
					: local,
				close: () => local.close(),
			};
		},
		stdout: (text) => void out.push(text),
		stderr: (text) => void err.push(text),
	};
	return { deps, out, err, opened, providers };
}

describe("ocr CLI with the stub worker", () => {
	test("prints rows in reading order with name and price joined, and dropped lines", async () => {
		const h = harness();
		expect(await main([imagePath], h.deps)).toBe(0);
		const text = h.out.join("");

		expect(text).toContain(`image:    ${imagePath}`);
		expect(text).toContain("model:    stub/model@stubrev+stub");
		expect(text).toContain("read:     1 rows, 2 lines, 1 dropped");
		// Both parts of the row on one output line, each with its confidence;
		// the row's own figure is the lower of the two.
		expect(text).toMatch(
			/\n {2}0 {2}0\.988 {2}\d+:1:hello \[0\.988\] │ 35\.00 \[1\.000\]\n/,
		);
		expect(text).toContain("dropped by the model's own filter: 1");
		expect(text).toMatch(/0\.410 {2}~~ {3}\(low_confidence\)/);
		expect(h.err).toEqual([]);
	});

	test("--json prints the full result plus joined rows", async () => {
		const h = harness();
		expect(await main([imagePath, "--json"], h.deps)).toBe(0);
		const parsed = JSON.parse(h.out.join(""));
		expect(parsed.image).toBe(imagePath);
		expect(parsed.provider).toBe("openthai-local");
		expect(parsed.lines).toHaveLength(2);
		expect(parsed.lines[0].box).toHaveLength(4);
		expect(parsed.dropped[0]).toMatchObject({
			text: "~~",
			reason: "low_confidence",
		});
		expect(parsed.rows).toHaveLength(1);
		expect(parsed.rows[0].text).toMatch(/:1:hello 35\.00$/);
		expect(parsed.rows[0].min_confidence).toBe(0.9876);
	});

	test("uses the cache by default and stops the worker afterwards", async () => {
		const h = harness();
		await main([imagePath], h.deps);
		await main([imagePath], h.deps);
		expect(h.opened).toEqual([{ cache: true }, { cache: true }]);
		expect(h.out[1]).toContain("(from cache");
		// Second run was a hit: its provider never started a process.
		expect(h.providers.map((p) => p.pid)).toEqual([undefined, undefined]);
	});

	test("--no-cache and --backend are passed through", async () => {
		const h = harness();
		await main([imagePath, "--no-cache", "--backend", "onnxruntime"], h.deps);
		expect(h.opened).toEqual([{ cache: false, backend: "onnxruntime" }]);
		expect(h.out.join("")).not.toContain("from cache");
	});

	test("usage errors exit 2 without starting OCR", async () => {
		for (const argv of [
			[],
			["a.png", "b.png"],
			["a.png", "--backend", "gpu"],
			["a.png", "--nope"],
		]) {
			const h = harness();
			expect(await main(argv, h.deps)).toBe(2);
			expect(h.err.join("")).toContain(USAGE);
			expect(h.opened).toEqual([]);
		}
	});

	test("a missing file exits 1 with the path", async () => {
		const h = harness();
		expect(await main([join(dir, "missing.jpg")], h.deps)).toBe(1);
		expect(h.err.join("")).toContain("cannot read");
		expect(h.opened).toEqual([]);
	});

	test("a worker failure exits 1 and still closes the worker", async () => {
		const h = harness("crash-on-ocr");
		expect(await main([imagePath, "--no-cache"], h.deps)).toBe(1);
		expect(h.err.join("")).toContain("OCR failed");
		expect(h.out).toEqual([]);
		expect(h.providers[0]?.pid).toBeUndefined();
	});
});

describe("groupRows / formatText", () => {
	const line = (
		text: string,
		confidence: number | null,
		row?: number,
	): OcrLine => ({
		text,
		box: null,
		confidence,
		...(row === undefined ? {} : { row }),
	});

	test("joins only consecutive lines that share a row", () => {
		const rows = groupRows([
			line("กาแฟเย็น", 0.9, 0),
			line("35.00", 1, 0),
			line("ส่วนลด", 0.8, 1),
			line("no row a", 0.7),
			line("no row b", 0.7),
		]);
		expect(rows.map((r) => r.text)).toEqual([
			"กาแฟเย็น 35.00",
			"ส่วนลด",
			"no row a",
			"no row b",
		]);
	});

	test("handles a result with no confidence and nothing dropped", () => {
		const text = formatText("x.png", {
			lines: [line("plain", null)],
			provider: "p",
			model: "m",
			duration_ms: 5,
		});
		expect(text).toContain("read:     1 rows, 1 lines, 0 dropped\n");
		expect(text).toContain("  0   n/a   plain");
		expect(text).toContain("dropped by the model's own filter: 0");
	});
});
