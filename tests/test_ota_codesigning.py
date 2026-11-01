"""F-019 of the 2026-11-01 mobile review: the OTA manifest is signed.

The publish script signs the exact manifest bytes with the operator's
private key and parks the base64 signature in ``manifest.sig.json``; the
sheet answers ``GET /ota`` with the same body plus the ``expo-signature``
header (an RFC 8941 dictionary: sig, keyid, alg). A code-signing APK
refuses anything else. The signer is pure stdlib, so the tests carry its
own throwaway 1024-bit key — a test fixture, never a real credential.
"""

import base64
import json
import sys

import pytest

from tests.conftest import REPO_ROOT

sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from scripts import ota_codesigning  # noqa: E402
from ui import serve  # noqa: E402

# A throwaway test-only keypair — generated for this suite, worthless.
TEST_KEY_PEM = """-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQCwN8gMqxHpZuZmUUlXhUkTfSHWbVJ+VIfuAbZGbqs1aasac/Rc
VfRT1lp6MMAYFnrzR9HT/kVequfFeAs4hh7ScSMm8jYvGwK2LAiV7YRHxgx7dBgv
7NDiDlKj7DB1OItPRin6cJv47uyzcBmXJIBhkdpSh4RnzmbFE8zdlNQh2QIDAQAB
AoGBAJugd/2wK359USe1zFcOMG6UyYiNPhix4OZy/p6PaIcgjmsrUvklNEXCfl+B
pHThja5DlG1sF6m2uEBud0JxOM/czo7dfWnrf4LaB56cS4Tw96off6gw/B4MM2Bg
L8KP4b7Mtglit8rjwG++cLm6h9zl0kTRxtWaOSiL4BMmaIQtAkEA1b3d7zFvStDC
qbKzsfNkzjQsQqTBuaWnBoro1Xwi1mEO9DGQFLVUt+5G05EacLwyxBa9CbAb9qqN
9YkpDp9uRwJBANMOuCPU6rrvqW81UG6/owpCfg3ptBJpHgpexj/5mKUMcQZERRQU
QyGsZs34urdcEUSq1ZXWxqFDKaVC2xhjXt8CQEH82SzEfVCCvOZ5NkMFGqUStGtq
xChVfQhnEFUAexzmYCCBwLKz/NDALnuYu6n8YEvrnTcFeMyhgSxByTwrencCQFoz
ez1NHPjBvq8ZoQOEAYE8A7WcgOoxZLZX5PCokrVPSOq9uKwpMLuue81hlSMSRQsM
2/WK8h8vnhfUJ+EXbw8CQQCj2eGXE5KjxSSuuE4jyo/vPZRgrnkNXAMBFgGkuUd/
rFe/romkOyfCWHeV2LeQLMIHvJ3a74onN6svEUqpp/ML
-----END RSA PRIVATE KEY-----
"""


def _test_key():
    return ota_codesigning.load_private_key_pem(TEST_KEY_PEM)


def _sign(pem: str, data: bytes) -> bytes:
    n, e, d = ota_codesigning.load_private_key_pem(pem)
    return ota_codesigning.sign_pkcs1_v15_sha256(n, d, data)


def test_sign_and_verify_round_trip():
    n, e, _ = _test_key()
    data = b'{"id": "manifest-body", "runtimeVersion": "1.0.0"}'
    signature = _sign(TEST_KEY_PEM, data)
    assert len(signature) == (n.bit_length() + 7) // 8
    assert ota_codesigning.verify_pkcs1_v15_sha256(n, e, data, signature)


def test_verify_rejects_a_tampered_body():
    n, e, _ = _test_key()
    signature = _sign(TEST_KEY_PEM, b"the published manifest")
    assert not ota_codesigning.verify_pkcs1_v15_sha256(
        n, e, b"the tampered manifest", signature
    )


def test_pkcs8_wrapper_loads_like_pkcs1():
    """The openssl `genpkey` shape wraps the same PKCS#1 payload — the
    loader accepts both so a regenerated key never surprises the publish
    script."""
    import base64 as b64

    pkcs1_der = b64.b64decode(
        "".join(
            TEST_KEY_PEM.split("-----BEGIN RSA PRIVATE KEY-----")[1]
            .split("-----END RSA PRIVATE KEY-----")[0]
            .split()
        )
    )

    def tlv(tag: int, content: bytes) -> bytes:
        if len(content) < 0x80:
            length = bytes([len(content)])
        else:
            raw = len(content).to_bytes((len(content).bit_length() + 7) // 8, "big")
            length = bytes([0x80 | len(raw)]) + raw
        return bytes([tag]) + length + content

    algorithm = tlv(0x30, tlv(0x06, bytes.fromhex("2a864886f70d010101")) + tlv(0x05, b""))
    pkcs8 = tlv(0x30, tlv(0x02, b"\x00") + algorithm + tlv(0x04, pkcs1_der))
    wrapped = (
        "-----BEGIN PRIVATE KEY-----\n"
        + b64.b64encode(pkcs8).decode("ascii")
        + "\n-----END PRIVATE KEY-----\n"
    )
    assert ota_codesigning.load_private_key_pem(wrapped) == _test_key()


def test_bad_pem_is_rejected_loudly():
    with pytest.raises(ota_codesigning.KeyFormatError):
        ota_codesigning.load_private_key_pem("-----BEGIN RSA PRIVATE KEY-----\nnope\n")


def test_signature_header_is_the_rfc8941_dictionary_the_client_parses():
    header = ota_codesigning.signature_header("QUJD", "main", "rsa-v1_5-sha256")
    assert header == 'sig="QUJD", keyid="main", alg="rsa-v1_5-sha256"'


def test_the_publish_script_signs_when_the_key_env_is_set(tmp_path, monkeypatch):
    """Publishing into a temp out dir with the test key: the sidecar
    exists, and its signature verifies over the exact manifest bytes."""
    import importlib

    export = tmp_path / "export"
    bundle_dir = export / "_expo" / "static" / "js" / "android"
    bundle_dir.mkdir(parents=True)
    (bundle_dir / "abc123.js").write_bytes(b"// bundle")
    out = tmp_path / "ota"
    monkeypatch.setenv("CWB_OTA_PRIVATE_KEY", str(tmp_path / "key.pem"))
    (tmp_path / "key.pem").write_text(TEST_KEY_PEM, encoding="utf-8")
    monkeypatch.setattr(
        sys, "argv",
        ["publish_ota.py", str(export), "--out", str(out),
         "--base", "https://x.test"],
    )

    publish = importlib.import_module("publish_ota")
    assert publish.main() == 0
    manifest_bytes = (out / "manifest.json").read_bytes()
    sidecar = json.loads((out / "manifest.sig.json").read_text(encoding="utf-8"))
    assert sidecar["keyid"] == "main" and sidecar["alg"] == "rsa-v1_5-sha256"
    n, e, _ = _test_key()
    assert ota_codesigning.verify_pkcs1_v15_sha256(
        n, e, manifest_bytes, base64.b64decode(sidecar["signature"])
    )


def test_the_sheet_serves_the_expo_signature_header(tmp_path, monkeypatch):
    """GET /ota with a signed manifest: the body is byte-identical to the
    signed payload and the header verifies against the public key."""
    import urllib.request

    from tests.helpers import stop_gate, with_gate

    class NoUpstream:
        def __call__(self, request, timeout=None):
            raise AssertionError("the OTA routes must never phone an upstream")

    ota_dir = tmp_path / "ota"
    ota_dir.mkdir(parents=True)
    monkeypatch.setattr(serve, "OTA_DIR", ota_dir)
    body = json.dumps(
        {"id": "signed-test", "runtimeVersion": "1.0.0",
         "launchAsset": {"url": "https://x/ota/current/b.js"}, "assets": []}
    ).encode("utf-8")
    (ota_dir / "manifest.json").write_bytes(body)
    signature = _sign(TEST_KEY_PEM, body)
    (ota_dir / "manifest.sig.json").write_text(
        json.dumps({
            "signature": base64.b64encode(signature).decode("ascii"),
            "keyid": "main",
            "alg": "rsa-v1_5-sha256",
        }),
        encoding="utf-8",
    )

    base, server, original = with_gate(tmp_path, NoUpstream())
    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/ota"), timeout=10) as response:
            assert response.status == 200
            assert response.read() == body
            header = response.headers["expo-signature"]
        assert header == 'sig="{}", keyid="{}", alg="{}"'.format(
            base64.b64encode(signature).decode("ascii"), "main", "rsa-v1_5-sha256"
        )
        sig_b64 = header.split('sig="')[1].split('"')[0]
        n, e, _ = _test_key()
        assert ota_codesigning.verify_pkcs1_v15_sha256(
            n, e, body, base64.b64decode(sig_b64)
        )

        # The unsigned shape stays: without the sidecar, no header —
        # the pre-certificate APKs keep their protocol.
        (ota_dir / "manifest.sig.json").unlink()
        with urllib.request.urlopen(urllib.request.Request(base + "/ota"), timeout=10) as response:
            assert response.status == 200
            assert response.headers.get("expo-signature") is None
    finally:
        stop_gate(server, original)


def test_the_publish_script_wires_the_signer():
    """The publish script carries the signing seam: env key, sidecar
    write, self-verification — F-019's chain in one place."""
    script = (REPO_ROOT / "scripts" / "publish_ota.py").read_text(encoding="utf-8")
    assert "CWB_OTA_PRIVATE_KEY" in script
    assert "manifest.sig.json" in script
    assert "sign_pkcs1_v15_sha256" in script
    assert "verify_pkcs1_v15_sha256" in script
    codesigning = (REPO_ROOT / "scripts" / "ota_codesigning.py").read_text(encoding="utf-8")
    assert "expo-signature" in codesigning or "sig=" in codesigning
