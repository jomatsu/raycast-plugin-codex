# Codex Sessions

Monorepo for the Codex Sessions tooling:

| Package | What it is | Distribution |
| --- | --- | --- |
| [`packages/raycast-extension`](packages/raycast-extension) | macOS Raycast extension for finding local Codex sessions and opening projects in Codex Desktop | Raycast Store |
| [`packages/codex-raycast`](packages/codex-raycast) | `codex-raycast` CLI that sets up the Codex session-status hook the extension reads | npm (`npx codex-raycast setup`) |

The two packages share a contract: the hook (writer) maintains `~/.local/state/raycast-codex-sessions/states.json` and the Raycast extension (reader) joins it onto Codex's SQLite session catalog, flipping `unread` when a session is opened. The states.json schema and the directory-based lock protocol are verified by cross-package contract tests in [`test/contract`](test/contract).

## Development

```sh
npm install          # installs all workspaces
npm test             # workspace unit tests + contract tests
npm run typecheck    # tsc for every package
npm run build        # ray build (extension) + tsc (codex-raycast)
npm run lint         # ray lint for the extension
```

Per-package instructions live in each package's README.
