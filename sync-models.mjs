#!/usr/bin/env node
// Sync models from an OpenAI-compatible /models endpoint into opencode.json.
//
// Usage:
//   opencode-models [--prune] [--dry-run] [--config <path>] [--provider <id>]
//
// Reads baseURL + apiKey from the provider's settings in the config,
// fetches {baseURL}/models, and merges the result into
// providers.<id>.models. Existing per-model fields (attachment,
// interleaved, options, ...) are preserved; only name and limit.context
// are managed. Writes atomically with a .bak backup, and only when the
// merged result actually differs from the current config.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "opencode.json")
export const DEFAULT_PROVIDER_ID = "litellm"
const FETCH_TIMEOUT_MS = 5_000

export async function fetchModels({ baseURL, apiKey, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch }) {
  const url = `${baseURL.replace(/\/+$/, "")}/models`
  const res = await fetchImpl(url, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`)
  const body = await res.json()
  const data = Array.isArray(body?.data) ? body.data : null
  if (!data) throw new Error("unexpected /models response shape (expected { data: [...] })")
  return data.map((m) => ({
    id: m.id,
    maxInputTokens: typeof m.max_input_tokens === "number" ? m.max_input_tokens : undefined,
  }))
}

function isImageModel(id) {
  return /image/i.test(id)
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

// Build the config entry for one model. Spreads the existing entry so all
// custom fields are preserved; only name and limit are managed here.
export function buildModelEntry(id, existing, apiModel) {
  const entry = { ...(existing ?? {}) }
  entry.name = existing?.name ?? id
  if (isImageModel(id)) {
    entry.type = "image"
    return entry
  }
  if (apiModel.maxInputTokens) {
    entry.limit = { ...(entry.limit ?? {}), context: apiModel.maxInputTokens }
  }
  return entry
}

export function mergeModels(config, providerID, models, { prune = false } = {}) {
  const provider = config?.providers?.[providerID]
  if (!provider) throw new Error(`provider "${providerID}" not found in config`)
  provider.models ??= {}
  const before = provider.models
  const after = {}
  const report = { added: [], updated: [], stale: [], removed: [] }
  const apiIds = new Set()

  for (const model of models) {
    apiIds.add(model.id)
    const prev = before[model.id]
    const next = buildModelEntry(model.id, prev, model)
    const changed = !prev || !deepEqual(prev, next)
    after[model.id] = next
    if (!prev) report.added.push(model.id)
    else if (changed) report.updated.push(model.id)
  }

  for (const id of Object.keys(before)) {
    if (apiIds.has(id)) continue
    if (prune) report.removed.push(id)
    else {
      after[id] = before[id]
      report.stale.push(id)
    }
  }

  provider.models = after
  const changed = report.added.length + report.updated.length + report.removed.length > 0
  return { report, changed }
}

export function loadConfig(configPath) {
  const text = fs.readFileSync(configPath, "utf8")
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`invalid JSON in ${configPath}: ${err.message}`)
  }
}

export function writeConfig(configPath, config) {
  const tmp = `${configPath}.tmp`
  const bak = `${configPath}.bak`
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, bak)
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`)
  fs.renameSync(tmp, configPath)
}

export async function runSync({
  configPath = DEFAULT_CONFIG_PATH,
  providerID = DEFAULT_PROVIDER_ID,
  prune = false,
  dryRun = false,
  fetchImpl,
} = {}) {
  const config = loadConfig(configPath)
  const provider = config.providers?.[providerID]
  if (!provider?.settings) throw new Error(`provider "${providerID}" not found in ${configPath}`)
  const { baseURL, apiKey } = provider.settings
  if (!baseURL) throw new Error(`provider "${providerID}" has no settings.baseURL`)

  const models = await fetchModels({ baseURL, apiKey, fetchImpl })
  const { report, changed } = mergeModels(config, providerID, models, { prune })
  if (changed && !dryRun) writeConfig(configPath, config)

  return { configPath, providerID, baseURL, total: models.length, report, changed, dryRun }
}

// --- CLI ---

const USAGE = `opencode-models [--prune] [--dry-run] [--config <path>] [--provider <id>]

Sync models from the provider's /models endpoint into opencode.json.

  --prune         remove models that no longer exist in the API (default: keep + warn)
  --dry-run       print what would change without writing
  --config <path> config file (default: ~/.config/opencode/opencode.json)
  --provider <id> provider id in the config (default: litellm)`

function parseArgs(argv) {
  const args = {
    prune: false,
    dryRun: false,
    configPath: DEFAULT_CONFIG_PATH,
    providerID: DEFAULT_PROVIDER_ID,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--prune") args.prune = true
    else if (a === "--dry-run") args.dryRun = true
    else if (a === "--config") args.configPath = argv[++i]
    else if (a === "--provider") args.providerID = argv[++i]
    else if (a === "--help" || a === "-h") return { help: true }
    else throw new Error(`unknown flag: ${a} (see --help)`)
  }
  return args
}

export function formatReport(r) {
  const lines = [`${r.providerID}: ${r.total} model(s) from ${r.baseURL}`]
  if (r.report.added.length) lines.push(`+ added:   ${r.report.added.join(", ")}`)
  if (r.report.updated.length) lines.push(`~ updated: ${r.report.updated.join(", ")}`)
  if (r.report.stale.length)
    lines.push(`! stale (kept, use --prune to remove): ${r.report.stale.join(", ")}`)
  if (r.report.removed.length) lines.push(`- removed: ${r.report.removed.join(", ")}`)
  if (!r.changed) lines.push("✓ up to date")
  else lines.push(`✓ ${r.dryRun ? "would update" : "updated"} ${r.configPath}`)
  return lines.join("\n")
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(USAGE)
      process.exit(0)
    }
    const result = await runSync(args)
    console.log(formatReport(result))
  } catch (err) {
    console.error(`opencode-models: ${err.message}`)
    process.exit(1)
  }
}
