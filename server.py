#!/usr/bin/env python3
"""
FastAPI Speech Noise Reduction Microservice
Using ModelScope FRCRN (speech_frcrn_ans_cirm_16k)
"""

import io
import os
import time
import tempfile
from pathlib import Path
from typing import Optional

import torch
import soundfile as sf
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import Response, JSONResponse
import uvicorn

from modelscope.pipelines import pipeline
from modelscope.utils.constant import Tasks
from denoise import load_and_standardize_audio

app = FastAPI(
    title="Speech FRCRN Noise Reduction API",
    description="High-performance speech noise suppression service powered by ModelScope FRCRN (16kHz)",
    version="1.0.0"
)

# Global model holder
model_holder = {"denoiser": None, "device": None, "model_path": None}


def load_model():
    candidates = [
        "/workspace/model",
        "/mnt/workspace/.cache/modelscope/hub/models/damo--speech_frcrn_ans_cirm_16k/snapshots/master",
        "damo/speech_frcrn_ans_cirm_16k"
    ]
    target_path = "damo/speech_frcrn_ans_cirm_16k"
    for c in candidates:
        if os.path.exists(c) and os.path.exists(os.path.join(c, "pytorch_model.bin")):
            target_path = c
            break

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"[*] Pre-loading FRCRN pipeline from: {target_path} on {device}...")
    t0 = time.time()
    ans = pipeline(Tasks.acoustic_noise_suppression, model=target_path, device=device)
    ans.model.to(device)
    print(f"[✓] FRCRN model loaded in {time.time() - t0:.2f}s (Weights on: {next(ans.model.parameters()).device})")
    model_holder["denoiser"] = ans
    model_holder["device"] = device
    model_holder["model_path"] = target_path


@app.on_event("startup")
def startup_event():
    load_model()


@app.get("/")
def root():
    return {
        "service": "Speech FRCRN Noise Reduction",
        "status": "ready" if model_holder["denoiser"] else "loading",
        "device": model_holder.get("device"),
        "endpoints": {
            "health": "/health",
            "denoise": "POST /denoise",
            "docs": "/docs"
        }
    }


@app.get("/health")
def health():
    gpu_info = {}
    if torch.cuda.is_available():
        gpu_info = {
            "gpu_name": torch.cuda.get_device_name(0),
            "allocated_mb": round(torch.cuda.memory_allocated(0) / (1024 * 1024), 2),
            "reserved_mb": round(torch.cuda.memory_reserved(0) / (1024 * 1024), 2),
        }
    return {
        "status": "ok",
        "model": "speech_frcrn_ans_cirm_16k",
        "model_path": model_holder["model_path"],
        "device": model_holder["device"],
        "gpu": gpu_info
    }


@app.post("/denoise")
async def denoise_audio(
    file: UploadFile = File(..., description="Audio file (.wav, .mp3, .flac, etc.)"),
    return_json: bool = Query(False, description="Return processing stats instead of raw audio stream")
):
    """
    Accepts noisy audio, runs FRCRN acoustic noise suppression,
    and returns clean 16kHz 16-bit PCM WAV audio.
    """
    if not model_holder["denoiser"]:
        raise HTTPException(status_code=503, detail="Model is still initializing.")

    # Read uploaded file
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file uploaded.")

    # Write to temporary file for pipeline processing
    suffix = Path(file.filename or "input.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as in_tmp:
        in_tmp.write(file_bytes)
        in_tmp_path = in_tmp.name

    out_tmp_path = in_tmp_path + "_clean.wav"
    std_wav_path = None
    is_temp = False

    try:
        # Standardize audio (handles MP3, FLAC, stereo, arbitrary sample rates)
        std_wav_path, orig_duration, is_temp = load_and_standardize_audio(in_tmp_path)

        t0 = time.time()
        # Execute inference
        model_holder["denoiser"](std_wav_path, output_path=out_tmp_path)
        proc_time = time.time() - t0

        if not os.path.exists(out_tmp_path):
            raise HTTPException(status_code=500, detail="Denoising produced no output.")

        with open(out_tmp_path, "rb") as f_out:
            clean_bytes = f_out.read()

        rtf = proc_time / orig_duration if orig_duration > 0 else 0.0

        if return_json:
            return {
                "filename": file.filename,
                "duration_sec": round(orig_duration, 2),
                "processing_time_sec": round(proc_time, 3),
                "rtf": round(rtf, 4),
                "speed": f"{1.0/rtf:.1f}x real-time" if rtf > 0 else "N/A",
                "clean_file_size_bytes": len(clean_bytes)
            }

        return Response(
            content=clean_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": f'attachment; filename="denoised_{Path(file.filename or "clean.wav").stem}.wav"',
                "X-Processing-Time-Sec": f"{proc_time:.3f}",
                "X-Audio-Duration-Sec": f"{orig_duration:.2f}",
                "X-Real-Time-Factor": f"{rtf:.4f}"
            }
        )

    finally:
        # Cleanup temp files
        for p in [in_tmp_path, out_tmp_path, std_wav_path]:
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Start Speech FRCRN Noise Reduction HTTP Service")
    parser.add_argument("--host", default="0.0.0.0", help="Host interface (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default 8000)")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port)
