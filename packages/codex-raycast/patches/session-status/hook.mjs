#!/usr/bin/env node
// Codex session-status hook for the Codex Sessions Raycast extension.
//
// Installed into $CODEX_HOME by `npx codex-raycast setup` and invoked by Codex as
// `node <this file> prompt` (UserPromptSubmit) and `node <this file> stop` (Stop).
// It maintains ~/.local/state/raycast-codex-sessions/states.json, which the
// extension reads; the extension also writes (flipping `unread`), so the states
// schema, the mkdir-based lock protocol, and the 500-entry prune limit here must
// stay compatible with the extension's session-status module. Cross-package
// contract tests in the monorepo enforce that.
//
// Self-contained on purpose: Node built-ins only, no imports from the package —
// users review this single file when trusting the hook via /hooks.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const MAX_STATES = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function stateDir() {
  const override = (process.env.RAYCAST_CODEX_STATE_DIR || '').trim();
  if (override) return expandHome(override);
  const root = (process.env.XDG_STATE_HOME || '').trim() || path.join(os.homedir(), '.local', 'state');
  return path.join(expandHome(root), 'raycast-codex-sessions');
}

function statesPath() {
  return path.join(stateDir(), 'states.json');
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex').slice(0, 32);
}

function sessionKey(payload) {
  return String(payload.session_id || payload.sessionId || 'unknown-session');
}

function turnKey(payload) {
  return String(payload.turn_id || payload.turnId || payload.turn || 'unknown-turn');
}

function promptMarkerPath(sessionId) {
  return path.join(stateDir(), `prompt-${safeId(sessionId)}.marker`);
}

function pendingPath(sessionId, turnId) {
  return path.join(stateDir(), `pending-${safeId(sessionId)}-${safeId(turnId)}.json`);
}

function atomicWrite(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o644);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename completed and the temporary file is already gone.
    }
  }
}

// Directory-based lock shared with the Raycast extension (mkdir is atomic on
// APFS; stale locks are reclaimed after 30 seconds).
async function withStatesLock(callback) {
  const lockPath = `${statesPath()}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const lock = fs.statSync(lockPath);
        if (Date.now() - lock.mtimeMs > 30_000) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch {
        // The other process released the lock between checks.
      }
      await sleep(5);
    }
  }
  if (!acquired) throw new Error(`Unable to acquire session state lock: ${lockPath}`);
  try {
    return await callback(statesPath());
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // Already released.
    }
  }
}

function isState(value) {
  if (!isObject(value)) return false;
  return (
    (value.status === 'working' || value.status === 'done') &&
    typeof value.unread === 'boolean' &&
    typeof value.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(value.updatedAt)) &&
    typeof value.turnId === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.source === 'string'
  );
}

function readStates(statesFile) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(statesFile, 'utf8'));
  } catch {
    return {};
  }
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => isState(item)));
}

function stateTimestamp(state) {
  const timestamp = Date.parse(state.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function pruneStates(states) {
  const entries = Object.entries(states);
  if (entries.length <= MAX_STATES) return states;
  entries.sort(([, first], [, second]) => stateTimestamp(second) - stateTimestamp(first));
  return Object.fromEntries(entries.slice(0, MAX_STATES));
}

function sameState(first, second) {
  const keys = ['status', 'unread', 'updatedAt', 'turnId', 'cwd', 'source'];
  return (
    Object.keys(first).length === keys.length &&
    Object.keys(second).length === keys.length &&
    keys.every((key) => first[key] === second[key])
  );
}

async function updateState(sessionId, state) {
  return withStatesLock(async (statesFile) => {
    const states = readStates(statesFile);
    const previous = states[sessionId];
    if (previous && sameState(previous, state)) return false;
    states[sessionId] = state;
    atomicWrite(statesFile, JSON.stringify(pruneStates(states)));
    return true;
  });
}

async function currentState(sessionId) {
  return withStatesLock(async (statesFile) => readStates(statesFile)[sessionId]);
}

// Wall-clock nanoseconds as BigInt: marker and pending tokens exceed
// Number.MAX_SAFE_INTEGER, so they are stored and compared as BigInt.
function nowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

function writeMarker(sessionId) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const markerFile = promptMarkerPath(sessionId);
  let previous = 0n;
  try {
    previous = BigInt(fs.readFileSync(markerFile, 'utf8').trim() || '0');
  } catch {
    previous = 0n;
  }
  const now = nowNs();
  const token = now > previous ? now : previous + 1n;
  const fd = fs.openSync(markerFile, 'w');
  try {
    fs.writeSync(fd, String(token));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function sourceValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
    if (isObject(value)) return JSON.stringify(value);
  }
  return '';
}

function payloadFromTranscript(payload) {
  const transcript = payload.transcript_path || payload.transcriptPath;
  if (typeof transcript !== 'string' || !transcript) return {};
  let firstLine;
  try {
    // The session meta line is small; a 64 KiB head always contains it.
    const fd = fs.openSync(transcript, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      firstLine = buffer.toString('utf8', 0, bytes).split('\n', 1)[0];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  if (!firstLine) return {};
  try {
    const value = JSON.parse(firstLine);
    const meta = isObject(value) ? value.payload : null;
    return isObject(meta) ? meta : {};
  } catch {
    return {};
  }
}

function classify(payload) {
  const metadata = payloadFromTranscript(payload);
  const source = sourceValue(metadata.source, payload.source, payload.client);
  const threadSource = stringValue(metadata.thread_source, payload.thread_source);
  return { source, threadSource };
}

function isFilteredSource(source, threadSource) {
  return (
    source.trim().toLowerCase() === 'exec' ||
    threadSource.trim().toLowerCase() === 'subagent' ||
    source.trimStart().startsWith('{')
  );
}

function payloadState(payload, status, unread, source) {
  return {
    status,
    unread,
    updatedAt: new Date().toISOString(),
    turnId: turnKey(payload),
    cwd: stringValue(payload.cwd, payload.working_directory),
    source: source !== undefined ? source : sourceValue(payload.source, payload.client),
  };
}

function settleMs() {
  const raw = Number.parseFloat(process.env.RAYCAST_CODEX_SETTLE_SECONDS ?? '3');
  const seconds = Number.isNaN(raw) ? 3 : Math.max(0, raw);
  return seconds * 1000;
}

function pendingToken(payload, pendingFile) {
  const raw = payload._pending_created_ns;
  if (typeof raw === 'string' && raw) return BigInt(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.trunc(raw));
  return fs.statSync(pendingFile, { bigint: true }).mtimeNs;
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

async function processPending(pendingFile) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    removeQuietly(pendingFile);
    return;
  }

  try {
    await sleep(settleMs());

    const sessionId = sessionKey(payload);
    try {
      const markerToken = BigInt(fs.readFileSync(promptMarkerPath(sessionId), 'utf8').trim() || '0');
      if (markerToken > pendingToken(payload, pendingFile)) return;
    } catch {
      // No newer prompt marker: proceed.
    }

    const { source, threadSource } = classify(payload);
    if (isFilteredSource(source, threadSource)) return;

    const turnId = turnKey(payload);
    const previous = await currentState(sessionId);
    if (previous && previous.status === 'done' && previous.turnId === turnId) return;
    await updateState(sessionId, payloadState(payload, 'done', true, source));
  } finally {
    removeQuietly(pendingFile);
  }
}

// O_EXCL create guarantees a single settle processor per (session, turn).
function createPending(pendingFile, payload) {
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  try {
    fs.writeFileSync(pendingFile, JSON.stringify(payload), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function runHook(kind) {
  let value = null;
  try {
    value = JSON.parse(readStdin());
  } catch {
    value = null;
  }
  if (!isObject(value)) {
    print('{}');
    return 0;
  }

  const sessionId = sessionKey(value);
  if (kind === 'prompt') {
    const { source, threadSource } = classify(value);
    if (isFilteredSource(source, threadSource)) {
      print('{}');
      return 0;
    }
    writeMarker(sessionId);
    await updateState(sessionId, payloadState(value, 'working', false, source));
    print('{}');
    return 0;
  }

  if (value.hook_event_name !== 'Stop' || value.stop_hook_active === true) {
    print('{}');
    return 0;
  }

  const pendingFile = pendingPath(sessionId, turnKey(value));
  const pending = { ...value, _pending_created_ns: String(nowNs()) };
  if (createPending(pendingFile, pending)) {
    try {
      const child = spawn(process.execPath, [selfPath, '--process', pendingFile], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => removeQuietly(pendingFile));
      child.unref();
    } catch {
      removeQuietly(pendingFile);
    }
  }
  print('{}');
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const processIndex = argv.indexOf('--process');
  if (processIndex !== -1 && argv[processIndex + 1]) {
    await processPending(argv[processIndex + 1]);
    return 0;
  }
  const kind = argv.find((argument) => argument === 'stop' || argument === 'prompt');
  if (!kind) {
    print('{}');
    return 0;
  }
  return runHook(kind);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
