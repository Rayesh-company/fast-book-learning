"""Subset the Vazirmatn UI fonts (2026-10-24 perf pass).

The mobile face ships exactly two faces of Vazirmatn (Regular 400-500,
Bold 600-800 — styles.css's two @font-face rules). The upstream woff2
files carry the font's whole pan-script coverage; the UI draws Persian
plus basic Latin, so the wire can carry a third less. The subset is the
committed vendor file; this script is how it was made and how it is
remade (run it against the UPSTREAM font, never the already-subset
vendor copy):

    .venv/Scripts/python -m tools.subset_vazirmatn <upstream-dir>

with the upstream Regular/Bold woff2 named Vazirmatn-Regular.woff2 and
Vazirmatn-Bold.woff2 (Google Fonts' vazirmatn, OFL — subsetting is
permitted; the license file rides the same directory).

The glyph set is every block the UI's own strings use (verified by
cmap check against ui/mobile + ui/book-reader sources; the three
symbols the UI draws that Vazirmatn never carried — ↗ ▶ ❚ — render via
the browser's sans-serif fallback today exactly as before):
Latin + Latin-1, Arabic (incl. Persian digits), General Punctuation
(ZWNJ, quotes, dashes, ellipsis), and both Arabic Presentation Forms
blocks (legacy precomposed text). Shaping is kept whole
(--layout-features='*'): Persian contextual forms come from GSUB, not
codepoints."""

from pathlib import Path
import subprocess
import sys

UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+0600-06FF,U+2000-206F,"
    "U+FB50-FDFF,U+FE70-FEFF"
)

REPO = Path(__file__).resolve().parent.parent
FONTS = REPO / "ui" / "vendor" / "fonts"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    upstream = Path(sys.argv[1])
    for weight in ("Regular", "Bold"):
        source = upstream / f"Vazirmatn-{weight}.woff2"
        if not source.exists():
            sys.exit(f"missing upstream font: {source}")
        subprocess.run(
            [
                sys.executable, "-m", "fontTools.subset", str(source),
                f"--output-file={FONTS / f'Vazirmatn-{weight}.woff2'}",
                "--flavor=woff2", "--layout-features=*",
                f"--unicodes={UNICODES}",
            ],
            check=True,
        )
        size = (FONTS / f"Vazirmatn-{weight}.woff2").stat().st_size
        print(f"Vazirmatn-{weight}.woff2: {size} bytes (subset)")


if __name__ == "__main__":
    main()
