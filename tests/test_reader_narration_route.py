"""The Book reader's generation boundary uses this app's Account gate."""
from tests.helpers import get, post, with_gate, stop_gate
from ui import narration, serve
from urllib.request import urlopen


def test_designed_mobile_ui_and_reader_assets_share_the_existing_host(tmp_path):
    base, server, originals = with_gate(tmp_path, None)
    try:
        with urlopen(base + "/docs/design/mobile-preview/?view=reader") as response:
            html = response.read().decode()
        assert 'src="/mobile/reader-runtime.mjs"' in html
        assert 'href="/book-reader/reader.css"' in html
        with urlopen(base + "/mobile/reader-runtime.mjs") as response:
            runtime = response.read().decode()
        assert "createBookReader" in runtime
        assert "/auth/me" in runtime
    finally:
        stop_gate(server, originals)


def test_reader_audio_requires_login_but_does_not_require_a_prior_chat(tmp_path, monkeypatch):
    calls = []
    def generated(doc, body, *, books_dir):
        calls.append((doc, body, books_dir))
        return {"audioBase64": "UklGRg==", "mimeType": "audio/wav", "durationMs": 1000, "cues": []}
    monkeypatch.setattr(narration, "generate_narration", generated)
    base, server, originals = with_gate(tmp_path, None)
    try:
        anonymous, _ = post(base, "/books/tarhe-kolli/narration", {"page": 1})
        assert anonymous == 401
        assert calls == []
        status, response = post(base, "/books/tarhe-kolli/narration", {"page": 1}, phone="09120000000")
        assert status == 200
        assert response["mimeType"] == "audio/wav"
        assert calls == [("tarhe-kolli", {"page": 1}, serve.BOOKS_DIR)]
        rejected, _ = post(base, "/books/unknown/narration", {}, phone="09120000000")
        assert rejected == 404
        assert len(calls) == 1
    finally:
        stop_gate(server, originals)


def test_generation_reports_safe_configuration_error_and_serves_reader_module(tmp_path, monkeypatch):
    def unavailable(*args, **kwargs):
        raise narration.NarrationError("NARRATION_PROVIDER_NOT_CONFIGURED")
    monkeypatch.setattr(narration, "generate_narration", unavailable)
    monkeypatch.setenv("AVALAI_TTS_API_KEY", "server-only-fixture-key")
    base, server, originals = with_gate(tmp_path, None)
    try:
        status, response = post(base, "/books/tarhe-kolli/narration", {}, phone="09120000000")
        assert status == 503
        assert response["code"] == "NARRATION_PROVIDER_NOT_CONFIGURED"
        assert "server-only-fixture-key" not in str(response)
        status, configuration = get(base, "/reader/narration/status", phone="09120000000")
        assert status == 200
        assert configuration["provider"]["status"] == "available"
        assert "server-only-fixture-key" not in str(configuration)
        status, _ = get(base, "/reader/narration/status")
        assert status == 401
    finally:
        stop_gate(server, originals)
