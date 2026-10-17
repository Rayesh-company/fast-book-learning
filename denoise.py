#!/usr/bin/env python3
"""
Speech Noise Reduction CLI using ModelScope FRCRN (speech_frcrn_ans_cirm_16k)
Frequency-Recurrent Convolutional Recurrent Network for Acoustic Noise Suppression (ANS)

Upgraded with High-Fidelity Long-Form Inference Engine:
- Replaces naive 1s hard-cutting with smooth Hann-window overlap-add cross-fading
- Configurable chunk size (10s - 30s) providing full sentence context to the network
- Residual blending (--blend) to preserve faint speech, consonants, and room naturalness
- Safe dynamic range normalization preventing quiet speech suppression
"""

import os
import sys
import time
import argparse
import tempfile
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

from modelscope.pipelines import pipeline
from modelscope.utils.constant import Tasks

DEFAULT_MODEL_PATHS = [
    "/workspace/model",
    "/workspace/noise-reduction/model",
    "/mnt/workspace/.cache/modelscope/hub/models/damo--speech_frcrn_ans_cirm_16k/snapshots/master",
    "damo/speech_frcrn_ans_cirm_16k"
]

SUPPORTED_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".wma"}


def resolve_model_path(custom_model=None) -> str:
    if custom_model:
        return custom_model

    for path_str in DEFAULT_MODEL_PATHS:
        p = Path(path_str)
        if p.exists() and (p / "pytorch_model.bin").exists():
            return str(p)

    return "damo/speech_frcrn_ans_cirm_16k"


def get_denoiser(model_path: str = None, device: str = None):
    target_model = resolve_model_path(model_path)
    print(f"[*] Initializing FRCRN pipeline from: {target_model}")
    
    t0 = time.time()
    target_device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
    ans = pipeline(
        Tasks.acoustic_noise_suppression,
        model=target_model,
        device=target_device
    )
    ans.model.to(target_device)
    ans.model.eval()
    load_time = time.time() - t0
    device_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
    print(f"[✓] Pipeline ready in {load_time:.2f}s (Device: {device_name}, Weights on: {next(ans.model.parameters()).device})")
    return ans


def load_audio_as_16k_mono(input_path: str) -> tuple[np.ndarray, float]:
    """Loads any audio file (MP3, WAV, etc.) and returns 16kHz float32 mono array."""
    in_p = Path(input_path)
    try:
        data, sr = sf.read(str(in_p))
    except Exception:
        temp_pcm = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        cmd = ["ffmpeg", "-y", "-i", str(in_p), "-ar", "16000", "-ac", "1", temp_pcm]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        data, sr = sf.read(temp_pcm)
        os.remove(temp_pcm)

    duration = float(len(data) / sr)

    if len(data.shape) > 1:
        data = np.mean(data, axis=1)

    if sr != 16000:
        tensor = torch.from_numpy(data.astype(np.float32)).unsqueeze(0)
        resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)
        tensor = resampler(tensor)
        data = tensor.squeeze(0).numpy()

    return data.astype(np.float32), duration


def run_smooth_denoising(
    model,
    audio: np.ndarray,
    device: str = "cuda:0",
    chunk_sec: float = 20.0,
    overlap_sec: float = 2.0,
    blend_ratio: float = 0.05,
    norm_mode: str = "gentle"
) -> np.ndarray:
    """
    Smooth, artifact-free speech denoising using Hann overlap-add.
    Prevents speech truncation, syllable clipping, and clicks at chunk boundaries.
    """
    sr = 16000
    total_len = len(audio)

    # 1. Gentle normalization to prevent faint speech cutoff
    orig_peak = np.max(np.abs(audio)) if total_len > 0 else 1.0
    if norm_mode == "gentle" and orig_peak > 0:
        # Scale to -1 dB peak headroom
        scale = 0.90 / max(orig_peak, 1e-4)
        working_audio = audio * scale
    else:
        working_audio = audio.copy()

    chunk_len = int(chunk_sec * sr)
    overlap_len = int(overlap_sec * sr)
    step_len = chunk_len - overlap_len

    def forward_padded(slice_np: np.ndarray) -> np.ndarray:
        c_len = len(slice_np)
        pad = (320 - (c_len % 320)) % 320 + 320
        padded_slice = np.pad(slice_np, (0, pad))
        t_in = torch.from_numpy(padded_slice).float().unsqueeze(0).to(device)
        with torch.no_grad():
            out_arr = model({'noisy': t_in})['wav_l2'][0].cpu().numpy()
        return out_arr[:c_len]

    # If audio is shorter than chunk_len, process directly
    if total_len <= chunk_len:
        denoised = forward_padded(working_audio)
    else:
        # Long audio: Process with Hann overlap-add cross-fading
        output_acc = np.zeros(total_len, dtype=np.float32)
        weight_acc = np.zeros(total_len, dtype=np.float32)

        fade_in = 0.5 * (1.0 - np.cos(np.linspace(0, np.pi, overlap_len, endpoint=False)))
        fade_out = 0.5 * (1.0 + np.cos(np.linspace(0, np.pi, overlap_len, endpoint=False)))

        for idx in range(0, total_len, step_len):
            end_idx = min(idx + chunk_len, total_len)
            c_len = end_idx - idx

            chunk_slice = working_audio[idx:end_idx]
            out_chunk = forward_padded(chunk_slice)

            # Construct smooth window weights for this chunk
            win_weights = np.ones(c_len, dtype=np.float32)
            if idx > 0 and c_len >= overlap_len:
                win_weights[:overlap_len] = fade_in
            if end_idx < total_len and c_len >= overlap_len:
                win_weights[-overlap_len:] = fade_out

            output_acc[idx:end_idx] += out_chunk * win_weights
            weight_acc[idx:end_idx] += win_weights

        denoised = output_acc / np.maximum(weight_acc, 1e-8)

    # 2. Invert gentle scaling
    if norm_mode == "gentle" and orig_peak > 0:
        denoised = denoised / scale

    # 3. Residual Blending: Mix a small percentage of original audio back
    # Prevents faint speech, whispered words, and consonants from getting muted
    if blend_ratio > 0.0:
        denoised = (1.0 - blend_ratio) * denoised + blend_ratio * audio

    # 4. Final peak limiting to avoid clipping
    peak = np.max(np.abs(denoised))
    if peak > 0.99:
        denoised = denoised * (0.99 / peak)

    return denoised.astype(np.float32)


def denoise_file(
    denoiser,
    input_path: str,
    output_path: str,
    chunk_sec: float = 20.0,
    overlap_sec: float = 2.0,
    blend_ratio: float = 0.05,
    norm_mode: str = "gentle"
) -> dict:
    in_p = Path(input_path)
    out_p = Path(output_path)
    out_p.parent.mkdir(parents=True, exist_ok=True)

    # 1. Load standardized audio
    audio_data, duration = load_audio_as_16k_mono(str(in_p))

    # 2. Run smooth GPU denoising
    target_device = getattr(denoiser, "device", "cuda:0")
    t0 = time.time()
    clean_audio = run_smooth_denoising(
        model=denoiser.model,
        audio=audio_data,
        device=target_device,
        chunk_sec=chunk_sec,
        overlap_sec=overlap_sec,
        blend_ratio=blend_ratio,
        norm_mode=norm_mode
    )
    elapsed = time.time() - t0

    # 3. Save output
    encode_mp3 = out_p.suffix.lower() == ".mp3"
    if encode_mp3:
        temp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
        sf.write(temp_wav, clean_audio, 16000)
        cmd = ["ffmpeg", "-y", "-i", temp_wav, "-b:a", "192k", str(out_p)]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        os.remove(temp_wav)
    else:
        sf.write(str(out_p), clean_audio, 16000)

    rtf = elapsed / duration if duration > 0 else 0.0

    return {
        "input": str(in_p),
        "output": str(out_p),
        "duration_sec": round(duration, 2),
        "elapsed_sec": round(elapsed, 3),
        "rtf": round(rtf, 4),
        "speed": f"{1.0/rtf:.1f}x real-time" if rtf > 0 else "N/A"
    }


def process_path(denoiser, input_path: str, output_path: str, **kwargs):
    in_p = Path(input_path)
    if not in_p.exists():
        print(f"[!] Error: Input path does not exist: {input_path}")
        sys.exit(1)

    if in_p.is_file():
        out_ext = in_p.suffix if in_p.suffix.lower() in [".mp3", ".wav"] else ".wav"
        out_p = output_path or (in_p.parent / f"{in_p.stem}_denoised{out_ext}")
        print(f"\n[+] Processing: {in_p.name} ({in_p.stat().st_size / 1024:.1f} KB)")
        res = denoise_file(denoiser, in_p, out_p, **kwargs)
        print(f"    -> Output saved: {res['output']}")
        print(f"    -> Audio duration: {res['duration_sec']}s | Latency: {res['elapsed_sec']}s ({res['speed']})")
        return [res]

    elif in_p.is_dir():
        audio_files = [f for f in in_p.iterdir() if f.suffix.lower() in SUPPORTED_EXTENSIONS]
        if not audio_files:
            print(f"[!] No audio files found in: {in_p}")
            return []

        out_dir = Path(output_path) if output_path else in_p / "denoised"
        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n[+] Found {len(audio_files)} audio file(s) in {in_p}. Saving to {out_dir}")

        results = []
        total_audio_time = 0.0
        total_proc_time = 0.0

        for idx, f in enumerate(audio_files, 1):
            out_file = out_dir / f"{f.stem}_denoised{f.suffix}"
            print(f"[{idx}/{len(audio_files)}] Denoising {f.name}...")
            res = denoise_file(denoiser, f, out_file, **kwargs)
            results.append(res)
            total_audio_time += res["duration_sec"]
            total_proc_time += res["elapsed_sec"]
            print(f"      Done in {res['elapsed_sec']}s (RTF: {res['rtf']})")

        overall_rtf = total_proc_time / total_audio_time if total_audio_time > 0 else 0
        print(f"\n[✓] Batch Completed:")
        print(f"    Total audio duration: {total_audio_time:.2f}s")
        print(f"    Total processing time: {total_proc_time:.2f}s")
        print(f"    Overall speed: {1.0/overall_rtf:.1f}x real-time")
        return results


def run_self_test(denoiser):
    print("\n" + "="*50)
    print("RUNNING SMOOTH HANN OVERLAP-ADD SELF-TEST")
    print("="*50)

    candidates = [
        "/workspace/model/examples/speech_with_noise1.wav",
        "/mnt/workspace/.cache/modelscope/hub/models/damo--speech_frcrn_ans_cirm_16k/snapshots/master/examples/speech_with_noise1.wav"
    ]
    test_files = [c for c in candidates if os.path.exists(c)]
    out_test = "/tmp/test_denoised.wav"
    for sample in test_files:
        print(f"\n[*] Testing sample: {sample}")
        res = denoise_file(denoiser, sample, out_test, chunk_sec=20.0, overlap_sec=2.0, blend_ratio=0.05)
        print(f"[✓] Success: {res['output']}")
        print(f"    Duration: {res['duration_sec']}s, Latency: {res['elapsed_sec']}s ({res['speed']})")

    print("\n[✓] Self-test finished successfully!")


def main():
    parser = argparse.ArgumentParser(
        description="Speech Noise Reduction using ModelScope FRCRN with Smooth Hann Overlap-Add"
    )
    parser.add_argument("input", nargs="?", help="Input audio file (MP3, WAV, FLAC, etc.) or folder")
    parser.add_argument("-o", "--output", help="Output file path (.wav or .mp3) or folder")
    parser.add_argument("--model", help="Custom model path or model ID")
    parser.add_argument("--device", choices=["cuda:0", "cpu"], help="Inference device")
    parser.add_argument("--test", action="store_true", help="Run self-test on bundled noisy samples")
    
    # Tunable parameters to prevent audio cutoffs
    parser.add_argument("--chunk-size", type=float, default=20.0,
                        help="Chunk window size in seconds (default: 20.0s). Higher values give better sentence context.")
    parser.add_argument("--overlap", type=float, default=2.0,
                        help="Hann cross-fade overlap in seconds (default: 2.0s). Eliminates boundary clipping.")
    parser.add_argument("--blend", type=float, default=0.05,
                        help="Residual blend ratio of original audio (default: 0.05 / 5%%). Prevents faint voice cutoffs.")
    parser.add_argument("--norm", choices=["gentle", "none"], default="gentle",
                        help="Normalization mode (default: gentle). Prevents quiet speech suppression.")
    
    args = parser.parse_args()

    if not args.input and not args.test:
        parser.print_help()
        print("\nExamples to Fix Audio Cutoffs:")
        print("  python denoise.py input.mp3 -o clean.wav --chunk-size 30 --overlap 3 --blend 0.10")
        print("  python denoise.py input.mp3 -o clean.mp3 --blend 0.08")
        sys.exit(1)

    denoiser = get_denoiser(model_path=args.model, device=args.device)

    if args.test:
        run_self_test(denoiser)

    if args.input:
        process_path(
            denoiser,
            args.input,
            args.output,
            chunk_sec=args.chunk_size,
            overlap_sec=args.overlap,
            blend_ratio=args.blend,
            norm_mode=args.norm
        )


if __name__ == "__main__":
    main()
