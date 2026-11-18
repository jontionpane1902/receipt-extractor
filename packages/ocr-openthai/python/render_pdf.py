"""Describe a PDF and render one page to a PNG for OCR. Runs locally only.

    python render_pdf.py <file.pdf> [--page 1] [--scale F | --dpi N] [--out-dir DIR] [--info]

Prints one JSON object on stdout: page count, page size, the pixel size of
the images embedded in the page, and (unless --info) the path and size of
the PNG it wrote.

Resolution. A scanned PDF is usually one image filling the page. Rendering
it larger than that image invents no detail, so by default the page is
rendered at the embedded image's own resolution ("native"); --scale
multiplies that (2 = twice the pixels per side) and --dpi sets an absolute
resolution instead. A page that is not a single full-page image is rendered
at DEFAULT_DPI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

DEFAULT_DPI = 200
POINTS_PER_INCH = 72
#: An image counts as "the page" when it covers at least this share of it.
FULL_PAGE_SHARE = 0.9


def describe_page(page) -> dict:
    import pypdfium2 as pdfium

    width_pt, height_pt = page.get_size()
    images = []
    for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE]):
        px_w, px_h = obj.get_px_size()
        left, bottom, right, top = obj.get_bounds()
        share = max(0.0, (right - left) * (top - bottom)) / (width_pt * height_pt)
        images.append({"width": px_w, "height": px_h, "page_share": round(min(share, 1.0), 3)})
    native = None
    if len(images) == 1 and images[0]["page_share"] >= FULL_PAGE_SHARE:
        # pixels per PDF point, from the tighter of the two axes
        native = min(images[0]["width"] / width_pt, images[0]["height"] / height_pt)
    return {
        "page_size_pt": [round(width_pt, 2), round(height_pt, 2)],
        "images": images,
        "native_scale": native,
        "native_dpi": None if native is None else round(native * POINTS_PER_INCH, 1),
    }


def choose_scale(native: float | None, scale: float | None, dpi: float | None) -> tuple[float, str]:
    """Pixels per PDF point, and how it was chosen."""
    if dpi is not None:
        return dpi / POINTS_PER_INCH, "dpi"
    base = native if native is not None else DEFAULT_DPI / POINTS_PER_INCH
    mode = "native" if native is not None else "default_dpi"
    if scale is not None and scale != 1:
        return base * scale, f"{mode}_x{scale:g}"
    return base, mode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--page", type=int, default=1, help="1-based page number")
    parser.add_argument("--scale", type=float, default=None, help="multiply the native resolution")
    parser.add_argument("--dpi", type=float, default=None, help="absolute resolution; overrides --scale")
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument("--info", action="store_true", help="describe only, render nothing")
    args = parser.parse_args()

    def fail(message: str) -> int:
        print(json.dumps({"ok": False, "error": message}))
        return 1

    if (args.scale is not None and args.scale <= 0) or (args.dpi is not None and args.dpi <= 0):
        return fail("--scale and --dpi must be positive")
    try:
        import pypdfium2 as pdfium

        data = args.pdf.read_bytes()
        pdf = pdfium.PdfDocument(data)
    except Exception as error:  # noqa: BLE001 - report any open failure as JSON
        return fail(f"cannot open PDF: {type(error).__name__}: {error}")

    page_count = len(pdf)
    if not 1 <= args.page <= page_count:
        return fail(f"page {args.page} does not exist: the PDF has {page_count} page(s)")
    page = pdf[args.page - 1]
    info = {"ok": True, "page_count": page_count, "page": args.page, **describe_page(page)}
    if args.info:
        print(json.dumps(info))
        return 0
    if args.out_dir is None:
        return fail("--out-dir is required to render")

    import cv2

    scale, mode = choose_scale(info["native_scale"], args.scale, args.dpi)
    bitmap = page.render(scale=scale)
    pixels = bitmap.to_numpy()
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        pixels = pixels[:, :, :3]  # pdfium renders BGRx; OpenCV wants BGR
    height, width = pixels.shape[:2]
    args.out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{hashlib.sha256(data).hexdigest()[:16]}-p{args.page}-{width}x{height}.png"
    target = args.out_dir / name
    if not cv2.imwrite(str(target), pixels):
        return fail(f"could not write {target}")
    info["render"] = {
        "png": str(target),
        "width": width,
        "height": height,
        "scale": round(scale, 4),
        "dpi": round(scale * POINTS_PER_INCH, 1),
        "mode": mode,
    }
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
