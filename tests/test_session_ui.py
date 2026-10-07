from tests.conftest import REPO_ROOT

README = REPO_ROOT / "README.md"
UI = REPO_ROOT / "ui" / "index.html"
SERVE = REPO_ROOT / "ui" / "serve.py"
COMPOSE = REPO_ROOT / "compose.yaml"


def test_session_ui_is_farsi_first_rtl():
    html = UI.read_text(encoding="utf-8")
    assert 'lang="fa"' in html
    assert 'dir="rtl"' in html
    assert "طرح کلی اندیشۀ اسلامی در قرآن" in html


def test_session_ui_pins_first_answer_recall_contract():
    # Re-recorded for ADR-0018: the chat surface is the free
    # conversational agent — the composer POSTs /agent/chat and the
    # Book retrieval happens inside the agent's own tool (the
    # only_context lanes stay pinned server-side in ui/ask.py, behind
    # /agent/recall). The browser still names no Cognee search type at
    # all — the dive payloads are pinned server-side (issue #25).
    html = UI.read_text(encoding="utf-8")
    assert 'fetch("/agent/chat"' in html
    assert "tarhe-kolli" in html
    # Tightened from the COT-only assertion: any GRAPH_COMPLETION*
    # string must stay out of the sheet.
    assert "GRAPH_COMPLETION" not in html
    assert "sessionId" not in html


def test_session_ui_shows_citation_not_a_second_summary():
    html = UI.read_text(encoding="utf-8")
    assert "استناد" in html
    assert "دقیقه‌سازی" not in html


def test_session_ui_splits_answers_into_three_switchable_sections():
    # PM brief, 2026-09-11: each phase generates into its own section
    # with a distinct separation and tabs to switch between them, while
    # a line names the phase being generated.
    html = UI.read_text(encoding="utf-8")
    assert 'role="tablist"' in html
    for tab in ("tab-1", "tab-2", "tab-3"):
        assert f'id="{tab}"' in html
    for panel in ("panel-1", "panel-2", "panel-3"):
        assert f'id="{panel}"' in html
    assert "پاسخ اول" in html
    assert "پاسخ استنادی" in html
    # Phase 3 is Research Mode now (ADR-0008): the guided research
    # conversation — the superseded dive and auto-start names are gone.
    assert "حالت پژوهش" in html
    assert "مطالعۀ عمیق" not in html
    assert "جست‌وجوی سطح بعدی" not in html
    assert "selectPhase(" in html
    assert 'id="phase-now"' in html


def test_session_ui_server_proxies_recall_to_cognee():
    text = SERVE.read_text(encoding="utf-8")
    assert "/api/v1/recall" in text
    assert "/health" in text
    assert "8000" in text


def test_readme_records_session_ui_command():
    text = README.read_text(encoding="utf-8")
    assert "python ui/serve.py" in text
    assert "http://localhost:8765" in text


def test_session_ui_asks_with_retrieval_only_no_stream():
    # Re-recorded for ADR-0018: the chat is one JSON POST to
    # /agent/chat and the agent's answer rides back complete — no SSE
    # reader on the sheet, no TTFT chip (the elapsed clock times the
    # agent's whole turn: the model call and its tool rounds).
    html = UI.read_text(encoding="utf-8")
    assert 'fetch("/agent/chat"' in html
    assert "stream: true" not in html
    assert "TextDecoder" not in html
    assert 'id="ttft"' not in html
    # The Research Mode switch stays in the markup (hidden at launch,
    # ADR-0017 — the surface intact, not offered).
    assert 'id="research-mode"' in html
    assert "researchModeEl.checked" in html
    assert 'localStorage.setItem("researchMode"' in html


def test_session_ui_restores_the_last_ask_on_reload():
    # Re-recorded for ADR-0014/0018: the sheet re-fetches its persisted
    # agent transcript — every Question and its agent answer — so a
    # reload never throws the conversation away and never re-bills (the
    # restore re-reads the store; it never calls the agent).
    html = UI.read_text(encoding="utf-8")
    assert 'fetch("/agent/chat/history"' in html
    assert "restoreAgentChat" in html


def test_session_ui_server_relays_sse_without_buffering():
    text = SERVE.read_text(encoding="utf-8")
    assert "text/event-stream" in text
    assert "readline()" in text


def test_compose_enables_answer_streaming():
    # LLM_ANSWER_STREAMING stays on for the cognee service (its own
    # completions stream); the sheet's ask no longer consumes a stream
    # (ADR-0014), but the service pin itself is untouched.
    text = COMPOSE.read_text(encoding="utf-8")
    assert 'LLM_ANSWER_STREAMING: "true"' in text


def test_readme_records_streaming_seam():
    text = README.read_text(encoding="utf-8")
    assert "LLM_ANSWER_STREAMING" in text
    assert "نخستین توکن" not in text
    assert "accumulated prose" not in text


def test_readme_records_the_missing_key_fallbacks_truthfully():
    # Round-2 review (2026-09-12), re-recorded for ADR-0014: without the
    # composer key neither the Quote-selection picker nor the phase-2
    # composer can run — the first answer lands the honest
    # selection-missed note (there is no streamed prose to fall back to
    # any more) and phase 2's tab lands nothing while the pool stays
    # visible. The sentence's true half — start-ui.ps1 reads the key
    # into the process env, serve.py takes it from the host env — stays
    # locked.
    text = README.read_text(encoding="utf-8")
    assert (
        "`start-ui.ps1` reads `LLM_API_KEY` from `.env` into the process env"
        in text
    )
    assert (
        "takes the key from the host env, never from `.env` "
        "(that file is compose-only)" in text
    )
    assert "neither the Quote-selection picker nor the phase-2 composer can run" in text
    assert "the pool's own citations stay" in text
    assert "land nothing in phase 2's tab" in text
    assert "The Evidence pool is never rendered as a fallback" in text
    # The retired false claim never returns.
    assert "falls back to the Evidence list" not in text


def test_session_ui_composer_sends_on_enter():
    # Ticket #22 (ADR-0018): the composer is a chat box, not a document
    # editor — Enter sends the Question, Shift+Enter breaks a line (the
    # research input's established pattern). The keydown routes through
    # form.requestSubmit(), the real submit path, so mid-flight Enter
    # dies on the composer's own two latches: the disabled ask-btn (the
    # form's default submit button — requestSubmit no-ops on a disabled
    # submitter) and the submit handler's agentBusy guard — appending
    # nothing; both unlock in the handler's finally.
    html = UI.read_text(encoding="utf-8")
    assert 'questionEl.addEventListener("keydown"' in html
    assert 'event.key === "Enter" && !event.shiftKey' in html
    assert "form.requestSubmit()" in html
    assert "if (agentBusy) return;" in html


def test_session_ui_shows_the_question_window_count_beside_the_composer():
    # Ticket #23 (ADR-0017/0018): the Learner sees the Question window
    # at a glance — a Farsi-digit count beside the composer in the
    # actions row. One renderer, one shape: the restore read initializes
    # it (even for an empty transcript — a fresh Learner still sees a
    # full window) and every reply payload re-renders it, the 200 and
    # the 429 alike; a full window trades the count for the reopen
    # time, clocked client-side from the machine epoch the server sends
    # (the browser renders its own clock, in Farsi digits).
    html = UI.read_text(encoding="utf-8")
    assert 'id="window-count"' in html
    assert "renderWindowState" in html
    assert "پرسش مانده" in html
    assert 'toLocaleTimeString("fa-IR"' in html
    # Both feeders call the one renderer: the restore read and every
    # reply payload (before the !res.ok throw, so the 429 renders too).
    assert "renderWindowState(payload && payload.window)" in html
    assert "renderWindowState(payload.window)" in html


def test_session_ui_never_serves_from_stale_cache():
    # A browser that heuristically cached the page kept rendering the
    # pre-tab sheet after the container switchover (2026-09-11): every
    # response must carry Cache-Control: no-cache so loads revalidate.
    # Only the page rasters override it, with an explicit per-response
    # policy (_cache_policy — an immutable cache key of dataset, page,
    # and width bucket); the default stays no-cache.
    text = SERVE.read_text(encoding="utf-8")
    assert "Cache-Control" in text
    assert 'getattr(self, "_cache_policy", None) or "no-cache"' in text
    assert '"max-age=604800, immutable"' in text


def test_session_ui_renders_the_guaranteed_outside_the_book_marking():
    # Ticket #24 (ADR-0018): the «بیرون از کتاب» marking is the sheet's
    # guarantee, not the model's memory — the answer renderer takes the
    # structured web-sourced flag and sources (derived server-side from
    # the reply's tool-call record, never parsed from the prose), so the
    # marking chrome and the source links render even when the model's
    # own text carries no mark. The live reply and the reload's stored
    # form feed the SAME renderer.
    html = UI.read_text(encoding="utf-8")
    assert "function agentAnswerNode(answer, webSourced, sources)" in html
    # The marking chrome: a distinct badge named in Farsi.
    assert 'mark.textContent = "«بیرون از کتاب»"' in html
    assert 'className = "web-mark"' in html
    # The sources render as real safe anchors (agentLink), not prose —
    # and the renderer's own filter is scheme-guarded as defense-in-depth
    # beside the seam's guarantee (#24): only http(s) becomes an anchor.
    assert "agentLink(source.url" in html
    assert "/^https?:\\/\\//i.test(source.url)" in html
    # Both feeders pass the structured fields: the reply payload...
    assert "payload.web_sourced === true" in html
    assert "Array.isArray(payload.sources)" in html
    # ...and the restore read's stored per-message form.
    assert "message.web_sourced === true" in html
    assert "Array.isArray(message.sources)" in html
