#!/usr/bin/env python3
"""Step 06: Acknowledge (mark read) specific channel messages.

Separated from 03_consume on purpose: a consumer PEEKS with 03_consume, delivers
the batch, and only calls 06_ack for the ids whose delivery actually succeeded.
A turn that failed (provider rate limiting, transient error) leaves its messages
unread so the next poll can deliver them again.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from util_gate import log_event, step_success, write_status
from util_queue import mark_read_many

STEP = "06_ack"


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: python 06_ack.py <flag> <message_id> [<message_id> ...]", file=sys.stderr)
        write_status(STEP, "FAIL", "missing flag or message ids")
        return 2

    flag = sys.argv[1]
    ids = []
    for raw in sys.argv[2:]:
        try:
            ids.append(int(raw))
        except ValueError:
            print(json.dumps({"error": f"invalid message id: {raw}"}), file=sys.stderr)
            write_status(STEP, "FAIL", f"invalid message id {raw}")
            return 2

    marked = mark_read_many(flag, ids)
    log_event(STEP, "acked", flag=flag, requested=len(ids), marked=marked)
    print(json.dumps({"flag": flag, "requested": len(ids), "marked": marked}, ensure_ascii=False))
    step_success(STEP)
    return 0


if __name__ == "__main__":
    sys.exit(main())
