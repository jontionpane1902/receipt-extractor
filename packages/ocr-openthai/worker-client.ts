import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	encodeRequest,
	type Failure,
	type OcrSuccess,
	ocrRequest,
	PROTOCOL_VERSION,
	type ProtocolError,
	parseWorkerLine,
	type ReadyMessage,
	type WorkerRequest,
} from "./protocol.ts";

export interface WorkerClientOptions {
	/** Program and arguments, e.g. [".venv/bin/python", "worker.py", "--model-dir", dir]. */
	command: readonly [string, ...string[]];
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** Model load can take a few seconds on a cold disk. */
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

/** The worker process failed: could not start, crashed, timed out, or broke the protocol. */
export class WorkerError extends Error {
	override readonly name = "WorkerError";
}

/** The worker is healthy but rejected this one request (e.g. an undecodable image). */
export class OcrRequestError extends Error {
	override readonly name = "OcrRequestError";
	readonly code: string;

	constructor(failure: Failure["error"]) {
		super(`${failure.code}: ${failure.message}`);
		this.code = failure.code;
	}
}

interface Pending {
	resolve: (message: OcrSuccess | { pong: true }) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const STDERR_TAIL_BYTES = 4000;

/**
 * Owns one long-lived worker process and speaks JSON lines to it.
 *
 * The process starts on first use, loads the model once, and then answers
 * any number of requests. Responses are matched to requests by id. Any
 * process-level failure (exit, timeout, malformed output) kills the worker
 * and rejects everything in flight: after a protocol break the stream can
 * no longer be trusted. A dead client stays dead; create a new one.
 */
export class WorkerClient {
	readonly #options: Required<
		Pick<WorkerClientOptions, "startupTimeoutMs" | "requestTimeoutMs">
	> &
		WorkerClientOptions;
	#child: ChildProcessWithoutNullStreams | null = null;
	#ready: Promise<ReadyMessage> | null = null;
	#pending = new Map<string, Pending>();
	#nextId = 1;
	#stderrTail = "";
	#failure: WorkerError | null = null;
	#closed = false;
	#isReady = false;
	#exited = false;

	constructor(options: WorkerClientOptions) {
		this.#options = {
			startupTimeoutMs: 60_000,
			requestTimeoutMs: 120_000,
			...options,
		};
	}

	/** Starts the worker if needed and resolves once its model is loaded. */
	start(): Promise<ReadyMessage> {
		if (this.#failure) return Promise.reject(this.#failure);
		if (this.#closed)
			return Promise.reject(new WorkerError("worker client is closed"));
		this.#ready ??= this.#spawn();
		return this.#ready;
	}

	get pid(): number | undefined {
		return this.#child?.pid;
	}

	async ocr(image: Uint8Array): Promise<OcrSuccess> {
		const id = String(this.#nextId++);
		const message = await this.#send(ocrRequest(id, image));
		if ("pong" in message) {
			throw this.#fail(
				new WorkerError("worker answered an ocr request with a pong"),
			);
		}
		return message;
	}

	async ping(): Promise<void> {
		await this.#send({ id: String(this.#nextId++), op: "ping" });
	}

	/** Closes stdin so the worker exits on its own, then makes sure it is gone. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		this.#rejectAll(new WorkerError("worker client was closed"));
		// A process that never started (or already ended) emits no exit event.
		if (!child || this.#exited || child.pid === undefined) return;
		await new Promise<void>((resolve) => {
			const force = setTimeout(() => {
				child.kill("SIGKILL");
				setTimeout(resolve, 500); // never wait forever on a stuck process
			}, 2000);
			child.once("exit", () => {
				clearTimeout(force);
				resolve();
			});
			child.stdin.end();
		});
	}

	#spawn(): Promise<ReadyMessage> {
		const [program, ...args] = this.#options.command;
		return new Promise<ReadyMessage>((resolve, reject) => {
			let settled = false;
			const settle = (error: WorkerError | null, ready?: ReadyMessage) => {
				if (settled) return;
				settled = true;
				clearTimeout(startupTimer);
				if (error) reject(error);
				else if (ready) resolve(ready);
			};

			let child: ChildProcessWithoutNullStreams;
			try {
				child = spawn(program, args, {
					cwd: this.#options.cwd,
					// An undefined value removes the variable from the child's environment.
					env: Object.fromEntries(
						Object.entries({ ...process.env, ...this.#options.env }).filter(
							(entry): entry is [string, string] => entry[1] !== undefined,
						),
					),
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (error) {
				settle(
					this.#fail(
						new WorkerError(
							`could not start OCR worker "${program}": ${String(error)}`,
						),
					),
				);
				return;
			}
			this.#child = child;

			const startupTimer = setTimeout(() => {
				settle(
					this.#fail(
						new WorkerError(
							`OCR worker was not ready after ${this.#options.startupTimeoutMs} ms`,
						),
					),
				);
			}, this.#options.startupTimeoutMs);

			child.on("error", (error) => {
				this.#exited = true;
				settle(
					this.#fail(
						new WorkerError(
							`could not start OCR worker "${program}": ${error.message}`,
						),
					),
				);
			});
			child.stdin.on("error", () => {
				// EPIPE when the worker died; the exit handler reports it.
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
			});
			child.on("exit", (code, signal) => {
				this.#exited = true;
				if (this.#closed) return;
				const error = this.#fail(
					new WorkerError(
						`OCR worker exited unexpectedly (${signal ?? `code ${code}`})`,
					),
				);
				settle(error);
			});

			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				if (!line.trim() || this.#failure) return;
				let message: ReturnType<typeof parseWorkerLine>;
				try {
					message = parseWorkerLine(line);
				} catch (error) {
					settle(this.#fail(new WorkerError((error as ProtocolError).message)));
					return;
				}
				if (message.type === "fatal") {
					settle(
						this.#fail(
							new WorkerError(`OCR worker failed to start: ${message.error}`),
						),
					);
				} else if (message.type === "ready") {
					if (this.#isReady) {
						this.#fail(
							new WorkerError("OCR worker sent a second ready message"),
						);
					} else if (message.protocol !== PROTOCOL_VERSION) {
						settle(
							this.#fail(
								new WorkerError(
									`OCR worker speaks protocol ${message.protocol}, this client speaks ${PROTOCOL_VERSION}`,
								),
							),
						);
					} else {
						this.#isReady = true;
						settle(null, message);
					}
				} else {
					this.#onResult(message);
				}
			});
		});
	}

	#onResult(
		message: OcrSuccess | Failure | { id: string; ok: true; pong: true },
	): void {
		if (!this.#isReady) {
			this.#fail(
				new WorkerError("OCR worker sent a result before it was ready"),
			);
			return;
		}
		const pending =
			message.id === null ? undefined : this.#pending.get(message.id);
		if (!pending || message.id === null) {
			this.#fail(
				new WorkerError(
					`OCR worker answered an unknown request id: ${JSON.stringify(message.id)}`,
				),
			);
			return;
		}
		this.#pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.ok) pending.resolve(message);
		else pending.reject(new OcrRequestError(message.error));
	}

	async #send(request: WorkerRequest): Promise<OcrSuccess | { pong: true }> {
		await this.start();
		const child = this.#child;
		if (this.#failure || !child)
			throw this.#failure ?? new WorkerError("no worker");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#fail(
					new WorkerError(
						`OCR worker did not answer within ${this.#options.requestTimeoutMs} ms`,
					),
				);
			}, this.#options.requestTimeoutMs);
			this.#pending.set(request.id, { resolve, reject, timer });
			child.stdin.write(encodeRequest(request));
		});
	}

	/** Marks the client dead, kills the process and rejects everything in flight. */
	#fail(error: WorkerError): WorkerError {
		if (this.#failure) return this.#failure;
		const tail = this.#stderrTail.trim();
		const failure = tail
			? new WorkerError(`${error.message}\n--- worker stderr ---\n${tail}`)
			: error;
		this.#failure = failure;
		this.#child?.kill("SIGKILL");
		this.#rejectAll(failure);
		return failure;
	}

	#rejectAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}
