# 0003 — Product catalog learned from receipts, not scraped

Date: 2026-11-17 · Status: accepted

## Context

OCR misreads item names. A list of known product names lets us map a
misread name to the right product. That list could be scraped from the
retailer's website or apps, or built up from the receipts we process.

## Decision

Learn the catalog **only from receipts**. No scraping.

- One row per observed name, keyed by store chain + name, with last
  price, times seen and status `unconfirmed` / `confirmed`.
- Receipt items keep both `raw_name` (as read, never overwritten) and
  `normalized_name` (catalog name, or null).
- A name is normalised toward a catalog entry only if the entry is
  confirmed **or** frequently seen, **and** has the same unit price,
  **and** is highly similar by grapheme clusters.
- Entries seen once or twice are never correction targets: they may be
  OCR errors themselves.
- If two entries are equally good, no match is made.
- The LLM is not allowed to "fix" names; the grounding check rejects
  names that are not in the OCR text.

## Why not scrape

- Receipt names are abbreviated POS names, not the marketing names on a
  website, so a scraped list would match poorly anyway.
- Scraping raises terms-of-service and maintenance problems that a public
  portfolio repository should not carry.
- A learned catalog can be evaluated honestly: it only knows what the
  pipeline itself has seen.

## Consequences

- Cold start: with few receipts, almost nothing is normalised. That is
  the intended behaviour — an empty `normalized_name` is better than a
  wrong one.
- A frequent, consistent OCR error could become a "frequently seen"
  entry. The same-price rule and the `confirmed` status limit this; the
  eval's catalog match accuracy will show whether it is a real problem.
- Price changes temporarily block fuzzy matches for a product until the
  new price is observed on an exactly-read name.

## Revisit if

- Catalog match accuracy stays low after enough receipts, or wrong
  normalisations appear in evals.
