"""Test suite for server-side page context resolution and transport seam (Ticket 01).

Acceptance criteria:
1. Resolves verbatim text for targeted page from local book text index.
2. Extracts boundary context (trailing paragraph of page-1, leading paragraph of page+1).
3. Missing or invalid targeted page degrades gracefully (returns None).
4. Assembled pageContext payload is passed into requestContext["pageContext"] by agent_client.
5. In serve._agent_chat, scope="page" with page resolves page context and forwards to agent upstream;
   invalid/missing page degrades gracefully to whole-book scope.
"""

import json
import os
import sys
from pathlib import Path

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from tests.helpers import stop_gate
from tests.test_agent_chat import agent_stream_ok, ask_agent, with_agent
from ui import agent_client, page_resolver, serve  # noqa: E402

PHONE = "09120000000"


def make_test_bookshelf(tmp_path, dataset="test-book"):
    """Create a temporary bookshelf with known pages and paragraphs."""
    shelf = tmp_path / "books"
    shelf.mkdir(parents=True, exist_ok=True)
    (shelf / f"{dataset}.pages.json").write_text(
        json.dumps(
            {
                "pages": {
                    "1": "متن آغازین کتاب در صفحه یک.\n\nپاراگراف دوم صفحه یک.",
                    "2": "پاراگراف اول صفحه دو.\n\nپاراگراف دوم صفحه دو.\n\nپاراگراف سوم صفحه دو.",
                    "3": "پاراگراف اول صفحه سه.\n\nپاراگراف دوم صفحه سه.",
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return shelf


def with_test_bookshelf(tmp_path, fn, dataset="test-book"):
    original_env = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(make_test_bookshelf(tmp_path, dataset))
    page_resolver.reset_cache()
    try:
        return fn()
    finally:
        page_resolver.reset_cache()
        if original_env is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_env


def test_get_page_context_extracts_verbatim_text_and_boundaries(tmp_path):
    def run():
        ctx = page_resolver.get_page_context("test-book", 2)
        assert ctx is not None
        assert ctx["book"] == "test-book"
        assert ctx["page"] == 2
        assert "پاراگراف اول صفحه دو." in ctx["text"]
        assert "پاراگراف سوم صفحه دو." in ctx["text"]
        # Boundary context: trailing paragraph of page 1
        assert ctx["prev_page"] == 1
        assert ctx["prev_paragraph"] == "پاراگراف دوم صفحه یک."
        # Boundary context: leading paragraph of page 3
        assert ctx["next_page"] == 3
        assert ctx["next_paragraph"] == "پاراگراف اول صفحه سه."
        # Unused formatted field must not be present
        assert "formatted" not in ctx
        # Forbidden domain term dataset must not be present (ADR/CONTEXT.md domain entity is Book)
        assert "dataset" not in ctx

    with_test_bookshelf(tmp_path, run)


def test_extract_paragraphs_cleans_controls_and_splits_single_newline_blocks():
    raw = (
        "جمله\x08اول\x08از\x08پاراگراف\x08اول\x08در\x08این\x08صفحه.\n"
        "جمله\x08دوم\x08از\x08پاراگراف\x08دوم\x08که\x08در\x08چند\x08سطر\n"
        "ادامه\x08پیدا\x08می‌کند\x08و\x08اینجا\x08تمام\x08می‌شود.\n"
        "سطر\x08پایانی\x08پاراگراف\x08سوم!"
    )
    paras = page_resolver._extract_paragraphs(raw)
    assert len(paras) == 3
    assert "\x08" not in paras[0]
    assert paras[0] == "جمله اول از پاراگراف اول در این صفحه."
    assert (
        paras[1]
        == "جمله دوم از پاراگراف دوم که در چند سطر ادامه پیدا می‌کند و اینجا تمام می‌شود."
    )
    assert paras[2] == "سطر پایانی پاراگراف سوم!"


def test_extract_paragraphs_on_real_book_page():
    pages = page_resolver._dataset_raw_pages("tarhe-kolli")
    assert pages is not None
    p12_text = pages["12"]
    paras = page_resolver._extract_paragraphs(p12_text)
    assert len(paras) > 1
    for p in paras:
        assert "\x08" not in p



def test_get_page_context_boundary_at_first_and_last_page(tmp_path):
    def run():
        # Page 1 has no previous page
        ctx_first = page_resolver.get_page_context("test-book", 1)
        assert ctx_first is not None
        assert ctx_first["prev_paragraph"] is None
        assert ctx_first["prev_page"] is None
        assert ctx_first["next_page"] == 2
        assert ctx_first["next_paragraph"] == "پاراگراف اول صفحه دو."

        # Page 3 has no next page
        ctx_last = page_resolver.get_page_context("test-book", 3)
        assert ctx_last is not None
        assert ctx_last["prev_page"] == 2
        assert ctx_last["prev_paragraph"] == "پاراگراف سوم صفحه دو."
        assert ctx_last["next_paragraph"] is None
        assert ctx_last["next_page"] is None

    with_test_bookshelf(tmp_path, run)


def test_get_page_context_returns_none_for_missing_or_invalid_page(tmp_path):
    def run():
        # Non-existent page number
        assert page_resolver.get_page_context("test-book", 99) is None
        # Invalid / non-positive page numbers
        assert page_resolver.get_page_context("test-book", 0) is None
        assert page_resolver.get_page_context("test-book", -1) is None
        assert page_resolver.get_page_context("test-book", "not-a-number") is None
        # Non-existent dataset
        assert page_resolver.get_page_context("non-existent-book", 1) is None

    with_test_bookshelf(tmp_path, run)


def test_agent_client_transports_page_context():
    page_ctx = {
        "book": "test-book",
        "page": 2,
        "text": "متن صفحه دو",
        "prev_paragraph": "پاراگراف قبلی",
        "next_paragraph": "پاراگراف بعدی",
    }
    body = agent_client._request_body(
        "پرسش تست",
        ["test-book"],
        "thread-1",
        page_context=page_ctx,
    )
    assert "pageContext" in body["requestContext"]
    assert body["requestContext"]["pageContext"] == page_ctx


def test_agent_chat_resolves_and_forwards_page_context(tmp_path):
    """When scope='page' and page is provided, serve._agent_chat resolves
    page context and sends it to agent upstream under requestContext.pageContext."""
    shelf = make_test_bookshelf(tmp_path, dataset="tarhe-kolli")
    original_books = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()

    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ تست")]
    )
    try:
        status, ctype, frames = ask_agent(
            base,
            {
                "query": "این صفحه چه می‌گوید؟",
                "datasets": ["tarhe-kolli"],
                "scope": "page",
                "page": 2,
                "book": "tarhe-kolli",
            },
        )
        assert status == 200
        assert len(upstream.payloads) == 1
        req_ctx = upstream.payloads[0].get("requestContext", {})
        assert "pageContext" in req_ctx
        page_ctx = req_ctx["pageContext"]
        assert page_ctx["page"] == 2
        assert page_ctx["book"] == "tarhe-kolli"
        assert "پاراگراف اول صفحه دو." in page_ctx["text"]
    finally:
        stop_gate(server, original)
        page_resolver.reset_cache()
        if original_books is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_books


def test_agent_chat_gracefully_degrades_when_page_missing(tmp_path):
    """When scope='page' but targeted page is missing, the request degrades
    gracefully to whole-book scope (no pageContext) without failing the turn."""
    shelf = make_test_bookshelf(tmp_path, dataset="tarhe-kolli")
    original_books = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()

    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ تست")]
    )
    try:
        status, ctype, frames = ask_agent(
            base,
            {
                "query": "این صفحه چه می‌گوید؟",
                "datasets": ["tarhe-kolli"],
                "scope": "page",
                "page": 999,  # Missing page
                "book": "tarhe-kolli",
            },
        )
        assert status == 200
        assert len(upstream.payloads) == 1
        req_ctx = upstream.payloads[0].get("requestContext", {})
        # Degraded gracefully: no pageContext attached
        assert "pageContext" not in req_ctx
    finally:
        stop_gate(server, original)
        page_resolver.reset_cache()
        if original_books is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_books


def test_agent_client_transports_selection_text():
    sel_ctx = {
        "text": "فراز انتخاب شده",
        "page": 2,
        "book": "tarhe-kolli",
    }
    body = agent_client._request_body(
        "پرسش تست",
        ["tarhe-kolli"],
        "thread-1",
        selection_text=sel_ctx,
    )
    assert "selectionText" in body["requestContext"]
    assert body["requestContext"]["selectionText"] == sel_ctx


def test_agent_chat_forwards_selection_context(tmp_path):
    """When selection is provided in payload, serve._agent_chat normalizes it
    and forwards it upstream under requestContext.selectionText."""
    shelf = make_test_bookshelf(tmp_path, dataset="tarhe-kolli")
    original_books = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()

    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ تست")]
    )
    try:
        status, ctype, frames = ask_agent(
            base,
            {
                "query": "معنای این عبارت چیست؟",
                "datasets": ["tarhe-kolli"],
                "selection": {
                    "text": "پاراگراف اول صفحه دو.",
                    "page": 2,
                    "book": "tarhe-kolli",
                },
            },
        )
        assert status == 200
        assert len(upstream.payloads) == 1
        req_ctx = upstream.payloads[0].get("requestContext", {})
        assert "selectionText" in req_ctx
        sel_ctx = req_ctx["selectionText"]
        assert sel_ctx["text"] == "پاراگراف اول صفحه دو."
        assert sel_ctx["page"] == 2
        assert sel_ctx["book"] == "tarhe-kolli"
    finally:
        stop_gate(server, original)
        page_resolver.reset_cache()
        if original_books is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_books


def test_agent_chat_normalizes_string_selection_with_outer_page_and_book(tmp_path):
    """When selection is a string, it is normalized to an object with text,
    page and book from the request payload."""
    shelf = make_test_bookshelf(tmp_path, dataset="tarhe-kolli")
    original_books = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()

    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ تست")]
    )
    try:
        status, ctype, frames = ask_agent(
            base,
            {
                "query": "این متن چه می‌گوید؟",
                "datasets": ["tarhe-kolli"],
                "page": 2,
                "book": "tarhe-kolli",
                "selection": "فراز انتخاب شده به عنوان رشته",
            },
        )
        assert status == 200
        assert len(upstream.payloads) == 1
        req_ctx = upstream.payloads[0].get("requestContext", {})
        assert "selectionText" in req_ctx
        sel_ctx = req_ctx["selectionText"]
        assert sel_ctx["text"] == "فراز انتخاب شده به عنوان رشته"
        assert sel_ctx["page"] == 2
        assert sel_ctx["book"] == "tarhe-kolli"
    finally:
        stop_gate(server, original)
        page_resolver.reset_cache()
        if original_books is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_books


def test_agent_chat_ignores_empty_or_whitespace_selection(tmp_path):
    """Empty or blank selection is ignored and not sent in requestContext."""
    shelf = make_test_bookshelf(tmp_path, dataset="tarhe-kolli")
    original_books = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()

    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ تست")]
    )
    try:
        status, ctype, frames = ask_agent(
            base,
            {
                "query": "پرسش عمومی",
                "datasets": ["tarhe-kolli"],
                "selection": "   ",
            },
        )
        assert status == 200
        assert len(upstream.payloads) == 1
        req_ctx = upstream.payloads[0].get("requestContext", {})
        assert "selectionText" not in req_ctx
    finally:
        stop_gate(server, original)
        page_resolver.reset_cache()
        if original_books is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_books


def test_normalize_selection():
    from ui.agent_client import normalize_selection

    # None, non-string, non-dict, and whitespace variants
    assert normalize_selection(None) is None
    assert normalize_selection("") is None
    assert normalize_selection("   ") is None
    assert normalize_selection({}) is None
    assert normalize_selection({"text": ""}) is None
    assert normalize_selection({"text": "   "}) is None
    assert normalize_selection(123) is None

    # Dict selection with explicit page and book
    res = normalize_selection(
        {"text": "  عبارت منتخب  ", "page": 10, "book": "tarhe-kolli"},
        default_page=2,
        default_book="other-book",
    )
    assert res == {
        "text": "عبارت منتخب",
        "page": 10,
        "book": "tarhe-kolli",
    }

    # Dict selection with fallback to default_page and default_book
    res2 = normalize_selection(
        {"text": "  عبارت منتخب  "},
        default_page=5,
        default_book="tarhe-kolli",
    )
    assert res2 == {
        "text": "عبارت منتخب",
        "page": 5,
        "book": "tarhe-kolli",
    }

    # String selection with defaults
    res3 = normalize_selection(
        "  فراز به عنوان رشته  ",
        default_page=8,
        default_book="tarhe-kolli",
    )
    assert res3 == {
        "text": "فراز به عنوان رشته",
        "page": 8,
        "book": "tarhe-kolli",
    }

    # String selection without defaults
    res4 = normalize_selection("فراز خالص")
    assert res4 == {"text": "فراز خالص"}


def test_get_page_context_multi_page_interval(tmp_path):
    """Multi-page interval resolution resolves all pages in range and boundary context."""
    def run():
        ctx = page_resolver.get_page_context("test-book", pages=[2, 3])
        assert ctx is not None
        assert ctx["book"] == "test-book"
        assert ctx["page"] == 2
        assert ctx["last_page"] == 3
        assert ctx["pages"] == [2, 3]
        assert "پاراگراف اول صفحه دو." in ctx["text"]
        assert "پاراگراف دوم صفحه سه." in ctx["text"]
        # Boundary context: start_page - 1 = 1
        assert ctx["prev_page"] == 1
        assert ctx["prev_paragraph"] == "پاراگراف دوم صفحه یک."
        # Boundary context: end_page + 1 = 4 does not exist
        assert ctx["next_page"] is None
        assert ctx["next_paragraph"] is None

    with_test_bookshelf(tmp_path, run)


def test_get_page_context_multi_page_length_budget(tmp_path):
    """Multi-page interval stops adding pages once length budget (~12,000 chars) is reached."""
    shelf = tmp_path / "books"
    shelf.mkdir(parents=True, exist_ok=True)
    # Page 1: 5000 chars, Page 2: 5000 chars, Page 3: 5000 chars. Total 1+2 = 10,000 <= 12,000; +3 = 15,000 > 12,000.
    (shelf / "budget-book.pages.json").write_text(
        json.dumps(
            {
                "pages": {
                    "1": "ا" * 5000,
                    "2": "ب" * 5000,
                    "3": "ج" * 5000,
                    "4": "د" * 100,
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    original_env = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()
    try:
        ctx = page_resolver.get_page_context("budget-book", pages=[1, 2, 3, 4])
        assert ctx is not None
        assert ctx["page"] == 1
        assert ctx["last_page"] == 2
        assert ctx["pages"] == [1, 2]
        assert len(ctx["text"]) <= 12000
        assert ctx["next_page"] == 3
    finally:
        page_resolver.reset_cache()
        if original_env is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_env


def test_agent_chat_forwards_page_interval(tmp_path):
    """When scope='page' and pages=[2, 3] are provided, serve._agent_chat resolves
    the multi-page interval and forwards pageContext upstream."""
    shelf = make_test_bookshelf(tmp_path, dataset="tarhe-kolli")
    original_books = os.environ.get("SESSION_BOOKS_DIR")
    os.environ["SESSION_BOOKS_DIR"] = str(shelf)
    page_resolver.reset_cache()

    upstream, base, server, original = with_agent(
        tmp_path, [agent_stream_ok("پاسخ تست")]
    )
    try:
        status, ctype, frames = ask_agent(
            base,
            {
                "query": "این صفحات چه می‌گویند؟",
                "datasets": ["tarhe-kolli"],
                "scope": "page",
                "page": 2,
                "pages": [2, 3],
                "book": "tarhe-kolli",
            },
        )
        assert status == 200
        assert len(upstream.payloads) == 1
        req_ctx = upstream.payloads[0].get("requestContext", {})
        assert "pageContext" in req_ctx
        page_ctx = req_ctx["pageContext"]
        assert page_ctx["page"] == 2
        assert page_ctx["last_page"] == 3
        assert page_ctx["pages"] == [2, 3]
        assert page_ctx["book"] == "tarhe-kolli"
        assert "پاراگراف اول صفحه دو." in page_ctx["text"]
        assert "پاراگراف دوم صفحه سه." in page_ctx["text"]
    finally:
        stop_gate(server, original)
        page_resolver.reset_cache()
        if original_books is None:
            os.environ.pop("SESSION_BOOKS_DIR", None)
        else:
            os.environ["SESSION_BOOKS_DIR"] = original_books




