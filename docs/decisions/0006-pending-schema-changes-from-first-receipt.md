# 0006 — Pending: layout-dependent schema changes

Date: 2026-11-17, updated 2026-11-18 with a second receipt · Status:
**proposed, not applied** — waiting for a current receipt

## Context

The first real receipt run through the local OCR was a third-party photo
of a 7-Eleven Thailand receipt **from 2015**. It showed several things the
provisional schema cannot represent. The layout may have changed since, so
the schema is not being changed on the evidence of one ten-year-old
receipt. This note records what was seen and what is proposed, so the
decision can be made quickly once the owner has a current receipt.

A second third-party photo, **from 2020**, was added on 2026-11-18. It
uses a visibly different layout, which confirms that waiting was right:
several rules taken from the 2015 receipt do not hold on it. See "What
the 2020 layout adds" below.

Both receipts, their OCR text and their labels are private and are not in
this repository; nothing below quotes them beyond generic label words.

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
- The printed item count is a soft signal: the check warns instead of
  failing, and quantity recovery may confirm with it but not deduce from
  it (changed after the 2020 receipt; see row 9).

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
| 9 | The item count is printed on the total row and equals total pieces including promotion rows. | ~~Keep `item_count` as pieces.~~ **Superseded by the 2020 receipt**: see B5. | — |
| 10 | Receipt number, date and time sit in the footer; the date uses a two-digit Buddhist-era year. | No schema change: the date parser already handles it. | — |

## What the 2020 layout adds

| # | Observation on the 2020 receipt | Proposed change | Open question |
| --- | --- | --- | --- |
| B1 | A **subtotal** line (label ยอดรวม) is printed after the item rows and before any discount. | Add optional `subtotal`. New check: Σ item amounts = subtotal. The existing check becomes subtotal − Σ discounts = net total. | Whether a subtotal is printed when there is no discount. |
| B2 | A **discount line** is printed **after** the subtotal, with its own quantity, and its text names the product it applies to. | Keep `discounts[]` (the arithmetic lines − discounts = total already fits), and add optional `applies_to_item` (index) plus the printed text. Link by name only when the match is unambiguous. | Discount lines may also appear directly under their item on other receipts. |
| B3 | The **net total** has its own label (ยอดสุทธิ), distinct from the subtotal. | `total` is defined as the net amount payable. No field change; document it. | — |
| B4 | **Labels differ between layouts**: Total vs ยอดสุทธิ, Cash/Change vs เงินสด/เงินทอน. | No schema change. The structuring prompt and any rule-based anchor must accept both languages, and must tolerate OCR damage to the labels: they should not be the only way to find the totals — the arithmetic is. | Other label variants. |
| B5 | The **item count** is printed as a number in parentheses on one layout and as a number followed by ชิ้น on the other. On the 2015 receipt it equals all pieces including promotion rows; on the 2020 receipt it equals neither the sum of row quantities nor the number of rows. | Keep `item_count` as "the number printed", with no stated meaning. Already applied in code: the check is a warning, and quantity recovery cannot deduce from the count. Add a per-layout counting rule only once one is established. | What the 2020 count counts (possibly priced products plus some promotion rows). Needs more receipts. |
| B6 | **Non-product zero-priced rows** now include more than promotions: rows acknowledging that no bag was taken. | Widen row 1's proposal: `kind: "product" \| "promotion" \| "notice"` (or a single `"non_product"` until the kinds matter). Non-product rows are excluded from the catalog. | Whether such rows ever carry a price (for example a bag charge). |
| B7 | Some product names start with a **one-letter prefix** of unknown meaning. | Keep the prefix in `raw_name`, never strip or interpret it. If it turns out to be a flag, add a field then. For catalog matching, treat a name with and without the prefix as different names until told otherwise. | Its meaning. |
| B8 | A **member block** follows the footer: a service phone line and loyalty points earned, used and balance. | Same rule as the coupon section (row 6), generalised: define an end-of-receipt boundary after the receipt-number/date line; nothing below it is extracted, stored or sent to an LLM. Redaction guidance must list the member block. The points balance identifies an account's activity and is personal data. | A reliable boundary detector; on a tilted, low-resolution photo OCR still reads fragments of this block. |
| B9 | Item names are **truncated** to a fixed width, while the discount line prints a **longer form** of the same product name. | No schema change. Catalog: allow an entry to hold alias names, and consider prefix-aware matching (a truncated name is a prefix of the full one) as a separate, explicit rule rather than loosening edit distance. A discount's product link must not use the same-price rule, since a discount amount is never the item price. | Whether the full name is always an extension of the truncated one. |
| B10 | Cash is printed with a real **thousands comma**; on the same receipt OCR turns some decimal points into commas. | None: the number parser already separates the two cases. | — |

### What the second receipt changed in the first list

- Row 1 (promotion rows) → widened by B6.
- Row 6 (coupon section) → generalised by B8 to "everything after the
  receipt footer".
- Row 7 (quantity always printed) → still true on the 2020 layout, but on
  that photo OCR lost the whole quantity column, including from its
  dropped lines. Keep the exemption.
- Row 9 (item count = pieces) → withdrawn, replaced by B5.

## What would settle it

One or more receipts printed this year, labelled by the owner. Each row
above is then confirmed, dropped or revised, the schema version is bumped
once, and the label format follows.

## Evidence quality

Both receipts are old, third-party, low-resolution photos; the 2020 one is
small, tilted and crumpled, and OCR lost whole rows on it. They are good
for finding what the schema cannot express and bad for measuring accuracy.
Nothing here should be read as a result.

## Not decided here

- Whether the OCR confidence threshold (0.8) should change. On the 2015
  receipt most misread Thai names had confidence between 0.8 and 0.93, so
  the check flagged nothing useful. That needs more receipts, not a schema
  change.
