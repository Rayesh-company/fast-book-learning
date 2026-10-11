#!/usr/bin/env python3
"""Build one Book's lecture index (books/<dataset>.lectures.json) from a
sentence-level audio alignment and the Book PDF.

Input: the aligner's ``reader_alignment.json`` — per lecture session
(جلسه) the audio file name, duration, intro/outro marks and the Book's
sentences with ``start``/``end`` seconds, ``page``/``page_end`` and flags.

The reader highlights the playing sentence ON the rendered PDF page, so
this tool locates each sentence's words on its page(s) with PyMuPDF and
stores their line rectangles in PDF points (top-left origin, the same
space PDF.js uses at scale 1). Matching runs on a letters-only
normalisation of both sides, so the PDF's lam-alef encoding (لا stored
as ال), split ligatures (اس لامی), ZWNJ/spaces, tatweel, diacritics,
footnote digits and the Quran font's unmapped glyphs (▯) do not break it.
A sentence that cannot be located keeps its timing and simply has no
``boxes`` (the reader then shows its text in the caption only).

Timings are made monotonic: sentences are ordered by start and an
overlap is clipped at the next sentence's start, so the reader's binary
search always has one answer.

Offline, run once per Book at provisioning; the JSON is committed like
``.pages.json``. PyMuPDF is a tool-only dependency — the server stays
stdlib-only:

    uv run --with pymupdf python tools/build_lecture_index.py \\
        --alignment reader_alignment.json --pdf books/tarhe-kolli.pdf \\
        --book tarhe-kolli [--out books/tarhe-kolli.lectures.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from bisect import bisect_left
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FORMAT = 1

_DIAC = re.compile("[\u064b-\u065f\u0670\u06d6-\u06ed\u0610-\u061a]")
_MAP = str.maketrans({
    "ي": "ی", "ى": "ی", "ئ": "ی", "ك": "ک", "ۀ": "ه", "ة": "ه", "ؤ": "و",
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا",
})
_LETTER = re.compile("[\u0621-\u064a\u066e-\u06d3\u06d5\u06fa-\u06ffA-Za-z]")


def norm_key(text: str) -> str:
    """Letters only, Persian-folded: the matching alphabet for both sides."""
    text = _DIAC.sub("", text.replace("ـ", "")).translate(_MAP)
    letters = "".join(ch for ch in text if _LETTER.match(ch))
    # The PDF stores the lam-alef ligature as «ال»; fold both sides.
    return letters.replace("لا", "ال")


# ---------------------------------------------------------------- PDF side

def body_words(page) -> list[tuple[float, float, float, float, str]]:
    """The page's body words in reading order (lines top-to-bottom, words
    right-to-left), without the running header and the footnote zone —
    the same body the aligner's sentences were extracted from."""
    sizes: list[tuple[float, float]] = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            size = max((span["size"] for span in line["spans"]), default=0)
            sizes.append((line["bbox"][1], size))
    def size_at(y: float) -> float:
        near = [s for ly, s in sizes if abs(ly - y) < 4]
        return max(near, default=0)
    lines: dict[tuple[int, int], list] = {}
    for w in page.get_text("words"):
        lines.setdefault((w[5], w[6]), []).append(w)
    rows = []
    for ws in lines.values():
        y0 = min(w[1] for w in ws)
        rows.append((y0, size_at(y0), sorted(ws, key=lambda w: -w[2])))
    rows.sort(key=lambda r: r[0])
    footnotes = min([y for y, s, _ in rows if y > 200 and s <= 11.5] or [1e9])
    words = []
    for y0, size, ws in rows:
        if y0 < 40 or size < 11.5 or y0 >= footnotes - 2:
            continue
        words.extend((w[0], w[1], w[2], w[3], w[4]) for w in ws)
    return words


class Stream:
    """A run of pages flattened into one normalised character stream,
    each character knowing its (page, word) of origin."""

    def __init__(self, pages: dict[int, list]):
        self.pages = pages
        chars: list[str] = []
        self.owner: list[tuple[int, int]] = []
        self.page_start: dict[int, int] = {}
        for number in sorted(pages):
            self.page_start[number] = len(chars)
            for index, word in enumerate(pages[number]):
                key = norm_key(word[4])
                chars.extend(key)
                self.owner.extend([(number, index)] * len(key))
        self.text = "".join(chars)
        self.page_end = {
            n: self.page_start.get(n + 1, len(self.text)) for n in sorted(pages)
        }
        # page_end for the last page and gaps
        ordered = sorted(pages)
        for i, n in enumerate(ordered):
            self.page_end[n] = (
                self.page_start[ordered[i + 1]] if i + 1 < len(ordered) else len(self.text)
            )


def locate(stream_text: str, key: str, lo: int, hi: int, cursor: int,
           seed: int = 10) -> tuple[int, int, str] | None:
    """Find ``key`` in ``stream_text[lo:hi]``, preferring the first
    occurrence at or after ``cursor``. Exact match first; otherwise the
    best-supported start estimate from several fixed-length seeds (each
    seed found at position p votes for start p - offset). Returns
    (start, end, "exact"|"fuzzy") in stream coordinates, or None."""
    if not key or lo >= hi:
        return None
    at = stream_text.find(key, max(lo, cursor), hi)
    if at < 0:
        at = stream_text.find(key, lo, hi)
    if at >= 0:
        return at, at + len(key), "exact"
    if len(key) < seed + 2:
        return None
    count = max(3, min(12, len(key) // seed))
    offsets = sorted({round(i * (len(key) - seed) / (count - 1)) for i in range(count)})
    votes: list[int] = []
    for off in offsets:
        piece = key[off:off + seed]
        start = lo
        found = 0
        while found < 4:
            p = stream_text.find(piece, start, hi)
            if p < 0:
                break
            votes.append(p - off)
            start = p + 1
            found += 1
    if not votes:
        return None
    votes.sort()
    tolerance = max(6, len(key) // 6)
    best = None
    for v in votes:
        support = bisect_left(votes, v + tolerance + 1) - bisect_left(votes, v - tolerance)
        rank = (support, v >= cursor - tolerance, -abs(v - cursor))
        if best is None or rank > best[0]:
            best = (rank, v)
    (support, _, _), estimate = best
    if support < 2 and len(offsets) > 2:
        return None
    start = max(lo, estimate)
    end = min(hi, estimate + len(key))
    if end - start < min(len(key), seed):
        return None
    return start, end, "fuzzy"


def boxes_for(stream: Stream, start: int, end: int) -> list[list[float]]:
    """Line rectangles [page, x0, y0, x1, y1] covering the words that own
    stream[start:end] (one rectangle per page line, PDF points)."""
    seen = []
    for page, index in stream.owner[start:end]:
        if not seen or seen[-1] != (page, index):
            seen.append((page, index))
    lines: list[list] = []
    for page, index in dict.fromkeys(seen):
        x0, y0, x1, y1, _ = stream.pages[page][index]
        cy = (y0 + y1) / 2
        for line in lines:
            if line[0] == page and line[2] - 1 <= cy <= line[4] + 1:
                line[1] = min(line[1], x0); line[2] = min(line[2], y0)
                line[3] = max(line[3], x1); line[4] = max(line[4], y1)
                break
        else:
            lines.append([page, x0, y0, x1, y1])
    return [[p, round(a, 1), round(b, 1), round(c, 1), round(d, 1)] for p, a, b, c, d in lines]


# ---------------------------------------------------------------- timings

def monotonic(sentences: list[dict]) -> list[dict]:
    """Order by start (stable) and clip overlaps at the next start."""
    ordered = sorted(sentences, key=lambda s: (s["start"], s["id"]))
    for current, following in zip(ordered, ordered[1:]):
        if current["end"] > following["start"]:
            current["end"] = following["start"]
    for s in ordered:
        s["end"] = max(s["end"], s["start"])
    return ordered


def audio_name(session: dict, suffix: str | None) -> str | None:
    """The committed audio file for a session: the aligner's MP3 name with
    the shipped encoding's suffix (timing is identical across encodings)."""
    name = session.get("audio_mp3")
    if name and suffix:
        name = str(Path(name).with_suffix(suffix))
    return name


def build(alignment: dict, doc, book: str, pdf_sha: str | None = None,
          audio_suffix: str | None = ".m4a") -> tuple[dict, dict]:
    page_cache: dict[int, list] = {}
    def words(n: int) -> list:
        if n not in page_cache:
            page_cache[n] = body_words(doc[n - 1]) if 1 <= n <= len(doc) else []
        return page_cache[n]

    sessions = []
    stats = {"sentences": 0, "boxed": 0, "exact": 0, "fuzzy": 0}
    used_pages: set[int] = set()
    for session in alignment["sessions"]:
        sentences = session["sentences"]
        first = min(s["page"] for s in sentences)
        last = max(s["page_end"] for s in sentences)
        stream = Stream({n: words(n) for n in range(first, last + 1)})
        cursor = 0
        out = []
        for s in sorted(sentences, key=lambda s: s["id"]):  # book order
            key = norm_key(s["text"])
            lo = stream.page_start.get(s["page"], 0)
            hi = stream.page_end.get(s["page_end"], len(stream.text))
            hit = locate(stream.text, key, lo, hi, cursor)
            entry = {
                "id": s["id"], "text": s["text"], "page": s["page"],
                "page_end": s["page_end"], "start": round(s["start"], 2),
                "end": round(s["end"], 2), "confidence": s.get("confidence"),
                "flags": list(s.get("flags", [])),
            }
            stats["sentences"] += 1
            if hit:
                start, end, kind = hit
                entry["boxes"] = boxes_for(stream, start, end)
                if entry["boxes"]:
                    cursor = end
                    stats["boxed"] += 1
                    stats[kind] += 1
                    if kind == "fuzzy":
                        entry["flags"].append("fuzzy_boxes")
                    used_pages.update(b[0] for b in entry["boxes"])
                else:
                    del entry["boxes"]
            out.append(entry)
        sessions.append({
            "session": session["session"],
            "audio": audio_name(session, audio_suffix),
            "duration": session.get("audio_duration_s"),
            "lecture_start": session.get("lecture_start_s", 0),
            "lecture_end": session.get("lecture_end_s"),
            "book_pages": session.get("book_pages"),
            "cover_page": session.get("session_cover_page"),
            "coverage": session.get("coverage"),
            "sentences": monotonic(out),
        })
    pages = {str(n): [round(doc[n - 1].rect.width, 2), round(doc[n - 1].rect.height, 2)]
             for n in sorted(used_pages)}
    index = {
        "format": FORMAT,
        "book": book,
        "title": alignment.get("title"),
        "source": {
            "alignment_generated": alignment.get("generated"),
            "alignment_pdf": alignment.get("book_pdf"),
            "boxes_pdf_sha256": pdf_sha,
        },
        "notes": list(alignment.get("notes", [])) + [
            "boxes: [page, x0, y0, x1, y1] in PDF points, top-left origin (PDF.js viewport at scale 1); one per text line",
            "fuzzy_boxes flag: the sentence was located approximately (garbled or edited text); its box may be off by a few words",
        ],
        "page_sizes": pages,
        "sessions": sessions,
    }
    return index, stats


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--alignment", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--audio-suffix", default=".m4a",
                        help="extension of the shipped session audio (default .m4a: AAC-LC)")
    args = parser.parse_args(argv)
    try:
        import pymupdf
    except ImportError:
        print("PyMuPDF is required: uv run --with pymupdf python tools/build_lecture_index.py ...",
              file=sys.stderr)
        return 2
    alignment = json.loads(args.alignment.read_text(encoding="utf-8"))
    sha = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    index, stats = build(alignment, pymupdf.open(args.pdf), args.book, sha, args.audio_suffix)
    out = args.out or REPO_ROOT / "books" / f"{args.book}.lectures.json"
    out.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{out}: {len(index['sessions'])} sessions, {stats['sentences']} sentences, "
          f"{stats['boxed']} with boxes ({stats['exact']} exact, {stats['fuzzy']} fuzzy)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
