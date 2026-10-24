"""The import seam between serve.py and the deep modules behind it —
ONE binding list resolved in both run modes, so script mode can never
drift from package mode again.

serve.py runs two ways: imported as `ui.serve` by the tests (package
mode — the modules the tests patch in place are the `ui.*` objects in
sys.modules, and the in-process sheet server must read exactly those)
and executed as `python ui/serve.py` in the container (script mode —
ui/ itself is sys.path[0], so the same files resolve top-level). Until
this module the facade kept TWO hand-synced import blocks
joined by try/except ImportError, and the parity was manual: commit
5f7edc9 records the failure — the script-mode block drifted, the first
production /agent/chat answered NameError, and only the live e2e run
caught it.

Here the try/except runs ONCE over module OBJECTS (never over the bound
names), and every re-export below names its origin module on its own
line — one binding list, one mode switch, nothing left to keep in
step. serve.py star-imports that list (`from ui.seam import *` in
package mode, `from seam import *` in script mode): its parity surface
is that single module name. tests/test_serve_seam.py pins the
construction — both modes loaded in one process must expose the same
public names, so the 5f7edc9 class dies under a test, not a live run.
"""

from __future__ import annotations

try:
    # Package mode: identity with the modules the tests patch — the
    # `question_window` bound below IS sys.modules["ui.question_window"],
    # so a test's `question_window.WINDOW_DB = tmp` is seen by the
    # sheet server serve.py's handlers run.
    from ui import (
        accounts,
        agent_client,
        ask,
        chat_store,
        composer,
        dive,
        guard,
        ledger,
        page_resolver,
        picker,
        question_window,
        quotas,
        recall_more,
        report,
        research,
    )
except ImportError:  # the container runs serve.py as a script beside the modules
    # Script mode: ui/ is sys.path[0] and the repo root is nowhere on
    # the path, so the same files import top-level. The module set is
    # the one list — a new deep module joins BOTH branches here, once.
    import accounts
    import agent_client
    import ask
    import chat_store
    import composer
    import dive
    import guard
    import ledger
    import page_resolver
    import picker
    import question_window
    import quotas
    import recall_more
    import report
    import research

# --- the binding list: one line per name, origin named on the line ----
# A maintainer grepping a name lands on its assignment and reads the
# origin module in the same breath — one hop, no second block to check.

# guard — the verbatim-quote guard
book_label = guard.book_label
first_page_label = guard.first_page_label
guard_blocks = guard.guard_blocks
guard_sentences = guard.guard_sentences
normalize_for_match = guard.normalize_for_match
pages_label = guard.pages_label
parse_quoted_reply = guard.parse_quoted_reply

# quotas — the daily-chat gate
DAILY_CHAT_LIMIT = quotas.DAILY_CHAT_LIMIT
chats_today = quotas.chats_today
is_unlimited = quotas.is_unlimited
normalize_phone = quotas.normalize_phone
record_chat = quotas.record_chat

# accounts — identity and Balance (ADR-0013)
account_by_email = accounts.account_by_email
create_account = accounts.create_account
deduct_balance = accounts.deduct_balance
get_balance = accounts.get_balance
verify_login = accounts.verify_login

# composer — the quoted-answer composer (ADR-0003)
COMPOSER_MAX_TOKENS = composer.COMPOSER_MAX_TOKENS
COMPOSER_TIMEOUT = composer.COMPOSER_TIMEOUT
build_continuation_prompt = composer.build_continuation_prompt
build_planner_prompt = composer.build_planner_prompt
build_quoted_prompt = composer.build_quoted_prompt
compose_quoted_answer = composer.compose_quoted_answer
set_meter = composer.set_meter

# ledger — the metering tap (T22). The MODULE rides too: serve.py
# wires ledger.set_deductor at import time, and the tests patch
# ui.ledger.LEDGER_DB in place.
record_composer_call = ledger.record_composer_call
record_size_estimate = ledger.record_size_estimate
session_total = ledger.session_total
today_total = ledger.today_total

# picker — the Quote selection (issue #28)
build_picker_prompt = picker.build_picker_prompt
parse_picker_reply = picker.parse_picker_reply
pick_quote_selection = picker.pick_quote_selection

# recall_more — the widen. The last line shadows the module: the
# `recall_more` serve.py sees is the module's widen FUNCTION, exactly
# the binding the old from-imports gave it.
recall_more = recall_more.recall_more

# page_resolver — the reader's citation locator; install, aliased the
# way serve.py calls it.
install_page_resolver = page_resolver.install

# dive — the Next-tier kernel (issue #25)
BOOK_DATASETS = dive.BOOK_DATASETS
NEXT_TIER_URL = dive.NEXT_TIER_URL
dive_recall = dive.dive_recall
parse_evidence_sources = dive.parse_evidence_sources

# report — Research Mode's Brief
research_session_report = report.research_session_report

# chat_store — the ask's persistence (ADR-0014). The MODULE rides too:
# serve.py calls chat_store.* per route, and the tests patch
# ui.chat_store.CHAT_DB in place.
latest_chat = chat_store.latest_chat

# ask — the retrieval-only first answer (ADR-0014)
ask_pool = ask.ask_pool

# agent_client — the Mastra seam, streamed (issue #26)
CHAT_ANSWER_FINALIZED = agent_client.CHAT_ANSWER_FINALIZED
AgentStream = agent_client.AgentStream
sse_frame = agent_client.sse_frame

# question_window — the 30-per-5-hours window (issue #23)
record_question = question_window.record_question
window_state = question_window.window_state

# research — Research Mode (ADR-0008)
RESEARCH_SESSION_NOT_FOUND_DETAIL = research.RESEARCH_SESSION_NOT_FOUND_DETAIL
RESEARCH_TURN_NOT_FOUND_DETAIL = research.RESEARCH_TURN_NOT_FOUND_DETAIL
abort_account_research = getattr(research, "abort_account_research", getattr(research, "abort_phone_research", None))
abort_phone_research = abort_account_research
decide_proposal = research.decide_proposal
ensure_session = research.ensure_session
find_turn = research.find_turn
research_session_messages = research.research_session_messages
research_session_state = research.research_session_state
start_research_turn = research.start_research_turn
turn_status_payload = research.turn_status_payload

# The canonical enumeration: serve.py's star import re-exports exactly
# these names, and tests/test_serve_seam.py reads this list as the
# ground truth of the facade's public surface. A name bound above but
# missing here never reaches serve.py, and every name here IS bound —
# the architecture review's prune (the retired surfaces left ~50 dead
# bindings behind) keeps the list to what serve.py's body actually
# reads, so the facade states the live interface, not the history.
__all__ = [
    # guard
    "book_label",
    "first_page_label",
    "guard_blocks",
    "guard_sentences",
    "normalize_for_match",
    "pages_label",
    "parse_quoted_reply",
    # quotas
    "DAILY_CHAT_LIMIT",
    "chats_today",
    "is_unlimited",
    "normalize_phone",
    "record_chat",
    # accounts
    "account_by_email",
    "create_account",
    "deduct_balance",
    "get_balance",
    "verify_login",
    # composer
    "COMPOSER_MAX_TOKENS",
    "COMPOSER_TIMEOUT",
    "build_continuation_prompt",
    "build_planner_prompt",
    "build_quoted_prompt",
    "compose_quoted_answer",
    "set_meter",
    # ledger
    "ledger",
    "record_composer_call",
    "record_size_estimate",
    "session_total",
    "today_total",
    # picker
    "build_picker_prompt",
    "parse_picker_reply",
    "pick_quote_selection",
    # recall_more
    "recall_more",
    # page_resolver
    "install_page_resolver",
    # dive
    "BOOK_DATASETS",
    "NEXT_TIER_URL",
    "dive_recall",
    "parse_evidence_sources",
    # report
    "research_session_report",
    # chat_store
    "chat_store",
    "latest_chat",
    # ask
    "ask_pool",
    # agent_client
    "CHAT_ANSWER_FINALIZED",
    "AgentStream",
    "sse_frame",
    # question_window
    "record_question",
    "window_state",
    # research
    "RESEARCH_SESSION_NOT_FOUND_DETAIL",
    "RESEARCH_TURN_NOT_FOUND_DETAIL",
    "abort_phone_research",
    "decide_proposal",
    "ensure_session",
    "find_turn",
    "research_session_messages",
    "research_session_state",
    "start_research_turn",
    "turn_status_payload",
]
