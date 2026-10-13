#!/usr/bin/env python3
"""Build recorded-lecture cues from locally recognized and CTC-aligned words.

The model is supplied explicitly. Audio, PDF geometry, and emissions are
fingerprinted; interrupted inference resumes from local caches. Publishing is
atomic and only happens after every selected session passes validation.
"""
from __future__ import annotations
import argparse
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

try:
    from tools.build_lecture_index import Stream, body_words, boxes_for, locate, norm_key, open_pdf
    from tools.refine_lecture_checkpoints import audio_rms, detect_pauses
except ModuleNotFoundError:
    from build_lecture_index import Stream, body_words, boxes_for, locate, norm_key, open_pdf
    from refine_lecture_checkpoints import audio_rms, detect_pauses

ROOT = Path(__file__).resolve().parents[1]
PHRASE_SCOPE = {"max_words": 8, "max_speech_seconds": 4.0,
                "boundaries": "pause_sentence_punctuation_or_word_limit"}


def exact_fragment_spans(stream, key, lo, hi, cursor):
    """Locate context approximately, but authorize geometry only for exact runs.

    One extraction/spelling difference must not discard an entire sentence.
    Runs are subsequently checked at complete source and PDF word boundaries.
    Short sentences require a complete PDF word, never a suffix such as نه in خانه.
    """
    def boundary(at):
        return at == 0 or at == len(stream.owner) or stream.owner[at-1] != stream.owner[at]

    for search_lo in (max(lo, cursor), lo):
        at = stream.text.find(key, search_lo, hi)
        while at >= 0:
            if boundary(at) and boundary(at+len(key)):
                return [(0, at, len(key))]
            at = stream.text.find(key, at+1, hi)
    if len(key) < 5:
        return []
    hit = locate(stream.text, key, lo, hi, cursor)
    if not hit:
        return []
    start, end = max(lo, hit[0]-24), min(hi, hit[1]+24)
    blocks = SequenceMatcher(None, key, stream.text[start:end], autojunk=False).get_matching_blocks()
    if sum(b.size for b in blocks) < max(8, len(key)*.7):
        return []
    return [(b.a, start+b.b, b.size) for b in blocks if b.size]



def prepare_words(session, stream):
    """Text offsets stay in the original sentence. Geometry must match the PDF
    exactly; an old fuzzy sentence box cannot authorize a smaller word box."""
    words, word_id, cursor = [], 0, 0
    for sentence in session["sentences"]:
        text = sentence["text"]
        tokens = list(re.finditer(r"\S+", text))
        # A long, interpolated Quran block squeezed into 1 second is not a
        # usable speech transcript. Do not let its letters steal later speech.
        # Rough transcript timestamps often collapse a real Persian sentence
        # into a fraction of a second. They cannot veto acoustic alignment.
        # Retain only the known non-spoken, interpolated Quran-header exclusion.
        placeholder = ("quran" in sentence.get("flags", [])
                       and "interpolated" in sentence.get("flags", [])
                       and len(norm_key(text)) > 80
                       and sentence["end"]-sentence["start"] <= 2)
        coarse_timing_plausible = len(norm_key(text)) / max(.02, sentence["end"]-sentence["start"]) <= 18
        lo = stream.page_start.get(sentence["page"], 0)
        hi = stream.page_end.get(sentence["page_end"], len(stream.text))
        placements,broken_tokens = {},set()
        for fragment in re.finditer(r"[^▯]+", text):
            fragment_tokens=[t for t in tokens if t.start()>=fragment.start() and t.end()<=fragment.end()]
            # PDF extraction can insert spaces around missing glyphs. The
            # adjacent "words" may really be broken pieces of an Arabic word.
            # Do not turn those fragments into an apparently verified focus.
            broken=set()
            if fragment_tokens and fragment.start()>0 and not any(t.start()<fragment.start()<t.end() for t in tokens):
                broken.add(fragment_tokens[0].start())
            if fragment_tokens and fragment.end()<len(text) and not any(t.start()<fragment.end()<t.end() for t in tokens):
                broken.add(fragment_tokens[-1].start())
            broken_tokens.update(broken)
            key = norm_key(fragment.group())
            if not key:
                continue
            spans = exact_fragment_spans(stream, key, lo, hi, cursor)
            if not spans:
                continue
            for token in fragment_tokens:
                if token.start() in broken:
                    continue
                a = len(norm_key(text[fragment.start():token.start()]))
                b = a+len(norm_key(token.group()))
                for source, target, length in spans:
                    if not source <= a < b <= source+length:
                        continue
                    left, right = target+a-source, target+b-source
                    full_context = source == 0 and length == len(key) and len(key) >= 5
                    if full_context or ((left == 0 or stream.owner[left-1] != stream.owner[left])
                            and (right == len(stream.owner) or stream.owner[right-1] != stream.owner[right])):
                        placements[token.start()] = boxes_for(stream, left, right)
                        cursor = max(cursor, right)
                    break
        for i, token in enumerate(tokens):
            boxes = placements.get(token.start(), [])
            if not placeholder and token.start() not in broken_tokens and "▯" not in token.group() and norm_key(token.group()) and "out_of_order" not in sentence.get("flags", []):
                words.append({"word_id":word_id,"sentence_id":sentence["id"],"word_index":i,
                              "text":token.group(),"text_start":token.start(),"text_end":token.end(),
                              "coarse_timing_plausible":coarse_timing_plausible,
                              "coarse_start":sentence["start"],"coarse_end":sentence["end"],"boxes":boxes})
            word_id += 1
    return words


def decode_pcm(audio, target):
    if target.exists() and target.stat().st_size > 0 and target.stat().st_size % 2 == 0:
        return
    temporary = target.with_suffix(".tmp")
    if shutil.which("ffmpeg"):
        command = ["ffmpeg","-v","error","-y","-i",str(audio),"-f","s16le","-ac","1","-ar","16000",str(temporary)]
    else:
        command = ["gst-launch-1.0","-q","filesrc",f"location={audio.resolve()}","!","decodebin","!",
                   "audioconvert","!","audioresample","!","audio/x-raw,format=S16LE,channels=1,rate=16000",
                   "!","filesink",f"location={temporary.resolve()}"]
    subprocess.run(command,check=True)
    temporary.replace(target)


def pause_between(pauses, left, right):
    """Only a pause physically between observed words can divide their text."""
    candidates = [p for p in pauses if p[0] >= left-.04 and p[1] <= right+.04]
    return max(candidates,key=lambda p:p[1]-p[0],default=None)


def build_sentence_focus(prepared):
    """Full sentence context from exact PDF words; no invented audio times.

    Unrecognized but placeable words belong to the visual sentence context.
    Broken/unplaced PDF glyphs cannot borrow another word's rectangle.
    """
    groups = {}
    for word in prepared:
        if word["boxes"]:
            groups.setdefault(word["sentence_id"], []).append(word)
    result = []
    for sentence_id, words in groups.items():
        words.sort(key=lambda w: w["text_start"])
        boxes = []
        for word in words:
            for box in word["boxes"]:
                if box not in boxes:
                    boxes.append(box)
        result.append({"id":sentence_id, "text":" ".join(w["text"] for w in words),
                       "boxes":boxes, "page":boxes[0][0], "page_end":boxes[-1][0]})
    return result


def add_sentence_onsets(cues, prepared, pauses):
    """Start sentence context at the preceding measured speech onset.

    CTC letter peaks can lag the initial sound, and a rejected prefix must not
    delay a whole sentence's visual focus. Only a nearby measured pause end
    can move the display boundary; accepted word times remain unchanged.
    """
    placed = {}
    for word in prepared:
        if word["boxes"]:
            placed.setdefault(word["sentence_id"], []).append(word)
    pause_ends = [p[1] for p in pauses]
    previous = None
    for cue in cues:
        cue["timing"].pop("sentence_onset", None)
        if previous and previous["sentence_id"] == cue["sentence_id"]:
            previous = cue
            continue
        words = placed.get(cue["sentence_id"], [])
        first = cue["words"][0]
        position = next((i for i,w in enumerate(words)
                         if w["text"] == first["text"] and w["boxes"] == first["boxes"]), None)
        anchor = cue["speech_start"]
        # Never borrow speech from a skipped sentence or an earlier speaker
        # turn. The prefix only widens a bounded search; it invents no times.
        adjacent = previous is None or cue["sentence_id"] == previous["sentence_id"]+1
        if position is not None and adjacent:
            lookback = min(2.5, .6 + .55*position)
            lo = max(anchor-lookback, previous["speech_end"] if previous else 0)
            i = bisect_right(pause_ends, anchor)-1
            if i >= 0:
                pause = pauses[i]
                start = pause[1]
                if lo <= start < anchor-.02 and pause[1]-pause[0] >= .2-1e-6:
                    cue["timing"]["sentence_onset"] = {
                        "start":round(start,3), "anchor_start":anchor,
                        "pause":pause, "prefix_words":position,
                        "method":"measured_pause_end"}
        previous = cue


def build_cues(session, alignment, pauses):
    words = [w for w in alignment["words"] if w["boxes"]
             and not any(a<=w["start"] and w["end"]<=b for a,b in pauses)]
    groups = []
    for word in words:
        previous = groups[-1][-1] if groups else None
        split = previous is None or word["word_id"] != previous["word_id"]+1 or word["sentence_id"] != previous["sentence_id"]
        if previous is not None:
            split = split or bool(pause_between(pauses,previous["end"],word["start"]))
            split = split or previous["boxes"][-1][0] != word["boxes"][0][0]
            split = split or word["start"]-previous["end"] > .8
            # Natural phrase endings take precedence over the size fallback.
            # A size/punctuation cut is a word boundary, never a fake silence.
            split = split or bool(re.search(r'[.!?؟؛،][»”"\)\]]*$', previous["text"]))
            split = split or len(groups[-1]) >= PHRASE_SCOPE["max_words"]
            split = split or word["end"]-groups[-1][0]["start"] > PHRASE_SCOPE["max_speech_seconds"]
        if split:
            groups.append([])
        groups[-1].append(word)
    sentences = {s["id"]:s for s in session["sentences"]}
    cues = []
    for group in groups:
        first,last=group[0],group[-1]
        sentence=sentences[first["sentence_id"]]
        # Exact word boxes are intentionally retained rather than a rectangle
        # spanning omitted words or neighbouring lines.
        boxes=[]
        for word in group:
            for box in word["boxes"]:
                if box not in boxes:
                    boxes.append(box)
        cues.append({"id":len(cues),"sentence_id":first["sentence_id"],
                     "text":sentence["text"][first["text_start"]:last["text_end"]],
                     "start":round(first["start"],3),"end":round(last["end"],3),
                     "speech_start":round(first["start"],3),"speech_end":round(last["end"],3),
                     "page":boxes[0][0],"page_end":boxes[-1][0],"boxes":boxes,
                     "page_timing":"word_alignment", "confidence":round(min(w["coverage"] for w in group),3),
                     "flags":[],"timing":{"text_boundary":"ctc_word_alignment","requires_word_alignment":False,
                     "start_pause":None,"end_pause":None},
                     "words":[{"text":w["text"],"start":round(w["start"],3),"end":round(w["end"],3),
                               "coverage":round(w["coverage"],3),"support":round(w["support"],3),
                               "context_recovery":w.get("context_recovery",False),
                               "recovery_kind":w.get("recovery_kind","single_word"),
                               "support_threshold":w.get("support_threshold",.35 if w.get("context_recovery") else .1),
                               "boxes":w["boxes"]} for w in group]})
    for i,(left,right) in enumerate(zip(cues,cues[1:])):
        pause=pause_between(pauses,left["speech_end"],right["speech_start"])
        # Long commentary gaps remain empty. A short silence checkpoint changes
        # the held phrase at its midpoint, with speech bounds from the model.
        consecutive=groups[i][-1]["word_id"]+1==groups[i+1][0]["word_id"]
        quiet_gap=pause and pause[0]-left["speech_end"]<=.3 and right["speech_start"]-pause[1]<=.3
        if consecutive and quiet_gap and right["speech_start"]-left["speech_end"]<=2.5:
            center=round((pause[0]+pause[1])/2,3)
            left["end"]=center;right["start"]=center
            left["timing"]["end_pause"]=pause;right["timing"]["start_pause"]=pause
    validate_cues(cues,alignment["duration"])
    return cues


def validate_cues(cues,duration):
    previous=0
    for cue in cues:
        if not 0<=previous<=cue["start"]<=cue["speech_start"]<cue["speech_end"]<=cue["end"]<=duration:
            raise ValueError(f"Invalid acoustic cue {cue['id']}")
        for word in cue["words"]:
            if not cue["speech_start"]<=word["start"]<word["end"]<=cue["speech_end"]:
                raise ValueError("Word outside its acoustic cue")
        previous=cue["end"]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("index","pdf","audio-dir","model","out","report"):
        parser.add_argument(f"--{name}",type=Path,required=True)
    parser.add_argument("--node",default="node")
    parser.add_argument("--cache",type=Path,default=Path(".scratch/lecture-sync/words"))
    parser.add_argument("--sessions",type=int,nargs="+")
    parser.add_argument("--workers",type=int,default=1,choices=(1,2))
    args=parser.parse_args()
    index=json.loads(args.index.read_text())
    available={s["session"] for s in index["sessions"]}
    if args.sessions and set(args.sessions)-available:
        parser.error(f"Unknown lecture sessions: {sorted(set(args.sessions)-available)}")
    pdf_sha=hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    if pdf_sha!=index["source"]["boxes_pdf_sha256"]:
        parser.error("PDF edition does not match lecture geometry")
    args.model.resolve(strict=True)
    args.cache.mkdir(parents=True,exist_ok=True)
    doc=open_pdf(args.pdf)
    jobs=[]
    for session in index["sessions"]:
        if args.sessions and session["session"] not in args.sessions:
            continue
        pages=range(min(s["page"] for s in session["sentences"]),max(s["page_end"] for s in session["sentences"])+1)
        if hasattr(doc,"load_range"):
            doc.load_range(pages.start,pages.stop-1)
        stream=Stream({p:body_words(doc[p-1]) for p in pages})
        audio=args.audio_dir/session["audio"]
        digest=hashlib.sha256(audio.read_bytes()).hexdigest()
        pcm=args.cache/f"{digest}.pcm"
        decode_pcm(audio,pcm)
        manifest=args.cache/f"session-{session['session']:02}.manifest.json"
        output=args.cache/f"session-{session['session']:02}.words.json"
        data={"session":session["session"],"audio_sha256":digest,"pcm":str(pcm.resolve()),"words":prepare_words(session,stream)}
        manifest.write_text(json.dumps(data,ensure_ascii=False,separators=(",",":")))
        jobs.append((session,audio,manifest,output,digest))
    def run(job):
        session,audio,manifest,output,digest=job
        subprocess.run([args.node,str(ROOT/"tools/align_lecture_words.mjs"),str(manifest.resolve()),str(args.model.resolve()),str(output.resolve()),str((args.cache/"emissions").resolve())],check=True,cwd=ROOT)
        alignment=json.loads(output.read_text())
        if alignment["audio_sha256"]!=digest:
            raise ValueError("Audio identity changed during alignment")
        pauses=detect_pauses(audio_rms(audio,args.cache/"rms"))
        prepared=json.loads(manifest.read_text())["words"]
        cues=build_cues(session,alignment,pauses)
        add_sentence_onsets(cues,prepared,pauses)
        return session,cues,{"session":session["session"],"cues":len(cues),"supported_words":sum(len(c["words"]) for c in cues),
                            "candidate_words":len(prepared),
                            "source_words":sum(len(re.findall(r"\S+",s["text"])) for s in session["sentences"]),
                            "exact_pdf_words":sum(bool(w["boxes"]) for w in prepared),
                            "quiet_checkpoints":sum(bool(c["timing"]["start_pause"]) for c in cues),
                            "bounded_phrase_words":sum(w["recovery_kind"]=="bounded_phrase" for c in cues for w in c["words"]),
                            "low_posterior_words":sum(w["support_threshold"]==.03 for c in cues for w in c["words"]),
                            "version":alignment["version"],"model":alignment["model"],
                            "audio_sha256":digest,"rejected_order":alignment["rejected_order"]}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results=list(pool.map(run,jobs))
    for session,cues,report in results:
        session["cues"]=cues
        prepared=json.loads((args.cache/f"session-{session['session']:02}.manifest.json").read_text())["words"]
        session["sentence_focus"]=build_sentence_focus(prepared)
        session["word_alignment"]={"method":"local_ctc","version":report["version"],"model":report["model"],"audio_sha256":report["audio_sha256"],"supported_words":report["supported_words"]}
    index["source"]["word_alignment"]={"method":"recognized_characters_and_local_ctc","sessions":[s["session"] for s,_,_ in results],
                                       "text_boundaries":"acoustic_words","unknown_text":"no_highlight","frame_resolution_ms":20}
    index["source"]["word_alignment"]["text_preparation"] = "exact_word_runs_in_matched_context_v2"
    index["source"]["word_alignment"]["phrase_scope"]=PHRASE_SCOPE
    index["source"]["word_alignment"]["display_scope"]="sentence"
    index["source"]["word_alignment"]["sentence_onsets"]={
        "method":"measured_pause_end", "minimum_pause_seconds":.2,
        "base_lookback_seconds":.6, "prefix_lookback_per_word_seconds":.55,
        "max_lookback_seconds":2.5, "word_times":"unchanged"}
    # The old silence-only build describes the superseded cue timing.
    if len(results)==len(index["sessions"]):
        index["source"].pop("checkpoint_refinement",None)
    temporary=args.out.with_suffix(args.out.suffix+".tmp")
    temporary.write_text(json.dumps(index,ensure_ascii=False,separators=(",",":")))
    temporary.replace(args.out)
    args.report.write_text(json.dumps([r for _,_,r in results],ensure_ascii=False,indent=2))


if __name__=="__main__":
    main()
