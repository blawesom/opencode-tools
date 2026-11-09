import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { formatReport, runSync } from "../../sync-models.mjs"

// Re-sync the model list into opencode.json on plugin load and on new
// sessions (with a cooldown). Errors never block startup: they are logged
// and swallowed. The sync is idempotent and only writes on change.
// Also registers a /sync-models command for manual refreshes.
const COOLDOWN_MS = 5 * 60 * 1000

export default Plugin.define({
  id: "litellm-sync",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as { configPath?: string; provider?: string }
    const configPath = options.configPath ?? path.join(os.homedir(), ".config", "opencode", "opencode.json")
    const providerID = options.provider ?? "litellm"
    let lastSyncAt = 0

    const sync = async () => {
      lastSyncAt = Date.now()
      try {
        const result = await runSync({ configPath, providerID })
        if (result.changed) {
          const parts = [
            result.report.added.length ? `+ ${result.report.added.join(", ")}` : "",
            result.report.updated.length ? `~ ${result.report.updated.join(", ")}` : "",
            result.report.removed.length ? `- ${result.report.removed.join(", ")}` : "",
          ].filter(Boolean)
          console.log(`[litellm-sync] ${parts.join(" ")} → ${configPath}`)
        }
      } catch (err) {
        console.warn(`[litellm-sync] sync failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await sync()

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.created"], signal: controller.signal })) {
        if (Date.now() - lastSyncAt < COOLDOWN_MS) continue
        await sync()
      }
    })()

    // /sync-models [--prune] — manual refresh, runs in-process (no LLM turn).
    await ctx.command.transform((editor) => {
      editor.add({
        name: "sync-models",
        description: "Sync models from the litellm endpoint into opencode.json (add --prune to drop models missing from the API)",
        execute: async ({ sessionID, prompt }) => {
          const text0 = (prompt as { text?: string } | undefined)?.text ?? ""
          const prune = /--prune\b/.test(text0)
          let text: string
          try {
            const result = await runSync({ configPath, providerID, prune })
            text = formatReport(result)
          } catch (err) {
            text = `sync failed: ${err instanceof Error ? err.message : String(err)}`
          }
          await ctx.session.synthetic({ sessionID, text })
        },
      })
    })

    return () => controller.abort()
  },
})
