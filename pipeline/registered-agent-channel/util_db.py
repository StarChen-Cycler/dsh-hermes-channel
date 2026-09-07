"""state.db access helpers for the registered-agent-channel pipeline."""

from __future__ import annotations

import sqlite3
from typing import List, Optional, Tuple

from util_paths import HERMES_STATE_DB


def get_session_id(chat_id: str) -> Optional[str]:
    conn = sqlite3.connect(HERMES_STATE_DB)
    try:
        row = conn.execute(
            "SELECT id FROM sessions WHERE source='feishu' AND chat_id=?",
            (chat_id,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def get_user_messages_since(session_id: str, since_id: int) -> List[Tuple[int, float, Optional[str], Optional[str], Optional[str]]]:
    conn = sqlite3.connect(HERMES_STATE_DB)
    try:
        return conn.execute(
            "SELECT id, timestamp, content, platform_message_id, display_metadata "
            "FROM messages WHERE session_id=? AND role='user' AND id > ? "
            "ORDER BY id ASC",
            (session_id, since_id),
        ).fetchall()
    finally:
        conn.close()


def get_latest_user_message_id(session_id: str) -> int:
    conn = sqlite3.connect(HERMES_STATE_DB)
    try:
        row = conn.execute(
            "SELECT MAX(id) FROM messages WHERE session_id=? AND role='user'",
            (session_id,),
        ).fetchone()
        return row[0] if row and row[0] else 0
    finally:
        conn.close()
