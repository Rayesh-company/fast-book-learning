"""The Mastra agent service client (ADR-0016/0018): the Learner-facing
seam's one upstream call — the Learner's message goes to the chat
agent's generate route, the conversation keyed per Learner thread
(Mastra Memory, durable in the agent service's own LibSQL), and the
sheet's Book selection rides the requestContext the search-books tool
reads (the selection reaches the tool without ever becoming prompt
text). The module talks to the agent service behind this module's ONE
``urlopen`` attribute, the ask.py rule; the URL and leash are read at
call time so the tests' env pins hold."""

from __future__ import annotations

import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen


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


def agent_answer(query: str, datasets, thread_id: str) -> str:
    """One Learner message through the agent; the answer text back.
    Raises AgentError when the reply carries no answer and
    URLError/TimeoutError/OSError when the service is unreachable — the
    seam maps both (502/504) and meters neither: a Question is an
    ANSWERED message (ADR-0018)."""
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
    return text
