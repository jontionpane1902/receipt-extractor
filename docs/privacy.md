# Privacy note

## What a receipt can reveal

A convenience-store receipt can contain a loyalty/member number, a phone
number, part of a card number, a name (on tax invoices), the branch, and
the exact time of a purchase. Together these can identify a person and
their habits. This project treats every receipt image as personal data.

## What is in this repository

- Code, documentation, labels and **redacted** images only.
- No unredacted receipts, no secrets, no model weights. `.gitignore`
  blocks `.env*`, `.dev.vars`, weight files and `originals/` /
  `unredacted/` folders, and CI runs a secret scan on every push.
- Invented synthetic samples in `evals/dataset/synthetic/`. They are not
  real receipts: the store name, tax ID and product names in them are
  made up, and any resemblance to real ones is unintended. The tax ID is
  a fictional number with a correct check digit. Real receipts of the
  target chain print the operator's public corporate tax ID; that number
  is deliberately not reproduced anywhere in this repository.

## Redaction before anything is committed

1. Black out member numbers, phone numbers, names, card digits,
   handwriting, and QR codes/barcodes that encode a transaction.
2. Strip EXIF metadata (location, device).
3. Make sure the label does not contain anything that was blacked out.

The planned web app will do redaction in the browser, before upload.

## Third parties that receive data

Nothing is sent anywhere today — the current code makes no network calls.
When the corresponding stages are built:

| Recipient | Receives | When |
| --- | --- | --- |
| iApp Technology (hosted OCR API) | The receipt image | Cloud deployments. Not when OCR runs locally from the open weights. |
| Anthropic (Claude Haiku) | The receipt image and OCR text | Only for receipts that fail validation (vision fallback). |
| Text LLM provider (not chosen yet) | OCR text, not the image | Every receipt. |
| Cloudflare (R2, D1, Queues) | Stored images and extracted data | Cloud deployments. |

Each provider's retention and training policies must be checked and linked
here before that stage ships. This table must be updated whenever a
recipient is added or changed.
