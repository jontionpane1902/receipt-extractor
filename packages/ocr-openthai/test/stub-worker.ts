/**
 * Stub OCR worker for unit tests: speaks the stdio protocol without Python
 * or a model. Behaviour is chosen with --mode.
 *
 * In the default mode each OCR answer is one line whose text is
 * "<pid>:<request count>:<decoded image bytes>", so a test can see which
 * process answered, how many requests it has served, and that the image
 * arrived intact.
 */
import { createInterface } from "node:readline";

const mode = process.argv.includes("--mode")
	? process.argv[process.argv.indexOf("--mode") + 1]
	: "ok";
const revision = process.argv.includes("--revision")
	? process.argv[process.argv.indexOf("--revision") + 1]
	: "stubrev";

const send = (message: unknown) =>
	process.stdout.write(`${JSON.stringify(message)}\n`);
const ready = (protocol = 1) =>
	send({
		type: "ready",
		protocol,
		model: "stub/model",
		revision,
		backend: "stub",
		load_ms: 1,
	});

process.stderr.write("stub worker starting\n");

if (mode === "fatal") {
	send({ type: "fatal", error: "WeightsError: missing file: det.onnx" });
	process.exit(1);
} else if (mode === "exit-early") {
	process.stderr.write("Traceback: cannot import cv2\n");
	process.exit(3);
} else if (mode === "never-ready") {
	setInterval(() => {}, 1000);
} else if (mode === "garbage-ready") {
	process.stdout.write("Loading model...\n");
	setInterval(() => {}, 1000);
} else if (mode === "wrong-protocol") {
	ready(99);
	setInterval(() => {}, 1000);
} else {
	ready();
	let count = 0;
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		const request = JSON.parse(line);
		if (request.op === "ping") {
			send({ type: "result", id: request.id, ok: true, pong: true });
			return;
		}
		count++;
		const text = Buffer.from(request.image_b64, "base64").toString("utf8");
		if (mode === "crash-on-ocr") {
			process.stderr.write("Segmentation fault (stub)\n");
			process.exit(139);
		} else if (mode === "hang-on-ocr") {
			return;
		} else if (mode === "garbage-on-ocr") {
			process.stdout.write("not json\n");
		} else if (mode === "wrong-id") {
			send({ type: "result", id: "nope", ok: true, pong: true });
		} else if (text === "BAD") {
			send({
				type: "result",
				id: request.id,
				ok: false,
				error: { code: "bad_image", message: "cannot decode image bytes" },
			});
		} else {
			send({
				type: "result",
				id: request.id,
				ok: true,
				lines: [
					{
						text: `${process.pid}:${count}:${text}`,
						confidence: 0.9876,
						row: 0,
						box: [
							[1.5, 2],
							[101, 2],
							[101, 30.5],
							[1.5, 30.5],
						],
					},
					{
						text: "35.00",
						confidence: 1,
						row: 0,
						box: [
							[200, 2],
							[260, 2],
							[260, 30],
							[200, 30],
						],
					},
				],
				dropped: [
					{
						text: "~~",
						confidence: 0.41,
						row: 1,
						box: [
							[0, 40],
							[9, 40],
							[9, 50],
							[0, 50],
						],
						reason: "low_confidence",
					},
				],
				rotation: 0,
				text_angle: 0,
				timing: { det_ms: 1, rec_ms: 1, total_ms: 2 },
			});
		}
	});
	lines.on("close", () => process.exit(0));
}
