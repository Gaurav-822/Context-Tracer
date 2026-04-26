import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  canUseMcpServerDefinitionProvider,
  fireExplorerMapMcpDefinitionsChanged,
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
};

export interface McpPanelSnapshot {
  distPath: string;
  distExists: boolean;
  workspaceRoot: string | null;
  showRunnerTerminal: boolean;
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

function getMcpDistPath(extensionPath: string): string {
  return path.normalize(path.join(extensionPath, 'mcp-md-handler', 'dist', 'index.js'));
}

function getMcpReadmePath(extensionPath: string): string {
  return path.join(extensionPath, 'mcp-md-handler', 'README.md');
}

function getMcpHandlerFolder(extensionPath: string): string {
  return path.join(extensionPath, 'mcp-md-handler');
}

function getProjectMcpJsonPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.cursor', 'mcp.json');
}

function getGlobalMcpJsonPath(): string {
  return path.join(os.homedir(), '.cursor', 'mcp.json');
}

function shouldWriteGlobalMcp(): boolean {
  return vscode.workspace.getConfiguration('apiGraphVisualizer').get<boolean>('mcp.writeGlobalMcp') !== false;
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

function isKeyInMcpFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const j = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const entry = j.mcpServers?.[EXPLORER_MAP_MCP_SERVER_KEY];
    return entry !== undefined && entry !== null;
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

/** User intent: on (workspace state) or legacy rows in mcp files before state was saved. */
export function getExplorerMapMcpWanted(context: vscode.ExtensionContext): boolean {
  const v = context.workspaceState.get<boolean | undefined>(MCP_WANTED_STATE_KEY);
  if (v === true || v === false) {
    return v;
  }
  const wr = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  if (!wr) {
    return false;
  }
  if (isExplorerMapMcpInProjectFile(wr) || isExplorerMapMcpInGlobalFile()) {
    void context.workspaceState.update(MCP_WANTED_STATE_KEY, true).then(() => {
      if (canUseMcpServerDefinitionProvider()) {
        fireExplorerMapMcpDefinitionsChanged();
      }
    });
    return true;
  }
  return false;
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
  return [new vscode.McpStdioServerDefinition(EXPLORER_MAP_MCP_SERVER_KEY, entry.command, entry.args, env, '1')];
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
  const root = wf.uri.fsPath;
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

  if (useApi) {
    fireExplorerMapMcpDefinitionsChanged();
  }

  const gNote =
    writeGlobal || !enabled
      ? enabled
        ? ' Wrote project + ~/.cursor/mcp.json'
        : ' Removed key from project + ~/.cursor/mcp.json if present.'
      : ' Project .cursor/mcp.json only (enable apiGraphVisualizer.mcp.writeGlobalMcp for ~/.cursor).';

  if (shouldAutoReloadWindowOnMcpToggle()) {
    const reloadMsg = enabled
      ? `${EXPLORER_MAP_MCP_SERVER_KEY} on.${gNote} Reloading window so MCP and Agent pick up changes — start a new chat afterward.`
      : `${EXPLORER_MAP_MCP_SERVER_KEY} off.${gNote} Reloading window…`;
    void vscode.window.showInformationMessage(useApi ? `${reloadMsg} (Provider notified.)` : reloadMsg);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  const coreMsg = enabled
    ? `Registered ${EXPLORER_MAP_MCP_SERVER_KEY} (stdio, absolute node).${gNote} Run Developer: Reload Window, then start a new chat and check Settings → MCP.`
    : `Removed ${EXPLORER_MAP_MCP_SERVER_KEY}.${gNote} Reload the window to refresh.`;

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
  const distPath = getMcpDistPath(ext);
  const distExists = fs.existsSync(distPath);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const cfgNode = getConfiguredNodeCommand();
  const nodeResolved = resolveNodeForMcpSpawn(cfgNode);
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
  const jsonConfig = buildCursorMcpConfigJsonObject(context);
  return {
    distPath,
    distExists,
    workspaceRoot,
    showRunnerTerminal,
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
    return JSON.stringify(
      {
        mcpServers: {
          [EXPLORER_MAP_MCP_SERVER_KEY]: {
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
    { mcpServers: { [EXPLORER_MAP_MCP_SERVER_KEY]: entry } },
    null,
    2
  );
}

export function buildCursorMcpConfigJson(opts: {
  distPath: string;
  workspaceRoot: string | null;
  command?: string;
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
  return JSON.stringify(
    { mcpServers: { [EXPLORER_MAP_MCP_SERVER_KEY]: entry } },
    null,
    2
  );
}

export function initMcpRunnerTerminalReaper(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === mcpRunnerTerminal) {
        mcpRunnerTerminal = undefined;
      }
    })
  );
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
  if (!mcpRunnerTerminal) {
    mcpRunnerTerminal = vscode.window.createTerminal({ name: 'Explorer Map MCP' });
  }
  mcpRunnerTerminal.show(true);
  const nodeCmd = resolveNodeForMcpSpawn(getConfiguredNodeCommand());
  const inner = `require('child_process').spawn(${JSON.stringify(nodeCmd)}, [${JSON.stringify(dist)}], { stdio: 'inherit', env: { ...process.env, EXPLORER_MAP_WORKSPACE_ROOT: ${JSON.stringify(workspaceRoot)} } })`;
  mcpRunnerTerminal.sendText(`${JSON.stringify(nodeCmd)} -e ${JSON.stringify(inner)}`, true);
}

export async function copyCursorMcpConfigToClipboard(context: vscode.ExtensionContext): Promise<void> {
  const snap = getMcpPanelSnapshot(context);
  await vscode.env.clipboard.writeText(snap.jsonConfig);
  const base =
    'MCP config copied (stdio + absolute node + env). The checkmark also writes project/global mcp.json; use that first.';
  const extra = snap.writeGlobalMcp
    ? ''
    : ' With apiGraphVisualizer.mcp.writeGlobalMcp off, add this block to mcp files yourself or turn the setting on.';
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
