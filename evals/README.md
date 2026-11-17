# Evals

Measures the pipeline against hand-labelled receipts. Every number in the
project README must come from a result file produced here.

```
evals/
  dataset/
    labels/      one <id>.json per receipt (committed)
    redacted/    redacted images referenced by labels (committed, see rules)
    originals/   unredacted photos — git-ignored, never commit
    synthetic/   invented samples that exercise the harness only
                 (images/ holds a generated picture, not a photo)
  run/           runner, metrics, CLI
  results/       one JSON file per run
```

## Running

```sh
bun run eval                        # synthetic samples, fake OCR + canned structurer
bun run eval --no-write             # print only
bun run eval --ocr openthai-local   # same samples, real local OCR on their image
```

Only the `synthetic` dataset is runnable today. By default it uses the
in-memory fake OCR provider and a structurer that returns canned output,
so it needs no model, network or API key.

`--ocr openthai-local` reads each sample's image with the real OpenThai
model (run `bun run ocr:setup` once). Samples without an image are
skipped. OCR output is cached in `.cache/ocr/` by image hash and model
revision, so repeat runs do not re-run OCR; `--no-ocr-cache` bypasses the
cache and `--ocr-backend openvino|onnxruntime` forces a backend. The
structurer is still canned, so this exercises OCR, grounding and the
checks — not extraction quality. **Synthetic numbers test the harness; they are
not accuracy results** and their result files are git-ignored. Real runs
arrive with the first real OCR provider and LLM structurer.

## Label format (`label_version: 0.1.0-provisional`)

Defined and validated by `run/label.ts` (`LabelSchema`). Provisional, like
the receipt schema it mirrors.

```jsonc
{
  "label_version": "0.1.0-provisional",
  "id": "711-0001",                  // lower-case, digits, dashes; equals the file name
  "difficulty": "easy",              // "easy" | "hard"
  "tags": ["faded", "long"],         // why it is easy or hard
  "image": "redacted/711-0001.jpg",  // relative to evals/dataset/; null for synthetic
  "notes": "optional free text",
  "expected": {
    "store_chain": "7-eleven",
    "branch": { "code": "…", "name": "…" },
    "tax_id": "0000000000000",       // 13 digits, as printed
    "receipt_number": "…",
    "datetime": "2026-08-15T14:05:00+07:00", // Gregorian ISO 8601, +07:00
    "items": [
      {
        "raw_name": "…",             // exactly as PRINTED, typos and all
        "normalized_name": null,     // catalog name it should map to, or null
        "qty": 1,
        "unit_price": 20,            // null if not printed
        "amount": 20
      }
    ],
    "discounts": [{ "raw_label": "…", "amount": 5 }],
    "total": 64,
    "vat": 4.19,                     // null if not printed
    "payment": { "method": "cash", "tendered": 100 },
    "change": 36,
    "item_count": 4                  // as printed; null if not printed
  }
}
```

Labelling rules:

- Label what is **printed**, not what you think it should say. `raw_name`
  is the paper's text; a labeller who "fixes" a name breaks the CER metric.
- `datetime` is the Gregorian date. A receipt printed in Buddhist era
  2569 is labelled 2026.
- Money is decimal baht.
- `normalized_name` is only non-null when the catalog used for the run is
  expected to contain that product.

## Redaction and privacy rules

- Never commit an unredacted receipt. Originals stay in
  `dataset/originals/` (git-ignored) or off the machine entirely.
- Before committing a redacted image, black out: member/loyalty numbers,
  phone numbers, names, card digits, QR codes and barcodes that encode a
  transaction, and anything handwritten.
- Strip EXIF metadata (location, device) from every image.
- Redact pixels, not just the label: a field blacked out in the image must
  also be absent from the label.

## Metrics

Reported for all receipts and separately for `easy` and `hard`:

| Metric | Definition |
| --- | --- |
| Field accuracy | Exact match per field, micro-averaged. Money compared in satang, text in NFC. Items aligned by position; a missing item fails all its fields. |
| Fully correct receipts | Share of receipts with every field right. |
| Raw-name CER | Edit distance ÷ reference length over item `raw_name`s, counted in **grapheme clusters** (a Thai consonant with its stacked vowel/tone mark is one unit). Lower is better. |
| Catalog match accuracy | Share of items whose `normalized_name` equals the label (null = correctly left alone). |
| Cost per receipt | USD, mean and p95, summed over all model calls for the receipt. |
| Latency per receipt | ms, p50 and p95, wall clock for the whole pipeline. |
| Fallback rate | Share of receipts sent to the vision fallback. |
| needs_review rate | Share still failing checks at the end. |
| Check effectiveness | Confusion matrix of "first-pass extraction was wrong" × "checks flagged it": caught, missed, false alarms, clean, with recall and precision. **Missed** (wrong but not flagged) is the number that matters most. |

Every result records schema version, label version, git commit, OCR
provider and model, and the model name and prompt version of each
structuring attempt.
