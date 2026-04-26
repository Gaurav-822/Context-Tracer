import { ChildProcess, execFileSync, spawn } from 'child_process';
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
const LEGACY_EXPLORER_MAP_MCP_SERVER_KEY = EXPLORER_MAP_MCP_SERVER_KEY;

const MCP_WANTED_STATE_KEY = 'apiGraphVisualizer.explorerMapMcp.wantsOn.v1';

export type ExplorerMapMcpEntry = {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
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

function shortStableHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function getScopedMcpServerKey(context: vscode.ExtensionContext): string {
  const token = `${context.extension.id}::${context.extensionPath}`;
  return `${EXPLORER_MAP_MCP_SERVER_KEY}-${shortStableHash(token)}`;
}

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

function shouldWriteGlobalMcp(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.writeGlobalMcp') === true;
}

function shouldRunMcpInProjectTerminal(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.runInProjectTerminal') !== false;
}

function shouldAutoReloadWindowOnMcpToggle(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.autoReloadWindowOnToggle') !== false;
}

export function shouldShowMcpRunnerUi(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.showRunnerTerminal') !== false;
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

function isAnyMcpKeyInFile(filePath: string, keys: string[]): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return keys.some((k) => {
      const entry = j.mcpServers?.[k];
      return entry !== undefined && entry !== null;
    });
  } catch {
    return false;
  }
}

export function isExplorerMapMcpInProjectFile(
  context: vscode.ExtensionContext,
  workspaceRoot: string | null
): boolean {
  if (!workspaceRoot) return false;
  return isAnyMcpKeyInFile(getProjectMcpJsonPath(workspaceRoot), [
    getScopedMcpServerKey(context),
    LEGACY_EXPLORER_MAP_MCP_SERVER_KEY,
  ]);
}

export function isExplorerMapMcpInGlobalFile(context: vscode.ExtensionContext): boolean {
  return isAnyMcpKeyInFile(getGlobalMcpJsonPath(), [
    getScopedMcpServerKey(context),
    LEGACY_EXPLORER_MAP_MCP_SERVER_KEY,
  ]);
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
  if (!isExplorerMapMcpInProjectFile(context, wr) && !isExplorerMapMcpInGlobalFile(context)) {
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

/** User intent only. MCP is off by default and legacy mcp.json entries do not auto-enable it. */
export function getExplorerMapMcpWanted(context: vscode.ExtensionContext): boolean {
  const v = context.workspaceState.get<boolean | undefined>(MCP_WANTED_STATE_KEY);
  return v === true;
}

/**
 * Definitions for {@link vscode.lm.registerMcpServerDefinitionProvider}. When this returns
 * an empty list, the editor does not start the MCP process (server is off). When the user
 * toggles on, we fire the change event so the host refreshes the stdio process and tools.
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
  const serverKey = getScopedMcpServerKey(context);
  return [new vscode.McpStdioServerDefinition(serverKey, entry.command, entry.args, env, '1')];
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
  const configured = getConfiguredNodeCommand();
  const command = resolveNodeForMcpSpawn(configured);
  return {
    type: 'stdio',
    command,
    args: [distPath],
    env: { [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: workspaceRoot },
  };
}

/**
 * Read → merge/remove key → write. Shared by project and global mcp.json.
 */
async function applyExplorerMapKeyToFile(
  mcpFilePath: string,
  serverKey: string,
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
  if (entry) {
    data.mcpServers[serverKey] = entry as unknown as Record<string, unknown>;
    if (serverKey !== LEGACY_EXPLORER_MAP_MCP_SERVER_KEY) {
      delete data.mcpServers[LEGACY_EXPLORER_MAP_MCP_SERVER_KEY];
    }
  } else {
    delete data.mcpServers[serverKey];
    delete data.mcpServers[LEGACY_EXPLORER_MAP_MCP_SERVER_KEY];
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
  const root = wf.uri.fsPath;
  const serverKey = getScopedMcpServerKey(context);
  const projectPath = getProjectMcpJsonPath(root);
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

  const errProject = await applyExplorerMapKeyToFile(projectPath, serverKey, enabled ? toWrite : null);
  if (errProject === 'parse_error') {
    void context.workspaceState.update(MCP_WANTED_STATE_KEY, !enabled);
    void vscode.window.showErrorMessage(
      `Could not parse ${projectPath}. Fix JSON or back it up, then try again.`
    );
    return;
  }

  if (writeGlobal) {
    const errGlobal = await applyExplorerMapKeyToFile(globalPath, serverKey, enabled ? toWrite : null);
    if (errGlobal === 'parse_error') {
      void vscode.window.showErrorMessage(
        `Could not parse ${globalPath}. Fix JSON or back it up. Project mcp was updated; global was not.`
      );
    }
  } else if (!enabled) {
    const errGlobal = await applyExplorerMapKeyToFile(globalPath, serverKey, null);
    if (errGlobal === 'parse_error') {
      void vscode.window.showErrorMessage(
        `Could not parse ${globalPath}. Fix JSON or back it up. ${serverKey} was removed from the project file only.`
      );
    }
  }

  if (useApi) {
    fireExplorerMapMcpDefinitionsChanged();
  }
  if (enabled) {
    ensureMcpRunnerForWorkspace(context, root);
  } else {
    stopAllMcpRunners();
  }

  const gNote =
    writeGlobal || !enabled
      ? enabled
        ? ' Wrote project + ~/.cursor/mcp.json'
        : ' Removed key from project + ~/.cursor/mcp.json if present.'
      : ' Project .cursor/mcp.json only (enable apiGraphVisualizer.mcp.writeGlobalMcp for ~/.cursor).';

  if (shouldAutoReloadWindowOnMcpToggle()) {
    const reloadMsg = enabled
      ? `${serverKey} on.${gNote} Reloading window so MCP and Agent pick up changes — start a new chat afterward.`
      : `${serverKey} off.${gNote} Reloading window…`;
    void vscode.window.showInformationMessage(useApi ? `${reloadMsg} (Provider notified.)` : reloadMsg);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  const coreMsg = enabled
    ? `Registered ${serverKey} (stdio, absolute node).${gNote} Run Developer: Reload Window, then start a new chat and check Settings → MCP.`
    : `Removed ${serverKey}.${gNote} Reload the window to refresh.`;

  const mcpInfoMsg = useApi
    ? `${coreMsg} (In-process provider was notified too.)`
    : coreMsg + (writeGlobal
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
  const serverKey = getScopedMcpServerKey(context);
  const distPath = getMcpDistPath(ext);
  const distExists = fs.existsSync(distPath);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const cfgNode = getConfiguredNodeCommand();
  const nodeResolved = resolveNodeForMcpSpawn(cfgNode);
  const writeGlobalMcp = shouldWriteGlobalMcp();
  const mcpUseProgrammaticMcp = canUseMcpServerDefinitionProvider();
  const mcpWanted = getExplorerMapMcpWanted(context);
  const mcpServerActive = mcpWanted && distExists && !!workspaceRoot;
  const mcpRegisteredInProject = isExplorerMapMcpInProjectFile(context, workspaceRoot);
  const mcpRegisteredInGlobal = isExplorerMapMcpInGlobalFile(context);
  const mcpEnabledAnywhere = mcpWanted;
  const projectMcpJsonPath = workspaceRoot ? getProjectMcpJsonPath(workspaceRoot) : null;
  const globalMcpJsonPath = getGlobalMcpJsonPath();
  const showRunnerTerminal = shouldShowMcpRunnerUi();
  const runInProjectTerminal = shouldRunMcpInProjectTerminal();
  const jsonConfig = buildCursorMcpConfigJsonObject(context);
  return {
    serverKey,
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
  const serverKey = getScopedMcpServerKey(context);
  const entry = getExplorerMapMcpEntry(context);
  if (!entry) {
    return JSON.stringify(
      {
        mcpServers: {
          [serverKey]: {
            type: 'stdio' as const,
            command: 'node',
            args: [getMcpDistPath(context.extensionPath)],
            env: { [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: 'OPEN_A_WORKSPACE_THEN_USE_THE_TOGGLE' },
          },
        },
      },
      null,
      2
    );
  }
  return JSON.stringify(
    { mcpServers: { [serverKey]: entry } },
    null,
    2
  );
}

export function buildCursorMcpConfigJson(opts: {
  distPath: string;
  workspaceRoot: string | null;
  command?: string;
  serverKey?: string;
}): string {
  const cmd = (opts.command && opts.command.trim().length) ? opts.command.trim() : 'node';
  const nodeAbs = resolveNodeForMcpSpawn(cmd);
  const ws = opts.workspaceRoot ?? 'REPLACE_WITH_YOUR_WORKSPACE_FOLDER';
  const distN = path.normalize(opts.distPath);
  const entry: ExplorerMapMcpEntry = {
    type: 'stdio',
    command: nodeAbs,
    args: [distN],
    env: { [EXPLORER_MAP_WORKSPACE_ROOT_ENV]: ws },
  };
  const serverKey = (opts.serverKey && opts.serverKey.trim()) || EXPLORER_MAP_MCP_SERVER_KEY;
  return JSON.stringify(
    { mcpServers: { [serverKey]: entry } },
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

/**
 * Picks per-project terminal or headless child process from settings.
 */
export function ensureMcpRunnerForWorkspace(
  context: vscode.ExtensionContext,
  workspaceRoot: string | null
): void {
  if (!workspaceRoot) return;
  if (!getExplorerMapMcpWanted(context)) {
    stopAllMcpRunners();
    return;
  }
  if (shouldRunMcpInProjectTerminal()) {
    killBackgroundMcpRunner();
    ensureProjectMcpRunnerTerminal(context, workspaceRoot);
  } else {
    disposeMcpProjectTerminal();
    ensureBackgroundMcpRunner(context, workspaceRoot);
  }
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
    'MCP config copied (stdio + absolute node + env). By default only this workspace’s .cursor/mcp.json is written so tools stay project-scoped.';
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
