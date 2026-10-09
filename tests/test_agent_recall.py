"""The agent seam contract (ADR-0016/0018): /agent/recall is the
Mastra chat agent's search-books tool — the SAME ask_pool passages
/ask builds, behind the shared AGENT_SERVICE_TOKEN instead of the
phone gate, with no chat row and no metering (the Question window
meters Learner messages on the Learner-facing seam, never the
agent's tool rounds)."""

import json
import sys
import urllib.error
import urllib.request

from tests.conftest import REPO_ROOT
from tests.helpers import stop_gate, with_gate
from tests.test_ask import AskUpstream, sample_document

sys.path.insert(0, str(REPO_ROOT))

from ui import serve  # noqa: E402

TOKEN = "agent-secret"


def agent_post(base, payload, token=TOKEN):
    """One POST in the agent service's dialect: the X-Agent-Token
    header instead of a login cookie — (status, payload)."""
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["X-Agent-Token"] = token
    request = urllib.request.Request(
        base + "/agent/recall",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def test_the_seam_stays_closed_without_a_token(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_SERVICE_TOKEN", raising=False)
    upstream = AskUpstream()
    base, server, original = with_gate(tmp_path, upstream)
    try:
        status, _ = agent_post(base, {"query": "پرسش؟"})
    finally:
        stop_gate(server, original)
    assert status == 401
    assert not upstream.search_bodies


def test_the_seam_rejects_a_wrong_token(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", TOKEN)
    upstream = AskUpstream()
    base, server, original = with_gate(tmp_path, upstream)
    try:
        status, _ = agent_post(base, {"query": "پرسش؟"}, token="wrong")
    finally:
        stop_gate(server, original)
    assert status == 401
    assert not upstream.search_bodies


def test_the_seam_returns_the_ask_pool_without_a_chat_row(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", TOKEN)
    upstream = AskUpstream(
        documents=[sample_document("Page 10:"), sample_document("Page 30:")]
    )
    base, server, original = with_gate(tmp_path, upstream)
    try:
        status, payload = agent_post(
            base, {"query": "پرسش؟", "datasets": ["tarhe-kolli"]}
        )
    finally:
        stop_gate(server, original)
    assert status == 200
    # The pool is ask_pool's own output over the one named Book.
    assert len(upstream.search_bodies) == 1
    assert payload["passages"][0]["reference"] == "document tarhe-kolli (page 10)"
    assert payload["passages"][0]["passage"].startswith("جملهٔ کتاب")
    # The tool round is not a Question: no chat row exists for anyone.
    assert serve.chats_today("09120000000") == 0


def test_the_seam_rejects_a_body_without_a_query(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", TOKEN)
    upstream = AskUpstream()
    base, server, original = with_gate(tmp_path, upstream)
    try:
        status, _ = agent_post(base, {"datasets": ["tarhe-kolli"]})
    finally:
        stop_gate(server, original)
    assert status == 400
    assert not upstream.search_bodies
