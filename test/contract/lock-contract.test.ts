// Lock-protocol contract: while one side holds the `states.json.lock`
// directory, the other side must block (retrying) instead of failing, and
// proceed once the lock is released. Stale-lock reclaim is covered in
// session-status.contract.test.ts.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadSessionStates,
  markSessionSeen,
  sessionStatesPath,
} from '../../packages/raycast-extension/src/lib/session-status';

const HOOK_PATH = fileURLToPath(
  new URL('../../packages/codex-raycast/patches/session-status/hook.mjs', import.meta.url),
);

let root: string;
let stateDir: string;
let savedStateDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-lock-contract-'));
  stateDir = join(root, 'raycast-codex-sessions');
  savedStateDir = process.env.RAYCAST_CODEX_STATE_DIR;
  process.env.RAYCAST_CODEX_STATE_DIR = stateDir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.RAYCAST_CODEX_STATE_DIR;
  else process.env.RAYCAST_CODEX_STATE_DIR = savedStateDir;
  rmSync(root, { recursive: true, force: true });
});

function lockPath(): string {
  return `${sessionStatesPath()}.lock`;
}

function seedDoneUnread(sessionId: string): void {
  const path = sessionStatesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      [sessionId]: {
        status: 'done',
        unread: true,
        updatedAt: new Date().toISOString(),
        turnId: 't1',
        cwd: '/tmp/project',
        source: 'cli',
      },
    }),
  );
}

function runHookPrompt(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, 'prompt'], {
      env: { ...process.env, RAYCAST_CODEX_STATE_DIR: stateDir },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hook exited with ${code}: ${stderr}`));
    });
    child.stdin.write(JSON.stringify({ session_id: sessionId, cwd: '/tmp/project', source: 'cli' }));
    child.stdin.end();
  });
}

describe('lock blocking contract', () => {
  it('the extension waits while the hook holds the lock, then proceeds', async () => {
    seedDoneUnread('s1');
    mkdirSync(lockPath(), { recursive: true });

    let settled = false;
    const pending = markSessionSeen('s1').then(() => {
      settled = true;
    });
    await delay(150);
    expect(settled).toBe(false);

    rmSync(lockPath(), { recursive: true, force: true });
    await pending;
    expect((await loadSessionStates()).s1.unread).toBe(false);
  });

  it('the hook waits while the extension holds the lock, then proceeds', async () => {
    mkdirSync(lockPath(), { recursive: true });
    const hookRun = runHookPrompt('s1');
    await delay(150);
    rmSync(lockPath(), { recursive: true, force: true });
    await hookRun;
    expect(JSON.parse(readFileSync(sessionStatesPath(), 'utf8')).s1.status).toBe('working');
  });
});
