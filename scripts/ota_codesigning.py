#!/usr/bin/env python3
"""Pure-stdlib RSA PKCS#1 v1.5 SHA-256 signing for the OTA manifest.

F-019 of the 2026-11-01 mobile review: the expo-updates client embedded in
a code-signing-configured APK refuses any manifest without a valid
``expo-signature`` header, so every publish signs the exact manifest bytes
with the operator's private key (never on the server, never in git). The
runtime has no ``cryptography`` (the ui image ships stdlib only), so the
primitive lives here: a minimal DER reader over a PKCS#1 (and PKCS#8)
private-key PEM, EMSA-PKCS1-v1_5 padding, and raw RSA. Verified against
openssl during the review that introduced it (openssl dgst -verify), and
by ``verify_pkcs1_v15_sha256`` in the tests.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re

# DER header of DigestInfo(SHA-256): SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


class KeyFormatError(ValueError):
    """The PEM is not a readable RSA private key (PKCS#1 or PKCS#8)."""


def _read_tlv(der: bytes, offset: int) -> tuple[int, bytes, int]:
    """One DER TLV at `offset`: (tag, content, offset-after). Lengths are
    the short form or the long form (up to 4 length bytes) — all this
    schema ever produces."""
    if offset + 2 > len(der):
        raise KeyFormatError("truncated DER")
    tag = der[offset]
    first = der[offset + 1]
    offset += 2
    if first < 0x80:
        length = first
    else:
        count = first & 0x7F
        if not 1 <= count <= 4 or offset + count > len(der):
            raise KeyFormatError("unsupported DER length")
        length = int.from_bytes(der[offset : offset + count], "big")
        offset += count
    if offset + length > len(der):
        raise KeyFormatError("truncated DER value")
    return tag, der[offset : offset + length], offset + length


def _read_integer_sequence(der: bytes, wanted: int) -> list[int]:
    """The INTEGERs of a SEQUENCE, in order; at least `wanted` of them."""
    tag, content, _ = _read_tlv(der, 0)
    if tag != 0x30:
        raise KeyFormatError("expected a DER SEQUENCE")
    integers: list[int] = []
    offset = 0
    while offset < len(content) and len(integers) < wanted:
        itag, ivalue, offset = _read_tlv(content, offset)
        if itag != 0x02:
            break
        integers.append(int.from_bytes(ivalue, "big"))
    if len(integers) < wanted:
        raise KeyFormatError("expected more INTEGERs in the SEQUENCE")
    return integers


def _pem_body(pem_text: str, label: str) -> bytes:
    match = re.search(
        rf"-----BEGIN {label}-----(.*?)-----END {label}-----",
        pem_text,
        re.DOTALL,
    )
    if match is None:
        raise KeyFormatError(f"no {label} PEM block found")
    try:
        return base64.b64decode("".join(match.group(1).split()))
    except (binascii.Error, ValueError) as exc:
        raise KeyFormatError("the PEM body is not valid base64") from exc


def parse_pkcs1_private_key(der: bytes) -> tuple[int, int, int]:
    """RSAPrivateKey ::= SEQUENCE { version, n, e, d, ... } — the first
    four INTEGERs; the CRT factors stay unread."""
    version, n, e, d = _read_integer_sequence(der, 4)
    if version != 0:
        raise KeyFormatError("unsupported RSAPrivateKey version")
    return n, e, d


def load_private_key_pem(pem_text: str) -> tuple[int, int, int]:
    """(n, e, d) from a PKCS#1 (``BEGIN RSA PRIVATE KEY``) or PKCS#8
    (``BEGIN PRIVATE KEY``) PEM. The expo codesigning generator emits
    PKCS#1; openssl genpkey emits PKCS#8 — both accepted."""
    try:
        return parse_pkcs1_private_key(_pem_body(pem_text, "RSA PRIVATE KEY"))
    except KeyFormatError:
        pass
    tag, content, _ = _read_tlv(_pem_body(pem_text, "PRIVATE KEY"), 0)
    if tag != 0x30:
        raise KeyFormatError("PKCS#8 payload is not a SEQUENCE")
    itag, ivalue, offset = _read_tlv(content, 0)  # version
    if itag != 0x02:
        raise KeyFormatError("PKCS#8 payload is malformed")
    atag, _, offset = _read_tlv(content, offset)  # AlgorithmIdentifier
    if atag != 0x30:
        raise KeyFormatError("PKCS#8 payload has no AlgorithmIdentifier")
    ktag, kvalue, _ = _read_tlv(content, offset)  # privateKey OCTET STRING
    if ktag != 0x04:
        raise KeyFormatError("PKCS#8 payload has no privateKey")
    return parse_pkcs1_private_key(kvalue)


def sign_pkcs1_v15_sha256(n: int, d: int, data: bytes) -> bytes:
    """EMSA-PKCS1-v1_5 over SHA-256, raw RSA — the bytes expo-updates
    verifies. The signature is modulus-length, big-endian."""
    k = (n.bit_length() + 7) // 8
    t = _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(data).digest()
    ps = b"\xff" * (k - len(t) - 3)
    if k - len(t) < 8:
        raise KeyFormatError("key too small for PKCS#1 v1.5 SHA-256")
    em = b"\x00\x01" + ps + b"\x00" + t
    signature = pow(int.from_bytes(em, "big"), d, n)
    return signature.to_bytes(k, "big")


def verify_pkcs1_v15_sha256(n: int, e: int, data: bytes, signature: bytes) -> bool:
    """The same padding, reversed — the tests' ground truth and the
    self-check a publish runs after signing."""
    k = (n.bit_length() + 7) // 8
    if len(signature) != k:
        return False
    em = pow(int.from_bytes(signature, "big"), e, n).to_bytes(k, "big")
    expected = (
        b"\x00\x01"
        + b"\xff" * (k - len(_SHA256_DIGEST_INFO_PREFIX) - hashlib.sha256().digest_size - 3)
        + b"\x00"
        + _SHA256_DIGEST_INFO_PREFIX
        + hashlib.sha256(data).digest()
    )
    return em == expected


def signature_header(signature_b64: str, keyid: str, alg: str) -> str:
    """The RFC 8941 dictionary the client parses out of ``expo-signature``
    (expo.modules.structuredheaders: sig/keyid/alg StringItems)."""
    return f'sig="{signature_b64}", keyid="{keyid}", alg="{alg}"'
