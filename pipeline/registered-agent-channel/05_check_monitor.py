#!/usr/bin/env python3
"""Step 05: Monitor check for the registered-agent-channel listener.

Checks whether the listener for a given flag is still alive and whether
the registration is still active. Intended to be run periodically (e.g.
every 5 minutes via cron) by the agent.

Returns JSON with status and recommended action.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from util_gate import log_event
from util_paths import LOGS_DIR, REGISTRATIONS_FILE
from util_queue import queue_size


STEP = "05_check_monitor"


def load_registrations() -> dict:
    if not REGISTRATIONS_FILE.exists():
        return {"registrations": {}}
    return json.loads(REGISTRATIONS_FILE.read_text(encoding="utf-8"))


def listener_status(flag: str) -> str:
    path = LOGS_DIR / "02_listen" / "STATUS.txt"
    if not path.exists():
        return "missing"
    return path.read_text(encoding="utf-8").splitlines()[0].strip()


def listener_last_event_age(flag: str) -> float:
    path = LOGS_DIR / "02_listen" / "step.log"
    if not path.exists():
        return float("inf")
    lines = [l for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not lines:
        return float("inf")
    last = json.loads(lines[-1])
    return time.time() - last.get("ts", 0)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python 05_check_monitor.py <flag>", file=sys.stderr)
        return 2

    flag = sys.argv[1]
    registrations = load_registrations()
    reg = registrations["registrations"].get(flag)

    result = {
        "flag": flag,
        "registered": reg is not None,
        "active": bool(reg and reg.get("active")),
        "listener_status": listener_status(flag),
        "listener_last_event_age_seconds": round(listener_last_event_age(flag), 1),
        "queue_pending": queue_size(flag),
        "recommended_action": None,
    }

    if not result["registered"]:
        result["recommended_action"] = "register_new"
    elif not result["active"]:
        result["recommended_action"] = "register_new"
    elif result["listener_status"] not in ("RUNNING", "PASS"):
        result["recommended_action"] = "restart_listener"
    elif result["listener_last_event_age_seconds"] > 600:
        result["recommended_action"] = "restart_listener"
    else:
        result["recommended_action"] = "none"

    log_event(STEP, "checked", flag=flag, action=result["recommended_action"])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
