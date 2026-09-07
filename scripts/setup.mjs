/**
 * Interactive setup for dsh-hermes-channel.
 * Prompts for every configuration value and writes them into cordis.patch.yml
 * (the local copy of this repo). Run with: npm run setup
 */
import readline from 'node:readline/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PATCH = path.join(REPO_ROOT, 'cordis.patch.yml')

const FIELDS = [
  { key: 'defaultChatId', question: 'Feishu/Lark chat_id for outbound messages (oc_...)', def: '' },
  { key: 'autoPushFlag', question: 'Flag to auto-push into every session (empty = manual hermes_channel_push_start)', def: '' },
  { key: 'pushIntervalSeconds', question: 'Push poll interval in seconds (min 5)', def: '15' },
  { key: 'hermesBin', question: 'Hermes CLI executable', def: 'hermes' },
  { key: 'pythonBin', question: 'Python interpreter', def: 'python' },
  { key: 'hermesHome', question: 'Hermes home directory (empty = platform default)', def: '' },
]

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const values = {}
console.log('dsh-hermes-channel setup — press Enter to keep the default.\n')
for (const field of FIELDS) {
  const suffix = field.def ? ` [${field.def}]` : ''
  const answer = (await rl.question(`${field.question}${suffix}: `)).trim()
  values[field.key] = answer || field.def
}
rl.close()

let text = readFileSync(PATCH, 'utf8')
for (const field of FIELDS) {
  const value = values[field.key]
  const rendered = /^\d+$/.test(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const pattern = new RegExp(`(${field.key}:)\\s*("[^"]*"|\\d*)`)
  if (pattern.test(text)) {
    text = text.replace(pattern, `$1 ${rendered}`)
  } else {
    throw new Error(`cordis.patch.yml is missing the "${field.key}" config key`)
  }
}
writeFileSync(PATCH, text, 'utf8')
console.log(`\nWrote ${PATCH}`)
console.log('Install with: dsh plugin --profile <profile> add ' + REPO_ROOT)
