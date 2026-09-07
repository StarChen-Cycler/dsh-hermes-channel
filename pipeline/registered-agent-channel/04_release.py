#!/usr/bin/env python3
"""Step 04: Release a flag back to the pool and mark the registration inactive."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from util_gate import gate_fail, gate_pass, log_event, step_success
from util_paths import REGISTRATIONS_FILE


STEP = "04_release"


def load_registrations() -> dict:
    if not REGISTRATIONS_FILE.exists():
        return {"registrations": {}}
    return json.loads(REGISTRATIONS_FILE.read_text(encoding="utf-8"))


def save_registrations(data: dict) -> None:
    REGISTRATIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python 04_release.py <flag>", file=sys.stderr)
        return 2

    flag = sys.argv[1]
    pool_script = Path(__file__).parent.parent / "hermes-feishu-flag-pool.py"
    if not pool_script.exists():
        gate_fail(STEP, "pool_script_exists", "missing", "exists", f"not found: {pool_script}")

    import subprocess
    proc = subprocess.run(
        [sys.executable, str(pool_script), "release", flag],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        gate_fail(STEP, "release_flag", proc.returncode, 0, proc.stderr.strip())

    registrations = load_registrations()
    if flag in registrations["registrations"]:
        registrations["registrations"][flag]["active"] = False
        registrations["registrations"][flag]["released_at"] = time.time()
        save_registrations(registrations)

    gate_pass(STEP, "release_flag", flag, "released")
    log_event(STEP, "released", flag=flag)
    step_success(STEP)
    print(json.dumps({"flag": flag, "status": "released"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
