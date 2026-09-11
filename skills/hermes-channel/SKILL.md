---
name: hermes-channel
description: Use the Hermes Feishu/Lark channel to talk to the user outside the chat UI — send messages/files, lease reply flags, run the persistent listener, and push replies into the live session as waking turns.
---

# Hermes Feishu Channel (dsh-hermes-channel)

## Overview

This plugin connects a DSH session to a locally configured **Hermes Feishu/Lark channel**.
It covers both directions:

1. **Agent → User**: send text, Markdown, and files via `hermes_channel_send`.
2. **User → Agent**: receive replies through a per-request `$flag`. Receiving
   requires **push** (`hermes_channel_push_start`), which injects each reply as a
   waking follow-up turn in the live session; `hermes_channel_consume` is only a
   manual one-shot read.

## First Contact (new session onboarding)

If you are an agent in a **fresh session** and this skill is in your catalog,
the plugin is already installed — the `hermes_channel_*` tools are callable
right now, nothing to install.

**Then follow "The Contract: four steps, in this order" below and finish with
`hermes_channel_status` before telling the user the channel is ready.** Do not
treat the push step as optional: a listener without a push loop captures
messages into a queue that nobody reads, which is indistinguishable from "the
channel is broken".

**Flag etiquette (important):** flags are per-session routing keys. Always
lease your OWN flag with `hermes_channel_register`; never reuse another
session's flag (two consumers on one flag eat each other's messages). If the
user gives you a flag that "belongs" to another session, confirm before
touching it. Release your flag with `hermes_channel_release` when the
conversation is done.

## Choosing a Flag (make it typeable)

The user types `$<flag> ` on **every** Feishu reply, so a flag must be
memorable and short — never a random string like `2b12jh`.

- `hermes_channel_register(agent_id: "x")` **assigns a word automatically**
  (e.g. `otter`, `quartz`, `topaz`) from a curated pool of short, unambiguous
  English words (animals, gems, trees, landscape, sky, objects).
- To pick the name yourself, pass `flag`:
  `hermes_channel_register(agent_id: "x", flag: "otter")`.
  Rules: 3–16 chars, lowercase letters/digits, must start with a letter;
  an invalid or already-leased name is rejected with a clear error.
- **Renaming**: calling register again with a different `flag` leases the new
  name, releases your previous lease, and retires your previous registration
  (the result lists them in `retired_flags`, and `hermes_channel_monitor` stops
  reporting the old flag). Complete the switch with `listen_start(new)` →
  `push_start(new)` (push_start replaces the session's previous push loop).
- Avoid names that look alike or are easy to mistype (`mu`/`nu`, `oak`/`okay`):
  prefer distinctive words such as `heron`, `amber`, `comet`.

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
| `hermes_channel_register` | Lease a unique reply flag — auto-assigns a memorable word, or pass `flag: "otter"` to choose; renaming releases the previous flag |
| `hermes_channel_listen_start` | Start the listener for a flag — IDEMPOTENT (adopts a running listener, kills duplicates, spawns only when none exists) **and arms push into this session by default** (`push: false` for listener-only) |
| `hermes_channel_listen_stop` | Stop every listener process for a flag (clears duplicates) |
| `hermes_channel_status` | Routing diagnosis: per flag — listener PIDs, queue depth, which session has push armed |
| `hermes_channel_consume` | One-shot read of pending replies (poll) |
| `hermes_channel_push_start` | Start real-time push into THIS session |
| `hermes_channel_push_stop` | Stop push for this session |
| `hermes_channel_monitor` | Health check: listener status, queue depth, recommended action |
| `hermes_channel_release` | Return a flag to the pool (also stops push) |

## The Contract: four steps, in this order

A channel is only half-built until **all four** steps are done. Steps 1–2 create
the plumbing; **step 3 is what actually delivers replies to you**; step 4 proves
it works. Skipping step 3 is the single most common failure — the listener keeps
capturing messages, they pile up in the queue, and the user sees nothing.

| # | Call | Done when |
|---|------|-----------|
| 1 | `hermes_channel_register(agent_id: "<name>")` | result has `flag` — a memorable word (or pass `flag: "otter"` to choose) |
| 2 | `hermes_channel_listen_start(flag)` | result has `pid` and `push: "armed into this session every Ns"` (this call arms push for you; `push: false` skips it) |
| 3 | `hermes_channel_send(message: "…reply with $<flag> …")` | result `success: true` — the user now knows which flag to use |
| 4 | `hermes_channel_status(flag)` | **verification**: `listeners` non-empty, `this_session_armed: true` |

Then, and only then, tell the user the channel is ready.

```
1. hermes_channel_register(agent_id: "<name>")     → { flag: "otter" }
2. hermes_channel_listen_start(flag: "otter")      → { pid: 1234, push: "armed into this session every 15s" }
3. hermes_channel_send(message: "…请回复 $otter …") → { success: true }
4. hermes_channel_status(flag: "otter")            → this_session_armed: true   ← gate
```

### Definition of done

The channel is ready **only if** `hermes_channel_status` reports for your flag:

- `listeners`: at least one PID — the capture side exists;
- `this_session_armed: true` — **the delivery side exists**;
- `queue_pending`: any number is fine (rows only leave after a delivered turn);
- `push_armed_by`: your own session id (nobody else's).

If `push_armed_by` names another session, or `this_session_armed` is false, the
channel is NOT ready: run `hermes_channel_push_start(flag)` in this session.

## Health Checks (run these, don't assume)

| When | Run | Look for |
|---|---|---|
| Right after setup | `hermes_channel_status(flag)` | `this_session_armed: true`, one listener |
| **After any DSH restart** | `hermes_channel_status(flag)` then `hermes_channel_push_start(flag)` if needed | push loops are **process-local** — a restart drops them while the listener survives, so replies silently stop arriving |
| Replies seem to go missing | `hermes_channel_status(flag)` | `push_armed_by: null` → nobody polls; `queue_pending` growing → messages are queued but never delivered |
| Listener health / staleness | `hermes_channel_monitor(flag)` | `recommended_action`; `restart_listener` also fires for a healthy quiet listener, so confirm with `hermes_channel_status` before restarting |
| Duplicate replies | count listeners for the flag | more than one PID → `hermes_channel_listen_stop(flag)` then `listen_start(flag)` |
| Replied but nothing arrived | `hermes_channel_consume(flag, mark_read: false)` | rows present = captured but not delivered (step 3 missing/stopped) |

Re-arm policy: **whenever this session restarts or `push_start` has not been
called since the last DSH start, call it again.** Re-arming is cheap and
idempotent; a missing push loop is invisible until the user notices silence.

## How Replies Are Routed (read this before debugging "wrong session")

Three separate pieces, and a reply only reaches you when **all three** line up:

| Piece | Scope | What it does |
|---|---|---|
| listener (`02_listen.py <flag>`) | per flag, one process | captures `$flag …` messages from the Feishu store into that flag's queue |
| queue | per flag | durable rows; a row leaves only when acked after a delivered turn |
| push loop | **per session, one flag at a time** | polls one flag's queue and injects batches into that session |

Consequences you must know:

- **A listener without a push loop delivers nothing.** Replying to `$flag` then
  looks like "the message went somewhere else" while it is actually sitting in
  the queue. `hermes_channel_listen_start` now arms push for you by default, and
  `hermes_channel_status` shows `push_armed_by: null` when nobody polls a flag.
- **One push loop per session**: calling `push_start` with a new flag replaces
  the previous one (the result reports `replaced`). A session cannot serve two
  flags at once — use one session per channel.
- **Two sessions on one flag** both inject the same replies; `push_start`
  reports a `warning` when it detects another live session already polling that
  flag.
- Both agents may still **send** into the same Feishu DM (same `chat_id`); that
  is normal and unrelated to routing — the flag, not the chat, decides which
  session receives a reply.

## Push Mode (the reason this plugin exists)

`hermes_channel_push_start` starts a per-session poll loop (default 15s,
minimum 5s — far below the native scheduler's 300s floor). Every user reply
lands in the session as a `[FEISHU CHANNEL MESSAGE BATCH]` user message that
wakes the agent even when idle. Treat that content as a direct user request.

Push requires the persistent listener for the same flag
(`hermes_channel_listen_start`). Check health with `hermes_channel_monitor`;
if `recommended_action` is `restart_listener`, start the listener again.

### Delivery semantics (at-least-once)

The push loop PEEKS the queue, injects the batch, then waits for the turn to
close:

- turn completed → the messages are acknowledged (`06_ack.py`) and leave the queue;
- turn failed with a transient provider error (`RATE_LIMIT`/`TIMEOUT`/`NETWORK`/
  server error) → nothing is acknowledged; the messages stay queued and are
  re-delivered after an exponential backoff (30s → 5min cap);
- while the session's last turn is a retryable provider failure, the loop waits
  instead of delivering, so a rate-limited model cannot swallow user replies.

Consequence: you may see the same batch twice after a failed turn — that is the
intended retry, not a duplicate bug. Manual `hermes_channel_consume` is
at-most-once by default (`mark_read: true`); pass `mark_read: false` to peek.

## Notes

- **Why channels silently stop working** (the two failure modes seen in
  practice): (a) the push loop was never armed — listener captures, queue grows,
  nobody delivers; (b) DSH restarted — push loops are process-local and vanish,
  while the detached listener survives, so everything looks healthy but is not.
  Both are invisible without `hermes_channel_status`; both are fixed by one
  `hermes_channel_push_start(flag)`.
- **One listener per flag is a hard invariant.** Two listeners on the same flag
  each capture the same underlying message and append it to the queue, so the
  user receives it twice (or N times). `hermes_channel_listen_start` enforces the
  invariant by scanning the host for `02_listen.py <flag>` processes: it adopts
  the newest, kills the rest, and spawns only when none exists — so calling it
  repeatedly (or from two sessions) is safe. Use `hermes_channel_listen_stop`
  to clear a flag's listeners completely.
- Delivery also dedupes by message id, so a batch never repeats content even if
  duplicate queue rows exist from an earlier stray listener.
- Queued messages expire after 1 hour (TTL in the pipeline) — a long provider
  outage can therefore outlive a queued reply.
- The listener is a detached process and survives plugin reloads; it dies with
  the host machine's restart and must then be restarted.
- `hermes_channel_monitor` may recommend `restart_listener` even for a healthy
  quiet listener (status files are shared across flags — known limitation).
- Auto-push for every session can be enabled via the `autoPushFlag` row config
  (not recommended: all sessions would share one flag; prefer per-session flags).
