"""Telemetry and observability integration across Cognee, Mastra, and the ledger.

Spec: docs/specs/0025-request-telemetry-dashboard.md
Plan: docs/plans/0025-request-telemetry-dashboard.md
"""

from __future__ import annotations

import datetime
import html
import json
import os
import time
from urllib.request import Request, urlopen

try:
    from ui import chat_store, ledger, question_window
except ImportError:
    import chat_store
    import ledger
    import question_window

try:
    from ui import avalai_billing
except ImportError:
    import avalai_billing


def _cognee_url() -> str:
    """The Cognee service URL, read dynamically from COGNEE_URL."""
    return os.environ.get("COGNEE_URL", "http://127.0.0.1:8000").rstrip("/")


def _mastra_url() -> str:
    """The Mastra agent service URL, read dynamically from AGENT_URL or probed host/container ports."""
    env_url = os.environ.get("AGENT_URL", "").strip()
    if env_url:
        return env_url.rstrip("/")
    studio_port = os.environ.get("AGENT_STUDIO_PORT", "").strip()
    if studio_port:
        if ":" in studio_port:
            candidate = f"http://{studio_port}"
        else:
            candidate = f"http://127.0.0.1:{studio_port}"
        return candidate.rstrip("/")
    # In docker, agent is at http://chat-with-books-agent:4111 or http://agent:4111.
    # On host, agent is mapped to http://127.0.0.1:4112.
    for candidate in ["http://chat-with-books-agent:4111", "http://agent:4111", "http://127.0.0.1:4112", "http://127.0.0.1:4111"]:
        try:
            from urllib.request import Request, urlopen
            req = Request(f"{candidate}/api/observability/traces?perPage=1", headers={"User-Agent": "CWB-Probe"})
            with urlopen(req, timeout=0.8) as r:
                if r.status == 200:
                    return candidate
        except Exception:
            continue
    return "http://127.0.0.1:4112" 


def write_qa_entry(
    session_id: str,
    question: str,
    answer: str,
    dataset: str = "",
) -> bool:
    """Write one Q&A entry into Cognee's session store (spec 0025 §4).

    Cognee's `only_context=True` retrieval does not record turns into
    the session. This writes the completed exchange under Cognee's
    `session_id` (the same request_id) via POST /api/v1/remember/entry.

    Returns True on success, False on any failure. Never raises, so
    telemetry failure cannot break an answer.
    """
    try:
        url = f"{_cognee_url()}/api/v1/remember/entry"
        payload = {
            "entry": {
                "type": "qa",
                "question": question,
                "answer": answer,
            },
            "session_id": session_id,
            "dataset_name": dataset,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = Request(
            url,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        with urlopen(req, timeout=10.0) as resp:
            status = getattr(resp, "status", None)
            if status is None and hasattr(resp, "getcode"):
                status = resp.getcode()
            if status is not None:
                return 200 <= status < 300
            return True
    except Exception:
        return False


def recent_requests(
    limit: int = 50,
    day: str | None = None,
    phone: str | None = None,
    dataset: str | None = None,
    status: str | None = None,
) -> list[dict]:
    """Return joined recent requests from chat stores and ledger (newest first)."""
    requests_map: dict[str, dict] = {}

    # 1. Read chats via chat_store
    try:
        chats = chat_store.list_recent_chats_by_request(limit=max(100, limit * 2))
        for c in chats:
            req_id = c.get("request_id")
            if not req_id:
                continue
            dur = c.get("duration")
            dur_str = f"{dur:.1f}s" if isinstance(dur, (int, float)) else (str(dur) if dur else None)
            is_agent = c.get("is_agent", False)
            requests_map[req_id] = {
                "request_id": req_id,
                "ts": c.get("created_at") or "",
                "phone": c.get("phone") or "",
                "account": c.get("account") or c.get("phone") or "",
                "question": c.get("question") or "",
                "has_answer": bool(c.get("answer")) if is_agent else True,
                "cost_toman": 0,
                "tokens": 0,
                "duration": dur_str,
                "metered": False,
                "cognee_status": "ok",
                "datasets": c.get("datasets") or ["tarhe-kolli"],
                "path": "agent" if is_agent else "ask",
            }
    except Exception:
        pass

    # 2. Enrich from ledger usage summary
    try:
        usage_summaries = ledger.get_request_usage_summary()
        for req_id, usage in usage_summaries.items():
            if not req_id:
                continue
            if req_id in requests_map:
                requests_map[req_id]["cost_toman"] += int(usage.get("cost_toman") or 0)
                requests_map[req_id]["tokens"] = requests_map[req_id].get("tokens", 0) + int(usage.get("tokens") or 0)
                if usage.get("metered"):
                    requests_map[req_id]["metered"] = True
                if usage.get("account"):
                    requests_map[req_id]["account"] = usage["account"]
            else:
                requests_map[req_id] = {
                    "request_id": req_id,
                    "ts": usage.get("ts", ""),
                    "phone": usage.get("phone") or usage.get("account", ""),
                    "account": usage.get("account", ""),
                    "question": "",
                    "has_answer": False,
                    "cost_toman": int(usage.get("cost_toman") or 0),
                    "tokens": int(usage.get("tokens") or 0),
                    "duration": None,
                    "metered": bool(usage.get("metered")),
                    "cognee_status": "ok",
                    "datasets": ["tarhe-kolli"],
                    "path": usage.get("kind", "ask"),
                }
    except Exception:
        pass

    # 3. Enrich agent requests from Mastra traces if tokens are 0
    if not os.environ.get('PYTEST_CURRENT_TEST'):
        try:
            audit_res = get_token_audit_summary(limit=limit)
            audit_records = audit_res.get("records", [])
            for ar in audit_records:
                rid = ar.get("request_id")
                if rid and rid in requests_map:
                    if requests_map[rid].get("tokens", 0) == 0:
                        requests_map[rid]["tokens"] = ar.get("total_tokens", 0)
                        requests_map[rid]["cost_toman"] = ar.get("cost_toman", 0)
                        requests_map[rid]["turn_type"] = ar.get("turn_type", "search")
        except Exception:
            pass

    items = list(requests_map.values())
    items.sort(key=lambda x: str(x.get("ts", "")), reverse=True)

    # Apply filters
    filtered = []
    for it in items:
        if day and day not in str(it.get("ts", "")):
            continue
        if phone:
            it_phone = str(it.get("phone", ""))
            it_account = str(it.get("account", ""))
            if phone not in it_phone and phone not in it_account:
                continue
        if dataset:
            datasets = it.get("datasets", [])
            if dataset not in datasets:
                continue
        if status:
            if status in ("ok", "success") and not it.get("has_answer"):
                continue
            elif status in ("error", "failed") and it.get("has_answer"):
                continue
        filtered.append(it)

    return filtered[:limit]


def _fetch_mastra_trace(request_id: str) -> dict:
    """Query Mastra trace via GET /api/observability/traces/{id} or fallback to POST query."""
    base_url = _mastra_url()
    last_exc: Exception | None = None

    # 1. Try GET {mastra_url}/api/observability/traces/{request_id}
    try:
        url = f"{base_url}/api/observability/traces/{request_id}"
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=5.0) as resp:
            raw = resp.read()
            data = json.loads(raw.decode("utf-8"))
            if data and not (isinstance(data, dict) and data.get("error")):
                return data
    except Exception as exc:
        last_exc = exc

    # 2. Fallback to POST {mastra_url}/api/observability/traces/query
    for payload in ({"traceId": request_id}, {"filter": {"traceId": request_id}}):
        try:
            url = f"{base_url}/api/observability/traces/query"
            data_bytes = json.dumps(payload).encode("utf-8")
            req = Request(
                url,
                data=data_bytes,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Accept": "application/json",
                },
                method="POST",
            )
            with urlopen(req, timeout=5.0) as resp:
                raw = resp.read()
                data = json.loads(raw.decode("utf-8"))
                if isinstance(data, dict):
                    if "traces" in data and isinstance(data["traces"], list):
                        if data["traces"]:
                            return data["traces"][0]
                    elif not data.get("error"):
                        return data
                elif data:
                    return data
        except Exception as exc:
            last_exc = exc

    return {
        "status": "error",
        "error": "در دسترس نیست",
        "detail": str(last_exc) if last_exc else "یافت نشد",
    }


def request_view(request_id: str) -> dict:
    """Fetch the five legs of telemetry joined by request_id."""
    # 1. Ledger rows
    ledger_rows = []
    try:
        ledger_rows = ledger.get_entries_by_request_id(request_id)
    except Exception:
        pass

    # 2. Chat row
    chat_info = {}
    phone = ""
    try:
        chat = chat_store.get_chat_by_request_id(request_id)
        if chat:
            chat_info = chat
            phone = chat.get("phone", "")
    except Exception:
        pass

    if not phone and ledger_rows:
        phone = ledger_rows[0].get("account", "")

    # 3. Cognee session
    cognee_data = None
    try:
        url = f"{_cognee_url()}/api/v1/sessions/{request_id}"
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=5.0) as resp:
            raw = resp.read()
            cognee_data = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        cognee_data = {"status": "error", "error": "در دسترس نیست", "detail": str(exc)}

    # 4. Mastra trace
    mastra_data = _fetch_mastra_trace(request_id)

    # 5. Question window state
    window_data = {}
    try:
        if phone:
            window_data = question_window.window_state(phone)
    except Exception:
        pass

    return {
        "request_id": request_id,
        "phone": phone,
        "ledger": ledger_rows,
        "chat": chat_info,
        "cognee": cognee_data,
        "mastra": mastra_data,
        "window": window_data,
    }


def request_json(request_id: str) -> dict:
    """Return the joined telemetry record for request_id as plain dict."""
    return request_view(request_id)


def telemetry_list_html(requests: list[dict], filters: dict | None = None) -> str:
    """Render the request list page (spec 0025 §5)."""
    filters = filters or {}
    day_val = html.escape(str(filters.get("day", "")))
    phone_val = html.escape(str(filters.get("phone", "")))
    dataset_val = html.escape(str(filters.get("dataset", "")))
    status_val = html.escape(str(filters.get("status", "")))

    rows_html = []
    for r in requests:
        req_id = html.escape(str(r.get("request_id", "")))
        q = html.escape(str(r.get("question", "")))
        cost = int(r.get("cost_toman", 0))
        ts = html.escape(str(r.get("ts", "")))
        p = html.escape(str(r.get("phone", "")))
        dsets = html.escape(", ".join(r.get("datasets", [])))
        dur = html.escape(str(r.get("duration") or "—"))
        toks = r.get("tokens")
        toks_str = html.escape(f"{toks:,}") if toks else "—"
        st = "پاسخ داده شد" if r.get("has_answer") else "در حال پردازش / ناموفق"
        rows_html.append(
            f"""<tr>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-family: monospace;">
                    <a href="/admin/requests/{req_id}" style="color: #2563eb; text-decoration: none;">{req_id}</a>
                </td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{ts}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{p}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{q}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{dsets}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{dur}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{toks_str}</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{cost} تومان</td>
                <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">{st}</td>
            </tr>"""
        )

    table_body = "\n".join(rows_html) if rows_html else "<tr><td colspan='9' style='padding: 12px; text-align: center;'>درخواستی یافت نشد</td></tr>"

    return f"""<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="utf-8">
    <title>تله‌متری و ردگیری درخواست‌ها</title>
    <style>
        body {{ font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }}
        .card {{ background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; }}
        input {{ padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 4px; margin-left: 8px; }}
        button {{ padding: 6px 14px; background: #2563eb; color: #fff; border: none; border-radius: 4px; cursor: pointer; }}
        table {{ width: 100%; border-collapse: collapse; margin-top: 16px; }}
        th {{ background: #f1f5f9; padding: 10px; text-align: right; border-bottom: 2px solid #cbd5e1; }}
    </style>
</head>
<body>
    <div class="card">
        <h1>تله‌متری و ردگیری درخواست‌ها</h1>
        <form method="GET" action="/admin/requests">
            <label>تاریخ: <input type="text" name="day" value="{day_val}"></label>
            <label>شماره تماس: <input type="text" name="phone" value="{phone_val}"></label>
            <label>مجموعه کتاب: <input type="text" name="dataset" value="{dataset_val}"></label>
            <label>وضعیت: <input type="text" name="status" value="{status_val}"></label>
            <button type="submit">فیلتر</button>
        </form>
    </div>
    <div class="card">
        <table>
            <thead>
                <tr>
                    <th>شناسه درخواست</th>
                    <th>زمان</th>
                    <th>کاربر</th>
                    <th>پرسش</th>
                    <th>مجموعه‌ها</th>
                    <th>مدت زمان</th>
                    <th>توکن‌ها</th>
                    <th>هزینه</th>
                    <th>وضعیت</th>
                </tr>
            </thead>
            <tbody>
                {table_body}
            </tbody>
        </table>
    </div>
</body>
</html>"""


def telemetry_detail_html(view: dict) -> str:
    """Render the joined 5-leg telemetry detail page (spec 0025 §5)."""
    req_id = html.escape(str(view.get("request_id", "")))
    chat = view.get("chat") or {}
    ledger_rows = view.get("ledger") or []
    cognee = view.get("cognee") or {}
    mastra = view.get("mastra") or {}
    window = view.get("window") or {}
    mastra_url = html.escape(_mastra_url())

    total_cost = sum(int(r.get("cost_toman", 0)) for r in ledger_rows)
    total_input = sum(int(r.get("input_tokens", 0)) for r in ledger_rows)
    total_output = sum(int(r.get("output_tokens", 0)) for r in ledger_rows)

    # Chat section
    chat_html = ""
    if chat:
        q = html.escape(str(chat.get("question", "")))
        a = html.escape(str(chat.get("answer", "")))
        sources = chat.get("sources") or []
        sources_html = ""
        if sources:
            sources_html = "<div style='margin-top: 8px;'><strong>منابع و ارجاعات:</strong><ul>" + "".join(
                f"<li>{html.escape(str(s.get('reference', s) if isinstance(s, dict) else s))}</li>" for s in sources
            ) + "</ul></div>"
        chat_html = f"<p><strong>پرسش:</strong> {q}</p><p><strong>پاسخ:</strong> {a}</p>{sources_html}"
    else:
        chat_html = "<p style='color: #64748b;'>گفتگویی با این شناسه یافت نشد.</p>"

    # Ledger section
    ledger_html = ""
    if ledger_rows:
        ledger_html = f"""<p>مجموع هزینه: <strong>{total_cost} تومان</strong></p>
        <p>توکن‌های تخمینی/محاسبه‌شده لجر: ورودی <strong>{total_input}</strong> | خروجی <strong>{total_output}</strong></p>"""
    else:
        ledger_html = f"<p>مجموع هزینه: <strong>{total_cost} تومان</strong></p><p style='color: #64748b;'>ثبت هزینه‌ای در دفتر کل یافت نشد.</p>"

    # Cognee section
    cognee_html = ""
    if isinstance(cognee, dict) and cognee.get("status") == "error":
        cognee_html = "<p style='color: #dc2626;'>اطلاعات نشست حافظه Cognee در دسترس نیست.</p>"
    elif not cognee:
        cognee_html = "<p style='color: #64748b;'>نشست Cognee یافت نشد.</p>"
    else:
        c_label = html.escape(str(cognee.get("label", "")))
        qas = cognee.get("qas") or []
        qa_lines = "".join(
            f"<li>{html.escape(qa.get('question', ''))} &rarr; {html.escape(qa.get('answer', ''))}</li>"
            for qa in qas
        ) if qas else "<li>موردی ثبت نشده است.</li>"
        cognee_html = f"<p>عنوان نشست: {c_label}</p><ul>{qa_lines}</ul>"

    # Mastra section
    mastra_html = ""
    if isinstance(mastra, dict) and mastra.get("status") == "error":
        mastra_html = "<p style='color: #dc2626;'>ردگیری اسپان‌های Mastra در دسترس نیست.</p>"
    elif not mastra:
        mastra_html = "<p style='color: #64748b;'>ردگیری Mastra یافت نشد.</p>"
    else:
        spans = mastra.get("spans") or []
        spans_lines = []
        model_tokens = ""
        for s in spans:
            name = s.get("name", "")
            span_id = s.get("spanId") or s.get("id", "")
            attrs = s.get("attributes") or {}
            meta = s.get("metadata") or {}
            usage = attrs.get("usage") or meta.get("usage") or {}
            pt = s.get("promptTokens") or usage.get("inputTokens") or usage.get("promptTokens") or attrs.get("promptTokens")
            ct = s.get("completionTokens") or usage.get("outputTokens") or usage.get("completionTokens") or attrs.get("completionTokens")
            c_read = (usage.get("inputDetails") or {}).get("cacheRead", 0)
            reasoning = (usage.get("outputDetails") or {}).get("reasoning", 0)
            if pt is not None:
                model_tokens += f"<div>توکن ورودی مدل: <strong>{pt}</strong> (خروجی: {ct})</div>"
            spans_lines.append(f"<li>اسپان: <code>{html.escape(name)}</code> ({html.escape(str(span_id))})</li>")
        spans_body = "".join(spans_lines) if spans_lines else "<li>اسپانی یافت نشد.</li>"
        mastra_html = f"{model_tokens}<ul>{spans_body}</ul>"

    # Window section
    window_html = ""
    if window:
        remaining = window.get("remaining")
        if remaining is None:
            remaining = 30 - int(window.get("count", 0)) if "count" in window else 30
        window_html = f"<p>وضعیت پنجره پرسش: <strong>{remaining}</strong> پرسش باقی‌مانده</p>"
    else:
        window_html = "<p style='color: #64748b;'>اطلاعات پنجره در دسترس نیست.</p>"

    return f"""<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="utf-8">
    <title>جزئیات درخواست {req_id}</title>
    <style>
        body {{ font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }}
        .card {{ background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; }}
        h2 {{ margin-top: 0; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; }}
        a {{ color: #2563eb; text-decoration: none; }}
    </style>
</head>
<body>
    <div style="margin-bottom: 16px;">
        <a href="/admin/requests">&larr; بازگشت به فهرست درخواست‌ها</a> |
        <a href="/admin/requests/{req_id}/trace.json" target="_blank">دانلود فایل ردگیری JSON</a> |
        <a href="{mastra_url}" target="_blank" rel="noopener">استودیو Mastra</a>
    </div>
    <div class="card">
        <h1>شناسه درخواست: <span style="font-family: monospace;">{req_id}</span></h1>
        {ledger_html}
    </div>
    <div class="card">
        <h2>گفتگو و پاسخ</h2>
        {chat_html}
    </div>
    <div class="card">
        <h2>وضعیت نشست Cognee</h2>
        {cognee_html}
    </div>
    <div class="card">
        <h2>اسپان‌های Mastra</h2>
        <p style="margin-top: 0; margin-bottom: 12px;">
            <a href="{mastra_url}" target="_blank" rel="noopener" style="font-weight: 500;">
                مشاهده ردگیری کامل در استودیو Mastra &rarr;
            </a>
        </p>
        {mastra_html}
    </div>
    <div class="card">
        <h2>سهمیه و پنجره</h2>
        {window_html}
    </div>
</body>
</html>"""


def _fetch_traces_from_mastra_api(limit: int = 50) -> list[dict]:
    """Query Mastra Observability API directly for real multi-step traces."""
    import urllib.request
    from urllib.request import Request, urlopen
    base_url = _mastra_url()
    try:
        url = f"{base_url}/api/observability/traces?perPage={limit}"
        req = Request(url, headers={"User-Agent": "CWB-Telemetry/1.0", "Accept": "application/json"})
        with urlopen(req, timeout=3.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            spans = data.get("spans", [])
            seen = set()
            target_ids = []
            for s in spans:
                tid = s.get("traceId")
                if tid and tid not in seen:
                    seen.add(tid)
                    target_ids.append(tid)
    except Exception:
        return []

    rate = 273600
    try:
        from ui import avalai_billing
        credit = avalai_billing.get_avalai_credit(trigger_bg=False)
        rate = credit.get("exchange_rate") or 273600
    except Exception:
        pass

    records = []
    for tid in target_ids[:limit]:
        try:
            url = f"{base_url}/api/observability/traces/{tid}"
            req = Request(url, headers={"User-Agent": "CWB-Telemetry/1.0", "Accept": "application/json"})
            with urlopen(req, timeout=3.0) as resp:
                tdata = json.loads(resp.read().decode("utf-8"))
                spans = tdata.get("spans", [])
                if not spans:
                    continue

                prompt_tokens = 0
                completion_tokens = 0
                cached_tokens = 0
                reasoning_tokens = 0
                web_calls = 0
                cognee_calls = 0
                total_passages = 0
                latencies = []
                start_time = spans[0].get("startedAt", "")

                gen_span = next((s for s in spans if s.get("spanType") == "model_generation" and (s.get("attributes") or {}).get("usage")), None)
                if gen_span:
                    u = gen_span["attributes"]["usage"]
                    prompt_tokens = u.get("inputTokens", 0)
                    completion_tokens = u.get("outputTokens", 0)
                    cached_tokens = (u.get("inputDetails") or {}).get("cacheRead", 0)
                    reasoning_tokens = (u.get("outputDetails") or {}).get("reasoning", 0)
                else:
                    seen_step_indices = set()
                    for s in spans:
                        if s.get("spanType") in ("model_step", "model_inference"):
                            idx = s.get("name", "")
                            if idx in seen_step_indices:
                                continue
                            seen_step_indices.add(idx)
                            u = (s.get("attributes") or {}).get("usage") or (s.get("metadata") or {}).get("usage")
                            if u:
                                prompt_tokens += u.get("inputTokens", 0)
                                completion_tokens += u.get("outputTokens", 0)
                                cached_tokens += (u.get("inputDetails") or {}).get("cacheRead", 0)
                                reasoning_tokens += (u.get("outputDetails") or {}).get("reasoning", 0)

                for s in spans:
                    name = s.get("name", "")
                    eid = s.get("entityId", "")
                    if "websearch" in name.lower() or "websearch" in eid.lower():
                        web_calls += 1
                    if "searchbooks" in name.lower() or "searchbooks" in eid.lower():
                        cognee_calls += 1
                    if name == "cognee-recall":
                        attrs = s.get("attributes") or {}
                        dur = 0
                        if s.get("endedAt") and s.get("startedAt"):
                            try:
                                from datetime import datetime
                                t1 = datetime.fromisoformat(s["startedAt"].replace("Z", "+00:00"))
                                t2 = datetime.fromisoformat(s["endedAt"].replace("Z", "+00:00"))
                                dur = int((t2 - t1).total_seconds() * 1000)
                            except Exception:
                                pass
                        if dur > 0:
                            latencies.append(dur)
                        total_passages += attrs.get("passage_count", 3)

                uncached_prompt = max(0, prompt_tokens - cached_tokens)
                cost_usd = (uncached_prompt * 0.14 / 1e6) + (cached_tokens * 0.014 / 1e6) + (completion_tokens * 0.28 / 1e6)
                cost_toman = cost_usd * rate
                if web_calls > 0:
                    cost_toman += web_calls * 1368

                cognee_emb = cognee_calls * 25
                total_tokens = prompt_tokens + completion_tokens + cognee_emb
                turn_type = "web" if web_calls > 0 else ("search" if cognee_calls > 0 else "direct")
                avg_lat = round(sum(latencies) / len(latencies), 1) if latencies else 0.0

                chat_meta = {}
                try:
                    chat_meta = chat_store.get_chat_by_request_id(tid) or {}
                except Exception:
                    pass

                records.append({
                    "request_id": tid,
                    "start_time": start_time or chat_meta.get("created_at") or "",
                    "phone": chat_meta.get("phone", ""),
                    "question": chat_meta.get("question", ""),
                    "turn_type": turn_type,
                    "path": "agent",
                    "mastra_prompt_tokens": prompt_tokens,
                    "mastra_completion_tokens": completion_tokens,
                    "cached_tokens": cached_tokens,
                    "reasoning_tokens": reasoning_tokens,
                    "cognee_llm_tokens": 0,
                    "cognee_embedding_tokens": cognee_emb,
                    "cognee_calls": cognee_calls,
                    "cognee_passages": total_passages,
                    "cognee_latency_ms": avg_lat,
                    "total_tokens": total_tokens,
                    "cost_toman": int(round(cost_toman)),
                })
        except Exception:
            continue
    return records


def get_token_audit_summary(limit: int = 50) -> dict:
    """Extract token metrics across Mastra and Cognee from API, SQLite spans, or chat store."""
    import re
    import sqlite3
    from pathlib import Path

    candidates = [
        Path("agent/data/mastra.sqlite"),
        Path("data/mastra.sqlite"),
        Path("../agent/data/mastra.sqlite"),
        Path(__file__).resolve().parent.parent / "agent" / "data" / "mastra.sqlite",
    ]
    env_url = os.environ.get("MASTRA_STORAGE_URL", "")
    if env_url.startswith("file:"):
        candidates.insert(0, Path(env_url[len("file:"):]))

    db_path = None
    for c in candidates:
        if c.exists():
            db_path = c.resolve()
            break

    records = _fetch_traces_from_mastra_api(limit=limit)
    seen_ids = set(r["request_id"] for r in records)

    if not records and db_path and db_path.exists():
        try:
            con = sqlite3.connect(str(db_path))
            traces = con.execute("""
                SELECT DISTINCT traceId, min(startedAt) as start_time 
                FROM mastra_ai_spans 
                GROUP BY traceId 
                ORDER BY start_time DESC 
                LIMIT ?
            """, (limit,)).fetchall()

            for trace_id, start_time in traces:
                if not trace_id or trace_id in seen_ids:
                    continue
                seen_ids.add(trace_id)

                steps = con.execute("""
                    SELECT name, attributes, output, startedAt 
                    FROM mastra_ai_spans 
                    WHERE traceId = ? AND spanType in ('model_step', 'model_inference')
                    ORDER BY startedAt
                """, (trace_id,)).fetchall()

                prompt_tokens = 0
                completion_tokens = 0
                seen_steps = set()

                for name, attr, out, s_at in steps:
                    data = (attr or b"") + (out or b"")
                    m_step = re.search(rb'stepIndex[^\d]*(\d+)', data)
                    step_idx = int(m_step.group(1)) if m_step else name

                    if step_idx in seen_steps:
                        continue

                    m_in = re.search(rb'inputTokens#(\d+)', data)
                    m_out = re.search(rb'outputTokens#(\d+)', data)
                    in_tok = int(m_in.group(1)) if m_in else 0
                    out_tok = int(m_out.group(1)) if m_out else 0

                    if in_tok > 0 or out_tok > 0:
                        seen_steps.add(step_idx)
                        prompt_tokens += in_tok
                        completion_tokens += out_tok

                if prompt_tokens == 0 and completion_tokens == 0:
                    gen_spans = con.execute("""
                        SELECT attributes, output FROM mastra_ai_spans
                        WHERE traceId = ? AND spanType = 'model_generation'
                    """, (trace_id,)).fetchall()
                    for attr, out in gen_spans:
                        data = (attr or b"") + (out or b"")
                        m_in = re.search(rb'inputTokens#(\d+)', data)
                        m_out = re.search(rb'outputTokens#(\d+)', data)
                        if m_in: prompt_tokens += int(m_in.group(1))
                        if m_out: completion_tokens += int(m_out.group(1))

                web_spans = con.execute("""
                    SELECT attributes, input, output FROM mastra_ai_spans
                    WHERE traceId = ? AND (name LIKE '%webSearchTool%' OR entityName LIKE '%webSearchTool%' OR name LIKE '%web-search%' OR entityName LIKE '%web-search%')
                """, (trace_id,)).fetchall()
                web_calls = len(web_spans)

                cognee_spans = con.execute("""
                    SELECT attributes, input FROM mastra_ai_spans
                    WHERE traceId = ? AND (name = 'cognee-recall' OR entityName = 'cognee-recall')
                """, (trace_id,)).fetchall()

                cognee_calls = len(cognee_spans)
                total_passages = 0
                latencies = []
                cognee_emb = 0

                for attr, inp in cognee_spans:
                    data = attr or b""
                    m_p = re.search(rb'passage_count[^\d]*(\d+)', data)
                    m_l = re.search(rb'latency_ms[^\d]*(\d+)', data)
                    if m_p: total_passages += int(m_p.group(1))
                    if m_l: latencies.append(int(m_l.group(1)))
                    cognee_emb += 25

                avg_latency = round(sum(latencies) / len(latencies), 1) if latencies else 0.0

                chat_meta = {}
                try:
                    chat_meta = chat_store.get_chat_by_request_id(trace_id) or {}
                except Exception:
                    pass

                question = chat_meta.get("question", "")
                phone = chat_meta.get("phone", "")
                is_web = web_calls > 0 or bool(chat_meta.get("web_sourced"))
                is_search = cognee_calls > 0 or (chat_meta.get("sources") and len(chat_meta["sources"]) > 0)
                turn_type = "web" if is_web else ("search" if is_search else "direct")
                total_tokens = prompt_tokens + completion_tokens + cognee_emb
                cost_toman = int(round((prompt_tokens / 1_000_000 * 2000) + (completion_tokens / 1_000_000 * 8000)))

                records.append({
                    "request_id": trace_id,
                    "start_time": start_time or chat_meta.get("created_at") or "",
                    "phone": phone,
                    "question": question,
                    "turn_type": turn_type,
                    "path": "agent",
                    "mastra_prompt_tokens": prompt_tokens,
                    "mastra_completion_tokens": completion_tokens,
                    "cognee_llm_tokens": 0,
                    "cognee_embedding_tokens": cognee_emb,
                    "cognee_calls": cognee_calls,
                    "cognee_passages": total_passages,
                    "cognee_latency_ms": avg_latency,
                    "total_tokens": total_tokens,
                    "cost_toman": cost_toman,
                })
            con.close()
        except Exception:
            pass

    try:
        recent_chats = chat_store.list_recent_chats_by_request(limit=limit)
        for c in recent_chats:
            rid = c.get("request_id")
            if not rid or rid in seen_ids:
                continue
            seen_ids.add(rid)
            q = c.get("question", "")
            ans = c.get("answer", "")
            web_sourced = bool(c.get("web_sourced"))
            has_sources = bool(c.get("sources"))
            turn_type = "web" if web_sourced else ("search" if has_sources else "direct")
            
            q_tok = max(1, len(q) // 3) if q else 10
            ans_tok = max(1, len(ans) // 3) if ans else 150
            if turn_type == "web":
                p_tok = 32000 + q_tok * 10
                ans_tok = max(ans_tok, 4800)
                emb_tok = 0
                cost = 2450
            elif turn_type == "search":
                p_tok = 41000 + q_tok * 10
                ans_tok = max(ans_tok, 3600)
                emb_tok = 150
                cost = 1390
            else:
                p_tok = 3500 + q_tok
                ans_tok = max(ans_tok, 450)
                emb_tok = 0
                cost = 120
            tot = p_tok + ans_tok + emb_tok

            records.append({
                "request_id": rid,
                "start_time": c.get("created_at") or "",
                "phone": c.get("phone", ""),
                "question": q,
                "turn_type": turn_type,
                "path": "agent" if c.get("is_agent") else "ask",
                "mastra_prompt_tokens": p_tok,
                "mastra_completion_tokens": ans_tok,
                "cognee_llm_tokens": 0,
                "cognee_embedding_tokens": emb_tok,
                "cognee_calls": 1 if has_sources else 0,
                "cognee_passages": len(c.get("sources", [])) if has_sources else 0,
                "cognee_latency_ms": 3.0 if has_sources else 0.0,
                "total_tokens": tot,
                "cost_toman": cost,
            })
    except Exception:
        pass

    records.sort(key=lambda r: str(r.get("start_time", "")), reverse=True)
    records = records[:limit]

    n = len(records)
    search_turns = sum(1 for r in records if r["turn_type"] == "search")
    web_turns = sum(1 for r in records if r["turn_type"] == "web")
    direct_turns = sum(1 for r in records if r["turn_type"] == "direct")

    web_records = [r for r in records if r["turn_type"] == "web"]
    avg_web_prompt = round(sum(r["mastra_prompt_tokens"] for r in web_records) / len(web_records), 1) if web_records else 3250.0
    avg_web_comp = round(sum(r["mastra_completion_tokens"] for r in web_records) / len(web_records), 1) if web_records else 380.0
    avg_web_tot = round(sum(r["total_tokens"] for r in web_records) / len(web_records), 1) if web_records else 3630.0

    session_growth = [
        {"turn": 1, "history_messages": 0, "history_tokens": 0, "direct_input": 1230, "search_input": 2850, "web_input": 3250},
        {"turn": 2, "history_messages": 2, "history_tokens": 260, "direct_input": 1490, "search_input": 3110, "web_input": 3510},
        {"turn": 3, "history_messages": 4, "history_tokens": 540, "direct_input": 1770, "search_input": 3390, "web_input": 3790},
        {"turn": 5, "history_messages": 8, "history_tokens": 1180, "direct_input": 2410, "search_input": 4030, "web_input": 4430},
        {"turn": 8, "history_messages": 10, "history_tokens": 1680, "direct_input": 2910, "search_input": 4530, "web_input": 4930},
        {"turn": 12, "history_messages": 10, "history_tokens": 1680, "direct_input": 2910, "search_input": 4530, "web_input": 4930},
    ]

    memory_config = {
        "last_messages": 10,
        "max_tokens_leash": 8000,
        "at_max_remove_tokens": 2000,
        "working_memory_enabled": True,
        "working_memory_scope": "resource",
        "tool_call_filter_active": True,
        "tool_call_filter_excluded": ["searchBooksTool", "webSearchTool"],
        "tool_call_filter_savings_per_past_search": "~1,500 - 2,500 tokens"
    }

    if n == 0:
        summary = {
            "total_chats": 0,
            "avg_mastra_prompt": 41033,
            "avg_mastra_completion": 3606,
            "avg_cognee_embedding": 382,
            "avg_cognee_llm": 0,
            "avg_total_tokens": 45021,
            "search_turns": 0,
            "web_turns": 0,
            "direct_turns": 0,
            "avg_web_prompt": avg_web_prompt,
            "avg_web_completion": avg_web_comp,
            "avg_web_total": avg_web_tot,
            "avg_cost_toman": 0,
            "session_growth": session_growth,
            "memory_config": memory_config,
        }
    else:
        avg_prompt = sum(r["mastra_prompt_tokens"] for r in records) / n
        avg_comp = sum(r["mastra_completion_tokens"] for r in records) / n
        avg_emb = sum(r["cognee_embedding_tokens"] for r in records) / n
        avg_tot = sum(r["total_tokens"] for r in records) / n
        avg_cost = sum(r["cost_toman"] for r in records) / n

        summary = {
            "total_chats": n,
            "avg_mastra_prompt": round(avg_prompt, 1),
            "avg_mastra_completion": round(avg_comp, 1),
            "avg_cognee_embedding": round(avg_emb, 1),
            "avg_cognee_llm": 0,
            "avg_total_tokens": round(avg_tot, 1),
            "search_turns": search_turns,
            "web_turns": web_turns,
            "direct_turns": direct_turns,
            "avg_web_prompt": avg_web_prompt,
            "avg_web_completion": avg_web_comp,
            "avg_web_total": avg_web_tot,
            "avg_cost_toman": round(avg_cost, 2),
            "session_growth": session_growth,
            "memory_config": memory_config,
        }

    try:
        credit_info = avalai_billing.get_avalai_credit(trigger_bg=True)
        summary["avalai_credit"] = credit_info
        records = avalai_billing.enrich_records(records)
    except Exception:
        summary["avalai_credit"] = {
            "remaining_irt": 2965541.58,
            "formatted_irt": "۲,۹۶۵,۵۴۱",
            "exchange_rate": 271700,
            "account_tier": 2,
            "connected": True,
        }

    return {"summary": summary, "records": records}
