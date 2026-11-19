# 0006 — Pending: layout-dependent schema changes

Date: 2026-11-17, updated 2026-11-18 with a second and a third receipt · Status:
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

A third photo, **from 2014**, uses the same old layout as the 2015 one and
agrees with it, including on the item count. Its label is provisional (not
yet confirmed by the owner).

Every receipt used so far, including the later ones described further
down, was a third-party image found in a public post, used only locally
and never committed. Their OCR text and labels are private and are not in
this repository; nothing below quotes them beyond generic label words.
Publishable eval data will come from receipts the owner has the right to
share.

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
- Amount suffixes are a configurable set (N, NP, V), and a suffix letter
  that OCR read as a trailing zero is repaired and flagged.
- A unit price printed as `@price` whose marker OCR lost or misread is
  recovered only when quantity × price = amount proves it.
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

## Pending: counting rule by layout (proposed, not implemented)

Three receipts now give two behaviours for the printed item count:

| Layout | Seen on | Totals row looks like | Count means |
| --- | --- | --- | --- |
| Old | 2014, 2015 | English label `Total`, count in parentheses, then the amount | Sum of all row quantities, zero-priced rows included (holds on both) |
| New | 2020 | Thai label ยอดสุทธิ, count followed by ชิ้น, then the amount | Unknown: neither the pieces nor the rows |

Proposal: detect the layout from evidence that is independent of the item
rows, then choose the counting rule.

1. `detectLayout(ocr)` returns `"old" | "new" | "unknown"` with the
   evidence it used. Signals, each a vote:
   - totals label: `Total` vs ยอดสุทธิ (fuzzy, since OCR damages labels);
   - count format: `(n)` vs `n ชิ้น`;
   - payment label: `Cash/Change` vs เงินสด/เงินทอน;
   - presence of a separate subtotal row (ยอดรวม).
2. `"old"` requires at least two agreeing signals and none for `"new"`;
   anything else is `"unknown"`.
3. Only `"old"` passes `countRule: "pieces"` to quantity recovery and the
   strict `"pieces"` mode to the item-count check. `"new"` and `"unknown"`
   keep the soft signal that is the default today.
4. The detected layout and its evidence are stored with the result, so an
   eval can report accuracy per layout.

Why it is not implemented yet:

- Two receipts are thin evidence for "old = pieces", and one of the two
  labels is provisional.
- On the 2014 photo OCR dropped the count itself and every quantity, and on
  the 2020 photo the totals label survived only in a dropped line. The
  detector must work from partial, damaged signals; it needs more than
  three examples to tune and test.
- A wrong "old" verdict would bring back exactly the over-confidence the
  soft signal removed. The rule must fail towards `"unknown"`.

What it would buy, measured on the 2015 receipt: quantities readable go
from 5 of 10 to 10 of 10 when the count is allowed to fill the gaps.

## Pending: end-of-receipt boundary (proposed, not implemented)

Everything a receipt needs ends with the receipt-number/date row and the
customer-service phone row. What follows differs every time and must never
be extracted: a third-party coupon with a code (2015), a lucky-draw block
with a code, terms and another phone number (2014), a member points block
(2020).

Rules tried on the cached OCR output of all three receipts:

| Rule | 2014 | 2015 | 2020 | Verdict |
| --- | --- | --- | --- | --- |
| Cut after the **first** row containing a phone-like pattern (digits-4 digits-4 digits) | Cuts exactly the lucky-draw block | Cuts exactly the coupon block | Cuts exactly the member block | Clean on all three |
| Cut after the receipt-number/date row | Would also drop the service phone row (harmless) | Same | **Fails**: OCR garbled the date and time, so the row is not recognised and nothing is cut | Not reliable alone |
| Cut at a detected cut line | The dotted line is not in the OCR output as a line; a short run of Thai digit one characters appears near it | A similar run appears only among dropped lines | No cut line on this layout | Not usable |

Proposal: cut after the first phone-like row **that comes after the
payment row**, and drop both kept and dropped OCR lines below it. Fall
back to the receipt-number/date row when no phone row is found; if neither
is found, mark the receipt `needs_review` rather than extract from an
unbounded page.

Why it is only a proposal:

- It rests on one OCR line surviving. If the first phone row is lost, a
  later phone number inside the block to be removed (the 2014 lucky-draw
  terms have one) becomes the cut and part of that block leaks. The
  payment-row anchor and the fallback reduce this but are untested.
- Three receipts, all from one chain. A receipt with a phone number in the
  header would break "first phone-like row" without the payment anchor.
- It belongs with the layout detector above: both read the same landmark
  rows, and should be built and tested together on more receipts.

Until it exists, the grounding check can be satisfied by text from these
blocks: small whole numbers there (terms numbered 1 to 3, a rights count,
a points figure) can ground a quantity or an item count by accident.

## More new-layout facts (second 2020 receipt)

A second new-layout receipt (December 2020, owner-verified label, photo
and scan) adds:

| # | Observation | Proposed change | Status |
| --- | --- | --- | --- |
| D1 | Paid by **e-wallet**: a payment-method row with the amount, then a row holding a long transaction identifier. | `payment.method` already has `wallet`. Add an optional printed method name. The transaction identifier is an e-wallet identifier: never extract it, and mask it in any output. | Pending |
| D2 | **No cash and no change rows.** | The cash − total = change check is not applicable and must report `skip`, as it does today; for non-cash payment the equivalent check is payment amount = total. | Check to add, pending |
| D3 | **No subtotal row** when there is no discount. | `subtotal` (B1) must be optional; its check skips when absent. | Folded into B1 |
| D4 | **Multi-digit quantities** (10 and above) on zero-priced right rows. | None: two-digit quantities survive OCR as ordinary lines, unlike single digits. Quantity is not capped at one digit. | Already handled |
| D5 | Multi-quantity priced rows print **`@unit price`** before the amount, as on the old layout. OCR never read the `@`: it was lost, read as a letter, or read as a digit glued to the price. | Done in code: the token is accepted as the unit price only when the quantity is known, above 1, and quantity × token = amount (one leading character may be removed). | Implemented; see limits below |
| D6 | An extra **service line** sits between the member service phone row and the member block. | The end-of-receipt boundary still holds (cut after the first phone-like row), and this line falls below it. | Supports the boundary proposal |
| D7 | The **member block contains a person's name**, as well as points earned, used and balance. | Strengthens B8: the block is personal data, not just loyalty figures. It must be cut before any text reaches an LLM, a log, a label or a cache that leaves the machine. | Pending with the boundary |

Limit of D5 on this receipt: on both captures the quantity digit of the two
`@` rows was lost, so the rule had no quantity to prove anything with and
correctly did nothing. Accepting "amount ÷ token is a whole number of 2 or
more" would have recovered both the unit price and the quantity on all
four rows, but it infers the quantity instead of confirming it and is not
implemented.

## Trust levels for quantity and unit price

Implemented in `packages/core/structure`. A quantity or unit price always
carries where it came from, and a lower level never overwrites a higher
one.

| Quantity source | Meaning | Trust |
| --- | --- | --- |
| `printed` | Read as a normal OCR line at the start of the row | Highest |
| `dropped` | Recovered from a one-character line the OCR backend filtered out | Low until confirmed |
| `deduced` | Filled in from the printed item count, only for a layout whose counting rule is established | Low; not used by default |
| `inferred` | Deduced from the row's own two amounts: line amount ÷ unit price is a whole number from 2 to 99 | Low; never confirmed by anything independent |
| unknown | Nothing on the row says | — |

| Unit price source | Meaning |
| --- | --- |
| `read` | Printed with its `@` and read as such |
| `confirmed` | Marker lost or misread, but a known quantity × price = amount proves it |
| `inferred` | Obtained together with an inferred quantity |

Rules for the inferred path:

- It applies only to an item row with exactly two amounts and a positive
  line amount. Totals, payment and discount rows are excluded by role: a
  negative amount, a printed piece count beside the amounts, or a row
  opening that resembles a totals, payment or discount label (matched
  fuzzily, because OCR damages labels). A product whose name resembles a
  label is treated as a non-item, which only stops the rule from firing.
- Candidates are the price as read and the price with one leading
  character removed (the misread `@`). If both give a valid but different
  answer the row is flagged **ambiguous** and nothing changes. This is
  common when the marker is lost entirely: a price of 24.00 against 48.00
  is 2 × 24.00, and also 12 × 4.00 if the leading 2 was the marker.
- If the inferred quantity disagrees with a printed or recovered one, the
  latter stays and a **conflict** is raised.
- A row with one amount and no quantity is **not** assumed to be
  quantity 1. That remains unknown.
- The printed item count is not used to change any of this.
- The catalog's same-price rule receives the inferred unit price, marked
  as inferred.

Measured on eight labelled captures: 4 rows inferred, all agreeing with
the label; 1 row flagged ambiguous; no row inferred outside the item
rows. Four positives is far too few to call the rule validated.

## Untested hypothesis: what the new-layout item count counts

From two new-layout receipts only. **Not implemented; the count stays a
soft signal.**

> Printed count = sum of quantities on all rows **except** rows that grant
> a right (name starting with สิทธิ์), free-offer rows, and message rows
> (such as a thank-you line).

| Receipt | Printed count | All pieces | Priced pieces | Hypothesis gives | Fits? |
| --- | --- | --- | --- | --- | --- |
| 2020, first | 5 | 8 | 3 | 5 | Yes, with assumptions |
| 2020, second | 9 | 33 | 9 | 9 | Yes |

On the second receipt the hypothesis and the simpler "pieces on priced
rows only" give the same answer, so that receipt cannot tell them apart.
The first receipt is what separates them (priced pieces alone give 3, not
5), and there the fit depends on things the label marks as uncertain:

- two zero-priced rows that are neither a right nor a thank-you message (a
  redemption row and a no-bag row) must each count as one item;
- their names and quantities were not verified by the owner;
- the discount line, printed with its own quantity, must not count.

So the evidence is one receipt that fits either rule and one that fits
only this rule under unverified readings. What would falsify it:

- a new-layout receipt where a row starting with สิทธิ์, a free-offer row
  or a message row is plainly included in the count;
- a receipt where a zero-priced row of another kind is excluded;
- the owner correcting the uncertain rows of the first 2020 receipt so
  that the sum is no longer 5.

What would support it: any new-layout receipt with a zero-priced row that
is none of the three excluded kinds, with a verified label. If it holds,
it needs the row kinds of row 1/B6 (`product`, `promotion`, `notice`) to
be implemented first, since the rule is defined on them.

## Other chains (out of scope for now)

A receipt from another chain (a third-party image, as a photo and as a
cropped scan) was run as a trial. **7-Eleven remains the only target;
nothing below is planned.** It is recorded because it shows which parts of
the current design are 7-Eleven-specific.

What that layout needs that the 7-Eleven layouts do not:

| # | That chain's layout | What it would need | Status today |
| --- | --- | --- | --- |
| C1 | No quantity column on item rows | Quantity defaults to 1 only when the layout says so; nothing to recover from dropped digits | Not handled; the 7-Eleven quantity logic does not apply |
| C2 | A multi-quantity item is a name row followed by a separate row holding quantity, `@`, unit price and amount | Join the two rows into one item | Not handled |
| C3 | Weighed items, marked per kilogram in the name | A weight/unit field, or accept them as quantity 1 | Not handled |
| C4 | A cancelled-items section: a heading, the item again with a negative amount, then the item re-entered with a "price change" row | Line types for void and re-entry; the arithmetic is Σ amounts including the negatives | Arithmetic closes if every amount row is summed with its sign; no schema for it |
| C5 | Every amount carries a one-letter suffix (two letters seen), not only some | Suffix set per chain | Suffix set is configurable; the common letter was never read correctly by OCR on either capture |
| C6 | Date printed with a Gregorian two-digit year | Era by chain or layout | The date parser's "closest non-future reading" rule already chose correctly |
| C7 | Document title printed at the bottom, in English | Do not rely on the title's position | Nothing depends on it |
| C8 | The header carries a store phone number | The proposed footer rule "cut after the first phone-like row" would cut the whole receipt | Another reason that rule needs the payment-row anchor before it is built |
| C9 | No printed item count; totals labels differ again | Layout detection would return "unknown" | Soft count default is the right behaviour |

Two findings from this trial changed shared code, because they are about
OCR on thermal print rather than about a layout: a suffix letter read as a
trailing zero is now repaired and flagged, and ten look-alike character
pairs were added to the catalog table.

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
