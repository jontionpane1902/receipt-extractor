# Decisions

Short records of choices that are costly to reverse. One file per
decision: context, decision, consequences, and what would make us revisit
it. Add a new numbered file rather than rewriting an old one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-worker-vs-container.md) | API on a Cloudflare Worker; OCR not in the Worker | Accepted |
| [0002](0002-hosted-ocr-api-vs-self-hosting.md) | Hosted iApp OCR API in the cloud, open weights locally | Accepted, with an open question |
| [0003](0003-learned-catalog-vs-scraped-catalog.md) | Product catalog learned from receipts, not scraped | Accepted |
| [0004](0004-ocr-text-llm-with-vision-fallback.md) | OCR + text LLM, Claude Haiku vision as fallback | Accepted, to be validated by evals |
| [0005](0005-local-ocr-python-subprocess.md) | Local OCR runs the official Python runtime in a subprocess | Accepted |
| [0006](0006-pending-schema-changes-from-first-receipt.md) | Layout-dependent schema changes seen on two old receipts (2015, 2020) | Proposed, waiting for a current receipt |
