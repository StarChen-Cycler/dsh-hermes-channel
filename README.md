# dsh-hermes-channel

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **bundle plugin** that
connects any agent session to a locally configured **Hermes Feishu/Lark channel**.

- **Agent → User**: send text, Markdown, and files to the user's Feishu/Lark DM.
- **User → Agent**: user replies carry a per-request `$flag`, captured by a
  persistent background listener into a durable queue.
- **Push mode**: a per-session loop polls the queue and injects each reply as a
  **waking follow-up turn** (`agent.followup`) — the Feishu message directly
  invokes work in the live session, with a configurable interval as low as 5
  seconds (the native in-session scheduler's floor is 300s).

No credentials, chat ids, or machine-specific paths are stored in this repo —
everything is configured at install time (see below).

## Requirements

- DSH ≥ 0.1.1-rc.2 (bundle profile plugins)
- [Hermes](https://github.com/) CLI + gateway running (`hermes gateway status`),
  with a configured Feishu/Lark channel
- Python 3.9+ (for the vendored pipeline scripts)
- Node ≥ 18

## Install

```bash
git clone <this-repo>
cd dsh-hermes-channel
npm run setup            # interactive: chat id, flags, binaries, hermes home
dsh plugin --profile <profile> add .
```

Restart the profile; every new root session then exposes the
`hermes_channel_*` tools and the `hermes-channel` skill.

## Configuration

All configuration lives in the composition row of `cordis.patch.yml`
(`npm run setup` edits it for you). Every key falls back to an environment
variable:

| config key | env var | default | meaning |
|---|---|---|---|
| `defaultChatId` | `HERMES_CHAT_ID` | — (required to send) | Feishu/Lark `oc_...` chat_id for outbound messages |
| `autoPushFlag` | `HERMES_CHANNEL_AUTOPUSH_FLAG` | off | auto-start push on this flag in every root session |
| `pushIntervalSeconds` | `HERMES_CHANNEL_PUSH_INTERVAL` | `15` | push poll interval (min 5) |
| `hermesBin` | `HERMES_BIN` | `hermes` | Hermes CLI executable |
| `pythonBin` | `HERMES_CHANNEL_PYTHON` | `python` | Python interpreter |
| `hermesHome` | `HERMES_HOME` | platform default | Hermes home dir containing `state.db` |

## Tools

| Tool | Purpose |
|------|---------|
| `hermes_channel_send` | Send text/Markdown/file to the user |
| `hermes_channel_register` | Lease a unique reply flag for this agent |
| `hermes_channel_listen_start` | Start the listener for a flag — IDEMPOTENT (adopts the running one, kills duplicates); optional `chat_id` |
| `hermes_channel_listen_stop` | Stop every listener process for a flag |
| `hermes_channel_consume` | One-shot read of pending replies |
| `hermes_channel_push_start` / `push_stop` | Real-time push into the session |
| `hermes_channel_monitor` | Listener health + recommended action |
| `hermes_channel_release` | Return a flag to the pool |

## Typical flow

```
hermes_channel_register(agent_id: "my-agent")      → flag "abc123"
hermes_channel_listen_start(flag: "abc123")
hermes_channel_send(message: "…请回复 $abc123 …")
hermes_channel_push_start(flag: "abc123")          # real-time mode
# …user replies in Feishu…  →  session wakes with the message
hermes_channel_release(flag: "abc123")
```

## Repository layout

```
.dsh-plugin/index.mjs     Node half (Cordis plugin; tools + push loop)
cordis.patch.yml          composition patch + the single configuration surface
pipeline/                 vendored Python pipeline (flag pool, listener, queue)
skills/hermes-channel/    bundled skill registered at runtime
scripts/setup.mjs         interactive configuration writer
```

## Notes & limitations

- Queued messages expire after 1 hour.
- **One listener per flag is a hard invariant.** Duplicate listeners each append
  the same message to the queue, and the user receives it N times.
  `hermes_channel_listen_start` is idempotent (scans the host for
  `02_listen.py <flag>` processes, adopts the newest, kills the rest, spawns
  only when none exists) and `hermes_channel_listen_stop` clears a flag
  completely. Delivery additionally dedupes batches by message id.
- The queue assumes a single consumer per flag (one push loop or manual
  consume); concurrent consumers on the same flag race on mark-read.
- Listener health files (`logs/02_listen/`) are shared across flags — run one
  listener per installation, or treat `hermes_channel_monitor` output as
  global to the pipeline.
- `hermes_channel_send` validates `media_path` (must be an existing file,
  no `..` segments) before attaching.
- The listener is a detached process; it survives plugin reloads but not OS
  restarts (use `hermes_channel_monitor` to detect and restart).
- Push loops are per live agent and are torn down when the agent or the plugin
  is disposed.

## License

MIT
