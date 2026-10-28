#!/usr/bin/env python3
"""Pre-warm Book page rasters into render-cache.

Renders pages of a Book into disk cache at specified widths and formats (WebP/PNG)
so that client requests result in instant static cache hits without request-time lock delays.
"""

import argparse
import sys
import time
from pathlib import Path

# Ensure repository root is in sys.path
REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from ui.raster import prewarm_book_rasters, _pdfium


def main():
    parser = argparse.ArgumentParser(description="Pre-warm raster cache for books.")
    parser.add_argument(
        "--dataset",
        "-d",
        default="tarhe-kolli",
        help="Dataset name (e.g., tarhe-kolli, 70143-336)",
    )
    parser.add_argument(
        "--books-dir",
        default=str(REPO_ROOT / "books"),
        help="Directory containing the book PDFs",
    )
    parser.add_argument(
        "--cache-dir",
        default=str(REPO_ROOT / "render-cache"),
        help="Directory to write rendered page rasters",
    )
    parser.add_argument(
        "--pages",
        "-p",
        nargs="+",
        type=int,
        help="Specific page numbers to pre-warm (default: all pages)",
    )
    parser.add_argument(
        "--widths",
        "-w",
        nargs="+",
        type=int,
        default=[480, 800, 1200],
        help="Widths to render (default: 480 800 1200)",
    )
    parser.add_argument(
        "--formats",
        "-f",
        nargs="+",
        default=["webp", "png"],
        help="Image formats to generate (default: webp png)",
    )

    args = parser.parse_args()

    if _pdfium is None:
        print("[!] Error: pypdfium2 is not installed in this environment.", file=sys.stderr)
        sys.exit(1)

    books_dir = Path(args.books_dir)
    cache_dir = Path(args.cache_dir)
    pdf_path = books_dir / f"{args.dataset}.pdf"

    if not pdf_path.exists():
        print(f"[!] Error: Book PDF not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[*] Pre-warming raster cache for '{args.dataset}'...")
    print(f"    Source:  {pdf_path}")
    print(f"    Cache:   {cache_dir}")
    print(f"    Widths:  {args.widths}")
    print(f"    Formats: {args.formats}")
    if args.pages:
        print(f"    Pages:   {len(args.pages)} specified pages")
    else:
        print("    Pages:   All pages in document")

    t0 = time.time()

    def on_progress(done, total, label):
        pct = (done / total) * 100
        print(f"\r[{pct:5.1f}%] Rendered {done}/{total} ({label})", end="", flush=True)

    try:
        stats = prewarm_book_rasters(
            dataset=args.dataset,
            books_dir=books_dir,
            cache_dir=cache_dir,
            pages=args.pages,
            widths=args.widths,
            formats=args.formats,
            progress_cb=on_progress,
        )
        print()
        dt = time.time() - t0
        mb = stats["total_bytes"] / (1024 * 1024)
        print(
            f"[OK] Finished in {dt:.2f}s: {stats['total_rendered']} images generated "
            f"({mb:.2f} MB total in {cache_dir})"
        )
    except Exception as exc:
        print(f"\n[!] Pre-warming failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
