import { Plugin } from "@opencode/plugin"

// Council: multiple models discuss and converge. On/off per session, cross-agent.
//
// - `/council on` / `/council off`: enable/disable council for the session,
//   whatever agent it runs (plan, build, custom). State follows the session,
//   so switching agents keeps the setting. Default: off.
// - One-shot: `/council <request>` (any session, regardless of the toggle):
//   members propose approaches in parallel, the chair synthesizes one
//   converged decision, and the enriched request is submitted to the session.
// - Idle review (when enabled): when the session finishes work and goes
//   idle, members review the working-tree diff — or, when there is no diff
//   (e.g. a plan session), the recent conversation. Unanimous approval
//   passes; any reject injects a prioritized fix list that runs in the same
//   execution, capped at `build.maxRounds` review rounds per work burst.
//
// Member calls are stateless generations (`experimental.generate.text`):
// parallel, individually timed out, and failure-tolerant — a member that
// errors or times out simply shrinks the quorum. All errors are logged with
// a `[council]` prefix and never block a session.

// Ambient timer declarations keep this file type-checkable without DOM or
// node lib types; the host runtime always provides them.
declare const setTimeout: (callback: () => void, ms: number) => unknown
declare const clearTimeout: (timer: unknown) => void

interface ModelRef {
  providerID: string
  id: string
}

type GenerateTextFn = (input: { prompt: string; model: ModelRef }) => Promise<{ text: string }>

interface CouncilConfig {
  members: ModelRef[]
  chair: ModelRef
  build: { enabled: boolean; maxRounds: number }
  debug: boolean
  memberTimeoutMs: number
  maxDiffBytes: number
  quorum: number
}

interface SessionState {
  enabled: boolean
  rounds: number
  lastReviewedCount: number
  lastUserId?: string
  reviewing: boolean
}

type ContextMessage = { type: string; id?: string; text?: string }

type DiffEntry = { file: string; patch: string; additions: number; deletions: number; status: string }
type VcsDiffFn = (input: {
  location?: { directory?: string }
  mode: "working" | "branch" | "committed"
  context?: number
  untracked?: "files" | "folders"
}) => Promise<{ data?: DiffEntry[] }>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const label = (ref: ModelRef) => `${ref.providerID}/${ref.id}`

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function log(msg: string) {
  console.log(`[council] ${msg}`)
}

function warn(msg: string) {
  console.warn(`[council] ${msg}`)
}

function dbg(enabled: boolean, msg: string) {
  if (enabled) log(msg)
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt
  return Math.min(max, Math.max(min, n))
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim())
}

function parseModelRef(ref: string): ModelRef | null {
  const idx = ref.indexOf("/")
  if (idx <= 0 || idx >= ref.length - 1) return null
  return { providerID: ref.slice(0, idx), id: ref.slice(idx + 1) }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: unknown
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function resolveConfig(raw: unknown): CouncilConfig | null {
  const o = (raw ?? {}) as Record<string, unknown>
  const memberRefs = toStringArray(o.members)
  if (memberRefs.length === 0) return null
  const members = memberRefs
    .map(parseModelRef)
    .filter((m): m is ModelRef => m !== null)
  if (members.length === 0) return null

  let chair = typeof o.chair === "string" ? parseModelRef(o.chair.trim()) : null
  if (!chair) chair = members[0]

  const b = (o.build ?? {}) as Record<string, unknown>
  const build = {
    enabled: b.enabled === undefined ? true : Boolean(b.enabled),
    maxRounds: clampInt(b.maxRounds, 2, 1, 10),
  }

  return {
    members,
    chair,
    build,
    debug: Boolean(o.debug),
    memberTimeoutMs: clampInt(o.memberTimeoutMs, 120_000, 5_000, 600_000),
    maxDiffBytes: clampInt(o.maxDiffBytes, 24_576, 1_024, 200_000),
    quorum: clampInt(o.quorum, 2, 1, members.length),
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PROPOSE_PROMPT = (request: string) => `You are one member of a council of AI models. Each member answers independently and cannot see the others.

User request:
${request}

Propose the best approach: the key steps, the main decisions with their trade-offs, and the biggest risks. Be concise (max ~300 words). Write as a direct recommendation, no preamble.`

const SYNTHESIZE_PROMPT = (request: string, proposals: string) => `You are the chair of a council of AI models. Members proposed approaches for the user request below, independently and without seeing each other.

User request:
${request}

Member proposals:
${proposals}

Synthesize ONE converged decision the group will follow:
- Start with a one-paragraph verdict: the chosen direction and why.
- Then the agreed key steps and decisions, in markdown.
- Explicitly resolve conflicts between proposals; where members disagreed, state the choice and the reason.
- End with a short "Dissent / risks" note for important points the decision does not follow.

Max ~400 words. Output only the decision.`

const REVIEW_PROMPT = (request: string, diff: string) => `You are one of several independent reviewers checking an implementation.

Original request:
${request}

Implementation diff (working tree, unified):
${diff}

Decide:
- Output APPROVE on the first line if the implementation fulfills the request with no significant defects.
- Otherwise output REJECT on the first line, followed by a numbered list of concrete, actionable issues (bugs, unhandled cases, security problems, breakage of surrounding code). Do not report style preferences.

Judge only what is in the diff. If the request is unclear, review the diff on its own merits.`

const REVIEW_MESSAGES_PROMPT = (request: string, transcript: string) => `You are one of several independent reviewers checking work that produced no file diff (e.g. a plan).

Original request:
${request}

Recent conversation (truncated):
${transcript}

Decide:
- Output APPROVE on the first line if the work fulfills the request with no significant defects.
- Otherwise output REJECT on the first line, followed by a numbered list of concrete, actionable issues (flaws, unhandled cases, contradictions with the request, missing pieces). Do not report style preferences.

Judge only what is in the transcript. If the request is unclear, review the work on its own merits.`

const MERGE_ISSUES_PROMPT = (issues: string) => `You are the chair of a review council. Reviewers rejected an implementation with the issues below.

Reviewer issues:
${issues}

Merge them into one prioritized, de-duplicated fix list for the implementer:
- Numbered, most critical first.
- Only actionable issues (bugs, security, breakage, unhandled cases). Drop style nits and duplicates.
- Keep each item to one or two sentences. Max ~300 words.`

// ---------------------------------------------------------------------------
// Council engine
// ---------------------------------------------------------------------------

async function runMembers(
  generate: GenerateTextFn,
  refs: readonly ModelRef[],
  makePrompt: () => string,
  cfg: CouncilConfig,
): Promise<Array<{ ref: ModelRef; text: string }>> {
  const settled = await Promise.allSettled(
    refs.map(async (ref) => {
      const prompt = makePrompt()
      dbg(cfg.debug, `→ ${label(ref)} (prompt ${prompt.length} chars)`)
      const res = await withTimeout(generate({ prompt, model: ref }), cfg.memberTimeoutMs)
      const text = (res?.text ?? "").trim()
      if (!text) throw new Error("empty response")
      dbg(cfg.debug, `← ${label(ref)} (${text.length} chars)`)
      return { ref, text }
    }),
  )
  const out: Array<{ ref: ModelRef; text: string }> = []
  for (const s of settled) {
    if (s.status === "fulfilled") out.push(s.value)
    else warn(`member failed: ${message(s.reason)}`)
  }
  return out
}

async function runPlanCouncil(
  generate: GenerateTextFn,
  cfg: CouncilConfig,
  request: string,
): Promise<string | null> {
  const proposals = await runMembers(generate, cfg.members, () => PROPOSE_PROMPT(request), cfg)
  if (proposals.length < cfg.quorum) {
    warn(`quorum not reached (${proposals.length}/${cfg.members.length} responded)`)
    return null
  }
  const blocks = proposals.map((p, i) => `### Member ${i + 1} (${label(p.ref)})\n\n${p.text}`).join("\n\n")
  const res = await withTimeout(generate({ prompt: SYNTHESIZE_PROMPT(request, blocks), model: cfg.chair }), cfg.memberTimeoutMs)
  const decision = (res?.text ?? "").trim()
  return decision || null
}

function parseVerdict(text: string): { approved: boolean; issues: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { approved: false, issues: ["(empty reviewer response)"] }

  let verdict: "APPROVE" | "REJECT" | null = null
  for (const line of lines.slice(0, 3)) {
    const m = line.match(/\b(APPROVE|REJECT)\b/i)
    if (m) {
      verdict = m[1].toUpperCase() as "APPROVE" | "REJECT"
      break
    }
  }
  if (!verdict) {
    const m = text.match(/\b(APPROVE|REJECT)\b/i)
    verdict = m ? (m[1].toUpperCase() as "APPROVE" | "REJECT") : null
  }
  if (!verdict) {
    return { approved: false, issues: [`(unparseable reviewer response) ${text.slice(0, 400)}`] }
  }
  if (verdict === "APPROVE") return { approved: true, issues: [] }

  const issues = lines
    .filter((l) => /^(\d+[.)]|[-*])\s+/.test(l))
    .map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, ""))
  if (issues.length > 0) return { approved: false, issues }
  const body = lines.filter((l) => !/\b(APPROVE|REJECT)\b/i.test(l))
  return { approved: false, issues: body.length > 0 ? body : ["(reviewer rejected without listing issues)"] }
}

async function gatherWorkingDiff(diff: VcsDiffFn, directory: string, maxBytes: number): Promise<string | null> {
  try {
    const out = await diff({ location: { directory }, mode: "working", context: 3, untracked: "files" })
    const entries = out?.data ?? []
    if (entries.length === 0) return null
    let patch = entries.map((e) => `--- ${e.file} (${e.status}, +${e.additions}/-${e.deletions})\n${e.patch}`).join("\n\n")
    if (patch.length > maxBytes) patch = `${patch.slice(0, maxBytes)}\n…(diff truncated)`
    return patch
  } catch (err) {
    dbg(false, `vcs diff unavailable: ${message(err)}`)
    return null
  }
}

function findLastUser(messages: readonly ContextMessage[]): { id: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === "user" && typeof m.id === "string" && typeof m.text === "string") {
      return { id: m.id, text: m.text }
    }
  }
  return null
}

function summarizeRecentMessages(messages: readonly ContextMessage[], maxBytes: number): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.type !== "user" && m.type !== "assistant") continue
    const text = typeof m.text === "string" ? m.text.trim() : ""
    if (!text) continue
    parts.push(`--- ${m.type} ---\n${text}`)
  }
  let out = parts.join("\n\n")
  if (out.length > maxBytes) out = `${out.slice(0, maxBytes)}\n…(transcript truncated)`
  return out
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "council",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options)
    if (!cfg) {
      warn("no valid options.members — plugin disabled. Set options.members to providerID/modelID refs, e.g. [\"litellm/glm-5.3\"]")
      return
    }

    const generate = ctx.experimental.generate.text as GenerateTextFn
    const states = new Map<string, SessionState>()
    const getState = (sessionID: string): SessionState => {
      let st = states.get(sessionID)
      if (!st) {
        st = { enabled: false, rounds: 0, lastReviewedCount: 0, reviewing: false }
        states.set(sessionID, st)
      }
      return st
    }

    const disposers: Array<() => Promise<void>> = []

    // --- /council command: on/off toggle + one-shot proposals -------------

    const commandReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "council",
        description: "Model council: members propose, the chair converges one decision, the session proceeds from it",
        execute: async ({ sessionID, prompt }) => {
          const raw = String(prompt?.text ?? "").trim()
          const st = getState(sessionID)

          if (!raw) {
            await ctx.session
              .synthetic({
                sessionID,
                text: `Council is ${st.enabled ? "ON" : "OFF"} for this session.\n\nUsage:\n- /council on — enable council idle review for this session (any agent)\n- /council off — disable it\n- /council <request> — one-shot: members propose, the chair converges one decision, the session proceeds from it`,
                description: "council status",
                resume: false,
              })
              .catch(() => {})
            return
          }

          const kw = raw.toLowerCase()
          if (kw === "on" || kw === "off") {
            st.enabled = kw === "on"
            if (!st.enabled) {
              st.rounds = 0
              st.lastReviewedCount = 0
            }
            log(`session ${sessionID}: council ${st.enabled ? "enabled" : "disabled"}`)
            await ctx.session
              .synthetic({
                sessionID,
                text: st.enabled
                  ? `Council enabled for this session (any agent). When work goes idle, ${cfg.members.map(label).join(", ")} will review it.`
                  : "Council disabled for this session.",
                description: `council ${st.enabled ? "on" : "off"}`,
                resume: false,
              })
              .catch(() => {})
            return
          }

          const request = raw
          try {
            log(`plan council convened: ${cfg.members.map(label).join(", ")} (chair ${label(cfg.chair)})`)
            const decision = await runPlanCouncil(generate, cfg, request)
            if (!decision) {
              warn("no converged decision; submitting the request unchanged")
              await ctx.session.prompt({ sessionID, text: request })
              return
            }
            const enriched = [
              request,
              "",
              "---",
              "## Council decision",
              "",
              decision,
              "",
              "---",
              `*Converged by the model council (${cfg.members.map(label).join(", ")}; chair: ${label(cfg.chair)}). Treat it as the agreed direction for this request.*`,
            ].join("\n")
            await ctx.session.prompt({ sessionID, text: enriched })
          } catch (err) {
            warn(`plan council failed: ${message(err)}; submitting the request unchanged`)
            await ctx.session.prompt({ sessionID, text: request }).catch(() => {})
          }
        },
      })
    })
    disposers.push(() => commandReg.dispose())

    // --- Idle review (per-session /council on, any agent) -------------------

    const idleReg = await ctx.session.hook("experimental.idle", async (event) => {
      try {
        if (!cfg.build.enabled) return
        if (event.background.length > 0) return // work still running; wait for the next idle
        const st = getState(event.sessionID)
        if (!st.enabled) return // per-session toggle is off
        if (st.reviewing) return

        const messages = (await ctx.session.context({ sessionID: event.sessionID })) as ContextMessage[]

        // A new user message starts a new work burst: reset the round counter.
        const lastUser = findLastUser(messages)
        if (lastUser && lastUser.id !== st.lastUserId) {
          st.rounds = 0
          st.lastUserId = lastUser.id
        }

        // No new messages since the last review → nothing to review.
        if (messages.length <= st.lastReviewedCount) return
        st.lastReviewedCount = messages.length

        // Review surface: the working-tree diff when there is one (committed
        // changes are not reviewed); otherwise the recent conversation, e.g.
        // a plan session with no file changes.
        const diff = await gatherWorkingDiff(ctx.vcs.diff, ctx.location.directory, cfg.maxDiffBytes)
        if (st.rounds >= cfg.build.maxRounds) return // safety; the cap note below normally handles this

        st.reviewing = true
        try {
          st.rounds += 1
          const request = lastUser?.text ?? "(no user request found)"
          log(`idle review round ${st.rounds}/${cfg.build.maxRounds} for session ${event.sessionID} (${diff ? "diff" : "transcript"})`)

          const makePrompt = diff
            ? () => REVIEW_PROMPT(request, diff)
            : () => REVIEW_MESSAGES_PROMPT(request, summarizeRecentMessages(messages, cfg.maxDiffBytes))
          const verdicts: Array<{ ref: ModelRef; text: string }> = await runMembers(
            generate,
            cfg.members,
            makePrompt,
            cfg,
          )
          if (verdicts.length < cfg.quorum) {
            warn(`only ${verdicts.length}/${cfg.members.length} reviewers responded; skipping this round`)
            st.rounds -= 1 // do not burn a round on a failed review
            return
          }

          const parsed = verdicts.map((v) => ({ ref: v.ref, ...parseVerdict(v.text) }))
          const rejects = parsed.filter((v) => !v.approved)

          if (rejects.length === 0) {
            await ctx.session.synthetic({
              sessionID: event.sessionID,
              text: `Council review — approved: ${parsed.length} of ${parsed.length} reviewers found no significant issues. ✅`,
              description: "council approval",
              resume: false,
            })
            st.rounds = 0
            return
          }

          const issueBlocks = rejects.map((r) => `Reviewer ${label(r.ref)}:\n${r.issues.join("\n")}`)
          let fixList: string
          try {
            const merged = await withTimeout(
              generate({ prompt: MERGE_ISSUES_PROMPT(issueBlocks.join("\n\n")), model: cfg.chair }),
              cfg.memberTimeoutMs,
            )
            fixList = (merged?.text ?? "").trim() || issueBlocks.join("\n\n")
          } catch (err) {
            warn(`chair failed to merge issues (${message(err)}); using raw reviewer issues`)
            fixList = issueBlocks.join("\n\n")
          }

          if (st.rounds >= cfg.build.maxRounds) {
            await ctx.session.synthetic({
              sessionID: event.sessionID,
              text: `Council review stopped after ${cfg.build.maxRounds} round(s) — reviewers still report unresolved issues:\n\n${fixList}\n\nThe implementation was left as-is; review the items above manually.`,
              description: "council unresolved",
              resume: false,
            })
            st.rounds = 0
            return
          }

          await ctx.session.synthetic({
            sessionID: event.sessionID,
            text: `Council review — round ${st.rounds} of ${cfg.build.maxRounds}: ${rejects.length} of ${parsed.length} reviewers rejected the implementation. Fix the following, most critical first:\n\n${fixList}`,
            description: "council fix list",
            resume: true,
          })
        } finally {
          st.reviewing = false
        }
      } catch (err) {
        warn(`idle review failed: ${message(err)}`)
      }
    })
    disposers.push(() => idleReg.dispose())

    log(`ready: members ${cfg.members.map(label).join(", ")}; chair ${label(cfg.chair)}; idle review ${cfg.build.enabled ? `available via per-session /council on, max ${cfg.build.maxRounds} round(s)` : "disabled"}`)

    return () => {
      for (const dispose of disposers) void dispose()
      states.clear()
    }
  },
})
