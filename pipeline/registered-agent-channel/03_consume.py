#!/usr/bin/env python3
"""Step 03: Consume pending channel messages for an agent.

Reads the durable queue for a given flag, marks messages as read, and prints
them with the [CHANNEL:feishu] signature. Intended to be called by the agent
at turn boundaries or when it wants to check for user input.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from util_gate import gate_fail, gate_pass, log_event, step_success
from util_queue import mark_read, read_pending


STEP = "03_consume"


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python 03_consume.py <flag> [--limit N] [--mark-read]", file=sys.stderr)
        return 2

    flag = sys.argv[1]
    limit = None
    mark_read_after = False
    if "--limit" in sys.argv:
        idx = sys.argv.index("--limit")
        if idx + 1 < len(sys.argv):
            limit = int(sys.argv[idx + 1])
    if "--mark-read" in sys.argv:
        mark_read_after = True

    pending = read_pending(flag, limit=limit)
    gate_pass(STEP, "queue_readable", len(pending), "any")

    result = {
        "flag": flag,
        "count": len(pending),
        "messages": [
            {
                "id": m.get("id"),
                "timestamp": m.get("timestamp"),
                "signature": m.get("signature"),
                "content": m.get("stripped_content") or m.get("content"),
                "file_paths": m.get("file_paths", []),
            }
            for m in pending
        ],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if mark_read_after:
        marked = mark_read(flag)
        log_event(STEP, "marked_read", flag=flag, count=marked)

    log_event(STEP, "consumed", flag=flag, count=len(pending))
    step_success(STEP)
    return 0


if __name__ == "__main__":
    sys.exit(main())
