"""The Mastra agent service client (ADR-0016/0018): the Learner-facing
seam's one upstream call — the Learner's message goes to the chat
agent's generate route, the conversation keyed per Learner thread
(Mastra Memory, durable in the agent service's own LibSQL), and the
sheet's Book selection rides the requestContext the search-books tool
reads (the selection reaches the tool without ever becoming prompt
text). The reply comes back STRUCTURED (#24, ADR-0018): the answer text
plus the guaranteed «بیرون از کتاب» marking derived here from the
reply's tool-call record — never parsed from the answer text — so the
sheet renders the marking even when the model's own prose omits it. The
module talks to the agent service behind this module's ONE
``urlopen`` attribute, the ask.py rule; the URL and leash are read at
call time so the tests' env pins hold."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# The web tool's names in the reply's tool-call record: the OBJECT KEY
# is what the model actually sees ("webSearchTool" — probed against the
# real agent 2026-10-07, pinned in agent/src/mastra/generate-shape.test.ts);
# the tool's own id ("web-search", agent/src/mastra/tools/web-search.ts)
# rides along as the fallback so a Mastra rename of the wire name can
# never silently unmark the sheet.
WEB_TOOL_NAMES = ("webSearchTool", "web-search")

# A long web result list renders sanely: the seam keeps the first eight
# sources (title+url) — the snippet stays the tool's own detail.
MAX_WEB_SOURCES = 8


class AgentError(Exception):
    """The service was reached but carries no answer — an HTTP error
    status of its own (its model upstream refused, e.g. the provider's
    rate limit) or a reply without answer text. The seam answers 502:
    the agent is up and failed, not unreachable."""


def _agent_url() -> str:
    return (
        os.environ.get("AGENT_URL", "http://127.0.0.1:4111").rstrip("/")
        + "/api/agents/chat-agent/generate"
    )


def _web_guarantee(payload: dict) -> tuple[bool, list]:
    """The «بیرون از کتاب» guarantee from the reply's tool-call record
    (#24, ADR-0018): web_sourced is TRUE only when a tool-RESULT for the
    web tool exists — the tool EXECUTED — and the sources are that
    result's own entries. Never text-parsed; a reply without tool
    records (no web round) is honestly false with no sources."""
    sourced = False
    sources: list = []
    records = payload.get("toolResults")
    if isinstance(records, list):
        for record in records:
            if not isinstance(record, dict):
                continue
            inner = record.get("payload")
            if (
                not isinstance(inner, dict)
                or inner.get("toolName") not in WEB_TOOL_NAMES
            ):
                continue
            # A tool-result record for the web tool IS the executed proof.
            sourced = True
            result = inner.get("result")
            items = result.get("results") if isinstance(result, dict) else None
            for item in items if isinstance(items, list) else ():
                if (
                    isinstance(item, dict)
                    and isinstance(item.get("title"), str)
                    and isinstance(item.get("url"), str)
                ):
                    sources.append({"title": item["title"], "url": item["url"]})
    return sourced, sources[:MAX_WEB_SOURCES]


def agent_answer(query: str, datasets, thread_id: str) -> dict:
    """One Learner message through the agent; the STRUCTURED reply back
    — {"text", "web_sourced", "sources"} — the marking derived from the
    reply's tool-call record so it is the platform's guarantee, never
    the model's memory (#24, ADR-0018). Raises AgentError when the reply
    carries no answer and URLError/TimeoutError/OSError when the service
    is unreachable — the seam maps both (502/504) and meters neither: a
    Question is an ANSWERED message (ADR-0018)."""
    request = Request(
        _agent_url(),
        data=json.dumps(
            {
                "messages": [{"role": "user", "content": query}],
                "memory": {"thread": thread_id, "resource": thread_id},
                "requestContext": {"datasets": list(datasets or [])},
            },
            ensure_ascii=False,
        ).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    timeout = int(os.environ.get("AGENT_TIMEOUT", "120"))
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read() or b"{}")
    except HTTPError as exc:
        # HTTPError is a URLError subclass; caught here first so a
        # reachable-but-failing agent stays a 502, never a 504.
        raise AgentError(f"the agent service answered {exc.code}") from exc
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise AgentError("the agent reply carries no answer")
    web_sourced, sources = _web_guarantee(payload)
    return {"text": text, "web_sourced": web_sourced, "sources": sources}
