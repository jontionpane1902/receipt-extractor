/**
 * OCR one image with the local OpenThai model and print what it read.
 *
 *   bun run ocr <image-path> [--json] [--no-cache] [--backend openvino|onnxruntime]
 *
 * Runs entirely on this machine: the image is read by the Python worker
 * and nothing is sent anywhere. Output goes to stdout only; the result is
 * also kept in the git-ignored OCR cache unless --no-cache is given.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import {
	groupRows,
	type OcrProvider,
	type OcrResult,
} from "@receipt-extractor/core";
import { createLocalOpenThaiOcr } from "./create.ts";

export const USAGE =
	"usage: bun run ocr <image-path> [--json] [--no-cache] [--backend openvino|onnxruntime]";

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".heic": "image/heic",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
};

const conf = (value: number | null) =>
	value === null ? " n/a " : value.toFixed(3);

/** Human-readable report: one printed row per line, with each part's confidence. */
export function formatText(path: string, result: OcrResult): string {
	const rows = groupRows(result.lines);
	const scores = result.lines
		.map((line) => line.confidence)
		.filter((c): c is number => c !== null);
	const dropped = result.dropped ?? [];
	const out = [
		`image:    ${path}`,
		`model:    ${result.model}`,
		`ocr time: ${result.duration_ms} ms${result.cache_hit ? " (from cache; time of the original read)" : ""}`,
		`read:     ${rows.length} rows, ${result.lines.length} lines, ${dropped.length} dropped${scores.length ? `, confidence min ${conf(Math.min(...scores))} mean ${conf(scores.reduce((a, b) => a + b, 0) / scores.length)}` : ""}`,
		"",
		"row  conf   text      (parts of one printed row are separated by │)",
	];
	for (const [index, row] of rows.entries()) {
		const label = String(row.row ?? index).padStart(3);
		const lowest = row.lines
			.map((line) => line.confidence)
			.filter((c): c is number => c !== null);
		const parts = row.lines.map((line) =>
			row.lines.length > 1
				? `${line.text} [${conf(line.confidence)}]`
				: line.text,
		);
		out.push(
			`${label}  ${conf(lowest.length ? Math.min(...lowest) : null)}  ${parts.join(" │ ")}`,
		);
	}
	out.push("", `dropped by the model's own filter: ${dropped.length}`);
	for (const line of dropped) {
		out.push(
			`${String(line.row ?? "").padStart(3)}  ${conf(line.confidence)}  ${line.text}   (${line.reason})`,
		);
	}
	return `${out.join("\n")}\n`;
}

export function formatJson(path: string, result: OcrResult): string {
	const rows = groupRows(result.lines).map(({ row, text, lines }) => ({
		row,
		text,
		min_confidence: lines.reduce<number | null>(
			(min, line) =>
				line.confidence === null
					? min
					: min === null
						? line.confidence
						: Math.min(min, line.confidence),
			null,
		),
	}));
	return `${JSON.stringify({ image: path, ...result, rows }, null, "\t")}\n`;
}

export interface CliDeps {
	/** Opens the OCR provider; `close` must stop any worker process. */
	open(options: { cache: boolean; backend?: "openvino" | "onnxruntime" }): {
		provider: OcrProvider;
		close(): Promise<void>;
	};
	stdout(text: string): void;
	stderr(text: string): void;
}

const defaultDeps: CliDeps = {
	open({ cache, backend }) {
		const ocr = createLocalOpenThaiOcr(backend ? { backend } : {});
		return { provider: cache ? ocr.provider : ocr.local, close: ocr.close };
	},
	stdout: (text) => void process.stdout.write(text),
	stderr: (text) => void process.stderr.write(text),
};

/** Returns the process exit code. */
export async function main(
	argv: readonly string[],
	deps: CliDeps = defaultDeps,
): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		deps.stderr(`${(error as Error).message}\n${USAGE}\n`);
		return 2;
	}
	const { values, positionals } = parsed;
	const [path] = positionals;
	if (values.help) {
		deps.stdout(`${USAGE}\n`);
		return 0;
	}
	if (path === undefined || positionals.length !== 1) {
		deps.stderr(`${USAGE}\n`);
		return 2;
	}
	const backend = values.backend;
	if (
		backend !== undefined &&
		backend !== "openvino" &&
		backend !== "onnxruntime"
	) {
		deps.stderr(`unknown --backend "${backend}"\n${USAGE}\n`);
		return 2;
	}

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(path));
	} catch (error) {
		deps.stderr(`cannot read ${path}: ${(error as Error).message}\n`);
		return 1;
	}

	let ocr: ReturnType<CliDeps["open"]> | undefined;
	try {
		ocr = deps.open({
			cache: !values["no-cache"],
			...(backend ? { backend } : {}),
		});
		const result = await ocr.provider.recognize({
			bytes,
			mime_type:
				MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
		});
		deps.stdout(
			values.json ? formatJson(path, result) : formatText(path, result),
		);
		return 0;
	} catch (error) {
		deps.stderr(`OCR failed: ${(error as Error).message}\n`);
		return 1;
	} finally {
		await ocr?.close();
	}
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			json: { type: "boolean", default: false },
			"no-cache": { type: "boolean", default: false },
			backend: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
}

if (import.meta.main) {
	process.exit(await main(Bun.argv.slice(2)));
}
