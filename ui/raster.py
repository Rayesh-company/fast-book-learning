"""The Book page visual pipeline: server-side PDFium rasters (ADR-0007, ADR-0017).

Encapsulates PDFium page rasterization, open document caching, multi-format
compression (WebP with PNG fallback), and disk-backed cache management behind
a unified interface.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional, Tuple

try:
    import pypdfium2 as _pdfium
except ImportError:
    _pdfium = None

# PDFium is not provably thread-safe across documents; renders are serialized.
RENDER_LOCK = threading.Lock()

# Reused open PdfDocument handles (LRU).
PDF_DOCS_CACHE: dict[str, object] = {}
PDF_DOCS_CACHE_CAP = 2

# Supported raster formats and their MIME types.
SUPPORTED_FORMATS = {
    "png": "image/png",
    "webp": "image/webp",
}


def clamp_width(width: int) -> int:
    """Clamp and bucket width to bound cache proliferation."""
    return min(2400, max(480, round(width / 160) * 160))


def _pdf_doc_handle(source: Path, cache: Optional[dict] = None, cap: Optional[int] = None):
    """Retrieve or open a reused PdfDocument handle under RENDER_LOCK."""
    if _pdfium is None:
        return None
    target_cache = PDF_DOCS_CACHE if cache is None else cache
    target_cap = PDF_DOCS_CACHE_CAP if cap is None else cap

    key = str(source.resolve())
    pdf = target_cache.get(key)
    if pdf is not None:
        target_cache[key] = target_cache.pop(key)
        return pdf
    while len(target_cache) >= target_cap:
        oldest = next(iter(target_cache))
        try:
            target_cache.pop(oldest).close()
        except Exception:
            pass
    pdf = _pdfium.PdfDocument(str(source))
    target_cache[key] = pdf
    return pdf


def prune_render_cache(
    cache_dir: Path,
    cap_bytes: int = 3 << 30,
) -> int:
    """Prune oldest raster files when the directory size exceeds the ceiling."""
    pruned_count = 0
    try:
        entries = list(cache_dir.glob("*.png")) + list(cache_dir.glob("*.webp"))
        total = sum(e.stat().st_size for e in entries)
        if total <= cap_bytes:
            return 0
        entries.sort(key=lambda e: e.stat().st_mtime)
        for entry in entries:
            if total <= cap_bytes:
                break
            try:
                size = entry.stat().st_size
                entry.unlink(missing_ok=True)
                total -= size
                pruned_count += 1
            except OSError:
                continue
    except OSError:
        pass
    return pruned_count


def get_page_raster(
    dataset: str,
    page_number: int,
    width: int = 1200,
    fmt: str = "webp",
    books_dir: Optional[Path] = None,
    cache_dir: Optional[Path] = None,
    cache_cap: int = 3 << 30,
    pdf_cache: Optional[dict] = None,
    pdf_cap: Optional[int] = None,
) -> Optional[Tuple[bytes, str]]:
    """Return (image_bytes, mime_type) for the requested Book page.

    Format may be 'webp' or 'png'.
    Renders are cached on disk. Thread-safe and concurrency-checked.
    """
    if _pdfium is None:
        return None

    norm_fmt = fmt.lower().strip(".")
    if norm_fmt not in SUPPORTED_FORMATS:
        norm_fmt = "png"
    mime_type = SUPPORTED_FORMATS[norm_fmt]

    if page_number < 1:
        return None

    bucketed_width = clamp_width(width)

    if books_dir is None:
        books_dir = Path(os.environ.get("SESSION_BOOKS_DIR", "/books"))
    if cache_dir is None:
        cache_dir = Path(
            os.environ.get(
                "SESSION_RENDER_CACHE", str(books_dir.parent / "render-cache")
            )
        )

    cache_key = f"{dataset}-p{page_number}-w{bucketed_width}.{norm_fmt}"
    cache_file = cache_dir / cache_key
    started = time.monotonic()

    # Fast path: disk cache hit before acquiring the lock
    try:
        body = cache_file.read_bytes()
        sys.stderr.write(
            f"render {dataset} p{page_number} w{bucketed_width} {norm_fmt}"
            f" hit {time.monotonic() - started:.3f}s\n"
        )
        return body, mime_type
    except OSError:
        pass

    source = books_dir / f"{dataset}.pdf"
    if not source.exists():
        return None

    cache_dir.mkdir(parents=True, exist_ok=True)

    with RENDER_LOCK:
        # Double check cache under lock (another thread may have rendered it)
        try:
            body = cache_file.read_bytes()
            sys.stderr.write(
                f"render {dataset} p{page_number} w{bucketed_width} {norm_fmt}"
                f" hit {time.monotonic() - started:.3f}s\n"
            )
            return body, mime_type
        except OSError:
            pass

        try:
            pdf = _pdf_doc_handle(source, cache=pdf_cache, cap=pdf_cap)
            if pdf is None or page_number > len(pdf):
                return None
            page = pdf[page_number - 1]
            scale = bucketed_width / page.get_width()
            bitmap = page.render(scale=scale)
            image = bitmap.to_pil()

            tmp = cache_file.with_suffix(
                f".tmp{threading.get_ident()}_{os.getpid()}"
            )
            if norm_fmt == "webp":
                # Quality 78, method 4 provides ~75% compression over PNG with sharp Arabic/Persian text.
                image.save(tmp, format="WEBP", quality=78, method=4)
            else:
                image.save(tmp, format="PNG")

            os.replace(tmp, cache_file)
            body = cache_file.read_bytes()

            prune_render_cache(cache_dir, cache_cap)

            sys.stderr.write(
                f"render {dataset} p{page_number} w{bucketed_width} {norm_fmt}"
                f" miss {time.monotonic() - started:.3f}s\n"
            )
            return body, mime_type
        except Exception as exc:
            sys.stderr.write(
                f"render failed: {dataset} p{page_number} ({exc})\n"
            )
            return None


def prewarm_book_rasters(
    dataset: str,
    books_dir: Path,
    cache_dir: Path,
    pages: Optional[list[int]] = None,
    widths: Optional[list[int]] = None,
    formats: Optional[list[str]] = None,
    progress_cb: Optional[Callable[[int, int, str], None]] = None,
) -> dict:
    """Pre-render pages for a Book into the render cache ahead of time."""
    if _pdfium is None:
        raise RuntimeError("pypdfium2 is not available")

    source = books_dir / f"{dataset}.pdf"
    if not source.exists():
        raise FileNotFoundError(f"Book PDF not found: {source}")

    if widths is None:
        widths = [480, 800, 1200]
    if formats is None:
        formats = ["webp", "png"]

    with RENDER_LOCK:
        pdf = _pdfium.PdfDocument(str(source))
        total_pages = len(pdf)

    target_pages = pages if pages is not None else list(range(1, total_pages + 1))
    total_tasks = len(target_pages) * len(widths) * len(formats)
    completed = 0
    total_bytes = 0

    for p in target_pages:
        for w in widths:
            for fmt in formats:
                res = get_page_raster(
                    dataset=dataset,
                    page_number=p,
                    width=w,
                    fmt=fmt,
                    books_dir=books_dir,
                    cache_dir=cache_dir,
                )
                if res:
                    total_bytes += len(res[0])
                completed += 1
                if progress_cb:
                    progress_cb(completed, total_tasks, f"p{p}-w{w}.{fmt}")

    return {
        "dataset": dataset,
        "pages_count": len(target_pages),
        "total_rendered": completed,
        "total_bytes": total_bytes,
    }
