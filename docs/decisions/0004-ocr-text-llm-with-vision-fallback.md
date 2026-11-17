# 0004 — OCR + text LLM, with Claude Haiku vision as fallback

Date: 2026-11-17 · Status: accepted, to be validated by evals

## Context

Two ways to read a receipt:

- **Vision LLM directly**: send the image to a multimodal model and ask
  for JSON. Simple, but every receipt pays vision-token prices, output
  cannot be traced to evidence, and models can produce plausible numbers
  and "corrected" Thai names that are not on the paper.
- **OCR, then a text LLM**: a small OCR model reads lines with positions
  and confidence; a cheap text model only arranges them into a schema.

## Decision

1. OCR produces lines with box and confidence.
2. A cheap text LLM structures the lines into the receipt schema.
3. Deterministic checks validate the result (arithmetic, formats,
   grounding in the OCR text, OCR confidence).
4. Only if checks fail, Claude Haiku receives the original image and
   tries again; the same checks run on its output.
5. If checks still fail, the receipt is returned with `needs_review`.

## Why

- **Cost**: most receipts should need only OCR plus a small text call.
  The expensive path is paid only for hard cases.
- **Traceability**: every extracted value can be checked against OCR
  text, and each field gets a confidence from the line it came from.
- **Measurability**: the checks give a signal we can evaluate — how many
  wrong extractions they catch, and how many they miss.
- The fallback covers what OCR loses (faded print, layout, skew) because
  it sees the image itself.

## Consequences and risks

- If OCR misreads a digit consistently with the arithmetic, the checks
  pass and nothing triggers the fallback. The eval's "missed" count is
  the measure of this risk.
- The vision fallback's output is harder to ground: its values may be
  correct yet absent from flawed OCR text. Whether grounding should be
  relaxed for the fallback is undecided and must be settled with data.
- Two model calls in the worst case: latency and cost are reported per
  receipt, including p95.
- This design is a hypothesis. The comparison that justifies it — this
  pipeline versus "vision LLM only" on the same labelled set, for
  accuracy and cost — belongs in the evals and has not been run.

## Revisit if

- The fallback rate is high enough that vision-only is cheaper or more
  accurate overall.
- The checks miss too many wrong extractions on real receipts.
