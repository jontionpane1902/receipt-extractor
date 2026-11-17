# 0005 — Local OCR runs the official Python runtime in a subprocess

Date: 2026-11-17 · Status: accepted

## Context

Evals need the open `iapp/OpenThai2.0-OCR-Text` weights to run from a
TypeScript project. Most of the model's behaviour is outside the two ONNX
graphs: the official `runtime/line_engine.py` (about 1,000 lines) does box
post-processing with OpenCV and pyclipper, perspective crops, background
flattening, CTC decoding, orientation, deskew, reading order and a
confidence filter. Options were a Python subprocess, a local HTTP service,
or re-implementing all of that on onnxruntime in JavaScript.

## Decision

Run the **official runtime unchanged** in a **long-lived Python
subprocess**, speaking JSON lines over stdio.

- The model loads once per run; each image is one request line and one
  response line.
- Python code is layered (`weights` → `engine` → `protocol` → `worker`),
  with the request handler independent of the transport, so an HTTP
  wrapper for the container milestone reuses it.
- Python lives in a project-local virtual environment with hash-locked
  dependencies. Nothing is installed globally.
- The model revision is pinned by commit hash; files are verified against
  the repository's `SHA256SUMS` (whose own hash is pinned) on download and
  at every worker start.
- OCR output is cached on disk by image hash, model revision and backend.

## Why

- Eval numbers describe the real model, not a port of it. A JavaScript
  re-implementation could drift silently and lower accuracy with no error.
- Small to build and to keep in step with upstream: a new model revision
  is a pin change, not a rewrite.

## Consequences

- Local OCR needs Python 3.11+ and `uv`. CI and the default test run do
  not: they use the fake provider and a stub process.
- The worker executes Python code downloaded from the model repository
  (`runtime/*.py`). It is pinned by revision and checksum, but it is
  third-party code running on the developer's machine.
- Results can differ slightly between backends (OpenVINO vs ONNX Runtime:
  same text, different confidence in the 3rd–4th decimal on the test
  image), so the backend is recorded with every result and is part of the
  cache key.
- Not usable inside a Worker; the cloud path is still decision 0002.

## Revisit if

- OCR must run inside a Worker (then a JS/WASM port, validated against
  this provider on the labelled set).
- The container milestone starts: wrap `protocol.handle` in HTTP.
