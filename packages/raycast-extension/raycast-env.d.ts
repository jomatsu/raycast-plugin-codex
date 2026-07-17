/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Codex CLI Path - Absolute path to the codex binary. Leave empty to auto-detect. */
  "codexCliPath"?: string,
  /** Terminal for Resume - Terminal application used by Resume in Terminal */
  "terminalApp": "Terminal" | "iTerm"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-sessions` command */
  export type SearchSessions = ExtensionPreferences & {}
  /** Preferences accessible in the `open-project` command */
  export type OpenProject = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `search-sessions` command */
  export type SearchSessions = {}
  /** Arguments passed to the `open-project` command */
  export type OpenProject = {}
}

