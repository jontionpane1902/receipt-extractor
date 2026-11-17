# 0001 — API on a Cloudflare Worker, OCR outside it

Date: 2026-11-17 · Status: accepted

## Context

The API will run on Cloudflare (ElysiaJS on Workers, R2, D1 + Drizzle,
Queues). The OCR model's official runtime is Python with
OpenVINO/onnxruntime, OpenCV and pyclipper. A Worker is a V8 isolate: it
cannot run Python packages with native extensions or native ONNX Runtime,
and has tight CPU-time and bundle-size limits. A Cloudflare Container can
run the official Python runtime unchanged, but adds an image to build,
cold starts, and a second thing to operate and pay for.

## Decision

- The API, validation, catalog and orchestration run in a **Worker**.
  `packages/core` is kept runtime-agnostic so it runs there unchanged.
- **OCR does not run inside the Worker.** The Worker calls an
  `OcrProvider`; in the cloud that is the hosted iApp API (see 0002).
- A **container** running the open weights is an optional later
  milestone, added as one more `OcrProvider` implementation.
- Slow work (OCR, LLM calls) goes through **Queues**, so request handlers
  stay short.

## Consequences

- Cheapest and simplest deployment for a portfolio project: no servers.
- The first cloud version depends on a third-party OCR API (cost,
  availability, images leave our infrastructure).
- Elysia's Cloudflare adapter is experimental (`CloudflareAdapter`,
  `.compile()`, no `.listen()`); the API layer must stay thin so it can
  be swapped for another router without touching `core`.

## Revisit if

- Hosted OCR cost or latency dominates the eval numbers.
- Images must not leave our own infrastructure.
- Workers gain a practical way to run the model (see the WASM option in
  the OCR runtime proposal).
