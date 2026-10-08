"""The serve import seam's parity pin (architecture pass #2): serve.py
loads two ways — imported as ``ui.serve`` by the tests, executed as
``python ui/serve.py`` in the container — and before ``ui/seam.py``
existed, two hand-synced import blocks kept the modes in step by
discipline alone. Commit 5f7edc9 records the drift's cost: the
script-mode block missed the chat seam's names, the first production
/agent/chat answered NameError, and only the live e2e run caught it.

The seam moved the whole surface to ONE binding list (ui/seam.py's
``__all__``); this module pins the construction twice. In-process, a
fresh file-loaded serve must expose every seam name that ``ui.serve``
does — the star-import wiring cannot silently drop a name. And in a
subprocess, the script-mode boot itself must come up and answer the
routes (the exact mode 5f7edc9 broke): /livez answers 200 and an
anonymous /agent/chat answers the gate's 401 JSON, never a NameError
traceback."""

import json
import importlib.util
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))

from ui import serve as package_serve  # noqa: E402
from ui import seam  # noqa: E402

UI_DIR = REPO_ROOT / "ui"


def test_a_fresh_serve_load_exposes_every_seam_name():
    # The star-import wiring: a name that joins seam.__all__ but never
    # reaches serve (a typo'd __all__, a shadowed import) goes red here,
    # in either load.
    spec = importlib.util.spec_from_file_location(
        "serve_fresh_load", UI_DIR / "serve.py"
    )
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)
    for name in seam.__all__:
        assert hasattr(package_serve, name), f"ui.serve lost {name}"
        assert hasattr(fresh, name), f"a fresh serve load lost {name}"
    # The deep modules stay shared across loads — the tests patch the
    # store modules in place (ui.ledger.LEDGER_DB and friends), and the
    # server the patches must reach is the one these bindings point
    # into. seam.__all__ re-exports the two serve wires at module
    # level (ledger.set_deductor; chat_store's backup).
    assert fresh.ledger is package_serve.ledger
    assert fresh.chat_store is package_serve.chat_store


def test_script_mode_boots_and_answers_the_routes():
    # The 5f7edc9 leg: the container's execution mode — serve.py as a
    # script beside the modules. The sheet must come up (the drift once
    # surfaced as a NameError on the first request) and the routes must
    # answer their gate shapes.
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        env = {
            path: value
            for path, value in __import__("os").environ.items()
            if path != "PYTHONPATH"
        }
        env.update(
            {
                "SESSION_UI_PORT": str(port),
                "SESSION_UI_HOST": "127.0.0.1",
                "ACCOUNTS_DB": str(Path(tmp) / "accounts.sqlite3"),
                "SESSION_CHAT_DB": str(Path(tmp) / "chats.sqlite3"),
                "SESSION_UI_QUOTA_DB": str(Path(tmp) / "usage.sqlite3"),
                "LEDGER_DB": str(Path(tmp) / "usage_ledger.sqlite3"),
                "COGNEE_URL": "http://127.0.0.1:19999",
            }
        )
        proc = subprocess.Popen(
            [sys.executable, str(UI_DIR / "serve.py")],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.time() + 30
            livez = None
            while time.time() < deadline:
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/livez", timeout=2
                    ) as response:
                        livez = response.status
                        break
                except (urllib.error.URLError, OSError):
                    if proc.poll() is not None:
                        out, err = proc.communicate(timeout=5)
                        raise AssertionError(
                            "script-mode serve died on boot:\n"
                            + err.decode("utf-8", "replace")[-2000:]
                        )
                    time.sleep(0.3)
            assert livez == 200
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/agent/chat",
                data=json.dumps({"query": "پرسش؟"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                urllib.request.urlopen(request, timeout=5)
                raise AssertionError("an anonymous ask must not pass the gate")
            except urllib.error.HTTPError as exc:
                assert exc.code == 401
                assert "detail" in json.load(exc)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
