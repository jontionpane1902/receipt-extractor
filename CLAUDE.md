# receipt-extractor

Thai convenience-store receipt extractor (7-Eleven Thailand first). Public
portfolio repository: the point is **measured, evaluated** AI engineering.
Any accuracy, cost or latency claim must come from `evals/results/`.

## Pipeline (agreed design)

```
image → OCR (lines + box + confidence)
      → cheap text LLM structures lines into the receipt schema
      → validation checks
      → checks fail? Claude Haiku with the original image (vision fallback)
      → still failing? needs_review
```

- **OCR** sits behind `OcrProvider` (`packages/core/ocr`): image in, lines
  with quad box and confidence out. Implementations are swappable: fake
  (tests/evals), local `iapp/OpenThai2.0-OCR-Text` weights (evals), iApp
  Document OCR API (cloud), Cloudflare Container (optional, later).
  Nothing outside an implementation may depend on a specific backend.
- **Validation** (`packages/core/validate`): arithmetic (qty × unit price =
  amount; lines − discounts = total; VAT = total × 7/107; cash − total =
  change; printed item count = extracted count), format (date parses,
  Buddhist era converted, not in future; 13-digit tax ID), grounding
  (every extracted number/name appears in raw OCR text), OCR confidence on
  lines feeding key fields. Every check returns a structured
  pass/fail/skip result with a reason.
- **Item names**: store `raw_name` and `normalized_name`; never overwrite
  raw. The LLM must not "fix" names — grounding enforces this.
- **Catalog** (`packages/core/catalog`): learned from receipts only, no
  scraping. Keyed by store chain + name, with last price, times seen and
  status `unconfirmed`/`confirmed`. Normalise only toward confirmed or
  frequently seen entries with the same price and high similarity. Never
  auto-correct toward entries seen once or twice. Thai similarity compares
  grapheme clusters, not code points.
- **Evals** (`evals/`): hand-labelled, redacted receipts tagged easy/hard.
  Report per-field accuracy, raw-name CER, catalog match accuracy, cost and
  latency per receipt, fallback rate, and how well checks catch wrong
  extractions. Store prompt version and model name with every result.

The receipt schema is **provisional** until the owner confirms the real
7-Eleven layout from physical receipts. Bump `SCHEMA_VERSION` when it
changes.

## Structure

```
packages/core/{schema,ocr,structure,validate,catalog}   runtime-agnostic
packages/ocr-openthai   local OCR provider: TS client + python/ worker
apps/api     Elysia on Cloudflare Workers   (not built yet)
apps/web     upload + client-side redaction (not built yet)
evals/{dataset,run,results}
docs/        architecture.md, privacy.md, decisions/
```

Rules for `packages/core`:

- No Cloudflare, Elysia, Node-only or Bun-only imports. It must run in
  Workers, Bun and tests unchanged.
- No network calls and no storage of its own: storage only through
  interfaces (`CatalogStore`, later others).
- No clock or randomness inside logic: inject `now`.
- Tests live next to the code they cover (`foo.ts` → `foo.test.ts`).
- Money is decimal baht in the schema; compare via `toSatang`.

Local OCR (`packages/ocr-openthai`):

- `OpenThaiLocalProvider` runs the model repository's **official** Python
  runtime in one long-lived subprocess (JSON lines over stdio, model
  loaded once). Do not re-implement OCR logic in TypeScript or Python:
  `python/openthai_ocr/engine.py` only wraps the official `LineOCR`.
- `python/` layers: `weights.py` (download/verify) → `engine.py` →
  `protocol.py` (request dict → response dict) → `worker.py` (stdio). An
  HTTP wrapper for the container milestone must reuse `protocol.handle`.
  `protocol.ts` and `protocol.py` must change together.
- The model revision is pinned in `python/model-pin.json`. Weights live in
  `models/` (git-ignored), are verified against the repo's `SHA256SUMS`,
  and are re-verified at every worker start. To move to a new revision,
  update the pin (revision + hash of `SHA256SUMS`) in its own commit.
- Python dependencies are hash-locked in `python/requirements.txt` and
  installed only into `python/.venv`. Never install Python packages
  globally. Re-lock with the command at the top of `requirements.in`.
- OCR output is cached in `.cache/ocr/` (git-ignored), keyed by image
  SHA-256 + model revision + backend. Treat the cache as private data.
- Unit tests use a stub process (`test/stub-worker.ts`) and must not need
  Python. The real model runs only in `integration.test.ts`, opt-in.

Later stack (not built yet): ElysiaJS on Cloudflare Workers (the adapter
is experimental: needs `CloudflareAdapter` and `.compile()`, no
`.listen()`), R2 for images, D1 + Drizzle for data, Cloudflare Queues for
async jobs.

## Commands

```sh
bun install
bun test                 # all unit tests
bun run lint             # biome check
bun run format           # biome check --write
bun run typecheck        # tsc --noEmit
bun run check            # lint + typecheck + test
bun run eval             # eval runner on synthetic samples (no network)

bun run ocr:setup        # once: python/.venv + pinned deps + verified weights (needs uv)
bun run test:ocr         # opt-in: real OpenThai model on the synthetic image
bun run ocr <image> [--json] [--no-cache]   # OCR one image locally, print rows + confidence + dropped
bun run eval --ocr openthai-local   # synthetic eval with the real local OCR
```

`bun test`, CI and the default `bun run eval` must stay offline: no
Python, no weights, no network. Real-model tests are opt-in only.

Run `bun run check` before every commit.

## Conventions

- **Conventional Commits**: `type(scope): summary` — imperative, under
  ~70 characters. Types: `feat`, `fix`, `refactor`, `test`, `docs`,
  `chore`, `perf`, `eval`. Scopes: `core`, `api`, `web`, `evals`,
  `catalog`, `ocr`. One logical change per commit; the body explains why.
- Feature branches + PRs. When a change affects accuracy or cost, put the
  eval numbers (before/after) in the PR description.
- Elysia, Bun, Drizzle, the AI SDK and OpenThai move fast: check current
  official docs before relying on remembered APIs or version numbers.

## Privacy and safety — hard rules

- Never commit unredacted receipts, secrets, or model weights.
  `.gitignore` blocks `.env*`, `.dev.vars`, `*.onnx`, `models/`,
  `.cache/` and `originals/`/`unredacted/` folders; do not work around it.
- Private images (real or third-party receipts) go only in a git-ignored
  folder: `evals/dataset/private/` or any `private/` folder. Never commit
  them, text extracted from them, or `bun run ocr` output; never paste
  that text into tests, fixtures, docs or commit messages; never send
  them to an external API.
- Test images must be generated (see
  `packages/ocr-openthai/tools/make-synthetic-receipt.ts`), never real
  receipts.
- Do not call paid APIs, write API keys into files, or deploy without the
  owner asking for it.
- Third parties that receive images (iApp, Anthropic) must stay documented
  in `README.md` and `docs/privacy.md`. Update both when that changes.
- Synthetic eval results are not accuracy numbers. Never put them in the
  README results table.
