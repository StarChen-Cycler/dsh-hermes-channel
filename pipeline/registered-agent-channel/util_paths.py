"""Paths and constants for the registered-agent-channel pipeline."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOGS_DIR = ROOT / "logs"
QUEUES_DIR = ROOT / "queues"
REGISTRATIONS_FILE = ROOT / "registrations.json"

# Hermes paths (env-overridable for portability)
_default_hermes = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "hermes"
HERMES_HOME = Path(os.environ.get("HERMES_HOME", str(_default_hermes)))
HERMES_STATE_DB = HERMES_HOME / "state.db"
HERMES_GATEWAY_LOG = HERMES_HOME / "logs" / "gateway.log"

# Defaults
DEFAULT_CHAT_ID = os.environ.get("HERMES_CHAT_ID", "")
CHANNEL_SIGNATURE = "[CHANNEL:feishu]"
POLL_INTERVAL_SECONDS = 1.0
MESSAGE_TTL_SECONDS = 3600  # captured messages expire after 1 hour
