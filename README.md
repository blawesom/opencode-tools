# opencode-tools

The usual tools for my [OpenCode](https://opencode.ai) setup, kept in one repo:

- **[Model sync](#model-sync)** — auto-detect the models served by an
  OpenAI-compatible endpoint and keep them in `opencode.json`.
- **[Council](#council)** — a council of models that discusses and converges
  into a single decision for planning, and double-checks build
  implementations.

Each tool lives under `plugins/<name>` and is registered in the `plugins`
array of `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "/home/benj/Documents/git/opencode-tools/plugins/litellm-sync",
    {
      "package": "/home/benj/Documents/git/opencode-tools/plugins/council",
      "options": { "...": "see below" }
    }
  ]
}
```

## Model sync

`sync-models.mjs` reads `baseURL` and `apiKey` from a provider's `settings`
in `~/.config/opencode/opencode.json` (default provider id: `litellm`),
fetches `{baseURL}/models`, and merges the result into
`providers.<id>.models`:

- new models get `{ name, limit: { context } }` (context from
  `max_input_tokens` when the API provides it)
- model ids containing `image` are registered as `{ name, type: "image" }`
- existing entries keep all custom fields (`attachment`, `interleaved`,
  `options`, …); only `name` and `limit.context` are managed — and
  `limit.context` is only overwritten when the API reports
  `max_input_tokens`, so manually set limits survive syncs
- models that are in the config but missing from the API are **kept** with a
  warning; `--prune` removes them
- the config is only rewritten when something actually changed, atomically
  (tmp + rename), with a `.bak` backup first

## CLI

```sh
opencode-models               # sync now (manual)
opencode-models --dry-run     # show what would change
opencode-models --prune       # also drop models gone from the API
opencode-models --config path/to/opencode.json --provider litellm
```

Install the command:

```sh
npm install
npm link
```

## Automatic sync (plugin)

`plugins/litellm-sync` is an OpenCode server plugin. It runs the same sync
when OpenCode loads and again on new sessions (5-minute cooldown), so models
deployed to the endpoint appear without restarting. Register it in your
global config:

```json
{
  "plugins": ["/path/to/opencode-tools/plugins/litellm-sync"]
}
```

Optional plugin options:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-tools/plugins/litellm-sync",
      "options": { "provider": "litellm" }
    }
  ]
}
```

OpenCode watches `opencode.json` and reloads it after a save, so newly added
models show up in `/models` automatically.

## Council

`plugins/council` runs a council of models: several members weigh in, and a
chair converges their output into a single decision.

Current setup: members `kimi-k3.1-pro`, `glm-5.3`, `mimo-v2.6-pro`; chair
`mistral-large-4` (non-voting — it only synthesizes, so it cannot anchor on
its own proposal). `qwen` stays the everyday working model.

### Plan — `/council` (command-gated)

In any session (intended for plan mode), type:

```
/council <request>
```

1. Every member independently proposes an approach (parallel, each call
   individually timed out; a failed member just shrinks the quorum).
2. The chair synthesizes the proposals into **one converged decision**,
   with conflicts resolved explicitly and dissent noted.
3. The session receives the original request plus the council decision
   block, and plans *from* that decision.

If the quorum is not reached, the plain request is submitted unchanged —
the flow is never blocked.

### Build — double-checked implementation (automatic)

When a session running a build agent finishes work and goes idle:

1. Each member reviews the working-tree diff against the original request
   and answers `APPROVE` or `REJECT` with numbered issues.
2. Unanimous approval → a "Council approved ✅" note in the inbox (it does
   not wake the agent).
3. Any reject → the chair merges the issues into one prioritized fix list,
   injected so the agent immediately fixes them; the next idle triggers the
   next review round.
4. Rounds are capped (`build.maxRounds`, default 2); afterwards a final
   note lists the unresolved issues and the implementation is left as-is.

The review surface is the **working-tree diff** (uncommitted changes,
including untracked files). Changes that were committed are not reviewed,
and sessions with no file changes are skipped. A new user message starts a
fresh work burst and resets the round counter.

### Options

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-tools/plugins/council",
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

| Option | Default | Meaning |
|---|---|---|
| `members` | — (required) | `providerID/modelID` refs; the council members |
| `chair` | first member | the synthesizer model (may be a non-member) |
| `build.enabled` | `true` | enable the idle build review |
| `build.agents` | `["build"]` | which agents trigger reviews |
| `build.maxRounds` | `2` | max review rounds per work burst |
| `debug` | `false` | log member call sizes and responses |
| `memberTimeoutMs` | `120000` | per-member call timeout |
| `maxDiffBytes` | `24576` | diff cap in reviewer prompts |
| `quorum` | `2` | min member responses needed to act |

Without `members` the plugin logs a warning and stays disabled. All errors
are logged with a `[council]` prefix and never block a session.

### Cost

- `/council`: `members + 1` model calls per invocation (opt-in per use).
- Build review: `members` calls per round, `+1` chair merge on reject, up to
  `maxRounds` rounds per work burst.
