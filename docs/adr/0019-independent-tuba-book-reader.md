# ADR 0019 — Independent Tuba Book reader

Date: 2026-10-06
Status: accepted
Amends: ADR-0007/0017's visual-pipeline constraints for the designed mobile reader

## Context

The operator requested extracting the stable Tuba reader's PDF display,
corrected text selection, audio playback, and focus, then separately its audio
generation. Tuba's wiki, workspace, notebook, and selection-action menus must
not become dependencies of chat-with-books.

Both readers already use PDF.js 6.3.289. Tuba renders embedded glyph outlines
with `disableFontFace: true` and `useSystemFonts: false`, avoiding the browser
font reshaping that led to the former raster-only decision.

## Decision

The PDF surface is a framework-free module in `ui/book-reader/`, using the
existing PDF runtime. It owns rendering, canonical text indexes, selection,
and transient audio focus. Its intended host is the mobile UI designed in
`docs/design/mobile-preview`, implemented in `ui/mobile`. The host owns shared
PDF loading, navigation, zoom, account entry, and selection context. The
conversation and note components keep their existing design and boundaries.
The legacy `ui/index.html` reader and its raster pipeline are unchanged.

The mobile reading surface displays the original PDF's glyph outlines in place
of the design's former typed sample text. Canvas and selectable-text preparation
run independently, and page removal cancels both tasks. Hosts that provide an
initial cached raster can retain it until successful canvas painting.

Selection uses Tuba's shared text emission rules and exact item offsets. The
host receives the selected text and page-local UTF-16 offsets; it continues to
provide its own notebook and citation behavior. The Tuba action menu and
notebook stores are not imported. Conversation, recording, and response samples
in the design remain samples; adding the PDF engine does not turn them into
provider-backed chat or speech-recording features.

Audio playback accepts bytes and validated sentence timings from a separate
server generation module. Focus follows media time, clears during silence,
and draws only when the canonical text and DOM still agree. Audio generation
holds provider credentials on the server and does not depend on Tuba's desktop
runtime or workspace persistence.

The generation server extracts the authorized page directly from the mounted
PDF with the same PDF.js version and shared canonical index builder. It
requires exact page text and UTF-16 selection agreement before provider calls;
the existing normalized citation index does not authorize narration offsets.

## Consequences

The reader can be reused without the Tuba application or a frontend build
system. The host's citation stream remains a separate representation from the
reader's canonical selection offsets; offsets must not be interchanged.
The designed mobile reader uses PDF glyphs as its final pixel source; the
legacy reader keeps its existing raster cache and fallback. Real provider/model setup
is required for audio generation; playback does not fabricate sentence timings.
