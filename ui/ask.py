"""The retrieval-only ask (ADR-0014): the first answer's Evidence pool
without an LLM completion in the loop. One Cognee search per selected
Book — HYBRID_COMPLETION with ``only_context`` — returns the hybrid
retriever's own context (the same passages the old streamed completion
read) with NO answer generation, so the pool cannot drift into a
conclusive essay, cannot skip its Evidence block, and lands in seconds
instead of minutes.

The module talks to the MAIN Cognee service behind this module's ONE
`urlopen` attribute (the scripted-upstream tests patch ui.ask.urlopen);
the deep, minutes-long searches stay on the second service where
Research Mode runs them (ADR-0002)."""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen

try:
    from ui.dive import BOOK_DATASETS
except ImportError:  # the container runs serve.py as a script beside the modules
    from dive import BOOK_DATASETS

try:
    from ui.guard import (
        _CONTROL_MARKS,
        _DOCUMENT_IN_REFERENCE,
        normalize_for_match,
    )
except ImportError:
    from guard import (
        _CONTROL_MARKS,
        _DOCUMENT_IN_REFERENCE,
        normalize_for_match,
    )


# The ask is the fast lane: only_context retrieval is one query embedding
# plus pgvector/graph lookups per Book (~4s measured, 2026-09-23). The
# leash carries an order of headroom for a cold service without ever
# approaching the old streamed completion's 90s+ tail.
ASK_TIMEOUT = 90
# The context doc's passage section header (the hybrid retriever's own
# format_hybrid_context shape, cognee modules/retrieval/hybrid/context.py).
_PASSAGES_HEADING = "## Relevant passages"
_NEXT_HEADING = "## "
# The chunk separator inside the passages section.
_PASSAGE_SEPARATOR = "\n---\n"
# The Book text layer's page marker, the service patch's twin
# (enable_farsi_evidence.py, ui.dive._CHUNK_PAGE_MARKER): a passage's
# pages read from the same markers its Evidence bullets would carry.
_PAGE_MARKER = re.compile(r"Page\s+(\d+)\s*[:：]", re.IGNORECASE)
_SENTENCE_REGEX = re.compile(r"([^.!؟؛\n]+[.!?؟؛\n]*)", re.UNICODE)
_WORD_TOKENS = re.compile(r"\w+", re.UNICODE)



def _recall_url() -> str:
    """The main service's recall route — the same one serve.py proxies
    to (COGNEE_URL), read at call time so the tests' env pins hold."""
    return (
        os.environ.get("COGNEE_URL", "http://127.0.0.1:8000").rstrip("/")
        + "/api/v1/recall"
    )


def only_context_request(dataset: str, query: str) -> Request:
    """One Book's retrieval-only recall POST — the search shape pinned
    HERE, never in the browser: the hybrid retriever's lanes with
    ``only_context``, which returns the retrieval context and nothing
    else (no LLM completion, no session write, cognee's own contract in
    modules/retrieval/context_preview.py). One dataset per call so every
    passage's Book identity is the call's own — the context doc carries
    no per-chunk attribution."""
    return Request(
        _recall_url(),
        data=json.dumps(
            {
                "searchType": "HYBRID_COMPLETION",
                "query": query,
                "datasets": [dataset],
                "includeReferences": True,
                "only_context": True,
            },
            ensure_ascii=False,
        ).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )


def parse_context_passages(document: str) -> list:
    """The passage strings out of one only_context reply's context doc.

    The doc's ``## Relevant passages`` section holds the retrieved
    chunks separated by ``---`` lines; the entity and fact sections that
    follow are graph labels, never citable passages, and drop here.
    Each kept chunk is verbatim Book text — exactly what the Evidence
    bullets of the old streamed reply carried, before the completion
    could mangle or drop them. A missing or empty section yields [],
    never an invented passage."""
    if not isinstance(document, str) or not document.strip():
        return []
    at = document.find(_PASSAGES_HEADING)
    if at == -1:
        return []
    rest = document[at + len(_PASSAGES_HEADING):]
    end = rest.find(_NEXT_HEADING)
    if end != -1:
        rest = rest[:end]
    passages = []
    for chunk in rest.split(_PASSAGE_SEPARATOR):
        text = chunk.strip()
        if text:
            passages.append(text)
    return passages


def _passage_reference(dataset: str, passage: str) -> str:
    """The Evidence-locator-shaped reference for one passage — the Book
    identity from the call's own dataset, the pages from the text
    layer's Page N: markers (the same provenance the service's Evidence
    bullets and ui.dive's chunks Tool build). No markers: the Book
    alone, never an invented page."""
    pages = sorted({int(m.group(1)) for m in _PAGE_MARKER.finditer(passage)})
    if not pages:
        return f"document {dataset}"
    if pages[0] == pages[-1]:
        return f"document {dataset} (page {pages[0]})"
    return f"document {dataset} (pages {pages[0]}-{pages[-1]})"


def _dataset_passages(dataset: str, query: str) -> list:
    """One Book's pool: the only_context call, the context doc out of
    the reply, the parsed passages as (reference, passage) pairs. On
    any failure the Book contributes nothing; the ask continues on its
    sibling Book's pool."""
    try:
        with urlopen(only_context_request(dataset, query), timeout=ASK_TIMEOUT) as response:
            payload = json.load(response)
    except (OSError, ValueError):
        return []
    document = None
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, dict):
            continue
        value = item.get("text")
        if isinstance(value, str) and value.strip():
            document = value
            break
        raw = item.get("raw")
        if isinstance(raw, dict) and isinstance(raw.get("value"), str):
            document = raw["value"]
            break
    return [
        {
            "reference": _passage_reference(dataset, passage),
            "passage": passage,
        }
        for passage in parse_context_passages(document)
    ]


def ask_pool(query: str, datasets=None, distill: bool = False) -> list:
    """The ask's Evidence pool: one only_context search per selected
    Book, both lanes in parallel, the passages merged in the Book set's
    stable order with cross-Book duplicates dropped. The pool is
    retrieval's own output — no completion, no conclusion, no drift.

    ``datasets`` follows the ask-path rule (ADR-0010): None or empty
    means the whole Book set; names outside the set never reach an
    upstream (serve.validated_datasets intersects before this runs)."""
    picked = [d for d in (datasets or []) if d in BOOK_DATASETS] or list(BOOK_DATASETS)
    with ThreadPoolExecutor(max_workers=len(picked)) as pool:
        per_book = list(
            pool.map(lambda dataset: _dataset_passages(dataset, query), picked)
        )
    seen = set()
    sources = []
    for result in per_book:
        for source in result:
            if source["passage"] in seen:
                continue
            seen.add(source["passage"])
            sources.append(source)
    if distill:
        return distill_pool(query, sources)
    return sources


def _page_at_offset(offset: int, markers: list) -> int | None:
    last_page = None
    for pm in markers:
        if pm.start() <= offset:
            last_page = int(pm.group(1))
        else:
            break
    return last_page


def distill_pool(
    query: str,
    pool: list[dict],
    max_chars_per_passage: int = 600,
    min_chars_per_passage: int = 150,
) -> list[dict]:
    """Extractive sentence-level scoring and density distillation.

    Filters candidate Cognee passages down to high-density citable evidence spans
    while preserving verbatim sentence boundaries, exact page provenance, and canonical
    interactive reader citations (document <book> (page <N>)).

    Passages <= 400 characters without multi-page spans are preserved verbatim.
    Distilled spans are assembled from 1-3 contiguous sentences around scoring peaks
    up to max_chars_per_passage, strictly staying on the same page.
    """
    if not pool or not isinstance(pool, list):
        return []

    # Extract query content tokens of length >= 2
    raw_tokens = _WORD_TOKENS.findall(query or "")
    norm_tokens = [
        normalize_for_match(t) for t in raw_tokens if len(normalize_for_match(t)) >= 2
    ]
    keywords = list(dict.fromkeys(norm_tokens))  # preserve order, unique

    distilled_pool = []
    seen_texts = set()

    for item in pool:
        if not isinstance(item, dict):
            continue
        raw_passage = item.get("passage", "")
        orig_ref = item.get("reference", "")

        if not isinstance(raw_passage, str) or not raw_passage.strip():
            continue

        # Pre-scan page marker positions
        page_markers = list(_PAGE_MARKER.finditer(raw_passage))
        distinct_pages = {int(m.group(1)) for m in page_markers}

        clean_raw = raw_passage.strip()
        # Rule: Concise passages (<= 400 chars) without multi-page spans are kept verbatim
        if len(clean_raw) <= 400 and len(distinct_pages) <= 1:
            if clean_raw not in seen_texts:
                seen_texts.add(clean_raw)
                distilled_pool.append({
                    "reference": orig_ref,
                    "passage": clean_raw,
                    "score": 1.0,
                })
            continue

        # Step 1: Segment passage into sentences with line offsets and page provenance
        sentences = []

        for match in _SENTENCE_REGEX.finditer(raw_passage):
            s_text = match.group(0)
            clean_s = s_text.strip()
            stripped_s = _CONTROL_MARKS.sub("", clean_s).strip()
            if (
                not clean_s
                or _PAGE_MARKER.fullmatch(clean_s)
                or _PAGE_MARKER.fullmatch(stripped_s)
            ):
                continue
            s_start = match.start()
            s_end = match.end()
            page = _page_at_offset(s_start, page_markers)

            # Score sentence against normalized query keywords
            norm_s = normalize_for_match(clean_s)
            score = 0.0
            hits = 0
            for kw in keywords:
                count = norm_s.count(kw)
                if count > 0:
                    hits += 1
                    score += count * 1.0
            score += hits * 2.0  # Diversity bonus

            sentences.append({
                "text": s_text,
                "clean": clean_s,
                "start": s_start,
                "end": s_end,
                "page": page,
                "score": score,
            })

        if not sentences:
            fallback_text = raw_passage[:max_chars_per_passage].strip()
            if fallback_text and fallback_text not in seen_texts:
                seen_texts.add(fallback_text)
                distilled_pool.append({
                    "reference": orig_ref,
                    "passage": fallback_text,
                    "score": 0.0,
                })
            continue

        # Step 2: Identify scoring peak
        best_idx = 0
        max_score = -1.0
        for i, s in enumerate(sentences):
            if s["score"] > max_score:
                max_score = s["score"]
                best_idx = i

        # Step 3: Expand contiguous window around peak (1-2 neighbor sentences)
        start_idx = best_idx
        end_idx = best_idx
        peak_page = sentences[best_idx]["page"]

        # Expand backwards: at most 1 neighbor, strictly staying on the same page
        while start_idx > 0 and (best_idx - start_idx) < 1:
            candidate_s = sentences[start_idx - 1]
            if (
                peak_page is not None
                and candidate_s["page"] is not None
                and candidate_s["page"] != peak_page
            ):
                break
            candidate_start = candidate_s["start"]
            span_len = sentences[end_idx]["end"] - candidate_start
            if span_len <= max_chars_per_passage:
                start_idx -= 1
            else:
                break

        # Expand forward: at most 1 neighbor, strictly staying on the same page
        while end_idx < len(sentences) - 1 and (end_idx - best_idx) < 1:
            candidate_s = sentences[end_idx + 1]
            if (
                peak_page is not None
                and candidate_s["page"] is not None
                and candidate_s["page"] != peak_page
            ):
                break
            candidate_end = candidate_s["end"]
            span_len = candidate_end - sentences[start_idx]["start"]
            if span_len <= max_chars_per_passage:
                end_idx += 1
            else:
                break

        # Step 4: Extract verbatim span
        span_start = sentences[start_idx]["start"]
        span_end = sentences[end_idx]["end"]
        distilled_text = raw_passage[span_start:span_end].strip()

        # Step 5: Resolve exact page reference
        window_pages = sorted({
            s["page"] for s in sentences[start_idx : end_idx + 1] if s["page"] is not None
        })

        doc_match = _DOCUMENT_IN_REFERENCE.search(orig_ref)
        dataset = doc_match.group(1) if doc_match else None

        if dataset and window_pages:
            if window_pages[0] == window_pages[-1]:
                resolved_ref = f"document {dataset} (page {window_pages[0]})"
            else:
                resolved_ref = f"document {dataset} (pages {window_pages[0]}-{window_pages[-1]})"
        else:
            resolved_ref = orig_ref

        if distilled_text and distilled_text not in seen_texts:
            seen_texts.add(distilled_text)
            distilled_pool.append({
                "reference": resolved_ref,
                "passage": distilled_text,
                "score": max_score,
            })

    return distilled_pool

