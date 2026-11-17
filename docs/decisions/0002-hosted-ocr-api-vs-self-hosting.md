# 0002 — Hosted OCR API in the cloud, open weights locally

Date: 2026-11-17 · Status: accepted, with an open question

## Context

`iapp/OpenThai2.0-OCR-Text` is open (Apache-2.0, two ONNX files of about
4 MB together, CPU-only, Thai + English, printed text). The same model is
offered as a hosted API by iApp (`POST /v3/store/ocr/document/ocr`,
`apikey` header).

- Evals must be free to run and reproducible, and must not send eval
  images to a third party.
- The cloud deployment is a Worker and cannot run the model (see 0001).

## Decision

- **Locally (evals, development): the open weights**, run on the
  developer's machine. Weights are downloaded, never committed.
- **In the cloud: the hosted iApp API.**
- **Self-hosting in a Cloudflare Container** is optional and later.
- All three sit behind the single `OcrProvider` interface. No other code
  may know which one is in use.

## Consequences

- Evals cost nothing in OCR fees and can be re-run by anyone with the
  weights.
- Local and cloud results may differ (pre-processing, model version). The
  eval runner records the provider and model with every result so the two
  can be compared directly once both exist.
- Cloud images go to iApp; documented in the README and privacy note.

## Open question — the hosted API may not return what the pipeline needs

Checked against iApp's documentation on 2026-11-17:

- `/v3/store/ocr/document/ocr` returns **plain text, one string per
  page** (`{ "text": ["…"], "time": …, "iapp": { "page", "char" } }`).
  **No per-line boxes and no confidence.**
- `/v3/store/ocr/document/layout` returns components with text, bounding
  box and type, at about three times the price per page. Whether it
  returns a confidence value was not stated on the page read.
- The open-weights runtime does return, per line, `text`, `confidence`
  and a four-point `box`.

So the cloud path as originally planned cannot feed the OCR-confidence
check. Because of this, `OcrLine.box` and `OcrLine.confidence` are
nullable and the confidence check reports `skip` (unknown) when they are
missing. Options to decide before the API milestone:

1. Use `/layout` and confirm what it returns with a real call.
2. Use `/ocr`, split text into lines, and run without the confidence
   check in the cloud (measure what that costs in missed errors).
3. Bring the container forward so cloud and local use the same runtime.

## Revisit if

- A real API call shows `/layout` gives line boxes and confidence (then
  option 1 is straightforward), or shows it does not (then 2 or 3).
