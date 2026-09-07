"""Gate/STATUS/log framework for the registered-agent-channel pipeline."""

from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

from util_paths import LOGS_DIR


def log_path(step: str) -> Path:
    return LOGS_DIR / step


def status_path(step: str) -> Path:
    return LOGS_DIR / step / "STATUS.txt"


def timing_path(step: str) -> Path:
    return LOGS_DIR / step / "timing.json"


def write_status(step: str, status: str, reason: Optional[str] = None) -> None:
    path = status_path(step)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = f"{status}\n"
    if reason:
        content += f"reason: {reason}\n"
    path.write_text(content, encoding="utf-8")


def read_status(step: str) -> Optional[str]:
    path = status_path(step)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").splitlines()[0].strip() if path.read_text(encoding="utf-8").strip() else None


def log_event(step: str, event: str, **fields: Any) -> None:
    """Append a timestamped JSON line to the step log."""
    path = log_path(step) / "step.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"ts": time.time(), "event": event, **fields}
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def gate_fail(step: str, gate: str, measured: Any, threshold: Any, reason: str) -> None:
    """Log a precise gate failure and write FAIL status."""
    log_event(step, "gate_fail", gate=gate, measured=measured, threshold=threshold, reason=reason)
    write_status(step, "FAIL", f"{gate}: {reason}")
    print(f"GATE FAIL [{step}] {gate}: measured={measured} threshold={threshold} reason={reason}", file=sys.stderr)
    sys.exit(1)


def gate_pass(step: str, gate: str, measured: Any, threshold: Any) -> None:
    log_event(step, "gate_pass", gate=gate, measured=measured, threshold=threshold)


def step_success(step: str) -> None:
    write_status(step, "PASS")
    log_event(step, "step_complete")
