---
name: hermes-channel
description: Use the Hermes Feishu/Lark channel to talk to the user outside the chat UI — send messages/files, lease reply flags, run the persistent listener, and push replies into the live session as waking turns.
---

# Hermes Feishu Channel (dsh-hermes-channel)

## Overview

This plugin connects a DSH session to a locally configured **Hermes Feishu/Lark channel**.
It covers both directions:

1. **Agent → User**: send text, Markdown, and files via `hermes_channel_send`.
2. **User → Agent**: receive replies through a per-request `$flag`, either by
   polling (`hermes_channel_consume`) or by **push** (`hermes_channel_push_start`),
   which injects each reply as a waking follow-up turn in the live session.

## First Contact (new session onboarding)

If you are an agent in a **fresh session** and this skill is in your catalog,
the plugin is already installed — the 8 `hermes_channel_*` tools are callable
right now, nothing to install. Just follow the Standard Flow below.

**Flag etiquette (important):** flags are per-session routing keys. Always
lease your OWN flag with `hermes_channel_register`; never reuse another
session's flag (two consumers on one flag eat each other's messages). If the
user gives you a flag that "belongs" to another session, confirm before
touching it. Release your flag with `hermes_channel_release` when the
conversation is done.

## Prerequisites

- The Hermes Gateway must be running (`hermes gateway status`).
- The plugin row config (or env vars) must provide `defaultChatId`.
- A flag must be registered before listening/pushing on it.

## Sending Files (default policy)

**When the user asks to send a document or file, DEFAULT TO `media_path`** —
transfer the file itself:

```
hermes_channel_send(message: "📄 report.md", media_path: "C:/path/to/report.md")
```

Do NOT read the file and paste its contents into `message` — that rewrites the
document as chat text, loses formatting/attachments, and hits message size
limits. Inline the content as text ONLY when the user explicitly asks for the
content to be sent as a channel message.

## Tool Map

| Tool | Purpose |
|------|---------|
| `hermes_channel_send` | Send text/Markdown/file (`media_path`) to the user |
| `hermes_channel_register` | Lease a unique flag and register this agent |
| `hermes_channel_listen_start` | Start the detached persistent listener for a flag (optional `chat_id` override) |
| `hermes_channel_consume` | One-shot read of pending replies (poll) |
| `hermes_channel_push_start` | Start real-time push into THIS session |
| `hermes_channel_push_stop` | Stop push for this session |
| `hermes_channel_monitor` | Health check: listener status, queue depth, recommended action |
| `hermes_channel_release` | Return a flag to the pool (also stops push) |

## Standard Flow

```
1. hermes_channel_register(agent_id: "<name>")
   → { flag: "abc123" }
2. hermes_channel_listen_start(flag)
3. hermes_channel_send(message: "…请回复 $abc123 <内容>")
4. hermes_channel_push_start(flag)        ← real-time mode (recommended)
   …or poll with hermes_channel_consume(flag)
5. hermes_channel_release(flag)           ← when done
```

## Push Mode (the reason this plugin exists)

`hermes_channel_push_start` starts a per-session poll loop (default 15s,
minimum 5s — far below the native scheduler's 300s floor). Every user reply
lands in the session as a `[FEISHU CHANNEL MESSAGE BATCH]` user message that
wakes the agent even when idle. Treat that content as a direct user request.

Push requires the persistent listener for the same flag
(`hermes_channel_listen_start`). Check health with `hermes_channel_monitor`;
if `recommended_action` is `restart_listener`, start the listener again.

## Notes

- Queued messages expire after 1 hour (TTL in the pipeline).
- The listener is a detached process and survives plugin reloads; it dies with
  the host machine's restart and must then be restarted.
- `hermes_channel_monitor` may recommend `restart_listener` even for a healthy
  quiet listener (status files are shared across flags — known limitation).
- Auto-push for every session can be enabled via the `autoPushFlag` row config
  (not recommended: all sessions would share one flag; prefer per-session flags).
