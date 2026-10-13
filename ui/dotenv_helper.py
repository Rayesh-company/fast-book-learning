"""Lightweight, pure-Python dotenv loader for local execution.

Loads key-value pairs from .env into os.environ if they are not already set.
Has zero third-party dependencies.
"""
from __future__ import annotations

import os
from pathlib import Path


def _normalize_container_env() -> None:
    in_docker = os.path.exists("/.dockerenv") or os.environ.get("SESSION_UI_HOST") == "0.0.0.0"
    if in_docker:
        for var in ("LLM_ENDPOINT", "EMBEDDING_ENDPOINT", "AVALAI_BASE_URL", "AVALAI_API_BASE_URL"):
            val = os.environ.get(var)
            if val and ("127.0.0.1" in val or "localhost" in val):
                os.environ[var] = val.replace("127.0.0.1", "host.docker.internal").replace("localhost", "host.docker.internal")

    llm_model = os.environ.get("LLM_MODEL")
    if llm_model == "Qwen3.8-27B-GGUF":
        os.environ["LLM_MODEL"] = "unsloth/Qwen3.8-27B-GGUF"
    chat_model = os.environ.get("CHAT_AGENT_MODEL")
    if chat_model == "Qwen3.8-27B-GGUF":
        os.environ["CHAT_AGENT_MODEL"] = "unsloth/Qwen3.8-27B-GGUF"


def load_env(path: Path | str | None = None) -> dict[str, str]:
    """Load variables from .env into os.environ without overwriting existing vars."""
    if path is None:
        target = Path(".env")
        if not target.is_file():
            target = Path(__file__).resolve().parent.parent / ".env"
    else:
        target = Path(path)

    loaded: dict[str, str] = {}
    if not target.is_file():
        _normalize_container_env()
        return loaded

    for raw in target.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
            loaded[key] = value

    _normalize_container_env()
    return loaded
