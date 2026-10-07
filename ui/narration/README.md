# Portable Book narration

This directory generates WAV audio for an authorized Book selection. It does not load Tuba, Electron, a wiki, a workspace, a note store, or a speech-synthesis browser API. The Python host in `../narration.py` verifies the selection against the mounted Book PDF before starting the isolated Node process.

The generation path preserves Tuba's Persian sentence and paragraph segmentation, DeepSeek diacritization with strict preservation of the canonical letters, corrective retry, AvalAI PCM speech adapter, and actual CTC forced alignment. The canonical Book text stays unchanged. Generation splits provider-rejected paragraphs at sentence boundaries and joins compatible PCM audio. Provider requests have a 120-second timeout each, reject redirects, classify authentication/credit/rate-limit failures, and bound the combined audio to 8 MiB. A host runs one generation at a time.

## Install

Use Node 22.13 or newer. Node 24 is supported. The host's Python module uses only the standard library.

```sh
npm ci --prefix ui/narration --omit=dev
```

The required packages are PDF.js 6.3.289 and its Node canvas implementation. The reader and the server use the same PDF text-emission algorithms and the same PDF.js version. This prevents the old per-page text index's differently ordered glyphs and footer markers from authorizing the wrong selection. The exact trusted PDF page text must equal `pageText`; UTF-16 offsets must extract exactly `text`. Book paths come from the host's Books directory, never from request JSON.

Server configuration:

| Variable | Purpose |
| --- | --- |
| `AVALAI_TTS_API_KEY` | Dedicated provider credential, preferred. |
| `AVALAI_API_KEY` | Shared credential fallback. |
| `AVALAI_API_BASE_URL` | Optional approved AvalAI origin: `https://api.avalai.ir`, `https://api.avalapis.ir`, or `https://api.avalai.org`. |
| `NARRATION_NODE_BIN` | Optional trusted Node executable; defaults to `node`. |
| `SESSION_BOOKS_DIR` | Existing Book PDF mount; the host resolves `<document>.pdf` here. |
| `NARRATION_ALIGNMENT_MODEL` | Optional absolute path to the local Persian ONNX model. |

Credentials remain in the trusted process environment. They are never sent to the browser, copied from the source repository, or included in provider error responses. A provider credential enables paid DeepSeek diacritization and TTS calls. There is no automatic speech retry after provider failure.

The default speech profile matches the extracted source: `gemini-2.5-flash-tts`, voice `Kore`, WAV output. The hidden diacritization profile is `deepseek-v4-flash`, temperature `0.1`, thinking disabled. A structurally invalid or unchanged Persian variant gets one corrective attempt. A changed Book letter stops generation.

## Actual sentence timing

Install the separate optional runtime:

```sh
npm ci --prefix ui/narration/alignment --omit=dev
```

This installs `onnxruntime-node` 1.22.0 in its own directory. Its normal postinstall fetches native ONNX runtime binaries; do not use `--ignore-scripts` for an operational installation. Mount an independently supplied `model_quantized.onnx` exported from `jonatasgrosman/wav2vec2-large-xlsr-53-persian`, with a single `input_values` input and `[1, frames, 67]` logits matching `ALIGNMENT_VOCAB` in `aligner.mjs`. Set `NARRATION_ALIGNMENT_MODEL` to that local artifact. No model is downloaded at runtime. A configured path is not proof that its model is valid: the real session load and output shape are validated during generation.

The aligner reads the actual WAV, downmixes and resamples it to 16 kHz with the source Hann-windowed sinc filter, normalizes the waveform, computes ONNX emissions, maps the speech transcript to the Persian vocabulary, and uses CTC dynamic programming to align sentence spans. Each cue is nonempty, ordered, and inside the audio duration. The model file SHA-256 is recorded in alignment identity.

If the model or native dependency is missing, real generated audio remains playable and `cues` is empty, with `alignment.status = "unavailable"`. If alignment fails on real audio, the response has empty cues and `alignment.status = "failed"`. There are no invented proportional timestamps, browser voices, or fallback highlights.

## Host boundary

The existing HTTP host applies its Account and Book authorization before calling:

```python
narration.generate_narration(document, {
    "page": 1, "start": 0, "end": 12,
    "text": canonical_selection,
    "pageText": canonical_full_page,
}, books_dir=books_path)
```

`page` is one-based; `start` and `end` are UTF-16 offsets within the canonical page, matching the reader. The selection may be part of a page or the whole page. A browser-provided URL, model path, key, executable or provider configuration is ignored. Invalid text, stale text, missing PDF, and invalid offsets are rejected before any provider call.

The response contains `audioBase64`, `mimeType`, `sha256`, `durationMs`, `profile`, `alignment`, and `cues`. Cues carry `page`, `start`, `end`, `text`, `startMs`, and `endMs`. A `NarrationError` carries a stable `code`, Farsi `message`/`messageFa`, HTTP `status`, and optional `retry_after_ms`. Raw provider diagnostics do not cross this boundary.

`narration_status()` describes installed/configured capability. It does not prove that the provider credential has credit, that upstream accepts the model, or that a mounted model passes inference.

The host's bounded in-memory cache keeps generated audio without a Tuba store. Authority must be revalidated before every cache read. Cache identity includes Book source/selection, speech profile, trusted provider configuration, and alignment configuration. Failed alignment must not poison a later configured model. Cached audio disappears when the host restarts.

## Source provenance and verification

`provider.mjs`, `diacritizer.mjs`, and `aligner.mjs` were transpiled from their corresponding pure source modules in the read-only `/home/rayesh/programming/Tuba-merge-27-29/src/narration` tree. `segmenter.mjs` retains only pure sentence/paragraph planning; source-map and catalog/workspace operations were omitted. `speech-variant.mjs` retains the strict Persian variant gate. `identity.mjs`, `errors.mjs`, and `constants.mjs` retain only the hashing, error and configuration primitives those algorithms need. `generate.mjs`, `model.mjs`, and the Python host are independent adapters for this application. `source-provenance.json` records the original source file digests.

The controlled tests use a real local HTTP server returning a one-second PCM WAV, inspect the actual speech requests, reject altered Book letters and redirects, verify UTF-16 boundaries and canonical authority, and check hand-derived CTC frame ranges using controlled emissions. The PDF authority test uses a real generated PDF. Synthetic emissions verify the alignment algorithm; they are not evidence that a live provider or the optional Persian model ran successfully.

At extraction time no AvalAI credential or alignment model was configured in this workspace. Live generation and real model inference therefore remain unverified until those server resources are supplied.
