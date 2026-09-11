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

/** Per-agent push loops, keyed for teardown. Listener state lives near its helpers. */
const pushers = new Map()

function stopPush(agentId) {
  const dispose = pushers.get(agentId)
  if (dispose !== undefined) dispose()
  pushers.delete(agentId)
}

/** Count of `turn/end` events in the agent's own log (delivery confirmation baseline). */
function turnEndCount(agent) {
  try {
    const events = agent.session.snapshotEvents()
    let count = 0
    for (const event of events) if (event.type === 'turn/end') count += 1
    return count
  } catch {
    return -1
  }
}

/** Leaf projection of the newest `turn/end` reason — never the live event object. */
function lastTurnEnd(agent) {
  try {
    const events = agent.session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'turn/end') continue
      const reason = event.data.reason
      return {
        kind: typeof reason?.kind === 'string' ? reason.kind : 'unknown',
        code: typeof reason?.error?.code === 'string' ? reason.error.code : '',
        message: typeof reason?.error?.message === 'string' ? reason.error.message.slice(0, 200) : '',
      }
    }
  } catch { /* fall through */ }
  return undefined
}

/** Whether a failed turn looks like a transient provider problem worth retrying. */
function isRetryableFailure(end) {
  if (end === undefined) return false
  if (end.kind !== 'error') return false
  return end.code === 'RATE_LIMIT' || end.code === 'TIMEOUT' || end.code === 'NETWORK'
    || end.code === 'SERVER_ERROR' || end.code === 'OVERLOADED' || end.code === ''
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
      const text = '[FEISHU CHANNEL MESSAGE BATCH]\n'
        + `The user sent the following ${batch.length} message(s) via the Feishu channel (flag $${flag}). `
        + 'Treat their content as a direct user request: act on it in this session, and briefly acknowledge in your reply.\n'
        + lines.join('\n')
      const baseline = turnEndCount(agent)
      inflight = true
      try {
        agent.followup(makeUserMessage(text))
      } catch (error) {
        inflight = false
        ctx.logger.warn(`hermes-channel: followup failed for $${flag}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      ctx.logger.info(`hermes-channel: delivered ${data.messages.length} message(s) to agent ${agent.id}; awaiting turn result`)
      // Confirm the delivery: ack only after a turn actually closed successfully.
      void (async () => {
        try {
          const settled = await waitForTurnEnd(agent, baseline, 600_000)
          const end = lastTurnEnd(agent)
          if (settled && !isRetryableFailure(end)) {
            if (ids.length > 0) await runPipeline('06_ack.py', [flag, ...ids.map(String)])
            consecutiveFailures = 0
            backoffUntil = 0
            ctx.logger.info(`hermes-channel: acked ${ids.length} message(s) for $${flag} (turn ${end?.kind ?? 'unknown'})`)
          } else {
            consecutiveFailures += 1
            backoffUntil = Date.now() + Math.min(30_000 * consecutiveFailures, 300_000)
            ctx.logger.warn(`hermes-channel: turn did not complete (${end?.kind ?? 'no turn-end'}${end?.code ? '/' + end.code : ''}); ${ids.length} message(s) stay queued, retry in ${Math.round((backoffUntil - Date.now()) / 1000)}s`)
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
  pushers.set(agent.id, () => clearInterval(timer))
  return { flag, interval_seconds: Math.max(5, seconds) }
}

/**
 * Listener bookkeeping is keyed by flag and backed by a real process scan:
 * `listen_start` must be idempotent, because a second listener on the same flag
 * appends every captured message to the queue again (duplicate delivery), while
 * a stale PID record alone cannot prove the process is gone.
 */
const listeners = new Map()

function listenerCommand(flag) {
  return `02_listen.py ${flag}`
}

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
      + 'a specific name (3-16 lowercase letters/digits, starting with a letter).',
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
    description: 'Release a channel flag back to the pool when the conversation is done.',
    parameters: schema({
      flag: { type: 'string', description: 'The flag to release' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      stopPush(agent.id)
      return runPipeline('04_release.py', [String(args.flag)])
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
      + 'spawning a new process only when none exists — repeated calls are safe and never duplicate delivery.',
    parameters: schema({
      flag: { type: 'string', description: 'The flag to listen on' },
      chat_id: { type: 'string', description: 'Feishu chat_id to listen on (default: configured defaultChatId)' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      const chatId = args.chat_id || RUNTIME.defaultChatId
      if (!chatId) {
        return { error: 'no chat_id given and no defaultChatId configured (see cordis.patch.yml / HERMES_CHAT_ID); the listener would fail its session gate' }
      }
      try {
        const result = await ensureListener(String(args.flag), String(chatId))
        return { success: true, pid: result.pid, chat_id: chatId, reused: result.reused, killed_duplicates: result.killed_duplicates }
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : error) }
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
      const state = startPush(ctx, agent, String(args.flag), interval)
      return {
        success: true,
        flag: state.flag,
        agent_id: agent.id,
        interval_seconds: state.interval_seconds,
        note: `Feishu replies prefixed with $${state.flag} will now be pushed into this session automatically.`,
      }
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
