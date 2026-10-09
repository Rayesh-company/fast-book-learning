#!/usr/bin/env python3
"""The capacity rehearsal (ADR-0017, ADR-0018): 100 concurrent chat asks
are 100 concurrent agent answers — the load rehearsal runs the AGENT
path (POST /agent/chat through the production seam), not the retired
quotes path.

Two modes:

  --accounts-db PATH   mint the rehearsal Accounts directly in the
                       store (the dev/local full-stack rehearsal; the
                       store is patched exactly the way the tests patch
                       it — set ACCOUNTS_DB before importing ui.accounts);
  --cookies FILE       reuse pre-made login cookies, one per line (the
                       production rehearsal — the Admin issues the
                       Accounts and tops their Balances, then hands the
                       cookies over).

The Question window caps one Account at 30 answered Questions per 5
hours (ADR-0017), so the rehearsal spreads N asks over
ceil(N / 30) phones — a burst larger than 30 per phone would trip the
window by design. Book questions only: the agent's search-books tool
runs, the web tool does not — the rehearsal measures the stack, not
the search bill.

The report is the honest census: per-status counts, latency
percentiles, and every failure's detail. The verdict is the stack
surviving the bar (all requests answered), not a green exit code.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The launch bar (ADR-0017): 100 concurrent chat asks.
DEFAULT_CONCURRENCY = 100
# The Question window's launch value (ADR-0017) — the per-phone cap the
# rehearsal's account spread honors.
QUESTIONS_PER_PHONE = 30

DEFAULT_QUESTION = "در یک جمله بگو توحید از نظر قرآن در زندگی انسان چه ریشه‌ای دارد؟"


def mint_accounts(count: int, run_tag: int) -> list[str]:
    """Mint `count` rehearsal Accounts (phone 0912 + run tag + index),
    each with a working Balance, in the caller's ACCOUNTS_DB; return the
    phones. A fresh run tag per run keeps every rehearsal off the
    previous run's Question window."""
    os.environ["ACCOUNTS_DB"] = ARGS.accounts_db
    sys.path.insert(0, str(REPO_ROOT))
    from ui import accounts

    phones = []
    for i in range(count):
        # 0912 + a 7-digit run tag + a 2-digit index: 13 digits, fresh
        # per run so no rehearsal trips the previous run's window.
        phone = f"0912{run_tag % 10_000_000:07d}{i:02d}"
        email = f"rehearsal-{run_tag}-{i}@sheet.test"
        accounts.create_account(email, "rehearsal-pass-1", phone=phone, role="operator")
        accounts.adjust_balance(phone, 1_000_000)
        phones.append(phone)
    return phones


def login_cookies(phones: list[str]) -> list[str]:
    """One login cookie per phone (the wire shape a browser carries)."""
    cookies = []
    for i, phone in enumerate(phones):
        request = urllib.request.Request(
            ARGS.base + "/auth/login",
            data=json.dumps(
                {
                    "email": f"rehearsal-{RUN_TAG}-{i}@sheet.test",
                    "password": "rehearsal-pass-1",
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            cookie = response.headers.get("Set-Cookie", "").split(";", 1)[0]
        if not cookie:
            raise SystemExit(f"login for {phone} set no cookie")
        cookies.append(cookie)
    return cookies


def one_ask(cookie: str, question: str, barrier: threading.Barrier) -> dict:
    """One concurrent agent ask: released together with every other
    thread, timed end to end, its outcome censused honestly."""
    barrier.wait()
    started = time.monotonic()
    request = urllib.request.Request(
        ARGS.base + "/agent/chat",
        data=json.dumps(
            {"query": question, "datasets": ["tarhe-kolli"]}, ensure_ascii=False
        ).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", "Cookie": cookie},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=ARGS.timeout) as response:
            payload = json.load(response)
        answer = payload.get("answer", "")
        return {
            "status": response.status,
            "seconds": round(time.monotonic() - started, 2),
            "answered": bool(isinstance(answer, str) and answer.strip()),
        }
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc).get("detail", "")
        except Exception:
            detail = ""
        return {
            "status": exc.code,
            "seconds": round(time.monotonic() - started, 2),
            "answered": False,
            "detail": str(detail)[:160],
        }
    except Exception as exc:  # the census wants the failure, not a crash
        return {
            "status": 0,
            "seconds": round(time.monotonic() - started, 2),
            "answered": False,
            "detail": f"{type(exc).__name__}: {exc}"[:160],
        }


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, round(fraction * (len(ordered) - 1)))
    return ordered[index]


def main() -> None:
    global ARGS, RUN_TAG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--accounts-db", help="mint mode: the accounts.sqlite3 to seed")
    parser.add_argument("--cookies", help="cookies mode: file, one cookie per line")
    parser.add_argument("--out", default="capacity-rehearsal.json")
    parser.add_argument(
        "--run-tag",
        type=int,
        default=None,
        help="fresh phones per run (default: a time-derived tag)",
    )
    ARGS = parser.parse_args()
    RUN_TAG = ARGS.run_tag if ARGS.run_tag is not None else int(time.time()) % 10_000_000

    if bool(ARGS.accounts_db) == bool(ARGS.cookies):
        raise SystemExit("choose exactly one mode: --accounts-db or --cookies")

    if ARGS.accounts_db:
        phone_count = max(1, -(-ARGS.concurrency // QUESTIONS_PER_PHONE))
        phones = mint_accounts(phone_count, RUN_TAG)
        cookies = login_cookies(phones)
        print(f"minted {len(phones)} rehearsal accounts on {ARGS.accounts_db}")
    else:
        cookies = [
            line.strip()
            for line in Path(ARGS.cookies).read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if len(cookies) * QUESTIONS_PER_PHONE < ARGS.concurrency:
            raise SystemExit(
                f"{len(cookies)} cookies cannot carry {ARGS.concurrency} asks "
                f"inside the {QUESTIONS_PER_PHONE}-per-phone window"
            )

    # Spread the asks evenly: phone i takes asks i, i+P, i+2P, ... — at
    # most ceil(N/P) per phone, under the window's cap.
    barrier = threading.Barrier(ARGS.concurrency)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=ARGS.concurrency) as pool:
        futures = [
            pool.submit(one_ask, cookies[i % len(cookies)], ARGS.question, barrier)
            for i in range(ARGS.concurrency)
        ]
        results = [future.result() for future in futures]
    wall = round(time.monotonic() - started, 2)

    answered = [r for r in results if r["answered"]]
    failed = [r for r in results if not r["answered"]]
    latencies = [r["seconds"] for r in results]
    census: dict[str, int] = {}
    for result in results:
        key = str(result["status"])
        census[key] = census.get(key, 0) + 1
    details = {}
    for result in failed:
        details.setdefault(str(result["status"]), []).append(result.get("detail", ""))

    report = {
        "base": ARGS.base,
        "concurrency": ARGS.concurrency,
        "question": ARGS.question,
        "wall_seconds": wall,
        "answered": len(answered),
        "failed": len(failed),
        "status_census": census,
        "latency": {
            "p50": percentile(latencies, 0.50),
            "p90": percentile(latencies, 0.90),
            "p99": percentile(latencies, 0.99),
            "max": max(latencies),
        },
        "failure_details": {k: v[:3] for k, v in details.items()},
    }
    Path(ARGS.out).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    verdict = "PASSED" if not failed else "FAILED"
    print(
        f"\nrehearsal {verdict}: {len(answered)}/{ARGS.concurrency} answered "
        f"in {wall}s (p50 {report['latency']['p50']}s, p99 {report['latency']['p99']}s)"
    )
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
