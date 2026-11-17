import { afterEach, describe, expect, test } from "bun:test";
import { OpenThaiLocalProvider } from "./provider.ts";
import { image, stubCommand } from "./test/stub.ts";
import { OcrRequestError, WorkerClient, WorkerError } from "./worker-client.ts";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((item) => item.close()));
});

function provider(mode = "ok", extra: object = {}) {
	const created = new OpenThaiLocalProvider({
		command: stubCommand(mode),
		startupTimeoutMs: 5000,
		requestTimeoutMs: 5000,
		...extra,
	});
	open.push(created);
	return created;
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("OpenThaiLocalProvider with a stub worker", () => {
	test("returns the worker's lines with box, confidence and row", async () => {
		const result = await provider().recognize(image("hello"));
		expect(result.provider).toBe("openthai-local");
		expect(result.model).toBe("stub/model@stubrev+stub");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
		expect(result.lines).toHaveLength(2);
		expect(result.lines[0]).toMatchObject({
			confidence: 0.9876,
			row: 0,
			box: [
				{ x: 1.5, y: 2 },
				{ x: 101, y: 2 },
				{ x: 101, y: 30.5 },
				{ x: 1.5, y: 30.5 },
			],
		});
		expect(result.lines[0]?.text.endsWith(":1:hello")).toBe(true);
		expect(result.dropped).toMatchObject([
			{ text: "~~", confidence: 0.41, reason: "low_confidence" },
		]);
	});

	test("sends image bytes intact, including non-text bytes", async () => {
		const client = new WorkerClient({ command: stubCommand() });
		open.push(client);
		const bytes = new TextEncoder().encode("ใบเสร็จ\n\t€");
		const result = await client.ocr(bytes);
		expect(result.lines[0]?.text.endsWith(":1:ใบเสร็จ\n\t€")).toBe(true);
	});

	test("one process serves every image: the model loads once per run", async () => {
		const ocr = provider();
		const first = await ocr.recognize(image("a"));
		const second = await ocr.recognize(image("b"));
		const third = await ocr.recognize(image("c"));
		const [pid1, n1] = first.lines[0]?.text.split(":") ?? [];
		const [pid2, n2] = second.lines[0]?.text.split(":") ?? [];
		const [pid3, n3] = third.lines[0]?.text.split(":") ?? [];
		expect(pid1).toBe(String(ocr.pid));
		expect([pid2, pid3]).toEqual([pid1, pid1]);
		expect([n1, n2, n3]).toEqual(["1", "2", "3"]);
	});

	test("concurrent requests are answered in order by id", async () => {
		const ocr = provider();
		const results = await Promise.all(
			["x", "y", "z"].map((text) => ocr.recognize(image(text))),
		);
		expect(results.map((r) => r.lines[0]?.text.split(":")[2])).toEqual([
			"x",
			"y",
			"z",
		]);
	});

	test("does not start a process until it is needed", () => {
		expect(provider().pid).toBeUndefined();
	});

	test("close() ends the worker process", async () => {
		const ocr = provider();
		await ocr.recognize(image("a"));
		const pid = ocr.pid;
		if (pid === undefined) throw new Error("no worker pid");
		expect(alive(pid)).toBe(true);
		await ocr.close();
		expect(alive(pid)).toBe(false);
		expect(ocr.pid).toBeUndefined();
	});

	test("a rejected image is an OcrRequestError and the worker stays up", async () => {
		const ocr = provider();
		await ocr.recognize(image("a"));
		const pid = ocr.pid;
		const error = await ocr.recognize(image("BAD")).catch((e) => e);
		expect(error).toBeInstanceOf(OcrRequestError);
		expect(error.code).toBe("bad_image");
		const after = await ocr.recognize(image("b"));
		expect(ocr.pid).toBe(pid);
		expect(after.lines[0]?.text.endsWith(":b")).toBe(true);
	});

	test("checks the model revision the worker actually loaded", async () => {
		const ok = provider("ok", { expectedRevision: "stubrev" });
		expect((await ok.start()).revision).toBe("stubrev");
		const wrong = provider("ok", { expectedRevision: "other" });
		await expect(wrong.recognize(image("a"))).rejects.toThrow(
			/revision stubrev, expected other/,
		);
	});
});

describe("worker failures", () => {
	test("startup failure reported by the worker", async () => {
		await expect(provider("fatal").recognize(image("a"))).rejects.toThrow(
			/failed to start: WeightsError: missing file: det.onnx/,
		);
	});

	test("worker exits before it is ready: error carries its stderr", async () => {
		const error = await provider("exit-early")
			.recognize(image("a"))
			.catch((e) => e);
		expect(error).toBeInstanceOf(WorkerError);
		expect(error.message).toContain("exited unexpectedly (code 3)");
		expect(error.message).toContain("cannot import cv2");
	});

	test("program does not exist", async () => {
		const missing = new OpenThaiLocalProvider({
			command: ["/nonexistent/python-for-test"],
		});
		open.push(missing);
		await expect(missing.recognize(image("a"))).rejects.toThrow(
			/could not start OCR worker/,
		);
	});

	test("startup timeout kills the worker", async () => {
		const ocr = provider("never-ready", { startupTimeoutMs: 300 });
		await expect(ocr.recognize(image("a"))).rejects.toThrow(
			/not ready after 300 ms/,
		);
	});

	test("non-protocol output on stdout is an error, not silently skipped", async () => {
		await expect(
			provider("garbage-ready").recognize(image("a")),
		).rejects.toThrow(/not JSON: Loading model/);
	});

	test("protocol version mismatch", async () => {
		await expect(
			provider("wrong-protocol").recognize(image("a")),
		).rejects.toThrow(/speaks protocol 99/);
	});

	test("crash during a request rejects it, and the next image starts a new worker", async () => {
		const ocr = provider("crash-on-ocr");
		const error = await ocr.recognize(image("a")).catch((e) => e);
		expect(error).toBeInstanceOf(WorkerError);
		expect(error.message).toContain("exited unexpectedly");
		expect(error.message).toContain("Segmentation fault (stub)");
		expect(ocr.pid).toBeUndefined();
		await expect(ocr.recognize(image("b"))).rejects.toThrow(WorkerError);
	});

	test("request timeout", async () => {
		const ocr = provider("hang-on-ocr", { requestTimeoutMs: 300 });
		await expect(ocr.recognize(image("a"))).rejects.toThrow(
			/did not answer within 300 ms/,
		);
	});

	test("garbage or an unknown id in a response fails every request in flight", async () => {
		await expect(
			provider("garbage-on-ocr").recognize(image("a")),
		).rejects.toThrow(/not JSON/);
		await expect(provider("wrong-id").recognize(image("a"))).rejects.toThrow(
			/unknown request id/,
		);
	});

	test("a closed client refuses new work", async () => {
		const client = new WorkerClient({ command: stubCommand() });
		await client.ping();
		await client.close();
		await expect(client.ping()).rejects.toThrow(/closed/);
	});
});
