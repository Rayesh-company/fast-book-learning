import subprocess
import base64
import time
import sys
import json

def run_vps_script(bash_script: str):
    b64 = base64.b64encode(bash_script.encode('utf-8')).decode('ascii')
    print("Triggering workflow dispatch with script...")
    res = subprocess.run([
        "gh", "workflow", "run", "env-check.yml",
        "--ref", "2book-ingest",
        "-f", f"script_b64={b64}"
    ], capture_output=True, text=True)
    if res.returncode != 0:
        print("Failed to dispatch workflow:", res.stderr)
        return
    print("Workflow dispatched. Waiting 6 seconds for run to register...")
    time.sleep(6)
    
    # Get latest run id
    res = subprocess.run(["gh", "run", "list", "--workflow=env-check.yml", "--limit=1", "--json=databaseId,status"], capture_output=True, text=True)
    runs = json.loads(res.stdout)
    if not runs:
        print("No runs found")
        return
    run_id = runs[0]["databaseId"]
    print(f"Tracking run {run_id}...")
    subprocess.run(["gh", "run", "watch", str(run_id)])
    print(f"Fetching logs for run {run_id}...")
    subprocess.run(["gh", "run", "view", str(run_id), "--log"])

if __name__ == "__main__":
    script_path = sys.argv[1] if len(sys.argv) > 1 else "scripts/run_check_vps.sh"
    with open(script_path, "r", encoding="utf-8") as f:
        content = f.read()
    run_vps_script(content)
