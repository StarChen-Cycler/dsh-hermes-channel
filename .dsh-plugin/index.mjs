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

/** Per-agent push loops and detached listener processes, keyed for teardown. */
const pushers = new Map()
const listeners = new Set()

function stopPush(agentId) {
  const dispose = pushers.get(agentId)
  if (dispose !== undefined) dispose()
  pushers.delete(agentId)
}

function startPush(ctx, agent, flag, intervalSeconds) {
  stopPush(agent.id)
  const seconds = Number.isFinite(Number(intervalSeconds)) ? Math.round(Number(intervalSeconds)) : RUNTIME.pushIntervalSeconds
  const intervalMs = Math.max(5, seconds) * 1000
  let polling = false
  const pollOnce = async () => {
    if (polling || !pushers.has(agent.id)) return
    polling = true
    try {
      if (ctx.agents.get(agent.id) !== agent) {
        stopPush(agent.id)
        return
      }
      const data = await runPipeline('03_consume.py', [flag, '--mark-read'])
      if (data === null || typeof data !== 'object' || !Array.isArray(data.messages) || data.messages.length === 0) return
      const lines = data.messages.map((m) => {
        const ts = Number(m.timestamp ?? m.ts ?? 0)
        const when = ts > 0 ? new Date(ts * 1000).toISOString() : 'unknown-time'
        const files = Array.isArray(m.file_paths) && m.file_paths.length > 0 ? ` [files: ${m.file_paths.join(', ')}]` : ''
        return `- (${when}) ${String(m.content)}${files}`
      })
      const text = '[FEISHU CHANNEL MESSAGE BATCH]\n'
        + `The user sent the following ${data.messages.length} message(s) via the Feishu channel (flag $${flag}). `
        + 'Treat their content as a direct user request: act on it in this session, and briefly acknowledge in your reply.\n'
        + lines.join('\n')
      agent.followup(makeUserMessage(text))
      ctx.logger.info(`hermes-channel: pushed ${data.messages.length} message(s) to agent ${agent.id}`)
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

function ensureListener(flag) {
  const child = spawn(RUNTIME.pythonBin, [path.join(PIPELINE, '02_listen.py'), flag], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: PIPELINE,
    env: childEnv(),
  })
  child.unref()
  listeners.add(child)
  child.on('exit', () => listeners.delete(child))
  return child.pid
}

function registerChannelTools(ctx, agent) {
  const disposers = []
  const register = (definition) => disposers.push(agent.ctx.tools.register(definition))

  register({
    name: 'hermes_channel_send',
    description: 'Send a message to the user through the Hermes Feishu/Lark channel. '
      + 'To receive a reply, include the flag in the text and ask the user to reply with "$<flag> ...".',
    parameters: schema({
      message: { type: 'string', description: 'Text to send (Markdown supported)' },
      chat_id: { type: 'string', description: 'Target chat_id (default: configured defaultChatId)' },
      media_path: { type: 'string', description: 'Optional local file path to attach' },
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
    description: 'Register this agent for the Feishu channel with a unique flag. '
      + 'Returns the flag that the user should prefix replies with (e.g. "$abc123").',
    parameters: schema({
      agent_id: { type: 'string', description: 'Identifier for this agent or request' },
    }, ['agent_id']),
    output: JSON_OUTPUT,
    async execute(args) {
      return runPipeline('01_register.py', [String(args.agent_id)])
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
      + 'Idempotent-ish: check hermes_channel_monitor first to avoid duplicates.',
    parameters: schema({
      flag: { type: 'string', description: 'The flag to listen on' },
    }, ['flag']),
    output: JSON_OUTPUT,
    async execute(args) {
      try {
        const pid = ensureListener(String(args.flag))
        return { success: true, pid }
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : error) }
      }
    },
  })

  register({
    name: 'hermes_channel_push_start',
    description: 'Start pushing Feishu channel replies for a flag directly into THIS session as waking '
      + 'follow-up turns. Every user reply is injected as a user message that invokes work here, '
      + 'even while the session is idle. Requires the persistent listener (hermes_channel_listen_start).',
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

export function apply(ctx) {
  const rawConfig = ctx.get('config')
  const cfg = (rawConfig !== null && typeof rawConfig === 'object') ? rawConfig : {}
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
