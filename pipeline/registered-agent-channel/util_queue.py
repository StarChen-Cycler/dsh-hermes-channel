"""Durable queue management for the registered-agent-channel pipeline."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from util_paths import QUEUES_DIR, CHANNEL_SIGNATURE, MESSAGE_TTL_SECONDS


def queue_path(flag: str) -> Path:
    return QUEUES_DIR / f"{flag}.jsonl"


def append_message(flag: str, message: Dict[str, Any]) -> Path:
    """Append a captured user message to the durable queue."""
    path = queue_path(flag)
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": time.time(),
        "signature": CHANNEL_SIGNATURE,
        "read": False,
        **message,
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path


def read_pending(flag: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """Return unread, non-expired messages from the queue."""
    path = queue_path(flag)
    if not path.exists():
        return []
    now = time.time()
    pending: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if entry.get("read"):
            continue
        if now - entry.get("ts", 0) > MESSAGE_TTL_SECONDS:
            continue
        pending.append(entry)
        if limit and len(pending) >= limit:
            break
    return pending


def mark_read(flag: str, message_id: Optional[int] = None) -> int:
    """Mark queue entries as read. If message_id is given, mark only that entry."""
    path = queue_path(flag)
    if not path.exists():
        return 0
    lines = []
    changed = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if not entry.get("read") and (message_id is None or entry.get("id") == message_id):
            entry["read"] = True
            changed += 1
        lines.append(json.dumps(entry, ensure_ascii=False))
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return changed


def queue_size(flag: str) -> int:
    return len(read_pending(flag))
