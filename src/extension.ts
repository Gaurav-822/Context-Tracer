import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileDropTreeProvider, relPathFromWorkspaceTreeId, scanSavedBacktrackedJson, toFileNamedBasename } from './fileDropTree';
import type { GraphData, GraphSnapshot } from './types';
import type { GraphPanelLoadMode, UpsertSessionMessage } from './graphPanel';
import {
  SearchSidebarViewProvider,
  SidebarTreeNode,
  relPathFromWorkspace,
} from './searchSidebarView';
import { getUsedLocalImportSpecsInRange } from './usedImports';

// Heavy modules loaded lazily on first use (keeps activation instant).
async function lazyGraphPanel() { return import('./graphPanel'); }
async function lazyFileGraphBuilder() { return import('./fileGraphBuilder'); }
async function lazyBacktrackClosure() { return import('./backtrackClosure'); }
async function lazyBacktrackMerge() { return import('./backtrackMerge'); }
async function lazyGitHeat() { return import('./gitHeat'); }
let mcpConfigModulePromise: Promise<typeof import('./mcpConfig')> | undefined;
async function lazyMcpConfig() {
  mcpConfigModulePromise ??= import('./mcpConfig');
  return mcpConfigModulePromise;
}

let _GraphPanel: typeof import('./graphPanel').GraphPanel | undefined;
function getGraphPanel(): typeof import('./graphPanel').GraphPanel | undefined {
  return _GraphPanel;
}
async function ensureGraphPanel() {
  if (!_GraphPanel) {
    const mod = await lazyGraphPanel();
    _GraphPanel = mod.GraphPanel;
  }
  return _GraphPanel;
}

/** Latest graph JSON in memory per open Import graph tab (for backtrack save). */
const graphDataByJsonPath = new Map<string, GraphData>();
const pendingImportEdgesByJsonPath = new Map<string, Array<{ fromRelPath: string; toRelPath: string }>>();

/** Last on-disk graph JSON opened (Saved / legacy). */
let lastJsonPath: string | undefined;
/** In-memory import graph session key (`__liveImport__:wfN:rel/path.tsx`). */
let lastLiveSessionKey: string | undefined;

function makeLiveImportSessionKey(workspaceFolderIndex: number, relPathPosix: string): string {
  return `__liveImport__:wf${workspaceFolderIndex}:${relPathPosix.replace(/\\/g, '/')}`;
}

function parseLiveImportSessionKey(key: string): { wfIndex: number; relPath: string } | null {
  const m = key.match(/^__liveImport__:wf(\d+):(.+)$/);
  if (!m) return null;
  return { wfIndex: parseInt(m[1], 10), relPath: m[2] };
}

function workspaceIndexForAbsPath(absPath: string, effectiveRoot: string): number {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return 0;
  const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
  if (wf) return Math.max(0, folders.indexOf(wf));
  const norm = path.normalize(absPath);
  for (let i = 0; i < folders.length; i++) {
    const r = folders[i].uri.fsPath;
    if (norm === r || norm.startsWith(r + path.sep)) return i;
  }
  for (let i = 0; i < folders.length; i++) {
    if (effectiveRoot === folders[i].uri.fsPath) return i;
  }
  return 0;
}

function sessionJsonBasenameForSave(sourceJsonPath: string): string {
  const live = parseLiveImportSessionKey(sourceJsonPath);
  if (live) return toFileNamedBasename(live.relPath);
  return path.basename(sourceJsonPath);
}
let fileDropProvider: FileDropTreeProvider;
let searchSidebarProvider: SearchSidebarViewProvider;
let fileDropTreeView: vscode.TreeView<vscode.TreeItem> | undefined;
/** Filled when Explorer Map sidebar starts dragging a file; graph webview often gets empty dataTransfer for internal drags. */
let pendingSidebarDragPaths: string[] | null = null;
let pendingSidebarDragAt = 0;
const PENDING_SIDEBAR_DRAG_TTL_MS = 20_000;
let untitledGraphCounter = 1;
const customSessionLabelsByPath = new Map<string, string>();
let workspaceSelectionCurrentAbsPath: string | undefined;
let workspaceSelectionPreviousAbsPath: string | undefined;
let pendingGraphPlacement:
  | { routeId: string; sourceJsonPath: string; dropX: number; dropY: number }
  | null = null;
const traceReductionBackupByTarget = new Map<string, GraphSnapshot>();
let tracedSelectionDecorationType: vscode.TextEditorDecorationType | undefined;
let tracedSelectionDecorationEditorUri: string | undefined;
type TracedSelectionTarget = { sourceJsonPath: string; routeId: string; nodeId: string };
type TracedSelectionContext = { range: vscode.Range; targets: TracedSelectionTarget[] };
const tracedSelectionContextByEditorUri = new Map<string, TracedSelectionContext>();

function traceReductionBackupKey(sourceJsonPath: string, routeId: string, nodeId: string): string {
  return `${sourceJsonPath}::${routeId}::${normalizeGraphNodePath(nodeId)}`;
}

function pushWorkspaceSelection(absPath: string, trackAsUserInteraction = true): void {
  const normalized = path.normalize(absPath);
  if (trackAsUserInteraction) {
    if (workspaceSelectionCurrentAbsPath && workspaceSelectionCurrentAbsPath !== normalized) {
      workspaceSelectionPreviousAbsPath = workspaceSelectionCurrentAbsPath;
    }
    workspaceSelectionCurrentAbsPath = normalized;
  }
  searchSidebarProvider.postWorkspaceSelection(normalized);
}

async function undoWorkspaceSelection(): Promise<void> {
  if (!workspaceSelectionPreviousAbsPath) {
    vscode.window.showInformationMessage('No previous workspace selection to restore.');
    return;
  }
  const previous = workspaceSelectionPreviousAbsPath;
  workspaceSelectionPreviousAbsPath = workspaceSelectionCurrentAbsPath;
  workspaceSelectionCurrentAbsPath = previous;
  searchSidebarProvider.postWorkspaceSelection(previous);
}

const MD_FEATURE_FILES = new Set([
  'skills.md',
  'learnings.md',
  'architecture.md',
  'mistakes.md',
  'working.md',
]);

/** Keep in sync with `MCP_WANTED_STATE_KEY` in mcpConfig.ts (lazy-loaded). */
const EXPLORER_MAP_MCP_WANTED_STATE_KEY = 'apiGraphVisualizer.explorerMapMcp.wantsOn.v1';

/** Best-effort: open Cursor/VS Code UI where the user can enable MCP servers and per-server tools. */
async function openCursorMcpSettingsPage(): Promise<void> {
  const tryCmd = async (id: string, ...args: unknown[]) => {
    try {
      await vscode.commands.executeCommand(id, ...args);
      return true;
    } catch {
      return false;
    }
  };
  if (await tryCmd('workbench.action.openSettings', 'MCP')) {
    return;
  }
  if (await tryCmd('workbench.action.openSettings', 'mcp')) {
    return;
  }
  if (await tryCmd('workbench.view.extension.mcp.view')) {
    return;
  }
  await tryCmd('workbench.action.openGlobalSettings');
  void vscode.window.showInformationMessage(
    'In Cursor, open **Cursor Settings** → **Tools & MCP** (or search “MCP” in settings). Turn **on** the Explorer Map server and each of its tools, then **fully quit and restart** Cursor, and start a **new** chat so tools from this server appear (GitKraken, Sentry, etc. can use up the tool budget).'
  );
}

function getMcpDisabledSnapshot(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const mcpC = vscode.workspace.getConfiguration('apiGraphVisualizer.mcp');
  const mcpWanted = context.workspaceState.get<boolean | undefined>(EXPLORER_MAP_MCP_WANTED_STATE_KEY) !== false;
  return {
    serverKey: 'explorer-map-md',
    distPath: path.join(context.extensionPath, 'dist', 'mcp-md-handler', 'index.js'),
    distExists: false,
    workspaceRoot,
    showRunnerTerminal: mcpC.get<boolean>('showRunnerTerminal', false) === true,
    runInProjectTerminal: mcpC.get<boolean>('runInProjectTerminal', false) === true,
    nodeCommand: 'node',
    nodeResolved: 'node',
    writeGlobalMcp: mcpC.get<boolean>('writeGlobalMcp', false) === true,
    mcpUseProgrammaticMcp: false,
    mcpWanted,
    mcpServerActive: mcpWanted && !!workspaceRoot,
    mcpRegisteredInProject: false,
    mcpRegisteredInGlobal: false,
    mcpEnabledAnywhere: mcpWanted,
    projectMcpJsonPath: workspaceRoot ? path.join(workspaceRoot, '.cursor', 'mcp.json') : null,
    globalMcpJsonPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
    jsonConfig: '{}',
  };
}

async function getMcpSnapshotIfLoaded(context: vscode.ExtensionContext) {
  if (!mcpConfigModulePromise) return getMcpDisabledSnapshot(context);
  try {
    const mcp = await mcpConfigModulePromise;
    return mcp.getMcpPanelSnapshot(context);
  } catch {
    return getMcpDisabledSnapshot(context);
  }
}

async function withMcpLayer<T>(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  fn: (mcp: typeof import('./mcpConfig')) => Promise<T> | T
): Promise<T | undefined> {
  try {
    const mcp = await lazyMcpConfig();
    mcp.registerExplorerMapMcpLayer(context);
    return await fn(mcp);
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    log.appendLine(`[mcp] ${message}`);
    void vscode.window.showErrorMessage('Explorer Map MCP failed. Core Explorer Map features are still available.');
    return undefined;
  }
}

async function readOrCreateWorkspaceMd(extensionUri: vscode.Uri, workspaceRoot: vscode.Uri, fileName: string): Promise<string> {
  if (!MD_FEATURE_FILES.has(fileName)) return '';
  const mdDir = vscode.Uri.joinPath(workspaceRoot, 'md');
  const target = vscode.Uri.joinPath(mdDir, fileName);
  const defaultUri = vscode.Uri.joinPath(extensionUri, 'media', 'md-defaults', fileName);
  try {
    await vscode.workspace.fs.createDirectory(mdDir);
  } catch {
    /* exists */
  }
  try {
    const data = await vscode.workspace.fs.readFile(target);
    return Buffer.from(data).toString('utf8');
  } catch {
    let text = `# ${fileName.replace(/\.md$/i, '')}\n\n`;
    try {
      const def = await vscode.workspace.fs.readFile(defaultUri);
      text = Buffer.from(def).toString('utf8');
    } catch {
      /* minimal heading only */
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    return text;
  }
}

async function saveWorkspaceMdFile(_extensionUri: vscode.Uri, fileName: string, content: string): Promise<boolean> {
  if (!MD_FEATURE_FILES.has(fileName)) return false;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    void vscode.window.showWarningMessage('No workspace folder open; could not save notes.');
    return false;
  }
  const mdDir = vscode.Uri.joinPath(ws.uri, 'md');
  const target = vscode.Uri.joinPath(mdDir, fileName);
  try {
    await vscode.workspace.fs.createDirectory(mdDir);
  } catch {
    /* exists */
  }
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    return true;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Could not save ${fileName}: ${m}`);
    return false;
  }
}

async function openWorkspaceMdDocFromSidebar(context: vscode.ExtensionContext, fileName: string): Promise<void> {
  if (!MD_FEATURE_FILES.has(fileName)) return;
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) {
    void vscode.window.showWarningMessage(
      'Open a workspace folder to use md notes (files are created under md/ in the workspace).'
    );
    return;
  }
  const content = await readOrCreateWorkspaceMd(context.extensionUri, ws.uri, fileName);
  let inst = getGraphPanel()?.instance;
  const mapViewWasOpen = !!inst;
  if (!inst) {
    await createAndOpenEmptyGraph(context, false);
    inst = getGraphPanel()?.instance;
  }
  if (!inst) return;
  inst.reveal();
  const delayBeforeSlideMs = mapViewWasOpen ? 80 : 520;
  setTimeout(() => {
    inst?.postWebviewMessage({ type: 'cmd:openMdPanel', fileName, content });
  }, delayBeforeSlideMs);
}

function ensureTraceSelectionDecorationType(context: vscode.ExtensionContext): vscode.TextEditorDecorationType {
  if (!tracedSelectionDecorationType) {
    tracedSelectionDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(245, 158, 11, 0.14)',
      textDecoration: 'rgba(245, 158, 11, 0.95) solid 2px underline',
      overviewRulerColor: 'rgba(245, 158, 11, 0.85)',
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: false,
    });
    context.subscriptions.push(tracedSelectionDecorationType);
  }
  return tracedSelectionDecorationType;
}

function applyTraceSelectionDecoration(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  range: vscode.Range
): void {
  const decoration = ensureTraceSelectionDecorationType(context);
  if (tracedSelectionDecorationEditorUri && tracedSelectionDecorationEditorUri !== editor.document.uri.toString()) {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() === tracedSelectionDecorationEditorUri) {
        ed.setDecorations(decoration, []);
      }
    }
  }
  editor.setDecorations(decoration, [range]);
  tracedSelectionDecorationEditorUri = editor.document.uri.toString();
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Explorer Map');
  context.subscriptions.push(log);
  try {
  fileDropProvider = new FileDropTreeProvider(context);
  searchSidebarProvider = new SearchSidebarViewProvider(context.extensionUri, {
    listSavedGraphsForSidebar: () => listSavedGraphs(),
    onSaveSavedGraphCopyAs: (absPath) => saveSavedGraphCopyAsNewFile(absPath),
    onSavedGraphSaveInPlace: (absPath) => handleSavedGraphSaveInPlace(context, absPath),
    onCreateEmptyGraph: async () => {
      await createAndOpenEmptyGraph(context, true);
    },
    onRenameWorkspaceItem: async (absPath) => {
      await renameWorkspaceItem(absPath);
    },
    onSidebarDragPaths: (paths) => {
      pendingSidebarDragPaths = paths.length ? [...paths] : null;
      pendingSidebarDragAt = paths.length ? Date.now() : 0;
    },
    onRequestPanelData: async (params) => ({
      useLlm: fileDropProvider.useLlm,
      saved: listSavedGraphs(),
      tree: await buildWorkspaceTree(params),
      mcp: await getMcpSnapshotIfLoaded(context),
    }),
    onToggleLlm: async () => {
      fileDropProvider.toggleUseLlm();
      return fileDropProvider.useLlm;
    },
    onOpenSaved: async (absPath) => {
      await loadAndShowFileGraph(context, absPath);
    },
    onCreateFile: async () => {
      await createWorkspaceFile();
    },
    onCreateFolder: async () => {
      await createWorkspaceFolder();
    },
    onUndoWorkspaceReveal: async () => {
      await undoWorkspaceSelection();
    },
    onOpenResult: async ({ resultType, absPath }) => {
      pushWorkspaceSelection(absPath, true);
      if (resultType === 'folder') return;
      await buildGraphFromFile(context, absPath, fileDropProvider.useLlm);
    },
    onPlaceInGraph: async (absPath) => {
      if (!pendingGraphPlacement) {
        getGraphPanel()?.instance?.postWebviewMessage({ type: 'cmd:placementFailed' });
        return;
      }
      const p = pendingGraphPlacement;
      pendingGraphPlacement = null;
      const ok = await addNodeFromGraphDrop(absPath, p.routeId, p.sourceJsonPath, p.dropX, p.dropY);
      getGraphPanel()?.instance?.postWebviewMessage({ type: ok ? 'cmd:placementCommitted' : 'cmd:placementFailed' });
    },
    onCancelPlaceInGraph: async () => {
      pendingGraphPlacement = null;
      getGraphPanel()?.instance?.postWebviewMessage({ type: 'cmd:placementFailed' });
    },
    onToggleConnectImports: () => {
      getGraphPanel()?.instance?.postWebviewMessage({ type: 'cmd:toggleConnectImports' });
    },
    onOpenMdDoc: async (fileName: string) => {
      await openWorkspaceMdDocFromSidebar(context, fileName);
    },
    onMcpCopyConfig: async () => {
      await withMcpLayer(context, log, (mcp) => mcp.copyCursorMcpConfigToClipboard(context));
    },
    onMcpRevealMcpHandler: async () => {
      await withMcpLayer(context, log, (mcp) => mcp.revealMcpHandlerFolderInOs(context));
    },
    onMcpOpenReadme: async () => {
      await withMcpLayer(context, log, (mcp) => mcp.openMcpReadme(context));
    },
    onMcpOpenRunnerTerminal: async () => {
      await withMcpLayer(context, log, (mcp) =>
        mcp.openMcpRunnerTerminal(
          context,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
        )
      );
    },
    onMcpSetEnabled: async (enabled) => {
      const snap = await withMcpLayer(context, log, async (mcp) => {
        await mcp.setExplorerMapMcpEnabled(context, enabled);
        return mcp.getMcpPanelSnapshot(context);
      });
      searchSidebarProvider?.postMcpPanelSnapshot(snap ?? getMcpDisabledSnapshot(context));
    },
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('apiGraphVisualizer.fileDropTree', searchSidebarProvider));

  void lazyMcpConfig()
    .then(async (mcp) => {
      mcp.registerExplorerMapMcpLayer(context);
      await mcp.applyExplorerMapMcpProjectSync(context);
      searchSidebarProvider?.postMcpPanelSnapshot(await getMcpSnapshotIfLoaded(context));
    })
    .catch((e) => {
      const message = e instanceof Error ? e.stack || e.message : String(e);
      log.appendLine(`[mcp bootstrap] ${message}`);
    });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('apiGraphVisualizer.mcp')) {
        void (async () => {
          try {
            const mcp = await lazyMcpConfig();
            await mcp.applyExplorerMapMcpProjectSync(context);
          } catch (err) {
            const message = err instanceof Error ? err.stack || err.message : String(err);
            log.appendLine(`[mcp config] ${message}`);
          }
          const snap = await getMcpSnapshotIfLoaded(context);
          searchSidebarProvider?.postMcpPanelSnapshot(snap);
        })();
      }
    })
  );

  const maybeViewVisibilityListener = fileDropTreeView
    ? fileDropTreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        getGraphPanel()?.instance?.requestGraphMeta();
      }
    })
    : undefined;

  context.subscriptions.push(
    ...(maybeViewVisibilityListener ? [maybeViewVisibilityListener] : []),
    vscode.commands.registerCommand('apiGraphVisualizer.open', () => { void openVisualizer(context); }),
    vscode.commands.registerCommand('apiGraphVisualizer.focusInGraph', () => focusCurrentFileInGraph()),
    vscode.commands.registerCommand('apiGraphVisualizer.buildFromCurrentFile', () => { void buildFromCurrentFile(context); }),
    vscode.commands.registerCommand('apiGraphVisualizer.traceFromSelection', () => {
      void traceFromSelection(context);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.revertTraceFromSelection', () => {
      void revertTraceReductionFromSelection(context);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.buildFromResource', (resource: vscode.Uri) => {
      if (resource?.fsPath) void buildGraphFromFile(context, resource.fsPath, false);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.pickFileForGraph', () => {
      void pickFileAndBuildGraph(context, fileDropProvider.useLlm);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.toggleFileGraphLlm', () => {
      fileDropProvider.toggleUseLlm();
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.copyMcpServerConfig', () => {
      void withMcpLayer(context, log, (mcp) => mcp.copyCursorMcpConfigToClipboard(context));
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.copyMcpStdioTestCommand', () => {
      void withMcpLayer(context, log, (mcp) => mcp.copyMcpStdioTestCommandToClipboard(context));
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.openCursorMcpSettings', () => {
      void openCursorMcpSettingsPage();
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.openMcpReadme', () => {
      void withMcpLayer(context, log, (mcp) => mcp.openMcpReadme(context));
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.openBacktrackedGraphsFolder', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) {
        vscode.window.showWarningMessage('Open a workspace to use backtracked graphs.');
        return;
      }
      const dir = vscode.Uri.joinPath(root, 'visualizer', 'backtracked');
      try {
        await vscode.workspace.fs.createDirectory(dir);
      } catch {
        /* exists */
      }
      await vscode.commands.executeCommand('revealInExplorer', dir);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.loadSavedGraph', async (resource?: vscode.Uri) => {
      if (!resource?.fsPath) return;
      await loadAndShowFileGraph(context, resource.fsPath);
    })
  );

  const getSelectedFilePaths = (): string[] => {
    const paths: string[] = [];
    if (!fileDropTreeView) return paths;
    for (const sel of fileDropTreeView.selection) {
      if (sel.contextValue === 'workspaceFile' && typeof sel.id === 'string') {
        const rp = relPathFromWorkspaceTreeId(sel.id);
        if (rp) paths.push(rp);
      } else if (sel.contextValue === 'softDeletedFile' && typeof sel.label === 'string') {
        paths.push(sel.label);
      }
    }
    return paths;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.softDeleteFromBuildFromFile', (item?: vscode.TreeItem) => {
      let paths: string[] = [];
      if (item?.contextValue === 'workspaceFile' && typeof item.id === 'string') {
        const rp = relPathFromWorkspaceTreeId(item.id);
        if (rp) paths = [rp];
      } else if (item?.contextValue === 'softDeletedFile' && typeof item.label === 'string') {
        paths = [item.label];
      } else {
        paths = getSelectedFilePaths();
      }
      const selectionHasWorkspaceFile =
        !!fileDropTreeView?.selection.some((s) => s.contextValue === 'workspaceFile');
      const fileOnly = paths.filter(
        (p) =>
          selectionHasWorkspaceFile ||
          fileDropProvider.getDroppedFiles().includes(p) ||
          fileDropProvider.hasSoftDeleted(p)
      );
      if (fileOnly.length > 0) fileDropProvider.softDelete(fileOnly);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.hardDeleteFromBuildFromFile', async (item?: vscode.TreeItem) => {
      let paths: string[];
      if (item?.contextValue === 'workspaceFile' && typeof item.id === 'string') {
        const rp = relPathFromWorkspaceTreeId(item.id);
        paths = rp ? [rp] : [];
      } else if (item?.contextValue === 'softDeletedFile' && typeof item.label === 'string') {
        paths = [item.label];
      } else {
        paths = getSelectedFilePaths();
      }
      const selectionHasWorkspaceFile =
        !!fileDropTreeView?.selection.some((s) => s.contextValue === 'workspaceFile');
      const fileOnly = paths.filter(
        (p) =>
          selectionHasWorkspaceFile ||
          fileDropProvider.getDroppedFiles().includes(p) ||
          fileDropProvider.hasSoftDeleted(p)
      );
      if (fileOnly.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Permanently delete ${fileOnly.length} file graph(s) and remove JSON from disk?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const filesNamedDir = path.join(root, 'visualizer', 'files_named');
      for (const relPath of fileOnly) {
        const jsonPath = path.join(filesNamedDir, toFileNamedBasename(relPath));
        try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch { /* ignore */ }
      }
      fileDropProvider.removeCompletely(fileOnly);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.restoreFromBuildFromFile', (item?: vscode.TreeItem) => {
      const paths = item?.contextValue === 'softDeletedFile' && typeof item.label === 'string' ? [item.label] : getSelectedFilePaths();
      const toRestore = paths.filter((p) => fileDropProvider.hasSoftDeleted(p));
      if (toRestore.length > 0) fileDropProvider.revive(toRestore);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.loadImportRoute', async (_: unknown, routeId?: string) => {
      if (!routeId) return;
      const relPath = routeId.replace(/^Import:\s*/, '');
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const absPath = path.join(root, relPath);
      if (fs.existsSync(absPath)) {
        await buildGraphFromFile(context, absPath, fileDropProvider.useLlm);
      } else {
        vscode.window.showWarningMessage(`File not found: ${relPath}`);
      }
    })
  );

  // Graph opens only from this extension's actions (tree click/commands), not Explorer/editor focus.
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    log.appendLine(`[activate] failed: ${message}`);
    void vscode.window.showErrorMessage('Explorer Map failed to activate. Check "Output: Explorer Map".');
  }
}

async function createWorkspaceFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace to create files.');
    return;
  }
  const rel = await vscode.window.showInputBox({
    title: 'Create New File',
    prompt: 'Enter file path relative to workspace root',
    placeHolder: 'src/newFile.ts',
    ignoreFocusOut: true,
  });
  if (!rel) return;
  const clean = rel.replace(/^[/\\]+/, '').trim();
  if (!clean) return;
  const uri = vscode.Uri.joinPath(root, ...clean.split('/'));
  const dir = vscode.Uri.joinPath(root, ...clean.split('/').slice(0, -1));
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Could not create file: ${msg}`);
  }
}

async function createWorkspaceFolder(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace to create folders.');
    return;
  }
  const rel = await vscode.window.showInputBox({
    title: 'Create New Folder',
    prompt: 'Enter folder path relative to workspace root',
    placeHolder: 'src/new-folder',
    ignoreFocusOut: true,
  });
  if (!rel) return;
  const clean = rel.replace(/^[/\\]+/, '').trim();
  if (!clean) return;
  const dir = vscode.Uri.joinPath(root, ...clean.split('/'));
  try {
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.commands.executeCommand('revealInExplorer', dir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Could not create folder: ${msg}`);
  }
}

async function renameWorkspaceItem(absPath: string): Promise<void> {
  const itemUri = vscode.Uri.file(absPath);
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(itemUri);
  } catch {
    vscode.window.showWarningMessage('Item no longer exists.');
    return;
  }
  const isDir = (stat.type & vscode.FileType.Directory) !== 0;
  const currentName = path.basename(absPath);
  const nextName = await vscode.window.showInputBox({
    title: isDir ? 'Rename Folder' : 'Rename File',
    prompt: 'Enter a new name',
    value: currentName,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = String(v || '').trim();
      if (!t) return 'Name cannot be empty.';
      if (t.includes('/') || t.includes('\\')) return 'Use only the item name (no path separators).';
      return null;
    },
  });
  if (nextName === undefined) return;
  const clean = nextName.trim();
  if (!clean || clean === currentName) return;
  const parentDir = path.dirname(absPath);
  const targetUri = vscode.Uri.file(path.join(parentDir, clean));
  try {
    await vscode.workspace.fs.rename(itemUri, targetUri, { overwrite: false });
    await vscode.commands.executeCommand('revealInExplorer', targetUri);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Could not rename item: ${msg}`);
  }
}

async function createAndOpenEmptyGraph(context: vscode.ExtensionContext, startRename: boolean): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage('Open a workspace to create an empty graph.');
    return;
  }
  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  const activeWf = activeEditorUri && activeEditorUri.scheme === 'file'
    ? vscode.workspace.getWorkspaceFolder(activeEditorUri)
    : undefined;
  const wfIndex = activeWf ? Math.max(0, folders.indexOf(activeWf)) : 0;
  const seed = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const fakeRelPath = `untitled/graph-${seed}.ts`;
  const sessionKey = makeLiveImportSessionKey(wfIndex, fakeRelPath);
  const graphData: GraphData = {
    routeNames: ['Graph'],
    graphSnapshots: {
      Graph: {
        nodes: [],
        edges: [],
        methodDeps: {},
        controllerMethods: {},
        defaultMethodId: null,
        controllerId: null,
      },
    },
  };
  lastJsonPath = undefined;
  lastLiveSessionKey = sessionKey;
  graphDataByJsonPath.set(sessionKey, graphData);
  pendingImportEdgesByJsonPath.set(sessionKey, []);
  const displayLabel = `Untitled ${untitledGraphCounter++}`;
  const GP = await ensureGraphPanel();
  GP.open(
    context.extensionUri,
    graphData,
    () => {
      /* no-op for empty graph */
    },
    (filePath) => openFileInEditor(filePath),
    (filePath) => selectWorkspaceItemFromGraph(filePath),
    'Graph',
    sessionKey,
    'newWindow',
    {
      ...graphPanelHooks(context),
      initialSession: {
        progressiveReveal: false,
        displayLabel: customSessionLabelsByPath.get(sessionKey) ?? displayLabel,
        startRename,
      },
    }
  );
}

async function buildWorkspaceTree(params: {
  query?: string;
  mode?: 'files' | 'folders';
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}): Promise<SidebarTreeNode[]> {
  const rawQuery = String(params.query || '').trim();
  const mode = params.mode || 'files';
  const matchCase = !!params.matchCase;
  const wholeWord = params.wholeWord !== undefined ? !!params.wholeWord : true;
  const useRegex = !!params.useRegex;
  const include = '**/*';
  const exclude = '**/{node_modules,.git,dist,build,out,coverage}/**';
  const files = await vscode.workspace.findFiles(include, exclude, 5000);

  interface MutableNode {
    type: 'file' | 'folder';
    label: string;
    relPath: string;
    absPath: string;
    children?: Map<string, MutableNode>;
  }

  const roots = new Map<string, MutableNode>();
  for (const file of files) {
    const wf = vscode.workspace.getWorkspaceFolder(file);
    if (!wf) continue;
    const rel = path.relative(wf.uri.fsPath, file.fsPath).replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let root = roots.get(wf.uri.fsPath);
    if (!root) {
      root = {
        type: 'folder',
        label: wf.name,
        relPath: '',
        absPath: wf.uri.fsPath,
        children: new Map<string, MutableNode>(),
      };
      roots.set(wf.uri.fsPath, root);
    }

    let cursor = root;
    let runningRel = '';
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      runningRel = runningRel ? `${runningRel}/${part}` : part;
      const isLast = i === parts.length - 1;
      if (!cursor.children) cursor.children = new Map<string, MutableNode>();
      const existing = cursor.children.get(part);
      if (existing) {
        cursor = existing;
        continue;
      }
      const newNode: MutableNode = isLast
        ? { type: 'file', label: part, relPath: runningRel, absPath: path.join(wf.uri.fsPath, runningRel) }
        : { type: 'folder', label: part, relPath: runningRel, absPath: path.join(wf.uri.fsPath, runningRel), children: new Map<string, MutableNode>() };
      cursor.children.set(part, newNode);
      cursor = newNode;
    }
  }

  const toSerializable = (node: MutableNode): SidebarTreeNode => {
    const out: SidebarTreeNode = {
      type: node.type,
      label: node.label,
      relPath: node.relPath,
      absPath: node.absPath,
    };
    if (node.children && node.children.size > 0) {
      const children = [...node.children.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
      out.children = children.map(toSerializable);
    }
    return out;
  };

  const rootNodes = [...roots.values()].sort((a, b) => a.label.localeCompare(b.label)).map(toSerializable);
  if (!rawQuery) return rootNodes;

  const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const makeMatcher = () => {
    if (useRegex) {
      try {
        const patt = wholeWord ? `\\b(?:${rawQuery})\\b` : rawQuery;
        const flags = matchCase ? '' : 'i';
        const re = new RegExp(patt, flags);
        return (text: string) => re.test(text);
      } catch {
        return (_text: string) => false;
      }
    }
    const q = matchCase ? rawQuery : rawQuery.toLowerCase();
    if (wholeWord) {
      const re = new RegExp(`\\b${escapeRegex(q)}\\b`, matchCase ? '' : 'i');
      return (text: string) => re.test(text);
    }
    return (text: string) => {
      const t = matchCase ? text : text.toLowerCase();
      return t.includes(q);
    };
  };
  const isMatch = makeMatcher();

  /** Split a filename into rough "words" (camelCase, non-alnum) for loose file search. */
  function splitBasenameIntoMatchTokens(label: string): string[] {
    const parts = String(label).split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const out: string[] = [];
    for (const part of parts) {
      const spaced = part
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
      for (const t of spaced.split(/\s+/).filter(Boolean)) {
        out.push(t);
      }
    }
    return out.length > 0 ? out : [String(label)];
  }

  /** Non-regex, non-whole-word file filter: substring must fall on a word boundary inside a token (excludes app-in-mappings). */
  function fileBasenameLooseMatch(label: string): boolean {
    const q = matchCase ? rawQuery : rawQuery.toLowerCase();
    if (!q) return true;
    const tokens = splitBasenameIntoMatchTokens(label);
    const re = new RegExp(`\\b${escapeRegex(rawQuery)}\\b`, matchCase ? '' : 'i');
    return tokens.some((t) => {
      const sub = matchCase ? t : t.toLowerCase();
      if (!sub.includes(q)) return false;
      return re.test(t);
    });
  }

  const keepNode = (node: SidebarTreeNode, forceKeepSubtree = false): SidebarTreeNode | null => {
    if (forceKeepSubtree) {
      return {
        ...node,
        children: (node.children || []).map((c) => keepNode(c, true)).filter((n): n is SidebarTreeNode => !!n),
      };
    }
    const rel = String(node.relPath || '');
    const folderMatches = node.type === 'folder' && mode === 'folders' && isMatch(rel);
    // File mode: basename only. Loose (substring) search uses per-token boundaries so e.g. "App" does not match "…mappings".
    const fileMatches =
      node.type === 'file' &&
      mode === 'files' &&
      (useRegex || wholeWord ? isMatch(node.label) : fileBasenameLooseMatch(node.label));
    if (node.type === 'file') return fileMatches ? node : null;
    const keptChildren = (node.children || [])
      .map((c) => keepNode(c, mode === 'folders' && folderMatches))
      .filter((n): n is SidebarTreeNode => !!n);
    if (folderMatches || keptChildren.length > 0) {
      return { ...node, children: keptChildren };
    }
    return null;
  };

  const kept = rootNodes.map((n) => keepNode(n, false)).filter((n): n is SidebarTreeNode => !!n);

  function subtreeFileCount(n: SidebarTreeNode): number {
    if (n.type === 'file') return 1;
    return (n.children || []).reduce((a, c) => a + subtreeFileCount(c), 0);
  }

  function pruneFoldersWithNoFiles(n: SidebarTreeNode): SidebarTreeNode | null {
    if (n.type === 'file') return n;
    const kids = (n.children || []).map(pruneFoldersWithNoFiles).filter((c): c is SidebarTreeNode => !!c);
    if (subtreeFileCount({ ...n, children: kids }) === 0) return null;
    return { ...n, children: kids };
  }

  function decorateExpandPath(nodes: SidebarTreeNode[]): SidebarTreeNode[] {
    const visit = (n: SidebarTreeNode): SidebarTreeNode => {
      if (n.type === 'file') {
        return { ...n, expandPath: false };
      }
      const kids = (n.children || []).map(visit);
      const selfMatch = mode === 'folders' && isMatch(String(n.relPath || ''));
      const expandPath =
        selfMatch ||
        (mode === 'files'
          ? kids.some((k) => k.type === 'file' || !!k.expandPath)
          : kids.some((k) => !!k.expandPath));
      return { ...n, children: kids, expandPath };
    };
    return nodes.map(visit);
  }

  let filtered = kept;
  if (mode === 'files') {
    filtered = kept.map(pruneFoldersWithNoFiles).filter((n): n is SidebarTreeNode => !!n);
  }
  return decorateExpandPath(filtered);
}

function listSavedGraphs(): { label: string; absPath: string; relPath: string }[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return [];
  const out: { label: string; absPath: string; relPath: string }[] = [];
  const multiRoot = folders.length > 1;
  for (const wf of folders) {
    const root = wf.uri.fsPath;
    for (const absPath of scanSavedBacktrackedJson(root)) {
      const rel = path.relative(root, absPath).replace(/\\/g, '/');
      out.push({
        label: path.basename(absPath),
        absPath,
        relPath: multiRoot ? `${wf.name}/${rel}` : rel,
      });
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/** Overwrite saved JSON from sidebar “Save” (Map View must have session or we open first). */
async function handleSavedGraphSaveInPlace(context: vscode.ExtensionContext, absPath: string): Promise<void> {
  if (!graphDataByJsonPath.has(absPath)) {
    await loadAndShowFileGraph(context, absPath);
    vscode.window.showInformationMessage(
      'When the graph finishes loading, press Ctrl+S — or right‑click this graph again and choose Save.'
    );
    return;
  }
  const inst = getGraphPanel()?.instance;
  if (inst) {
    await inst.requestActivateAndSave(absPath, false);
  }
}

async function presentLiveImportGraph(
  context: vscode.ExtensionContext,
  sessionKey: string,
  graphData: GraphData,
  progressiveReveal: boolean
): Promise<void> {
  const fileRoute = graphData.routeNames.find((r) => r.startsWith('Import:')) ?? graphData.routeNames[0];
  const fileRelPath = fileRoute.replace(/^Import:\s*/, '');
  const skipRestore = fileDropProvider.hasSoftDeleted(fileRelPath);

  lastJsonPath = undefined;
  lastLiveSessionKey = sessionKey;
  graphDataByJsonPath.set(sessionKey, graphData);
  const live = parseLiveImportSessionKey(sessionKey);
  const heatFs =
    live && vscode.workspace.workspaceFolders?.[live.wfIndex]
      ? vscode.workspace.workspaceFolders[live.wfIndex].uri.fsPath
      : undefined;
  await attachGitHeat(graphData, getGitRepoRootForPath(heatFs));

  const shortLabel = fileRelPath.split('/').pop() || fileRelPath;

  const hooks = {
    ...graphPanelHooks(context),
    initialSession: {
      progressiveReveal,
      displayLabel: customSessionLabelsByPath.get(sessionKey) ?? shortLabel,
    },
  };

  const GP = await ensureGraphPanel();
  GP.open(
    context.extensionUri,
    graphData,
    (routeNames) => {
      const fileRoutes = (routeNames || []).filter((r): r is string => typeof r === 'string' && r.startsWith('Import:'));
      if (!skipRestore) fileDropProvider.updateDroppedFiles(fileRoutes);
    },
    (filePath) => openFileInEditor(filePath),
    (filePath) => selectWorkspaceItemFromGraph(filePath),
    fileRoute,
    sessionKey,
    'newWindow',
    hooks
  );
}

async function buildFromCurrentFile(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  const filePath = editor.document.uri.fsPath;
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    vscode.window.showWarningMessage('Select a TypeScript or JavaScript file.');
    return;
  }
  await buildGraphFromFile(context, filePath, false);
}

async function traceFromSelection(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  const selection = editor.selection;
  if (!selection || selection.isEmpty) {
    vscode.window.showInformationMessage('Select a code section first, then use "Trace from here".');
    return;
  }
  const filePath = editor.document.uri.fsPath;
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    vscode.window.showWarningMessage('Trace from here supports TypeScript/JavaScript files.');
    return;
  }
  const text = editor.document.getText(selection).trim();
  if (!text) {
    vscode.window.showInformationMessage('Selected section is empty.');
    return;
  }

  const fileUri = vscode.Uri.file(filePath);
  const containingFolder = vscode.workspace.getWorkspaceFolder(fileUri);
  let effectiveRoot = containingFolder?.uri.fsPath;
  if (!effectiveRoot) {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        effectiveRoot = dir;
        break;
      }
      dir = path.dirname(dir);
    }
    effectiveRoot ??= path.dirname(filePath);
  }
  const relPath = path.relative(effectiveRoot, filePath).replace(/\\/g, '/');
  const startOffset = editor.document.offsetAt(selection.start);
  const endOffset = editor.document.offsetAt(selection.end);
  const usedSpecs = getUsedLocalImportSpecsInRange(filePath, startOffset, endOffset);
  if (usedSpecs.size === 0) {
    vscode.window.showWarningMessage('No local imports are referenced in the selected section.');
    return;
  }

  const fromHereTag = `from L${selection.start.line + 1}-${selection.end.line + 1}`;
  const status = vscode.window.setStatusBarMessage('Building graph from selected section...');
  try {
    const normTarget = normalizeGraphNodePath(relPath);
    const targets: Array<{ sourceJsonPath: string; routeId: string }> = [];
    for (const [sourceJsonPath, gd] of graphDataByJsonPath.entries()) {
      for (const routeId of gd.routeNames || []) {
        const snap = gd.graphSnapshots[routeId];
        if (!snap?.nodes?.length) continue;
        const hasNode = snap.nodes.some(
          (n) => !String(n.id).startsWith('Import:') && normalizeGraphNodePath(String(n.id || '')) === normTarget
        );
        if (hasNode) targets.push({ sourceJsonPath, routeId });
      }
    }
    if (targets.length === 0) {
      vscode.window.showWarningMessage('This file is not present in any currently loaded graph.');
      return;
    }

    const { buildFileGraph } = await lazyFileGraphBuilder();
    const tracedGraph = await buildFileGraph(filePath, effectiveRoot, false, {
      rootImportSpecs: usedSpecs,
      routeNameSuffix: fromHereTag,
      tracedSelectionLabel: `Trace from selected code (${fromHereTag})`,
    });
    const tracedRouteId = tracedGraph.routeNames.find((r) => r.startsWith('Import:')) ?? tracedGraph.routeNames[0];
    const tracedSnap = tracedGraph.graphSnapshots[tracedRouteId];
    if (!tracedSnap) {
      vscode.window.showWarningMessage('Could not build traced snapshot.');
      return;
    }

    const normalize = (p: string) => normalizeGraphNodePath(String(p || ''));
    const tracedRootNode =
      tracedSnap.nodes.find((n) => normalize(String(n.id || '')) === normTarget) ??
      tracedSnap.nodes.find((n) => !String(n.id || '').startsWith('Import:'));
    if (!tracedRootNode) {
      vscode.window.showWarningMessage('Trace root node is missing in traced snapshot.');
      return;
    }
    const tracedRootId = String(tracedRootNode.id);

    const appliedTargets: TracedSelectionTarget[] = [];
    for (const t of targets) {
      const existing = graphDataByJsonPath.get(t.sourceJsonPath);
      if (!existing) continue;
      const snap = existing.graphSnapshots[t.routeId];
      if (!snap) continue;
      const targetNodeId =
        (snap.nodes || []).find((n) => !String(n.id).startsWith('Import:') && normalize(String(n.id || '')) === normTarget)?.id ??
        relPath;
      appliedTargets.push({
        sourceJsonPath: t.sourceJsonPath,
        routeId: t.routeId,
        nodeId: String(targetNodeId),
      });

      // Nodes reachable as imports of target (walk edges dep -> importer backwards via `to === current`).
      const closure = new Set<string>();
      const stack = [String(targetNodeId)];
      closure.add(String(targetNodeId));
      while (stack.length) {
        const cur = stack.pop()!;
        for (const e of snap.edges || []) {
          if (String(e.to) !== cur) continue;
          const dep = String(e.from);
          if (dep.startsWith('Import:')) continue;
          if (!closure.has(dep)) {
            closure.add(dep);
            stack.push(dep);
          }
        }
      }

      const backupKey = traceReductionBackupKey(t.sourceJsonPath, t.routeId, String(targetNodeId));
      traceReductionBackupByTarget.set(backupKey, JSON.parse(JSON.stringify(snap)) as GraphSnapshot);

      const closureNorm = new Set<string>([...closure].map((id) => normalize(id)));
      const allowedNodeNorm = new Set<string>();
      for (const tn of tracedSnap.nodes || []) {
        const idStr = String(tn.id || '');
        if (idStr.startsWith('Import:')) continue;
        const mapped = normalize(idStr) === normalize(tracedRootId) ? String(targetNodeId) : idStr;
        allowedNodeNorm.add(normalize(mapped));
      }
      allowedNodeNorm.add(normalize(String(targetNodeId)));

      const allowedEdgeNorm = new Set<string>();
      for (const te of tracedSnap.edges || []) {
        const fromRaw = String(te.from || '');
        const toRaw = String(te.to || '');
        if (fromRaw.startsWith('Import:') || toRaw.startsWith('Import:')) continue;
        const mappedFrom = normalize(fromRaw) === normalize(tracedRootId) ? String(targetNodeId) : fromRaw;
        const mappedTo = normalize(toRaw) === normalize(tracedRootId) ? String(targetNodeId) : toRaw;
        allowedEdgeNorm.add(`${normalize(mappedFrom)}->${normalize(mappedTo)}`);
      }

      const removedNodeNorm = new Set<string>();
      snap.nodes = (snap.nodes || []).filter((n) => {
        const id = String(n.id || '');
        const nid = normalize(id);
        if (!closureNorm.has(nid)) return true;
        if (nid === normalize(String(targetNodeId))) return true;
        const keep = allowedNodeNorm.has(nid);
        if (!keep) removedNodeNorm.add(nid);
        return keep;
      });

      snap.edges = (snap.edges || []).filter((e) => {
        const fromN = normalize(String(e.from || ''));
        const toN = normalize(String(e.to || ''));
        if (removedNodeNorm.has(fromN) || removedNodeNorm.has(toN)) return false;
        if (closureNorm.has(fromN) && closureNorm.has(toN)) {
          return allowedEdgeNorm.has(`${fromN}->${toN}`);
        }
        return true;
      });

      const targetNode = (snap.nodes || []).find(
        (n) => normalize(String(n.id || '')) === normalize(String(targetNodeId))
      );
      if (targetNode) {
        targetNode.color = {
          background: '#F59E0B',
          border: '#B45309',
          highlight: { background: '#FBBF24', border: '#FDE68A' },
          hover: { background: '#FBBF24', border: '#FDE68A' },
        };
        targetNode.shape = 'star';
        targetNode.size = Math.max(targetNode.size || 40, 48);
        targetNode.borderWidth = Math.max(targetNode.borderWidth || 1.5, 3);
        const prevTitle = typeof targetNode.title === 'string' ? targetNode.title : String(targetNode.id || '');
        const marker = `Trace reduced from selection (${fromHereTag})`;
        if (!prevTitle.includes(marker)) {
          targetNode.title = `${prevTitle}\n\n${marker}`;
        }
      }

      existing.graphSnapshots[t.routeId] = snap;
      graphDataByJsonPath.set(t.sourceJsonPath, existing);

      const msg: UpsertSessionMessage = {
        type: 'upsertSession',
        sourceJsonPath: t.sourceJsonPath,
        graphSnapshots: existing.graphSnapshots,
        routeNames: existing.routeNames,
        initialRouteId: t.routeId,
        sessionMode: 'replace',
        unsavedChanges: true,
        mergeInPlace: true,
      };
      getGraphPanel()?.instance?.deliverUpsertExternal(msg);
      getGraphPanel()?.instance?.postSessionState({ sourceJsonPath: t.sourceJsonPath, unsavedChanges: true });
    }
    applyTraceSelectionDecoration(context, editor, new vscode.Range(selection.start, selection.end));
    tracedSelectionContextByEditorUri.set(editor.document.uri.toString(), {
      range: new vscode.Range(selection.start, selection.end),
      targets: appliedTargets,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to trace from selection: ${message}`);
  } finally {
    status.dispose();
  }
}

async function revertTraceReductionFromSelection(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  const key = editor.document.uri.toString();
  const ctx = tracedSelectionContextByEditorUri.get(key);
  if (!ctx || !ctx.targets.length) {
    vscode.window.showInformationMessage('No traced selection found in this file.');
    return;
  }
  const anchor = editor.selection?.active;
  if (!anchor || !ctx.range.contains(anchor)) {
    vscode.window.showInformationMessage('Place cursor inside traced code section to revert.');
    return;
  }
  for (const t of ctx.targets) {
    await revertTraceReductionForNode(t.sourceJsonPath, t.routeId, t.nodeId);
  }
  tracedSelectionContextByEditorUri.delete(key);
  if (tracedSelectionDecorationType) {
    editor.setDecorations(tracedSelectionDecorationType, []);
  }
}

async function revertTraceReductionForNode(
  sourceJsonPath: string,
  routeId: string,
  nodeId: string
): Promise<void> {
  const key = traceReductionBackupKey(sourceJsonPath, routeId, nodeId);
  const backup = traceReductionBackupByTarget.get(key);
  if (!backup) {
    vscode.window.showInformationMessage('No trace-reduction backup found for this node.');
    return;
  }
  const existing = graphDataByJsonPath.get(sourceJsonPath);
  if (!existing || !existing.graphSnapshots[routeId]) return;
  existing.graphSnapshots[routeId] = JSON.parse(JSON.stringify(backup)) as GraphSnapshot;
  graphDataByJsonPath.set(sourceJsonPath, existing);
  traceReductionBackupByTarget.delete(key);
  const msg: UpsertSessionMessage = {
    type: 'upsertSession',
    sourceJsonPath,
    graphSnapshots: existing.graphSnapshots,
    routeNames: existing.routeNames,
    initialRouteId: routeId,
    sessionMode: 'replace',
    unsavedChanges: true,
    mergeInPlace: true,
  };
  getGraphPanel()?.instance?.deliverUpsertExternal(msg);
  getGraphPanel()?.instance?.postSessionState({ sourceJsonPath, unsavedChanges: true });
}

function focusCurrentFileInGraph(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) return;
  let relativePath = editor.document.uri.fsPath;
  for (const folder of workspaceFolders) {
    const folderPath = folder.uri.fsPath;
    if (relativePath.startsWith(folderPath + path.sep) || relativePath === folderPath) {
      relativePath = path.relative(folderPath, relativePath);
      break;
    }
  }
  getGraphPanel()?.instance?.focusNodeInGraph(relativePath.replace(/\\/g, '/'));
}

function openFileInEditor(relativePath: string): void {
  const trimmed = relativePath?.trim();
  if (!trimmed) return;
  const normalized = trimmed.replace(/^[/\\]+/, '');

  // Resolve project root: paths in graph are relative to project root (parent of visualizer/ when json is in visualizer)
  let projectRoot: string | undefined;
  if (lastJsonPath && fs.existsSync(lastJsonPath)) {
    const jsonDir = path.dirname(lastJsonPath);
    projectRoot = path.basename(jsonDir) === 'visualizer' ? path.dirname(jsonDir) : jsonDir;
  }
  if (!projectRoot && vscode.workspace.workspaceFolders?.length) {
    projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  if (!projectRoot) {
    vscode.window.showWarningMessage('No project root found. Open a workspace or load a graph first.');
    return;
  }

  let absPath = path.join(projectRoot, normalized);

  if (!fs.existsSync(absPath) && vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      const candidate = path.join(folder.uri.fsPath, normalized);
      if (fs.existsSync(candidate)) {
        absPath = candidate;
        break;
      }
    }
  }

  if (!fs.existsSync(absPath)) {
    vscode.window.showWarningMessage(`File not found: ${normalized}`);
    return;
  }

  const uri = vscode.Uri.file(absPath);

  void vscode.commands.executeCommand('vscode.open', uri, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  }).then(
    () => { /* opened successfully */ },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const fileSizeMB = (fs.statSync(absPath).size / (1024 * 1024)).toFixed(1);
      if (msg.includes('50MB') || msg.includes('synchronized with extensions')) {
        vscode.window.showWarningMessage(
          `Could not open ${path.basename(absPath)} (${fileSizeMB} MB). ${parseFloat(fileSizeMB) > 50 ? 'File exceeds VS Code limit.' : 'Try opening manually.'}`,
          'Open with Default App',
          'Reveal in Explorer'
        ).then((choice) => {
          if (choice === 'Open with Default App') {
            void vscode.env.openExternal(uri);
          } else if (choice === 'Reveal in Explorer') {
            void vscode.commands.executeCommand('revealInExplorer', uri);
          }
        });
      } else {
        vscode.window.showErrorMessage(`Failed to open file: ${msg}`);
      }
    }
  );
}

function selectWorkspaceItemFromGraph(relativePath: string): void {
  const trimmed = relativePath?.trim();
  if (!trimmed) return;
  const normalized = trimmed.replace(/^[/\\]+/, '');
  let projectRoot: string | undefined;
  if (lastJsonPath && fs.existsSync(lastJsonPath)) {
    const jsonDir = path.dirname(lastJsonPath);
    projectRoot = path.basename(jsonDir) === 'visualizer' ? path.dirname(jsonDir) : jsonDir;
  }
  if (!projectRoot && vscode.workspace.workspaceFolders?.length) {
    projectRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  if (!projectRoot) return;

  let absPath = path.join(projectRoot, normalized);
  if (!fs.existsSync(absPath) && vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      const candidate = path.join(folder.uri.fsPath, normalized);
      if (fs.existsSync(candidate)) {
        absPath = candidate;
        break;
      }
    }
  }
  if (!fs.existsSync(absPath)) return;
  pushWorkspaceSelection(absPath, true);
}

function getPreferredProjectRoot(fsPath?: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;
  if (fsPath) {
    const live = parseLiveImportSessionKey(fsPath);
    if (live !== null) {
      return folders[live.wfIndex]?.uri.fsPath ?? folders[0].uri.fsPath;
    }
    const norm = path.normalize(fsPath);
    for (const f of folders) {
      const r = f.uri.fsPath;
      if (norm === r || norm.startsWith(r + path.sep)) return r;
    }
  }
  return folders[0].uri.fsPath;
}

function getGitRepoRootForPath(fsPath: string | undefined): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;
  if (fsPath) {
    const live = parseLiveImportSessionKey(fsPath);
    if (live !== null) {
      return folders[live.wfIndex]?.uri.fsPath ?? folders[0].uri.fsPath;
    }
    const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (wf) return wf.uri.fsPath;
  }
  return folders[0].uri.fsPath;
}

function collectRelPathsFromGraph(graphData: GraphData): string[] {
  const s = new Set<string>();
  for (const snap of Object.values(graphData.graphSnapshots)) {
    for (const n of snap.nodes) {
      if (n.shape === 'hexagon') continue;
      const id = n.id.replace(/\\/g, '/');
      if (id.includes('::')) continue;
      if (id.includes('/')) s.add(id);
    }
  }
  return [...s];
}

async function attachGitHeat(graphData: GraphData, cwd: string | undefined): Promise<void> {
  delete graphData.gitHeatByPath;
  if (!cwd) return;
  const paths = collectRelPathsFromGraph(graphData);
  if (paths.length === 0) return;
  try {
    const { computeGitHeatByPath } = await lazyGitHeat();
    const heat = computeGitHeatByPath(cwd, paths);
    const anyHot = Object.values(heat).some((v) => v > 0);
    graphData.gitHeatByPath = anyHot ? heat : undefined;
  } catch {
    /* ignore */
  }
}

async function openVisualizer(context: vscode.ExtensionContext): Promise<void> {
  if (lastLiveSessionKey && graphDataByJsonPath.has(lastLiveSessionKey)) {
    const gd = graphDataByJsonPath.get(lastLiveSessionKey)!;
    await presentLiveImportGraph(context, lastLiveSessionKey, gd, false);
    return;
  }
  if (lastJsonPath && fs.existsSync(lastJsonPath)) {
    await loadAndShowFileGraph(context, lastJsonPath);
    return;
  }
  const detected = findLatestFileGraphJson();
  if (detected) {
    lastJsonPath = detected;
    await loadAndShowFileGraph(context, detected);
    return;
  }
  vscode.window.showInformationMessage('No file graph found. Use Explorer Map to create one.');
}

async function pickFileAndBuildGraph(
  context: vscode.ExtensionContext,
  useLlm: boolean
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters: { 'TypeScript/JavaScript': ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] },
    openLabel: 'Select file(s) to trace imports',
    defaultUri: workspaceFolders[0].uri,
  });

  if (uris?.length) {
    for (const u of uris) {
      await buildGraphFromFile(context, u.fsPath, useLlm);
    }
  }
}

async function buildGraphFromFile(
  context: vscode.ExtensionContext,
  filePath: string,
  useLlm: boolean
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  const projectRoot = workspaceFolders[0].uri.fsPath;
  let absPath = path.isAbsolute(filePath)
    ? path.normalize(filePath.trim())
    : path.join(projectRoot, filePath.trim());

  let exists = false;
  try {
    exists = fs.existsSync(absPath) && fs.statSync(absPath).isFile();
  } catch {
    /* ignore */
  }
  if (!exists) {
    const uri = vscode.Uri.file(absPath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch {
      /* ignore */
    }
  }
  if (!exists) {
    const targetBasename = path.basename(absPath);
    const normAbs = path.resolve(absPath);
    for (const d of vscode.workspace.textDocuments) {
      const docPath = d.uri.fsPath;
      if (path.resolve(docPath) === normAbs || (docPath.endsWith(targetBasename) && path.basename(docPath) === targetBasename)) {
        try {
          if (fs.existsSync(docPath) && fs.statSync(docPath).isFile()) {
            absPath = docPath;
            exists = true;
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (!exists) {
    const basename = path.basename(absPath);
    const found = await vscode.workspace.findFiles(`**/${basename}`, null, 10);
    const match = found.find((u) => u.fsPath === absPath || u.fsPath.endsWith(basename));
    if (match && fs.existsSync(match.fsPath)) {
      absPath = match.fsPath;
      exists = true;
    }
  }
  if (!exists) {
    vscode.window.showErrorMessage(`File not found: ${filePath}`);
    return;
  }

  const fileUri = vscode.Uri.file(absPath);
  const containingFolder = vscode.workspace.getWorkspaceFolder(fileUri);
  let effectiveRoot = containingFolder?.uri.fsPath;
  if (!effectiveRoot) {
    let dir = path.dirname(absPath);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        effectiveRoot = dir;
        break;
      }
      dir = path.dirname(dir);
    }
    effectiveRoot ??= path.dirname(absPath);
  }

  const relPath = path.relative(effectiveRoot, absPath).replace(/\\/g, '/');
  const filesNamedDir = path.join(effectiveRoot, 'visualizer', 'files_named');
  const outBasename = toFileNamedBasename(relPath);
  const outPath = path.join(filesNamedDir, outBasename);
  const wfIdx = workspaceIndexForAbsPath(absPath, effectiveRoot);

  if (useLlm) {
    if (!fs.existsSync(filesNamedDir)) fs.mkdirSync(filesNamedDir, { recursive: true });
    runFileGraphScriptInTerminal(context, absPath, effectiveRoot, outPath);
    return;
  }

  const status = vscode.window.setStatusBarMessage('Building import graph...');

  try {
    const { buildFileGraph } = await lazyFileGraphBuilder();
    const graphData = await buildFileGraph(absPath, effectiveRoot, false);

    fileDropProvider.updateDroppedFiles([`Import: ${relPath}`]);
    await presentLiveImportGraph(context, makeLiveImportSessionKey(wfIdx, relPath), graphData, true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to build import graph: ${message}`);
  } finally {
    status.dispose();
  }
}

function runFileGraphScriptInTerminal(
  context: vscode.ExtensionContext,
  absPath: string,
  projectRoot: string,
  outputPath: string
): void {
  const scriptPath = path.join(context.extensionPath, 'dist', 'scripts', 'build-file-graph.ts');

  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage('Build-file-graph script not found. Rebuild the extension.');
    return;
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const terminal = vscode.window.createTerminal({
    name: 'Import Graph (LLM)',
    cwd: projectRoot,
    env: { ...process.env, PROJECT_ROOT: projectRoot },
  });
  terminal.show();
  terminal.sendText(`npx ts-node "${scriptPath}" "${absPath}" --llm --out "${outputPath}"`);
}

function findLatestFileGraphJson(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return undefined;
  let latest: { path: string; mtime: number } | null = null;
  for (const folder of workspaceFolders) {
    const root = folder.uri.fsPath;
    const fileGraph = path.join(root, 'visualizer', 'file_graph_output.json');
    if (fs.existsSync(fileGraph)) {
      const mtime = fs.statSync(fileGraph).mtimeMs;
      if (!latest || mtime > latest.mtime) latest = { path: fileGraph, mtime };
    }
    const filesNamedDir = path.join(root, 'visualizer', 'files_named');
    if (fs.existsSync(filesNamedDir) && fs.statSync(filesNamedDir).isDirectory()) {
      for (const name of fs.readdirSync(filesNamedDir)) {
        if (!name.endsWith('.json')) continue;
        const fp = path.join(filesNamedDir, name);
        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) continue;
        const mtime = fs.statSync(fp).mtimeMs;
        if (!latest || mtime > latest.mtime) latest = { path: fp, mtime };
      }
    }
  }
  return latest?.path;
}

function autoDetectFileGraphs(context: vscode.ExtensionContext): void {
  const fileGraphWatcher = vscode.workspace.createFileSystemWatcher('**/file_graph_output.json');
  const filesNamedWatcher = vscode.workspace.createFileSystemWatcher('**/visualizer/files_named/*.json');

  const loadFileGraphFromUri = (uri: vscode.Uri) => {
    lastJsonPath = uri.fsPath;
    lastLiveSessionKey = undefined;
    void loadAndShowFileGraph(context, uri.fsPath, 'refreshOpenOrOpen');
  };

  fileGraphWatcher.onDidCreate(loadFileGraphFromUri);
  fileGraphWatcher.onDidChange((uri) => {
    void loadAndShowFileGraph(context, uri.fsPath, 'refreshOpenOrOpen');
  });

  filesNamedWatcher.onDidCreate((uri) => {
    loadFileGraphFromUri(uri);
    fileDropProvider.refreshFromFilesNamed();
  });
  filesNamedWatcher.onDidChange((uri) => {
    void loadAndShowFileGraph(context, uri.fsPath, 'refreshOpenOrOpen');
    fileDropProvider.refreshFromFilesNamed();
  });
  filesNamedWatcher.onDidDelete(() => fileDropProvider.refreshFromFilesNamed());

  context.subscriptions.push(fileGraphWatcher, filesNamedWatcher);
}

function graphPanelHooks(context: vscode.ExtensionContext) {
  return {
    onBacktrack: (payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => {
      void runBacktrackFromWebview(payload.nodeId, payload.routeId, payload.sourceJsonPath);
    },
    onRevertTraceNode: (payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => {
      void revertTraceReductionForNode(payload.sourceJsonPath, payload.routeId, payload.nodeId);
    },
    onSaveBacktrack: (sourceJsonPath: string) => {
      void saveBacktrackGraph(sourceJsonPath);
    },
    onSaveBacktrackPrompt: (sourceJsonPath: string) => {
      void promptSaveBacktrack(sourceJsonPath);
    },
    onAddNodeFromDrop: (payload: {
      droppedPath: string;
      routeId: string;
      sourceJsonPath: string;
      dropX?: number;
      dropY?: number;
    }) => {
      void addNodeFromGraphDrop(
        payload.droppedPath,
        payload.routeId,
        payload.sourceJsonPath,
        payload.dropX,
        payload.dropY
      );
    },
    onAddRecentTreeDrag: (payload: { routeId: string; sourceJsonPath: string; dropX?: number; dropY?: number }) => {
      void addRecentTreeDraggedNodes(payload.routeId, payload.sourceJsonPath, payload.dropX, payload.dropY);
    },
    onCreateEmptyGraph: () => {
      void createAndOpenEmptyGraph(context, true);
    },
    onRenameSession: (payload: { sourceJsonPath: string; displayLabel: string }) => {
      const label = String(payload.displayLabel || '').trim();
      if (!label) return;
      customSessionLabelsByPath.set(payload.sourceJsonPath, label);
      getGraphPanel()?.instance?.postSessionState({
        sourceJsonPath: payload.sourceJsonPath,
        displayLabel: label,
      });
    },
    onSearchWorkspaceFiles: (payload: { query: string; sourceJsonPath: string; requestToken: string }) => {
      void searchWorkspaceFilesForGraph(payload.query, payload.sourceJsonPath, payload.requestToken);
    },
    onStartSidebarPlacement: (payload: { routeId: string; sourceJsonPath: string; dropX: number; dropY: number }) => {
      pendingGraphPlacement = { ...payload };
      void vscode.commands.executeCommand('workbench.view.extension.api-graph-sidebar');
      void vscode.commands.executeCommand('apiGraphVisualizer.fileDropTree.focus');
      searchSidebarProvider.activatePlacementSearch();
    },
    onGraphDrop: (payload: {
      routeId: string;
      sourceJsonPath: string;
      pathsFromDataTransfer: string[];
      dropX?: number;
      dropY?: number;
    }) => {
      void handleGraphDropFromWebview(payload);
    },
    onConnectNodes: (payload: { fromNodeId: string; toNodeId: string; routeId: string; sourceJsonPath: string }) => {
      void connectGraphNodes(payload.fromNodeId, payload.toNodeId, payload.routeId, payload.sourceJsonPath);
    },
    onGraphSidebarState: (payload: { showConnectImports: boolean; connectLabel: string; connectActive: boolean }) => {
      searchSidebarProvider.postGraphConnectImportsState(payload);
    },
    onSaveMdFile: async (payload: { fileName: string; content: string }) => {
      const ok = await saveWorkspaceMdFile(context.extensionUri, payload.fileName, payload.content);
      getGraphPanel()?.instance?.postWebviewMessage({ type: 'cmd:mdFileSaveResult', fileName: payload.fileName, ok });
    },
    onSaveSession: (payload: {
      sourceJsonPath: string;
      saveToSaved?: boolean;
      graphSnapshots?: GraphData['graphSnapshots'];
    }) => {
      void saveSession(payload.sourceJsonPath, !!payload.saveToSaved, payload.graphSnapshots);
    },
  };
}

async function searchWorkspaceFilesForGraph(
  query: string,
  sourceJsonPath: string,
  requestToken: string
): Promise<void> {
  const q = String(query || '').trim();
  const tree = await buildWorkspaceTree({
    query: q,
    mode: 'files',
    matchCase: false,
    wholeWord: true,
    useRegex: false,
  });
  const collectFiles = (nodes: SidebarTreeNode[], out: SidebarTreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'file') out.push(node);
      if (Array.isArray(node.children) && node.children.length) collectFiles(node.children, out);
    }
  };
  const files: SidebarTreeNode[] = [];
  collectFiles(tree, files);
  const items = files.slice(0, 80).map((n) => ({
    absPath: n.absPath,
    relPath: n.relPath || relPathFromWorkspace(n.absPath),
    label: n.label || path.basename(n.absPath),
  }));
  getGraphPanel()?.instance?.postWebviewMessage({
    type: 'cmd:workspaceSearchResults',
    sourceJsonPath,
    requestToken,
    items,
  });
}

function makeManualNode(rel: string): GraphData['graphSnapshots'][string]['nodes'][number] {
  return {
    id: rel,
    label: rel,
    title: `${rel}\n\nWhat it does:\n(Added manually from file tree)\n\nNPM Packages:\nNone`,
    color: {
      background: '#1E88E5',
      border: '#0D47A1',
      highlight: { background: '#42A5F5', border: '#FFC107' },
      hover: { background: '#42A5F5', border: '#FFC107' },
    },
    font: { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' },
    shape: 'box',
    size: 38,
    borderWidth: 1.5,
    borderWidthSelected: 3,
    margin: 12,
  };
}

function makeManualEdge(from: string, to: string): GraphData['graphSnapshots'][string]['edges'][number] {
  return {
    from,
    to,
    color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' },
    width: 1.5,
    selectionWidth: 2,
    smooth: false,
  };
}

function toWorkspaceRelPathAny(rawPath: string, sourceJsonPath: string): string | undefined {
  let p = rawPath.trim();
  if (!p) return undefined;
  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) return undefined;
  if (/^(file|vscode-file|vscode):\/\//i.test(p)) {
    try {
      p = vscode.Uri.parse(p).fsPath;
    } catch {
      return undefined;
    }
  }
  if (path.isAbsolute(p)) {
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return undefined;
    return rel;
  }
  const normalized = p.replace(/\\/g, '/').replace(/^[/\\]+/, '');
  // Some drag sources provide only basename; avoid adding unresolved ambiguous nodes.
  if (!normalized.includes('/')) return undefined;
  return normalized || undefined;
}

function normalizeGraphNodePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
}

async function addNodeFromGraphDrop(
  droppedPath: string,
  routeId: string,
  sourceJsonPath: string,
  dropX?: number,
  dropY?: number
): Promise<boolean> {
  const graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData) return false;
  const snap = graphData.graphSnapshots[routeId];
  if (!snap) return false;
  const rel = toWorkspaceRelPathAny(droppedPath, sourceJsonPath);
  if (!rel) {
    vscode.window.showWarningMessage('Dropped file is outside the current workspace.');
    return false;
  }
  const normalizedRel = normalizeGraphNodePath(rel);
  if (snap.nodes.some((n) => normalizeGraphNodePath(String(n.id || '')) === normalizedRel)) {
    return false;
  }
  const node = makeManualNode(rel);
  if (typeof dropX === 'number' && typeof dropY === 'number') {
    (node as unknown as { x?: number; y?: number }).x = dropX;
    (node as unknown as { x?: number; y?: number }).y = dropY;
  }
  snap.nodes.push(node);
  graphDataByJsonPath.set(sourceJsonPath, graphData);
  getGraphPanel()?.instance?.postSessionState({ sourceJsonPath, backtrackDirty: true, unsavedChanges: true });
  getGraphPanel()?.instance?.postWebviewMessage({
    type: 'cmd:addNodeApplied',
    sourceJsonPath,
    routeId,
    node,
  });
  return true;
}

async function addRecentTreeDraggedNodes(
  routeId: string,
  sourceJsonPath: string,
  dropX?: number,
  dropY?: number
): Promise<void> {
  const rels = fileDropProvider.consumeLastDraggedFiles();
  if (rels.length === 0) return;
  let i = 0;
  for (const rel of rels) {
    const dx = typeof dropX === 'number' ? dropX + i * 36 : undefined;
    const dy = typeof dropY === 'number' ? dropY + i * 20 : undefined;
    await addNodeFromGraphDrop(rel, routeId, sourceJsonPath, dx, dy);
    i += 1;
  }
}

async function handleGraphDropFromWebview(payload: {
  routeId: string;
  sourceJsonPath: string;
  pathsFromDataTransfer: string[];
  dropX?: number;
  dropY?: number;
}): Promise<void> {
  const fromDt = Array.isArray(payload.pathsFromDataTransfer)
    ? payload.pathsFromDataTransfer.filter((p): p is string => typeof p === 'string' && !!String(p).trim())
    : [];
  let paths = [...new Set(fromDt.map((p) => String(p).trim()))];
  const pendingFresh =
    pendingSidebarDragPaths?.length &&
    pendingSidebarDragAt > 0 &&
    Date.now() - pendingSidebarDragAt < PENDING_SIDEBAR_DRAG_TTL_MS;
  if (paths.length === 0 && pendingFresh) {
    paths = [...new Set(pendingSidebarDragPaths!)];
  }
  pendingSidebarDragPaths = null;
  pendingSidebarDragAt = 0;
  if (paths.length === 0) {
    await addRecentTreeDraggedNodes(payload.routeId, payload.sourceJsonPath, payload.dropX, payload.dropY);
    return;
  }
  let i = 0;
  for (const droppedPath of paths) {
    const dx = typeof payload.dropX === 'number' ? payload.dropX + i * 36 : undefined;
    const dy = typeof payload.dropY === 'number' ? payload.dropY + i * 20 : undefined;
    await addNodeFromGraphDrop(droppedPath, payload.routeId, payload.sourceJsonPath, dx, dy);
    i += 1;
  }
}

async function connectGraphNodes(
  fromNodeId: string,
  toNodeId: string,
  routeId: string,
  sourceJsonPath: string
): Promise<void> {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
  if (fromNodeId.startsWith('Import:') || toNodeId.startsWith('Import:')) return;
  const graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData) return;
  const snap = graphData.graphSnapshots[routeId];
  if (!snap) return;
  const ids = new Set(snap.nodes.map((n) => n.id));
  if (!ids.has(fromNodeId) || !ids.has(toNodeId)) {
    vscode.window.showWarningMessage('Both nodes must exist in the current route.');
    return;
  }
  // Graph edges use imported -> importer; pending edits still record (importer, imported) for applyPendingImports.
  const already = snap.edges.some((e) => e.from === toNodeId && e.to === fromNodeId);
  if (!already) {
    snap.edges.push(makeManualEdge(toNodeId, fromNodeId));
  }
  const pending = pendingImportEdgesByJsonPath.get(sourceJsonPath) ?? [];
  const existsPending = pending.some((e) => e.fromRelPath === fromNodeId && e.toRelPath === toNodeId);
  if (!existsPending) pending.push({ fromRelPath: fromNodeId, toRelPath: toNodeId });
  pendingImportEdgesByJsonPath.set(sourceJsonPath, pending);
  graphDataByJsonPath.set(sourceJsonPath, graphData);
  getGraphPanel()?.instance?.postSessionState({ sourceJsonPath, backtrackDirty: true, unsavedChanges: true });
  getGraphPanel()?.instance?.postWebviewMessage({
    type: 'cmd:addEdgeApplied',
    sourceJsonPath,
    routeId,
    edge: makeManualEdge(toNodeId, fromNodeId),
  });
}

function relativeImportSpec(fromRelPath: string, toRelPath: string): string {
  const fromDir = path.posix.dirname(fromRelPath.replace(/\\/g, '/'));
  const toNorm = toRelPath.replace(/\\/g, '/');
  let rel = path.posix.relative(fromDir, toNorm);
  if (!rel.startsWith('.')) rel = './' + rel;
  rel = rel.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
  rel = rel.replace(/\/index$/i, '/index');
  return rel;
}

function addSideEffectImportToTop(fileContent: string, importSpec: string): { updated: string; changed: boolean } {
  const hasImport = new RegExp(
    String.raw`(?:import\s+[^;]*from\s+['"]${importSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]|import\s+['"]${importSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"])`
  ).test(fileContent);
  if (hasImport) return { updated: fileContent, changed: false };
  const lines = fileContent.split(/\r?\n/);
  let insertAt = 0;
  if (lines[0]?.startsWith('#!')) insertAt = 1;
  while (insertAt < lines.length && /^\s*$/.test(lines[insertAt])) insertAt += 1;
  if (lines[insertAt] && /^['"]use strict['"];?\s*$/.test(lines[insertAt])) insertAt += 1;
  while (insertAt < lines.length && /^\s*import\b/.test(lines[insertAt])) insertAt += 1;
  lines.splice(insertAt, 0, `import '${importSpec}';`);
  return { updated: lines.join('\n'), changed: true };
}

async function applyPendingImports(sourceJsonPath: string): Promise<number> {
  const edits = pendingImportEdgesByJsonPath.get(sourceJsonPath) ?? [];
  if (edits.length === 0) return 0;
  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) return 0;
  let changedFiles = 0;
  const grouped = new Map<string, string[]>();
  for (const e of edits) {
    const specs = grouped.get(e.fromRelPath) ?? [];
    specs.push(relativeImportSpec(e.fromRelPath, e.toRelPath));
    grouped.set(e.fromRelPath, specs);
  }
  for (const [fromRel, specs] of grouped) {
    const abs = path.join(root, fromRel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const raw = fs.readFileSync(abs, 'utf-8');
    let next = raw;
    let anyChanged = false;
    for (const spec of [...new Set(specs)]) {
      const res = addSideEffectImportToTop(next, spec);
      next = res.updated;
      if (res.changed) anyChanged = true;
    }
    if (anyChanged) {
      fs.writeFileSync(abs, next, 'utf-8');
      changedFiles += 1;
    }
  }
  pendingImportEdgesByJsonPath.delete(sourceJsonPath);
  return changedFiles;
}

function applyFixedLayoutFlags(snapshots: GraphData['graphSnapshots']): void {
  for (const rid of Object.keys(snapshots)) {
    const snap = snapshots[rid];
    if (!snap?.nodes?.length) continue;
    const allFinite = snap.nodes.every(
      (n) => typeof n.x === 'number' && typeof n.y === 'number' && Number.isFinite(n.x) && Number.isFinite(n.y)
    );
    if (allFinite) snap.fixedLayout = true;
    else delete snap.fixedLayout;
  }
}

function notifySavedGraphsChanged(): void {
  fileDropProvider.refreshSavedGraphs();
  searchSidebarProvider.postSavedListUpdate();
}

/** True if this session path is an on-disk JSON under that workspace folder's visualizer/backtracked. */
function isSavedGraphWorkspacePath(absJsonPath: string, root: string): boolean {
  if (parseLiveImportSessionKey(absJsonPath)) return false;
  if (!absJsonPath.toLowerCase().endsWith('.json')) return false;
  const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absJsonPath));
  const folderRoot = wf?.uri.fsPath ?? root;
  const br = path.normalize(path.join(path.normalize(folderRoot), 'visualizer', 'backtracked'));
  const normPath = path.normalize(absJsonPath);
  return normPath === br || normPath.startsWith(br + path.sep);
}

async function saveSavedGraphCopyAsNewFile(sourceAbsPath: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace to save a graph copy.');
    return;
  }
  const base = path.basename(sourceAbsPath, '.json');
  const defaultUri = vscode.Uri.file(path.join(root, 'visualizer', 'backtracked', `${base}_copy.json`));
  const picked = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { JSON: ['json'] },
    title: 'Save graph copy as',
    saveLabel: 'Save copy',
  });
  if (!picked?.fsPath) return;

  const gdMem = graphDataByJsonPath.get(sourceAbsPath);
  const GP = getGraphPanel()?.instance;
  let graphData: GraphData;
  if (gdMem && GP) {
    const live = await GP.requestSnapshotExport(sourceAbsPath);
    graphData = { ...gdMem };
    if (live?.graphSnapshots && Object.keys(live.graphSnapshots).length > 0) {
      graphData.graphSnapshots = live.graphSnapshots;
      if (live.routeNames?.length) {
        graphData.routeNames = live.routeNames;
      }
      applyFixedLayoutFlags(graphData.graphSnapshots);
    }
  } else {
    try {
      graphData = JSON.parse(fs.readFileSync(sourceAbsPath, 'utf-8')) as GraphData;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Could not read graph file: ${msg}`);
      return;
    }
  }

  try {
    fs.mkdirSync(path.dirname(picked.fsPath), { recursive: true });
    fs.writeFileSync(picked.fsPath, JSON.stringify(graphData, null, 2), 'utf-8');
    notifySavedGraphsChanged();
    vscode.window.showInformationMessage(`Saved graph copy: ${path.relative(root, picked.fsPath)}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Save failed: ${msg}`);
  }
}

/** Copy graph JSON into visualizer/backtracked so it appears under Saved in the sidebar. */
function writeGraphCopyToBacktrackedDir(
  root: string,
  sourceJsonPath: string,
  graphData: GraphData
): string | null {
  const outDir = path.join(root, 'visualizer', 'backtracked');
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    return null;
  }
  const base = sessionJsonBasenameForSave(sourceJsonPath);
  const prefixed = base.toLowerCase().startsWith('backtracked_') ? base : `backtracked_${base}`;
  let outPath = path.join(outDir, prefixed);
  if (fs.existsSync(outPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(prefixed);
    const stem = prefixed.slice(0, prefixed.length - ext.length);
    outPath = path.join(outDir, `${stem}_${stamp}${ext}`);
  }
  try {
    fs.writeFileSync(outPath, JSON.stringify(graphData, null, 2), 'utf-8');
    return outPath;
  } catch {
    return null;
  }
}

async function saveSession(
  sourceJsonPath: string,
  saveToSaved = false,
  graphSnapshotsFromWebview?: GraphData['graphSnapshots']
): Promise<void> {
  const graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData) {
    vscode.window.showWarningMessage('No graph session loaded.');
    return;
  }
  if (graphSnapshotsFromWebview) {
    graphData.graphSnapshots = graphSnapshotsFromWebview;
    applyFixedLayoutFlags(graphData.graphSnapshots);
  }
  const changedFiles = await applyPendingImports(sourceJsonPath);
  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder.');
    return;
  }
  if (saveToSaved || graphData.backtrack) {
    const outDir = path.join(root, 'visualizer', 'backtracked');
    fs.mkdirSync(outDir, { recursive: true });
    const saveInPlaceOpenedFile =
      !saveToSaved && isSavedGraphWorkspacePath(sourceJsonPath, root);
    let outPath: string;
    if (saveInPlaceOpenedFile) {
      outPath = path.normalize(sourceJsonPath);
    } else {
      const base = sessionJsonBasenameForSave(sourceJsonPath);
      const prefixed = base.toLowerCase().startsWith('backtracked_') ? base : `backtracked_${base}`;
      outPath = path.join(outDir, prefixed);
      if (saveToSaved && fs.existsSync(outPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(prefixed);
        const stem = prefixed.slice(0, prefixed.length - ext.length);
        outPath = path.join(outDir, `${stem}_${stamp}${ext}`);
      }
    }
    try {
      fs.writeFileSync(outPath, JSON.stringify(graphData, null, 2), 'utf-8');
      graphDataByJsonPath.set(sourceJsonPath, graphData);
      getGraphPanel()?.instance?.postSessionState({ sourceJsonPath, backtrackDirty: false, unsavedChanges: false });
      notifySavedGraphsChanged();
      if (changedFiles > 0) {
        vscode.window.showInformationMessage(
          `Saved to ${path.relative(root, outPath)} and wrote imports in ${changedFiles} file(s).`
        );
      } else {
        vscode.window.showInformationMessage(`Saved to ${path.relative(root, outPath)}.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Save failed: ${msg}`);
    }
    return;
  }
  try {
    const outFile = parseLiveImportSessionKey(sourceJsonPath)
      ? path.join(root, 'visualizer', 'files_named', sessionJsonBasenameForSave(sourceJsonPath))
      : sourceJsonPath;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(graphData, null, 2), 'utf-8');
    let sidebarCopyPath: string | null = null;
    if (graphSnapshotsFromWebview) {
      const primaryInBacktracked = outFile.replace(/\\/g, '/').includes('/visualizer/backtracked/');
      if (!primaryInBacktracked) {
        sidebarCopyPath = writeGraphCopyToBacktrackedDir(root, sourceJsonPath, graphData);
      }
      notifySavedGraphsChanged();
    }
    getGraphPanel()?.instance?.postSessionState({ sourceJsonPath, backtrackDirty: false, unsavedChanges: false });
    fileDropProvider.refreshFromFilesNamed();
    if (changedFiles > 0) {
      vscode.window.showInformationMessage(
        `Saved graph and wrote import statements in ${changedFiles} file(s).`
      );
    } else if (sidebarCopyPath) {
      vscode.window.showInformationMessage(
        `Saved graph JSON: ${path.relative(root, outFile)}. Copy for Saved sidebar: ${path.relative(root, sidebarCopyPath)}.`
      );
    } else {
      vscode.window.showInformationMessage(`Saved graph JSON: ${path.relative(root, outFile)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Save failed: ${msg}`);
  }
}

function getNodeImportLevelForNext(snap: GraphSnapshot, nodeId: string): number {
  const n = snap.nodes.find((x) => x.id === nodeId);
  if (n && typeof n.importLevel === 'number') return n.importLevel;
  return 0;
}

async function runBacktrackFromWebview(
  nodeId: string,
  routeId: string,
  sourceJsonPath: string
): Promise<void> {
  if (nodeId.includes('::')) {
    vscode.window.showWarningMessage('Next is only available for file nodes, not controller methods.');
    return;
  }

  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) {
    vscode.window.showErrorMessage('No workspace root for Next.');
    return;
  }
  let graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData) {
    if (parseLiveImportSessionKey(sourceJsonPath)) {
      vscode.window.showErrorMessage('Could not load graph data for this session.');
      return;
    }
    try {
      const raw = fs.readFileSync(sourceJsonPath, 'utf-8');
      graphData = JSON.parse(raw) as GraphData;
    } catch {
      vscode.window.showErrorMessage('Could not load graph data for this session.');
      return;
    }
  }

  const routeKey =
    routeId && graphData.graphSnapshots[routeId]
      ? routeId
      : graphData.routeNames.find((r) => graphData.graphSnapshots[r]) ?? graphData.routeNames[0];
  if (!routeKey || !graphData.graphSnapshots[routeKey]) {
    vscode.window.showErrorMessage('No graph route available.');
    return;
  }

  const snap = graphData.graphSnapshots[routeKey];
  const seedLevel = getNodeImportLevelForNext(snap, nodeId);
  const importerImportLevel = seedLevel - 1;

  const { computeDirectImportersFromWorkspace } = await lazyBacktrackClosure();
  const { mergeBacktrackIntoRoute } = await lazyBacktrackMerge();

  const { closureRelPaths, edges } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Next: scanning workspace for files that import this module…',
      cancellable: true,
    },
    async (_progress, token) => computeDirectImportersFromWorkspace(nodeId, root, token)
  );

  if (closureRelPaths.length <= 1) {
    vscode.window.showInformationMessage('No workspace files import this module (local/path-alias imports only).');
    return;
  }

  const { newNodesAdded, newEdgesAdded } = mergeBacktrackIntoRoute(
    graphData,
    routeKey,
    closureRelPaths,
    edges,
    importerImportLevel
  );
  if (newNodesAdded <= 0 && newEdgesAdded <= 0) {
    vscode.window.showInformationMessage(
      'Next: every matching importer is already in this graph with edges — nothing new to add.'
    );
    return;
  }

  graphData.backtrack = {
    seedNodeRelPath: nodeId,
    closureRelPaths,
    generatedAt: Date.now(),
  };
  await attachGitHeat(graphData, getGitRepoRootForPath(sourceJsonPath));
  graphDataByJsonPath.set(sourceJsonPath, graphData);

  const displayLabel = `backtracked · ${sessionJsonBasenameForSave(sourceJsonPath)}`;
  const msg: UpsertSessionMessage = {
    type: 'upsertSession',
    sourceJsonPath,
    graphSnapshots: graphData.graphSnapshots,
    routeNames: graphData.routeNames,
    initialRouteId: routeKey,
    sessionMode: 'replace',
    isBacktrackSession: true,
    backtrackDirty: true,
    unsavedChanges: true,
    displayLabel,
    mergeInPlace: true,
  };
  getGraphPanel()?.instance?.deliverUpsertExternal(msg);

  const parts: string[] = [];
  if (newNodesAdded > 0) parts.push(`added ${newNodesAdded} file node(s)`);
  if (newEdgesAdded > 0) parts.push(`added ${newEdgesAdded} link(s)`);
  vscode.window.showInformationMessage(`Next: ${parts.join(', ')}. Use ▲/▼ (or arrow keys) to highlight import levels, including the new layer. Save with Ctrl+S or the tab.`);
}

async function saveBacktrackGraph(sourceJsonPath: string): Promise<void> {
  const graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData?.backtrack) {
    vscode.window.showWarningMessage('Nothing to save — run Next first.');
    return;
  }
  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder.');
    return;
  }
  const outDir = path.join(root, 'visualizer', 'backtracked');
  fs.mkdirSync(outDir, { recursive: true });
  const base = sessionJsonBasenameForSave(sourceJsonPath);
  const name = base.toLowerCase().startsWith('backtracked_') ? base : `backtracked_${base}`;
  const outPath = path.join(outDir, name);
  try {
    fs.writeFileSync(outPath, JSON.stringify(graphData, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Saved: ${path.relative(root, outPath)}`);
    graphDataByJsonPath.set(sourceJsonPath, graphData);
    getGraphPanel()?.instance?.postSessionState({ sourceJsonPath, backtrackDirty: false, unsavedChanges: false });
    notifySavedGraphsChanged();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Save failed: ${msg}`);
  }
}

async function promptSaveBacktrack(sourceJsonPath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'Save graph JSON (with Next importers) to visualizer/backtracked?',
    'Save',
    'Cancel'
  );
  if (choice === 'Save') await saveBacktrackGraph(sourceJsonPath);
}

async function loadAndShowFileGraph(
  context: vscode.ExtensionContext,
  jsonPath: string,
  mode: GraphPanelLoadMode = 'newWindow'
): Promise<void> {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const graphData: GraphData = JSON.parse(raw);

    if (graphData.routeNames.length === 0) {
      vscode.window.showWarningMessage('No routes found in file graph output.');
      return;
    }

    const fileRoute = graphData.routeNames.find((r) => r.startsWith('Import:')) ?? graphData.routeNames[0];
    const fileRelPath = fileRoute.replace(/^Import:\s*/, '');
    const skipRestore = fileDropProvider.hasSoftDeleted(fileRelPath);

    lastJsonPath = jsonPath;
    lastLiveSessionKey = undefined;
    graphDataByJsonPath.set(jsonPath, graphData);
    await attachGitHeat(graphData, getGitRepoRootForPath(jsonPath));

    const hooks = {
      ...graphPanelHooks(context),
      ...(graphData.backtrack
        ? {
            initialSession: {
              isBacktrackSession: true as const,
              backtrackDirty: false as const,
              displayLabel:
                customSessionLabelsByPath.get(jsonPath) ?? `backtracked · ${path.basename(jsonPath)}`,
              progressiveReveal: false as const,
            },
          }
        : {
            initialSession: {
              displayLabel: customSessionLabelsByPath.get(jsonPath),
              progressiveReveal: false,
            },
          }),
    };

    const GP = await ensureGraphPanel();
    GP.open(
      context.extensionUri,
      graphData,
      (routeNames) => {
        const fileRoutes = (routeNames || []).filter((r): r is string => typeof r === 'string' && r.startsWith('Import:'));
        if (!skipRestore) fileDropProvider.updateDroppedFiles(fileRoutes);
      },
      (filePath) => openFileInEditor(filePath),
      (filePath) => selectWorkspaceItemFromGraph(filePath),
      fileRoute,
      jsonPath,
      mode,
      hooks
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to load file graph: ${message}`);
  }
}

export function deactivate() {
  if (mcpConfigModulePromise) {
    void mcpConfigModulePromise.then((mcp) => mcp.stopAllMcpRunners(), () => {
      /* MCP layer was never fully loaded. */
    });
  }
}
