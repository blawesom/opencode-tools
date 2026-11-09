# Council — multi-model convergence for Plan & Build

Status: **implemented** in `plugins/council/index.ts` (single file, same
loading pattern as litellm-sync) and deployed in `opencode.json`.

Current setup: members `kimi-k3.1-pro`, `glm-5.3`, `mimo-v2.6-pro`; chair
`mistral-large-4` (non-voting synthesizer); working model `qwen`. The
context limit of kimi/mistral/mimo is manually set to 1M in `opencode.json`
— this survives syncs because the API does not report `max_input_tokens`
for those models.

A plugin that runs a council of models: several models weigh in, a chair
converges their output into a single decision. Two behaviors:

- **Plan** (command-gated): `/council <request>` in a plan session — members
  propose approaches in parallel, the chair synthesizes one converged
  decision, and the plan agent plans from that decision.
- **Build** (automatic): when the build agent finishes and goes idle, council
  members review the implementation. Unanimous approval passes; any reject
  injects a prioritized fix list that the agent immediately acts on. Capped
  review rounds prevent infinite fix cycles.

## Files

| File | Purpose |
|---|---|
| `plugins/council/index.ts` | The whole plugin: options parsing, `/council` command, idle-hook build review, council engine, member prompts (single file — no cross-file imports, so plugin loading stays as bulletproof as litellm-sync's) |
| `README.md` (repo root) | Config, command, and behavior docs |

## Configuration

Registered in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/home/benj/Documents/git/opencode-tools/plugins/council",
      "options": {
        "members": ["litellm/kimi-k3.1-pro", "litellm/glm-5.3", "litellm/mimo-v2.6-pro"],
        "chair": "litellm/mistral-large-4",
        "build": { "enabled": true, "agents": ["build"], "maxRounds": 2 },
        "debug": false,
        "memberTimeoutMs": 120000,
        "maxDiffBytes": 24576,
        "quorum": 2
      }
    }
  ]
}
```

Defaults:

- `chair` — first entry of `members` (here set explicitly to a non-member)
- `build.agents` — `["build"]`
- `build.maxRounds` — `2`
- `debug` — `false` (when true, log full member prompts/responses)
- `memberTimeoutMs` — `120000`
- `maxDiffBytes` — `24576`
- `quorum` — `2`

`members` is required. If missing (or empty), the plugin logs a warning at
setup and stays disabled — it never breaks session startup.

Model refs are `providerID/modelID` strings parsed into
`{ providerID, id }` for `experimental.generate.text`. Invalid/unavailable
members are logged and skipped at call time, shrinking the quorum.

## Verified API surface (opencode plugin 2.2.6)

All of the following were confirmed against the installed
`@opencode/plugin` types:

- `ctx.experimental.generate.text({ prompt, model: { id, providerID } })`
  → `{ text }` — stateless, no session/history/tools. This is the
  "council member speaks" primitive.
- `ctx.command.transform(editor => editor.add({ name, description, execute }))`
  — command registration. `CommandInvocation` provides `sessionID`,
  `prompt` (parsed `PromptInput.Prompt`), `delivery`.
- `ctx.session.hook("experimental.idle", ...)` — fires when a session
  finishes model work and is about to go idle (not after interruption or
  failure). Input admitted by the hook runs in the same execution.
  `background` lists still-running work (shell, subagent, image); when a
  descendant finishes, the hook fires again — so if background work exists,
  return and wait for the next idle.
- `ctx.session.prompt({ sessionID, text, delivery? })` — submit a user
  prompt.
- `ctx.session.synthetic({ sessionID, text, resume? })` — inject a message.
  `resume: true` runs it in the same execution (used for fix lists);
  `resume: false` leaves it in the inbox without waking the agent (used for
  approval notes and error messages — this is the loop-safety valve).
- `ctx.session.get({ sessionID })` → `Session.Info` with an `agent` field
  (Agent.ID) — used to check whether the session runs a build agent.
- `ctx.session.context({ sessionID })` → message history (requests, tool
  calls, results) — review context; also the "new work since last review"
  signal via message count.
- `ctx.vcs.diff(...)` — file diffs for reviewers. Fallback when not a repo
  or diff is empty: messages-only review context.
- `ctx.session.hook("prompt", ...)` — used only to reset per-session round
  counters when a new user message arrives.

## Plan side — `/council` command

1. User in a plan session types `/council <request>`.
2. Command `execute`:
   - **Round 1 — proposals (parallel):** each member receives the user's
     request framed as "you are one member of a council; propose the best
     approach, concise". `Promise.allSettled` with a per-member timeout
     (`memberTimeoutMs`, 120s default). Failed/timed-out members are skipped.
   - **Chair synthesis:** the chair model receives all proposals plus the
     original request and produces a single converged decision in
     markdown, including notable dissents.
   - **Submit:** `ctx.session.prompt({ sessionID, text })` where `text` is
     the original request followed by a clearly-delimited council decision
     block, framed so the plan agent treats the decision as the converged
     direction to plan from.
3. `/council` with no request → synthetic error note with `resume: false`.

Quorum rule: at least 2 member responses are needed to run synthesis
(plus the chair). Below quorum, log a warning and submit the plain
request unchanged so the user's flow is never blocked.

## Build side — double-checked implementation

1. `experimental.idle` hook fires. Guards (all must pass, else return
   quietly):
   - build review is enabled
   - `session.get(sessionID).agent` is in `build.agents`
   - `background` is empty (otherwise wait for the next idle)
   - review rounds for this work burst `< build.maxRounds`
   - new work exists since the last review (message count from
     `session.context` exceeds the stored `lastReviewedMessageCount`)
2. Gather review context:
   - the session's original/most recent user request
   - summary of recent messages from `session.context`
   - `vcs.diff` output, truncated to a size cap (~24 KB) in the reviewer
     prompt; if not a git repo or the diff is empty, review from messages
     only
3. **Review round:** each member reviews in parallel and must answer with
   a strict format: `APPROVE` or `REJECT` on the first line, followed by
   numbered issues (if rejecting). Parse defensively.
4. **All approve** → synthetic note "Council approved ✅" with
   `resume: false`. Reset the round counter.
5. **Any reject** → the chair merges all rejected issues into a single
   prioritized, de-duplicated fix list → injected as a synthetic message
   (runs in the same execution) → the build agent fixes → goes idle again
   → the idle hook fires the next review round.
6. **Round cap exceeded** → final synthetic note (`resume: false`) listing
   unresolved issues; the counter resets on the next user prompt.

## Loop safety

- Per-session in-memory state: `Map<sessionID, { rounds, lastReviewedMessageCount }>`
- Round counters reset whenever the `prompt` hook sees a new user message
- Notes injected with `resume: false` never wake the agent, so they cannot
  re-trigger the idle loop
- Fix-list messages are the only self-reinjecting input and are bounded by
  `maxRounds`
- Every hook body and member call is wrapped in try/catch; errors are
  logged with a `[council]` prefix (same convention as litellm-sync) and
  never propagate into the session

## Member prompts

All member/chair prompts live as constants in `council.ts` so they are
easy to iterate on:

- `PROPOSE_PROMPT` — council member proposing an approach (Plan)
- `SYNTHESIZE_PROMPT` — chair merging proposals into one decision (Plan)
- `REVIEW_PROMPT` — council member reviewing an implementation (Build)
- `MERGE_ISSUES_PROMPT` — chair merging rejected issues into a fix list (Build)

Convergence quality depends heavily on these; tune them first when
results feel weak.

## Cost model

- Plan (`/council` per invocation): `members.length` calls + 1 chair call.
  Command-gated, so cost is opt-in per use.
- Build (per work burst): `members.length` review calls per round + 1 chair
  merge call on reject, up to `maxRounds` rounds.

## Testing checklist

- [ ] Plugin loads with valid options; disabled with warning when `members` is missing
- [ ] `/council <request>` in a plan session submits an enriched prompt containing the converged decision
- [ ] `/council` with no args produces an inbox error note without waking the agent
- [ ] A member timing out or erroring is skipped; below quorum the plain request is submitted
- [ ] A build session that introduces a deliberate bug triggers REJECT → fix list → agent fixes → next round approves
- [ ] Unanimous approval produces a `resume: false` note and no further agent work
- [ ] `maxRounds` is respected; the final unresolved-issues note does not wake the agent
- [ ] New user prompt resets the round counter
- [ ] Idle with background work still running defers review to the next idle
- [ ] `debug: true` logs full member prompts and responses

## Open items

- ~~Final `members` list~~ — decided: kimi-k3.1-pro, glm-5.3, mimo-v2.6-pro
  (members) + mistral-large-4 (chair)
- Verify the full build-review loop on a real change (deliberate bug →
  reject → fix → approve)
- Possible follow-up: feed previous-round issues into the next review
  round so reviewers can verify specific fixes
- Possible follow-up: surface the individual plan proposals somewhere
  (currently only the converged decision is visible; `debug: true` logs
  call sizes)
