"""Book-bound narration: real HTTP audio fixture and pure forced alignment."""
import base64
import importlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import wave

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEXT = 'کتاب خوب است.'


def module():
    if importlib.util.find_spec('ui.narration') is None:
        pytest.fail('Portable Book narration module is missing')
    return importlib.import_module('ui.narration')


@pytest.fixture(autouse=True)
def controlled_book_authority(monkeypatch):
    """Unit tests isolate canonical PDF authority; the PDF test runs it for real."""
    narration = module()
    real = narration._canonical_page_text
    def trusted_page(path, page):
        fixture = Path(path).with_suffix('.pages.json')
        if fixture.exists():
            return json.loads(fixture.read_text())['pages'][str(page)]
        return real(path, page)
    monkeypatch.setattr(narration, '_canonical_page_text', trusted_page)


def pcm_fixture():
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b''.join(struct.pack('<h', int(1000 * math.sin(i / 10))) for i in range(16000)))
    return output.getvalue()


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv('AVALAI_TTS_API_KEY', 'fixture-key')
    monkeypatch.delenv('NARRATION_ALIGNMENT_MODEL', raising=False)
    requests = []
    state = {'status': 200, 'audio': pcm_fixture(), 'candidate': 'کِتابِ خوب اَست.'}
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append((self.path, payload, self.headers.get('Authorization')))
            if self.path == '/chat':
                body = json.dumps({'choices': [{'message': {'content': json.dumps({'text': state['candidate']})}}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
            else:
                body = state['audio']
                self.send_response(state['status'])
                self.send_header('Content-Type', 'audio/L16')
                if state['status'] == 302:
                    self.send_header('Location', '/should-never-follow')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    yield {'endpoint': base + '/speech', 'diacritizerEndpoint': base + '/chat'}, requests, state
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def book(tmp_path):
    (tmp_path / 'book.pages.json').write_text(json.dumps({'pages': {'1': TEXT}}))
    return tmp_path


def body(text=TEXT, page_text=TEXT):
    return {'page': 1, 'start': 0, 'end': len(text.encode('utf-16-le')) // 2, 'text': text, 'pageText': page_text}


def test_generation_speaks_validated_variant_and_returns_real_wav(book, provider):
    opts, calls, state = provider
    result = module().generate_narration('book', body(), books_dir=book, provider_options=opts)
    assert base64.b64decode(result['audioBase64']) == state['audio']
    assert result['durationMs'] == 1000
    assert result['cues'] == []
    assert result['alignment']['status'] == 'unavailable'
    assert calls[0][1]['model'] == 'deepseek-v4-flash'
    assert calls[1][1] == {'model': 'gemini-2.5-flash-tts', 'voice': 'Kore', 'input': 'کِتابِ خوب اَست.', 'response_format': 'wav'}
    assert all(call[2] == 'Bearer fixture-key' for call in calls)
    assert 'fixture-key' not in json.dumps(result)


@pytest.mark.parametrize('change', [ {'text': 'متن جعلی'}, {'start': True}, {'page': 0}, {'end': 999}, {'pageText': 'متن جعلی'} ])
def test_untrusted_selection_rejected_before_provider(book, provider, change):
    opts, calls, _ = provider
    request = body()
    request.update(change)
    with pytest.raises(module().NarrationError):
        module().generate_narration('book', request, books_dir=book, provider_options=opts)
    assert calls == []


def test_client_cannot_supply_provider_configuration(book, provider):
    opts, calls, _ = provider
    request = body()
    request['providerOptions'] = {'endpoint': 'http://evil.invalid'}
    module().generate_narration('book', request, books_dir=book, provider_options=opts)
    assert calls[1][0] == '/speech'


def test_canonical_authority_does_not_depend_on_legacy_page_index(book, provider, monkeypatch):
    (book / 'book.pages.json').write_text(json.dumps({'pages': {'1': 'stale index with reversed glyphs'}}))
    monkeypatch.setattr(module(), '_canonical_page_text', lambda path, page: TEXT)
    module().generate_narration('book', body(), books_dir=book, provider_options=provider[0])


def test_changed_diacritizer_letters_cannot_be_spoken(book, provider):
    opts, calls, state = provider
    state['candidate'] = 'این متن عوض شده است.'
    with pytest.raises(module().NarrationError) as error:
        module().generate_narration('book', body(), books_dir=book, provider_options=opts)
    assert error.value.code == 'NARRATION_DIACRITIZATION_INVALID'
    assert [call[0] for call in calls] == ['/chat', '/chat']


@pytest.mark.parametrize('status,code', [(401, 'NARRATION_PROVIDER_AUTH_FAILED'), (402, 'NARRATION_PROVIDER_CREDIT_EXHAUSTED'), (429, 'NARRATION_PROVIDER_RATE_LIMITED'), (500, 'NARRATION_PROVIDER_UNAVAILABLE'), (302, 'NARRATION_PROVIDER_UNAVAILABLE')])
def test_http_failures_are_classified_without_retry_or_redirect(book, provider, status, code):
    opts, calls, state = provider
    state['status'] = status
    with pytest.raises(module().NarrationError) as error:
        module().generate_narration('book', body(), books_dir=book, provider_options=opts)
    assert error.value.code == code
    assert [call[0] for call in calls] == ['/chat', '/speech']


def test_not_configured_never_contacts_provider(book, provider, monkeypatch):
    monkeypatch.delenv('AVALAI_TTS_API_KEY', raising=False)
    monkeypatch.delenv('AVALAI_API_KEY', raising=False)
    with pytest.raises(module().NarrationError) as error:
        module().generate_narration('book', body(), books_dir=book, provider_options=provider[0])
    assert error.value.code == 'NARRATION_PROVIDER_NOT_CONFIGURED'
    assert provider[1] == []


def test_invalid_audio_is_rejected(book, provider):
    opts, _, state = provider
    state['audio'] = b'RIFF' + b'\0' * 40
    with pytest.raises(module().NarrationError) as error:
        module().generate_narration('book', body(), books_dir=book, provider_options=opts)
    assert error.value.code in {'NARRATION_AUDIO_INVALID', 'NARRATION_GENERATION_FAILED'}


def test_ctc_alignment_uses_observed_pcm_frame_ranges():
    target = ROOT / 'ui/narration/aligner.mjs'
    assert target.is_file(), 'Extracted forced aligner is missing'
    script = """
import {alignChunk} from './ui/narration/aligner.mjs';
const input = JSON.parse(await new Promise(resolve => {let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));}));
const logits = new Float32Array(8*67).fill(-20);
[0,33,33,0,37,37,0,0].forEach((id,t)=>logits[t*67+id]=20);
const result = await alignChunk({wavBytes:Buffer.from(input.wav,'base64'),speechSlice:'ب. ت.',sliceStart:0,sentences:[{sentenceId:'b',range:{start:0,end:2}},{sentenceId:'t',range:{start:3,end:5}}],model:{inputSampleRate:16000,modelIdentity:'controlled-emissions',compute:async()=>({frameCount:8,vocabSize:67,logits})}});
process.stdout.write(JSON.stringify(result));
"""
    proc = subprocess.run([shutil.which('node'), '--input-type=module', '-e', script], cwd=ROOT, input=json.dumps({'wav': base64.b64encode(pcm_fixture()).decode()}), text=True, capture_output=True, check=True)
    result = json.loads(proc.stdout)
    assert result['timings'] == [{'sentenceId': 'b', 'startMs': 125, 'endMs': 375}, {'sentenceId': 't', 'startMs': 500, 'endMs': 750}]


def test_utf16_selection_respects_astral_character_boundary(tmp_path, provider):
    text = '😀 ' + TEXT
    (tmp_path / 'book.pages.json').write_text(json.dumps({'pages': {'1': text}}))
    request = body(TEXT, text)
    request.update(start=3, end=3 + len(TEXT))
    result = module().generate_narration('book', request, books_dir=tmp_path, provider_options=provider[0])
    assert result['durationMs'] == 1000
    request.update(start=1, end=2, text='?')
    with pytest.raises(module().NarrationError):
        module().generate_narration('book', request, books_dir=tmp_path, provider_options=provider[0])


def cache_module():
    target = ROOT / 'ui/narration_cache.py'
    assert target.is_file(), 'Bounded narration cache is missing'
    return importlib.import_module('ui.narration_cache')


def test_audio_cache_is_bounded_and_does_not_leak_mutations():
    cache = cache_module().AudioCache(max_bytes=100, max_entries=2)
    first = {'audioBase64': 'a' * 20, 'cues': []}
    assert cache.put('first', first)
    first['cues'].append('client-mutated')
    fetched = cache.get('first')
    assert fetched['cues'] == []
    fetched['cues'].append('caller-mutated')
    assert cache.get('first')['cues'] == []
    assert cache.put('second', {'audioBase64': 'b' * 20})
    assert cache.put('third', {'audioBase64': 'c' * 20})
    assert cache.get('first') is None
    assert not cache.put('oversized', {'audioBase64': 'x' * 100})


def test_audio_cache_expires_and_keys_include_model_configuration():
    time = [100]
    cache = cache_module().AudioCache(ttl_seconds=10, clock=lambda: time[0])
    key = cache_module().cache_key('book', 1, 0, 12, TEXT, 'profile5', 'model-unavailable')
    assert key != cache_module().cache_key('book', 1, 0, 12, TEXT, 'profile5', 'model-configured')
    cache.put(key, {'audioBase64': 'YQ=='})
    time[0] += 11
    assert cache.get(key) is None


def test_multiple_paragraphs_join_pcm_without_guessed_cues(book, provider):
    text = TEXT + '\n\n' + TEXT
    (book / 'book.pages.json').write_text(json.dumps({'pages': {'1': text}}))
    result = module().generate_narration('book', body(text, text), books_dir=book, provider_options=provider[0])
    with wave.open(io.BytesIO(base64.b64decode(result['audioBase64']))) as wav:
        assert wav.getnframes() == 32000
        assert wav.getframerate() == 16000
    assert result['durationMs'] == 2000
    assert result['cues'] == []
    assert [call[0] for call in provider[1]] == ['/chat', '/speech', '/chat', '/speech']


def test_chunked_or_declared_provider_audio_size_is_bounded(book, provider):
    opts = {**provider[0], 'maxBytes': 80}
    with pytest.raises(module().NarrationError) as error:
        module().generate_narration('book', body(), books_dir=book, provider_options=opts)
    assert error.value.code == 'NARRATION_INPUT_UNSUPPORTED'


def test_server_extracts_exact_canonical_text_from_real_pdf(tmp_path):
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        None,
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    content = b'BT /F1 12 Tf 72 700 Td (Portable Book authority.) Tj ET'
    objects[3] = b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream'
    data = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for offset in offsets[1:]:
        data.extend(f'{offset:010} 00000 n \n'.encode())
    data.extend(b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n')
    path = tmp_path / 'real.pdf'
    path.write_bytes(data)
    assert module()._canonical_page_text(path, 1) == 'Portable Book authority.'


def test_cached_audio_avoids_second_charge_and_revalidates_authority(book, provider):
    narration = module()
    first = narration.generate_narration('book', body(), books_dir=book, provider_options=provider[0])
    calls_after_generation = len(provider[1])
    second = narration.generate_narration('book', body(), books_dir=book, provider_options=provider[0])
    assert first == second
    assert len(provider[1]) == calls_after_generation == 2
    request = body()
    request['pageText'] = 'متن جعلی'
    with pytest.raises(narration.NarrationError):
        narration.generate_narration('book', request, books_dir=book, provider_options=provider[0])
    assert len(provider[1]) == calls_after_generation
    (book / 'book.pages.json').write_text(json.dumps({'pages': {'1': 'changed trusted PDF page'}}))
    with pytest.raises(narration.NarrationError):
        narration.generate_narration('book', body(), books_dir=book, provider_options=provider[0])
    assert len(provider[1]) == calls_after_generation
