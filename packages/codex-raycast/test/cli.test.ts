// Tests for the codex-raycast CLI. Everything runs against a temporary
// CODEX_HOME / XDG_STATE_HOME; the real ~/.codex is never touched.

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cmdRemove,
  cmdSetup,
  discoverPatches,
  markedHandlerKeys,
  patchTrusted,
  readHooksConfig,
} from '../src/cli';

const HOOK_PATH = fileURLToPath(new URL('../patches/session-status/hook.mjs', import.meta.url));
const INSTALLED_NAME = 'codex-raycast-session-hook.mjs';
const LEGACY_NAME = 'raycast-codex-completion-hook.py';

let root: string;
let codexHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-raycast-test-'));
  codexHome = join(root, '.codex');
  mkdirSync(codexHome, { recursive: true });
  for (const key of ['CODEX_HOME', 'XDG_STATE_HOME', 'RAYCAST_CODEX_STATE_DIR']) {
    savedEnv[key] = process.env[key];
  }
  process.env.CODEX_HOME = codexHome;
  process.env.XDG_STATE_HOME = join(root, '.state');
  delete process.env.RAYCAST_CODEX_STATE_DIR;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function patch() {
  return discoverPatches(['session-status'])[0];
}

function hooksJson() {
  return JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'));
}

describe('setup and remove', () => {
  it('preserves existing hooks and is idempotent', () => {
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'herdr-session-start' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'other-stop-handler' }] }],
        },
      }),
    );
    writeFileSync(join(codexHome, 'config.toml'), 'notify = "SkyComputerUseClient"\n\n[features]\nother = true\n');

    cmdSetup([patch()], false);
    const config = hooksJson();
    expect(config.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'herdr-session-start' }] }]);
    expect(config.hooks.Stop).toHaveLength(2);
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain('notify = "SkyComputerUseClient"');
    expect(toml).toContain('[features]\nhooks = true');
    const installed = join(codexHome, INSTALLED_NAME);
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(HOOK_PATH, 'utf8'));
    expect(() => accessSync(installed, constants.X_OK)).not.toThrow();

    cmdSetup([patch()], false);
    expect(hooksJson().hooks.Stop).toHaveLength(2);
  });

  it('creates missing config.toml', () => {
    cmdSetup([patch()], false);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe('[features]\nhooks = true\n');
  });

  it('does not confuse a top-level hooks key in config.toml', () => {
    writeFileSync(join(codexHome, 'config.toml'), 'hooks = "top-level"\n[features]\nother = false\n');
    cmdSetup([patch()], false);
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain('hooks = "top-level"');
    expect(toml).toContain('[features]\nhooks = true');
  });

  it('refuses to touch malformed hooks.json', () => {
    writeFileSync(join(codexHome, 'hooks.json'), '{ malformed');
    expect(() => cmdSetup([patch()], false)).toThrow(/Refusing to touch it/);
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toBe('{ malformed');
  });

  it('removes only marked entries', () => {
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'herdr' }] }] } }),
    );
    cmdSetup([patch()], false);
    const before = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    cmdRemove([patch()]);
    const config = hooksJson();
    expect(config.hooks).toEqual({ SessionStart: [{ hooks: [{ type: 'command', command: 'herdr' }] }] });
    expect(existsSync(join(codexHome, INSTALLED_NAME))).toBe(false);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(before);
  });

  it('changes nothing on dry-run', () => {
    cmdSetup([patch()], true);
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
    expect(existsSync(join(codexHome, INSTALLED_NAME))).toBe(false);
  });

  it('migrates away the legacy python hook on setup', () => {
    const legacyCommand = `python3 '${join(codexHome, LEGACY_NAME)}' stop`;
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'other-stop-handler' }] },
            { hooks: [{ type: 'command', command: legacyCommand, timeout: 10 }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: legacyCommand.replace(' stop', ' prompt'), timeout: 10 }] },
          ],
        },
      }),
    );
    writeFileSync(join(codexHome, LEGACY_NAME), '# legacy hook\n');

    cmdSetup([patch()], false);
    const config = hooksJson();
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain(LEGACY_NAME);
    expect(serialized).toContain('other-stop-handler');
    expect(serialized).toContain(INSTALLED_NAME);
    expect(config.hooks.Stop).toHaveLength(2);
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
    expect(existsSync(join(codexHome, LEGACY_NAME))).toBe(false);
    expect(existsSync(join(codexHome, INSTALLED_NAME))).toBe(true);
  });
});

describe('trust status', () => {
  it('detects trust from config.toml hook state', () => {
    cmdSetup([patch()], false);
    expect(patchTrusted(patch(), readHooksConfig())).toBe(false);

    const hooksPath = join(codexHome, 'hooks.json');
    const tomlPath = join(codexHome, 'config.toml');
    writeFileSync(
      tomlPath,
      readFileSync(tomlPath, 'utf8') +
        `\n[hooks.state."${hooksPath}:stop:0:0"]\ntrusted_hash = "sha256:0abc"\n` +
        `\n[hooks.state."${hooksPath}:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:0def"\n`,
    );
    expect(patchTrusted(patch(), readHooksConfig())).toBe(true);
  });

  it('tracks group indexes in trust keys', () => {
    writeFileSync(
      join(codexHome, 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }),
    );
    cmdSetup([patch()], false);
    const keys = markedHandlerKeys(readHooksConfig(), patch());
    const hooksPath = join(codexHome, 'hooks.json');
    expect(keys).toContain(`${hooksPath}:stop:1:0`);
    expect(keys).toContain(`${hooksPath}:user_prompt_submit:0:0`);
  });
});
