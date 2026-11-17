import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CachedOcrProvider,
	type OcrResult,
	sha256Hex,
} from "@receipt-extractor/core";
import { cacheVariant } from "./create.ts";
import { DiskOcrCacheStore } from "./disk-cache.ts";
import { OpenThaiLocalProvider } from "./provider.ts";
import { image, stubCommand } from "./test/stub.ts";

const dirs: string[] = [];
const tempDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), "ocr-cache-test-"));
	dirs.push(dir);
	return dir;
};
afterAll(async () => {
	await Promise.all(
		dirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const HASH = "a".repeat(64);
const result: OcrResult = {
	lines: [{ text: "ยอดสุทธิ 64.00", box: null, confidence: 0.98, row: 0 }],
	provider: "openthai-local",
	model: "m@rev+openvino",
	duration_ms: 250,
};

describe("DiskOcrCacheStore", () => {
	test("stores and returns a result, with Thai text intact", async () => {
		const store = new DiskOcrCacheStore(await tempDir());
		const key = { variant: "openthai-local@rev+default", image_sha256: HASH };
		expect(await store.get(key)).toBeNull();
		await store.set(key, result);
		expect(await store.get(key)).toEqual(result);
	});

	test("survives a new store instance (it is on disk)", async () => {
		const dir = await tempDir();
		const key = { variant: "v", image_sha256: HASH };
		await new DiskOcrCacheStore(dir).set(key, result);
		expect(await new DiskOcrCacheStore(dir).get(key)).toEqual(result);
	});

	test("keys by image hash and by variant", async () => {
		const store = new DiskOcrCacheStore(await tempDir());
		await store.set({ variant: "rev1", image_sha256: HASH }, result);
		expect(await store.get({ variant: "rev2", image_sha256: HASH })).toBeNull();
		expect(
			await store.get({ variant: "rev1", image_sha256: "b".repeat(64) }),
		).toBeNull();
	});

	test("a corrupt or foreign file is a miss, not a result", async () => {
		const store = new DiskOcrCacheStore(await tempDir());
		const key = { variant: "v", image_sha256: HASH };
		await store.set(key, result);
		const path = store.pathFor(key);

		await writeFile(path, "{ truncated");
		expect(await store.get(key)).toBeNull();

		await writeFile(
			path,
			JSON.stringify({ format: 1, ...key, result: { lines: "no" } }),
		);
		expect(await store.get(key)).toBeNull();

		await writeFile(
			path,
			JSON.stringify({
				format: 1,
				variant: "other",
				image_sha256: HASH,
				result,
			}),
		);
		expect(await store.get(key)).toBeNull();
	});

	test("variant cannot escape the cache directory", async () => {
		const dir = await tempDir();
		const store = new DiskOcrCacheStore(dir);
		for (const variant of ["../../etc/x y", "..", ".", "a/../../b"]) {
			const path = store.pathFor({ variant, image_sha256: HASH });
			expect(dirname(dirname(path))).toBe(dir);
		}
		expect(() =>
			store.pathFor({ variant: "v", image_sha256: "../x" }),
		).toThrow();
	});

	test("leaves no temporary files behind", async () => {
		const dir = await tempDir();
		const store = new DiskOcrCacheStore(dir);
		await store.set({ variant: "v", image_sha256: HASH }, result);
		expect(await readdir(join(dir, "v"))).toEqual([`${HASH}.json`]);
	});
});

describe("disk cache in front of the worker", () => {
	test("a cached image is not sent to the worker again, even by a new process", async () => {
		const dir = await tempDir();
		const variant = cacheVariant("stubrev");
		const run = async (text: string) => {
			const local = new OpenThaiLocalProvider({ command: stubCommand() });
			const cached = new CachedOcrProvider(
				local,
				new DiskOcrCacheStore(dir),
				variant,
			);
			try {
				return { result: await cached.recognize(image(text)), pid: local.pid };
			} finally {
				await local.close();
			}
		};

		const first = await run("receipt-1");
		expect(first.result.cache_hit).toBe(false);
		expect(first.pid).toBeDefined();

		const second = await run("receipt-1");
		expect(second.result.cache_hit).toBe(true);
		expect(second.pid).toBeUndefined(); // no worker was started at all
		expect(second.result.lines).toEqual(first.result.lines);
		expect(second.result.duration_ms).toBe(first.result.duration_ms);

		const other = await run("receipt-2");
		expect(other.result.cache_hit).toBe(false);
	});

	test("a new model revision misses the cache", async () => {
		const dir = await tempDir();
		const read = async (revision: string) => {
			const local = new OpenThaiLocalProvider({
				command: stubCommand("ok", revision),
			});
			const cached = new CachedOcrProvider(
				local,
				new DiskOcrCacheStore(dir),
				cacheVariant(revision),
			);
			try {
				return await cached.recognize(image("same image"));
			} finally {
				await local.close();
			}
		};
		expect((await read("rev-a")).cache_hit).toBe(false);
		const next = await read("rev-b");
		expect(next.cache_hit).toBe(false);
		expect(next.model).toContain("rev-b");
	});

	test("the entry records what it is a result of", async () => {
		const dir = await tempDir();
		const store = new DiskOcrCacheStore(dir);
		const bytes = new TextEncoder().encode("img");
		const key = {
			variant: cacheVariant("abc123", "openvino"),
			image_sha256: await sha256Hex(bytes),
		};
		await store.set(key, result);
		const onDisk = JSON.parse(await readFile(store.pathFor(key), "utf8"));
		expect(onDisk).toMatchObject({
			format: 1,
			variant: "openthai-local@abc123+openvino",
			image_sha256: key.image_sha256,
		});
	});
});
