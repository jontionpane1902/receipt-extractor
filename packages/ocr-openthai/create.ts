import { CachedOcrProvider, type OcrProvider } from "@receipt-extractor/core";
import { DiskOcrCacheStore } from "./disk-cache.ts";
import {
	DEFAULT_CACHE_DIR,
	pinnedModelDir,
	readModelManifest,
} from "./paths.ts";
import {
	OPENTHAI_LOCAL_PROVIDER,
	type OpenThaiLocalOptions,
	OpenThaiLocalProvider,
} from "./provider.ts";

export interface LocalOpenThaiOcr {
	/** Cached provider: an image already read with this model costs no OCR. */
	provider: OcrProvider;
	/** The uncached provider underneath. */
	local: OpenThaiLocalProvider;
	modelRevision: string;
	cacheVariant: string;
	/** Stops the worker process. Always call it. */
	close(): Promise<void>;
}

/** Cache variant: provider, model revision and requested backend. */
export function cacheVariant(revision: string, backend?: string): string {
	return `${OPENTHAI_LOCAL_PROVIDER}@${revision}+${backend ?? "default"}`;
}

/**
 * The local OpenThai provider behind the disk cache, the way evals use it.
 *
 * The model revision comes from the manifest written by the download
 * script, so a cache hit needs no Python process at all; the worker is
 * started only for an image that has not been read with this revision, and
 * must then report the same revision.
 */
export function createLocalOpenThaiOcr(
	options: Omit<OpenThaiLocalOptions, "expectedRevision" | "command"> & {
		cacheDir?: string;
	} = {},
): LocalOpenThaiOcr {
	const { cacheDir = DEFAULT_CACHE_DIR, ...providerOptions } = options;
	const modelDir = providerOptions.modelDir ?? pinnedModelDir();
	const manifest = readModelManifest(modelDir);
	const local = new OpenThaiLocalProvider({
		...providerOptions,
		modelDir,
		expectedRevision: manifest.revision,
	});
	const variant = cacheVariant(manifest.revision, providerOptions.backend);
	return {
		provider: new CachedOcrProvider(
			local,
			new DiskOcrCacheStore(cacheDir),
			variant,
		),
		local,
		modelRevision: manifest.revision,
		cacheVariant: variant,
		close: () => local.close(),
	};
}
