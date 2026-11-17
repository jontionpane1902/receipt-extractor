import { describe, expect, test } from "bun:test";
import {
	encodeRequest,
	ocrRequest,
	ProtocolError,
	parseWorkerLine,
	toOcrLines,
} from "./protocol.ts";

const box = [
	[1, 2],
	[3, 2],
	[3, 4],
	[1, 4],
];
const okResult = {
	type: "result",
	id: "7",
	ok: true,
	lines: [{ text: "ยอดสุทธิ", confidence: 0.9984, row: 7, box }],
	dropped: [
		{ text: "x", confidence: 0.3, row: 8, box, reason: "low_confidence" },
	],
	rotation: 0,
	text_angle: 0,
	timing: { det_ms: 1.5, rec_ms: 2, total_ms: 4 },
};

describe("parseWorkerLine", () => {
	test("parses ready, fatal, pong, result and failure messages", () => {
		expect(
			parseWorkerLine(
				'{"type":"ready","protocol":1,"model":"m","revision":"r","backend":"openvino","load_ms":12.5}',
			),
		).toMatchObject({ type: "ready", revision: "r" });
		expect(parseWorkerLine('{"type":"fatal","error":"no model"}')).toEqual({
			type: "fatal",
			error: "no model",
		});
		expect(
			parseWorkerLine('{"type":"result","id":"1","ok":true,"pong":true}'),
		).toMatchObject({ pong: true });
		expect(parseWorkerLine(JSON.stringify(okResult))).toMatchObject({
			id: "7",
			ok: true,
		});
		expect(
			parseWorkerLine(
				'{"type":"result","id":null,"ok":false,"error":{"code":"bad_request","message":"invalid JSON"}}',
			),
		).toMatchObject({ ok: false, id: null });
	});

	test("rejects non-JSON output such as a stray print", () => {
		expect(() => parseWorkerLine("Loading model...")).toThrow(ProtocolError);
	});

	test("rejects lines that are JSON but not a protocol message", () => {
		expect(() => parseWorkerLine('{"type":"hello"}')).toThrow(ProtocolError);
		expect(() => parseWorkerLine("[1,2,3]")).toThrow(ProtocolError);
	});

	test("rejects a result whose lines are malformed", () => {
		const bad = (line: object) =>
			JSON.stringify({ ...okResult, lines: [line], dropped: [] });
		expect(() =>
			parseWorkerLine(bad({ text: "x", confidence: 1.2, row: 0, box })),
		).toThrow(ProtocolError);
		expect(() =>
			parseWorkerLine(
				bad({ text: "x", confidence: 1, row: 0, box: box.slice(0, 3) }),
			),
		).toThrow(ProtocolError);
		expect(() => parseWorkerLine(bad({ text: "x", row: 0, box }))).toThrow(
			ProtocolError,
		);
	});
});

describe("requests", () => {
	test("an OCR request is one line of JSON with the image as base64", () => {
		const bytes = new Uint8Array([0, 255, 16, 32]);
		const line = encodeRequest(ocrRequest("3", bytes));
		expect(line.endsWith("\n")).toBe(true);
		expect(line.trimEnd()).not.toContain("\n");
		const parsed = JSON.parse(line);
		expect(parsed).toMatchObject({ id: "3", op: "ocr" });
		expect([...Buffer.from(parsed.image_b64, "base64")]).toEqual([
			0, 255, 16, 32,
		]);
	});
});

describe("toOcrLines", () => {
	test("keeps text, confidence, row and the four corners as the runtime gave them", () => {
		const message = parseWorkerLine(JSON.stringify(okResult));
		if (message.type !== "result" || !message.ok || "pong" in message) {
			throw new Error("expected an OCR result");
		}
		const { lines, dropped } = toOcrLines(message);
		expect(lines).toEqual([
			{
				text: "ยอดสุทธิ",
				confidence: 0.9984,
				row: 7,
				box: [
					{ x: 1, y: 2 },
					{ x: 3, y: 2 },
					{ x: 3, y: 4 },
					{ x: 1, y: 4 },
				],
			},
		]);
		expect(dropped[0]).toMatchObject({ text: "x", reason: "low_confidence" });
	});
});
