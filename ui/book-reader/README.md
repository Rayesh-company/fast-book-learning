# Independent Book reader

Extracted from the stable reader in `Tuba-merge-27-29` at the user's request.
The source checkout is read-only. These ES modules run directly in the existing
chat-with-books page, using its vendored PDF.js 6.3.289. No React, Electron,
workspace, wiki, or Tuba notebook dependency is needed.

The intended mobile host is [`../mobile`](../mobile/README.md), preserving the
previously designed UI. The legacy `ui/index.html` reader is unchanged.

Import `index.mjs` and include `reader.css`. The host owns the PDF document,
page scheduler, book identity, citation lookup, notes, and selection actions.
Use `PDF_RENDER_OPTIONS` when loading a document to draw embedded glyph outlines
without browser FontFace reshaping. Keep the worker version equal to PDF.js.

```js
const reader = createBookReader({ pdfjs, onSelection });
const mounted = reader.mountPage({
  page: pdfPage, surface: pageElement, width: 640, pixelRatio: devicePixelRatio,
  isCurrent: () => currentBook === bookId,
});
const { content, index } = await mounted.ready;
await mounted.painted;
const selection = reader.captureSelection();
// { text, pages: [{ page, start, end, text }] }
```

`ready` and `painted` are independent: background canvas throttling cannot
hold up selection. An existing `.reader-img` is retained until successful
canvas painting. The host receives paint errors through `onPaintError`.
Call `removePage(pageNumber)` on eviction or zoom, and `clear()` on book
switch/disposal. It cancels page work, disconnects observers, and detaches audio.

Selection offsets are UTF-16 offsets in `getPageIndex(page).text`, not in the
server's independently normalized citation stream. Spans carry item identities,
are reordered using Tuba's emission rules, and retain exact partial-word
boundaries. Altered DOM text fails closed. Mouse/pen selection snaps whitespace
to the closest text run; touch retains native selection handles. Actions after
selection belong to the host, which keeps its own note schema and chat flow.

Audio is supplied by the separate generation boundary:

```js
const player = reader.loadAudio({
  bytes, mimeType: 'audio/wav',
  cues: [{ page: 3, start: 20, end: 25, text: 'سلام.', startMs: 100, endMs: 900 }],
  onState: state => updateControls(state),
});
await player.play();
player.pause();
await player.seek(0.5);
player.setRate(1.25);
player.dispose();
```

Focus follows the audio element's current time, including seek events. Silent
gaps clear focus. Timing ranges cannot overlap; text must exactly equal its
canonical page slice before geometry is drawn. There is no guessed highlight
for an unavailable page. Audio URLs and listeners are released on disposal.

## Source provenance

The following algorithms were copied from the indicated Tuba files with types
erased, retaining their logic:

| Local file | Tuba source |
| --- | --- |
| `pdf-text.mjs` | `src/pdf-text.ts` |
| `pdf-text-index.mjs` | `src/studio/pdf-text-index.ts` |
| `pdf-pointer-selection.mjs` | `src/studio/pdf-pointer-selection.ts` |
| `pdf-playback-focus.mjs` | `src/studio/pdf-playback-focus.ts` |
| `html-audio-playback.mjs` | `src/studio/html-audio-playback.ts` |

`index.mjs` adapts only the PDF effects and span stamping of
`src/studio/authoritative-studio.tsx` to a framework-free lifecycle.
`selection.mjs` adds page clamping for the host's multi-page capture and keeps
the mouse anchor when dragging into another mounted page. One edge
correction in the index/focus helpers measures DOM offsets through `rawStart`
and validates the original item text, preserving geometry when page-edge
whitespace is trimmed. `playback.mjs` uses the half-open timing rule from
`src/narration/aligner.ts` without importing the Tuba runtime.

`pdf-content.mjs` builds the same canonical index for the browser and the
audio-generation server. Separators are computed after Tuba's control-mark
and glyph emission, so both boundaries agree exactly on spacing and offsets.

Run regression checks from the repository root:

```sh
npm ci --prefix tests/reader
npm test --prefix tests/reader
python -m pytest -q tests/test_book_reader.py tests/test_session_ui.py
```

The browser reader needs no npm install or compilation. The separate server
generation module requires its own Node dependencies; see
[`../narration/README.md`](../narration/README.md). No credentials, book files,
or generated audio are vendored.

Verification includes the renderer/media and designed-host DOM regressions.
Four pages from an existing 862-page Persian PDF rendered with the actual
vendored engine; their canonical browser text matched the server extraction
exactly. An authenticated local browser preview confirmed the original PDF
inside the designed mobile frames and a partial mouse selection on the real
book. Full browser pointer coverage and live provider/model verification
remain pending; narration verification is described in its README.
