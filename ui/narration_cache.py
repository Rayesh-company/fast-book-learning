"""A bounded ephemeral audio cache; callers must revalidate Book authority."""
from collections import OrderedDict
import hashlib
import json
import threading
import time


def cache_key(*identity_components):
    """Bind Book, canonical slice, profile and model/configuration identities."""
    return hashlib.sha256(json.dumps(identity_components, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


class AudioCache:
    def __init__(self, *, max_bytes=64 * 1024 * 1024, max_entries=32, ttl_seconds=3600, clock=time.monotonic):
        self._max_bytes = max_bytes
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._entries = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def _discard(self, key):
        value = self._entries.pop(key, None)
        if value is not None:
            self._bytes -= len(value[1])

    def get(self, key):
        with self._lock:
            value = self._entries.get(key)
            if value is None:
                return None
            if self._clock() >= value[0]:
                self._discard(key)
                return None
            self._entries.move_to_end(key)
            # The JSON byte buffer is private; each caller owns a fresh result.
            return json.loads(value[1])

    def put(self, key, result):
        encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if len(encoded) > self._max_bytes or self._max_entries < 1:
            return False
        with self._lock:
            self._discard(key)
            now = self._clock()
            for existing, value in list(self._entries.items()):
                if now >= value[0]:
                    self._discard(existing)
            while self._entries and (self._bytes + len(encoded) > self._max_bytes or len(self._entries) >= self._max_entries):
                self._discard(next(iter(self._entries)))
            self._entries[key] = (now + self._ttl_seconds, encoded)
            self._bytes += len(encoded)
            return True

    def clear(self):
        with self._lock:
            self._entries.clear()
            self._bytes = 0
