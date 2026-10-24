#!/usr/bin/env python3
"""
Robust, Resumable Docker Image Downloader & Loader for ModelScope
Image: modelscope-registry.us-west-1.cr.aliyuncs.com/modelscope-repo/modelscope:ubuntu22.04-cuda12.8.1-py312-torch2.10.0-1.39.0
"""

import os
import sys
import time
import json
import hashlib
import tarfile
import subprocess
import requests

CACHE_DIR = r"E:\modelscope_cache"
BLOBS_DIR = os.path.join(CACHE_DIR, "blobs", "sha256")
REPO_TAG = "modelscope-registry.us-west-1.cr.aliyuncs.com/modelscope-repo/modelscope:ubuntu22.04-cuda12.8.1-py312-torch2.10.0-1.39.0"

ENDPOINTS = [
    {
        "name": "us-west-1",
        "registry": "https://modelscope-registry.us-west-1.cr.aliyuncs.com",
        "auth": "https://dockerauth-us-west-1.aliyuncs.com/auth?scope=repository%3Amodelscope-repo%2Fmodelscope%3Apull&service=registry.aliyuncs.com%3Aus-west-1%3Achina%3Acri-dyo42qk4t4l8fs8t",
    },
    {
        "name": "cn-hangzhou",
        "registry": "https://modelscope-registry.cn-hangzhou.cr.aliyuncs.com",
        "auth": "https://dockerauth.cn-hangzhou.aliyuncs.com/auth?scope=repository%3Amodelscope-repo%2Fmodelscope%3Apull&service=registry.aliyuncs.com%3Acn-hangzhou%3Achina%3Acri-75ecx767oktevn8h",
    },
]

token_cache = {}


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def get_token(endpoint, force=False):
    key = endpoint["name"]
    now = time.time()
    if not force and key in token_cache:
        token, ts = token_cache[key]
        if now - ts < 240:  # Refresh token every 4 minutes (max is 10 min)
            return token

    for attempt in range(10):
        try:
            r = requests.get(endpoint["auth"], timeout=15)
            if r.status_code == 200:
                token = r.json()["token"]
                token_cache[key] = (token, now)
                return token
        except Exception as e:
            log(f"Warning: Failed to fetch token for {key}: {e}. Retrying...")
            time.sleep(2)

    raise RuntimeError(f"Unable to fetch token for endpoint {key}")


def verify_sha256(filepath, expected_hex):
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(4 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest() == expected_hex


def download_blob(digest_str, expected_size, desc, global_progress):
    # digest_str is "sha256:<hex>"
    sha_hex = digest_str.split(":", 1)[1]
    out_path = os.path.join(BLOBS_DIR, sha_hex)

    # 1. Check if file is already fully downloaded
    if os.path.exists(out_path):
        current_len = os.path.getsize(out_path)
        if current_len == expected_size:
            log(f"Verifying existing file for {desc} ({expected_size / 1024 / 1024:.1f} MB)...")
            if verify_sha256(out_path, sha_hex):
                log(f"-> {desc} already exists and is verified.")
                global_progress["downloaded_total"] += expected_size
                return
            else:
                log(f"-> SHA mismatch for {desc}. Redownloading...")
                os.remove(out_path)
        elif current_len > expected_size:
            log(f"-> File size {current_len} > {expected_size}. Truncating...")
            os.remove(out_path)

    # 2. Resumable download loop
    endpoint_idx = 0
    max_retries = 100
    chunk_size = 1024 * 1024  # 1 MB
    blob_downloaded_before = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    global_progress["downloaded_total"] += blob_downloaded_before

    for attempt in range(max_retries):
        endpoint = ENDPOINTS[endpoint_idx % len(ENDPOINTS)]
        current_offset = os.path.getsize(out_path) if os.path.exists(out_path) else 0

        if current_offset >= expected_size:
            break

        headers = {}
        if current_offset > 0:
            headers["Range"] = f"bytes={current_offset}-"

        try:
            token = get_token(endpoint)
            headers["Authorization"] = f"Bearer {token}"
            blob_url = f"{endpoint['registry']}/v2/modelscope-repo/modelscope/blobs/sha256:{sha_hex}"

            with requests.get(blob_url, headers=headers, stream=True, timeout=30) as resp:
                if resp.status_code == 401:
                    log(f"Token expired, refreshing for {endpoint['name']}...")
                    get_token(endpoint, force=True)
                    continue

                if resp.status_code not in (200, 206):
                    log(f"HTTP {resp.status_code} from {endpoint['name']} on {desc}. Switching endpoint...")
                    endpoint_idx += 1
                    time.sleep(2)
                    continue

                mode = "ab" if current_offset > 0 else "wb"
                with open(out_path, mode) as f:
                    last_log_time = time.time()
                    last_log_bytes = current_offset

                    for chunk in resp.iter_content(chunk_size=chunk_size):
                        if not chunk:
                            continue
                        f.write(chunk)
                        chunk_len = len(chunk)
                        current_offset += chunk_len
                        global_progress["downloaded_total"] += chunk_len

                        now = time.time()
                        if now - last_log_time >= 10.0 or current_offset == expected_size:
                            speed = (current_offset - last_log_bytes) / (now - last_log_time) / (1024 * 1024)
                            pct = (current_offset / expected_size) * 100
                            tot_pct = (global_progress["downloaded_total"] / global_progress["size_total"]) * 100
                            log(
                                f"{desc}: {current_offset / 1024 / 1024:.1f}/{expected_size / 1024 / 1024:.1f} MB "
                                f"({pct:.1f}%) | {speed:.2f} MB/s | "
                                f"Total: {global_progress['downloaded_total'] / 1024 / 1024 / 1024:.2f}/{global_progress['size_total'] / 1024 / 1024 / 1024:.2f} GB ({tot_pct:.1f}%)"
                            )
                            last_log_time = now
                            last_log_bytes = current_offset

                if current_offset == expected_size:
                    break

        except Exception as e:
            log(f"Network hiccup ({type(e).__name__}: {e}) on {desc} at offset {current_offset}. Retrying in 5s...")
            time.sleep(5)
            # Switch to other endpoint on timeout / disconnect
            endpoint_idx += 1

    # Verify sha256
    log(f"Verifying checksum for {desc}...")
    if not verify_sha256(out_path, sha_hex):
        raise RuntimeError(f"Checksum mismatch for {desc} after download!")
    log(f"-> {desc} downloaded and verified successfully!")


def main():
    os.makedirs(BLOBS_DIR, exist_ok=True)
    log("=== ModelScope Docker Setup Starting ===")
    log(f"Target Image: {REPO_TAG}")
    log(f"Cache Location: {CACHE_DIR}")

    # Fetch manifest
    primary_ep = ENDPOINTS[0]
    token = get_token(primary_ep)
    manifest_url = f"{primary_ep['registry']}/v2/modelscope-repo/modelscope/manifests/ubuntu22.04-cuda12.8.1-py312-torch2.10.0-1.39.0"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
    }
    r = requests.get(manifest_url, headers=headers, timeout=15)
    r.raise_for_status()
    manifest = r.json()

    config_digest = manifest["config"]["digest"]
    config_size = manifest["config"]["size"]
    layers = manifest["layers"]

    total_image_bytes = config_size + sum(l["size"] for l in layers)
    log(f"Image has 1 config + {len(layers)} layers. Total compressed size: {total_image_bytes / 1024 / 1024 / 1024:.2f} GB")

    global_progress = {
        "downloaded_total": 0,
        "size_total": total_image_bytes,
    }

    # 1. Download config blob
    log("Downloading image config blob...")
    download_blob(config_digest, config_size, "Config Blob", global_progress)

    # 2. Download all layer blobs
    for i, layer in enumerate(layers, 1):
        digest = layer["digest"]
        size = layer["size"]
        desc = f"Layer [{i}/{len(layers)}] {digest[7:19]}"
        download_blob(digest, size, desc, global_progress)

    log("=== All 29 Layers & Config downloaded and verified! ===")

    # 3. Build manifest.json for docker load
    docker_manifest = [
        {
            "Config": f"blobs/sha256/{config_digest.split(':', 1)[1]}",
            "RepoTags": [REPO_TAG],
            "Layers": [f"blobs/sha256/{l['digest'].split(':', 1)[1]}" for l in layers],
        }
    ]
    manifest_path = os.path.join(CACHE_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(docker_manifest, f, indent=2)

    log("Manifest written. Streaming archive directly to 'docker load'...")

    load_proc = subprocess.Popen(
        ["docker", "load"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    with tarfile.open(fileobj=load_proc.stdin, mode="w|") as tar:
        tar.add(os.path.join(CACHE_DIR, "blobs"), arcname="blobs")
        tar.add(manifest_path, arcname="manifest.json")

    load_proc.stdin.close()
    out, _ = load_proc.communicate()
    log(f"Docker load output:\n{out.decode('utf-8', errors='replace')}")
    if load_proc.returncode != 0:
        raise RuntimeError(f"docker load failed with return code {load_proc.returncode}")

    log("=== Docker Image Loaded Successfully! ===")

    # 4. Run and test container
    log("Starting container 'modelscope-env' with GPU passthrough...")
    subprocess.run(["docker", "rm", "-f", "modelscope-env"], capture_output=True)

    run_cmd = [
        "docker", "run", "-d",
        "--name", "modelscope-env",
        "--gpus", "all",
        "--ipc=host",
        "--shm-size=16g",
        "-v", f"{os.getcwd()}:/workspace",
        "-w", "/workspace",
        REPO_TAG,
        "sleep", "infinity",
    ]
    log(f"Running command: {' '.join(run_cmd)}")
    subprocess.run(run_cmd, check=True)

    log("Verifying PyTorch CUDA & ModelScope inside the container...")
    test_code = (
        "import torch; "
        "print('CUDA Available:', torch.cuda.is_available()); "
        "print('Device Name:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None'); "
        "import modelscope; "
        "print('ModelScope Version:', modelscope.__version__)"
    )
    test_proc = subprocess.run(
        ["docker", "exec", "modelscope-env", "python", "-c", test_code],
        capture_output=True,
        text=True,
    )
    log(f"Verification output:\n{test_proc.stdout}")
    if test_proc.stderr:
        log(f"Verification stderr:\n{test_proc.stderr}")

    log("=== Setup & Verification Complete! ===")


if __name__ == "__main__":
    main()
