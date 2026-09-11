#!/usr/bin/env python3
"""Step 01: Register an agent for the Feishu channel.

Leases a unique flag from the flag pool and writes a registration record.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from util_gate import gate_fail, gate_pass, log_event, step_success, write_status
from util_paths import REGISTRATIONS_FILE


STEP = "01_register"


def load_registrations() -> dict:
    if not REGISTRATIONS_FILE.exists():
        return {"registrations": {}}
    return json.loads(REGISTRATIONS_FILE.read_text(encoding="utf-8"))


def save_registrations(data: dict) -> None:
    REGISTRATIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python 01_register.py <agent_id> [--flag <flag>]", file=sys.stderr)
        write_status(STEP, "FAIL", "missing agent_id")
        return 2

    agent_id = sys.argv[1]
    flag = None
    if "--flag" in sys.argv:
        idx = sys.argv.index("--flag")
        if idx + 1 < len(sys.argv):
            flag = sys.argv[idx + 1]

    # Gate: flag pool script must be reachable
    pool_script = Path(__file__).parent.parent / "hermes-feishu-flag-pool.py"
    if not pool_script.exists():
        gate_fail(STEP, "pool_script_exists", "missing", "exists", f"not found: {pool_script}")

    if flag is None:
        # Lease a memorable word from the pool (e.g. "otter") rather than a
        # random string: the user types this flag on every Feishu reply.
        import subprocess
        proc = subprocess.run(
            [sys.executable, str(pool_script), "lease", "--agent", agent_id],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            gate_fail(STEP, "lease_flag", proc.returncode, 0, proc.stderr.strip())
        flag = json.loads(proc.stdout)["flag"]
    else:
        # An explicit name was requested: lease exactly that flag.
        import subprocess
        proc = subprocess.run(
            [sys.executable, str(pool_script), "lease", "--agent", agent_id, "--flag", flag],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            gate_fail(STEP, "lease_flag", proc.returncode, 0, proc.stderr.strip())
        flag = json.loads(proc.stdout)["flag"]

    registrations = load_registrations()
    # One live flag per agent: a rename (or any re-registration) retires the
    # agent's previous entries so monitor/status never reports a stale flag.
    retired = []
    for existing_flag, record in registrations["registrations"].items():
        if existing_flag != flag and record.get("agent_id") == agent_id and record.get("active"):
            record["active"] = False
            record["retired_at"] = time.time()
            retired.append(existing_flag)
    registrations["registrations"][flag] = {
        "agent_id": agent_id,
        "registered_at": time.time(),
        "active": True,
    }
    save_registrations(registrations)

    gate_pass(STEP, "lease_flag", flag, "assigned")
    log_event(STEP, "registered", agent_id=agent_id, flag=flag, retired=retired)
    step_success(STEP)
    print(json.dumps({
        "flag": flag,
        "agent_id": agent_id,
        "status": "registered",
        "retired_flags": retired,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
