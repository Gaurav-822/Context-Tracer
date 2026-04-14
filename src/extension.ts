import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildFileGraph } from './fileGraphBuilder';
import { FileDropTreeProvider, relPathFromWorkspaceTreeId, toFileNamedBasename } from './fileDropTree';
import { computeImporterClosureFromOpenEditors } from './backtrackClosure';
import { mergeBacktrackIntoRoute } from './backtrackMerge';
import { GraphPanel, GraphPanelLoadMode, UpsertSessionMessage } from './graphPanel';
import { computeGitHeatByPath } from './gitHeat';
import { GraphData } from './types';

/** Latest graph JSON in memory per open Import graph tab (for backtrack save). */
const graphDataByJsonPath = new Map<string, GraphData>();

let lastJsonPath: string | undefined;
let fileDropProvider: FileDropTreeProvider;
let fileDropTreeView: vscode.TreeView<vscode.TreeItem> | undefined;

export function activate(context: vscode.ExtensionContext) {
  fileDropProvider = new FileDropTreeProvider(
    context,
    (filePathOrUri, useLlm) => {
      const fp = typeof filePathOrUri === 'string' ? filePathOrUri : filePathOrUri.fsPath;
      void buildGraphFromFile(context, fp, useLlm);
    },
    (paths, useLlm) => {
      for (const p of paths) {
        const fp = typeof p === 'string' ? p : p.fsPath;
        void buildGraphFromFile(context, fp, useLlm);
      }
    }
  );
  fileDropTreeView = vscode.window.createTreeView('apiGraphVisualizer.fileDropTree', {
    treeDataProvider: fileDropProvider,
    dragAndDropController: fileDropProvider,
  });
  context.subscriptions.push(fileDropTreeView);
  fileDropProvider.refreshFromFilesNamed();

  context.subscriptions.push(
    fileDropTreeView.onDidChangeVisibility((e) => {
      if (e.visible) {
        fileDropProvider.refreshFromFilesNamed();
        GraphPanel.instance?.requestGraphMeta();
      }
    }),
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
      const jsonPath = path.join(root, 'visualizer', 'files_named', toFileNamedBasename(relPath));
      if (fs.existsSync(jsonPath)) {
        await loadAndShowFileGraph(context, jsonPath);
      } else {
        const absPath = path.join(root, relPath);
        if (fs.existsSync(absPath)) void buildGraphFromFile(context, absPath, fileDropProvider.useLlm);
      }
    })
  );

  autoDetectFileGraphs(context);
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
  GraphPanel.instance?.focusNodeInGraph(relativePath.replace(/\\/g, '/'));
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

function attachGitHeat(graphData: GraphData, cwd: string | undefined): void {
  delete graphData.gitHeatByPath;
  if (!cwd) return;
  const paths = collectRelPathsFromGraph(graphData);
  if (paths.length === 0) return;
  try {
    const heat = computeGitHeatByPath(cwd, paths);
    const anyHot = Object.values(heat).some((v) => v > 0);
    graphData.gitHeatByPath = anyHot ? heat : undefined;
  } catch {
    /* ignore */
  }
}

async function openVisualizer(context: vscode.ExtensionContext): Promise<void> {
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
  vscode.window.showInformationMessage('No file graph found. Use "Build From File" to create one.');
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

  if (useLlm) {
    runFileGraphScriptInTerminal(context, absPath, effectiveRoot, outPath);
    return;
  }

  const status = vscode.window.setStatusBarMessage('Building import graph...');

  try {
    const graphData = await buildFileGraph(absPath, effectiveRoot, false);
    if (!fs.existsSync(filesNamedDir)) fs.mkdirSync(filesNamedDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(graphData, null, 2), 'utf-8');

    fileDropProvider.updateDroppedFiles([`Import: ${relPath}`]);
    await loadAndShowFileGraph(context, outPath);
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
  };
}

async function runBacktrackFromWebview(
  nodeId: string,
  routeId: string,
  sourceJsonPath: string
): Promise<void> {
  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) {
    vscode.window.showErrorMessage('No workspace root for backtrack.');
    return;
  }
  let graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData) {
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
    vscode.window.showErrorMessage('No graph route available for backtrack.');
    return;
  }

  const { closureRelPaths, edges } = computeImporterClosureFromOpenEditors(nodeId, root);
  if (closureRelPaths.length <= 1) {
    vscode.window.showInformationMessage(
      'No open files import this node yet. Open files that import it, then run Backtrack again.'
    );
    return;
  }

  const { newNodesAdded } = mergeBacktrackIntoRoute(graphData, routeKey, closureRelPaths, edges);
  if (newNodesAdded <= 0) {
    vscode.window.showInformationMessage(
      'Backtrack: every file in the closure is already in this graph — nothing new to add.'
    );
    return;
  }

  graphData.backtrack = {
    seedNodeRelPath: nodeId,
    closureRelPaths,
    generatedAt: Date.now(),
  };
  attachGitHeat(graphData, getGitRepoRootForPath(sourceJsonPath));
  graphDataByJsonPath.set(sourceJsonPath, graphData);

  const displayLabel = `backtracked · ${path.basename(sourceJsonPath)}`;
  const msg: UpsertSessionMessage = {
    type: 'upsertSession',
    sourceJsonPath,
    graphSnapshots: graphData.graphSnapshots,
    routeNames: graphData.routeNames,
    initialRouteId: routeKey,
    sessionMode: 'replace',
    isBacktrackSession: true,
    backtrackDirty: true,
    displayLabel,
  };
  GraphPanel.instance?.deliverUpsertExternal(msg);

  vscode.window.showInformationMessage(
    `Backtrack: added ${newNodesAdded} new file node(s). Save with Ctrl+S or the tab.`
  );
}

async function saveBacktrackGraph(sourceJsonPath: string): Promise<void> {
  const graphData = graphDataByJsonPath.get(sourceJsonPath);
  if (!graphData?.backtrack) {
    vscode.window.showWarningMessage('Nothing to save — run Backtrack first.');
    return;
  }
  const root = getPreferredProjectRoot(sourceJsonPath);
  if (!root) {
    vscode.window.showErrorMessage('No workspace folder.');
    return;
  }
  const outDir = path.join(root, 'visualizer', 'backtracked');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(sourceJsonPath);
  const name = base.toLowerCase().startsWith('backtracked_') ? base : `backtracked_${base}`;
  const outPath = path.join(outDir, name);
  try {
    fs.writeFileSync(outPath, JSON.stringify(graphData, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Saved: ${path.relative(root, outPath)}`);
    graphDataByJsonPath.set(sourceJsonPath, graphData);
    GraphPanel.instance?.postSessionState({ sourceJsonPath, backtrackDirty: false });
    fileDropProvider.refreshSavedGraphs();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Save failed: ${msg}`);
  }
}

async function promptSaveBacktrack(sourceJsonPath: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'Save backtracked graph JSON to visualizer/backtracked?',
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
    graphDataByJsonPath.set(jsonPath, graphData);
    attachGitHeat(graphData, getGitRepoRootForPath(jsonPath));

    const hooks = {
      ...graphPanelHooks(),
      ...(graphData.backtrack
        ? {
            initialSession: {
              isBacktrackSession: true as const,
              backtrackDirty: false as const,
              displayLabel: `backtracked · ${path.basename(jsonPath)}`,
            },
          }
        : {}),
    };

    GraphPanel.open(
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
