# @receipt-extractor/ocr-openthai

Local OCR provider: runs the open
[`iapp/OpenThai2.0-OCR-Text`](https://huggingface.co/iapp/OpenThai2.0-OCR-Text)
model (Apache-2.0) on your machine through its **official Python runtime**,
behind the `OcrProvider` interface from `@receipt-extractor/core`.

```
OpenThaiLocalProvider ── JSON lines over stdio ──► python/worker.py
   (TypeScript)             one process per run        └─ official runtime/line_engine.py
```

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.11 or newer.

```sh
bun run ocr:setup
```

This one command:

1. creates a virtual environment in `python/.venv` (nothing is installed
   outside the repository),
2. installs the hash-locked dependencies from `python/requirements.txt`,
3. downloads the model revision pinned in `python/model-pin.json` into
   `<repo>/models/` and verifies every file against the model repository's
   `SHA256SUMS`.

`models/`, `.venv/` and the OCR cache are git-ignored. Weights are never
committed.

## Use

```ts
import { createLocalOpenThaiOcr } from "@receipt-extractor/ocr-openthai";

const ocr = createLocalOpenThaiOcr(); // cached; starts Python only when needed
try {
	const result = await ocr.provider.recognize({ bytes, mime_type: "image/jpeg" });
	// result.lines: [{ text, confidence, row, box: [4 points] }]
	// result.model: "iapp/OpenThai2.0-OCR-Text@<revision>+openvino"
} finally {
	await ocr.close(); // stops the worker process
}
```

- The model loads on the first image and stays loaded until `close()`.
- Lines, boxes, confidences and rows are passed through exactly as the
  runtime returns them. The runtime's own filter removes low-confidence
  lines (below 0.8 in the shipped `config.json`); those are reported in
  `result.dropped` with a reason.
- `OpenThaiLocalProvider` is the same thing without the cache.

## Command line

```sh
bun run ocr <image-path>            # rows in reading order, confidence, dropped lines
bun run ocr <image-path> --json     # full result as JSON, including boxes
bun run ocr <image-path> --no-cache --backend onnxruntime
```

Parts of one printed row (an item name and its price) are shown on one
line, each with its own confidence. The lines the model's own filter
removed are listed at the end with their confidence and the reason. The
image is read locally and the output goes to the terminal only.

## Tests

```sh
bun test packages/ocr-openthai     # unit tests: stub process, no Python
bun run test:ocr                   # opt-in: real model on a generated image
python3 -m unittest discover -s packages/ocr-openthai/python/tests -t packages/ocr-openthai/python
```

The integration test is skipped unless `OPENTHAI_INTEGRATION=1` (which
`bun run test:ocr` sets). Its image is generated from invented text by
`tools/make-synthetic-receipt.ts`; no real receipt is used.

## Cache

`.cache/ocr/<provider>@<revision>+<backend>/<image sha256>.json`. Keyed by
the image bytes, the model revision and the backend, so a new model never
serves old text. A hit starts no Python process. The cache contains the
text of whatever was read: for real receipts, treat it as private. Delete
the folder to clear it.

## Protocol (v1)

One JSON object per line. Defined in `python/openthai_ocr/protocol.py` and
`protocol.ts`; the two must change together.

```jsonc
// worker → client, once, after the model is loaded
{"type":"ready","protocol":1,"model":"iapp/OpenThai2.0-OCR-Text","revision":"<sha>","backend":"openvino","load_ms":285.7}
// client → worker
{"id":"1","op":"ocr","image_b64":"<base64 image bytes>"}
// worker → client
{"type":"result","id":"1","ok":true,"lines":[{"text":"…","confidence":0.97,"row":0,"box":[[x,y],[x,y],[x,y],[x,y]]}],"dropped":[],"rotation":0,"text_angle":0.0,"timing":{"det_ms":150,"rec_ms":70,"total_ms":222}}
{"type":"result","id":"1","ok":false,"error":{"code":"bad_image","message":"…"}}
```

Boxes are in input-image pixels: top-left, top-right, bottom-right,
bottom-left. stdout carries only protocol lines; anything else the worker
or its libraries print goes to stderr and is attached to error messages.

## Python layout

| File | Role |
| --- | --- |
| `python/model-pin.json` | Repository, revision, hash of `SHA256SUMS`, files to fetch |
| `python/openthai_ocr/weights.py` | Download, verify, manifest (standard library only) |
| `python/openthai_ocr/engine.py` | Loads the official `LineOCR` once; bytes in, dict out |
| `python/openthai_ocr/protocol.py` | Request dict → response dict; transport-agnostic |
| `python/worker.py` | stdio transport (thin) |
| `python/download_weights.py` | Download entry point (thin) |

For the container milestone, an HTTP server calls `protocol.handle` with
the same engine; nothing else changes.

## Updating the model

Change `revision` and `sha256sums_sha256` in `python/model-pin.json` (the
SHA-256 of the new revision's `SHA256SUMS` file), run `bun run ocr:setup`
and `bun run test:ocr`, and commit the pin on its own. Cached results from
the old revision are not reused.
