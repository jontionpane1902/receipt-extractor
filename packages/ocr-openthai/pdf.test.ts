import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CachedOcrProvider,
	InMemoryOcrCacheStore,
	type OcrImage,
} from "@receipt-extractor/core";
import { type CliDeps, main } from "./cli.ts";
import {
	describePdf,
	isPdf,
	PdfError,
	type PdfRenderOptions,
	renderArgs,
	renderPdfPage,
} from "./pdf.ts";
import { OpenThaiLocalProvider } from "./provider.ts";
import { stubCommand } from "./test/stub.ts";

const dir = await mkdtemp(join(tmpdir(), "ocr-pdf-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

// Invented files: only the "%PDF-" signature matters to the code under test.
const pdfPath = join(dir, "scan.pdf");
await writeFile(pdfPath, "%PDF-1.4\ninvented\n");
const disguised = join(dir, "really-a-pdf.png");
await writeFile(disguised, "%PDF-1.7\n");
const pngPath = join(dir, "photo.png");
await writeFile(pngPath, "not a pdf");
const brokenPdf = join(dir, "broken.pdf");
await writeFile(brokenPdf, "%PDF-1.4\n");
const crashPdf = join(dir, "crash.pdf");
await writeFile(crashPdf, "%PDF-1.4\n");

const stub: PdfRenderOptions = {
	command: [process.execPath, join(import.meta.dir, "test", "stub-render.ts")],
	outDir: join(dir, "renders"),
};

describe("isPdf", () => {
	test("goes by the file signature, not the extension", async () => {
		expect(await isPdf(pdfPath)).toBe(true);
		expect(await isPdf(disguised)).toBe(true);
		expect(await isPdf(pngPath)).toBe(false);
	});
});

describe("renderArgs", () => {
	test("defaults to page 1 at native resolution", () => {
		expect(renderArgs("a.pdf", { outDir: "/out" }, false)).toEqual([
			"a.pdf",
			"--page",
			"1",
			"--out-dir",
			"/out",
		]);
	});

	test("passes page and scale; dpi overrides scale", () => {
		expect(
			renderArgs("a.pdf", { page: 3, scale: 2, outDir: "/o" }, false),
		).toEqual(["a.pdf", "--page", "3", "--scale", "2", "--out-dir", "/o"]);
		expect(
			renderArgs("a.pdf", { scale: 2, dpi: 300, outDir: "/o" }, false),
		).toEqual(["a.pdf", "--page", "1", "--dpi", "300", "--out-dir", "/o"]);
		expect(renderArgs("a.pdf", {}, true).at(-1)).toBe("--info");
	});

	test("rejects nonsense values", () => {
		for (const options of [
			{ page: 0 },
			{ page: 1.5 },
			{ scale: -1 },
			{ dpi: Number.NaN },
		]) {
			expect(() => renderArgs("a.pdf", options, false)).toThrow(PdfError);
		}
	});
});

describe("renderPdfPage / describePdf (stub renderer)", () => {
	test("describes without rendering", async () => {
		const info = await describePdf(pdfPath, stub);
		expect(info).toMatchObject({
			page_count: 2,
			images: [{ width: 300, height: 600 }],
			native_scale: 3,
		});
		expect("render" in info).toBe(false);
	});

	test("renders at native resolution by default, never upsampling", async () => {
		const result = await renderPdfPage(pdfPath, stub);
		expect(result.render).toMatchObject({
			width: 300,
			height: 600,
			mode: "native",
		});
		expect(result.render.png.startsWith(join(dir, "renders"))).toBe(true);
		expect(await Bun.file(result.render.png).exists()).toBe(true);
	});

	test("scale, dpi and page change the render and its file", async () => {
		const native = await renderPdfPage(pdfPath, stub);
		const doubled = await renderPdfPage(pdfPath, { ...stub, scale: 2 });
		const byDpi = await renderPdfPage(pdfPath, { ...stub, dpi: 144 });
		const second = await renderPdfPage(pdfPath, { ...stub, page: 2 });
		expect(doubled.render).toMatchObject({
			width: 600,
			height: 1200,
			mode: "native_x2",
		});
		expect(byDpi.render).toMatchObject({
			width: 200,
			height: 400,
			mode: "dpi",
		});
		expect(second.page).toBe(2);
		expect(
			new Set([native, doubled, byDpi, second].map((r) => r.render.png)).size,
		).toBe(4);
	});

	test("errors from the renderer are reported, including a missing page", async () => {
		await expect(renderPdfPage(brokenPdf, stub)).rejects.toThrow(
			/cannot open PDF/,
		);
		await expect(renderPdfPage(pdfPath, { ...stub, page: 9 })).rejects.toThrow(
			/page 9 does not exist/,
		);
		await expect(renderPdfPage(crashPdf, stub)).rejects.toThrow(/stub crash/);
	});
});

describe("ocr CLI with a PDF", () => {
	function harness() {
		const out: string[] = [];
		const err: string[] = [];
		const seen: OcrImage[] = [];
		const store = new InMemoryOcrCacheStore();
		const rendered: PdfRenderOptions[] = [];
		const deps: CliDeps = {
			open() {
				const local = new OpenThaiLocalProvider({ command: stubCommand() });
				const cached = new CachedOcrProvider(local, store, "stub");
				return {
					provider: {
						name: cached.name,
						recognize: (image) => {
							seen.push(image);
							return cached.recognize(image);
						},
					},
					close: () => local.close(),
				};
			},
			renderPdf: (path, options = {}) => {
				rendered.push(options);
				return renderPdfPage(path, { ...options, ...stub });
			},
			stdout: (text) => void out.push(text),
			stderr: (text) => void err.push(text),
		};
		return { deps, out, err, seen, rendered };
	}

	test("renders page 1 and OCRs the rendered PNG, saying what it did", async () => {
		const h = harness();
		expect(await main([pdfPath], h.deps)).toBe(0);
		const text = h.out.join("");
		expect(text).toContain(
			"page 1 of 2, rendered 300x600 px (native, 216 dpi)",
		);
		expect(text).toContain("1 other page(s) not read, use --page");
		expect(h.seen[0]?.mime_type).toBe("image/png");
		expect(new TextDecoder().decode(h.seen[0]?.bytes)).toBe(
			"fake png page=1 300x600",
		);
	});

	test("--page and --scale are passed to the renderer", async () => {
		const h = harness();
		expect(await main([pdfPath, "--page", "2", "--scale", "2"], h.deps)).toBe(
			0,
		);
		expect(h.rendered).toEqual([{ page: 2, scale: 2 }]);
		expect(h.out.join("")).toContain(
			"page 2 of 2, rendered 600x1200 px (native_x2",
		);
	});

	test("the OCR cache keeps different render settings apart", async () => {
		const h = harness();
		await main([pdfPath], h.deps);
		await main([pdfPath], h.deps);
		await main([pdfPath, "--scale", "2"], h.deps);
		await main([pdfPath, "--page", "2"], h.deps);
		const cached = h.out.map((text) => text.includes("(from cache"));
		expect(cached).toEqual([false, true, false, false]);
	});

	test("a PDF that cannot be rendered exits 1; PDF flags on an image exit 2", async () => {
		const bad = harness();
		expect(await main([brokenPdf], bad.deps)).toBe(1);
		expect(bad.err.join("")).toContain("cannot open PDF");
		const image = harness();
		expect(await main([pngPath, "--scale", "2"], image.deps)).toBe(2);
		expect(image.err.join("")).toContain("only apply to a PDF");
		expect(image.seen).toEqual([]);
	});
});
