"""Download the pinned OpenThai OCR model into a git-ignored folder and verify it.

    python download_weights.py [--models-root <repo>/models]

Standard library only. Fetches the revision named in model-pin.json from the
official Hugging Face repository, checks every file against the repository's
SHA256SUMS, and writes manifest.json (repo, revision, file hashes) next to
the weights. Prints the model directory on the last line.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from openthai_ocr.weights import WeightsError, download

REPO_ROOT = Path(__file__).resolve().parents[3]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-root", type=Path, default=REPO_ROOT / "models")
    args = parser.parse_args()
    try:
        download(args.models_root, log=lambda message: print(message, file=sys.stderr))
    except WeightsError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
