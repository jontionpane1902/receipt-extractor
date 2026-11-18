import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { PYTHON_DIR, REPO_ROOT, SETUP_HINT, venvPython } from "./paths.ts";

/** Rendered pages are derived from private documents: keep them git-ignored. */
export const DEFAULT_PDF_RENDER_DIR = join(REPO_ROOT, ".cache", "pdf-render");

export interface PdfRenderOptions {
	/** 1-based page number. Default 1. */
	page?: number;
	/**
	 * Multiplies the native resolution (the embedded image's own pixels for
	 * a scanned page). Default 1: no upsampling.
	 */
	scale?: number;
	/** Absolute resolution; overrides `scale`. */
	dpi?: number;
	outDir?: string;
	/** Replaces the Python command. For tests with a stub. */
	command?: readonly [string, ...string[]];
}

export interface PdfPageInfo {
	page_count: number;
	page: number;
	page_size_pt: [number, number];
	/** Pixel size of each image embedded in the page, and the share of the page it covers. */
	images: { width: number; height: number; page_share: number }[];
	/** Pixels per PDF point of a single full-page image, else null. */
	native_scale: number | null;
	native_dpi: number | null;
}

export interface PdfRender extends PdfPageInfo {
	render: {
		png: string;
		width: number;
		height: number;
		scale: number;
		dpi: number;
		/** "native", "native_x2", "default_dpi", "dpi", ... */
		mode: string;
	};
}

export class PdfError extends Error {
	override readonly name = "PdfError";
}

/** True when the file starts with the PDF signature, whatever its extension. */
export async function isPdf(path: string): Promise<boolean> {
	const file = await open(path, "r");
	try {
		const { buffer, bytesRead } = await file.read(Buffer.alloc(5), 0, 5, 0);
		return bytesRead === 5 && buffer.toString("latin1") === "%PDF-";
	} finally {
		await file.close();
	}
}

/** Arguments for python/render_pdf.py. */
export function renderArgs(
	pdfPath: string,
	options: PdfRenderOptions,
	infoOnly: boolean,
): string[] {
	for (const [name, value] of [
		["page", options.page],
		["scale", options.scale],
		["dpi", options.dpi],
	] as const) {
		if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
			throw new PdfError(`${name} must be a positive number`);
		}
	}
	if (options.page !== undefined && !Number.isInteger(options.page)) {
		throw new PdfError("page must be a whole number");
	}
	return [
		pdfPath,
		"--page",
		String(options.page ?? 1),
		...(options.dpi !== undefined ? ["--dpi", String(options.dpi)] : []),
		...(options.dpi === undefined && options.scale !== undefined
			? ["--scale", String(options.scale)]
			: []),
		...(infoOnly
			? ["--info"]
			: ["--out-dir", options.outDir ?? DEFAULT_PDF_RENDER_DIR]),
	];
}

async function run(
	pdfPath: string,
	options: PdfRenderOptions,
	infoOnly: boolean,
): Promise<unknown> {
	const args = renderArgs(pdfPath, options, infoOnly);
	let command: string[];
	if (options.command) command = [...options.command, ...args];
	else {
		const python = venvPython();
		if (!existsSync(python)) {
			throw new PdfError(
				`Python environment not found at ${python}. ${SETUP_HINT}`,
			);
		}
		command = [python, join(PYTHON_DIR, "render_pdf.py"), ...args];
	}
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	let result: { ok?: boolean; error?: string };
	try {
		result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
	} catch {
		throw new PdfError(
			`PDF renderer gave no result (exit ${child.exitCode}): ${stderr.trim().slice(-500) || "no output"}`,
		);
	}
	if (result.ok !== true)
		throw new PdfError(result.error ?? "PDF rendering failed");
	return result;
}

/** Page count, page size and embedded image sizes. Renders nothing. */
export async function describePdf(
	pdfPath: string,
	options: Pick<PdfRenderOptions, "page" | "command"> = {},
): Promise<PdfPageInfo> {
	return (await run(pdfPath, options, true)) as PdfPageInfo;
}

/**
 * Renders one PDF page to a PNG on this machine and returns where it is.
 *
 * The PNG name contains a hash of the PDF, the page and the pixel size, and
 * OCR caching is keyed by the PNG's own bytes, so a different PDF, page or
 * render setting can never be served another one's OCR result.
 */
export async function renderPdfPage(
	pdfPath: string,
	options: PdfRenderOptions = {},
): Promise<PdfRender> {
	return (await run(pdfPath, options, false)) as PdfRender;
}
