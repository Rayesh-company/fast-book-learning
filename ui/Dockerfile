# The Session sheet uses stdlib Python. Book narration has an isolated Node
# runtime; its optional local alignment engine is enabled at build time.
FROM node:22-bookworm-slim AS narration-runtime
WORKDIR /narration
COPY narration/package*.json ./
COPY narration/alignment/package*.json ./alignment/
ARG NARRATION_WITH_ALIGNMENT=0
RUN npm ci --omit=dev && if [ "$NARRATION_WITH_ALIGNMENT" = "1" ]; then npm ci --prefix alignment --omit=dev; else mkdir -p alignment/node_modules; fi

# The interpreter, sheet, and modules serve.py facades (guard, quotas,
# composer, picker, dive, ask, chat_store, research, research_store,
# recall_more, page_resolver, accounts, audit, console, migrate, report,
# ledger, session_store, note_store).
# COGNEE_URL / NEXT_TIER_URL are set in compose to the container-network
# service names; the sheet must bind 0.0.0.0 to be reachable through the
# published port.
FROM python:3.12-slim

WORKDIR /app
COPY --from=narration-runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libatomic1 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY serve.py guard.py quotas.py composer.py picker.py dive.py ask.py chat_store.py research.py research_store.py recall_more.py page_resolver.py accounts.py audit.py console.py migrate.py report.py ledger.py session_store.py note_store.py narration.py narration_cache.py index.html ./
# The reader's client-side PDF engine (pdf.js, Apache-2.0) — vendored so
# the sheet works on a LAN with no CDN (ADR-0007).
COPY vendor /app/vendor
COPY book-reader /app/book-reader
COPY mobile /app/mobile
COPY narration /app/narration
COPY --from=narration-runtime /narration/node_modules /app/narration/node_modules
COPY --from=narration-runtime /narration/alignment/node_modules /app/narration/alignment/node_modules
# The visual pipeline: pages rasterize server-side through PDFium
# (pypdfium2 bundles the binary; Pillow encodes the PNGs) — pdf.js's
# canvas glyph-outline upgrade keeps this as a cold-path fallback (ADR-0007).
# The wheel fallback (the VPS pip times out on PyPI): the deploy plants
# the host's pinned wheels into ui/wheels/ before the build, and the
# install tries THEM FIRST with --no-index — a range spec still phones
# the index when find-links rides alone. A build without wheels (or an
# incomplete set) falls through to PyPI. The pins are identical either way.
COPY wheels /wheels/
RUN (pip install --no-cache-dir --no-index --find-links=/wheels \
      pypdfium2==5.9.0 "pillow>=10,<12" \
     || pip install --no-cache-dir pypdfium2==5.9.0 "pillow>=10,<12")

ENV SESSION_UI_HOST=0.0.0.0 \
    SESSION_UI_PORT=8765

EXPOSE 8765
CMD ["python", "serve.py"]
