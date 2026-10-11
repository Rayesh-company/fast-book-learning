#!/usr/bin/env python3
"""Build one Book's lecture index (books/<dataset>.lectures.json) from a
sentence-level audio alignment and the Book PDF.

Input: the aligner's ``reader_alignment.json`` (or an existing ``.lectures.json``)
— per lecture session (جلسه) the audio file name, duration, intro/outro marks
and the Book's sentences with ``start``/``end`` seconds, ``page``/``page_end``
and flags.

The reader highlights the playing sentence ON the rendered PDF page, so
this tool locates each sentence's words on its page(s) (with PyMuPDF or
``pdftotext -bbox-layout``) and stores their line rectangles in PDF points
(top-left origin, the same space PDF.js uses at scale 1).

Key guarantees:
1. Visual-line reading order: PDF words on the same visual line (even when
   Adobe InDesign splits a line into multiple fragments around diacritics or
   Quranic glyphs) are clustered by baseline and ordered strictly right-to-left,
   eliminating overlapping boxes on shared lines.
2. Sentence-by-sentence granularity: mid-sentence line-break splits around
   Quranic spans are rejoined, and multi-sentence / long compound entries are
   split at sentence punctuation (``.`` / ``؟`` / ``!`` / ``؛`` / ``:``),
   consecutive (Arabic phrase + Persian translation) pairs, and finite-verb +
   comma boundaries, with timestamps aligned to acoustic breath pauses (RMS
   valleys) when available.
3. Monotonic timings and non-overlapping boxes: sentences are ordered by start
   and any overlap is clipped at the next sentence's start.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET
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


def _norm_word(word: str) -> str:
    word = _DIAC.sub("", word.replace("ـ", "")).translate(_MAP)
    letters = "".join(ch for ch in word if _LETTER.match(ch))
    return letters.replace("لا", "ال")


def norm_key(text: str) -> str:
    """Letters only, Persian-folded: the matching alphabet for both sides.
    Folds lam-alef per word so cross-word 'ل + ا' (e.g. 'انفال از') is not
    turned into 'ال'."""
    return "".join(_norm_word(w) for w in text.split())


# ---------------------------------------------------------------- PDF side

class PdftotextPage:
    """Fallback page adapter using ``pdftotext -bbox-layout`` when PyMuPDF
    is not installed in the active Python environment."""

    def __init__(self, width: float, height: float, raw_lines: list[tuple[float, float, list[tuple[float, float, float, float, str]]]]):
        self.rect = type("Rect", (), {"width": width, "height": height})()
        self._raw_lines = raw_lines

    def get_text(self, kind: str):
        if kind == "dict":
            return {
                "blocks": [{
                    "lines": [
                        {"bbox": [0.0, y0, 0.0, y1], "spans": [{"size": round((y1 - y0) * 0.66, 2)}]}
                        for y0, y1, ws in self._raw_lines
                        if sum(len(_LETTER.findall(w[4])) for w in ws) >= 2
                    ]
                }]
            }
        words = []
        for line_no, (_, _, ws) in enumerate(self._raw_lines):
            for word_no, (x0, y0, x1, y1, text) in enumerate(ws):
                words.append((x0, y0, x1, y1, text, 0, line_no, word_no))
        return words


class PdftotextDoc:
    """Lazy-loading PDF document backed by ``pdftotext -bbox-layout``."""

    def __init__(self, pdf_path: Path):
        self.pdf_path = Path(pdf_path)
        self._pages: dict[int, PdftotextPage] = {}
        self._len = self._probe_length()

    def _probe_length(self) -> int:
        res = subprocess.run(["pdfinfo", str(self.pdf_path)], capture_output=True, text=True)
        if res.returncode == 0:
            for line in res.stdout.splitlines():
                if line.startswith("Pages:"):
                    return int(line.split(":", 1)[1].strip())
        return 1000

    def __len__(self) -> int:
        return self._len

    def load_range(self, first_page: int, last_page: int) -> None:
        missing = [p for p in range(first_page, last_page + 1) if p not in self._pages]
        if not missing:
            return
        p0, p1 = min(missing), max(missing)
        xml_text = subprocess.check_output([
            "pdftotext", "-bbox-layout", "-f", str(p0), "-l", str(p1),
            str(self.pdf_path), "-",
        ]).decode("utf-8", errors="ignore")
        xml_text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", xml_text)
        root = ET.fromstring(xml_text)
        ns = {"x": "http://www.w3.org/1999/xhtml"}
        for idx, page_el in enumerate(root.findall(".//x:page", ns)):
            pnum = p0 + idx
            width = float(page_el.attrib["width"])
            height = float(page_el.attrib["height"])
            raw_lines = []
            for line_el in page_el.findall(".//x:line", ns):
                ly0 = float(line_el.attrib["yMin"])
                ly1 = float(line_el.attrib["yMax"])
                ws = []
                for w_el in line_el.findall("x:word", ns):
                    txt = (w_el.text or "").strip()
                    if not txt:
                        continue
                    # Poppler's pdftotext -bbox-layout emits RTL characters in visual LTR order
                    txt = txt[::-1]
                    ws.append((
                        float(w_el.attrib["xMin"]),
                        float(w_el.attrib["yMin"]),
                        float(w_el.attrib["xMax"]),
                        float(w_el.attrib["yMax"]),
                        txt,
                    ))
                if ws:
                    raw_lines.append((ly0, ly1, ws))
            self._pages[pnum] = PdftotextPage(width, height, raw_lines)

    def __getitem__(self, index: int) -> PdftotextPage:
        page_no = index + 1
        if page_no not in self._pages:
            self.load_range(page_no, page_no)
        return self._pages[page_no]


def body_words(page) -> list[tuple[float, float, float, float, str]]:
    """The page's body words in visual reading order (visual lines top-to-bottom,
    words right-to-left on each visual line), without the running header and
    the footnote zone."""
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
        y1 = max(w[3] for w in ws)
        rows.append((y0, y1, size_at(y0), ws))
    rows.sort(key=lambda r: (r[0], r[1]))

    last_body_y = max([y0 for y0, _, s, _ in rows if s >= 12.0] or [0.0])
    footnotes = min([
        y0 for y0, _, s, ws in rows
        if y0 > max(200.0, last_body_y) and 0 < s <= 11.5 and sum(len(_LETTER.findall(w[4])) for w in ws) >= 2
    ] or [1e9])
    body_rows = [
        (y0, y1, ws)
        for y0, y1, size, ws in rows
        if y0 >= 40 and (size >= 11.5 or (y1 - y0) >= 16.0 or y0 < last_body_y) and y0 < footnotes - 2
    ]

    # Cluster fragments that belong to the same visual line (e.g. split by
    # InDesign around diacritics or Quranic spans) and sort right-to-left.
    clusters: list[dict] = []
    for y0, y1, ws in sorted(body_rows, key=lambda r: (r[1], r[0])):
        placed = False
        for cl in clusters:
            if abs(y1 - cl["y1"]) <= 12.5 or abs(y0 - cl["y0"]) <= 10.0:
                cl["words"].extend(ws)
                n = len(cl["words"])
                cl["y0"] = (cl["y0"] * (n - len(ws)) + y0 * len(ws)) / n
                cl["y1"] = (cl["y1"] * (n - len(ws)) + y1 * len(ws)) / n
                placed = True
                break
        if not placed:
            clusters.append({"y0": y0, "y1": y1, "words": list(ws)})

    clusters.sort(key=lambda cl: cl["y0"])
    words: list[tuple[float, float, float, float, str]] = []
    for cl in clusters:
        rtl_words = sorted(cl["words"], key=lambda w: (-round(w[2], 1), -round(w[0], 1)))
        words.extend((w[0], w[1], w[2], w[3], w[4]) for w in rtl_words)
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
        self.page_end: dict[int, int] = {}
        ordered = sorted(pages)
        for i, n in enumerate(ordered):
            self.page_end[n] = (
                self.page_start[ordered[i + 1]] if i + 1 < len(ordered) else len(self.text)
            )


def _refine_endpoints(stream_text: str, key: str, lo: int, hi: int,
                      est_start: int, est_end: int) -> tuple[int, int]:
    """Snap a fuzzy match's start and end to exact prefix/suffix anchors in
    ``key`` so missing Quran glyphs (▯) do not leave trailing words unboxed."""
    start, end = est_start, est_end
    for plen in (10, 8, 6, 5):
        if len(key) >= plen:
            anchor = key[:plen]
            s_lo = max(lo, est_start - 35)
            s_hi = min(hi, est_start + 35 + plen)
            p = stream_text.find(anchor, s_lo, s_hi)
            if p >= 0:
                start = p
                break
    for slen in (10, 8, 6, 5):
        if len(key) >= slen:
            anchor = key[-slen:]
            e_lo = max(start + slen, est_end - 45 - slen)
            e_hi = min(hi, est_end + 85)
            p = stream_text.rfind(anchor, e_lo, e_hi)
            if p >= 0:
                end = p + slen
                break
    return start, max(start, end)


def locate(stream_text: str, key: str, lo: int, hi: int, cursor: int,
           seed: int = 10) -> tuple[int, int, str] | None:
    """Find ``key`` in ``stream_text[lo:hi]``, preferring the first
    occurrence at or after ``cursor``. Exact match first; otherwise the
    best-supported start estimate from several fixed-length seeds (each
    seed found at position p votes for start p - offset), with start/end
    refined from prefix/suffix anchors. Returns (start, end, "exact"|"fuzzy")
    in stream coordinates, or None."""
    if not key or lo >= hi:
        return None
    for candidate in (key, key.replace("لا", "ال")):
        at = stream_text.find(candidate, max(lo, cursor), hi)
        if at < 0:
            at = stream_text.find(candidate, lo, hi)
        if at >= 0:
            return at, at + len(candidate), "exact"

    for search_lo in (max(lo, cursor), lo):
        if search_lo >= hi:
            continue
        for s_len in (seed, 7, 5, 4):
            if len(key) < s_len + 1:
                continue
            count = max(3, min(14, len(key) // max(2, s_len // 2)))
            offsets = sorted({round(i * (len(key) - s_len) / max(1, count - 1)) for i in range(count)})
            votes: list[int] = []
            for off in offsets:
                piece = key[off:off + s_len]
                start = search_lo
                found = 0
                while found < 6:
                    p = stream_text.find(piece, start, hi)
                    if p < 0:
                        break
                    votes.append(p - off)
                    start = p + 1
                    found += 1
            if not votes:
                continue
            votes.sort()
            tolerance = max(8, len(key) // 4)
            best = None
            for v in votes:
                support = bisect_left(votes, v + tolerance + 1) - bisect_left(votes, v - tolerance)
                rank = (support, v >= cursor - tolerance, -abs(v - cursor))
                if best is None or rank > best[0]:
                    best = (rank, v)
            (support, _, _), estimate = best
            if support < 2 and len(offsets) > 2:
                continue
            start = max(search_lo, estimate)
            end = min(hi, estimate + len(key))
            start, end = _refine_endpoints(stream_text, key, search_lo, hi, start, end)
            if end - start >= min(len(key), s_len):
                return start, end, "fuzzy"
    return None


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
        if round(x1, 1) <= round(x0, 1) or round(y1, 1) <= round(y0, 1):
            continue
        cy = (y0 + y1) / 2
        for line in lines:
            if line[0] == page and line[2] - 4 <= cy <= line[4] + 4:
                line[1] = min(line[1], x0)
                line[2] = min(line[2], y0)
                line[3] = max(line[3], x1)
                line[4] = max(line[4], y1)
                break
        else:
            lines.append([page, x0, y0, x1, y1])
    return [[p, round(a, 1), round(b, 1), round(c, 1), round(d, 1)] for p, a, b, c, d in lines]


# ------------------------------------------------ sentence-by-sentence & timing

_TERMINAL_END = (".", "؟", "!", "؛", ":", "»", ")", "…")
_STRONG_PUNCT = re.compile(r"([.؟!؛:]+\s*)")
_PREPOSITIONS = {
    "برای", "از", "به", "در", "با", "بر", "تا", "بی", "چون", "مثل", "مانند",
    "به‌سوی", "به\u200cسوی", "مگر", "الا", "جز", "بدون", "علیه", "دربارۀ", "درباره",
}
_VERB_COMMA = re.compile(
    r"\b(?:"
    r"(?:نمی|می)[\u200c ]?[^\s،.؟!؛:]+(?:ند|ید|یم|د|م|ی)"
    r"|[^\s،.؟!؛:]+(?:ند|ید|یم|اند|اید|ایم)"
    r"|(?:است|نیست|بود|نبود|شد|نشد|شود|نشود|بشود|نبشود|باشد|نباشد|باشند|نباشند"
    r"|گردد|نگردد|گردید|نگردید|دارد|ندارد|دارند|ندارند|داشت|نداشت"
    r"|کرد|نکرد|کند|نکند|بکند|نکند|زد|نزد|زند|نزند|بزند"
    r"|گوید|نگوید|بگوید|گفت|نگفت|رسد|نرسد|برسد|رسید|نرسید"
    r"|آید|نیاید|بیاید|آمد|نیامد|رود|نرود|برود|رفت|نرفت"
    r"|دهد|ندهد|بدهد|داد|نداد|گیرد|نگیرد|بگیرد|گرفت|نگرفت"
    r"|خواهد|نخواهد|خواست|نخواست|تواند|نتواند|بتواند|توانست|نتوانست"
    r"|ماند|نماند|بماند|فرمود|فرماید|بفرماید)"
    r")\s*،\s+"
)
_CLAUSE_STARTER_AFTER_COMMA = re.compile(
    r"(\S+)\s*،\s+(?=(?:که|اما|ولی|بلکه|زیرا|چون|چراکه|لذا|بنابراین|یعنی|مثلاً|اگر|وقتی|درحالی|درصورتی|آن[\u200c ]?وقت|سپس|بعد|نه\s+به‌سوی|نه\s+اینکه)\b)"
)
_PARALLEL_CLAUSE = re.compile(
    r"\s+(?=(?:آن[\u200c ]?وقت\s+است\s+که|درحالی[\u200c ]?که|درصورتی[\u200c ]?که)\b)"
)


def is_arabic_word(w: str) -> bool:
    """True if token is part of a vocalized Quranic/Arabic phrase (not a Persian
    word with a single ezafe kasra or tanwin)."""
    if "\u25af" in w or "\u0670" in w:
        return True
    core = w.lstrip("\u064b-\u065f")
    if core.endswith(("اً", "اًا")):
        return False
    diacs = _DIAC.findall(core)
    if len(diacs) >= 2:
        return True
    if len(diacs) == 1 and diacs[0] in ("\u064f", "\u0652", "\u064c", "\u064d"):
        return True
    return False


def has_arabic_phrase(text: str) -> bool:
    return any(is_arabic_word(w) for w in text.split())


def clean_display_text(text: str) -> str:
    """Remove stray leading PDF diacritics (like 'ًوجودش' -> 'وجودش') and false
    line-end commas after prepositions ('برای، اینکه' -> 'برای اینکه')."""
    text = re.sub(r"(?:^|(?<=\s))[\u064b-\u065f]+(?=[آ-ی])", "", text)
    text = re.sub(r"\b(برای|از|به|در|با|بر|تا|مثل|مانند)،\s+", r"\1 ", text)
    text = re.sub(r"،\s*،", "،", text)
    return text.strip()


def merge_broken_entries(sentences: list[dict]) -> list[dict]:
    """Re-join consecutive aligner entries that were split mid-sentence at a
    PDF line break (e.g. around Quranic spans), keeping their time anchors."""
    ordered = sorted(sentences, key=lambda s: s["id"])
    merged: list[dict] = []
    i = 0
    while i < len(ordered):
        cur = dict(ordered[i])
        text = clean_display_text(cur["text"])
        segments = [(0, len(text), float(cur["start"]), float(cur["end"]))]
        flags = list(cur.get("flags", []))
        confs = [cur.get("confidence") if cur.get("confidence") is not None else 0.0]
        while (
            i + 1 < len(ordered)
            and not (cur["id"] == 0 and "quran" in cur.get("flags", []))
            and (
                not text.endswith(_TERMINAL_END)
                or not norm_key(ordered[i + 1]["text"])
            )
            and (ordered[i + 1]["start"] - cur["end"]) < 8.5
            and ordered[i + 1]["page"] <= cur["page_end"] + 1
        ):
            nxt = ordered[i + 1]
            nxt_text = clean_display_text(nxt["text"])
            if not nxt_text or not norm_key(nxt_text):
                cur["end"] = max(cur["end"], nxt["end"])
                i += 1
                continue
            if text.endswith("،") and nxt_text.split()[0] in (
                "می‌کنند", "می‌کند", "است", "بود", "شد", "بشود", "دارد", "ندارد", "تواَند", "تواند",
            ):
                text = text[:-1].rstrip()
                segments[-1] = (segments[-1][0], len(text), segments[-1][2], segments[-1][3])
            if text.endswith(" و") and nxt_text.startswith(("َال", "ُال", "ِال")):
                nxt_text = nxt_text[0] + " " + nxt_text[1:]
                text = text + nxt_text
            else:
                text = text + " " + nxt_text
            seg_start_char = segments[-1][1] + (0 if nxt_text.startswith(("َ ", "ُ ", "ِ ")) else 1)
            segments.append((seg_start_char, len(text), float(nxt["start"]), float(nxt["end"])))
            cur["end"] = nxt["end"]
            cur["page_end"] = max(cur["page_end"], nxt["page_end"])
            for f in nxt.get("flags", []):
                if f not in flags:
                    flags.append(f)
            confs.append(nxt.get("confidence") if nxt.get("confidence") is not None else 0.0)
            i += 1
        cur["text"] = text
        cur["flags"] = flags
        cur["confidence"] = round(sum(confs) / len(confs), 3) if confs else cur.get("confidence")
        cur["_segments"] = segments
        merged.append(cur)
        i += 1
    return merged


def split_arabic_translation_pairs(text: str) -> list[tuple[int, int]]:
    """If a chunk contains multiple (Arabic phrase + Persian translation) pairs,
    split before the 2nd+ Arabic phrase once at least 2 Persian translation words
    have appeared after the previous Arabic phrase."""
    tokens = list(re.finditer(r"\S+", text))
    if len(tokens) < 4:
        return [(0, len(text))]

    is_ar = [is_arabic_word(m.group(0)) for m in tokens]
    for _pass in range(2):
        for idx in range(len(tokens)):
            if is_ar[idx]:
                continue
            w_clean = _DIAC.sub("", tokens[idx].group(0)).strip("،.؟!؛:«»()")
            prev_ar = idx > 0 and is_ar[idx - 1]
            next_ar = idx + 1 < len(tokens) and is_ar[idx + 1]
            if prev_ar and next_ar:
                is_ar[idx] = True
            elif w_clean in ("و", "الله", "فی", "من", "الی", "علی", "ان", "لا", "ما", "هو", "هم", "ثم") and (prev_ar or next_ar):
                is_ar[idx] = True

    spans: list[tuple[int, int]] = []
    chunk_start = 0
    seen_ar_in_chunk = False
    persian_after_ar = 0

    for idx, m in enumerate(tokens):
        if is_ar[idx]:
            if seen_ar_in_chunk and persian_after_ar >= 2:
                prev_tok = tokens[idx - 1].group(0)
                if prev_tok.endswith(("،", "؛", ".", ":")) or persian_after_ar >= 3:
                    split_at = m.start()
                    if split_at - chunk_start >= 18 and len(text) - split_at >= 18:
                        spans.append((chunk_start, split_at))
                        chunk_start = split_at
                        seen_ar_in_chunk = True
                        persian_after_ar = 0
                        continue
            seen_ar_in_chunk = True
            persian_after_ar = 0
        else:
            if seen_ar_in_chunk:
                persian_after_ar += 1

    spans.append((chunk_start, len(text)))
    return spans


def split_long_clause(text: str, start_offset: int, max_len: int = 95, min_len: int = 24) -> list[tuple[int, int]]:
    """Split a clause > max_len chars at finite-verb + comma or comma + clause-starter."""
    effective_max = 160 if has_arabic_phrase(text) else max_len
    if len(text) <= effective_max:
        return [(start_offset, start_offset + len(text))]

    candidates: list[int] = []
    for m in _VERB_COMMA.finditer(text):
        pos = m.end()
        if min_len <= pos <= len(text) - min_len:
            if not (has_arabic_phrase(text[max(0, pos - 18):pos]) and has_arabic_phrase(text[pos:min(len(text), pos + 18)])):
                candidates.append(pos)
    for m in _CLAUSE_STARTER_AFTER_COMMA.finditer(text):
        prev_word = m.group(1).strip("،.؟!؛:«»()")
        if prev_word in _PREPOSITIONS:
            continue
        pos = m.end()
        if min_len <= pos <= len(text) - min_len:
            candidates.append(pos)
    for m in _PARALLEL_CLAUSE.finditer(text):
        pos = m.end()
        if min_len <= pos <= len(text) - min_len:
            candidates.append(pos)
    if not candidates and len(text) > 140:
        for m in re.finditer(r"(\S+)\s*،\s+", text):
            prev_word = m.group(1).strip("،.؟!؛:«»()")
            if prev_word in _PREPOSITIONS:
                continue
            pos = m.end()
            if min_len <= pos <= len(text) - min_len:
                candidates.append(pos)

    if not candidates:
        return [(start_offset, start_offset + len(text))]

    target = min(80, len(text) // 2)
    best = min(candidates, key=lambda p: abs(p - target))
    left = text[:best].strip()
    right = text[best:].strip()
    if len(left) < min_len or len(right) < min_len:
        return [(start_offset, start_offset + len(text))]

    left_spans = split_long_clause(left, start_offset, max_len, min_len)
    right_spans = split_long_clause(right, start_offset + best, max_len, min_len)
    return left_spans + right_spans


def split_sentence_spans(text: str, is_epigraph: bool = False) -> list[tuple[int, int]]:
    """Return [(char_start, char_end), ...] for sentence-by-sentence units."""
    if is_epigraph or len(text) < 42:
        return [(0, len(text))]

    raw_cuts = [0]
    for m in _STRONG_PUNCT.finditer(text):
        end_pos = m.end()
        if end_pos >= len(text):
            continue
        punct = m.group(1).strip()
        left_len = end_pos - raw_cuts[-1]
        right_len = len(text) - end_pos
        if punct == ":" and left_len < 24:
            continue
        if left_len >= 18 and right_len >= 14:
            raw_cuts.append(end_pos)
    raw_cuts.append(len(text))

    step1: list[tuple[int, int]] = []
    for a, b in zip(raw_cuts, raw_cuts[1:]):
        while a < b and text[a].isspace():
            a += 1
        while b > a and text[b - 1].isspace():
            b -= 1
        if b > a:
            step1.append((a, b))

    step2: list[tuple[int, int]] = []
    for a, b in step1:
        sub = text[a:b]
        for sa, sb in split_arabic_translation_pairs(sub):
            ca, cb = a + sa, a + sb
            while ca < cb and text[ca].isspace():
                ca += 1
            while cb > ca and text[cb - 1].isspace():
                cb -= 1
            if cb > ca:
                step2.append((ca, cb))

    step3: list[tuple[int, int]] = []
    for a, b in step2:
        sub = text[a:b]
        for la, lb in split_long_clause(sub, a, max_len=95, min_len=24):
            while la < lb and text[la].isspace():
                la += 1
            while lb > la and text[lb - 1].isspace():
                lb -= 1
            if lb > ca if False else lb > la:
                step3.append((la, lb))

    return step3 or [(0, len(text))]


def load_rms(rms_path: Path | None) -> list[float]:
    if not rms_path or not rms_path.is_file():
        return []
    data = rms_path.read_bytes()
    n = len(data) // 4
    return list(struct.unpack(f"<{n}f", data[: n * 4]))


def _char_weights(text: str) -> list[float]:
    n = len(text)
    w = [1.0] * n
    for m in re.finditer(r"\S+", text):
        if is_arabic_word(m.group(0)):
            for i in range(m.start(), m.end()):
                w[i] = 1.45
    for i, ch in enumerate(text):
        if ch == "،":
            w[i] += 6.5
        elif ch in ("؛", ":"):
            w[i] += 9.5
        elif ch in (".", "؟", "!"):
            w[i] += 11.5
        elif ch == "\u25af":
            w[i] = 2.6
    return w


def allocate_span_timings(
    text: str,
    spans: list[tuple[int, int]],
    segments: list[tuple[int, int, float, float]],
    rms: list[float],
) -> list[tuple[float, float]]:
    """Map each sentence span (a, b) in ``text`` to (start_s, end_s) using
    piecewise ASR segment anchors and RMS acoustic pause snapping."""
    if len(spans) == 1:
        return [(round(segments[0][2], 2), round(segments[-1][3], 2))]

    weights = _char_weights(text)
    prefix = [0.0] * (len(text) + 1)
    for i, cw in enumerate(weights):
        prefix[i + 1] = prefix[i] + cw

    def weight_between(a: int, b: int) -> float:
        return max(1e-6, prefix[max(a, min(len(text), b))] - prefix[max(0, min(len(text), a))])

    def interp_time(char_pos: int) -> tuple[float, tuple[float, float], bool]:
        for c0, c1, s0, e0 in segments:
            if abs(char_pos - c0) <= 2:
                return s0, (s0, e0), True
            if abs(char_pos - c1) <= 2:
                return e0, (s0, e0), True
            if c0 <= char_pos <= c1:
                frac = weight_between(c0, char_pos) / weight_between(c0, c1)
                return s0 + frac * (e0 - s0), (s0, e0), False
        return segments[-1][3], (segments[-1][2], segments[-1][3]), True

    def smooth_rms(bin_idx: int) -> float:
        lo = max(0, bin_idx - 2)
        hi = min(len(rms), bin_idx + 3)
        return sum(rms[lo:hi]) / max(1, hi - lo)

    total_start = segments[0][2]
    total_end = segments[-1][3]
    results: list[tuple[float, float]] = []
    cur_start = total_start

    for idx in range(len(spans)):
        _, b = spans[idx]
        if idx == len(spans) - 1:
            results.append((round(cur_start, 2), round(max(cur_start + 0.15, total_end), 2)))
            break

        t_est, (seg_s, seg_e), is_exact = interp_time(b)
        remaining_spans = len(spans) - 1 - idx
        min_allowed = cur_start + 0.30
        max_allowed = total_end - 0.30 * remaining_spans
        if min_allowed >= max_allowed:
            t_est = cur_start + max(0.15, (total_end - cur_start) / (remaining_spans + 1))
            results.append((round(cur_start, 2), round(t_est, 2)))
            cur_start = t_est
            continue

        t_est = max(min_allowed, min(max_allowed, t_est))
        if is_exact or not rms:
            results.append((round(cur_start, 2), round(t_est, 2)))
            cur_start = t_est
            continue

        seg_span = max(0.5, seg_e - seg_s)
        win = min(2.2, max(0.45, seg_span * 0.20))
        search_lo = max(min_allowed, seg_s + 0.25, t_est - win)
        search_hi = min(max_allowed, seg_e - 0.25, t_est + win)

        b_lo = max(0, int(search_lo * 50))
        b_hi = min(len(rms) - 1, int(search_hi * 50))
        seg_b0 = max(0, int(seg_s * 50))
        seg_b1 = min(len(rms), int(seg_e * 50))
        mean_r = (sum(rms[seg_b0:seg_b1]) / max(1, seg_b1 - seg_b0)) if seg_b1 > seg_b0 else 0.05

        if b_hi > b_lo and mean_r > 1e-4:
            best_bin = int(t_est * 50)
            best_score = 1e9
            for bi in range(b_lo, b_hi + 1):
                tb = bi / 50.0
                sr = smooth_rms(bi) / mean_r
                dist_pen = 0.30 * abs(tb - t_est) / max(0.3, win)
                score = sr + dist_pen
                if score < best_score:
                    best_score = score
                    best_bin = bi

            valley_rms = smooth_rms(best_bin)
            if valley_rms < 0.65 * mean_r:
                thresh = max(0.004, min(0.30 * mean_r, valley_rms * 1.6))
                v_start = best_bin
                while v_start > b_lo and smooth_rms(v_start - 1) <= thresh:
                    v_start -= 1
                v_end = best_bin
                while v_end < b_hi and smooth_rms(v_end + 1) <= thresh:
                    v_end += 1
                pause_start = v_start / 50.0
                pause_end = v_end / 50.0
                if pause_end - pause_start >= 0.22:
                    results.append((round(cur_start, 2), round(max(cur_start + 0.15, pause_start), 2)))
                    cur_start = pause_end
                    continue
                t_snap = (pause_start + pause_end) / 2.0
                results.append((round(cur_start, 2), round(max(cur_start + 0.15, t_snap), 2)))
                cur_start = t_snap
                continue

        results.append((round(cur_start, 2), round(t_est, 2)))
        cur_start = t_est

    return results


def refine_session_sentences(sentences: list[dict], rms: list[float] | None = None) -> list[dict]:
    """Rejoin mid-sentence PDF line-break fragments and split into
    sentence-by-sentence units with acoustic pause timing."""
    merged = merge_broken_entries(sentences)
    refined: list[dict] = []
    next_id = 0
    for m in merged:
        text = m["text"]
        is_ep = "quran" in m.get("flags", []) and m["id"] == 0
        spans = split_sentence_spans(text, is_epigraph=is_ep)
        timings = allocate_span_timings(text, spans, m["_segments"], rms or [])
        base_flags = [f for f in m.get("flags", []) if f != "fuzzy_boxes"]
        for (a, b), (st, en) in zip(spans, timings):
            sub_text = text[a:b].strip()
            if not sub_text:
                continue
            sub_flags = list(base_flags)
            if "\u25af" not in sub_text and "garbled_pdf_text" in sub_flags:
                sub_flags.remove("garbled_pdf_text")
            if not has_arabic_phrase(sub_text) and "quran" in sub_flags and not is_ep:
                sub_flags.remove("quran")
            refined.append({
                "id": next_id,
                "text": sub_text,
                "page": m["page"],
                "page_end": m["page_end"],
                "start": st,
                "end": en,
                "confidence": m.get("confidence"),
                "flags": sub_flags,
            })
            next_id += 1
    return refined


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
    """The committed audio file for a session: the aligner's audio name with
    the shipped encoding's suffix (timing is identical across encodings)."""
    name = session.get("audio_mp3") or session.get("audio")
    if name and suffix:
        name = str(Path(name).with_suffix(suffix))
    return name


def build(alignment: dict, doc, book: str, pdf_sha: str | None = None,
          audio_suffix: str | None = ".mp3", split_sentences: bool = False,
          rms_dir: Path | None = None) -> tuple[dict, dict]:
    page_cache: dict[int, list] = {}

    def words(n: int) -> list:
        if n not in page_cache:
            page_cache[n] = body_words(doc[n - 1]) if 1 <= n <= len(doc) else []
        return page_cache[n]

    sessions = []
    stats = {"sentences": 0, "boxed": 0, "exact": 0, "fuzzy": 0}
    used_pages: set[int] = set()
    for session in alignment["sessions"]:
        sess_no = session["session"]
        raw_sentences = session["sentences"]
        if split_sentences:
            rms_path = (rms_dir / f"session_{sess_no:02d}.rms") if rms_dir else None
            sentences = refine_session_sentences(raw_sentences, load_rms(rms_path))
        else:
            sentences = raw_sentences

        first = min(s["page"] for s in sentences)
        last = max(s["page_end"] for s in sentences)
        if hasattr(doc, "load_range"):
            doc.load_range(first, last)
        stream = Stream({n: words(n) for n in range(first, last + 1)})
        cursor = 0
        out = []
        spans: list[tuple[int, int, str] | None] = []
        ordered_sents = sorted(sentences, key=lambda s: s["id"])
        for s in ordered_sents:
            key = norm_key(s["text"])
            lo = stream.page_start.get(s["page"], 0)
            hi = stream.page_end.get(s["page_end"], len(stream.text))
            hit = locate(stream.text, key, lo, hi, cursor)
            if hit:
                s_idx, e_idx, kind = hit
                if s_idx < cursor and e_idx > cursor:
                    s_idx = cursor
                # Snap start to the beginning of a word if the previous sentence already owns the start of this word
                if cursor > 0 and s_idx == cursor and s_idx < len(stream.owner):
                    prev_word = stream.owner[cursor - 1]
                    while s_idx < e_idx and stream.owner[s_idx] == prev_word:
                        s_idx += 1
                if e_idx > s_idx:
                    cursor = max(cursor, e_idx)
                    spans.append((s_idx, e_idx, kind))
                else:
                    spans.append(None)
            else:
                spans.append(None)

        # Fill any unlocated sentence strictly bracketed between two located neighbours
        for i, hit in enumerate(spans):
            if hit is not None:
                continue
            prev_end = next((spans[j][1] for j in range(i - 1, -1, -1) if spans[j] is not None), None)
            next_start = next((spans[j][0] for j in range(i + 1, len(spans)) if spans[j] is not None), None)
            if prev_end is not None and next_start is not None and 0 < next_start - prev_end <= 400:
                spans[i] = (prev_end, next_start, "fuzzy")

        # Clip any span overlap with the next located sentence at word boundaries so no word is boxed twice
        for i in range(len(spans) - 1):
            if spans[i] is None:
                continue
            s_idx, e_idx, kind = spans[i]
            next_j = next((j for j in range(i + 1, len(spans)) if spans[j] is not None), None)
            if next_j is not None:
                ns, ne, nkind = spans[next_j]
                if e_idx > ns > s_idx:
                    e_idx = ns
                # Ensure the boundary between i and next_j does not share the same PDF word
                if 0 < e_idx <= ns < len(stream.owner) and stream.owner[e_idx - 1] == stream.owner[ns]:
                    shared_w = stream.owner[ns]
                    while ns < ne and stream.owner[ns] == shared_w:
                        ns += 1
                    spans[next_j] = (ns, ne, nkind)
                spans[i] = (s_idx, e_idx, kind)

        for s, hit in zip(ordered_sents, spans):
            entry = {
                "id": s["id"], "text": s["text"], "page": s["page"],
                "page_end": s["page_end"], "start": round(s["start"], 2),
                "end": round(s["end"], 2), "confidence": s.get("confidence"),
                "flags": [f for f in s.get("flags", []) if f != "fuzzy_boxes"],
            }
            stats["sentences"] += 1
            if hit:
                start, end, kind = hit
                entry["boxes"] = boxes_for(stream, start, end)
                if entry["boxes"]:
                    box_pages = [b[0] for b in entry["boxes"]]
                    entry["page"] = min(box_pages)
                    entry["page_end"] = max(box_pages)
                    stats["boxed"] += 1
                    stats[kind] += 1
                    if kind == "fuzzy":
                        entry["flags"].append("fuzzy_boxes")
                    used_pages.update(box_pages)
                else:
                    del entry["boxes"]
            out.append(entry)
        sessions.append({
            "session": sess_no,
            "audio": audio_name(session, audio_suffix),
            "duration": session.get("audio_duration_s") or session.get("duration"),
            "lecture_start": session.get("lecture_start_s", session.get("lecture_start", 0)),
            "lecture_end": session.get("lecture_end_s", session.get("lecture_end")),
            "book_pages": session.get("book_pages"),
            "cover_page": session.get("session_cover_page", session.get("cover_page")),
            "coverage": session.get("coverage"),
            "sentences": monotonic(out),
        })
    pages = {str(n): [round(doc[n - 1].rect.width, 2), round(doc[n - 1].rect.height, 2)]
             for n in sorted(used_pages)}
    source = alignment.get("source") or {}
    notes = list(alignment.get("notes", []))
    for extra in (
        "boxes: [page, x0, y0, x1, y1] in PDF points, top-left origin (PDF.js viewport at scale 1); one per text line",
        "fuzzy_boxes flag: the sentence was located approximately (garbled or edited text); its box may be off by a few words",
    ):
        if extra not in notes:
            notes.append(extra)
    index = {
        "format": FORMAT,
        "book": book,
        "title": alignment.get("title"),
        "source": {
            "alignment_generated": alignment.get("generated") or source.get("alignment_generated"),
            "alignment_pdf": alignment.get("book_pdf") or source.get("alignment_pdf"),
            "boxes_pdf_sha256": pdf_sha,
        },
        "notes": notes,
        "page_sizes": pages,
        "sessions": sessions,
    }
    return index, stats


def open_pdf(pdf_path: Path):
    try:
        import pymupdf
        return pymupdf.open(pdf_path)
    except ImportError:
        return PdftotextDoc(pdf_path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--alignment", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--audio-suffix", default=".mp3",
                        help="extension of the shipped session audio (default .mp3)")
    parser.add_argument("--rms-dir", type=Path, default=None,
                        help="directory of 50Hz float32 session_NN.rms files for pause alignment")
    parser.add_argument("--no-split-sentences", action="store_true",
                        help="keep raw aligner entries without sentence-by-sentence splitting")
    args = parser.parse_args(argv)
    alignment = json.loads(args.alignment.read_text(encoding="utf-8"))
    sha = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    doc = open_pdf(args.pdf)
    index, stats = build(
        alignment, doc, args.book, sha, args.audio_suffix,
        split_sentences=not args.no_split_sentences,
        rms_dir=args.rms_dir,
    )
    out = args.out or REPO_ROOT / "books" / f"{args.book}.lectures.json"
    out.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{out}: {len(index['sessions'])} sessions, {stats['sentences']} sentences, "
          f"{stats['boxed']} with boxes ({stats['exact']} exact, {stats['fuzzy']} fuzzy)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
