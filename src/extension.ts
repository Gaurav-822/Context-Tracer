import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileDropTreeProvider, relPathFromWorkspaceTreeId, scanSavedBacktrackedJson, toFileNamedBasename } from './fileDropTree';
import type { GraphData, GraphSnapshot } from './types';
import type { GraphPanelLoadMode, UpsertSessionMessage } from './graphPanel';
import {
  SearchSidebarViewProvider,
  SidebarTreeNode,
} from './searchSidebarView';

// Heavy modules loaded lazily on first use (keeps activation instant).
async function lazyGraphPanel() { return import('./graphPanel'); }
async function lazyFileGraphBuilder() { return import('./fileGraphBuilder'); }
async function lazyBacktrackClosure() { return import('./backtrackClosure'); }
async function lazyBacktrackMerge() { return import('./backtrackMerge'); }
async function lazyGitHeat() { return import('./gitHeat'); }

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

export function activate(context: vscode.ExtensionContext) {
  fileDropProvider = new FileDropTreeProvider(context);
  searchSidebarProvider = new SearchSidebarViewProvider(context.extensionUri, {
    listSavedGraphsForSidebar: () => listSavedGraphs(),
    onSaveSavedGraphCopyAs: (absPath) => saveSavedGraphCopyAsNewFile(absPath),
    onSavedGraphSaveInPlace: (absPath) => handleSavedGraphSaveInPlace(context, absPath),
    onSidebarDragPaths: (paths) => {
      pendingSidebarDragPaths = paths.length ? [...paths] : null;
      pendingSidebarDragAt = paths.length ? Date.now() : 0;
    },
    onRequestPanelData: async (params) => ({
      useLlm: fileDropProvider.useLlm,
      saved: listSavedGraphs(),
      tree: await buildWorkspaceTree(params),
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
    onOpenResult: async ({ resultType, absPath }) => {
      if (resultType === 'folder') {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absPath));
        return;
      }
      await buildGraphFromFile(context, absPath, fileDropProvider.useLlm);
    },
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('apiGraphVisualizer.fileDropTree', searchSidebarProvider));

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
    vscode.commands.registerCommand('apiGraphVisualizer.buildFromResource', (resource: vscode.Uri) => {
      if (resource?.fsPath) void buildGraphFromFile(context, resource.fsPath, false);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.pickFileForGraph', () => {
      void pickFileAndBuildGraph(context, fileDropProvider.useLlm);
    }),
    vscode.commands.registerCommand('apiGraphVisualizer.toggleFileGraphLlm', () => {
      fileDropProvider.toggleUseLlm();
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
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return [];
  return scanSavedBacktrackedJson(root).map((absPath) => ({
    label: path.basename(absPath),
    absPath,
    relPath: path.relative(root, absPath).replace(/\\/g, '/'),
  }));
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
    ...graphPanelHooks(),
    initialSession: { progressiveReveal, displayLabel: shortLabel },
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

function graphPanelHooks() {
  return {
    onBacktrack: (payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => {
      void runBacktrackFromWebview(payload.nodeId, payload.routeId, payload.sourceJsonPath);
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
    onSaveSession: (payload: {
      sourceJsonPath: string;
      saveToSaved?: boolean;
      graphSnapshots?: GraphData['graphSnapshots'];
    }) => {
      void saveSession(payload.sourceJsonPath, !!payload.saveToSaved, payload.graphSnapshots);
    },
  };
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
): Promise<void> {
  const graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData) return;
  const snap = graphData.graphSnapshots[routeId];
  if (!snap) return;
  const rel = toWorkspaceRelPathAny(droppedPath, sourceJsonPath);
  if (!rel) {
    vscode.window.showWarningMessage('Dropped file is outside the current workspace.');
    return;
  }
  const normalizedRel = normalizeGraphNodePath(rel);
  if (snap.nodes.some((n) => normalizeGraphNodePath(String(n.id || '')) === normalizedRel)) {
    return;
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
      ...graphPanelHooks(),
      ...(graphData.backtrack
        ? {
            initialSession: {
              isBacktrackSession: true as const,
              backtrackDirty: false as const,
              displayLabel: `backtracked · ${path.basename(jsonPath)}`,
              progressiveReveal: false as const,
            },
          }
        : {
            initialSession: {
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

export function deactivate() {}
