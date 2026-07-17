// Cross-package contract tests: the codex-raycast hook (writer) and the Raycast
// extension's session-status module (reader, and writer of the `unread` flag)
// must agree on the states.json schema and the directory-based lock protocol.
// The hook runs as a real subprocess, exactly as Codex would invoke it.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  root = mkdtempSync(join(tmpdir(), 'codex-contract-test-'));
  stateDir = join(root, 'raycast-codex-sessions');
  savedStateDir = process.env.RAYCAST_CODEX_STATE_DIR;
  process.env.RAYCAST_CODEX_STATE_DIR = stateDir;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.RAYCAST_CODEX_STATE_DIR;
  else process.env.RAYCAST_CODEX_STATE_DIR = savedStateDir;
  rmSync(root, { recursive: true, force: true });
});

function runHook(kind: 'prompt' | 'stop', payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, kind], {
      env: { ...process.env, RAYCAST_CODEX_STATE_DIR: stateDir, RAYCAST_CODEX_SETTLE_SECONDS: '0.2' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hook ${kind} exited with ${code}: ${stderr}`));
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function waitForStatus(sessionId: string, status: 'working' | 'done') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = (await loadSessionStates())[sessionId];
    if (state && state.status === status) return state;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${sessionId} to reach ${status}`);
}

describe('states.json contract', () => {
  it('the extension parses a working state written by the hook', async () => {
    await runHook('prompt', { session_id: 'c1', cwd: '/tmp/project', source: 'cli' });
    const state = (await loadSessionStates()).c1;
    expect(state).toBeDefined();
    expect(state.status).toBe('working');
    expect(state.unread).toBe(false);
    expect(state.cwd).toBe('/tmp/project');
    expect(state.source).toBe('cli');
    expect(typeof state.turnId).toBe('string');
    expect(Number.isNaN(Date.parse(state.updatedAt))).toBe(false);
  });

  it('done+unread flows through markSessionSeen and a duplicate Stop stays seen', async () => {
    await runHook('stop', { hook_event_name: 'Stop', session_id: 'c2', turn_id: 't1', cwd: '/tmp/p', source: 'cli' });
    const done = await waitForStatus('c2', 'done');
    expect(done.unread).toBe(true);

    await markSessionSeen('c2');
    expect((await loadSessionStates()).c2.unread).toBe(false);

    // A duplicate Stop for the same turn must not resurrect the unread flag.
    await runHook('stop', { hook_event_name: 'Stop', session_id: 'c2', turn_id: 't1', cwd: '/tmp/p', source: 'cli' });
    await delay(600);
    expect((await loadSessionStates()).c2.unread).toBe(false);
  });

  it('the hook preserves entries in an extension-written file', async () => {
    await runHook('stop', { hook_event_name: 'Stop', session_id: 'c3', turn_id: 't1', cwd: '/tmp/p', source: 'cli' });
    await waitForStatus('c3', 'done');
    await markSessionSeen('c3'); // rewrites states.json through the extension's writer

    await runHook('prompt', { session_id: 'c4', cwd: '/tmp/q', source: 'vscode' });
    const states = await loadSessionStates();
    expect(states.c3.status).toBe('done');
    expect(states.c3.unread).toBe(false);
    expect(states.c4.status).toBe('working');
  });

  it('both sides reclaim a stale lock directory', async () => {
    await runHook('stop', { hook_event_name: 'Stop', session_id: 'c5', turn_id: 't1', cwd: '/tmp/p', source: 'cli' });
    await waitForStatus('c5', 'done');

    const lockPath = `${sessionStatesPath()}.lock`;
    const past = new Date(Date.now() - 60_000);

    mkdirSync(lockPath);
    utimesSync(lockPath, past, past);
    await markSessionSeen('c5'); // the extension reclaims a stale lock left by the hook
    expect((await loadSessionStates()).c5.unread).toBe(false);

    mkdirSync(lockPath);
    utimesSync(lockPath, past, past);
    await runHook('prompt', { session_id: 'c5', cwd: '/tmp/p', source: 'cli' }); // and the hook reclaims one too
    expect((await loadSessionStates()).c5.status).toBe('working');
  });
});
