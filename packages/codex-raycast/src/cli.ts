// Set up, inspect, and remove user-level Codex config patches.
//
// Each patch lives in patches/<name>/ with a patch.json manifest describing:
//   - files:         scripts copied into $CODEX_HOME (atomic, chmod)
//   - hooks:         entries merged into $CODEX_HOME/hooks.json (marker-based, idempotent)
//   - features:      flags ensured in $CODEX_HOME/config.toml [features]
//   - legacyMarkers/legacyFiles: remnants of earlier patch versions, cleaned up on setup
//
// The tool never touches unrelated hooks (e.g. Herdr's SessionStart), never edits
// `notify`, and never writes hook trust: after a script changes, Codex marks the
// hook untrusted and the user reviews it with /hooks. `status` and `doctor` exist
// to detect exactly that drift after a Codex version upgrade.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PATCHES_DIR = fileURLToPath(new URL('../patches', import.meta.url));

const KNOWN_TRUST_NAMES: Record<string, string> = {
  Stop: 'stop',
  UserPromptSubmit: 'user_prompt_submit',
  SessionStart: 'session_start',
};

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export class CliError extends Error {}

interface FileEntry {
  source: string;
  target: string;
  mode?: string;
}

interface HookSpec {
  command: string;
  timeout?: number;
}

export interface Patch {
  directory: string;
  name: string;
  description: string;
  marker: string;
  files: FileEntry[];
  hooks: Record<string, HookSpec>;
  features: Record<string, boolean>;
  legacyMarkers: string[];
  legacyFiles: string[];
}

export interface HooksConfig {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${RESET}` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function expandUser(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function codexHome(): string {
  return expandUser(process.env.CODEX_HOME || join(homedir(), '.codex'));
}

export function stateDir(): string {
  const root = expandUser(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'));
  return join(root, 'codex-raycast');
}

export function appliedStatePath(): string {
  return join(stateDir(), 'applied.json');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename completed and the temporary file is already gone.
    }
  }
}

export function trustName(event: string): string {
  if (event in KNOWN_TRUST_NAMES) return KNOWN_TRUST_NAMES[event];
  return event.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase();
}

// --- patches ------------------------------------------------------------------

export function loadPatch(directory: string): Patch {
  const manifest = JSON.parse(readFileSync(join(directory, 'patch.json'), 'utf8')) as Record<string, unknown>;
  return {
    directory,
    name: String(manifest.name),
    description: typeof manifest.description === 'string' ? manifest.description : '',
    marker: String(manifest.marker),
    files: (manifest.files as FileEntry[] | undefined) ?? [],
    hooks: (manifest.hooks as Record<string, HookSpec> | undefined) ?? {},
    features: (manifest.features as Record<string, boolean> | undefined) ?? {},
    legacyMarkers: (manifest.legacyMarkers as string[] | undefined) ?? [],
    legacyFiles: (manifest.legacyFiles as string[] | undefined) ?? [],
  };
}

export function targetPath(entry: FileEntry): string {
  return join(codexHome(), entry.target);
}

export function commandFor(patch: Patch, event: string): string {
  let command = String(patch.hooks[event].command);
  for (const entry of patch.files) {
    command = command.replaceAll(`\${${entry.source}}`, shellQuote(targetPath(entry)));
  }
  return command;
}

export function discoverPatches(names: string[] | null): Patch[] {
  const patches = readdirSync(PATCHES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PATCHES_DIR, entry.name, 'patch.json')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => loadPatch(join(PATCHES_DIR, entry.name)));
  if (!names || names.length === 0) return patches;
  const byName = new Map(patches.map((patch) => [patch.name, patch]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length) {
    throw new CliError(`Unknown patch(es): ${missing.join(', ')}. Available: ${[...byName.keys()].join(', ')}`);
  }
  return names.map((name) => byName.get(name) as Patch);
}

// --- hooks.json ---------------------------------------------------------------

export function hooksJsonPath(): string {
  return join(codexHome(), 'hooks.json');
}

export function readHooksConfig(): HooksConfig {
  const path = hooksJsonPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {};
    throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new CliError(`Malformed JSON in ${path}: ${(error as Error).message}. Refusing to touch it.`);
  }
  if (!isPlainObject(config) || ('hooks' in config && !isPlainObject(config.hooks))) {
    throw new CliError(`Malformed hooks configuration in ${path}. Refusing to touch it.`);
  }
  return config as HooksConfig;
}

export function writeHooksConfig(config: HooksConfig): void {
  atomicWrite(hooksJsonPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function containsMarker(value: unknown, marker: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsMarker(item, marker));
  if (isPlainObject(value)) {
    if (String(value.command ?? '').includes(marker)) return true;
    return Object.values(value).some((item) => containsMarker(item, marker));
  }
  return false;
}

export function eventHandlers(config: HooksConfig, event: string): unknown[] {
  const handlers = config.hooks?.[event] ?? [];
  if (!Array.isArray(handlers)) {
    throw new CliError(`Malformed hooks configuration: ${event} must be an array. Refusing to touch it.`);
  }
  return handlers;
}

export function addHandler(config: HooksConfig, event: string, command: string, timeout: number, marker: string): boolean {
  const handlers = eventHandlers(config, event);
  if (handlers.some((group) => containsMarker(group, marker))) return false;
  const hooks = (config.hooks ??= {});
  hooks[event] = [...handlers, { hooks: [{ type: 'command', command, timeout }] }];
  return true;
}

export function removeMarked(config: HooksConfig, event: string, marker: string): boolean {
  const hooks = config.hooks ?? {};
  const handlers = eventHandlers(config, event);
  if (!handlers.some((group) => containsMarker(group, marker))) return false;
  const cleaned: unknown[] = [];
  for (const group of handlers) {
    if (!isPlainObject(group)) {
      cleaned.push(group);
      continue;
    }
    const inner = (Array.isArray(group.hooks) ? group.hooks : []).filter((h) => !containsMarker(h, marker));
    if (inner.length) cleaned.push({ ...group, hooks: inner });
  }
  if (cleaned.length) hooks[event] = cleaned;
  else delete hooks[event];
  return true;
}

// --- config.toml features -------------------------------------------------------

export function configTomlPath(): string {
  return join(codexHome(), 'config.toml');
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function ensureFeature(config: string, key: string, value: boolean): string {
  const rendered = value ? 'true' : 'false';
  const lines = config.split('\n');
  let featuresStart = -1;
  let featuresEnd = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[index]);
    if (!header) continue;
    if (header[1].trim() === 'features') {
      featuresStart = index;
      continue;
    }
    if (featuresStart >= 0 && index > featuresStart) {
      featuresEnd = index;
      break;
    }
  }

  if (featuresStart < 0) {
    const prefix = !config || config.endsWith('\n') ? config : `${config}\n`;
    return `${prefix}[features]\n${key} = ${rendered}\n`;
  }

  const keyPattern = new RegExp(`^\\s*${regexEscape(key)}\\s*=`);
  for (let index = featuresStart + 1; index < featuresEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = lines[index].replace(
        new RegExp(`^(\\s*)${regexEscape(key)}\\s*=.*$`),
        `$1${key} = ${rendered}`,
      );
      return lines.join('\n');
    }
  }
  lines.splice(featuresStart + 1, 0, `${key} = ${rendered}`);
  return lines.join('\n');
}

export function ensureFeatures(features: Record<string, boolean>): boolean {
  const path = configTomlPath();
  let config: string;
  try {
    config = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    config = '';
  }
  let updated = config;
  for (const [key, value] of Object.entries(features)) {
    updated = ensureFeature(updated, key, value);
  }
  if (updated !== config || config === '') {
    atomicWrite(path, updated);
    return true;
  }
  return false;
}

// --- trust ----------------------------------------------------------------------

export function markedHandlerKeys(config: HooksConfig, patch: Patch): string[] {
  const sourcePath = hooksJsonPath();
  const keys: string[] = [];
  for (const event of Object.keys(patch.hooks)) {
    eventHandlers(config, event).forEach((group, groupIndex) => {
      if (!isPlainObject(group)) return;
      (Array.isArray(group.hooks) ? group.hooks : []).forEach((handler, handlerIndex) => {
        if (containsMarker(handler, patch.marker)) {
          keys.push(`${sourcePath}:${trustName(event)}:${groupIndex}:${handlerIndex}`);
        }
      });
    });
  }
  return keys;
}

export function trustedKeys(tomlText: string): Set<string> {
  const pattern = /\[hooks\.state\."(.+?)"\]\s+trusted_hash\s*=\s*"sha256:[0-9a-f]+"/g;
  return new Set([...tomlText.matchAll(pattern)].map((match) => match[1]));
}

export function patchTrusted(patch: Patch, config: HooksConfig): boolean {
  const keys = markedHandlerKeys(config, patch);
  if (keys.length !== Object.keys(patch.hooks).length) return false;
  let tomlText: string;
  try {
    tomlText = readFileSync(configTomlPath(), 'utf8');
  } catch {
    return false;
  }
  const trusted = trustedKeys(tomlText);
  return keys.every((key) => trusted.has(key));
}

// --- applied state ---------------------------------------------------------------

function which(name: string): string | null {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function codexVersion(): string {
  const binary = which('codex');
  if (!binary) return '';
  try {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    return (result.stdout || '').trim() || (result.stderr || '').trim();
  } catch {
    return '';
  }
}

export function readAppliedState(): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(appliedStatePath(), 'utf8')) as unknown;
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

function recordApplied(patch: Patch): void {
  const state = readAppliedState();
  state[patch.name] = {
    applied_at: new Date().toISOString(),
    codex_version: codexVersion(),
    files: Object.fromEntries(
      patch.files.map((entry) => [entry.source, sha256File(join(patch.directory, entry.source))]),
    ),
  };
  atomicWrite(appliedStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

// --- commands --------------------------------------------------------------------

function tryUnlink(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function filesInSync(patch: Patch): [boolean, boolean] {
  let installed = true;
  let inSync = true;
  for (const entry of patch.files) {
    const target = targetPath(entry);
    let targetIsFile = false;
    try {
      targetIsFile = statSync(target).isFile();
    } catch {
      targetIsFile = false;
    }
    if (!targetIsFile) {
      installed = false;
      inSync = false;
      continue;
    }
    if (sha256File(target) !== sha256File(join(patch.directory, entry.source))) inSync = false;
  }
  return [installed, inSync];
}

function legacyLeftovers(config: HooksConfig, patch: Patch): { events: string[]; files: string[] } {
  const events = new Set<string>();
  for (const marker of patch.legacyMarkers) {
    for (const event of Object.keys(config.hooks ?? {})) {
      if (eventHandlers(config, event).some((group) => containsMarker(group, marker))) events.add(event);
    }
  }
  const files = patch.legacyFiles.filter((file) => existsSync(join(codexHome(), file)));
  return { events: [...events], files };
}

export function cmdSetup(patches: Patch[], dryRun: boolean): number {
  for (const patch of patches) {
    const changes: string[] = [];
    const [, inSync] = filesInSync(patch);
    if (!inSync) changes.push('install script(s)');
    const config = readHooksConfig();
    const pendingEvents = Object.keys(patch.hooks).filter(
      (event) => !eventHandlers(config, event).some((group) => containsMarker(group, patch.marker)),
    );
    if (pendingEvents.length) changes.push(`add hooks: ${pendingEvents.join(', ')}`);
    const legacy = legacyLeftovers(config, patch);
    if (legacy.events.length || legacy.files.length) changes.push('remove legacy hook(s)');

    if (dryRun) {
      console.log(`${patch.name}: ${changes.length ? changes.join('; ') : 'no changes'}`);
      continue;
    }

    for (const entry of patch.files) {
      const target = targetPath(entry);
      atomicWrite(target, readFileSync(join(patch.directory, entry.source), 'utf8'));
      chmodSync(target, parseInt(entry.mode ?? '755', 8));
    }
    for (const [event, spec] of Object.entries(patch.hooks)) {
      addHandler(config, event, commandFor(patch, event), Number(spec.timeout ?? 10), patch.marker);
    }
    for (const marker of patch.legacyMarkers) {
      for (const event of Object.keys(config.hooks ?? {})) removeMarked(config, event, marker);
    }
    writeHooksConfig(config);
    ensureFeatures(patch.features);
    for (const file of patch.legacyFiles) tryUnlink(join(codexHome(), file));
    recordApplied(patch);

    console.log(`${patch.name}: ${changes.length ? changes.join('; ') : 'already set up (no changes)'}`);
    if (!inSync) {
      console.log(
        color(
          `  -> the ${patch.name} script changed: Codex now marks its hooks untrusted.\n` +
            '     Open Codex and run /hooks to review and re-trust them.',
          YELLOW,
        ),
      );
    }
  }
  return 0;
}

export function cmdRemove(patches: Patch[]): number {
  for (const patch of patches) {
    const config = readHooksConfig();
    let changed = false;
    for (const event of Object.keys(patch.hooks)) {
      changed = removeMarked(config, event, patch.marker) || changed;
    }
    for (const marker of patch.legacyMarkers) {
      for (const event of Object.keys(config.hooks ?? {})) changed = removeMarked(config, event, marker) || changed;
    }
    if (changed) writeHooksConfig(config);
    for (const entry of patch.files) tryUnlink(targetPath(entry));
    for (const file of patch.legacyFiles) tryUnlink(join(codexHome(), file));
    const state = readAppliedState();
    if (patch.name in state) {
      delete state[patch.name];
      atomicWrite(appliedStatePath(), `${JSON.stringify(state, null, 2)}\n`);
    }
    console.log(`${patch.name}: removed (features.hooks and other tools' hooks left untouched)`);
  }
  return 0;
}

export function cmdStatus(patches: Patch[]): number {
  const versionNow = codexVersion();
  const appliedState = readAppliedState();
  let drift = false;
  console.log(`CODEX_HOME: ${codexHome()}`);
  console.log(`codex: ${versionNow || 'not found on PATH'}`);
  for (const patch of patches) {
    const config = readHooksConfig();
    const [installed, inSync] = filesInSync(patch);
    const hooksOk = Object.keys(patch.hooks).every((event) =>
      eventHandlers(config, event).some((group) => containsMarker(group, patch.marker)),
    );
    const trusted = hooksOk ? patchTrusted(patch, config) : false;
    const applied = appliedState[patch.name];
    const appliedVersion = isPlainObject(applied) && typeof applied.codex_version === 'string' ? applied.codex_version : '';

    let verdict: string;
    if (installed && inSync && hooksOk && trusted) verdict = color('ok', GREEN);
    else if (installed && hooksOk) verdict = color('needs attention', YELLOW);
    else verdict = color('not set up', RED);
    console.log(`\n${patch.name}: ${verdict}`);
    console.log(`  script installed: ${installed}   in sync with package: ${inSync}`);
    console.log(`  hooks configured: ${hooksOk}   trusted: ${trusted}`);
    if (appliedVersion && versionNow && appliedVersion !== versionNow) {
      console.log(color(`  codex upgraded since last setup (${appliedVersion} -> ${versionNow}): run doctor`, YELLOW));
    }
    if (!inSync && installed) {
      console.log(color('  installed script differs from package: run setup, then re-trust via /hooks', YELLOW));
    }
    if (hooksOk && !trusted) {
      console.log(color('  hooks present but untrusted: open Codex and run /hooks to trust them', YELLOW));
    }
    const legacy = legacyLeftovers(config, patch);
    if (legacy.events.length || legacy.files.length) {
      console.log(color('  legacy python hook remnants found: run setup to migrate them', YELLOW));
      drift = true;
    }
    drift = drift || !(installed && inSync && hooksOk && trusted);
  }
  return drift ? 1 : 0;
}

async function liveHookReport(patches: Patch[]): Promise<void> {
  const binary = which('codex');
  if (!binary) {
    console.log('doctor: codex not on PATH; skipping live hooks/list check');
    return;
  }
  const markers = patches.map((patch) => patch.marker);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(binary, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (!stdout || !stdin) {
      console.log('doctor: could not talk to codex app-server; skipping live check');
      return;
    }
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    const send = (payload: unknown) => stdin.write(`${JSON.stringify(payload)}\n`);
    const recv = (targetId: number, timeoutMs = 15_000): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          lines.off('line', onLine);
          lines.off('close', onClose);
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, timeoutMs);
        const onLine = (line: string) => {
          let data: unknown;
          try {
            data = JSON.parse(line);
          } catch {
            return;
          }
          if (isPlainObject(data) && data.id === targetId) {
            cleanup();
            resolve(data);
          }
        };
        const onClose = () => {
          cleanup();
          resolve(null);
        };
        lines.on('line', onLine);
        lines.on('close', onClose);
      });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex-raycast', title: 'codex-raycast doctor', version: '1.0.0' },
        capabilities: {},
      },
    });
    if (!(await recv(1))) {
      console.log('doctor: app-server did not answer initialize; skipping live check');
      return;
    }
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [process.cwd()] } });
    const response = (await recv(2)) ?? {};
    let found = false;
    const result = isPlainObject(response.result) ? response.result : {};
    const data = Array.isArray(result.data) ? result.data : [];
    for (const entry of data) {
      const hooks = isPlainObject(entry) && Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        if (!isPlainObject(hook)) continue;
        const command = typeof hook.command === 'string' ? hook.command : '';
        if (markers.some((marker) => command.includes(marker))) {
          found = true;
          console.log(`doctor: codex sees ${hook.eventName}: trust=${hook.trustStatus} enabled=${hook.enabled}`);
        }
      }
    }
    if (!found) console.log('doctor: codex does not currently list any patched hooks');
  } catch (error) {
    console.log(`doctor: live check failed (${(error as Error)?.message ?? error})`);
  } finally {
    try {
      child?.kill();
    } catch {
      // Already exited.
    }
  }
}

export async function cmdDoctor(patches: Patch[]): Promise<number> {
  let exitCode = cmdStatus(patches);
  console.log();
  if (which('node')) {
    console.log('doctor: node available on PATH (required by hook commands)');
  } else {
    console.log(color('doctor: node NOT found on PATH - hook commands will fail', RED));
    exitCode = 1;
  }
  await liveHookReport(patches);
  return exitCode;
}

// --- entry point -------------------------------------------------------------------

const USAGE = `usage: codex-raycast <setup|remove|status|doctor> [patch ...] [--dry-run]

  setup    install/refresh the Codex hooks (idempotent); --dry-run previews
  remove   remove only the entries this tool owns
  status   what is installed, in sync, and trusted?
  doctor   status + live hooks/list check via codex app-server`;

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  let command = args[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command === 'apply') command = 'setup'; // compatibility alias
  if (!['setup', 'remove', 'status', 'doctor'].includes(command)) {
    console.error(USAGE);
    return 1;
  }
  const rest = args.slice(1);
  const dryRun = rest.includes('--dry-run');
  const flags = rest.filter((arg) => arg.startsWith('-'));
  const unknownFlags = flags.filter((arg) => arg !== '--dry-run');
  if (unknownFlags.length || (dryRun && command !== 'setup')) {
    console.error(USAGE);
    return 1;
  }
  const names = rest.filter((arg) => !arg.startsWith('-'));
  const patches = discoverPatches(names.length ? names : null);
  if (command === 'setup') return cmdSetup(patches, dryRun);
  if (command === 'remove') return cmdRemove(patches);
  if (command === 'status') return cmdStatus(patches);
  return cmdDoctor(patches);
}
