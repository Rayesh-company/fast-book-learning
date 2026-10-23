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


def _cognee_url() -> str:
    """The Cognee service URL, read dynamically from COGNEE_URL."""
    return os.environ.get("COGNEE_URL", "http://127.0.0.1:8000").rstrip("/")


def _mastra_url() -> str:
    """The Mastra agent service URL, read dynamically from AGENT_URL."""
    return os.environ.get("AGENT_URL", "http://127.0.0.1:4111").rstrip("/")


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
            span_id = s.get("id", "")
            pt = s.get("promptTokens") or (s.get("attributes") or {}).get("promptTokens")
            ct = s.get("completionTokens") or (s.get("attributes") or {}).get("completionTokens")
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
