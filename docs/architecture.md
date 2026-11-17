# Architecture

## Pipeline

```
image
  │
  ▼
OcrProvider.recognize ──► OcrResult { lines: [{ text, box, confidence }] }
  │
  ▼
Structurer.structure (cheap text LLM) ──► Receipt (provisional schema)
  │
  ▼
code post-processing: resolve Buddhist-era date, catalog name matching,
per-field confidence from OCR lines
  │
  ▼
validateReceipt ──► ValidationReport { ok, checks[], failures[] }
  │
  ├─ ok ───────────────────────────────► result
  │
  └─ not ok ─► fallback Structurer (Claude Haiku + original image)
                 │
                 ▼
               validateReceipt
                 ├─ ok ──────────────────► result
                 └─ not ok ──────────────► result with needs_review = true
```

The LLM is deliberately given the smallest job: arranging text that OCR
already read. Everything that can be decided by code is decided by code —
date conversion, arithmetic, name normalisation — because code is free,
deterministic and testable.

## Packages

`packages/core` is runtime-agnostic: no Cloudflare, Elysia or filesystem
imports, no network, no clock (callers inject `now`). It can run in a
Worker, in Bun and in tests unchanged.

| Module | Responsibility | State today |
| --- | --- | --- |
| `schema` | Receipt shape (zod), schema version, `toSatang`. | Provisional |
| `ocr` | `OcrProvider` interface, `OcrLine`/`Quad` types, `FakeOcrProvider`. | Interface + fake |
| `structure` | `Structurer` interface and usage/cost metadata. | Types only |
| `validate` | Checks returning structured results; `validateReceipt`. | Implemented |
| `catalog` | Grapheme similarity, `CatalogStore`, matching rules. | Implemented, in-memory store |

`evals` holds the label schema, metrics, a minimal pipeline orchestration
and the runner. The orchestration will move into `core` when real
structurers exist.

## OCR boundary

```ts
interface OcrProvider {
  readonly name: string;
  recognize(image: OcrImage): Promise<OcrResult>;
}
```

- `box` is a four-point quad in image pixels (top-left, top-right,
  bottom-right, bottom-left), matching the OpenThai 2.0 runtime.
- `box` and `confidence` are nullable: a backend that cannot provide them
  must say so rather than invent values. Checks treat missing confidence
  as unknown (skip), never as confident.

- `row` is the reading-order row when the backend reports one. The
  OpenThai runtime splits a line at wide gaps, so an item name and its
  price arrive as two lines on the same row; `ocrText` joins them back.
- `dropped` carries lines the backend read but filtered out itself.

Implementations: fake (tests), local OpenThai weights (evals, see below),
iApp hosted API (cloud, planned), optional container (planned). See
decisions 0001, 0002 and 0005.

### Local OpenThai provider

```
OpenThaiLocalProvider (TypeScript)          packages/ocr-openthai
   │  JSON lines over stdio, one process per run
   ▼
worker.py → protocol.py → engine.py → official runtime/line_engine.py
                                        (det.onnx + rec.onnx, OpenVINO)
```

- The Python side adds no OCR logic: it loads the official `LineOCR` once
  and passes its lines through. Thresholds come from the model's own
  `config.json`.
- The model revision is pinned; files are verified against the repository's
  `SHA256SUMS` on download and again at every worker start. The revision
  and backend are part of `OcrResult.model`, and so of every eval result.
- `CachedOcrProvider` + `DiskOcrCacheStore` cache results by image SHA-256,
  model revision and backend. A hit starts no Python at all.

## Validation checks

| Check | Rule | Severity |
| --- | --- | --- |
| `line_amount` | qty × unit price = line amount | error |
| `total_sum` | Σ line amounts − Σ discounts = total | error |
| `vat` | VAT = total × 7/107, ±1 satang | error |
| `change` | tendered − total = change | error |
| `item_count` | printed count = extracted pieces or lines | warning (error only when a layout's counting rule is set explicitly) |
| `date_parse` | date parses; Buddhist era converted | error |
| `date_not_future` | not later than now (+10 min skew) | error |
| `tax_id_format` | exactly 13 digits | error |
| `tax_id_checksum` | mod-11 check digit | warning |
| `grounding` | each extracted number/name appears in OCR text | error |
| `ocr_confidence` | lines feeding key fields ≥ threshold | error |

A check that cannot run (e.g. no VAT printed) returns `skip`, not `pass`.
Any `error` failure makes the report not ok, which triggers the fallback.

Known limits, all provisional until real receipts are seen:

- VAT assumes every item is VATable.
- The printed item count is a soft signal. Two real receipts disagree on
  what it counts (all pieces including promotion rows on one; neither
  pieces nor lines on the other), so by default a disagreement is a
  warning, and quantity recovery may use the count to confirm quantities
  but never to deduce missing ones. Strict modes exist for a layout whose
  rule has been established.
- Two-digit years are ambiguous between Buddhist and Gregorian; the
  reading closest to now and not in the future wins, and is marked as
  inferred.
- Thai month names in dates are not parsed yet.
- Grounding is necessary, not sufficient: a value can appear in the text
  and still be assigned to the wrong field.
- The confidence threshold (0.8) is a placeholder to calibrate in evals.
  With the local OpenThai provider it currently cannot fire: the model's
  shipped `config.json` already drops every line below 0.8 confidence
  (`drop_below`), so such lines never reach `lines` — they appear in
  `dropped` instead. Whether to raise our threshold, lower the runtime's,
  or treat dropped lines as a signal is open.

## Catalog

A table of names observed on receipts, keyed by store chain + name, with
last price, times seen and status. Matching order:

1. Exact name (after NFC, whitespace and case normalisation).
2. Fuzzy, only toward an entry that is confirmed **or** seen at least 5
   times (never fewer than 3, whatever the configuration), **and** has
   the same unit price, **and** has grapheme-cluster similarity ≥ 0.85.
3. Two candidates tie → no match.

Similarity for step 2 uses a small **look-alike table**: characters that
thermal print makes OCR confuse cost 0.25 of an edit instead of 1 when
they are swapped inside an otherwise identical cluster.

| Group | Why |
| --- | --- |
| ข / ช | differ by the notch on the head |
| พ / ฟ / ห | differ by the tail or middle stroke |
| ด / ต | differ by the notch on the head |
| ื / ี | upper vowels one small stroke apart |

The table only changes how similar two names look. The trust floor, the
same-price rule and the tie rule are unchanged, and `matchName` accepts
`lookalikes: NO_LOOKALIKES` to switch it off. Add a group only with
evidence from real OCR output.

`raw_name` is never changed. A wrong correction is treated as worse than
no correction. See decision 0003.

Why grapheme clusters: Thai stacks vowels and tone marks on consonants.
"น้ำ" is three code points but one unit to a reader. Counting code points
would make one misread stacked character look like several errors.
