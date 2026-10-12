"""The true-page resolver (ADR-0011): a kept quote's labels name the
passage's ACTUAL page, not the locator's estimate. The Evidence
locators' ``pages A-B`` labels drift against the Book's real pagination
(recorded live 2026-09-16: every sampled passage sat at label-1), so
``guard.py``'s regex-only labels put tooltips and the reader's landing
one page off at the source. This module loads the Book's per-page text
index (``books/<dataset>.pages.json``, built by
tools/build_page_index.py) lazily, normalizes each touched page once
with the guard's own letter stream, and finds the page a passage
actually starts on — the reader's recorded algorithm, server-side.

``install()`` wires the resolver into ui.guard's labels seam; the
default (no install) keeps the estimate behavior, so the pure-text
tests are untouched."""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

try:
    from ui import guard as guard_module
    from ui.guard import normalize_for_match
except ImportError:  # the container runs serve.py as a script beside the modules
    import guard as guard_module
    from guard import normalize_for_match

# The locator shapes, the guard's twins.
_PAGE_RANGE = re.compile(r"\(pages (\d+)-(\d+)\)")
_PAGE_SINGLE = re.compile(r"\(page (\d+)\)")
_DOCUMENT = re.compile(r"\bdocument ([A-Za-z0-9._-]+)")
# The recorded drift is ±2 pages; the resolver searches the labeled
# range first, then the widened band around it.
_RESOLVE_WIDEN = 2
# A passage needle shorter than this matches too easily — no resolution
# beats a wrong one.
_MIN_NEEDLE = 12

_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()


# The Book text layer's backspace word separators (\x08, recorded live
# 2026-09-09) and any non-whitespace C0 control gets the space the layer meant.
_CONTROL_MARKS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TERMINAL_PUNCT = re.compile(
    r"([\.!\?؟\u2026]+[\)»\"'\]]*|[\)»\"'\]][\.!\?؟\u2026]+)$"
)


def bookshelf_dir() -> Path:
    """The Books' directory — serve.py's own rule (compose mounts the
    Books at /books; dev default: the repo's books/ beside ui/)."""
    return Path(
        os.environ.get("SESSION_BOOKS_DIR", str(Path(__file__).resolve().parent.parent / "books"))
    )


def _dataset_raw_pages(dataset: str) -> dict[str, str] | None:
    """The dataset's {page number: verbatim page text}, loaded once per
    process; None when the index is unreadable."""
    if not isinstance(dataset, str) or not dataset:
        return None
    cache_key = f"raw:{dataset}"
    with _CACHE_LOCK:
        if cache_key in _CACHE:
            return _CACHE[cache_key]
        try:
            path = bookshelf_dir() / f"{dataset}.pages.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            raw = (
                data.get("pages")
                if isinstance(data, dict) and "pages" in data
                else data
            )
            if isinstance(raw, dict):
                pages = {str(k): str(v) for k, v in raw.items()}
            else:
                pages = None
        except (OSError, ValueError):
            pages = None
        _CACHE[cache_key] = pages
        return pages


def _dataset_pages(dataset: str) -> dict[str, str] | None:
    """The dataset's {page number: normalized page text}, derived from
    _dataset_raw_pages and normalized once per process; None when the index is
    unreadable (the estimate behavior stands)."""
    if not isinstance(dataset, str) or not dataset:
        return None
    with _CACHE_LOCK:
        if dataset in _CACHE:
            return _CACHE[dataset]
    raw = _dataset_raw_pages(dataset)
    if raw is None:
        pages = None
    else:
        pages = {
            str(number): normalize_for_match(text)
            for number, text in raw.items()
        }
    with _CACHE_LOCK:
        _CACHE[dataset] = pages
        return pages


def _clean_text(text: str) -> str:
    """Clean control characters (like \x08) and normalize whitespace within lines."""
    if not text:
        return ""
    cleaned = _CONTROL_MARKS.sub(" ", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in cleaned.splitlines()]
    return "\n".join(lines).strip()


def _extract_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs based on double newlines (blank lines)
    if present; otherwise splits into coherent line blocks grouped by
    terminal punctuation. Cleans control characters and normalizes whitespace."""
    if not text or not text.strip():
        return []

    cleaned = _CONTROL_MARKS.sub(" ", text)

    # 1. Double newlines (blank lines): split by blank lines
    if re.search(r"\n\s*\n+", cleaned):
        chunks = [c.strip() for c in re.split(r"\n\s*\n+", cleaned.strip()) if c.strip()]
        paras = []
        for chunk in chunks:
            lines = [re.sub(r"[ \t]+", " ", l).strip() for l in chunk.splitlines() if l.strip()]
            if lines:
                paras.append(" ".join(lines))
        return paras if paras else [_clean_text(cleaned)]

    # 2. Single newlines: split into coherent line blocks by terminal punctuation
    lines = [re.sub(r"[ \t]+", " ", l).strip() for l in cleaned.splitlines()]
    lines = [l for l in lines if l]
    if not lines:
        return []

    blocks: list[str] = []
    current: list[str] = []
    for line in lines:
        current.append(line)
        if _TERMINAL_PUNCT.search(line):
            blocks.append(" ".join(current))
            current = []
    if current:
        blocks.append(" ".join(current))

    return blocks


def get_page_context(
    book: str, page: int | str = None, pages: list = None
) -> dict | None:
    """Retrieve the verbatim text for the targeted page or interval alongside boundary
    context (±1 margin: trailing paragraph of start_page-1 and leading paragraph of end_page+1).
    Resolves within an allotted length budget (~12,000 chars) and returns page, last_page, pages.
    Returns None if missing or invalid."""
    if not isinstance(book, str) or not book:
        return None

    clean_pages: list[int] = []
    if pages:
        for p in pages:
            try:
                val = int(p)
                if val > 0:
                    clean_pages.append(val)
            except (ValueError, TypeError):
                pass

    if not clean_pages and page is not None:
        try:
            val = int(page)
            if val > 0:
                clean_pages = [val]
        except (ValueError, TypeError):
            return None

    if not clean_pages:
        return None

    raw_pages = _dataset_raw_pages(book)
    if not raw_pages:
        return None

    start_page = min(clean_pages)
    end_page = max(clean_pages)
    interval_pages = list(range(start_page, end_page + 1))

    if str(start_page) not in raw_pages:
        return None

    max_length = 12000
    collected_pages: list[int] = []
    collected_texts: list[str] = []
    current_len = 0

    for p_num in interval_pages:
        p_key = str(p_num)
        if p_key not in raw_pages:
            break
        raw_p_text = raw_pages[p_key]
        if not isinstance(raw_p_text, str) or not raw_p_text.strip():
            continue
        cleaned_p = _clean_text(raw_p_text)
        if not cleaned_p:
            continue

        extra_len = len(cleaned_p) + (2 if collected_texts else 0)
        if collected_pages and (current_len + extra_len > max_length):
            break

        collected_pages.append(p_num)
        collected_texts.append(cleaned_p)
        current_len += extra_len

    if not collected_pages:
        return None

    resolved_start = collected_pages[0]
    resolved_end = collected_pages[-1]
    combined_text = "\n\n".join(collected_texts)

    prev_paragraph = None
    prev_page_num = None
    prev_key = str(resolved_start - 1)
    if prev_key in raw_pages:
        prev_raw = raw_pages[prev_key]
        if isinstance(prev_raw, str) and prev_raw.strip():
            prev_paras = _extract_paragraphs(prev_raw)
            if prev_paras:
                prev_paragraph = prev_paras[-1]
                prev_page_num = resolved_start - 1

    next_paragraph = None
    next_page_num = None
    next_key = str(resolved_end + 1)
    if next_key in raw_pages:
        next_raw = raw_pages[next_key]
        if isinstance(next_raw, str) and next_raw.strip():
            next_paras = _extract_paragraphs(next_raw)
            if next_paras:
                next_paragraph = next_paras[0]
                next_page_num = resolved_end + 1

    return {
        "book": book,
        "page": resolved_start,
        "last_page": resolved_end,
        "pages": collected_pages,
        "text": combined_text,
        "prev_page": prev_page_num,
        "prev_paragraph": prev_paragraph,
        "next_page": next_page_num,
        "next_paragraph": next_paragraph,
    }


def reset_cache() -> None:
    """Drop the loaded indexes (tests repoint the bookshelf)."""
    with _CACHE_LOCK:
        _CACHE.clear()


def resolve_first_page(reference: str, passage: str):
    """The page the passage actually starts on, or None — the honest
    unknown. Searches the locator's labeled range first (a chunk spans
    at most a few pages), then the ±2 widened band for the recorded
    drift; the needle is the passage's normalized opening, the same
    letter-stream comparison the verbatim guard runs."""
    if not isinstance(reference, str) or not isinstance(passage, str):
        return None
    document = _DOCUMENT.search(reference)
    if not document:
        return None
    pages = _dataset_pages(document.group(1))
    if not pages:
        return None
    needle = normalize_for_match(passage)[:400]
    if len(needle) < _MIN_NEEDLE:
        return None
    range_match = _PAGE_RANGE.search(reference)
    if range_match:
        first, last = int(range_match.group(1)), int(range_match.group(2))
    else:
        single = _PAGE_SINGLE.search(reference)
        if not single:
            return None
        first = last = int(single.group(1))
    for number in range(first, last + 1):
        if needle in pages.get(str(number), ""):
            return number
    for number in range(max(1, first - _RESOLVE_WIDEN), last + _RESOLVE_WIDEN + 1):
        if needle in pages.get(str(number), ""):
            return number
    return None


def install() -> None:
    """Wire the resolver into guard's citation labels — called once at
    serve startup; without it the labels keep the estimate behavior."""
    guard_module.PAGE_RESOLVER = resolve_first_page
