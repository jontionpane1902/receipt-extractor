import type { OcrDroppedLine, OcrLine, Quad } from "@receipt-extractor/core";
import { z } from "zod";

/**
 * Wire protocol between this package and python/worker.py: one JSON object
 * per line over stdio. The Python side is documented in
 * python/openthai_ocr/protocol.py; the two must change together.
 */
export const PROTOCOL_VERSION = 1;

export const ReadyMessageSchema = z.object({
	type: z.literal("ready"),
	protocol: z.number().int(),
	model: z.string().min(1),
	revision: z.string().min(1),
	backend: z.string().min(1),
	load_ms: z.number().nonnegative(),
});
export type ReadyMessage = z.infer<typeof ReadyMessageSchema>;

const FatalMessageSchema = z.object({
	type: z.literal("fatal"),
	error: z.string(),
});

const WirePointSchema = z.tuple([z.number(), z.number()]);
const WireLineSchema = z.object({
	text: z.string(),
	confidence: z.number().min(0).max(1),
	row: z.number().int().nonnegative(),
	box: z.tuple([
		WirePointSchema,
		WirePointSchema,
		WirePointSchema,
		WirePointSchema,
	]),
});
type WireLine = z.infer<typeof WireLineSchema>;

const OcrSuccessSchema = z.object({
	type: z.literal("result"),
	id: z.string(),
	ok: z.literal(true),
	lines: z.array(WireLineSchema),
	dropped: z.array(WireLineSchema.extend({ reason: z.string() })).default([]),
	rotation: z.number().default(0),
	text_angle: z.number().default(0),
	timing: z.record(z.string(), z.number()).default({}),
});
export type OcrSuccess = z.infer<typeof OcrSuccessSchema>;

const PongSchema = z.object({
	type: z.literal("result"),
	id: z.string(),
	ok: z.literal(true),
	pong: z.literal(true),
});

const FailureSchema = z.object({
	type: z.literal("result"),
	id: z.string().nullable(),
	ok: z.literal(false),
	error: z.object({ code: z.string(), message: z.string() }),
});
export type Failure = z.infer<typeof FailureSchema>;

export const WorkerMessageSchema = z.union([
	ReadyMessageSchema,
	FatalMessageSchema,
	PongSchema,
	OcrSuccessSchema,
	FailureSchema,
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export type WorkerRequest =
	| { id: string; op: "ocr"; image_b64: string }
	| { id: string; op: "ping" };

export class ProtocolError extends Error {
	override readonly name = "ProtocolError";
}

/** Parses one stdout line from the worker. Throws ProtocolError if it is not a valid message. */
export function parseWorkerLine(line: string): WorkerMessage {
	let data: unknown;
	try {
		data = JSON.parse(line);
	} catch {
		throw new ProtocolError(
			`worker wrote a line that is not JSON: ${line.slice(0, 200)}`,
		);
	}
	const parsed = WorkerMessageSchema.safeParse(data);
	if (!parsed.success) {
		throw new ProtocolError(
			`worker wrote an unexpected message: ${line.slice(0, 200)}`,
		);
	}
	return parsed.data;
}

export function encodeRequest(request: WorkerRequest): string {
	return `${JSON.stringify(request)}\n`;
}

export function ocrRequest(id: string, bytes: Uint8Array): WorkerRequest {
	return { id, op: "ocr", image_b64: Buffer.from(bytes).toString("base64") };
}

function toLine(wire: WireLine): OcrLine {
	const [a, b, c, d] = wire.box;
	const box: Quad = [
		{ x: a[0], y: a[1] },
		{ x: b[0], y: b[1] },
		{ x: c[0], y: c[1] },
		{ x: d[0], y: d[1] },
	];
	return {
		text: wire.text,
		box,
		confidence: wire.confidence,
		row: wire.row,
	};
}

/** Converts a successful worker response into core OCR lines, unchanged in content. */
export function toOcrLines(result: OcrSuccess): {
	lines: OcrLine[];
	dropped: OcrDroppedLine[];
} {
	return {
		lines: result.lines.map(toLine),
		dropped: result.dropped.map((wire) => ({
			...toLine(wire),
			reason: wire.reason,
		})),
	};
}
