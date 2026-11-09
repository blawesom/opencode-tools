# Deployment record — host `dev`

Deployed 2026-11-09 to `https://inference.laplane.net/v1` (provider `litellm`
in `~/.config/opencode/opencode.json`).

## Host requirements

- Node `>=22.19.0` (declared in `package.json` `engines`; resolved tree
  requires it via `@effect/platform-node*` 4.1.0 / `@effect/opentelemetry`
  4.1.0). Host has **v22.22.1** ✓
- OpenCode v2.2.6 at `~/.opencode/bin/opencode`; `@opencode/plugin` pinned to
  the exact same 2.2.6 (no floating `latest`).

## Install steps (reproducible)

```sh
npm ci                 # clean install from the lockfile
ln -sf "$(pwd)/sync-models.mjs" ~/.local/bin/opencode-models
```

`~/.local/bin` is on PATH. (Equivalent to `npm link`; the script uses only
Node builtins, so a direct symlink is stable across `npm ci` runs.)

OpenCode registration (already in `~/.config/opencode/opencode.json`):

```json
"plugins": [
  "/home/outscale/git/opencode-tools/plugins/litellm-sync",
  {
    "package": "/home/outscale/git/opencode-tools/plugins/council",
    "options": {
      "members": ["litellm/kimi-k3.1-pro", "litellm/glm-5.3", "litellm/mimo-v2.6-pro"],
      "chair": "litellm/mistral-large-4",
      "build": { "enabled": true, "agents": ["build"], "maxRounds": 2 }
    }
  }
]
```

## Smoke test (2026-11-09, post `npm ci`)

CLI:

```
$ opencode-models --dry-run
litellm: 6 model(s) from https://inference.laplane.net/v1
! stale (kept, use --prune to remove): qwen3.8-27b
✓ up to date
```

Plugin load (server log, no warnings):

```
loading plugin id=/home/outscale/git/opencode-tools/plugins/litellm-sync
loading plugin id=/home/outscale/git/opencode-tools/plugins/council
```

Runtime state (`opencode api` against the running service, location
`/home/outscale/git/opencode-tools`):

```
litellm-sync -> active
council      -> active
commands: init, review, goal, sync-models, council
```

Models in sync: `qwen`, `kimi-k3.1-pro`, `glm-5.3`, `mistral-large-4`,
`mimo-v2.6-pro`, `qwen-image` (image). `qwen3.8-27b` is stale (no longer
served) and kept; remove with `opencode-models --prune`.
