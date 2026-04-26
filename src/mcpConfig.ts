import { ChildProcess, execFile, execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  canUseMcpServerDefinitionProvider,
  fireExplorerMapMcpDefinitionsChanged,
  registerExplorerMapMcpDefinitionProvider,
} from './explorerMapMcpProvider';

export const EXPLORER_MAP_WORKSPACE_ROOT_ENV = 'EXPLORER_MAP_WORKSPACE_ROOT';
/** Key used in Cursor `mcp.json` under `mcpServers`. */
export const EXPLORER_MAP_MCP_SERVER_KEY = 'explorer-map-md';

const MCP_WANTED_STATE_KEY = 'apiGraphVisualizer.explorerMapMcp.wantsOn.v1';

export type ExplorerMapMcpEntry = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Spawns the server with this cwd (Cursor/VS Code stdio; matches forum guidance for reliable Agent tools). */
  cwd?: string;
};

export interface McpPanelSnapshot {
  serverKey: string;
  distPath: string;
  distExists: boolean;
  workspaceRoot: string | null;
  showRunnerTerminal: boolean;
  /** When true, MCP runs in a workspace Terminal tab (per project), not a hidden process. */
  runInProjectTerminal: boolean;
  /** Configured or resolved node used for `command` (see nodeResolved for absolute). */
  nodeCommand: string;
  nodeResolved: string;
  /**
   * When true, `~/.cursor/mcp.json` is also updated on toggle (only used if the
   * editor has no `registerMcpServerDefinitionProvider` API and MCP is configured via files).
   */
  writeGlobalMcp: boolean;
  /** Host has `registerMcpServerDefinitionProvider` (we still write mcp.json for Cursor’s Agent). */
  mcpUseProgrammaticMcp: boolean;
  /** User asked for the server on (from workspace state, or legacy migration from mcp.json). */
  mcpWanted: boolean;
  /** Wanted and runnable: workspace open, mcp dist present. */
  mcpServerActive: boolean;
  /** True if `explorer-map-md` is in workspace `.cursor/mcp.json` (file-based; optional when using API). */
  mcpRegisteredInProject: boolean;
  /** True if `explorer-map-md` is in `~/.cursor/mcp.json` (file-based). */
  mcpRegisteredInGlobal: boolean;
  /** Kept in sync with `mcpWanted` for the Features checkbox. */
  mcpEnabledAnywhere: boolean;
  projectMcpJsonPath: string | null;
  globalMcpJsonPath: string;
  /** Prettified JSON for Copy. */
  jsonConfig: string;
}

let mcpRunnerTerminal: vscode.Terminal | undefined;
/** Last boot command key for the project terminal; reset when terminal is disposed. */
let mcpProjectTerminalBootKey: string | undefined;
let mcpRunnerProcess: ChildProcess | undefined;
let mcpRunnerProcessKey: string | undefined;
let mcpLayerRegistered = false;
/** Clears any pending `setTimeout` re-syncs of Cursor MCP `state.vscdb` (see `scheduleDeferredCursorMcpStateResync`). */
let cancelDeferredCursorMcpResync: (() => void) | undefined;

function getMcpDistPath(extensionPath: string): string {
  const bundled = path.normalize(path.join(extensionPath, 'dist', 'mcp-md-handler', 'index.js'));
  if (fs.existsSync(bundled)) return bundled;
  return path.normalize(path.join(extensionPath, 'mcp-md-handler', 'dist', 'index.js'));
}

function getMcpReadmePath(extensionPath: string): string {
  const bundled = path.join(extensionPath, 'dist', 'mcp-md-handler', 'README.md');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(extensionPath, 'mcp-md-handler', 'README.md');
}

function getMcpHandlerFolder(extensionPath: string): string {
  const bundled = path.join(extensionPath, 'dist', 'mcp-md-handler');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(extensionPath, 'mcp-md-handler');
}

function getProjectMcpJsonPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.cursor', 'mcp.json');
}

function getGlobalMcpJsonPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function getCursorStateDbPath(): string | null {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb') : null;
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2500 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function getCursorProjectMcpServerIdentifier(wf: vscode.WorkspaceFolder): string {
  return `project-${wf.index}-${wf.name}-${EXPLORER_MAP_MCP_SERVER_KEY}`;
}

/**
 * Matches Cursor’s `MCPService#computeServerConfigHash` (see bundled workbench):
 * SHA-256 of `JSON.stringify` of { command, args, env, url, headers } with only
 * those keys that exist, in that order; first 16 hex chars of the digest.
 * Hash approval in `cursor/approvedProjectMcpServers` is `identifier:hash`.
 */
function computeCursorMcpConfigHashForApproval(entry: ExplorerMapMcpEntry): string {
  const t = ['command', 'args', 'env', 'url', 'headers'] as const;
  const o: Record<string, unknown> = {};
  for (const s of t) {
    if (s in entry && (entry as unknown as Record<string, unknown>)[s] !== undefined) {
      o[s] = (entry as unknown as Record<string, unknown>)[s];
    }
  }
  const r = JSON.stringify(o);
  return createHash('sha256').update(r, 'utf8').digest('hex').substring(0, 16);
}

let resolvedSqlite3: string | null | undefined;

function getSqlite3Executable(): string | null {
  if (resolvedSqlite3 !== undefined) {
    return resolvedSqlite3;
  }
  const tryPaths: string[] = [];
  if (process.platform === 'darwin') {
    tryPaths.push('/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3');
  } else if (process.platform === 'win32') {
    const p = process.env.ProgramFiles;
    if (p) {
      tryPaths.push(path.join(p, 'sqlite3', 'sqlite3.exe'));
    }
  } else {
    tryPaths.push('/usr/bin/sqlite3', '/bin/sqlite3');
  }
  for (const tryPath of tryPaths) {
    if (fs.existsSync(tryPath)) {
      resolvedSqlite3 = tryPath;
      return resolvedSqlite3;
    }
  }
  try {
    const bin = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(bin, ['sqlite3'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const first = out
      .trim()
      .split(/[\r\n]+/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (first && fs.existsSync(first)) {
      resolvedSqlite3 = first;
      return resolvedSqlite3;
    }
  } catch {
    /* optional CLI */
  }
  resolvedSqlite3 = null;
  return null;
}

async function updateCursorJsonArrayStateKey(
  sqlite3Path: string,
  dbPath: string,
  key: string,
  values: string[],
  mode: 'add' | 'remove'
): Promise<void> {
  const keySql = sqlString(key);
  const valuesSql = values.map(sqlString).join(', ');
  const addSelectSql = values.map((v) => `SELECT ${sqlString(v)}`).join(' UNION ');
  const sql =
    mode === 'add'
      ? `
WITH items(value) AS (
  SELECT value FROM json_each(COALESCE((SELECT value FROM ItemTable WHERE key = ${keySql}), '[]'))
  UNION
  ${addSelectSql}
)
INSERT OR REPLACE INTO ItemTable(key, value)
SELECT ${keySql}, json_group_array(value) FROM (SELECT DISTINCT value FROM items);
`
      : `
WITH items(value) AS (
  SELECT value FROM json_each(COALESCE((SELECT value FROM ItemTable WHERE key = ${keySql}), '[]'))
  WHERE value NOT IN (${valuesSql})
    AND NOT (${values.map((v) => `value LIKE ${sqlString(`${v}:%`)}`).join(' OR ')})
)
INSERT OR REPLACE INTO ItemTable(key, value)
SELECT ${keySql}, COALESCE(json_group_array(value), '[]') FROM (SELECT DISTINCT value FROM items);
`;
  await execFileAsync(sqlite3Path, [dbPath, sql]);
}

/**
 * Keep Cursor’s **Tools & MCP** enabled state in sync: `cursor/approvedProjectMcpServers` must
 * include either legacy `project-…-explorer-map-md` or `project-…-explorer-map-md:<configHash>`, and
 * the server id must not be listed in `cursor/disabledMcpServers` (and likewise `user-…` when global is used).
 */
async function syncCursorToolsMcpToggleState(
  wf: vscode.WorkspaceFolder,
  enabled: boolean,
  entry: ExplorerMapMcpEntry | null
): Promise<void> {
  const dbPath = getCursorStateDbPath();
  const sqlite3 = getSqlite3Executable();
  if (!dbPath || !fs.existsSync(dbPath) || !sqlite3) {
    return;
  }

  const projectId = getCursorProjectMcpServerIdentifier(wf);
  const userId = `user-${EXPLORER_MAP_MCP_SERVER_KEY}`;

  if (enabled) {
    const approved: string[] = [projectId];
    if (entry) {
      approved.push(`${projectId}:${computeCursorMcpConfigHashForApproval(entry)}`);
    }
    await updateCursorJsonArrayStateKey(sqlite3, dbPath, 'cursor/approvedProjectMcpServers', approved, 'add');
    await updateCursorJsonArrayStateKey(sqlite3, dbPath, 'cursor/disabledMcpServers', [projectId, userId], 'remove');
  } else {
    await updateCursorJsonArrayStateKey(sqlite3, dbPath, 'cursor/approvedProjectMcpServers', [projectId], 'remove');
    await updateCursorJsonArrayStateKey(sqlite3, dbPath, 'cursor/disabledMcpServers', [projectId, userId], 'add');
  }
}

/**
 * After window load, Cursor may re-read or rewrite `state.vscdb` and re-apply a prior **disabled** MCP
 * state, undoing a single early sync. Re-run the approved/disabled list updates a few times so the
 * server stays **On** in Tools & MCP when `getExplorerMapMcpWanted` is still true.
 */
function scheduleDeferredCursorMcpStateResync(context: vscode.ExtensionContext): void {
  cancelDeferredCursorMcpResync?.();
  const delaysMs = [1_500, 4_000, 8_000];
  const timeoutIds: ReturnType<typeof setTimeout>[] = [];
  const run = (): void => {
    void (async () => {
      if (!getExplorerMapMcpWanted(context)) {
        return;
      }
      const wf = vscode.workspace.workspaceFolders?.[0];
      if (!wf) {
        return;
      }
      const entry = getExplorerMapMcpEntry(context);
      if (!entry) {
        return;
      }
      try {
        await syncCursorToolsMcpToggleState(wf, true, entry);
      } catch (err) {
        console.warn('[Explorer Map] deferred Cursor MCP state sync failed:', err);
      }
    })();
  };
  for (const d of delaysMs) {
    timeoutIds.push(setTimeout(run, d));
  }
  cancelDeferredCursorMcpResync = () => {
    for (const id of timeoutIds) {
      clearTimeout(id);
    }
    cancelDeferredCursorMcpResync = undefined;
  };
}

function shouldWriteGlobalMcp(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.writeGlobalMcp') === true;
}

function shouldRunMcpInProjectTerminal(): boolean {
  return (
    vscode.workspace
      .getConfiguration('apiGraphVisualizer')
      .get<boolean>('mcp.runInProjectTerminal', false) === true
  );
}

function shouldAutoReloadWindowOnMcpToggle(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.autoReloadWindowOnToggle') !== false;
}

export function shouldShowMcpRunnerUi(): boolean {
  return (
    vscode.workspace
      .getConfiguration('apiGraphVisualizer')
      .get<boolean>('mcp.showRunnerTerminal', false) === true
  );
}

function getConfiguredNodeCommand(): string {
  const v = vscode.workspace
    .getConfiguration('apiGraphVisualizer')
    .get<string>('mcp.nodeExecutable');
  const t = (v ?? 'node').trim();
  return t.length ? t : 'node';
}

/**
 * Resolve `node` (or a bare name) to an absolute path so Cursor’s MCP runner can start the process
 * without the user’s shell PATH (nvm, etc.).
 */
export function resolveNodeForMcpSpawn(configured: string): string {
  const c = (configured || 'node').trim() || 'node';
  if (path.isAbsolute(c)) {
    return path.normalize(c);
  }
  if (c.includes(path.sep) || (process.platform === 'win32' && /\\/.test(c))) {
    return path.resolve(c);
  }
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [c], { encoding: 'utf8' });
      const first = out.trim().split(/\r?\n/)[0];
      return first && first.length > 0 ? first.trim() : c;
    }
    const w = execFileSync('which', [c], { encoding: 'utf8' });
    return w.trim() || c;
  } catch {
    return c;
  }
}

const COMMON_NODE_INSTALL_PATHS: string[] =
  process.platform === 'win32'
    ? ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];

/**
 * `command` in `.cursor/mcp.json` must be an **absolute** path: Cursor’s Agent MCP host often has no
 * shell `PATH` ([forum](https://forum.cursor.com/t/mcp-servers-configured-but-agent-cannot-use-their-tools/153150) — tools missing while server shows connected).
 * Try `which` in the extension host, then common install paths (Homebrew, system).
 */
function resolveNodeWithAbsoluteFallbacks(configured: string): string {
  const r = path.normalize(resolveNodeForMcpSpawn((configured || 'node').trim() || 'node'));
  if (path.isAbsolute(r) && fs.existsSync(r)) {
    return r;
  }
  for (const p of COMMON_NODE_INSTALL_PATHS) {
    try {
      if (fs.existsSync(p)) {
        return path.normalize(p);
      }
    } catch {
      /* */
    }
  }
  if (path.isAbsolute(r)) {
    return r;
  }
  return r;
}

export function resolveNodeForMcpConfigFile(): string {
  return resolveNodeWithAbsoluteFallbacks(getConfiguredNodeCommand());
}

/** True if `mcp.json` contains the stable `explorer-map-md` key or a legacy per-build alias `explorer-map-md-*`. */
function hasExplorerMapMcpKeyInServers(mcpServers: Record<string, unknown> | undefined): boolean {
  if (!mcpServers) return false;
  if (mcpServers[EXPLORER_MAP_MCP_SERVER_KEY] !== undefined && mcpServers[EXPLORER_MAP_MCP_SERVER_KEY] !== null) {
    return true;
  }
  return Object.keys(mcpServers).some(
    (k) => k.startsWith(`${EXPLORER_MAP_MCP_SERVER_KEY}-`) && mcpServers[k] !== undefined && mcpServers[k] !== null
  );
}

function isKeyInMcpFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return hasExplorerMapMcpKeyInServers(j.mcpServers);
  } catch {
    return false;
  }
}

export function isExplorerMapMcpInProjectFile(workspaceRoot: string | null): boolean {
  if (!workspaceRoot) return false;
  return isKeyInMcpFile(getProjectMcpJsonPath(workspaceRoot));
}

export function isExplorerMapMcpInGlobalFile(): boolean {
  return isKeyInMcpFile(getGlobalMcpJsonPath());
}

/**
 * If `mcp.json` already lists `explorer-map-md` but workspace state is unset, set state to on.
 * File entries are kept: Cursor’s Agent reads project/user `mcp.json` for tools, not only the
 * extension MCP provider.
 */
export async function syncProgrammaticMcpStateWithLegacyFiles(
  context: vscode.ExtensionContext
): Promise<void> {
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!wr) {
    return;
  }
  if (!isExplorerMapMcpInProjectFile(wr) && !isExplorerMapMcpInGlobalFile()) {
    return;
  }
  const s = context.workspaceState.get<boolean | undefined>(MCP_WANTED_STATE_KEY);
  if (s !== undefined) {
    return;
  }
  await context.workspaceState.update(MCP_WANTED_STATE_KEY, true);
  if (canUseMcpServerDefinitionProvider()) {
    fireExplorerMapMcpDefinitionsChanged();
  }
}

/**
 * MCP is on by default. Only `false` in workspace state turns it off (Features toggle).
 * Cursor scopes tools via this workspace’s `.cursor/mcp.json` (see https://cursor.com/docs/mcp).
 */
export function getExplorerMapMcpWanted(context: vscode.ExtensionContext): boolean {
  return context.workspaceState.get<boolean | undefined>(MCP_WANTED_STATE_KEY) !== false;
}

/**
 * On activation: write project `.cursor/mcp.json` (and global when configured) with the bundled stdio
 * entry, then refresh the in-process provider hook.
 * Cursor still lists the server from the project `mcp.json` entry. The programmatic provider also
 * returns a {@link vscode.McpStdioServerDefinition} (same as commit 99315a) so the host can start
 * the stdio process and expose tools when `getExplorerMapMcpWanted` is true.
 */
export async function applyExplorerMapMcpProjectSync(
  context: vscode.ExtensionContext
): Promise<void> {
  if (!getExplorerMapMcpWanted(context)) {
    return;
  }
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) {
    return;
  }
  const projectPath = getProjectMcpJsonPath(wf.uri.fsPath);
  const entry = getExplorerMapMcpEntry(context);
  if (!entry) {
    return;
  }
  if ((await applyExplorerMapKeyToFile(projectPath, entry)) === 'parse_error') {
    return;
  }
  if (shouldWriteGlobalMcp()) {
    await applyExplorerMapKeyToFile(getGlobalMcpJsonPath(), entry);
  }
  try {
    await syncCursorToolsMcpToggleState(wf, true, entry);
  } catch (err) {
    console.warn('[Explorer Map] Could not sync Cursor MCP enabled state:', err);
  }
  if (canUseMcpServerDefinitionProvider()) {
    fireExplorerMapMcpDefinitionsChanged();
  }
  scheduleDeferredCursorMcpStateResync(context);
}

/**
 * In-process definitions for `registerMcpServerDefinitionProvider`.
 * Matches the working setup from 99315a: when MCP is wanted and the handler exists, return the stdio
 * definition so the editor starts the process and tools are available (empty list = off).
 */
export function provideExplorerMapMcpDefinitions(
  context: vscode.ExtensionContext
): vscode.McpServerDefinition[] {
  if (!getExplorerMapMcpWanted(context)) {
    return [];
  }
  const entry = getExplorerMapMcpEntry(context);
  if (!entry) {
    return [];
  }
  const env: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(entry.env)) {
    env[k] = v;
  }
  const def = new vscode.McpStdioServerDefinition(
    EXPLORER_MAP_MCP_SERVER_KEY,
    entry.command,
    entry.args,
    env,
    '1'
  );
  if (entry.cwd) {
    def.cwd = vscode.Uri.file(entry.cwd);
  }
  return [def];
}

/**
 * Single MCP entry: bundled `mcp-md-handler/dist` next to the extension, absolute paths.
 * For file-based or programmatic registration.
 */
function getExplorerMapMcpEntry(context: vscode.ExtensionContext): ExplorerMapMcpEntry | null {
  const distPath = getMcpDistPath(context.extensionPath);
  if (!fs.existsSync(distPath)) return null;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!workspaceRoot) return null;
  const root = path.resolve(workspaceRoot);
  const distAbs = path.resolve(distPath);
  const command = resolveNodeForMcpConfigFile();
  return {
    type: 'stdio',
    command,
    args: [distAbs],
    env: { [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: root },
    cwd: root,
  };
}

/** Drop legacy per-installation keys (`explorer-map-md` + random suffix) so only the stable `explorer-map-md` entry remains. */
function scrubLegacyScopedExplorerMapKeys(mcpServers: Record<string, unknown>): void {
  for (const k of Object.keys(mcpServers)) {
    if (k.startsWith(`${EXPLORER_MAP_MCP_SERVER_KEY}-`)) {
      delete mcpServers[k];
    }
  }
}

/**
 * Read → merge/remove key → write. Shared by project and global mcp.json.
 * Strips any `explorer-map-md-*` keys before writing the single bundled server entry.
 */
async function applyExplorerMapKeyToFile(
  mcpFilePath: string,
  entry: ExplorerMapMcpEntry | null
): Promise<'ok' | 'parse_error'> {
  let data: { mcpServers?: Record<string, unknown> };
  if (fs.existsSync(mcpFilePath)) {
    const raw = await fsp.readFile(mcpFilePath, 'utf8');
    try {
      data = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch {
      return 'parse_error';
    }
  } else {
    data = {};
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  scrubLegacyScopedExplorerMapKeys(data.mcpServers);
  if (entry) {
    data.mcpServers[EXPLORER_MAP_MCP_SERVER_KEY] = entry as unknown as Record<string, unknown>;
  } else {
    delete data.mcpServers[EXPLORER_MAP_MCP_SERVER_KEY];
  }
  await fsp.mkdir(path.dirname(mcpFilePath), { recursive: true });
  await fsp.writeFile(mcpFilePath, JSON.stringify(data, null, 2), 'utf8');
  return 'ok';
}

/**
 * Turns the MCP server on or off: workspace state, **and** project `/.cursor/mcp.json`
 * (and optionally `~/.cursor/mcp.json`). Cursor’s Agent discovers tools from those files;
 * we also notify `registerMcpServerDefinitionProvider` when the host supports it.
 */
export async function setExplorerMapMcpEnabled(
  context: vscode.ExtensionContext,
  enabled: boolean
): Promise<void> {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) {
    void vscode.window.showWarningMessage('Open a workspace folder first.');
    return;
  }
  const projectPath = getProjectMcpJsonPath(wf.uri.fsPath);
  const globalPath = getGlobalMcpJsonPath();
  const writeGlobal = shouldWriteGlobalMcp();
  const useApi = canUseMcpServerDefinitionProvider();

  let toWrite: ExplorerMapMcpEntry | null = null;
  if (enabled) {
    toWrite = getExplorerMapMcpEntry(context);
    if (!toWrite) {
      void vscode.window.showWarningMessage(
        'Cannot enable: the extension’s mcp-md-handler (dist/index.js) is missing. Run npm run build in the extension repo (dev) or reinstall the extension.'
      );
      return;
    }
  }

  await context.workspaceState.update(MCP_WANTED_STATE_KEY, enabled);

  const errProject = await applyExplorerMapKeyToFile(projectPath, enabled ? toWrite : null);
  if (errProject === 'parse_error') {
    void context.workspaceState.update(MCP_WANTED_STATE_KEY, !enabled);
    void vscode.window.showErrorMessage(
      `Could not parse ${projectPath}. Fix JSON or back it up, then try again.`
    );
    return;
  }

  if (writeGlobal) {
    const errGlobal = await applyExplorerMapKeyToFile(globalPath, enabled ? toWrite : null);
    if (errGlobal === 'parse_error') {
      void vscode.window.showErrorMessage(
        `Could not parse ${globalPath}. Fix JSON or back it up. Project mcp was updated; global was not.`
      );
    }
  } else if (!enabled) {
    const errGlobal = await applyExplorerMapKeyToFile(globalPath, null);
    if (errGlobal === 'parse_error') {
      void vscode.window.showErrorMessage(
        `Could not parse ${globalPath}. Fix JSON or back it up. ${EXPLORER_MAP_MCP_SERVER_KEY} was removed from the project file only.`
      );
    }
  }

  try {
    await syncCursorToolsMcpToggleState(wf, enabled, enabled ? toWrite : null);
  } catch (err) {
    console.warn('[Explorer Map] Could not sync Cursor MCP enabled state:', err);
    void vscode.window.showWarningMessage(
      'Explorer Map wrote mcp.json, but could not sync Cursor’s Tools & MCP toggle. Use the Cursor toggle once if it still shows Disabled.'
    );
  }
  if (enabled) {
    scheduleDeferredCursorMcpStateResync(context);
  } else {
    cancelDeferredCursorMcpResync?.();
  }

  if (useApi) {
    fireExplorerMapMcpDefinitionsChanged();
  }
  if (!enabled) {
    stopAllMcpRunners();
  }

  if (enabled && toWrite && !path.isAbsolute(toWrite.command)) {
    void vscode.window.showWarningMessage(
      'MCP `command` in mcp.json should be an absolute path to `node` so Cursor can start the process. Set **Explorer Map › MCP: Node Executable** to a full path (e.g. output of `which node`), then toggle off and on again.'
    );
  }

  const gNote =
    writeGlobal || !enabled
      ? enabled
        ? ' Wrote project + ~/.cursor/mcp.json'
        : ' Removed key from project + ~/.cursor/mcp.json if present.'
      : ' Project .cursor/mcp.json only (enable apiGraphVisualizer.mcp.writeGlobalMcp for ~/.cursor).';

  if (shouldAutoReloadWindowOnMcpToggle()) {
    const reloadMsg = enabled
      ? `${EXPLORER_MAP_MCP_SERVER_KEY} on.${gNote} Cursor reads this from the project mcp file (and lists it under Installed MCP servers). Reloading…`
      : `${EXPLORER_MAP_MCP_SERVER_KEY} off.${gNote} Reloading the window…`;
    void vscode.window.showInformationMessage(reloadMsg);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  const coreMsg = enabled
    ? `Registered ${EXPLORER_MAP_MCP_SERVER_KEY} in mcp.json (stdio, absolute node).${gNote} Run Developer: Reload Window, then start a new chat.`
    : `Removed ${EXPLORER_MAP_MCP_SERVER_KEY} from mcp.json.${gNote} Reload the window to refresh.`;

  const mcpInfoMsg =
    coreMsg +
    (writeGlobal
      ? ''
      : ' Enable apiGraphVisualizer.mcp.writeGlobalMcp to also write ~/.cursor/mcp.json if needed.');
  const mcpInfoActions: string[] = ['Open project mcp.json'];
  if (writeGlobal) {
    mcpInfoActions.push('Open global mcp.json');
  }
  void vscode.window
    .showInformationMessage(mcpInfoMsg, ...mcpInfoActions)
    .then((choice) => {
      if (choice === 'Open project mcp.json') {
        void vscode.workspace.openTextDocument(vscode.Uri.file(projectPath)).then((d) => {
          void vscode.window.showTextDocument(d, { preview: true });
        });
      } else if (choice === 'Open global mcp.json' && writeGlobal) {
        void vscode.workspace.openTextDocument(vscode.Uri.file(globalPath)).then((d) => {
          void vscode.window.showTextDocument(d, { preview: true });
        });
      }
    });
}

export function getMcpPanelSnapshot(context: vscode.ExtensionContext): McpPanelSnapshot {
  const ext = context.extensionPath;
  const distPath = getMcpDistPath(ext);
  const distExists = fs.existsSync(distPath);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const cfgNode = getConfiguredNodeCommand();
  const nodeResolved = resolveNodeForMcpConfigFile();
  const writeGlobalMcp = shouldWriteGlobalMcp();
  const mcpUseProgrammaticMcp = canUseMcpServerDefinitionProvider();
  const mcpWanted = getExplorerMapMcpWanted(context);
  const mcpServerActive = mcpWanted && distExists && !!workspaceRoot;
  const mcpRegisteredInProject = isExplorerMapMcpInProjectFile(workspaceRoot);
  const mcpRegisteredInGlobal = isExplorerMapMcpInGlobalFile();
  const mcpEnabledAnywhere = mcpWanted;
  const projectMcpJsonPath = workspaceRoot ? getProjectMcpJsonPath(workspaceRoot) : null;
  const globalMcpJsonPath = getGlobalMcpJsonPath();
  const showRunnerTerminal = shouldShowMcpRunnerUi();
  const runInProjectTerminal = shouldRunMcpInProjectTerminal();
  const jsonConfig = buildCursorMcpConfigJsonObject(context);
  return {
    serverKey: EXPLORER_MAP_MCP_SERVER_KEY,
    distPath,
    distExists,
    workspaceRoot,
    showRunnerTerminal,
    runInProjectTerminal,
    nodeCommand: cfgNode,
    nodeResolved,
    writeGlobalMcp,
    mcpUseProgrammaticMcp,
    mcpWanted,
    mcpServerActive,
    mcpRegisteredInProject,
    mcpRegisteredInGlobal,
    mcpEnabledAnywhere,
    projectMcpJsonPath,
    globalMcpJsonPath,
    jsonConfig,
  };
}

function buildCursorMcpConfigJsonObject(context: vscode.ExtensionContext): string {
  const entry = getExplorerMapMcpEntry(context);
  if (!entry) {
    const n = resolveNodeForMcpConfigFile();
    return JSON.stringify(
      {
        mcpServers: {
          [EXPLORER_MAP_MCP_SERVER_KEY]: {
            type: 'stdio' as const,
            command: n,
            args: [path.resolve(getMcpDistPath(context.extensionPath))],
            env: { [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: 'OPEN_A_WORKSPACE_THEN_USE_THE_TOGGLE' },
            cwd: '${workspaceFolder}',
          },
        },
      },
      null,
      2
    );
  }
  return JSON.stringify(
    { mcpServers: { [EXPLORER_MAP_MCP_SERVER_KEY]: entry } },
    null,
    2
  );
}

/**
 * Safe for POSIX shells. Do not use path-like strings as placeholders in docs — users paste them
 * literally and get "Cannot find module '/path/to/...'".
 */
function bashSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function powerShellSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** True when the resolved node path is a single executable name (looked up on PATH), not a path. */
function isBareExecutableName(resolved: string): boolean {
  if (!resolved || !resolved.trim()) {
    return true;
  }
  if (path.isAbsolute(resolved)) {
    return false;
  }
  return !/[\\/]/.test(resolved);
}

/**
 * One line to run the bundled stdio server with real absolute paths (bash/zsh on macOS/Linux, PowerShell on Windows).
 * Follow MCP guidance: use absolute paths for `command` and `args` (and here for env).
 */
export function getMcpStdioSmokeTestCommandLine(context: vscode.ExtensionContext): string | null {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) {
    return null;
  }
  const dist = path.resolve(getMcpDistPath(context.extensionPath));
  if (!fs.existsSync(dist)) {
    return null;
  }
  const nodeResolved = resolveNodeForMcpConfigFile();
  const wr = path.resolve(wf.uri.fsPath);
  if (process.platform === 'win32') {
    const nodeInv = isBareExecutableName(nodeResolved)
      ? `& ${nodeResolved}`
      : `& ${powerShellSingleQuoted(path.normalize(nodeResolved))}`;
    return `$env:EXPLORER_MAP_WORKSPACE_ROOT=${powerShellSingleQuoted(
      wr
    )}; ${nodeInv} ${powerShellSingleQuoted(dist)}`;
  }
  const nodeInv = isBareExecutableName(nodeResolved)
    ? nodeResolved
    : bashSingleQuoted(path.normalize(nodeResolved));
  return `EXPLORER_MAP_WORKSPACE_ROOT=${bashSingleQuoted(wr)} ${nodeInv} ${bashSingleQuoted(dist)}`;
}

export async function copyMcpStdioTestCommandToClipboard(
  context: vscode.ExtensionContext
): Promise<void> {
  const line = getMcpStdioSmokeTestCommandLine(context);
  if (!line) {
    void vscode.window.showWarningMessage(
      'Open a workspace folder and ensure the extension is built (dist/mcp-md-handler/index.js must exist on disk).'
    );
    return;
  }
  await vscode.env.clipboard.writeText(line);
  void vscode.window.showInformationMessage(
    'Optional debugger copy (advanced). Normal use: leave the Explorer Map MCP switch on—Cursor runs the server from .cursor/mcp.json; do not run node in a terminal unless you are debugging.',
    'OK'
  );
}

export function buildCursorMcpConfigJson(opts: {
  distPath: string;
  workspaceRoot: string | null;
  command?: string;
}): string {
  const cmdInput =
    opts.command && opts.command.trim().length > 0 ? opts.command.trim() : getConfiguredNodeCommand();
  const nodeAbs = resolveNodeWithAbsoluteFallbacks(cmdInput);
  const ph =
    'Open a workspace in Cursor, then re-copy the MCP config (do not use path/to placeholders).';
  const wsRaw = opts.workspaceRoot;
  const hasRealWs = !!(wsRaw && !wsRaw.includes('Open a workspace'));
  const wsForEnv = hasRealWs && wsRaw ? path.resolve(wsRaw) : ph;
  const distN = path.resolve(opts.distPath);
  const entry: ExplorerMapMcpEntry = {
    type: 'stdio',
    command: nodeAbs,
    args: [distN],
    env: { [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: wsForEnv },
  };
  if (hasRealWs && wsRaw) {
    entry.cwd = path.resolve(wsRaw);
  }
  return JSON.stringify(
    { mcpServers: { [EXPLORER_MAP_MCP_SERVER_KEY]: entry } },
    null,
    2
  );
}

function disposeMcpProjectTerminal(): void {
  if (mcpRunnerTerminal) {
    try {
      mcpRunnerTerminal.dispose();
    } catch {
      /* ignore */
    }
    mcpRunnerTerminal = undefined;
  }
  mcpProjectTerminalBootKey = undefined;
}

export function initMcpRunnerTerminalReaper(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === mcpRunnerTerminal) {
        mcpRunnerTerminal = undefined;
        mcpProjectTerminalBootKey = undefined;
      }
    })
  );
}

export function registerExplorerMapMcpLayer(context: vscode.ExtensionContext): void {
  if (mcpLayerRegistered) return;
  mcpLayerRegistered = true;
  initMcpRunnerTerminalReaper(context);
  registerExplorerMapMcpDefinitionProvider(context, () => provideExplorerMapMcpDefinitions(context));
  context.subscriptions.push(
    new vscode.Disposable(() => {
      cancelDeferredCursorMcpResync?.();
    })
  );
}

function killBackgroundMcpRunner(): void {
  if (!mcpRunnerProcess) return;
  try {
    mcpRunnerProcess.kill();
  } catch {
    /* ignore */
  }
  mcpRunnerProcess = undefined;
  mcpRunnerProcessKey = undefined;
}

export function stopBackgroundMcpRunner(): void {
  killBackgroundMcpRunner();
}

/**
 * Starts a hidden MCP process (no terminal UI). Safe to call repeatedly.
 */
export function ensureBackgroundMcpRunner(
  context: vscode.ExtensionContext,
  workspaceRoot: string | null
): void {
  if (!workspaceRoot) return;
  const dist = getMcpDistPath(context.extensionPath);
  if (!fs.existsSync(dist)) return;
  if (!getExplorerMapMcpWanted(context)) {
    killBackgroundMcpRunner();
    return;
  }
  const nodeCmd = resolveNodeForMcpSpawn(getConfiguredNodeCommand());
  const processKey = `${nodeCmd}::${dist}::${workspaceRoot}`;
  if (mcpRunnerProcess && mcpRunnerProcess.exitCode === null && mcpRunnerProcessKey === processKey) {
    return;
  }
  killBackgroundMcpRunner();
  try {
    const child = spawn(nodeCmd, [dist], {
      cwd: workspaceRoot,
      env: { ...process.env, EXPLORER_MAP_WORKSPACE_ROOT: workspaceRoot },
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    child.unref();
    child.on('exit', () => {
      if (mcpRunnerProcess === child) {
        mcpRunnerProcess = undefined;
        mcpRunnerProcessKey = undefined;
      }
    });
    mcpRunnerProcess = child;
    mcpRunnerProcessKey = processKey;
  } catch {
    /* ignore */
  }
}

/**
 * Run MCP stdio in this workspace’s integrated terminal (cwd = project folder).
 * Cursor’s Agent also uses the project’s `.cursor/mcp.json` to spawn a process for tool calls; this terminal
 * is the per-project, visible process you can watch and is tied to the workspace folder only.
 */
function ensureProjectMcpRunnerTerminal(
  context: vscode.ExtensionContext,
  workspaceRoot: string | null
): void {
  if (!workspaceRoot) return;
  const dist = getMcpDistPath(context.extensionPath);
  if (!fs.existsSync(dist)) return;
  if (!getExplorerMapMcpWanted(context)) {
    disposeMcpProjectTerminal();
    return;
  }
  const nodeCmd = resolveNodeForMcpSpawn(getConfiguredNodeCommand());
  const bootKey = `${nodeCmd}::${dist}::${workspaceRoot}`;
  const label = path.basename(path.resolve(workspaceRoot)) || 'workspace';
  const termName = `Explorer Map MCP · ${label}`;

  if (mcpRunnerTerminal) {
    mcpRunnerTerminal.show(true);
    if (mcpProjectTerminalBootKey !== bootKey) {
      mcpProjectTerminalBootKey = bootKey;
      mcpRunnerTerminal.sendText(`${JSON.stringify(nodeCmd)} ${JSON.stringify(dist)}`, true);
    }
    return;
  }

  mcpRunnerTerminal = vscode.window.createTerminal({
    name: termName,
    cwd: workspaceRoot,
    env: { ...process.env, [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: workspaceRoot },
  });
  mcpProjectTerminalBootKey = bootKey;
  mcpRunnerTerminal.show(true);
  mcpRunnerTerminal.sendText(`${JSON.stringify(nodeCmd)} ${JSON.stringify(dist)}`, true);
}

export function stopAllMcpRunners(): void {
  stopBackgroundMcpRunner();
  disposeMcpProjectTerminal();
}

export function openMcpRunnerTerminal(context: vscode.ExtensionContext, workspaceRoot: string | null): void {
  if (!shouldShowMcpRunnerUi()) {
    return;
  }
  if (!workspaceRoot) {
    void vscode.window.showWarningMessage('Open a workspace folder first; EXPLORER_MAP_WORKSPACE_ROOT is taken from the first folder.');
    return;
  }
  const dist = getMcpDistPath(context.extensionPath);
  if (!fs.existsSync(dist)) {
    void vscode.window.showWarningMessage('mcp-md-handler is not built. Run: npm run build at the extension repo (or use the MCP toggle after build).');
    return;
  }
  if (shouldRunMcpInProjectTerminal()) {
    if (!getExplorerMapMcpWanted(context)) {
      void vscode.window.showInformationMessage('Turn on the Explorer Map MCP server in Features first.');
      return;
    }
    ensureProjectMcpRunnerTerminal(context, workspaceRoot);
    return;
  }
  ensureBackgroundMcpRunner(context, workspaceRoot);
  void vscode.window.showInformationMessage('Explorer Map MCP: running in headless mode (see Settings: runInProjectTerminal).');
}

export async function copyCursorMcpConfigToClipboard(context: vscode.ExtensionContext): Promise<void> {
  const snap = getMcpPanelSnapshot(context);
  await vscode.env.clipboard.writeText(snap.jsonConfig);
  const base =
    'MCP JSON copied. The Explorer Map switch updates .cursor/mcp.json so the server shows under **Installed MCP servers**; use this copy for sharing or backup.';
  const extra = snap.writeGlobalMcp
    ? ' Global ~/.cursor/mcp.json is also updated (optional).'
    : ' Enable apiGraphVisualizer.mcp.writeGlobalMcp only if you also need the same entry in user-level mcp.json.';
  void vscode.window.showInformationMessage(base + extra, 'Open README (troubleshooting)').then((choice) => {
    if (choice === 'Open README (troubleshooting)') {
      void openMcpReadme(context);
    }
  });
}

export async function revealMcpHandlerFolderInOs(context: vscode.ExtensionContext): Promise<void> {
  const p = getMcpHandlerFolder(context.extensionPath);
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
}

export async function openMcpReadme(context: vscode.ExtensionContext): Promise<void> {
  const p = getMcpReadmePath(context.extensionPath);
  if (!fs.existsSync(p)) {
    void vscode.window.showErrorMessage('Missing mcp-md-handler/README.md in the extension.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
  await vscode.window.showTextDocument(doc, { preview: true });
}
