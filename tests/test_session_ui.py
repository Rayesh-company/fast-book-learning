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
    # Re-recorded for #26: the PM's 2026-10-06 streamed decision
    # (parent #21) reverses ADR-0014's non-streamed posture on the
    # AGENT surface only — /agent/chat is an SSE stream consumer now
    # (getReader + TextDecoder over the seam's unbuffered relay), while
    # the retired retrieval ask keeps ADR-0014's shape: plain JSON
    # fetches, answers complete. No TTFT chip anywhere (the elapsed
    # clock still times the agent's whole turn: the model call and its
    # tool rounds).
    html = UI.read_text(encoding="utf-8")
    assert 'fetch("/agent/chat"' in html
    assert "res.body.getReader()" in html
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
    # actions row. One renderer, one shape. Since #26 the feeders are
    # three: the history read initializes the counter (even for an
    # empty transcript — a fresh Learner still sees a full window), the
    # finalize frame re-renders it after each answered Question, and
    # the 429's payload re-renders it on the refusal itself; a full
    # window trades the count for the reopen time, clocked client-side
    # from the machine epoch the server sends (the browser renders its
    # own clock, in Farsi digits).
    html = UI.read_text(encoding="utf-8")
    assert 'id="window-count"' in html
    assert "renderWindowState" in html
    assert "پرسش مانده" in html
    assert 'toLocaleTimeString("fa-IR"' in html
    # All three feeders call the one renderer: the restore read, the
    # gate branch (before the !res.ok throw, so the 429 renders too),
    # and the finalize frame.
    assert "renderWindowState(payload && payload.window)" in html
    assert "renderWindowState(payload.window)" in html
    assert "renderWindowState(finalized.window);" in html


def test_session_ui_agent_answers_render_live_book_citations():
    # Ticket #25 (ADR-0018): a Book reference inside an agent answer
    # renders interactive and opens the reader on the cited Book's page
    # beside the chat. The agent is instructed to copy the search
    # tool's reference verbatim, so the machine form it cites in is
    # parseReference's own — and the detection rides agentParagraphNode,
    # the ONE paragraph renderer both the live reply and the reload's
    # restore feed (agentAnswerNode calls it on both paths), so the
    # restored answers keep the same live citations with no server
    # change and no re-billing.
    html = UI.read_text(encoding="utf-8")
    # The detection regex: parseReference's exact two page shapes —
    # "(pages N-M)" and "(page N)", ASCII digits (the seam formats
    # them so). A reference with no page markers ("document X" alone)
    # does NOT match and stays plain text: the pages are unknown and
    # the sheet never invents a page (CONTEXT.md's Citation rule) —
    # opening nothing beats opening page 1 blind.
    assert (
        "/document ([A-Za-z0-9._-]+) \\((?:pages \\d+-\\d+|page \\d+)\\)/g" in html
    )
    # The citation pass runs ONLY on the plain-text parts left after
    # the link splitter (the markdown/bare-URL split agentParagraphNode
    # already performs), so a citation can never swallow a URL or a
    # markdown link label, and a link never eats a citation — a
    # paragraph may carry both.
    assert "for (const match of part.matchAll(AGENT_CITATION))" in html
    assert "p.append(agentCiteNode(match[0]));" in html
    # The interactive span: the quote span's cite-sent affordances plus
    # the agent variant, resolved through the EXISTING machinery
    # (parseReference — never a second parser) and wired with the data
    # attributes the delegated reader handlers read, Farsi hint
    # included. Deliberately NOT wireQuoteSpan: its locatorPassages
    # memory exists so a «منابع» line's click can look up a real quote
    # passage (ADR-0010), and a reference string is not a passage —
    # registering it would send that fallback hunting for text no Book
    # page holds.
    assert 'span.className = "cite-sent agent-cite";' in html
    assert "const located = parseReference(reference);" in html
    assert "span.dataset.doc = located.doc;" in html
    builder = html[
        html.index("function agentCiteNode") : html.index(
            "function agentParagraphNode"
        )
    ]
    assert "span.tabIndex = 0;" in builder
    assert "span.dataset.pages =" in builder
    assert 'span.dataset.hint = "برای دیدن در کتاب کلیک کنید";' in builder
    assert "wireQuoteSpan" not in builder
    # The visual language: the quote span's hover/focus affordances,
    # reading as a reference rather than a quote (dotted underline, no
    # resting tint).
    assert ".cite-sent.agent-cite {" in html


def test_session_ui_agent_citations_open_the_reader_without_a_highlight():
    # Ticket #25: activating an agent citation (click or keyboard — the
    # quote span's own parity) opens the cited Book's page through the
    # same openCitation, but with EMPTY text: the reference names a
    # locator, not a passage, so the reader must never try to highlight
    # it — openCitation's clean-open branch (no pending, no note). The
    # agent branch precedes the quote-span branch in both delegated
    # handlers because an agent citation carries cite-sent too.
    html = UI.read_text(encoding="utf-8")
    assert "function openAgentCitation(el)" in html
    assert "openCitation(located.doc, located.first, located.last, \"\")" in html
    # The delegated click: the agent branch first, then the quote span.
    assert 'closest("span.agent-cite")' in html
    assert html.index('closest("span.agent-cite")') < html.index(
        'closest("span.cite-sent")'
    )
    # The keyboard parity: same branch order inside the Enter/Space
    # handler.
    assert 'classList.contains("agent-cite")' in html
    assert html.index('classList.contains("agent-cite")') < html.index(
        "openCitationFromElement(event.target)"
    )


def test_session_ui_page_jumps_are_instant_not_css_smooth():
    # Ticket #25 fixup: gotoPage asked scrollTo for behavior:"auto"
    # under a comment claiming "Instant, not smooth" — but the sheet's
    # own CSS pins .reader-pages { scroll-behavior: smooth }, and the
    # CSSOM overrides the call's "auto" with an animated smooth scroll
    # (the browser gate measured ~1.3s compositor animations on every
    # citation jump; page 1 to 400+ would glide for seconds).
    # "instant" is the one value that beats the CSS rule, so the jump
    # site must state it explicitly AND name the trap in the comment.
    # The CSS rule itself stays pinned — other reader scrolling keeps
    # its smooth.
    html = UI.read_text(encoding="utf-8")
    goto = html[
        html.index("async function gotoPage") : html.index(
            "function sweepFarPages"
        )
    ]
    assert 'behavior: "instant",' in goto
    assert 'behavior: "auto"' not in goto
    assert "scroll-behavior: smooth" in goto
    assert 'overrides behavior:"auto"' in goto
    # The CSS rule the jump must coexist with, not remove.
    assert "scroll-behavior: smooth;" in html


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
    # Both feeders pass the structured fields: the live stream's
    # finalize frame (#26)...
    assert "finalized.web_sourced === true" in html
    assert "Array.isArray(finalized.sources)" in html
    # ...and the restore read's stored per-message form.
    assert "message.web_sourced === true" in html
    assert "Array.isArray(message.sources)" in html


def test_session_ui_streams_the_agent_answer_progressively():
    # Ticket #26 (ADR-0018): the composer's fetch becomes a stream
    # consumer — the answer grows in the bubble as the agent composes it
    # (the seam relays the Mastra text-delta frames unbuffered), the
    # seam's OWN finalize frame replaces the bubble with the full-chrome
    # agentAnswerNode plus the window counter, and the error frame (or a
    # dead stream, or the gates' non-OK JSON) lands the honest notice
    # with the composer re-enabled. Progressive rendering touches ONLY
    # the streaming bubble — never the whole transcript per delta.
    html = UI.read_text(encoding="utf-8")
    # The stream consumer: the body rides getReader(), the SSE events
    # split on the blank line, and the three frame kinds dispatch.
    assert "res.body.getReader()" in html
    assert 'buffer.indexOf("\\n\\n")' in html
    assert 'event.startsWith("data: ")' in html
    assert 'frame.type === "text-delta"' in html
    assert 'frame.type === "chat-answer-finalized"' in html
    assert 'frame.type === "chat-answer-error"' in html
    # The delta appends into a growing plain-text bubble — the same
    # paragraph split the finalized renderer uses (agentAnswerNode's
    # /\n{2,}/), and only that bubble's own paragraphs re-render.
    assert "function agentStreamingNode()" in html
    assert "accumulated.split(/\\n{2,}/)" in html
    # The finalize frame carries the full chrome: the answer, the
    # guaranteed marking, the sources, and the window counter (issue
    # #23's one renderer on the streamed path).
    assert "renderWindowState(finalized.window);" in html
    assert "finalized.web_sourced === true" in html
    assert "Array.isArray(finalized.sources)" in html
    # The finalize replaces the STREAMING bubble (not the waiting line —
    # the waiting line was already replaced when the stream opened).
    assert "streaming.node.replaceWith(agentAnswerNode(" in html
    # A failed/stalled/dead stream lands the honest notice on the
    # streaming bubble and the composer's finally re-enables + clears.
    assert "streaming.node.replaceWith(agentNoticeNode(" in html
    submit = html[html.index('form.addEventListener("submit"') : html.index(
        "questionEl.addEventListener(\"keydown\""
    )]
    assert "agentBusy = false;" in submit
    assert "questionEl.value = \"\";" in submit
    # The honest failure texts are SINGLE-SOURCED (#21 fixup): the two
    # constants at the top of the chat-agent section — the sheet's
    # twins of ui/agent_client's own AGENT_FAILED_DETAIL /
    # AGENT_UNREACHABLE_DETAIL, the words the error frame itself
    # carries. Each full wording (retry clause «دوباره بپرسید.»
    # included) appears exactly ONCE — the definition — and every
    # failure branch reads the constants: the error frame's fallback,
    # the no-body branch, the dead stream, and the catch's
    # Failed-to-fetch mapping (the dead-stream and no-body branches
    # once dropped the retry clause with no pin to catch the drift).
    assert "const AGENT_FAILED_DETAIL" in html
    assert "const AGENT_UNREACHABLE_DETAIL" in html
    assert html.count("عامل گفت‌وگو پاسخ نداد؛ دوباره بپرسید.") == 1
    assert html.count("ارتباط با عامل گفت‌وگو قطع شد؛ دوباره بپرسید.") == 1
    assert "frame.detail || AGENT_FAILED_DETAIL" in html
    # 3 = the definition, the frame-fallback site, and the comment
    # naming the twin; 5 = the definition, the three sites, and the
    # comment — any inline copy that creeps back moves the count.
    assert html.count("AGENT_FAILED_DETAIL") == 3
    assert html.count("AGENT_UNREACHABLE_DETAIL") == 5


def test_session_ui_pins_the_phone_width_responsive_base():
    # Ticket #27: the chat environment is usable on a phone (~375px) —
    # the responsive base ONLY (the full mobile conversation-home
    # design stays with #20). One media block owns it: the root stays
    # single-column (the chat IS the page; the reader is the
    # sub-1024px full-screen layer it already was, so closing it
    # recovers the chat — AC-3), the composer's rows fold instead of
    # overflowing (AC-1), and long unbreakable strings — the URLs the
    # agent relays in prose and the «بیرون از کتاب» source list
    # labels verbatim — wrap INSIDE the message, the RTL sheet's
    # likeliest horizontal-scroll source (AC-2). The browser gate at
    # 375px is the ACs' evidence; these pins hold the block's
    # load-bearing rules so a refactor cannot silently unfold them.
    html = UI.read_text(encoding="utf-8")
    assert "@media (max-width: 480px)" in html
    phone = html[
        html.index("@media (max-width: 480px)") : html.index("</style>")
    ]
    # The single-column root: even with the reader open the body stays
    # ONE column — a future grid must not creep under 480px. The chat
    # recovers by closing the reader, whose overlay rule stays pinned
    # below (the same fixed inset-0 layer it already was before #27).
    assert "body.reader-open {" in phone
    assert "display: block;" in phone[: phone.index("main {")]
    overlay = html[
        html.index("@media (max-width: 1023.98px)") : html.index(
            ".reader-head {"
        )
    ]
    assert "#reader:not([hidden]) {" in overlay
    assert "position: fixed;" in overlay
    assert "inset: 0;" in overlay
    # The composer folds: the header's status row and the ask's actions
    # row (send + window count + elapsed) wrap instead of overflowing.
    assert ".status-row {" in phone
    assert ".actions {" in phone
    rows = phone[phone.index(".status-row {") : phone.index(".agent-msg {")]
    assert rows.count("flex-wrap: wrap;") == 2
    # Long unbreakable strings wrap inside the message contents —
    # inherited by the anchors and citation spans inside, so a relayed
    # URL or reference never pushes the sheet past the viewport.
    assert ".agent-msg {" in phone
    assert "overflow-wrap: anywhere;" in phone[
        phone.index(".agent-msg {") : phone.index(".reader-head {")
    ]
    # The reader's head folds at phone width: the Book pills take their
    # own wrapped row (order after the close, full-width basis) so the
    # title, both pills, and the close stay reachable — no overflow
    # inside the fixed overlay.
    assert ".reader-head {" in phone
    assert "flex-wrap: wrap;" in phone[
        phone.index(".reader-head {") : phone.index(".reader-books {")
    ]
    books = phone[phone.index(".reader-books {") :]
    assert "order: 3;" in books
    assert "flex-basis: 100%;" in books
    assert "flex-wrap: wrap;" in books


def test_session_ui_server_relays_the_streamed_agent_answer_unbuffered():
    # Ticket #26's server side: /agent/chat past its gates is an SSE
    # endpoint — close-delimited (no Content-Length), each relayed line
    # written as it arrives — and the metering is completion-anchored:
    # record_question and record_agent_exchange run only on the
    # completed answer, after the relay loop, never on the error path.
    # The abandoned branch (a Learner whose connection died mid-stream)
    # aborts the upstream and returns BEFORE any metering — the browser
    # gate exercises the disconnect itself; this pin holds the ordering.
    text = SERVE.read_text(encoding="utf-8")
    handler = text[
        text.index("def _agent_chat(self, phone: str)") : text.index(
            "def _agent_chat_history(self)"
        )
    ]
    assert 'self.send_header("Content-Type", "text/event-stream' in handler
    assert "AgentStream(" in handler
    # The unbuffered relay: one line at a time onto the socket, the
    # _relay close-delimited pattern.
    assert "self.wfile.write(line)" in handler
    # Completion-anchored metering: both writes sit AFTER the relay loop
    # and behind the completed-reply guard, never on the error path; the
    # finalize frame rides the seam's own line builder and terminal
    # frame name (the error frame's name and text are pinned on the
    # seam tests' wire assertions).
    assert "record_question(phone)" in handler
    assert "record_agent_exchange(" in handler
    assert "sse_frame(" in handler
    assert "CHAT_ANSWER_FINALIZED" in handler
    assert handler.index("self.wfile.write(line)") < handler.index(
        "record_question(phone)"
    )
    # The abandoned branch: abort and return, meter nothing.
    abort_branch = handler[
        handler.index("stream.abort()") : handler.index("record_question(phone)")
    ]
    assert "return" in abort_branch
