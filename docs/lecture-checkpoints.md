# Recorded lecture word alignment

The recorded MP3 is the timing clock. The reader uses media `currentTime`, so
seeks and playback-speed changes never accumulate a separate highlight timer.
The original `sentences` stay intact as the source record. Playback uses `cues`
with acoustic `words`, exact PDF word rectangles, and separate phrase
checkpoints and speech bounds.

## Alignment

`tools/align_lecture_words.py` prepares exact word geometry from the pinned
PDF and decodes each original MP3 to mono 16 kHz PCM. The Node inference tool
uses the existing local Persian wav2vec2 model adapter. It processes 12-second
windows with two seconds of context on either side and caches emissions.

`tools/lecture-word-alignment.mjs` collapses recognized CTC characters and
matches them monotonically to Book characters, permitting deleted Book text
and inserted speech. Old sentence times limit a broad search neighbourhood by
16 seconds; they do not determine any word or phrase boundary. Complete heard
words are protected before partial character matching, so omitted Book words
cannot steal the letters of a correctly recognized neighbouring word. Supported
words are locally forced aligned inside their observed acoustic neighbourhood.
CTC character support and nearby word context reject unsupported matches.
A word missed by greedy decoding can be recovered only in a short interval
bounded by strong neighbouring words, with stronger direct CTC support: at
least 75% of its characters must reach posterior 0.35 (ordinary anchored words
require 50% at 0.1). Silent or unrelated speech cannot supply this evidence.
These are support gates, not a calibrated word-accuracy percentage.
Two-letter words missed by greedy decoding can also be recovered, but only
between two strong acoustic neighbours, with support for every letter at 0.35
and a word duration no longer than 0.6 seconds. A written conjunction such as
`وَ` or `و،` uses its normalized acoustic spelling for eligibility while
retaining the original text and PDF geometry. It still needs both neighbours.
Arabic/Persian spelling variants share their acoustic label support. A second
matching pass handles transcripts clipped by a window. The final sequence
maximizes acoustic support in Book order, rejecting contradictory observations
instead of retiming them.

In v3, missing runs are also aligned together between acoustic word anchors,
up to 12 consecutive Book words in eight seconds (six at an open sentence
edge). This recovers noisy words using the known phrase rather than demanding
that greedy transcription spell each word correctly. Each recovered word
still requires direct acoustic support: at least half its letters at posterior
0.1, or every letter at 0.03 within 1.2 seconds. Single two-letter edge words
cannot use this route. The recorded `recovery_kind` and `support_threshold`
distinguish these gates from the stronger single-word recovery described above.
These posteriors are model evidence, not calibrated accuracy.

Complete word observations in overlapping context windows are retained and
deduplicated in the final chain, including words just before a window's core.
An approximate sentence time is only a soft preference when choosing duplicate
observations and at least one agrees with that interval. It never rejects a
unique delayed word. A sufficiently supported word may stand alone across a
speaker's pause; immediate neighbour proximity is not required for it.

Words wholly inside a measured silent interval are also rejected.
Words lacking an exact PDF placement cannot borrow the old fuzzy sentence's
rectangle. Garbled text without a complete PDF word placement may therefore have no
highlight. The original sentences remain available for diagnostics.

In v4, an extraction or spelling difference in one PDF word no longer discards
all the other words in its sentence. An exact sentence match remains the first
choice. Otherwise, local matching identifies context, and only complete exact
word runs authorize PDF rectangles; changed or partial words cannot borrow a
neighbour's geometry. The PDF's visual-order `اهلل` ligature is normalized
to `الله`, including inside compounds, while retaining original glyph owners.
Short sentences such as `نه.` are allowed only at complete
PDF word boundaries, so they cannot match the suffix of `خانه`.

Rough source intervals no longer exclude readable sentences by apparent speech
speed. The known long interpolated Quran-header placeholder remains excluded.
For windows containing collapsed source intervals, alignment evaluates both the
expanded transcript and the plausible-timing subset. Both use the same acoustic
support gates, followed by one recording-wide monotonic selection. This lets
real speech in a formerly excluded sentence contribute evidence without forcing
its text into silence or displacing valid neighbouring observations solely by
changing the character-matching context. It does not interpolate word times.


Phrases split only between observed words: at a measured pause, an unsupported
word, a page break, a sentence/clause boundary, or a long gap. Continuous speech
is bounded to eight words and four seconds of speech; an individual word is
never cut even if it exceeds the duration limit. These size and punctuation
fallbacks retain observed word times and do not create silence metadata. A pause inside a word
cannot cut its text. A short pause checkpoint is its actual midpoint, and is shared only by
consecutive supported words with silence covering their gap. It cannot jump
over an unsupported word or extra speech. Speech
bounds remain the acoustic word times. Long gaps remain empty.

The visible highlight and caption use the complete current sentence from
`sentence_focus`, built from all its exactly placed PDF words. Its range has
no eight-word/four-second limit: those bounds apply only to internal acoustic
cues. Pauses and clause breaks inside a sentence do not shrink its focus.
Placeable words can appear as sentence context even without an accepted
individual audio timestamp; unplaced or broken PDF glyphs remain excluded.
Playback joins adjacent cues of the same source sentence into one continuous
display interval: the first observed speech start through the last observed
speech end. The highlight stays at the same tone throughout that interval,
including internal pauses and missing-word gaps. It clears at the sentence's
end; unrelated sentences and later repetitions are never joined across another
sentence. Word timestamps still decide page turns, and the source acoustic cues
remain untouched. Clicking sentence context seeks its first observed speech.
Legacy indexes retain their old behaviour.

The lecture player merges the sentence's exact word rectangles into one
continuous visual strip per line on the current page. Whitespace between
words receives the same highlight; the space between separate lines stays
clear. This is display geometry only: PDF word boxes, hit testing, acoustic
timestamps and page-turn decisions remain unchanged.

Sentence starts additionally use `timing.sentence_onset` when a measured pause
ends just before the first accepted word. CTC character peaks can follow the
initial sound, and rejected prefix words can otherwise delay sentence context.
The search covers 0.6 seconds plus 0.55 seconds per placeable prefix word,
capped at 2.5 seconds, and cannot cross the preceding sentence's speech end
or borrow speech from a skipped sentence. Only the end of a measured pause of
at least 0.2 seconds can supply an earlier boundary. Without that evidence,
the original start remains. This refines display onset, not individual word
timestamps; it does not introduce a global audio offset or estimated word times.

## Local model

The model is explicitly supplied, runs on CPU, and is never downloaded by the
application. Audio is processed locally. The selected export is
[XDcobra/wav2vec2-large-xlsr-53-persian-ONNX](https://huggingface.co/XDcobra/wav2vec2-large-xlsr-53-persian-ONNX),
derived from
[jonatasgrosman/wav2vec2-large-xlsr-53-persian](https://huggingface.co/jonatasgrosman/wav2vec2-large-xlsr-53-persian).
The export and base checkpoint declare Apache-2.0. The input is `input_values`
at 16 kHz and the output has 67 CTC labels matching the adapter vocabulary.

Pinned export revision: `d685d76a8db308bb3a29e8ccf93669b275668c15`.
Artifact: `onnx/model_int8.onnx`, 355,042,936 bytes.
SHA-256: `3d841795da90cb84a17f4cb8060d57eb690a61e3d4697292a04996772e8dab3b`.
Weights live under ignored `models/`, not in the Git repository. The generated
index records model and MP3 SHA-256 identities per session.

## Rebuild

Requires Node >=22.13, Python 3, Poppler (or PyMuPDF), and ffmpeg or GStreamer
with an MP3 decoder. Install the existing optional native CPU runtime:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --prefix ui/narration/alignment --omit=dev
mkdir -p models .scratch/lecture-sync
curl -fL --retry 3 \
  'https://huggingface.co/XDcobra/wav2vec2-large-xlsr-53-persian-ONNX/resolve/d685d76a8db308bb3a29e8ccf93669b275668c15/onnx/model_int8.onnx?download=true' \
  -o models/persian-wav2vec2-int8.onnx
echo '3d841795da90cb84a17f4cb8060d57eb690a61e3d4697292a04996772e8dab3b  models/persian-wav2vec2-int8.onnx' | sha256sum -c
python3 tools/align_lecture_words.py \
  --index books/tarhe-kolli.lectures.json \
  --pdf books/tarhe-kolli.pdf \
  --audio-dir books/tarhe-kolli/lectures \
  --model models/persian-wav2vec2-int8.onnx \
  --workers 2 \
  --out .scratch/lecture-sync/word-refined-all.json \
  --report .scratch/lecture-sync/word-report-all.json
```

Use `--node /absolute/path/to/node` when needed and `--sessions 1 2` for a
calibration run. One worker is the default; two need sufficient CPU and RAM
(about 1.5 GB per native process on this machine). Interrupted builds resume
from emissions, and output publication is atomic after all selected sessions
validate. An audio or model change invalidates its cache. Review the report
before replacing the committed index. Audio files are never modified.

The older `refine_lecture_checkpoints.py` remains a silence-only diagnostic.
It estimates text cuts and must not overwrite a word-aligned production index.

## Accuracy and verification

The committed build covers all 28 sessions (26.96 hours), with 100,112 accepted
word highlights and 10,903 measured silence checkpoints. This is 70.3% of the
142,479 usable transcript candidates; source text also contains garbled and
excluded fragments. Coverage is not timing accuracy. Session counts and audio
identities are recorded in [lecture-alignment-report.json](lecture-alignment-report.json).

These are real model-derived word anchors, with 20 ms acoustic frames, rather
than character-length interpolation. Frame resolution is not an accuracy
guarantee. Old noisy recordings, Quran recitation, paraphrases, omissions and
garbled PDF glyphs can remain unsupported. They deliberately have no highlight
instead of an invented word timestamp. Automated support thresholds do not
prove every match correct; representative listening is still needed for a
human accuracy assessment. No blanket zero-error claim is made.

```bash
python3 -m unittest tests.test_lecture_word_alignment tests.test_lecture_checkpoints
python3 -m pytest -q tests/test_lectures.py tests/test_mobile_share.py
node --test tests/reader/*.test.mjs
```

Tests cover short-word recovery, written conjunction variants, nonuniform word speed, omitted text, extra speech, absolute audio
offsets, exact word geometry, pause placement, unsupported gaps, page changes,
phrase focus, bounded continuous speech, and backward seeks.

The compressed emissions in `tests/fixtures/lecture-ctc/` replay the beginning
of actual session 3 without a model or MP3 decoder. They cover the operator's
reported omissions (`با توجه به چند آیه‌ای`, `به‌دست`, `اولا`, `آنهاست`,
`رسالت خود`, `رهبر`) through the same generic alignment and ordering path.
Additional tests exercise omitted words, silence, diffuse model uncertainty,
window boundaries, delayed speech and isolated words. No per-word corrections
or session-specific branches are used.


The v4 rebuild restores 1,064 previously absent sentence identities and adds
6,808 acoustic word highlights across all 28 sessions. Seven formerly represented
identities are reassigned to competing source occurrences or rejected as partial
PDF fragments; counts are coverage, not a listening-based accuracy score.
The PDF-placement fixture replays session 3 at 260.78 seconds, where one spelling
difference previously removed an otherwise recognized sentence. A second real
CTC fixture from session 4 at 174 seconds ensures expanded transcript candidates
do not erase neighbouring acoustic anchors. Synthetic checks also cover short
sentences, collapsed coarse intervals, unrelated PDF text, and omitted speech.


In v5, open-edge recovery first restricts a candidate prefix or suffix to the
acoustic anchor's source sentence. The wider search window still contains
neighbouring sentences, but their presence cannot cancel recovery of the current
sentence's words. The same support and duration gates apply; silence and omitted
words remain rejected. Across the 28-session rebuild this adds 1,581 acoustic
words. First acoustic anchors move earlier by more than 100 ms in 343 sentences
(median 840 ms); these are model-derived changes, not a human accuracy score.
Six sentence identities gain cues and six lose their former competing matches.
The real session-1 replay asserts speech at 494.60 seconds rather than waiting
until the old anchor at 497.48 seconds, and exercises the player lookup too.

Precomputed lecture rectangles now mount and paint independently of PDF text
extraction, including on a cold page. Canonical-offset narration and selection
still require the text index. A regression keeps extraction pending while the
page paints, and asserts the lecture highlight appears and clears immediately.
