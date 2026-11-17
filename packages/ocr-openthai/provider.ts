import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OcrImage, OcrProvider, OcrResult } from "@receipt-extractor/core";
import {
	PYTHON_DIR,
	pinnedModelDir,
	readModelManifest,
	SETUP_HINT,
	venvPython,
} from "./paths.ts";
import { type ReadyMessage, toOcrLines } from "./protocol.ts";
import {
	WorkerClient,
	type WorkerClientOptions,
	WorkerError,
} from "./worker-client.ts";

export type OpenThaiBackend = "openvino" | "onnxruntime";

export interface OpenThaiLocalOptions {
	/** Verified model directory. Default: the pinned revision under <repo>/models. */
	modelDir?: string;
	/** Inference threads inside the worker. The model card recommends 1 per process. */
	threads?: number;
	/** Force a backend; default is the runtime's own choice (OpenVINO, else ONNX Runtime). */
	backend?: OpenThaiBackend;
	/** Refuse to run if the worker reports a different model revision. */
	expectedRevision?: string;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	/** Replaces the Python command entirely. For tests with a stub process. */
	command?: readonly [string, ...string[]];
}

export const OPENTHAI_LOCAL_PROVIDER = "openthai-local";

/** `<repo>@<revision>+<backend>`: everything that determines the OCR output. */
export function modelId(
	ready: Pick<ReadyMessage, "model" | "revision" | "backend">,
): string {
	return `${ready.model}@${ready.revision}+${ready.backend}`;
}

/**
 * OCR with the open iapp/OpenThai2.0-OCR-Text weights on this machine.
 *
 * Runs the model repository's official Python runtime in one long-lived
 * subprocess: the model loads on the first image and stays loaded until
 * `close()`. Lines, boxes and confidences are passed through exactly as the
 * runtime returns them, including its own low-confidence filter (the lines
 * it removes are reported in `dropped`).
 *
 * Call `close()` when done, or the worker keeps the process alive.
 */
export class OpenThaiLocalProvider implements OcrProvider {
	readonly name = OPENTHAI_LOCAL_PROVIDER;
	readonly #options: OpenThaiLocalOptions;
	#client: WorkerClient | null = null;
	#ready: ReadyMessage | null = null;

	constructor(options: OpenThaiLocalOptions = {}) {
		this.#options = options;
	}

	/** Model info, available after the first image (or `start()`). */
	get ready(): ReadyMessage | null {
		return this.#ready;
	}

	/** Process id of the running worker, if any. */
	get pid(): number | undefined {
		return this.#client?.pid;
	}

	/** Loads the model now instead of on the first image. */
	async start(): Promise<ReadyMessage> {
		this.#client ??= new WorkerClient(this.#clientOptions());
		try {
			const ready = await this.#client.start();
			const expected = this.#options.expectedRevision;
			if (expected !== undefined && ready.revision !== expected) {
				throw new WorkerError(
					`OCR worker loaded model revision ${ready.revision}, expected ${expected}`,
				);
			}
			this.#ready = ready;
			return ready;
		} catch (error) {
			await this.#reset();
			throw error;
		}
	}

	async recognize(image: OcrImage): Promise<OcrResult> {
		const ready = await this.start();
		const client = this.#client;
		if (!client) throw new WorkerError("OCR worker is not running");
		const started = performance.now();
		try {
			const response = await client.ocr(image.bytes);
			const { lines, dropped } = toOcrLines(response);
			return {
				lines,
				dropped,
				provider: this.name,
				model: modelId(ready),
				duration_ms: Math.round((performance.now() - started) * 10) / 10,
			};
		} catch (error) {
			// A request-level error leaves the worker usable; anything else
			// killed it, so the next image starts a fresh one.
			if (error instanceof WorkerError) await this.#reset();
			throw error;
		}
	}

	async close(): Promise<void> {
		await this.#reset();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	async #reset(): Promise<void> {
		const client = this.#client;
		this.#client = null;
		this.#ready = null;
		await client?.close();
	}

	#clientOptions(): WorkerClientOptions {
		const { startupTimeoutMs, requestTimeoutMs } = this.#options;
		const timeouts = {
			...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
			...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
		};
		if (this.#options.command) {
			return { command: this.#options.command, ...timeouts };
		}
		const python = venvPython();
		if (!existsSync(python)) {
			throw new WorkerError(
				`Python environment not found at ${python}. ${SETUP_HINT}`,
			);
		}
		const modelDir = this.#options.modelDir ?? pinnedModelDir();
		readModelManifest(modelDir); // throws with the setup hint if missing
		return {
			command: [
				python,
				join(PYTHON_DIR, "worker.py"),
				"--model-dir",
				modelDir,
				"--threads",
				String(this.#options.threads ?? 1),
				...(this.#options.backend ? ["--backend", this.#options.backend] : []),
			],
			cwd: PYTHON_DIR,
			// Isolated from the caller's Python settings: no user site-packages,
			// no PYTHONPATH, unbuffered output.
			env: {
				PYTHONPATH: undefined,
				PYTHONNOUSERSITE: "1",
				PYTHONUNBUFFERED: "1",
			},
			...timeouts,
		};
	}
}
