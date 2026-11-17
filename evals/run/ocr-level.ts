import {
	type CheckResult,
	checkChange,
	checkItemCount,
	checkLineAmounts,
	checkTotal,
	checkVat,
	DEFAULT_LOOKALIKES,
	editDistance,
	graphemes,
	groupRows,
	InMemoryCatalogStore,
	matchName,
	NO_LOOKALIKES,
	numbersIn,
	type OcrLine,
	type OcrResult,
	type OcrRow,
	parseNumberTokens,
	parseReceiptDateTime,
	type QuantityInput,
	quantityCandidatesFromDropped,
	type Receipt,
	type ResolvedQuantity,
	resolveQuantities,
	SCHEMA_VERSION,
	selectTaxIdWindow,
	similarity,
	squash,
	thaiDigitsToAscii,
	toSatang,
	validateReceipt,
} from "@receipt-extractor/core";
import type { Label } from "./label.ts";
import { uncertainItems } from "./metrics.ts";

/**
 * OCR-level eval for one labelled receipt, with NO structuring step.
 *
 * There is no LLM structurer yet, so this does not measure extraction. It
 * measures what the OCR output makes available: for each labelled field,
 * can the correct value be found in the OCR text at all, and how far are
 * the OCR item names from the printed ones.
 *
 * The label guides the lookup (item rows are aligned to label items by
 * name similarity), so these numbers are an upper bound for any text-only
 * structurer on this OCR output, not a prediction of what one would do.
 */
export interface ScalarReading {
	path: string;
	/** true = the labelled value can be read from the OCR output; null = not measurable without interpretation. */
	found: boolean | null;
	uncertain: boolean;
	detail: string;
}

export interface ItemReading {
	index: number;
	uncertain_name: boolean;
	/** OCR row aligned to this item, or null when none was similar enough. */
	row: number | null;
	expected_name: string;
	ocr_name: string | null;
	name_exact: boolean;
	cer: { edits: number; length: number };
	expected_amount: number;
	ocr_amount: number | null;
	amount_ok: boolean;
	amount_notes: string[];
	suffix: string | null;
	expected_unit_price: number | null;
	ocr_unit_price: number | null;
	expected_qty: number;
	/** Quantity with the item count as a soft signal (the default rule). */
	quantity: ResolvedQuantity;
	qty_ok: boolean;
	/** Quantity if the printed count is assumed to mean total pieces. */
	quantity_if_pieces: ResolvedQuantity;
	qty_ok_if_pieces: boolean;
	min_confidence: number | null;
	/**
	 * For an item with no kept OCR row: the most similar line among those
	 * the OCR backend dropped, if any resembles the name.
	 */
	dropped_match: { similarity: number; confidence: number | null } | null;
}

export interface CatalogReading {
	index: number;
	uncertain_name: boolean;
	ocr_name: string | null;
	price_used: number | null;
	/** "ocr": unit price or amount ÷ quantity read from OCR. "assumed_qty_1": amount read, quantity unknown. */
	price_source: "ocr" | "assumed_qty_1" | "none";
	before: { kind: string; similarity: number; correct: boolean };
	after: { kind: string; similarity: number; correct: boolean };
}

export interface OcrLevelReport {
	id: string;
	ocr: {
		model: string;
		rows: number;
		lines: number;
		dropped: number;
		duration_ms: number;
		cache_hit: boolean;
	};
	scalars: ScalarReading[];
	items: ItemReading[];
	quantity: { status: string; message: string };
	quantity_if_pieces: { status: string; message: string };
	/** Arithmetic checks run on the LABEL itself: does this layout fit the checks at all? */
	label_checks: CheckResult[];
	cer: { certain: number | null; uncertain: number | null };
	/** Checks run on a receipt assembled from the OCR readings above. */
	checks: CheckResult[];
	validation_ok: boolean;
	catalog: CatalogReading[];
}

const MIN_ALIGN_SIMILARITY = 0.3;

interface RowParts {
	row: OcrRow;
	printedQty: number | null;
	name: OcrLine | null;
	rest: OcrLine[];
}

/** Splits a row into an optional leading quantity, the name line and what follows. */
function rowParts(row: OcrRow): RowParts {
	const [first, ...others] = row.lines;
	if (
		first &&
		others.length > 0 &&
		/^[0-9]{1,2}$/.test(thaiDigitsToAscii(first.text.trim()))
	) {
		const [name, ...rest] = others;
		return {
			row,
			printedQty: Number(thaiDigitsToAscii(first.text.trim())),
			name: name ?? null,
			rest,
		};
	}
	return { row, printedQty: null, name: first ?? null, rest: others };
}

/**
 * Assigns label items to OCR rows in order (both read top to bottom),
 * maximising total name similarity. An item with no row similar enough
 * stays unassigned.
 */
export function alignItems(
	names: readonly string[],
	rows: readonly RowParts[],
): (number | null)[] {
	const n = names.length;
	const m = rows.length;
	const sim = names.map((name) =>
		rows.map((parts) =>
			parts.name
				? similarity(name, parts.name.text, { lookalikes: DEFAULT_LOOKALIKES })
				: 0,
		),
	);
	const best: number[][] = Array.from({ length: n + 1 }, () =>
		Array(m + 1).fill(0),
	);
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const s = sim[i - 1]?.[j - 1] ?? 0;
			const take =
				s >= MIN_ALIGN_SIMILARITY ? (best[i - 1]?.[j - 1] ?? 0) + s : -1;
			const row = best[i];
			if (row)
				row[j] = Math.max(best[i]?.[j - 1] ?? 0, best[i - 1]?.[j] ?? 0, take);
		}
	}
	const assigned: (number | null)[] = Array(n).fill(null);
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		const here = best[i]?.[j] ?? 0;
		const s = sim[i - 1]?.[j - 1] ?? 0;
		if (s >= MIN_ALIGN_SIMILARITY && here === (best[i - 1]?.[j - 1] ?? 0) + s) {
			assigned[i - 1] = j - 1;
			i--;
			j--;
		} else if (here === (best[i]?.[j - 1] ?? 0)) j--;
		else i--;
	}
	return assigned;
}

/**
 * Whole numbers that stand on their own: not glued to a letter or another
 * digit ("(4)" and "5 ชิ้น" count; the 4 in a misread "ผ4" or the 21 in a
 * product name does not). An item count is only looked for among these, so
 * OCR junk next to a letter cannot pass for it.
 */
export function standaloneIntegers(text: string): Set<number> {
	const ascii = thaiDigitsToAscii(text);
	const found = new Set<number>();
	for (const token of parseNumberTokens(ascii)) {
		if (token.value === null || token.decimals !== 0 || token.value < 0)
			continue;
		const before = ascii[token.start - 1] ?? " ";
		const after = ascii[token.end] ?? " ";
		if (
			/[\p{L}\p{M}\p{N}]/u.test(before) ||
			/[\p{L}\p{M}\p{N}.,:/-]/u.test(after)
		) {
			continue;
		}
		if (/[.,:/-]/.test(before)) continue;
		found.add(token.value);
	}
	return found;
}

const minConfidence = (lines: readonly OcrLine[]) => {
	const scores = lines
		.map((l) => l.confidence)
		.filter((c): c is number => c !== null);
	return scores.length ? Math.min(...scores) : null;
};

export async function evaluateOcrAgainstLabel(
	label: Label,
	ocr: OcrResult,
	now: Date,
): Promise<OcrLevelReport> {
	const { expected } = label;
	const unsure = new Set(label.uncertain);
	const unsureNames = uncertainItems(label.uncertain, "raw_name");
	const rows = groupRows(ocr.lines);
	const parts = rows.map(rowParts);
	const pageText = ocr.lines.map((line) => line.text).join("\n");
	const squashedPage = squash(ocr.lines.map((line) => line.text).join(" "));
	const amounts = numbersIn(pageText, { excludeUnitPrices: true });

	// ---- items -----------------------------------------------------------
	const assignment = alignItems(
		expected.items.map((item) => item.raw_name),
		parts,
	);
	const droppedQty = quantityCandidatesFromDropped(ocr);
	const quantityInputs: (QuantityInput | null)[] = assignment.map(
		(rowIndex) => {
			const part = rowIndex === null ? undefined : parts[rowIndex];
			if (!part) return null;
			if (part.printedQty !== null)
				return { qty: part.printedQty, source: "printed" };
			const candidate =
				part.row.row === null ? undefined : droppedQty.get(part.row.row);
			return candidate
				? {
						qty: candidate.qty,
						source: "dropped",
						confidence: candidate.confidence,
					}
				: null;
		},
	);
	const keptCounts = standaloneIntegers(pageText);
	const droppedCounts = standaloneIntegers(
		(ocr.dropped ?? []).map((line) => line.text).join("\n"),
	);
	const countSource =
		expected.item_count === null
			? null
			: keptCounts.has(expected.item_count)
				? "kept"
				: droppedCounts.has(expected.item_count)
					? "dropped"
					: null;
	const ocrItemCount = countSource === null ? null : expected.item_count;
	const resolution = resolveQuantities(quantityInputs, ocrItemCount);
	const ifPieces = resolveQuantities(quantityInputs, ocrItemCount, {
		countRule: "pieces",
	});
	const unknownQuantity: ResolvedQuantity = {
		qty: null,
		source: null,
		trust: null,
		confidence: null,
	};

	const items: ItemReading[] = expected.items.map((want, index) => {
		const rowIndex = assignment[index] ?? null;
		const part = rowIndex === null ? undefined : parts[rowIndex];
		const ocrName = part?.name?.text ?? null;
		const tokens = (part?.rest ?? []).flatMap((line) =>
			parseNumberTokens(line.text),
		);
		const amountTokens = tokens.filter(
			(t) => t.kind === "amount" && t.decimals === 2,
		);
		const amountToken = amountTokens.at(-1);
		const unitToken = tokens.find(
			(t) => t.kind === "unit_price" && t.value !== null,
		);
		const ambiguous = tokens.filter((t) => t.ambiguous !== null);
		const ocrAmount = amountToken?.value ?? null;
		const reference = graphemes(want.raw_name.normalize("NFC"));
		const quantity = resolution.quantities[index] ?? unknownQuantity;
		const quantityIfPieces = ifPieces.quantities[index] ?? unknownQuantity;
		const droppedBest = part
			? null
			: (ocr.dropped ?? [])
					.map((line) => ({
						similarity: similarity(want.raw_name, line.text, {
							lookalikes: DEFAULT_LOOKALIKES,
						}),
						confidence: line.confidence,
					}))
					.filter((candidate) => candidate.similarity >= MIN_ALIGN_SIMILARITY)
					.sort((a, b) => b.similarity - a.similarity)[0];
		return {
			index,
			uncertain_name: unsureNames.has(index),
			row: part?.row.row ?? null,
			expected_name: want.raw_name,
			ocr_name: ocrName,
			name_exact:
				ocrName !== null &&
				ocrName.normalize("NFC") === want.raw_name.normalize("NFC"),
			cer: {
				edits: editDistance(
					reference,
					graphemes((ocrName ?? "").normalize("NFC")),
				),
				length: reference.length,
			},
			expected_amount: want.amount,
			ocr_amount: ocrAmount,
			amount_ok:
				ocrAmount !== null &&
				toSatang(Math.abs(ocrAmount)) === toSatang(want.amount),
			amount_notes: [
				...(amountToken?.notes ?? []),
				...ambiguous.map((t) => `ambiguous "${t.raw}": ${t.ambiguous}`),
				...(part && !amountToken ? ["no amount token on the row"] : []),
			],
			suffix: amountToken?.suffix ?? null,
			expected_unit_price: want.unit_price,
			ocr_unit_price: unitToken?.value ?? null,
			expected_qty: want.qty,
			quantity,
			qty_ok: quantity.qty === want.qty,
			quantity_if_pieces: quantityIfPieces,
			qty_ok_if_pieces: quantityIfPieces.qty === want.qty,
			min_confidence: part ? minConfidence(part.row.lines) : null,
			dropped_match: droppedBest ?? null,
		};
	});

	// ---- scalar fields ---------------------------------------------------
	const scalars: ScalarReading[] = [];
	const scalar = (path: string, found: boolean | null, detail: string) =>
		scalars.push({ path, found, uncertain: unsure.has(path), detail });
	const textField = (path: string, value: string | null) => {
		if (value === null) return scalar(path, null, "label has no value");
		const present = squashedPage.includes(squash(value));
		scalar(
			path,
			present,
			present ? "printed text found in OCR output" : "not found as written",
		);
	};
	const amountField = (path: string, value: number | null) => {
		if (value === null) return scalar(path, null, "label has no value");
		const present = amounts.has(toSatang(value));
		scalar(
			path,
			present,
			present ? "amount found in OCR output" : "amount not found",
		);
	};

	scalar("store_chain", null, "needs interpretation; not measured on OCR text");
	textField("branch.code", expected.branch.code);
	textField("branch.name", expected.branch.name);

	if (expected.tax_id === null) scalar("tax_id", null, "label has no value");
	else {
		const runs = thaiDigitsToAscii(pageText).match(/\d{13,}/g) ?? [];
		const windows = runs.map((run) => ({
			run,
			window: selectTaxIdWindow(run),
		}));
		const hit = windows.find((w) => w.window.tax_id === expected.tax_id);
		scalar(
			"tax_id",
			hit !== undefined,
			hit
				? `${hit.window.status}: ${hit.window.message}`
				: windows.length === 0
					? "no run of 13+ digits in OCR output"
					: windows
							.map((w) => `${w.run.length} digits → ${w.window.status}`)
							.join("; "),
		);
	}

	if (expected.receipt_number === null)
		scalar("receipt_number", null, "label has no value");
	else {
		const asWritten = squashedPage.includes(squash(expected.receipt_number));
		const digits = expected.receipt_number.replace(/\D/g, "");
		const digitsOnly =
			digits.length > 0 && thaiDigitsToAscii(squashedPage).includes(digits);
		scalar(
			"receipt_number",
			asWritten,
			asWritten
				? "found as written"
				: digitsOnly
					? "digits found, but prefix/punctuation misread"
					: "not found",
		);
	}

	let datetimeRaw: string | null = null;
	if (expected.datetime === null)
		scalar("datetime", null, "label has no value");
	else {
		let detail = "no parseable date in OCR output";
		let ok = false;
		for (const row of rows) {
			const parsed = parseReceiptDateTime(row.text, now);
			if (!parsed.ok) continue;
			datetimeRaw = row.text;
			ok = parsed.iso === expected.datetime;
			detail = `parsed ${parsed.iso} (${parsed.era}${parsed.era_inferred ? ", era inferred" : ""})`;
			if (ok) break;
		}
		scalar("datetime", ok, detail);
	}

	amountField("total", expected.total);
	amountField("vat", expected.vat);
	scalar(
		"payment.method",
		null,
		"needs interpretation; not measured on OCR text",
	);
	amountField("payment.tendered", expected.payment.tendered);
	amountField("change", expected.change);
	if (expected.item_count === null)
		scalar("item_count", null, "label has no value");
	else {
		scalar(
			"item_count",
			countSource === "kept",
			countSource === "kept"
				? "count found in OCR output"
				: countSource === "dropped"
					? "only in a line the OCR backend dropped (low trust)"
					: "count not found",
		);
	}
	const discountsFound = expected.discounts.map((discount) =>
		amounts.has(toSatang(discount.amount)),
	);
	if (expected.discounts.length === 0)
		scalar("discounts", null, "label has none");
	else {
		scalar(
			"discounts",
			discountsFound.every(Boolean),
			`${discountsFound.filter(Boolean).length}/${discountsFound.length} discount amounts found in OCR output`,
		);
	}

	// ---- validation on a receipt assembled from the OCR readings ---------
	const found = (path: string) =>
		scalars.find((s) => s.path === path)?.found === true;
	const assembled: Receipt = {
		schema_version: SCHEMA_VERSION,
		store_chain: expected.store_chain,
		branch: {
			code: found("branch.code") ? expected.branch.code : null,
			name: found("branch.name") ? expected.branch.name : null,
		},
		tax_id: found("tax_id") ? expected.tax_id : null,
		receipt_number: found("receipt_number") ? expected.receipt_number : null,
		datetime_raw: datetimeRaw,
		datetime: null,
		items: items.map((item) => ({
			raw_name: item.ocr_name ?? "(no OCR row)",
			normalized_name: null,
			qty: item.quantity.qty ?? 1,
			unit_price: item.ocr_unit_price,
			amount: item.ocr_amount === null ? 0 : Math.abs(item.ocr_amount),
		})),
		discounts: expected.discounts.filter((_, i) => discountsFound[i]),
		total: found("total") ? expected.total : 0,
		vat: found("vat") ? expected.vat : null,
		payment: {
			method: expected.payment.method,
			tendered: found("payment.tendered") ? expected.payment.tendered : null,
		},
		change: found("change") ? expected.change : null,
		item_count: ocrItemCount,
		field_confidence: {},
		needs_review: false,
	};
	const validation = validateReceipt(assembled, ocr, { now });

	// ---- catalog: do the noisy OCR names reach their true names? ---------
	const store = new InMemoryCatalogStore(
		expected.items.map((item) => ({
			store_chain: expected.store_chain,
			name: item.raw_name,
			last_price: item.unit_price ?? item.amount / item.qty,
			times_seen: 1,
			status: "confirmed" as const,
		})),
	);
	const catalog: CatalogReading[] = [];
	for (const item of items) {
		// Same rule as the pipeline's normalizeItems, except that an unknown
		// quantity is taken as 1 (and flagged) so that a lost quantity column
		// does not hide what the names alone would do.
		const amount = item.ocr_amount === null ? null : Math.abs(item.ocr_amount);
		const price =
			item.ocr_unit_price ??
			(amount === null ? null : amount / (item.quantity.qty ?? 1));
		const priceSource =
			price === null
				? "none"
				: item.ocr_unit_price !== null || item.quantity.qty !== null
					? "ocr"
					: "assumed_qty_1";
		const run = async (lookalikes: typeof DEFAULT_LOOKALIKES) => {
			if (item.ocr_name === null)
				return { kind: "none", similarity: 0, correct: false };
			const match = await matchName(
				store,
				expected.store_chain,
				item.ocr_name,
				price,
				{
					lookalikes,
				},
			);
			return {
				kind: match.kind,
				// Similarity to the TRUE name, whatever was matched, so before
				// and after are comparable even when nothing matched.
				similarity: similarity(item.ocr_name, item.expected_name, {
					lookalikes,
				}),
				correct: match.normalized_name === item.expected_name,
			};
		};
		catalog.push({
			index: item.index,
			uncertain_name: item.uncertain_name,
			ocr_name: item.ocr_name,
			price_used: price,
			price_source: priceSource,
			before: await run(NO_LOOKALIKES),
			after: await run(DEFAULT_LOOKALIKES),
		});
	}

	const cer = (pick: (item: ItemReading) => boolean) => {
		const chosen = items.filter(pick);
		const length = chosen.reduce((sum, item) => sum + item.cer.length, 0);
		return length === 0
			? null
			: chosen.reduce((sum, item) => sum + item.cer.edits, 0) / length;
	};

	return {
		id: label.id,
		ocr: {
			model: ocr.model,
			rows: rows.length,
			lines: ocr.lines.length,
			dropped: ocr.dropped?.length ?? 0,
			duration_ms: ocr.duration_ms,
			cache_hit: ocr.cache_hit ?? false,
		},
		scalars,
		items,
		quantity: { status: resolution.status, message: resolution.message },
		quantity_if_pieces: { status: ifPieces.status, message: ifPieces.message },
		label_checks: labelChecks(label),
		cer: {
			certain: cer((item) => !item.uncertain_name),
			uncertain: cer((item) => item.uncertain_name),
		},
		checks: validation.checks,
		validation_ok: validation.ok,
		catalog,
	};
}

/**
 * Arithmetic checks on the label's own values. If these fail, the receipt
 * layout does not fit the check — no extraction could pass it.
 */
function labelChecks(label: Label): CheckResult[] {
	const receipt: Receipt = {
		...label.expected,
		schema_version: SCHEMA_VERSION,
		datetime_raw: null,
		field_confidence: {},
		needs_review: false,
	};
	return [
		...checkLineAmounts(receipt),
		checkTotal(receipt),
		checkVat(receipt),
		checkChange(receipt),
		checkItemCount(receipt),
		checkItemCount(receipt, "pieces"),
		checkItemCount(receipt, "lines"),
	];
}

const pct = (value: number | null) =>
	value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const mark = (ok: boolean | null) =>
	ok === null ? "  -  " : ok ? " ok  " : "WRONG";

/**
 * Terminal report. With `showText: false` no receipt text is printed (names
 * and values are replaced by positions), for output that may be shared.
 */
export function formatOcrLevelReport(
	report: OcrLevelReport,
	options: { showText?: boolean } = {},
): string {
	const show = options.showText ?? true;
	const name = (text: string | null) =>
		show ? (text ?? "(none)") : text === null ? "(none)" : "…";
	const certain = report.scalars.filter(
		(s) => !s.uncertain && s.found !== null,
	);
	const itemFields = report.items.filter((i) => !i.uncertain_name);
	const out = [
		`# OCR-level eval: ${report.id}`,
		"No structuring step exists yet: every number below is measured directly on OCR",
		"output, with the label guiding where to look. It is an upper bound for a text-only",
		"structurer on this OCR output, not an extraction result.",
		`ocr: ${report.ocr.model}, ${report.ocr.duration_ms} ms${report.ocr.cache_hit ? " (cached)" : ""}, ${report.ocr.rows} rows, ${report.ocr.lines} lines, ${report.ocr.dropped} dropped`,
		"",
		"## Header and totals: can the labelled value be read from the OCR output?",
		...report.scalars.map(
			(s) =>
				`${mark(s.found)} ${s.path.padEnd(17)}${s.uncertain ? " [uncertain label]" : ""} ${s.detail}`,
		),
		`  readable: ${certain.filter((s) => s.found).length}/${certain.length} (uncertain and unmeasured fields excluded)`,
		"",
		"## Items (label order). name CER counts grapheme clusters",
		"  #  row  name CER        name   amount  qty (source, trust)            min conf",
		...report.items.map((item) => {
			const q = item.quantity;
			return (
				`${String(item.index).padStart(3)}  ${String(item.row ?? "-").padStart(3)}  ${`${item.cer.edits}/${item.cer.length}`.padStart(5)} ${pct(item.cer.length ? item.cer.edits / item.cer.length : null).padStart(6)}  ${mark(item.name_exact)}  ${mark(item.amount_ok)}  ${mark(item.qty_ok)} ${String(q.qty ?? "?")} (${q.source ?? "unknown"}, ${q.trust ?? "-"})`.padEnd(
					78,
				) +
				`${item.min_confidence?.toFixed(3) ?? "n/a"}${item.uncertain_name ? "  [uncertain name]" : ""}${item.suffix ? `  suffix ${item.suffix}` : ""}${item.amount_notes.length ? `  {${item.amount_notes.join("; ")}}` : ""}${item.dropped_match ? `  {row dropped by the OCR filter: best dropped line sim ${item.dropped_match.similarity.toFixed(2)}, conf ${item.dropped_match.confidence?.toFixed(2) ?? "n/a"}}` : ""}${show ? `\n       printed: ${item.expected_name}\n       ocr:     ${name(item.ocr_name)}` : ""}`
			);
		}),
		`  names exact ${itemFields.filter((i) => i.name_exact).length}/${itemFields.length}, amounts ${report.items.filter((i) => i.amount_ok).length}/${report.items.length}, quantities ${report.items.filter((i) => i.qty_ok).length}/${report.items.length}`,
		`  raw-name CER: ${pct(report.cer.certain)} (certain names), ${pct(report.cer.uncertain)} (uncertain names, reported apart)`,
		`  quantity recovery (count as soft signal): ${report.quantity.status} — ${report.quantity.message}`,
		`  if the count were assumed to mean pieces:  ${report.quantity_if_pieces.status} — ${report.quantity_if_pieces.message} → quantities ${report.items.filter((i) => i.qty_ok_if_pieces).length}/${report.items.length}`,
		"",
		"## Layout fit: arithmetic checks run on the LABEL's own values",
		...report.label_checks
			.filter((c) => c.check !== "line_amount" || c.status !== "skip")
			.map(
				(c, i, all) =>
					`  ${c.status.padEnd(4)} ${c.check}${c.check === "item_count" ? ["  (default, soft)", "  (strict pieces)", "  (strict lines) "][i - (all.length - 3)] : ""}: ${c.message}`,
			),
		"",
		"## Validation checks, run on a receipt assembled from the OCR readings above",
		`  overall: ${report.validation_ok ? "ok" : "NOT ok"}`,
		...report.checks.map(
			(c) =>
				`  ${c.status.padEnd(4)} ${c.severity === "warning" ? "(warn) " : ""}${c.check}${c.path ? ` [${c.path}]` : ""}: ${show ? c.message : c.message.replace(/"[^"]*"/g, '"…"')}`,
		),
		"",
		"## Catalog: true names seeded as confirmed entries; does each OCR name reach its true name?",
		"  #   plain edit distance        with look-alike table",
		...report.catalog.map(
			(c) =>
				`${String(c.index).padStart(3)}   ${c.before.correct ? "match" : "no   "} (${c.before.kind.padEnd(5)}, sim ${c.before.similarity.toFixed(3)})   ${c.after.correct ? "match" : "no   "} (${c.after.kind.padEnd(5)}, sim ${c.after.similarity.toFixed(3)})${c.price_source === "none" ? "  no price read" : c.price_source === "assumed_qty_1" ? "  price = amount, qty unknown" : ""}${c.uncertain_name ? "  [uncertain name]" : ""}`,
		),
		`  matched: ${report.catalog.filter((c) => c.before.correct).length}/${report.catalog.length} before, ${report.catalog.filter((c) => c.after.correct).length}/${report.catalog.length} after`,
		"",
	];
	return out.join("\n");
}
