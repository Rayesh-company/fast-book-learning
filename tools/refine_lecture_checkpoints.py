#!/usr/bin/env python3
"""Refine existing lecture anchors against pauses in the shipped audio.

This is acoustic boundary refinement, not speech recognition. Original
sentences stay intact; sessions gain smaller playback `cues`. Text boundaries
inside a sentence are estimated from its existing anchors and marked as such.
Garbled/interpolated/rough sentences are never subdivided. Only an exact match
to the PDF can supply new phrase boxes. No boundary is invented when no real
pause is found. The report records unresolved anchors for a word aligner.
"""
from __future__ import annotations

import argparse
from array import array
from bisect import bisect_left, bisect_right
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile

try:
    from tools.build_lecture_index import Stream, body_words, boxes_for, locate, norm_key, open_pdf
except ModuleNotFoundError:
    from build_lecture_index import Stream, body_words, boxes_for, locate, norm_key, open_pdf

HZ = 50
SAMPLE_RATE = 16_000
UNRELIABLE = {"interpolated", "rough_timing", "garbled_pdf_text", "out_of_order", "low_confidence"}


def audio_rms(path: Path, cache: Path) -> list[float]:
    """20 ms RMS frames decoded from the actual delivered MP3, no rescaling.

    ffmpeg is preferred; GStreamer is a local fallback. The cache fingerprints
    the audio bytes so stale analysis cannot be used for replacement audio.
    """
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{path.stem}-{digest[:20]}-16k-50hz.rms"
    if target.is_file():
        data = target.read_bytes()
        if len(data) % 4:
            raise ValueError(f"truncated RMS cache: {target}")
        return list(struct.unpack(f"<{len(data) // 4}f", data))
    ffmpeg = shutil.which("ffmpeg")
    gst = shutil.which("gst-launch-1.0")
    if ffmpeg:
        command = [ffmpeg, "-v", "error", "-i", str(path), "-f", "s16le",
                   "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"]
    elif gst:
        command = [gst, "-q", "filesrc", f"location={path.resolve()}", "!", "decodebin",
                   "!", "audioconvert", "!", "audioresample", "!",
                   f"audio/x-raw,format=S16LE,channels=1,rate={SAMPLE_RATE}",
                   "!", "fdsink", "fd=1"]
    else:
        raise RuntimeError("Install ffmpeg or GStreamer with an MP3 decoder to analyze audio")
    try:
        import audioop  # Python <=3.12: fast stdlib RMS, no runtime dependency
    except ImportError:
        audioop = None
    frames = []
    frame_bytes = SAMPLE_RATE // HZ * 2
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        try:
            while data := process.stdout.read(frame_bytes):
                if len(data) % 2:
                    raise ValueError("decoder produced a partial PCM sample")
                if audioop is not None:
                    value = audioop.rms(data, 2) / 32768
                else:
                    samples = array("h", data)
                    if sys.byteorder != "little":
                        samples.byteswap()
                    value = math.sqrt(sum(s * s for s in samples) / len(samples)) / 32768
                frames.append(value)
            if process.wait() != 0:
                errors.seek(0)
                raise RuntimeError(errors.read(4096).decode(errors="replace"))
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
                process.wait()
    if not frames:
        raise ValueError(f"no decoded audio: {path}")
    target.write_bytes(struct.pack(f"<{len(frames)}f", *frames))
    return frames


def detect_pauses(rms: list[float], min_pause: float = 0.20) -> list[tuple[float, float]]:
    """Sustained low energy, relative to a local 10 s speech level.

    A quiet phoneme is not a checkpoint: runs must last min_pause. Thresholds
    vary gradually across blocks so recording-level changes don't cause cuts.
    """
    if not rms or any(not math.isfinite(v) or v < 0 for v in rms):
        raise ValueError("RMS frames must be finite and nonnegative")
    width = 10 * HZ
    levels = []
    for start in range(0, len(rms), width):
        block = sorted(rms[max(0, start - width // 2):start + width + width // 2])
        speech = block[min(len(block) - 1, int(len(block) * 0.80))]
        levels.append(max(1e-6, speech * 0.16))
    pauses, start = [], None
    for i, value in enumerate(rms):
        position = i / width
        block = int(position)
        fraction = position - block
        threshold = levels[block] * (1 - fraction) + levels[min(block + 1, len(levels) - 1)] * fraction
        if value <= threshold:
            if start is None:
                start = i
        elif start is not None:
            if (i - start) / HZ >= min_pause:
                pauses.append((start / HZ, i / HZ))
            start = None
    if start is not None and (len(rms) - start) / HZ >= min_pause:
        pauses.append((start / HZ, len(rms) / HZ))
    return pauses


class PauseIndex:
    def __init__(self, pauses):
        self.pauses = pauses
        self.centers = [(a + b) / 2 for a, b in pauses]

    def nearest(self, time, lo, hi, radius=1.0, center_lo=-math.inf, center_hi=math.inf):
        first = bisect_left(self.centers, max(lo, time - radius, center_lo))
        last = bisect_right(self.centers, min(hi, time + radius, center_hi))
        # Long off-book gaps cannot stand in for a phrase breath.
        candidates = [p for p in self.pauses[first:last] if p[1] - p[0] <= 2.5 and p[0] >= lo and p[1] <= hi]
        return min(candidates, key=lambda p: abs((p[0] + p[1]) / 2 - time), default=None)


def checkpoint(pause):
    return round((pause[0] + pause[1]) / 2, 3)


def sentence_anchors(sentences, pauses, radius=1.0):
    """Constrain each adjustment by its neighbours, never accumulating drift."""
    starts = [{"checkpoint": s["start"], "speech": s["start"], "pause": None} for s in sentences]
    ends = [{"checkpoint": s["end"], "speech": s["end"], "pause": None} for s in sentences]
    for i, sentence in enumerate(sentences):
        # Separate boundaries around commentary; do not divide a long gap in half.
        prev = sentences[i - 1] if i else None
        next_ = sentences[i + 1] if i + 1 < len(sentences) else None
        if prev is None or sentence["start"] - prev["end"] > 2.5:
            lo = max(0, prev["end"] if prev else 0)
            hi = sentence["end"] - 0.4
            pause = pauses.nearest(sentence["start"], lo, hi, radius)
            if pause:
                starts[i] = {"checkpoint": checkpoint(pause), "speech": pause[1], "pause": pause}
        if next_ is None or next_["start"] - sentence["end"] > 2.5:
            lo = starts[i]["speech"] + 0.4
            hi = next_["start"] if next_ else sentence["end"] + radius + 1.25
            pause = pauses.nearest(sentence["end"], lo, hi, radius)
            if pause:
                ends[i] = {"checkpoint": checkpoint(pause), "speech": pause[0], "pause": pause}
        elif next_ is not None:
            estimate = (sentence["end"] + next_["start"]) / 2
            # Do not move through either sentence's original anchor centre.
            lo = max(starts[i]["speech"] + 0.4, (sentence["start"] + sentence["end"]) / 2)
            hi = min(next_["end"] - 0.4, (next_["start"] + next_["end"]) / 2)
            pause = pauses.nearest(estimate, lo, hi, radius,
                                  center_lo=max(sentence["end"], next_["start"]) - radius,
                                  center_hi=min(sentence["end"], next_["start"]) + radius)
            if pause:
                ends[i] = {"checkpoint": checkpoint(pause), "speech": pause[0], "pause": pause}
                starts[i + 1] = {"checkpoint": checkpoint(pause), "speech": pause[1], "pause": pause}
    return starts, ends


def phrase_cuts(text, start, end, pauses, target_words=6):
    """Estimate word cuts only where a corresponding acoustic pause exists.

    Punctuation is preferred; arbitrary equal-duration slices are never emitted.
    The existing anchor constrains a proposed cut within 750 ms. These text
    cuts remain estimates until replaced by recognizer/forced-aligner words.
    """
    import re
    tokens = list(re.finditer(r"\S+", text))
    if len(tokens) < 6 or end - start < 3:
        return []
    weights = [max(1, len(norm_key(m.group()))) for m in tokens]
    total = sum(weights)
    prefix, candidates = 0, []
    for i, token in enumerate(tokens[:-1], 1):
        prefix += weights[i - 1]
        if i < 3 or len(tokens) - i < 3:
            continue
        estimate = start + (end - start) * prefix / total
        pause = pauses.nearest(estimate, start + 0.5, end - 0.5, radius=0.75)
        if pause:
            punctuation = token.group().endswith(("،", "؛", ":", ".", "؟", "!"))
            candidates.append((i, tokens[i].start(), pause, punctuation, abs(checkpoint(pause) - estimate)))
    cuts, word_start, time_start = [], 0, start
    while candidates:
        eligible = [c for c in candidates if c[0] - word_start >= 3 and c[2][0] - time_start >= 0.6]
        if not eligible or len(tokens) - word_start <= target_words:
            break
        # Nearby punctuation makes a stronger text anchor than an arbitrary cut.
        chosen = min(eligible, key=lambda c: abs(c[0] - word_start - target_words) + c[4] - (1.5 if c[3] else 0))
        cuts.append((chosen[1], chosen[2]))
        word_start, time_start = chosen[0], chosen[2][1]
        candidates = [c for c in candidates if c[0] > word_start and c[2][0] > time_start]
    return cuts


def refine_session(session, pauses, stream, max_shift=1.0, target_words=6):
    ordered = sorted(session["sentences"], key=lambda s: (s["start"], s["id"]))
    starts, ends = sentence_anchors(ordered, pauses, max_shift)
    cues, unresolved, shifts, cursor = [], [], [], 0
    for i, sentence in enumerate(ordered):
        first, last = starts[i], ends[i]
        # Very short/bad old anchors cannot be repaired safely by silence alone.
        if last["speech"] <= first["speech"]:
            first = {"checkpoint": sentence["start"], "speech": sentence["start"], "pause": None}
            last = {"checkpoint": sentence["end"], "speech": sentence["end"], "pause": None}
        text = sentence["text"]
        lo = stream.page_start.get(sentence["page"], 0)
        hi = stream.page_end.get(sentence["page_end"], len(stream.text))
        hit = locate(stream.text, norm_key(text), lo, hi, cursor)
        if hit:
            cursor = max(cursor, hit[1])
        reliable = not (UNRELIABLE & set(sentence.get("flags", [])))
        cuts = phrase_cuts(text, first["speech"], last["speech"], pauses, target_words) if reliable and hit and hit[2] == "exact" else []
        positions = [0] + [pos for pos, _ in cuts] + [len(text)]
        boundaries = [first] + [{"checkpoint": checkpoint(p), "speech_start": p[1], "speech_end": p[0], "pause": p} for _, p in cuts] + [last]
        for j, (a, b) in enumerate(zip(positions, positions[1:])):
            begin, finish = boundaries[j], boundaries[j + 1]
            boxes = sentence.get("boxes", [])
            if cuts:
                offset = hit[0] + len(norm_key(text[:a]))
                boxes = boxes_for(stream, offset, offset + len(norm_key(text[a:b])))
            pages = list(dict.fromkeys(box[0] for box in boxes))
            cue = {
                "id": len(cues), "sentence_id": sentence["id"], "text": text[a:b].strip(),
                "start": round(begin["checkpoint"], 3), "end": round(finish["checkpoint"], 3),
                "speech_start": round(begin.get("speech_start", begin.get("speech")), 3),
                "speech_end": round(finish.get("speech_end", finish.get("speech")), 3),
                "page": pages[0] if pages else sentence["page"],
                "page_end": pages[-1] if pages else sentence["page_end"],
                "boxes": boxes, "confidence": sentence.get("confidence"),
                "flags": sentence.get("flags", []),
                "timing": {"start_pause": begin["pause"], "end_pause": finish["pause"],
                           "text_boundary": "estimated" if cuts else "original",
                           "requires_word_alignment": not reliable or bool(cuts)},
            }
            # A silence checkpoint does not identify a word at a page break.
            # Retain the legacy page estimate for unsplittable cross-page cues;
            # claim checkpoint page timing only for single-page phrases.
            cue["page_timing"] = "checkpoint" if len(pages) <= 1 else "legacy_estimate"
            if len(pages) > 1:
                cue["timing"]["requires_word_alignment"] = True
            cues.append(cue)
        for original, anchor in ((sentence["start"], first), (sentence["end"], last)):
            if anchor["pause"]:
                shifts.append(round(anchor["checkpoint"] - original, 3))
        if not reliable or not first["pause"] or not last["pause"]:
            unresolved.append({"sentence": sentence["id"], "start": sentence["start"],
                               "flags": sentence.get("flags", []),
                               "start_anchored": bool(first["pause"]), "end_anchored": bool(last["pause"])})
    # Never truncate a cue to conceal a crossed anchor; fail the offline build.
    for a, b in zip(cues, cues[1:]):
        if a["end"] > b["start"] + 1e-6:
            raise ValueError(f"crossed checkpoint in session {session['session']}: {a['id']}")
    for cue in cues:
        if not cue["start"] <= cue["speech_start"] <= cue["speech_end"] <= cue["end"]:
            raise ValueError(f"invalid speech bounds in session {session['session']}: {cue['id']}")
    return cues, {"session": session["session"], "sentences": len(ordered), "cues": len(cues),
                  "pauses": len(pauses.pauses), "anchored_boundaries": len(shifts),
                  "max_shift_s": max(map(abs, shifts), default=0), "unresolved": unresolved}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--audio-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path(".scratch/lecture-sync/rms"))
    parser.add_argument("--sessions", type=int, nargs="+")
    parser.add_argument("--max-shift", type=float, default=1.0)
    parser.add_argument("--target-words", type=int, default=6)
    args = parser.parse_args(argv)
    if not 0 < args.max_shift <= 2 or args.target_words < 3:
        parser.error("max-shift must be in (0, 2]; target-words must be >=3")
    index = json.loads(args.index.read_text(encoding="utf-8"))
    if any(s.get("word_alignment") for s in index["sessions"] if not args.sessions or s["session"] in args.sessions):
        parser.error("Word-aligned sessions cannot be replaced with estimated cuts; use align_lecture_words.py")
    pdf_sha = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    if pdf_sha != index.get("source", {}).get("boxes_pdf_sha256"):
        parser.error("PDF edition does not match the existing lecture boxes")
    doc = open_pdf(args.pdf)
    reports = []
    for session in index["sessions"]:
        if args.sessions and session["session"] not in args.sessions:
            continue
        pages = range(min(s["page"] for s in session["sentences"]), max(s["page_end"] for s in session["sentences"]) + 1)
        if hasattr(doc, "load_range"):
            doc.load_range(pages.start, pages.stop - 1)
        stream = Stream({page: body_words(doc[page - 1]) for page in pages})
        audio = args.audio_dir / session["audio"]
        rms = audio_rms(audio, args.cache)
        pauses = PauseIndex(detect_pauses(rms))
        cues, report = refine_session(session, pauses, stream, args.max_shift, args.target_words)
        session["cues"] = cues
        reports.append(report)
        print(f"session {session['session']}: {len(session['sentences'])} sentences -> {len(cues)} cues; {report['anchored_boundaries']} pause anchors", flush=True)
    index["source"]["checkpoint_refinement"] = {
        "method": "local_audio_silence", "rms_hz": HZ, "min_pause_s": 0.2,
        "max_shift_s": args.max_shift, "target_words": args.target_words,
        "text_boundaries": "estimated_from_existing_alignment_not_word_recognition",
    }
    # All sessions must pass before publishing either output.
    args.out.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    args.report.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
