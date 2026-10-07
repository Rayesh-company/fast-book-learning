"""Portable Book narration host: stdlib authority checks, isolated Node TTS.

No credentials, model path, provider URL or executable come from request JSON.
The HTTP host must apply its normal Account authorization before calling this.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import hashlib
from functools import lru_cache

try:
    from ui.narration_cache import AudioCache, cache_key
except ImportError:
    from narration_cache import AudioCache, cache_key

_RUNTIME = Path(__file__).resolve().parent / 'narration' / 'generate.mjs'
_PDF_SOURCE = _RUNTIME.with_name('pdf-source.mjs')
# One bounded generation per host process; avoid unbounded paid work/model loads.
_GENERATION_LOCK = threading.Lock()
_AUDIO_CACHE = AudioCache()
_MAX_SELECTION_BYTES = 24_000
_MAX_PAGE_BYTES = 240_000
_APPROVED_BASES = {'https://api.avalai.ir', 'https://api.avalapis.ir', 'https://api.avalai.org'}
_MESSAGES = {
    'NARRATION_SELECTION_UNMAPPED': 'متن انتخاب‌شده با متن مرجع این صفحه تطبیق ندارد.',
    'NARRATION_SOURCE_NOT_FOUND': 'متن مرجع این کتاب در دسترس نیست.',
    'NARRATION_PROVIDER_NOT_CONFIGURED': 'سرویس ساخت صدا تنظیم نشده است.',
    'NARRATION_RUNTIME_UNAVAILABLE': 'محیط ساخت صدا روی سرور آماده نیست.',
    'NARRATION_PROVIDER_AUTH_FAILED': 'دسترسی به سرویس ساخت صدا تأیید نشد.',
    'NARRATION_PROVIDER_CREDIT_EXHAUSTED': 'اعتبار سرویس ساخت صدا تمام شده است.',
    'NARRATION_PROVIDER_RATE_LIMITED': 'سرویس ساخت صدا موقتاً پراستفاده است.',
    'NARRATION_PROVIDER_UNAVAILABLE': 'سرویس ساخت صدا در دسترس نیست.',
    'NARRATION_REQUEST_TIMEOUT': 'ساخت صدا بیش از حد طول کشید.',
    'NARRATION_DIACRITIZATION_INVALID': 'متن گفتاری تأیید نشد؛ ساخت صدا متوقف شد.',
    'NARRATION_INPUT_UNSUPPORTED': 'این بخش برای ساخت صدا پشتیبانی نمی‌شود.',
    'NARRATION_AUDIO_INVALID': 'صدای تولیدشده معتبر نیست.',
    'NARRATION_BUSY': 'ساخت صدای دیگری در حال انجام است؛ کمی بعد تلاش کنید.',
}


class NarrationError(Exception):
    """A stable, secret-free error for the HTTP boundary."""
    def __init__(self, code: str, status: int | None = None, retry_after_ms=None):
        self.code = code
        self.message = _MESSAGES.get(code, 'ساخت صدا برای این بخش کامل نشد.')
        self.messageFa = self.message
        self.status = status or (400 if code in {'NARRATION_SELECTION_UNMAPPED', 'NARRATION_INPUT_UNSUPPORTED'} else 503)
        self.retry_after_ms = retry_after_ms
        super().__init__(self.message)


def _node_binary():
    return shutil.which(os.environ.get('NARRATION_NODE_BIN', 'node'))


def _provider_configured():
    base = os.environ.get('AVALAI_API_BASE_URL', '').rstrip('/')
    return bool((os.environ.get('AVALAI_TTS_API_KEY', '').strip() or os.environ.get('AVALAI_API_KEY', '').strip()) and (not base or base in _APPROVED_BASES))


def narration_status():
    """Configuration availability; provider auth/model validity need a real run."""
    node = _node_binary()
    runtime = False
    if node:
        try:
            probe = subprocess.run([node, '--input-type=module', '-e',
                "const [major,minor]=process.versions.node.split('.').map(Number); if(major<22||(major===22&&minor<13))process.exit(1); await import('pdfjs-dist/legacy/build/pdf.mjs');"],
                cwd=_RUNTIME.parent, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=10)
            runtime = probe.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
    model = os.environ.get('NARRATION_ALIGNMENT_MODEL', '')
    alignment = 'unavailable'
    if runtime and model and Path(model).is_file():
        try:
            probe = subprocess.run([node, '--input-type=module', '-e', "await (await import('./alignment/runtime.mjs')).loadOnnxRuntime();"], cwd=_RUNTIME.parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if probe.returncode == 0:
                alignment = 'available'
        except (OSError, subprocess.TimeoutExpired):
            pass
    return {
        'provider': {'status': 'available' if _provider_configured() else 'not-configured'},
        'alignment': {'status': alignment},
        'runtime': {'status': 'available' if runtime and _RUNTIME.is_file() else 'unavailable'},
        'profile': {'model': 'gemini-2.5-flash-tts', 'voice': 'Kore'},
    }


@lru_cache(maxsize=64)
def _extract_pdf_page(path, page, size, modified_ns):
    """Cache only trusted PDF text; the file fingerprint invalidates changes."""
    node = _node_binary()
    if not node:
        raise NarrationError('NARRATION_RUNTIME_UNAVAILABLE')
    try:
        process = subprocess.run([node, str(_PDF_SOURCE), path, str(page)],
                                 capture_output=True, text=True, timeout=60,
                                 cwd=_RUNTIME.parent)
        result = json.loads(process.stdout)
        if process.returncode or not result.get('ok') or not isinstance(result.get('text'), str):
            raise ValueError
        if len(result['text'].encode('utf-8')) > _MAX_PAGE_BYTES:
            raise ValueError
        return result['text']
    except subprocess.TimeoutExpired:
        raise NarrationError('NARRATION_REQUEST_TIMEOUT') from None
    except (OSError, ValueError, TypeError):
        raise NarrationError('NARRATION_SOURCE_NOT_FOUND', 404) from None


def _canonical_page_text(book_path, page):
    """Same PDF.js version and emission as the reader; no old index guessing."""
    if not (_RUNTIME.parent / 'node_modules' / 'pdfjs-dist' / 'legacy' / 'build' / 'pdf.mjs').is_file():
        raise NarrationError('NARRATION_RUNTIME_UNAVAILABLE')
    try:
        book_path = Path(book_path).resolve(strict=True)
        stat = book_path.stat()
    except OSError:
        raise NarrationError('NARRATION_SOURCE_NOT_FOUND', 404) from None
    return _extract_pdf_page(str(book_path), page, stat.st_size, stat.st_mtime_ns)


def _validate_selection(document, request, books_dir):
    if not isinstance(document, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,150}', document) or '..' in document:
        raise NarrationError('NARRATION_SOURCE_NOT_FOUND', 404)
    if not isinstance(request, dict):
        raise NarrationError('NARRATION_SELECTION_UNMAPPED')
    page, start, end = (request.get(key) for key in ('page', 'start', 'end'))
    text, page_text = request.get('text'), request.get('pageText')
    if any(type(number) is not int for number in (page, start, end)) or page < 1 or start < 0 or end <= start:
        raise NarrationError('NARRATION_SELECTION_UNMAPPED')
    if not isinstance(text, str) or not isinstance(page_text, str) or not text.strip():
        raise NarrationError('NARRATION_SELECTION_UNMAPPED')
    try:
        if len(text.encode('utf-8')) > _MAX_SELECTION_BYTES or len(page_text.encode('utf-8')) > _MAX_PAGE_BYTES:
            raise NarrationError('NARRATION_INPUT_UNSUPPORTED')
        encoded = page_text.encode('utf-16-le')
        if end * 2 > len(encoded) or encoded[start * 2:end * 2].decode('utf-16-le') != text:
            raise NarrationError('NARRATION_SELECTION_UNMAPPED')
    except UnicodeError:
        raise NarrationError('NARRATION_SELECTION_UNMAPPED') from None
    trusted = _canonical_page_text(Path(books_dir) / f'{document}.pdf', page)
    if page_text != trusted:
        raise NarrationError('NARRATION_SELECTION_UNMAPPED')
    return {'page': page, 'start': start, 'end': end, 'text': text}


def generate_narration(document, request, *, books_dir=None, provider_options=None):
    """Return real PCM WAV and actual CTC cues (or explicitly absent cues).

    ``provider_options`` is a trusted test seam, never passed from request JSON.
    ``books_dir`` defaults to the Session host's existing Books mount.
    """
    books_dir = books_dir or os.environ.get('SESSION_BOOKS_DIR', str(_RUNTIME.parents[2] / 'books'))
    payload = _validate_selection(document, request, books_dir)
    model = os.environ.get('NARRATION_ALIGNMENT_MODEL', '')
    try:
        model_stat = Path(model).stat() if model else None
        model_identity = [model, model_stat.st_size, model_stat.st_mtime_ns] if model_stat else None
    except OSError:
        model_identity = [model, 'missing']
    configuration = narration_status()
    identity = cache_key(document, payload, 'tuba-fa-narration-v5',
                         os.environ.get('AVALAI_API_BASE_URL', ''), model_identity,
                         configuration['alignment']['status'], provider_options,
                         hashlib.sha256(request['pageText'].encode('utf-8')).hexdigest())
    cached = _AUDIO_CACHE.get(identity)
    if cached is not None:
        return cached
    if not _provider_configured():
        raise NarrationError('NARRATION_PROVIDER_NOT_CONFIGURED')
    node = _node_binary()
    if not node:
        raise NarrationError('NARRATION_RUNTIME_UNAVAILABLE')
    if provider_options is not None:
        payload['providerOptions'] = provider_options
    if not _GENERATION_LOCK.acquire(blocking=False):
        raise NarrationError('NARRATION_BUSY', 429)
    try:
        # Input-size bound and each provider's timeout bound the job. No stderr
        # or raw provider diagnostics are exposed to the HTTP client or logs.
        paragraphs = max(1, len(payload['text']) // 1000 + 1)
        timeout = min(3600, 360 * paragraphs + 30)
        try:
            process = subprocess.run([node, str(_RUNTIME)], input=json.dumps(payload, ensure_ascii=False), capture_output=True, text=True, timeout=timeout, cwd=_RUNTIME.parent)
        except subprocess.TimeoutExpired:
            raise NarrationError('NARRATION_REQUEST_TIMEOUT') from None
        except OSError:
            raise NarrationError('NARRATION_RUNTIME_UNAVAILABLE') from None
        try:
            result = json.loads(process.stdout)
        except (ValueError, TypeError):
            raise NarrationError('NARRATION_GENERATION_FAILED') from None
        if process.returncode != 0 or not result.get('ok'):
            error = result.get('error') or {}
            code = error.get('code', 'NARRATION_GENERATION_FAILED')
            status = 429 if code == 'NARRATION_PROVIDER_RATE_LIMITED' else None
            raise NarrationError(code, status, error.get('retryAfterMs'))
        audio = result['result']
        if audio.get('alignment', {}).get('status') != 'failed':
            _AUDIO_CACHE.put(identity, audio)
        return audio
    finally:
        _GENERATION_LOCK.release()
