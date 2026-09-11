/**
 * dsh-hermes-channel — Hermes Feishu/Lark channel for DeepSeek Harness.
 *
 * Node half (full Cordis plugin, plain ESM, zero npm dependencies):
 *  - registers agent-scoped model tools (send / register / consume / release /
 *    monitor / listen_start / push_start / push_stop) on every root agent;
 *  - a per-agent push loop polls the durable channel queue and injects user
 *    replies as WAKING follow-up turns (agent.followup), so a Feishu message
 *    directly invokes work in the live session — no 5-minute scheduler needed.
 *
 * Configuration — every knob is set in the composition row (cordis.patch.yml),
 * each with an environment-variable fallback:
 *
 *   config key           env var                          default
 *   -------------------  --------------------------------  --------------------
 *   defaultChatId        HERMES_CHAT_ID                    "" (required to send)
 *   autoPushFlag         HERMES_CHANNEL_AUTOPUSH_FLAG      "" (no auto push)
 *   pushIntervalSeconds  HERMES_CHANNEL_PUSH_INTERVAL      15
 *   hermesBin            HERMES_BIN                        "hermes"
 *   pythonBin            HERMES_CHANNEL_PYTHON             "python"
 *   hermesHome           HERMES_HOME                       %LOCALAPPDATA%/hermes
 *
 * No credentials, chat ids, or machine paths are stored in this repo.
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.dirname(PACKAGE_DIR)
const PIPELINE = path.join(REPO_ROOT, 'pipeline', 'registered-agent-channel')
const FLAG_REGISTRY = path.join(REPO_ROOT, 'pipeline', 'feishu-flag-registry.json')

export const name = 'dsh-hermes-channel'
export const inject = ['agents', 'tools']

/** Resolved runtime configuration, populated by apply(). */
const RUNTIME = {
  defaultChatId: '',
  autoPushFlag: '',
  pushIntervalSeconds: 15,
  hermesBin: 'hermes',
  pythonBin: 'python',
  hermesHome: '',
}

/** Unconstrained-JSON tool output with a readable text rendering. */
const JSON_OUTPUT = {
  schema: {},
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

function schema(properties, required) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length > 0 ? { required } : {}) }
}

/** Environment handed to every child process (pipeline + hermes CLI). */
function childEnv() {
  const env = { ...process.env }
  if (RUNTIME.hermesHome) env.HERMES_HOME = RUNTIME.hermesHome
  if (RUNTIME.defaultChatId) env.HERMES_CHAT_ID = RUNTIME.defaultChatId
  env.HERMES_FLAG_REGISTRY = FLAG_REGISTRY
  return env
}

/** Run a foreground process; never rejects — errors resolve into the result. */
function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd: PIPELINE, env: childEnv() }, (error, stdout, stderr) => {
      resolve({
        exitCode: error == null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error == null ? null : String(error.message || error),
      })
    })
  })
}

async function runPipeline(script, args, timeoutMs = 30000) {
  const r = await run(RUNTIME.pythonBin, [path.join(PIPELINE, script), ...args], timeoutMs)
  // Pipeline scripts report structured JSON on stdout even for non-zero exits
  // (e.g. monitor on an unregistered flag) — prefer the payload when present.
  if (r.stdout.trim().length > 0) {
    try {
      const data = JSON.parse(r.stdout)
      if (r.exitCode !== 0 && data !== null && typeof data === 'object' && !Array.isArray(data)) data.exit_code = r.exitCode
      return data
    } catch (e) {
      if (r.exitCode === 0) return { raw: r.stdout, parse_error: String(e) }
    }
  }
  if (r.exitCode !== 0) return { error: r.stderr.trim() || r.error || `exit ${r.exitCode}`, exit_code: r.exitCode }
  return { error: 'pipeline produced empty output', exit_code: r.exitCode }
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-hermes-channel' },
  }
}

/** Per-agent push loops: agentId -> { flag, dispose }. */
const pushers = new Map()

function stopPush(agentId) {
  const entry = pushers.get(agentId)
  if (entry !== undefined) entry.dispose()
  pushers.delete(agentId)
}

/** The flag a live session currently polls, if any. */
function pusherFlag(agentId) {
  const entry = pushers.get(agentId)
  return entry === undefined ? undefined : entry.flag
}

/**
 * Find another session in this process that already polls a flag. Two live
 * sessions on one flag both inject the same replies — the exact failure that
 * looks like "both flags arrive in the same session".
 */
function otherPoller(ctx, excludeAgentId, flag) {
  for (const [agentId, entry] of pushers) {
    if (agentId === excludeAgentId) continue
    if (flag !== undefined && entry.flag !== flag) continue
    if (ctx.agents.get(agentId) === undefined) continue
    return { agentId, flag: entry.flag }
  }
  return undefined
}

/**
 * Read one agent's session event log across DSH versions.
 *
 * The session API changed shape: current builds expose `session.events` (a
 * frozen snapshot array, reused until the next append), while older builds
 * exposed `session.snapshotEvents()` / `session.ownEvents()`. Calling a method
 * that no longer exists threw, which made every delivery look unsettled and
 * produced an endless redelivery loop — so probe every known shape and never
 * assume one.
 *
 * @returns the event array, or undefined when no supported accessor exists.
 */
function sessionEvents(agent) {
  const session = agent?.session
  if (session === null || session === undefined) return undefined
  // Each accessor is probed independently: one throwing shape must not prevent
  // the next from being tried.
  const readers = [
    () => (typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : undefined),
    () => session.events,
    () => (typeof session.ownEvents === 'function' ? session.ownEvents() : undefined),
  ]
  for (const read of readers) {
    try {
      const events = read()
      if (Array.isArray(events)) return events
    } catch { /* try the next shape */ }
  }
  return undefined
}

/**
 * Count of `turn/end` events in the agent's own log (delivery baseline).
 * @returns the count, or -1 when the log cannot be observed at all.
 */
function turnEndCount(agent) {
  const events = sessionEvents(agent)
  if (events === undefined) return -1
  let count = 0
  for (const event of events) if (event.type === 'turn/end') count += 1
  return count
}

/** Leaf projection of the newest `turn/end` reason — never the live event object. */
function lastTurnEnd(agent) {
  return turnEndAt(agent, -1)
}

/**
 * Leaf projection of one `turn/end` reason by position.
 * `index >= 0` counts from the start (0 = first turn/end); `-1` = newest.
 * Reading the turn that closed *after* our delivery baseline avoids blaming a
 * concurrent UI turn's outcome on the delivered batch.
 */
function turnEndAt(agent, index) {
  const events = sessionEvents(agent)
  if (events === undefined) return undefined
  if (index < 0) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'turn/end') continue
      return projectTurnEnd(event)
    }
    return undefined
  }
  let seen = 0
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    if (seen === index) return projectTurnEnd(event)
    seen += 1
  }
  return undefined
}

/** Scalar-only projection of one turn/end event. */
function projectTurnEnd(event) {
  const reason = event.data?.reason
  return {
    kind: typeof reason?.kind === 'string' ? reason.kind : 'unknown',
    code: typeof reason?.error?.code === 'string' ? reason.error.code : '',
    message: typeof reason?.error?.message === 'string' ? reason.error.message.slice(0, 200) : '',
  }
}

/**
 * Provider-transient failure codes, mirroring the harness's own llm-retry
 * default policy (@deepseek-ai/dsh-llm retry-policy DEFAULT_RETRYABLE_CODES).
 * Anything else — including an error with no code at all — means the turn DID
 * run and the batch was seen, so it must be acknowledged instead of re-injected.
 * Treating unknown codes as retryable caused an endless redelivery loop.
 */
const RETRYABLE_FAILURE_CODES = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

/** How many times one batch may be re-injected before it is acknowledged anyway. */
const MAX_DELIVERY_ATTEMPTS = 3

/** Whether a failed turn looks like a transient provider problem worth retrying. */
function isRetryableFailure(end) {
  if (end === undefined) return false
  if (end.kind !== 'error') return false
  return RETRYABLE_FAILURE_CODES.has(end.code)
}

/** Wait for a NEW turn/end beyond the baseline count, bounded by a timeout. */
function waitForTurnEnd(agent, baselineCount, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const count = turnEndCount(agent)
      if (count < 0) return resolve(false)
      if (count > baselineCount) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, 500)
    }
    setTimeout(tick, 250)
  })
}

function startPush(ctx, agent, flag, intervalSeconds) {
  stopPush(agent.id)
  const seconds = Number.isFinite(Number(intervalSeconds)) ? Math.round(Number(intervalSeconds)) : RUNTIME.pushIntervalSeconds
  const intervalMs = Math.max(5, seconds) * 1000
  let polling = false
  let inflight = false
  let backoffUntil = 0
  let consecutiveFailures = 0
  /** batch key -> deliveries already attempted for it (bounded by MAX_DELIVERY_ATTEMPTS) */
  const deliveryAttempts = new Map()

  const pollOnce = async () => {
    if (polling || inflight || !pushers.has(agent.id)) return
    if (Date.now() < backoffUntil) return
    polling = true
    try {
      if (ctx.agents.get(agent.id) !== agent) {
        stopPush(agent.id)
        return
      }
      // PEEK only: nothing is acknowledged until the delivered turn succeeds.
      const data = await runPipeline('03_consume.py', [flag])
      if (data === null || typeof data !== 'object' || !Array.isArray(data.messages) || data.messages.length === 0) {
        consecutiveFailures = 0
        return
      }
      // Dedupe by message id: several listeners on one flag would append the
      // same state.db message repeatedly, and each row must still be acked.
      const seen = new Map()
      for (const message of data.messages) {
        const id = Number(message.id)
        if (!seen.has(id)) seen.set(id, message)
      }
      const batch = [...seen.values()]
      const ids = [...seen.keys()].filter((id) => Number.isFinite(id))
      // Attempt bookkeeping: a batch that keeps failing must not be re-injected
      // forever, and the receiving agent should see which attempt this is.
      const key = ids.join(',')
      const attempt = (deliveryAttempts.get(key) ?? 0) + 1
      // If the session's own last turn died on a provider error, the model is
      // still unavailable — keep the messages queued and retry after a backoff
      // instead of burning a delivery attempt.
      const prior = lastTurnEnd(agent)
      if (isRetryableFailure(prior)) {
        consecutiveFailures += 1
        backoffUntil = Date.now() + Math.min(30_000 * consecutiveFailures, 300_000)
        ctx.logger.warn(`hermes-channel: provider unavailable (${prior.code || prior.kind}); keeping ${data.messages.length} message(s) queued, retry in ${Math.round((backoffUntil - Date.now()) / 1000)}s`)
        return
      }
      const lines = batch.map((m) => {
        const ts = Number(m.timestamp ?? m.ts ?? 0)
        const when = ts > 0 ? new Date(ts * 1000).toISOString() : 'unknown-time'
        const files = Array.isArray(m.file_paths) && m.file_paths.length > 0 ? ` [files: ${m.file_paths.join(', ')}]` : ''
        return `- (${when}) ${String(m.content)}${files}`
      })
      const retryMark = attempt > 1 ? ` — RETRY ${attempt}/${MAX_DELIVERY_ATTEMPTS} of the SAME batch; do not repeat work already done` : ''
      const text = `[FEISHU CHANNEL MESSAGE BATCH${retryMark}]\n`
        + `The user sent the following ${batch.length} message(s) via the Feishu channel (flag $${flag}). `
        + 'Treat their content as a direct user request: act on it in this session, and briefly acknowledge in your reply.\n'
        + lines.join('\n')
      const baseline = turnEndCount(agent)
      inflight = true
      try {
        agent.followup(makeUserMessage(text))
      } catch (error) {
        inflight = false
        // Delivery never started: keep the messages queued, but do not spin —
        // a followup that throws synchronously is usually a transient state.
        consecutiveFailures += 1
        backoffUntil = Date.now() + Math.min(30_000 * consecutiveFailures, 300_000)
        ctx.logger.warn(`hermes-channel: followup failed for $${flag}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      ctx.logger.info(`hermes-channel: delivered ${data.messages.length} message(s) to agent ${agent.id}; awaiting turn result`)
      // Confirm the delivery: ack only after the turn opened by this delivery closes.
      void (async () => {
        try {
          const observable = baseline >= 0
          const settled = await waitForTurnEnd(agent, baseline, 600_000)
          // The turn that closed right after the baseline is ours; the newest
          // turn/end could belong to a concurrent UI turn.
          const end = settled && observable ? turnEndAt(agent, baseline) : lastTurnEnd(agent)
          const ack = async () => {
            if (ids.length > 0) await runPipeline('06_ack.py', [flag, ...ids.map(String)])
            deliveryAttempts.delete(key)
            consecutiveFailures = 0
            backoffUntil = 0
          }
          if (!observable) {
            // The session log could not be read at all (unsupported API shape).
            // Acknowledge instead of looping: an unobservable outcome must never
            // turn into an endless redelivery of the same batch.
            await ack()
            ctx.logger.warn(`hermes-channel: session events are unobservable for ${agent.id}; acknowledged ${ids.length} message(s) for $${flag} to avoid a redelivery loop`)
          } else if (ids.length === 0) {
            // Nothing could ever be acknowledged; count it against the delivery
            // cap so it cannot spin forever, and never claim success.
            deliveryAttempts.set(key, attempt)
            consecutiveFailures += 1
            backoffUntil = Date.now() + Math.min(30_000 * consecutiveFailures, 300_000)
            ctx.logger.warn(`hermes-channel: batch for $${flag} carried no numeric message ids (attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS}); leaving it queued`)
          } else if (settled && !isRetryableFailure(end)) {
            await ack()
            ctx.logger.info(`hermes-channel: acked ${ids.length} message(s) for $${flag} (turn ${end?.kind ?? 'unknown'}${end?.code ? '/' + end.code : ''})`)
          } else if (attempt >= MAX_DELIVERY_ATTEMPTS) {
            // The batch was delivered but its turns keep failing for a reason we
            // cannot fix by re-injecting. Stop the loop: acknowledge it, tell the
            // user once, and leave the transcript as the record.
            await ack()
            ctx.logger.warn(`hermes-channel: giving up after ${attempt} deliveries for $${flag} (${end?.kind ?? 'no turn-end'}${end?.code ? '/' + end.code : ''}); batch acknowledged to stop the redelivery loop`)
            try {
              const chatId = RUNTIME.defaultChatId
              if (chatId) {
                await run(RUNTIME.hermesBin, ['send', '--to', `feishu:${chatId}`,
                  `⚠️ 你的 ${ids.length} 条消息已送达会话，但处理它们的轮次连续 ${attempt} 次未成功结束（${end?.kind ?? 'unknown'}${end?.code ? '/' + end.code : ''}）。我不会再重复投递；如果还需要处理，请重新发送。`], 60000)
              }
            } catch { /* best effort */ }
          } else {
            deliveryAttempts.set(key, attempt)
            consecutiveFailures += 1
            backoffUntil = Date.now() + Math.min(30_000 * consecutiveFailures, 300_000)
            ctx.logger.warn(`hermes-channel: turn did not complete (${end?.kind ?? 'no turn-end'}${end?.code ? '/' + end.code : ''}); ${ids.length} message(s) stay queued, retry ${attempt + 1}/${MAX_DELIVERY_ATTEMPTS} in ${Math.round((backoffUntil - Date.now()) / 1000)}s`)
          }
        } catch (error) {
          ctx.logger.warn(`hermes-channel: delivery confirmation failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          inflight = false
        }
      })()
    } catch (error) {
      ctx.logger.warn(`hermes-channel: poll failed for $${flag}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => { void pollOnce() }, intervalMs)
  pushers.set(agent.id, { flag, dispose: () => clearInterval(timer) })
  return { flag, interval_seconds: Math.max(5, seconds) }
}

/**
 * Listener bookkeeping is keyed by flag and backed by a real process scan:
 * `listen_start` must be idempotent, because a second listener on the same flag
 * appends every captured message to the queue again (duplicate delivery), while
 * a stale PID record alone cannot prove the process is gone.
 */
const listeners = new Map()

/** Scan the OS for `02_listen.py <flag>` processes; newest first. */
function scanListeners() {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const command = isWindows ? 'powershell' : 'ps'
    const args = isWindows
      ? ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Where-Object { $_.CommandLine -like '*02_listen.py*' } | ForEach-Object { \"$($_.ProcessId)|$([int]((Get-Date) - $_.CreationDate).TotalSeconds)|$($_.CommandLine)\" }"]
      : ['-eo', 'pid=,etimes=,args=']
    execFile(command, args, { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      const found = []
      for (const raw of String(stdout ?? '').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line.includes('02_listen.py')) continue
        const parts = line.split('|')
        let pid
        let ageSeconds
        let cmdline
        if (isWindows && parts.length >= 3) {
          pid = Number(parts[0].trim())
          ageSeconds = Number(parts[1].trim())
          cmdline = parts.slice(2).join('|')
        } else {
          const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line)
          if (match === null) continue
          pid = Number(match[1])
          ageSeconds = Number(match[2])
          cmdline = match[3]
        }
        const flagMatch = /02_listen\.py\s+(\S+)/.exec(cmdline ?? '')
        if (!Number.isFinite(pid) || flagMatch === null) continue
        found.push({ pid, flag: flagMatch[1], ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : Number.MAX_SAFE_INTEGER })
      }
      found.sort((left, right) => left.ageSeconds - right.ageSeconds)
      resolve(found)
    })
  })
}

function killProcess(pid) {
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    if (process.platform !== 'win32') return false
    try {
      execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => {})
      return true
    } catch {
      return false
    }
  }
}

/**
 * Idempotent listener start: adopt the newest live listener for the flag, kill
 * any duplicates, and spawn one only when none exists.
 */
async function ensureListener(flag, chatId) {
  const scanned = await scanListeners()
  const mine = scanned.filter((entry) => entry.flag === flag)
  const [newest, ...duplicates] = mine
  const killed = []
  for (const duplicate of duplicates) {
    if (killProcess(duplicate.pid)) killed.push(duplicate.pid)
  }
  if (newest !== undefined) {
    listeners.set(flag, { pid: newest.pid, adopted: true })
    return { pid: newest.pid, reused: true, killed_duplicates: killed }
  }
  const child = spawn(RUNTIME.pythonBin, [path.join(PIPELINE, '02_listen.py'), flag, '--chat-id', chatId], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PIPELINE,
    env: childEnv(),
  })
  child.unref()
  listeners.set(flag, { pid: child.pid, child, adopted: false })
  child.on('exit', () => {
    const entry = listeners.get(flag)
    if (entry !== undefined && entry.child === child) listeners.delete(flag)
  })
  return { pid: child.pid, reused: false, killed_duplicates: killed }
}

/** Stop every listener process for a flag (tracked and discovered). */
async function stopListeners(flag) {
  const tracked = listeners.get(flag)
  listeners.delete(flag)
  const scanned = (await scanListeners()).filter((entry) => entry.flag === flag)
  const pids = new Set(scanned.map((entry) => entry.pid))
  if (tracked?.pid !== undefined) pids.add(tracked.pid)
  const killed = []
  for (const pid of pids) if (killProcess(pid)) killed.push(pid)
  return killed
}

function registerChannelTools(ctx, agent) {
  const disposers = []
  const register = (definition) => disposers.push(agent.ctx.tools.register(definition))

  register({
    name: 'hermes_channel_send',
    description: 'Send a message to the user through the Hermes Feishu/Lark channel. '
      + 'To receive a reply, include the flag in the text and ask the user to reply with "$<flag> ...". '
      + 'When the user asks to send a document or file, DEFAULT to media_path (transfer the file itself); '
      + 'only paste file contents into message when the user explicitly wants the content as chat text.',
    parameters: schema({
      message: { type: 'string', description: 'Text to send (Markdown supported)' },
      chat_id: { type: 'string', description: 'Target chat_id (default: configured defaultChatId)' },
      media_path: { type: 'string', description: 'Local file path to attach. PREFERRED way to send documents/files — pass the file itself instead of pasting its content into message.' },
    }, ['message']),
    output: JSON_OUTPUT,
    async execute(args) {
      const chatId = args.chat_id || RUNTIME.defaultChatId
      if (!chatId) return { error: 'no chat_id given and no defaultChatId configured (see cordis.patch.yml / HERMES_CHAT_ID)' }
      let mediaPath = ''
      if (args.media_path) {
        const resolved = path.resolve(String(args.media_path))
        if (String(args.media_path).includes('..')) return { error: 'media_path must not contain ".."' }
        if (!existsSync(resolved) || !statSync(resolved).isFile()) return { error: `media_path not found or not a file: ${resolved}` }
        mediaPath = resolved
      }
      const text = mediaPath ? `${args.message} MEDIA:${mediaPath}` : args.message
      const r = await run(RUNTIME.hermesBin, ['send', '--to', `feishu:${chatId}`, String(text)], 60000)
      if (r.exitCode !== 0) return { error: r.stderr.trim() || r.error || 'hermes send failed', exit_code: r.exitCode }
      return { success: true, stdout: r.stdout.trim() }
    },
  })

  register({
    name: 'hermes_channel_register',
    description: 'Register this agent for the Feishu channel and lease a unique reply flag. '
      + 'By default a short memorable WORD is assigned (e.g. "otter", "quartz") because the user '
      + 'must type "$<flag> " on every Feishu reply — avoid random strings. Pass "flag" to request '
      + 'a specific name (3-16 lowercase letters/digits, starting with a letter); registering again '
      + 'with a different name RENAMES: the previous flag is released and its registration retired '
      + '(listed in retired_flags).',
    parameters: schema({
      agent_id: { type: 'string', description: 'Identifier for this agent or request' },
      flag: { type: 'string', description: 'Preferred memorable flag name, e.g. "otter" (optional; a free word is assigned when omitted or taken)' },
    }, ['agent_id']),
    output: JSON_OUTPUT,
    async execute(args) {
      const cmdArgs = [String(args.agent_id)]
      if (typeof args.flag === 'string' && args.flag.length > 0) cmdArgs.push('--flag', String(args.flag))
      return runPipeline('01_register.py', cmdArgs)
    },
  })

  register({
    name: 'hermes_channel_consume',
    description: 'Read pending user replies from the Hermes Feishu channel queue for a flag.',
    parameters: schema({
      flag: { type: 'string', description: 'The per-request flag (e.g. "a3brjx")' },
      mark_read: { type: 'boolean', description: 'Mark returned messages as read (default: true)' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      const cmdArgs = [String(args.flag)]
      if (args.mark_read !== false) cmdArgs.push('--mark-read')
      return runPipeline('03_consume.py', cmdArgs)
    },
  })

  register({
    name: 'hermes_channel_release',
    description: 'Close a channel: stop this session\'s push loop, stop every listener process for the flag, '
      + 'and return the flag to the pool. Releasing without stopping the listener used to leave a process '
      + 'capturing into a queue nobody would ever read.',
    parameters: schema({
      flag: { type: 'string', description: 'The flag to release' },
      keep_listener: { type: 'boolean', description: 'Keep the listener running (default: false — releasing closes the channel)' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      const flag = String(args.flag)
      const wasPolling = pusherFlag(agent.id)
      stopPush(agent.id)
      let killed = []
      if (args.keep_listener !== true) {
        try {
          killed = await stopListeners(flag)
        } catch { /* best effort: releasing the flag still matters */ }
      }
      const released = await runPipeline('04_release.py', [flag])
      return {
        ...(released !== null && typeof released === 'object' && !Array.isArray(released) ? released : { release: released }),
        stopped_push: wasPolling === flag,
        killed_listeners: killed,
      }
    },
  })

  register({
    name: 'hermes_channel_monitor',
    description: 'Health-check the persistent listener for a flag: registered/active state, '
      + 'listener status, queue depth, and a recommended_action (none / restart_listener / register_new).',
    parameters: schema({
      flag: { type: 'string', description: 'The flag to check' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      return runPipeline('05_check_monitor.py', [String(args.flag)])
    },
  })

  register({
    name: 'hermes_channel_listen_start',
    description: 'Start the persistent background listener for a flag (detached; survives plugin reloads). '
      + 'IDEMPOTENT: it adopts the newest listener already running for that flag and kills any duplicates, '
      + 'spawning a new process only when none exists — repeated calls are safe and never duplicate delivery. '
      + 'The listener alone does NOT deliver anything: that is the push loop. Because forgetting it is silent, '
      + 'this tool ALSO arms push for the calling session by default (pass push:false for listener-only).',
    parameters: schema({
      flag: { type: 'string', description: 'The flag to listen on' },
      chat_id: { type: 'string', description: 'Feishu chat_id to listen on (default: configured defaultChatId)' },
      push: { type: 'boolean', description: 'Also arm push into this session (default: true). Set false for listener-only.' },
      interval_seconds: { type: 'number', description: 'Push poll interval in seconds when push is armed (default: configured pushIntervalSeconds, minimum: 5)' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      const flag = String(args.flag)
      const chatId = args.chat_id || RUNTIME.defaultChatId
      if (!chatId) {
        return { error: 'no chat_id given and no defaultChatId configured (see cordis.patch.yml / HERMES_CHAT_ID); the listener would fail its session gate' }
      }
      try {
        const result = await ensureListener(flag, String(chatId))
        const payload = {
          success: true,
          flag,
          pid: result.pid,
          chat_id: chatId,
          reused: result.reused,
          killed_duplicates: result.killed_duplicates,
        }
        if (args.push === false) {
          payload.push = 'not armed (push:false) — replies will queue until hermes_channel_push_start is called'
          return payload
        }
        const interval = Math.max(5, Number(args.interval_seconds) || RUNTIME.pushIntervalSeconds)
        const state = startPush(ctx, agent, flag, interval)
        payload.push = `armed into this session every ${state.interval_seconds}s`
        const other = otherPoller(ctx, agent.id)
        if (other !== undefined && other.flag === flag) {
          payload.warning = `another live session (${other.agentId}) already polls $${flag}; replies will be delivered to whichever session armed it last`
        }
        return payload
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : error) }
      }
    },
  })

  register({
    name: 'hermes_channel_status',
    description: 'Diagnose channel routing for every flag you care about: which flags have a listener running, '
      + 'how many queue rows are pending, and which live session (if any) has a push loop armed. '
      + 'Use this when replies seem to go missing or to the wrong session.',
    parameters: schema({
      flag: { type: 'string', description: 'Check one flag (omit to list every flag with a queue or listener)' },
    }, []),
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const listenersNow = await scanListeners()
        const want = typeof args.flag === 'string' && args.flag.length > 0 ? String(args.flag) : undefined
        const flags = new Set()
        for (const entry of listenersNow) flags.add(entry.flag)
        for (const key of pushers.keys()) {
          const bound = pusherFlag(key)
          if (bound !== undefined) flags.add(bound)
        }
        const inspected = want !== undefined ? [want] : [...flags]
        const rows = []
        for (const flag of inspected) {
          const queue = await runPipeline('03_consume.py', [flag])
          const pending = queue !== null && typeof queue === 'object' && Array.isArray(queue.messages) ? queue.messages.length : null
          const poller = otherPoller(ctx, undefined, flag)
          rows.push({
            flag,
            listeners: listenersNow.filter((entry) => entry.flag === flag).map((entry) => entry.pid),
            queue_pending: pending,
            push_armed_by: poller === undefined ? null : poller.agentId,
            this_session_armed: pusherFlag(agent.id) === flag,
          })
        }
        return { success: true, rows }
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : String(error)) }
      }
    },
  })

  register({
    name: 'hermes_channel_listen_stop',
    description: 'Stop every background listener process serving a flag (tracked and discovered on the host). '
      + 'Use this to clear duplicate consumers left behind by earlier starts.',
    parameters: schema({
      flag: { type: 'string', description: 'The flag whose listeners should be stopped' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const killed = await stopListeners(String(args.flag))
        return { success: true, killed }
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : error) }
      }
    },
  })

  register({
    name: 'hermes_channel_push_start',
    description: 'Start pushing Feishu channel replies for a flag directly into THIS session as waking '
      + 'follow-up turns. Every user reply is injected as a user message that invokes work here, '
      + 'even while the session is idle. Delivery is at-least-once: a reply is only acknowledged after '
      + 'its turn completes, so provider rate limiting or a transient failure leaves it queued for retry. '
      + 'Requires the persistent listener (hermes_channel_listen_start).',
    parameters: schema({
      flag: { type: 'string', description: 'The channel flag assigned at registration' },
      interval_seconds: { type: 'number', description: 'Poll interval in seconds (default: configured pushIntervalSeconds, minimum: 5)' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      const interval = Math.max(5, Number(args.interval_seconds) || RUNTIME.pushIntervalSeconds)
      const flag = String(args.flag)
      const previous = pusherFlag(agent.id)
      const state = startPush(ctx, agent, flag, interval)
      const payload = {
        success: true,
        flag: state.flag,
        agent_id: agent.id,
        interval_seconds: state.interval_seconds,
        note: `Feishu replies prefixed with $${state.flag} will now be pushed into this session automatically.`,
      }
      if (previous !== undefined && previous !== flag) {
        payload.replaced = `this session stopped polling $${previous} (one push loop per session)`
      }
      const other = otherPoller(ctx, agent.id, flag)
      if (other !== undefined) {
        payload.warning = `another live session (${other.agentId}) also polls $${flag}; both will inject the same replies — use distinct flags per session`
      }
      return payload
    },
  })

  register({
    name: 'hermes_channel_push_stop',
    description: 'Stop pushing Feishu channel replies into this session.',
    parameters: schema({}, []),
    output: JSON_OUTPUT,
    async execute() {
      const wasRunning = pushers.has(agent.id)
      stopPush(agent.id)
      return { success: true, was_running: wasRunning }
    },
  })

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

function registerBundledSkill(ctx) {
  const skills = ctx.get('skills')
  if (skills === undefined) return
  try {
    const raw = readFileSync(path.join(REPO_ROOT, 'skills', 'hermes-channel', 'SKILL.md'), 'utf8')
    const content = raw.replace(/^---\n[\s\S]*?\n---\n/, '')
    ctx.effect(() => skills.register({
      name: 'hermes-channel',
      description: 'Use the Hermes Feishu/Lark channel to talk to the user outside the chat UI: '
        + 'send messages/files, lease reply flags, run the persistent listener, and push replies '
        + 'into the live session as waking turns.',
      whenToUse: 'When the agent needs to reach the user via Feishu/Lark, wait for replies via $flag, '
        + 'or enable real-time push of channel messages into the session.',
      source: 'bundled',
      content,
    }))
  } catch (error) {
    ctx.logger.warn(`hermes-channel: bundled skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function pickString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

export function apply(ctx, config) {
  // Row config arrives as apply's SECOND argument (cordis loader contract;
  // see @deepseek-ai/dsh-time-context). Neither ctx.config nor a 'config'
  // service exists — both are blocked/absent.
  const cfg = (config !== null && typeof config === 'object') ? config : {}
  RUNTIME.defaultChatId = pickString(cfg.defaultChatId, process.env.HERMES_CHAT_ID || '')
  RUNTIME.autoPushFlag = pickString(cfg.autoPushFlag, process.env.HERMES_CHANNEL_AUTOPUSH_FLAG || '')
  RUNTIME.pushIntervalSeconds = Number(cfg.pushIntervalSeconds) || Number(process.env.HERMES_CHANNEL_PUSH_INTERVAL) || 15
  RUNTIME.hermesBin = pickString(cfg.hermesBin, process.env.HERMES_BIN || 'hermes')
  RUNTIME.pythonBin = pickString(cfg.pythonBin, process.env.HERMES_CHANNEL_PYTHON || 'python')
  RUNTIME.hermesHome = pickString(cfg.hermesHome, process.env.HERMES_HOME || '')

  registerBundledSkill(ctx)

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      agent.ctx.effect(() => {
        const disposeTools = registerChannelTools(ctx, agent)
        if (RUNTIME.autoPushFlag.length > 0) startPush(ctx, agent, RUNTIME.autoPushFlag, RUNTIME.pushIntervalSeconds)
        return () => {
          disposeTools()
          stopPush(agent.id)
        }
      }, 'hermes-channel.agent()')
    })
    return () => {
      stopCreated()
      for (const id of [...pushers.keys()]) stopPush(id)
    }
  }, 'hermes-channel.lifecycle()')
}
