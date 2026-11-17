import { z } from "zod";
import type { OcrDroppedLine, OcrLine, OcrResult } from "./types.ts";

/**
 * Runtime validation for OCR results that cross a trust boundary: a cache
 * file on disk, a subprocess, an HTTP response.
 */
const PointSchema = z.object({ x: z.number(), y: z.number() });

export const OcrLineSchema = z.object({
	text: z.string(),
	box: z.tuple([PointSchema, PointSchema, PointSchema, PointSchema]).nullable(),
	confidence: z.number().min(0).max(1).nullable(),
	row: z.number().int().nonnegative().optional(),
});

export const OcrDroppedLineSchema = OcrLineSchema.extend({
	reason: z.string(),
});

export const OcrResultSchema = z.object({
	lines: z.array(OcrLineSchema),
	provider: z.string(),
	model: z.string(),
	duration_ms: z.number().nonnegative(),
	dropped: z.array(OcrDroppedLineSchema).optional(),
	cache_hit: z.boolean().optional(),
});

/** Parses unknown data into an OcrResult, or returns null if it is not one. */
export function parseOcrResult(data: unknown): OcrResult | null {
	const parsed = OcrResultSchema.safeParse(data);
	if (!parsed.success) return null;
	const line = (l: z.infer<typeof OcrLineSchema>): OcrLine => ({
		text: l.text,
		box: l.box,
		confidence: l.confidence,
		...(l.row === undefined ? {} : { row: l.row }),
	});
	const { lines, dropped, cache_hit, ...rest } = parsed.data;
	return {
		...rest,
		lines: lines.map(line),
		...(dropped === undefined
			? {}
			: {
					dropped: dropped.map(
						(d): OcrDroppedLine => ({ ...line(d), reason: d.reason }),
					),
				}),
		...(cache_hit === undefined ? {} : { cache_hit }),
	};
}
