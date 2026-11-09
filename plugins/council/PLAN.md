# Council — multi-model convergence, on/off per session (cross-agent)

Status: **implemented** in `plugins/council/index.ts` (single file, same
loading pattern as litellm-sync) and deployed in `opencode.json`.

Current setup: members `kimi-k3.1-pro`, `glm-5.3`, `mimo-v2.6-pro`; chair
`mistral-large-4` (non-voting synthesizer); working model `qwen`. The
context limit of kimi/mistral/mimo is manually set to 1M in `opencode.json`
— this survives syncs because the API does not report `max_input_tokens`
for those models.

A plugin that runs a council of models: several models weigh in, a chair
converges their output into a single decision. Three behaviors:

- **On/off mode (session-scoped, cross-agent):** `/council on` enables council
  for the session no matter which agent runs it (plan, build, custom); the
  state follows the session, so switching agents keeps it. `/council off`
  disables it. Default: off. `/council` with no args reports the state.
- **One-shot proposals (command-gated):** `/council <request>` in any session
  (regardless of the toggle) — members propose approaches in parallel, the
  chair synthesizes one converged decision, and the session proceeds from
  that decision.
- **Idle review (automatic, when enabled):** when an enabled session finishes
  work and goes idle, council members review the working-tree diff — or, if
  there is no diff (e.g. a plan session), the recent conversation. Unanimous
  approval passes; any reject injects a prioritized fix list that the agent
  immediately acts on. Capped review rounds prevent infinite fix cycles.

## Files

| File | Purpose |
|---|---|
| `plugins/council/index.ts` | The whole plugin: options parsing, `/council` command (on/off/status/one-shot), idle-hook review, council engine, member prompts (single file — no cross-file imports, so plugin loading stays as bulletproof as litellm-sync's) |
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
        "build": { "enabled": true, "maxRounds": 2 },
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
- `build.enabled` — `true` (global kill switch; the per-session toggle still defaults to off)
- `build.maxRounds` — `2`
- `debug` — `false` (when true, log full member prompts/responses)
- `memberTimeoutMs` — `120000`
- `maxDiffBytes` — `24576` (cap for both diffs and transcripts in reviewer prompts)
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
  approval notes, toggle confirmations, and error messages — this is the
  loop-safety valve).
- `ctx.session.context({ sessionID })` → message history (requests, tool
  calls, results) — review context; also the "new work since last review"
  signal via message count, and the new-user-message signal via the last
  user message id (which resets the round counter).
- `ctx.vcs.diff(...)` — file diffs for reviewers. When not a repo or the
  diff is empty, the review falls back to the message transcript.

## On/off toggle — `/council on|off`

- State lives in a per-session `Map<sessionID, SessionState>`; `enabled`
  defaults to `false`.
- `/council on` sets `enabled = true` and posts a `resume: false`
  confirmation: "Council is now **ON** for this session — …".
- `/council off` sets `enabled = false`, resets `rounds` and
  `lastReviewedCount`, and posts "Council is now **OFF** …".
- `/council` with no args reports the current state and usage.
- The state is keyed by session, not agent, so switching agents (plan ↔
  build) in the same session keeps the toggle.
- The literal texts `on`/`off` (case-insensitive) are reserved for the toggle.
- Every displayed council note ends with a status line
  (`statusLine(st)` → `Council: ON|OFF for this session`), so the state is
  always visible no matter which `/council` form was used.

## One-shot — `/council <request>`

Works in any session regardless of the toggle:

1. User types `/council <request>`.
2. Command `execute`:
   - **Convening note (feedback at start):** a `resume: false` note with the
     members, chair, quorum, and the session status line.
   - **Round 1 — proposals (parallel):** each member receives the user's
     request framed as "you are one member of a council; propose the best
     approach, concise". `Promise.allSettled` with a per-member timeout
     (`memberTimeoutMs`, 120s default). Failed/timed-out members are skipped.
   - **Chair synthesis:** the chair model receives all proposals plus the
     original request and produces a single converged decision in
     markdown, including notable dissents.
   - **Submit:** `ctx.session.prompt({ sessionID, text })` where `text` is
     the original request followed by a clearly-delimited council decision
     block, framed so the agent treats the decision as the converged
     direction to work from.
3. Quorum rule: at least 2 member responses are needed to run synthesis
   (plus the chair). Below quorum, log a warning and submit the plain
   request unchanged so the flow is never blocked.
4. **Recap note (feedback at end of the answer):** the decision + member
   stats are stored in `SessionState.pendingReport`; the `experimental.idle`
   hook posts it once when the answer completes (before the enabled check,
   so it works with the toggle off) as a `resume: false` "council report"
   note: "Council did: N/M members proposed… chair … converged the decision
   below", the **full converged decision**, the status line, and a
   `/council on` hint. Failure paths (below quorum, exception) get an
   honest recap too.

## Idle review — double-checked work (when the session toggle is on)

1. `experimental.idle` hook fires. Guards (all must pass, else return
   quietly):
   - `build.enabled` (global kill switch)
   - the session's `enabled` toggle is on
   - `background` is empty (otherwise wait for the next idle)
   - not already reviewing
   - review rounds for this work burst `< build.maxRounds`
   - new work exists since the last review (message count from
     `session.context` exceeds the stored `lastReviewedCount`)
2. Gather review context:
   - the session's most recent user request
   - the working-tree diff via `vcs.diff`, truncated to `maxDiffBytes`;
     if not a git repo or the diff is empty → fall back to a transcript of
     recent user/assistant messages (also capped at `maxDiffBytes`), so
     plan output gets reviewed too
3. **Review round:** each member reviews in parallel and must answer with
   a strict format: `APPROVE` or `REJECT` on the first line, followed by
   numbered issues (if rejecting). Parse defensively.
4. **All approve** → synthetic note "Council approved ✅" + status line, with
   `resume: false`. Reset the round counter.
5. **Any reject** → the chair merges all rejected issues into a single
   prioritized, de-duplicated fix list → injected as a synthetic message
   (`resume: true`, runs in the same execution) → the agent fixes → goes
   idle again → the idle hook fires the next review round.
6. **Round cap exceeded** → final synthetic note (`resume: false`) listing
   unresolved issues + status line; the counter resets on the next user prompt.

All review notes end with the session status line.

## Loop safety

- Per-session in-memory state: `Map<sessionID, { enabled, rounds, lastReviewedCount, lastUserId, reviewing, pendingReport }>`
- `pendingReport` (one-shot recap) is posted by the idle hook before any
  other guard, exactly once, with `resume: false`
- Round counters reset whenever a new user message arrives (detected in the
  idle hook via the last user message id)
- Notes injected with `resume: false` never wake the agent, so they cannot
  re-trigger the idle loop
- Fix-list messages are the only self-reinjecting input and are bounded by
  `maxRounds`
- Every hook body and member call is wrapped in try/catch; errors are
  logged with a `[council]` prefix (same convention as litellm-sync) and
  never propagate into the session

## Member prompts

All member/chair prompts live as constants in `index.ts` so they are
easy to iterate on:

- `PROPOSE_PROMPT` — council member proposing an approach (one-shot)
- `SYNTHESIZE_PROMPT` — chair merging proposals into one decision (one-shot)
- `REVIEW_PROMPT` — council member reviewing a diff (idle)
- `REVIEW_MESSAGES_PROMPT` — council member reviewing the transcript when
  there is no diff (idle)
- `MERGE_ISSUES_PROMPT` — chair merging rejected issues into a fix list (idle)

Convergence quality depends heavily on these; tune them first when
results feel weak.

## Cost model

- One-shot (`/council <request>` per invocation): `members.length` calls +
  1 chair call. Command-gated, so cost is opt-in per use.
- Idle review (per work burst, only in sessions with the toggle on):
  `members.length` review calls per round + 1 chair merge call on reject,
  up to `maxRounds` rounds. Default off → zero cost until `/council on`.

## Testing checklist

- [ ] Plugin loads with valid options; disabled with warning when `members` is missing
- [ ] `/council on`/`off` confirm with explicit "Council is now ON/OFF" notes; every note carries the `Council: ON|OFF for this session` status line
- [ ] `/council` with no args reports state + usage
- [ ] `/council <request>` posts a convening note immediately and a recap note (member stats + full decision + status + hint) when the answer goes idle — with the toggle off too
- [ ] Below-quorum / failure one-shots submit the plain request and the recap says so
- [ ] The toggle survives switching agents in the same session (plan ↔ build)
- [ ] With the toggle off, idle work triggers no review
- [ ] `/council <request>` submits an enriched prompt containing the converged decision (works with the toggle off too)
- [ ] A member timing out or erroring is skipped; below quorum the plain request is submitted
- [ ] Idle review with a working diff: deliberate bug → REJECT → fix list → agent fixes → next round approves
- [ ] Idle review with no diff (plan session): transcript review triggers
- [ ] Unanimous approval produces a `resume: false` note and no further agent work
- [ ] `maxRounds` is respected; the final unresolved-issues note does not wake the agent
- [ ] New user prompt resets the round counter
- [ ] Idle with background work still running defers review to the next idle
- [ ] `debug: true` logs full member prompts and responses

## Open items

- ~~Final `members` list~~ — decided: kimi-k3.1-pro, glm-5.3, mimo-v2.6-pro
  (members) + mistral-large-4 (chair)
- Verify the full idle-review loop on a real change (deliberate bug →
  reject → fix → approve) and on a no-diff plan session (transcript review)
- Possible follow-up: feed previous-round issues into the next review
  round so reviewers can verify specific fixes
- Possible follow-up: surface the individual one-shot proposals somewhere
  (currently only the converged decision is visible; `debug: true` logs
  call sizes)
