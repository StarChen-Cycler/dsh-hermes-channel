#!/usr/bin/env python3
"""Step 02: Persistent listener for the Feishu channel.

Polls Hermes state.db for new user messages matching a registered flag,
then appends them to the durable queue with the channel signature.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from util_db import get_latest_user_message_id, get_session_id, get_user_messages_since
from util_gate import gate_fail, gate_pass, log_event, write_status
from util_paths import DEFAULT_CHAT_ID, POLL_INTERVAL_SECONDS, REGISTRATIONS_FILE
from util_queue import append_message


STEP = "02_listen"


def load_registrations() -> dict:
    if not REGISTRATIONS_FILE.exists():
        return {"registrations": {}}
    return json.loads(REGISTRATIONS_FILE.read_text(encoding="utf-8"))


def message_matches_flag(content: str, flag: str) -> bool:
    return content.startswith(f"${flag} ")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python 02_listen.py <flag> [--chat-id <chat_id>]", file=sys.stderr)
        write_status(STEP, "FAIL", "missing flag")
        return 2

    flag = sys.argv[1]
    chat_id = DEFAULT_CHAT_ID
    if "--chat-id" in sys.argv:
        idx = sys.argv.index("--chat-id")
        if idx + 1 < len(sys.argv):
            chat_id = sys.argv[idx + 1]

    # Gate 1: registration exists
    registrations = load_registrations()
    if flag not in registrations["registrations"]:
        gate_fail(STEP, "registration_exists", "missing", "registered", f"flag '{flag}' not in registrations.json")
    gate_pass(STEP, "registration_exists", flag, "registered")

    # Gate 2: state.db session exists
    session_id = get_session_id(chat_id)
    if not session_id:
        gate_fail(STEP, "session_exists", "missing", "exists", f"no feishu session for chat_id={chat_id}")
    gate_pass(STEP, "session_exists", session_id, "found")

    baseline_id = get_latest_user_message_id(session_id)
    log_event(STEP, "listening", flag=flag, chat_id=chat_id, session_id=session_id, baseline_id=baseline_id)
    write_status(STEP, "RUNNING")

    try:
        while True:
            new_messages = get_user_messages_since(session_id, baseline_id)
            for msg_id, ts, content, platform_msg_id, metadata in new_messages:
                baseline_id = max(baseline_id, msg_id)
                if not content:
                    continue
                if not message_matches_flag(content, flag):
                    log_event(STEP, "ignored", message_id=msg_id, content_preview=content[:80])
                    continue
                stripped = content[len(f"${flag} "):]
                append_message(flag, {
                    "id": msg_id,
                    "timestamp": ts,
                    "platform_message_id": platform_msg_id,
                    "content": content,
                    "stripped_content": stripped,
                    "display_metadata": metadata,
                })
                log_event(STEP, "captured", flag=flag, message_id=msg_id, content=stripped[:120])
            time.sleep(POLL_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        write_status(STEP, "STOPPED", "keyboard interrupt")
        log_event(STEP, "stopped", reason="keyboard interrupt")
        return 0
    except Exception as exc:
        gate_fail(STEP, "listen_loop", "exception", "no exception", str(exc))


if __name__ == "__main__":
    sys.exit(main())
