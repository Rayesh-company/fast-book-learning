"""Tests for the deep Raster Module (ui/raster.py)."""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

import pytest
from ui.raster import (
    clamp_width,
    get_page_raster,
    prewarm_book_rasters,
    prune_render_cache,
    _pdfium,
)

REAL_PDF = REPO_ROOT / "books" / "tarhe-kolli.pdf"


def test_clamp_width():
    assert clamp_width(300) == 480
    assert clamp_width(480) == 480
    assert clamp_width(630) == 640
    assert clamp_width(650) == 640
    assert clamp_width(800) == 800
    assert clamp_width(1200) == 1280
    assert clamp_width(3000) == 2400


@pytest.mark.skipif(_pdfium is None or not REAL_PDF.exists(), reason="PDFium or tarhe-kolli.pdf not available")
def test_get_page_raster_png_and_webp(tmp_path):
    cache_dir = tmp_path / "cache"
    books_dir = REPO_ROOT / "books"

    # 1. Request PNG
    res_png = get_page_raster("tarhe-kolli", 1, width=640, fmt="png", books_dir=books_dir, cache_dir=cache_dir)
    assert res_png is not None
    body_png, mime_png = res_png
    assert mime_png == "image/png"
    assert body_png[:4] == b"\x89PNG"
    assert (cache_dir / "tarhe-kolli-p1-w640.png").exists()

    # 2. Request WebP
    res_webp = get_page_raster("tarhe-kolli", 1, width=640, fmt="webp", books_dir=books_dir, cache_dir=cache_dir)
    assert res_webp is not None
    body_webp, mime_webp = res_webp
    assert mime_webp == "image/webp"
    assert body_webp[:4] == b"RIFF"
    assert body_webp[8:12] == b"WEBP"
    assert (cache_dir / "tarhe-kolli-p1-w640.webp").exists()

    # WebP should be significantly smaller than PNG
    assert len(body_webp) < len(body_png)

    # 3. Cache hit returns identical bytes fast
    cached_hit = get_page_raster("tarhe-kolli", 1, width=640, fmt="webp", books_dir=books_dir, cache_dir=cache_dir)
    assert cached_hit == res_webp


@pytest.mark.skipif(_pdfium is None or not REAL_PDF.exists(), reason="PDFium or tarhe-kolli.pdf not available")
def test_prewarm_book_rasters(tmp_path):
    cache_dir = tmp_path / "cache"
    books_dir = REPO_ROOT / "books"

    stats = prewarm_book_rasters(
        dataset="tarhe-kolli",
        books_dir=books_dir,
        cache_dir=cache_dir,
        pages=[1, 2],
        widths=[480],
        formats=["webp"],
    )
    assert stats["pages_count"] == 2
    assert stats["total_rendered"] == 2
    assert (cache_dir / "tarhe-kolli-p1-w480.webp").exists()
    assert (cache_dir / "tarhe-kolli-p2-w480.webp").exists()


def test_get_page_raster_invalid_page(tmp_path):
    res = get_page_raster("tarhe-kolli", -1, width=640, fmt="webp", cache_dir=tmp_path)
    assert res is None


def test_prune_render_cache(tmp_path):
    f1 = tmp_path / "test1.png"
    f2 = tmp_path / "test2.webp"
    f1.write_bytes(b"x" * 1000)
    f2.write_bytes(b"y" * 1000)

    # Cap at 1500 bytes -> should prune one file
    pruned = prune_render_cache(tmp_path, cap_bytes=1500)
    assert pruned == 1
    assert len(list(tmp_path.glob("*"))) == 1
