// Behaviour tests for the session-status hook, run as a real subprocess
// against a temporary state directory.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK_PATH = fileURLToPath(new URL('../patches/session-status/hook.mjs', import.meta.url));

let root: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-hook-test-'));
  stateDir = join(root, 'raycast-codex-sessions');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runHook(kind: 'prompt' | 'stop', payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, kind], {
      env: {
        ...process.env,
        RAYCAST_CODEX_STATE_DIR: stateDir,
        RAYCAST_CODEX_SETTLE_SECONDS: '0.2',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        expect(code, stderr).toBe(0);
        expect(stdout.trim()).toBe('{}');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function states(): Record<string, { status: string; unread: boolean }> {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'states.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function waitFor(sessionId: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = states()[sessionId];
    if (state && state.status === status) return state;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${sessionId} to become ${status}: ${JSON.stringify(states())}`);
}

describe('session-status hook', () => {
  it('marks prompt then stop as done + unread', async () => {
    await runHook('prompt', { session_id: 's1', cwd: '/tmp/p', source: 'cli' });
    let state = states().s1;
    expect(state.status).toBe('working');
    expect(state.unread).toBe(false);
    await runHook('stop', {
      hook_event_name: 'Stop',
      session_id: 's1',
      turn_id: 't1',
      cwd: '/tmp/p',
      source: 'cli',
    });
    state = await waitFor('s1', 'done');
    expect(state.unread).toBe(true);
    expect(state).not.toHaveProperty('message');
  });

  it('cancels a pending completion when a newer prompt arrives during settle', async () => {
    await runHook('stop', {
      hook_event_name: 'Stop',
      session_id: 's2',
      turn_id: 't1',
      cwd: '/tmp/p',
      source: 'cli',
    });
    await runHook('prompt', { session_id: 's2', cwd: '/tmp/p', source: 'cli' });
    await delay(600);
    expect(states().s2.status).toBe('working');
  });

  it('ignores exec and subagent sources', async () => {
    await runHook('prompt', { session_id: 's3', source: 'exec' });
    await runHook('stop', { hook_event_name: 'Stop', session_id: 's3', turn_id: 't1', source: 'exec' });
    await runHook('stop', {
      hook_event_name: 'Stop',
      session_id: 's4',
      turn_id: 't1',
      source: { subagent: 'review' },
    });
    await delay(600);
    expect(states()).not.toHaveProperty('s3');
    expect(states()).not.toHaveProperty('s4');
  });

  it('ignores stop_hook_active events', async () => {
    await runHook('stop', {
      hook_event_name: 'Stop',
      session_id: 's5',
      turn_id: 't1',
      stop_hook_active: true,
    });
    await delay(600);
    expect(states()).not.toHaveProperty('s5');
  });
});
