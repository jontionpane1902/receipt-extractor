# 0006 — Pending: layout-dependent schema changes

Date: 2026-11-17 · Status: **proposed, not applied** — waiting for a
current receipt

## Context

The first real receipt run through the local OCR was a third-party photo
of a 7-Eleven Thailand receipt **from 2015**. It showed several things the
provisional schema cannot represent. The layout may have changed since, so
the schema is not being changed on the evidence of one ten-year-old
receipt. This note records what was seen and what is proposed, so the
decision can be made quickly once the owner has a current receipt.

The receipt itself, its OCR text and its label are private and are not in
this repository; nothing below quotes it.

## Already done (not layout-dependent)

These were safe to do now because they describe how OCR reads thermal
print, not how a receipt is laid out:

- Receipt-aware number parsing: decimal comma, stray space after the
  point, suffix flags, `@unit-price`, ambiguity flagged
  (`validate/numbers.ts`).
- Quantities recovered from the OCR backend's dropped one-character lines
  and reconciled with the printed item count (`structure/quantity.ts`).
- Tax ID selected by check digit when OCR glues an extra digit on
  (`selectTaxIdWindow`).
- Look-alike character costs in catalog similarity.
- Labels can mark fields the labeller could not read (`uncertain`).

## Proposed, waiting for a current receipt

| # | Observation on the 2015 receipt | Proposed change | Why it waits |
| --- | --- | --- | --- |
| 1 | Promotions and privileges are printed as ordinary item rows with a zero amount, and they count toward the printed item count. | Add `kind: "product" \| "promotion"` to items. Promotion rows keep their quantity (so the item count still adds up) but are excluded from the catalog. | Promotion mechanics change often; need to see how they print today, and whether discounts now appear as separate negative lines. |
| 2 | Some amounts carry a short suffix flag (one flag on a priced item, another on zero-priced rows). | Add `tax_flag: string \| null` to items, holding the suffix as printed. Do not interpret it yet. | The meaning of each flag is a guess from one receipt (possibly "not subject to VAT"). Needs confirmation. |
| 3 | No VAT amount is printed, only a statement that VAT is included. | Keep `vat` nullable; when present, compute the expected VAT from items without a non-VAT flag instead of from the total. | Depends on 2. Current receipts may print a VAT breakdown. |
| 4 | The header has a POS terminal serial and a short VAT branch code. The footer has a second numeric identifier next to the receipt number. | Add optional `pos_id`; decide whether the other identifiers are worth storing. | Not needed by any check today; do not add fields nobody reads. |
| 5 | The document title distinguishes a receipt from an abbreviated tax invoice. | Add optional `document_type`. | Only useful if more than one type shows up in the dataset. |
| 6 | Below a printed cut line is a third-party promotional coupon with a redeemable code. | Add an explicit rule: structuring stops at the cut line; nothing below it is extracted, stored or sent to an LLM. Add a check that fails if an extracted value is grounded only below the cut line. | Needs a reliable cut-line detector; one example is not enough to design it. |
| 7 | Quantity is printed at the start of every item row, including 1. Unit price is printed only for some multi-quantity rows, as `@price`. | Once confirmed, drop the "quantity 1 need not be grounded" exemption in favour of grounding against kept or dropped lines. | The exemption is harmless; removing it on one receipt risks false failures. |
| 8 | The receipt number is printed with a prefix that OCR misreads on both the synthetic image and the real one. | Store the number without the prefix and ground it on digits only. | Small, but changes the label format; batch it with the changes above. |
| 9 | The item count is printed on the total row and equals total pieces including promotion rows. | Keep `item_count` as pieces; document that promotion rows are included. | Depends on 1. |
| 10 | Receipt number, date and time sit in the footer; the date uses a two-digit Buddhist-era year. | No schema change: the date parser already handles it. | — |

## What would settle it

One or more receipts printed this year, labelled by the owner. Each row
above is then confirmed, dropped or revised, the schema version is bumped
once, and the label format follows.

## Not decided here

- Whether the OCR confidence threshold (0.8) should change. On the 2015
  receipt most misread Thai names had confidence between 0.8 and 0.93, so
  the check flagged nothing useful. That needs more receipts, not a schema
  change.
