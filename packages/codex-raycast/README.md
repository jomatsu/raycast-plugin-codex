# codex-raycast

Sets up the Codex hooks that power the [Codex Sessions Raycast extension](../raycast-extension) — an idempotent setup/status/doctor workflow for user-level OpenAI Codex configuration (`$CODEX_HOME`, default `~/.codex`) that keeps up with Codex version upgrades.

The **session-status** patch installs two Codex hooks that maintain a small `states.json` (`working` / `done` + unread) which the extension joins onto its SQLite-backed session list. The hook stores no prompt or assistant content and has no UI of its own.

## Usage

```sh
npx codex-raycast setup            # install/refresh the hooks (idempotent)
npx codex-raycast setup --dry-run  # preview without changing anything
npx codex-raycast status           # what is installed, in sync, and trusted?
npx codex-raycast doctor           # status + live `hooks/list` check via codex app-server
npx codex-raycast remove           # remove only the entries this tool owns
```

Node.js ≥ 20, no runtime dependencies.

> Migrating from the old Python hook (the codex-patches repository)? `setup` removes the legacy `raycast-codex-completion-hook.py` hook entries and script automatically, then installs the Node hook. Re-trust via `/hooks` afterwards.

## What setup does — and deliberately does not do

- Copies the hook script into `$CODEX_HOME` as `codex-raycast-session-hook.mjs` (atomic write + chmod).
- Merges hook entries into `$CODEX_HOME/hooks.json`, identified by a marker string. Existing entries from other tools (e.g. Herdr's `SessionStart`) are never touched; malformed JSON aborts instead of overwriting.
- Ensures `[features] hooks = true` in `$CODEX_HOME/config.toml` without altering other keys — in particular it never touches `notify`.
- Cleans up remnants of the earlier Python hook (declared as `legacyMarkers` / `legacyFiles` in the manifest).
- Records the applied script hashes and `codex --version` under `~/.local/state/codex-raycast/` so `status` can flag drift later.
- **Never writes hook trust.** Codex tracks trust against each hook's hash; new or changed hooks are skipped until you review them with `/hooks` inside Codex. That review is the security boundary and this tool does not bypass it.

## Following Codex upgrades

After a Codex update, run:

```sh
npx codex-raycast doctor
```

- If the CLI version differs from the last `setup`, status says so.
- If Codex renamed/moved its config surfaces or stopped listing the hooks, the live `hooks/list` check (via `codex app-server`) shows what Codex actually sees, including its own `trustStatus`.
- If the hook script was updated in a newer package version, `setup` reinstalls it and reminds you that Codex will require a `/hooks` re-trust (hash changed).

Typical upgrade loop: `npx codex-raycast@latest setup` → open Codex → `/hooks` → trust → `npx codex-raycast status` shows `ok`.

## Patch layout

```
patches/<name>/
  patch.json   # manifest: files to install, hook entries, feature flags, marker, legacy cleanup
  hook.mjs     # self-contained script referenced by the manifest
```

`patch.json` (session-status):

```json
{
  "name": "session-status",
  "marker": "codex-raycast-session-hook.mjs",
  "legacyMarkers": ["raycast-codex-completion-hook.py"],
  "legacyFiles": ["raycast-codex-completion-hook.py"],
  "files": [{ "source": "hook.mjs", "target": "codex-raycast-session-hook.mjs", "mode": "755" }],
  "hooks": {
    "Stop": { "command": "node ${hook.mjs} stop", "timeout": 10 },
    "UserPromptSubmit": { "command": "node ${hook.mjs} prompt", "timeout": 10 }
  },
  "features": { "hooks": true }
}
```

`${hook.mjs}` expands to the shell-quoted absolute installed path. The installed hook is a single self-contained file using only Node built-ins, so it stays easy to review when Codex asks you to trust it.

## session-status semantics

- `UserPromptSubmit` → session becomes `working` (and cancels a pending completion).
- `Stop` → after a 3-second settle window (cancelled by a newer prompt, deduped per turn) → `done` + `unread`.
- `codex exec`, subagents, and JSON automation sources are excluded entirely.
- State lives in `~/.local/state/raycast-codex-sessions/states.json` (max 500 sessions, atomic + locked). Readers (the Raycast extension) mark sessions seen by flipping `unread`.

The states.json schema and the lock protocol are shared with the Raycast extension and covered by the contract tests in [`test/contract`](../../test/contract) at the monorepo root.

## Tests

```sh
npm test
```

Tests run against a temporary `CODEX_HOME` / `XDG_STATE_HOME`; they never touch your real `~/.codex`.
