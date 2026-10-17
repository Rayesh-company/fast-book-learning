#!/usr/bin/env python3
"""
Test and Verification Suite for speech_frcrn_ans_cirm_16k
Validates output audio integrity, duration consistency, and processing speed.
"""

import sys
import time
from pathlib import Path
import numpy as np
import soundfile as sf
import torch

from denoise import get_denoiser, denoise_file, resolve_model_path


def test_suite():
    print("=" * 60)
    print("  Speech FRCRN Noise Suppression - Verification Suite")
    print("=" * 60)

    # 1. Environment & GPU Checks
    cuda_ok = torch.cuda.is_available()
    device = torch.cuda.get_device_name(0) if cuda_ok else "CPU"
    print(f"[*] CUDA Available: {cuda_ok}")
    print(f"[*] Compute Device: {device}")
    
    # 2. Pipeline Initialization
    denoiser = get_denoiser()

    # 3. Test on Bundled Samples
    sample_dir = Path("/workspace/model/examples")
    if not sample_dir.exists():
        sample_dir = Path("/mnt/workspace/.cache/modelscope/hub/models/damo--speech_frcrn_ans_cirm_16k/snapshots/master/examples")

    samples = list(sample_dir.glob("*.wav")) if sample_dir.exists() else []
    
    # Also add test MP3 sample
    mp3_sample = Path("/tmp/test_stereo_44k.mp3")
    if mp3_sample.exists():
        samples.append(mp3_sample)

    if not samples:
        print("[!] No sample files found.")
        sys.exit(1)

    print(f"\n[*] Found {len(samples)} verification sample(s):")
    out_dir = Path("/tmp/verification_results")
    out_dir.mkdir(parents=True, exist_ok=True)

    all_passed = True

    for sample in samples:
        out_wav = out_dir / f"clean_{sample.name}"
        print(f"\n--- Testing: {sample.name} ---")
        res = denoise_file(denoiser, str(sample), str(out_wav))
        
        # Verify file existence and readability
        if not out_wav.exists():
            print(f"[FAIL] Output file was not created: {out_wav}")
            all_passed = False
            continue

        raw_in, sr_in = sf.read(str(sample))
        clean, sr_out = sf.read(str(out_wav))

        # Check sample rate
        assert sr_out == 16000, f"Expected 16000Hz, got {sr_out}Hz"
        
        # Check duration
        dur_in = len(raw_in) / sr_in
        dur_out = len(clean) / sr_out
        dur_diff = abs(dur_in - dur_out)
        print(f"  Duration: Input={dur_in:.2f}s | Output={dur_out:.2f}s (Diff: {dur_diff:.3f}s)")
        assert dur_diff < 0.1, f"Duration mismatch: {dur_diff:.3f}s"

        # Check amplitude sanity
        peak_amp = np.max(np.abs(clean))
        rms_in = np.sqrt(np.mean(raw_in**2))
        rms_out = np.sqrt(np.mean(clean**2))
        print(f"  Signal RMS: Input={rms_in:.4f} -> Output={rms_out:.4f} (Peak={peak_amp:.4f})")
        assert peak_amp <= 1.0, f"Output clipped! Peak={peak_amp}"

        # Speed metric
        print(f"  Processing Time: {res['elapsed_sec']}s (RTF: {res['rtf']}, Speed: {res['speed']})")
        print(f"  [PASS] {sample.name} verified successfully.")

    print("\n" + "=" * 60)
    if all_passed:
        print("  ALL VERIFICATION CHECKS PASSED [OK]")
    else:
        print("  SOME CHECKS FAILED [FAIL]")
    print("=" * 60)
    return all_passed


if __name__ == "__main__":
    success = test_suite()
    sys.exit(0 if success else 1)
