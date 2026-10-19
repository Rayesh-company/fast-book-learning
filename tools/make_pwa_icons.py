#!/usr/bin/env python3
"""Generate the PWA's icon set (ui/icons/, ADR-0019) — a pure-stdlib
rasterizer, so the marks are reproducible from source on any machine
(no Pillow, no design tool, no binary blob without provenance).

The mark is the sheet's own paper world: the light theme's paper
(--bg #d8cbae) behind an ink (--ink #2e2417) open book — two curved
pages meeting at a gutter over a base line. One geometry, two
croppings: the regular icons let the mark breathe edge-to-edge; the
maskable ones (and iOS's apple-touch-icon) shrink it into the safe
zone so an OS mask of any shape keeps the whole book visible.

Usage:
    python tools/make_pwa_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

PAPER = (216, 203, 174, 255)  # --bg, the light paper
INK = (46, 36, 24, 255)  # --ink, the light ink

ICONS_DIR = Path(__file__).resolve().parent.parent / "ui" / "icons"

SS = 4  # supersampling factor per axis


def _quad(p0, p1, p2, n=32):
    """A quadratic Bezier's sampled points, p0 → p2 with control p1."""
    return [
        (
            (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0],
            (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1],
        )
        for t in (i / n for i in range(n + 1))
    ]


def _book_polygons(width: float) -> list[list[tuple[float, float]]]:
    """The open book as three simple polygons in the unit square — two
    curved pages and the back-cover bar — filled by union.

    ``width`` is the mark's full width; every page's top edge sags from
    its high outer corner into the gutter (the spine is the top edge's
    low point, the way an open book actually curves), and the bottom
    edge repeats that curve one page-thickness down.
    """
    cx, gap = 0.5, 0.05 * (width / 0.62)
    half = width / 2
    top_outer, top_spine = 0.32, 0.38
    thick = 0.17
    pages = []
    for s in (-1, 1):
        sx = cx + s * (gap / 2)  # the page's gutter-side x
        ox = cx + s * half  # the page's outer x
        mx = cx + s * (half + gap / 2) / 2  # the curve's control x
        page = (
            _quad((ox, top_outer), (mx, top_spine), (sx, top_spine))  # top edge
            + [(sx, top_spine + thick)]  # down the gutter edge
            + _quad(
                (sx, top_spine + thick),
                (mx, top_spine + thick),
                (ox, top_outer + thick),
            )[1:]  # bottom edge, the same sag one thickness lower
        )  # the outer edge closes back up to (ox, top_outer)
        pages.append(page)
    bar_y = top_spine + thick + 0.018
    bar_h = 0.032
    bar = [
        (cx - half, bar_y),
        (cx - half, bar_y + bar_h),
        (cx + half, bar_y + bar_h),
        (cx + half, bar_y),
    ]
    return pages + [bar]


def _inside_any(x, y, polys) -> bool:
    """Union membership: the point fills if any simple polygon holds it."""
    for poly in polys:
        inside = False
        n = len(poly)
        j = n - 1
        for i in range(n):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        if inside:
            return True
    return False


def render(size: int, mark_width: float) -> bytes:
    """One RGBA PNG: paper tile, ink book of ``mark_width`` unit width."""
    big = size * SS
    polys = _book_polygons(mark_width)
    rows = bytearray()
    for py in range(big):
        rows.append(0)  # filter: None
        y = (py + 0.5) / big
        for px in range(big):
            x = (px + 0.5) / big
            rows += bytes(INK if _inside_any(x, y, polys) else PAPER)
    # Box-downsample the supersampled raster (each filtered scanline
    # carries one filter byte before its big*4 pixel bytes — the read
    # strides on the full row or every row drifts a little further).
    stride = big * 4 + 1
    down = bytearray()
    for py in range(size):
        down.append(0)
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    o = (py * SS + sy) * stride + (px * SS + sx) * 4 + 1
                    for c in range(4):
                        acc[c] += rows[o + c]
            down += bytes(v // (SS * SS) for v in acc)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(down), 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    # purpose=any: the mark owns the tile. purpose=maskable + iOS: the
    # mark shrinks into the safe zone (the OS may mask any shape).
    targets = {
        "icon-192.png": (192, 0.62),
        "icon-512.png": (512, 0.62),
        "icon-maskable-192.png": (192, 0.50),
        "icon-maskable-512.png": (512, 0.50),
        "apple-touch-icon.png": (180, 0.56),
    }
    for name, (size, width) in targets.items():
        (ICONS_DIR / name).write_bytes(render(size, width))
        print(f"wrote {ICONS_DIR / name}")


if __name__ == "__main__":
    main()
