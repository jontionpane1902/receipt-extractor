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

## What stays on your machine

- Model weights (`models/`) and the Python environment
  (`packages/ocr-openthai/python/.venv`): git-ignored.
- The OCR cache (`.cache/ocr/`): git-ignored. It stores the text read from
  each image, keyed by the image's hash. For a real receipt that text is
  personal data; delete the folder to remove it.
- The only test image in the repository is generated from invented text
  (`evals/dataset/synthetic/images/`), not photographed.

## Private receipts used during development

While building the OCR and parsing code, the local OCR was run on a few
real receipts stored only on the author's machine, in a git-ignored
folder. All of them were third-party images found in public posts. For
those:

- the images, any image rendered from them, their OCR text and their
  labels were never committed, and the repository history has been
  searched for their item names, branch names and codes, identifiers,
  phone numbers and file names;
- OCR ran with the local model only; the images were not sent to any API;
- tests and documentation use invented names and numbers. What was learned
  is recorded in general terms in `docs/decisions/0006`.

They will not be published. A public eval set will come only from
receipts the author has the right to share, redacted as described below.

## Redaction before anything is committed

1. Black out member numbers, phone numbers, names, card digits,
   handwriting, and QR codes/barcodes that encode a transaction.
2. Strip EXIF metadata (location, device).
3. Make sure the label does not contain anything that was blacked out.

The planned web app will do redaction in the browser, before upload.

## Third parties that receive data

Nothing is sent anywhere today. Local OCR runs entirely on your machine;
the only network access is downloading the public model files from Hugging
Face during setup (no image or text is uploaded).
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
