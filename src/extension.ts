import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildGraphSnapshots } from './builder';
import { buildFileGraph } from './fileGraphBuilder';
import { FileDropTreeProvider, toFileNamedBasename } from './fileDropTree';
import { GraphPanel } from './graphPanel';
import { TraceSidebarProvider } from './traceSidebar';
import { computeGitHeatByPath } from './gitHeat';
import { ApiJsonData, GraphData } from './types';

let lastJsonPath: string | undefined;
let traceSidebarProvider: TraceSidebarProvider;
let fileDropProvider: FileDropTreeProvider;
let fileDropTreeView: vscode.TreeView<vscode.TreeItem> | undefined;
let lastFileGraphUseLlm = false;
let traceGraphUseLlm = false;
let autoFollowEnabled = false;
let lastApiGraphMeta: { routeNames: string[]; nodeIds: string[] } | null = null;

export function activate(context: vscode.ExtensionContext) {
  traceSidebarProvider = new TraceSidebarProvider(context.extensionUri);

  fileDropProvider = new FileDropTreeProvider(
    context,
    (filePathOrUri, useLlm) => {
      const pathOrUri = typeof filePathOrUri === 'string' ? filePathOrUri : filePathOrUri.fsPath;
      void buildGraphFromFile(context, pathOrUri, useLlm);
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
    vscode.window.registerWebviewViewProvider(
      TraceSidebarProvider.viewType,
      traceSidebarProvider
    )
  );

  traceSidebarProvider.setOnCommandFromSidebar((msg) => {
    const type = msg.type as string;

    if (type === 'cmd:runMapper') {
      runMapperInTerminal(context);
      return;
    }

    if (type === 'cmd:openFile') {
      openFileInEditor(msg.filePath as string);
      return;
    }

    if (type === 'cmd:pickFileForGraph') {
      lastFileGraphUseLlm = !!(msg.useLlm as boolean);
      void pickFileAndBuildGraph(context, lastFileGraphUseLlm);
      return;
    }

    if (type === 'cmd:buildFileGraph') {
      lastFileGraphUseLlm = !!(msg.useLlm as boolean);
      buildGraphFromFile(context, msg.filePath as string, lastFileGraphUseLlm);
      return;
    }

    if (type === 'cmd:useLlmState') {
      lastFileGraphUseLlm = !!(msg.useLlm as boolean);
      return;
    }

    if (type === 'cmd:toggleFileGraphLlm') {
      fileDropProvider.toggleUseLlm();
      return;
    }

    if (type === 'cmd:toggleTraceGraphLlm') {
      traceGraphUseLlm = !traceGraphUseLlm;
      traceSidebarProvider.updateUseLlmState(traceGraphUseLlm);
      return;
    }

    if (type === 'cmd:autoFollowToggle') {
      autoFollowEnabled = !!(msg.on as boolean);
      traceSidebarProvider.updateAutoFollowState(autoFollowEnabled);
      return;
    }

    GraphPanel.currentPanel?.handleSidebarCommand(msg);
  });

  traceSidebarProvider.setOnSidebarOpened(() => {
    const jsonExists = !!findJsonInWorkspace();
    traceSidebarProvider.updateGenerateButtonState(jsonExists);
    traceSidebarProvider.updateUseLlmState(traceGraphUseLlm);
    traceSidebarProvider.updateAutoFollowState(autoFollowEnabled);
    fileDropProvider.refreshFromFilesNamed();
    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.reveal();
    } else {
      openVisualizer(context);
    }
  });

  traceSidebarProvider.setOnSidebarReady(() => {
    const jsonExists = !!findJsonInWorkspace();
    traceSidebarProvider.updateGenerateButtonState(jsonExists);
    traceSidebarProvider.updateUseLlmState(traceGraphUseLlm);
    traceSidebarProvider.updateAutoFollowState(autoFollowEnabled);
    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.requestGraphMeta();
    }
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!autoFollowEnabled || !editor || !GraphPanel.currentPanel) return;
      const uri = editor.document.uri;
      if (uri.scheme !== 'file') return;
      const ext = path.extname(uri.fsPath).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return;

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) return;

      let relativePath: string = uri.fsPath;
      for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        if (uri.fsPath.startsWith(folderPath + path.sep) || uri.fsPath === folderPath) {
          relativePath = path.relative(folderPath, uri.fsPath);
          break;
        }
      }
      relativePath = relativePath.replace(/\\/g, '/');
      GraphPanel.currentPanel.focusNodeInGraph(relativePath, true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.open', () => {
      openVisualizer(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.selectFile', () => {
      selectAndOpenFile(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.focusInGraph', () => {
      focusCurrentFileInGraph(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.buildFromCurrentFile', () => {
      buildFromCurrentFile(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.buildFromResource', (resource: vscode.Uri) => {
      if (resource?.fsPath) {
        void buildGraphFromFile(context, resource.fsPath, false);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.pickFileForGraph', () => {
      void pickFileAndBuildGraph(context, fileDropProvider.useLlm);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.toggleFileGraphLlm', () => {
      fileDropProvider.toggleUseLlm();
    })
  );

  const getSelectedFilePaths = (): string[] => {
    const paths: string[] = [];
    if (fileDropTreeView) {
      for (const sel of fileDropTreeView.selection) {
        if ((sel.contextValue === 'fileItem' || sel.contextValue === 'softDeletedFile') && typeof sel.label === 'string') {
          paths.push(sel.label);
        }
      }
    }
    return paths;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.softDeleteFromBuildFromFile', (item?: vscode.TreeItem) => {
      const paths = item?.contextValue === 'fileItem' && typeof item.label === 'string'
        ? [item.label]
        : getSelectedFilePaths();
      const fileOnly = paths.filter((p) => fileDropProvider.getDroppedFiles().includes(p));
      if (fileOnly.length > 0) fileDropProvider.softDelete(fileOnly);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.hardDeleteFromBuildFromFile', async (item?: vscode.TreeItem) => {
      const paths = item?.contextValue === 'fileItem' && typeof item.label === 'string'
        ? [item.label]
        : item?.contextValue === 'softDeletedFile' && typeof item.label === 'string'
          ? [item.label]
          : getSelectedFilePaths();
      const fileOnly = paths.filter((p) => fileDropProvider.getDroppedFiles().includes(p) || fileDropProvider.hasSoftDeleted(p));
      if (fileOnly.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Permanently delete ${fileOnly.length} file graph(s) and remove JSON from disk?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) return;
      const projectRoot = workspaceFolders[0].uri.fsPath;
      const filesNamedDir = path.join(projectRoot, 'visualizer', 'files_named');
      for (const relPath of fileOnly) {
        const jsonPath = path.join(filesNamedDir, toFileNamedBasename(relPath));
        try {
          if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        } catch {
          /* ignore */
        }
      }
      fileDropProvider.removeCompletely(fileOnly);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.restoreFromBuildFromFile', (item?: vscode.TreeItem) => {
      const paths = item?.contextValue === 'softDeletedFile' && typeof item.label === 'string'
        ? [item.label]
        : getSelectedFilePaths();
      const toRestore = paths.filter((p) => fileDropProvider.hasSoftDeleted(p));
      if (toRestore.length > 0) fileDropProvider.revive(toRestore);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('apiGraphVisualizer.loadImportRoute', async (_: unknown, routeId?: string) => {
      if (!routeId) return;
      const relPath = routeId.replace(/^Import:\s*/, '');
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) return;
      const projectRoot = workspaceFolders[0].uri.fsPath;
      const jsonPath = path.join(projectRoot, 'visualizer', 'files_named', toFileNamedBasename(relPath));
      if (fs.existsSync(jsonPath)) {
        await loadAndShowFileGraph(context, jsonPath);
      } else {
        GraphPanel.currentPanel?.handleSidebarCommand({ type: 'cmd:loadRoute', routeId });
        const absPath = path.join(projectRoot, relPath);
        if (fs.existsSync(absPath)) {
          void buildGraphFromFile(context, absPath, fileDropProvider.useLlm);
        }
      }
    })
  );

  autoDetectJsonFile(context);
}

async function buildFromCurrentFile(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a file first to build its import graph.');
    return;
  }
  const uri = editor.document.uri;
  if (uri.scheme !== 'file') return;
  const filePath = uri.fsPath;
  const ext = path.extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    vscode.window.showWarningMessage('Select a TypeScript or JavaScript file.');
    return;
  }
  await buildGraphFromFile(context, filePath, false);
}

function focusCurrentFileInGraph(_context: vscode.ExtensionContext): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const uri = editor.document.uri;
  if (uri.scheme !== 'file') return;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) return;

  let relativePath: string = uri.fsPath;
  for (const folder of workspaceFolders) {
    const folderPath = folder.uri.fsPath;
    if (uri.fsPath.startsWith(folderPath + path.sep) || uri.fsPath === folderPath) {
      relativePath = path.relative(folderPath, uri.fsPath);
      break;
    }
  }
  relativePath = relativePath.replace(/\\/g, '/');

  if (!GraphPanel.currentPanel) {
    vscode.window.showInformationMessage('Open the API Graph first to focus this file.');
    return;
  }

  GraphPanel.currentPanel.focusNodeInGraph(relativePath);
}

function runMapperInTerminal(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('No workspace folder open.');
    return;
  }

  const projectRoot = workspaceFolders[0].uri.fsPath;
  const scriptPath = path.join(context.extensionPath, 'dist', 'scripts', 'makeMap.ts');

  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage('Mapper script not found. Rebuild the extension.');
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: 'API Graph Mapper',
    cwd: projectRoot,
    env: { PROJECT_ROOT: projectRoot },
  });
  terminal.show();
  const llmFlag = traceGraphUseLlm ? ' --llm' : '';
  terminal.sendText(`npx ts-node "${scriptPath}"${llmFlag}`);
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

async function openVisualizer(context: vscode.ExtensionContext): Promise<void> {
  if (lastJsonPath && fs.existsSync(lastJsonPath)) {
    await loadAndShowGraph(context, lastJsonPath);
    return;
  }

  const detected = findJsonInWorkspace();
  if (detected) {
    lastJsonPath = detected;
    await loadAndShowGraph(context, detected);
    return;
  }

  vscode.window.showInformationMessage(
    'No API graph found. Click "Update Graph" to generate from your workspace.'
  );
}

async function selectAndOpenFile(context: vscode.ExtensionContext): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'JSON Files': ['json'] },
    openLabel: 'Select API Graph JSON',
  });

  if (uris && uris.length > 0) {
    lastJsonPath = uris[0].fsPath;
    await loadAndShowGraph(context, lastJsonPath);
  }
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

async function loadAndShowGraph(
  context: vscode.ExtensionContext,
  jsonPath: string
): Promise<void> {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const data: ApiJsonData = JSON.parse(raw);
    let graphData: GraphData = buildGraphSnapshots(data);
    attachGitHeat(graphData, getGitRepoRootForPath(jsonPath));

    if (graphData.routeNames.length === 0) {
      vscode.window.showWarningMessage('No API routes found in the selected JSON file.');
      return;
    }

    lastApiGraphMeta = { routeNames: graphData.routeNames, nodeIds: [] };
    GraphPanel.createOrShow(context.extensionUri, graphData, (traceState) => {
      traceSidebarProvider.updateTraceState(traceState);
    }, (routeNames, nodeIds, currentRouteId) => {
      lastApiGraphMeta = { routeNames: routeNames || [], nodeIds: nodeIds || [] };
      traceSidebarProvider.updateGraphMeta(routeNames, nodeIds, 'api', currentRouteId);
      const imports = (routeNames || []).filter((r): r is string => typeof r === 'string' && r.startsWith('Import:'));
      fileDropProvider.updateDroppedFiles(imports);
    }, (msg) => {
      if ((msg.type as string) === 'cmd:openFile') {
        openFileInEditor(msg.filePath as string);
      } else {
        traceSidebarProvider.forwardToSidebar(msg);
      }
    });

    traceSidebarProvider.updateGenerateButtonState(true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to load API graph: ${message}`);
  }
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
    traceSidebarProvider.updateGenerateButtonState(true);
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

function findJsonInWorkspace(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return undefined;

  for (const folder of workspaceFolders) {
    const inVisualizer = path.join(folder.uri.fsPath, 'visualizer', 'api_graph_output.json');
    if (fs.existsSync(inVisualizer)) return inVisualizer;
    const inRoot = path.join(folder.uri.fsPath, 'api_graph_output.json');
    if (fs.existsSync(inRoot)) return inRoot;
  }
  return undefined;
}

function autoDetectJsonFile(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher('**/api_graph_output.json');

  watcher.onDidCreate((uri) => {
    lastJsonPath = uri.fsPath;
    traceSidebarProvider.updateGenerateButtonState(true);
    void loadAndShowGraph(context, uri.fsPath);
  });

  watcher.onDidChange((uri) => {
    if (lastJsonPath === uri.fsPath && GraphPanel.currentPanel) {
      void loadAndShowGraph(context, uri.fsPath);
    }
  });

  context.subscriptions.push(watcher);

  const fileGraphWatcher = vscode.workspace.createFileSystemWatcher('**/file_graph_output.json');
  const filesNamedWatcher = vscode.workspace.createFileSystemWatcher('**/visualizer/files_named/*.json');

  const loadFileGraphFromUri = (uri: vscode.Uri) => {
    lastJsonPath = uri.fsPath;
    loadAndShowFileGraph(context, uri.fsPath);
    traceSidebarProvider.updateGenerateButtonState(true);
  };

  fileGraphWatcher.onDidCreate(loadFileGraphFromUri);
  fileGraphWatcher.onDidChange((uri) => loadAndShowFileGraph(context, uri.fsPath));

  filesNamedWatcher.onDidCreate((uri) => {
    loadFileGraphFromUri(uri);
    fileDropProvider.refreshFromFilesNamed();
  });
  filesNamedWatcher.onDidChange((uri) => {
    loadAndShowFileGraph(context, uri.fsPath);
    fileDropProvider.refreshFromFilesNamed();
  });
  filesNamedWatcher.onDidDelete(() => fileDropProvider.refreshFromFilesNamed());

  context.subscriptions.push(fileGraphWatcher, filesNamedWatcher);

  const detected = findJsonInWorkspace();
  if (detected) {
    lastJsonPath = detected;
  }
}

async function loadAndShowFileGraph(
  context: vscode.ExtensionContext,
  jsonPath: string
): Promise<void> {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    let graphData: GraphData = JSON.parse(raw);

    if (graphData.routeNames.length === 0) {
      vscode.window.showWarningMessage('No routes found in file graph output.');
      return;
    }

    const fileRoute = graphData.routeNames.find((r) => r.startsWith('Import:')) ?? graphData.routeNames[0];
    const fileRelPath = fileRoute.replace(/^Import:\s*/, '');
    const skipRestore = fileDropProvider.hasSoftDeleted(fileRelPath);
    const apiJsonPath = findJsonInWorkspace();
    if (apiJsonPath && apiJsonPath !== jsonPath) {
      try {
        const apiRaw = fs.readFileSync(apiJsonPath, 'utf-8');
        const apiData: ApiJsonData = JSON.parse(apiRaw);
        const apiGraphData = buildGraphSnapshots(apiData);
        if (apiGraphData.routeNames.length > 0) {
          graphData = {
            graphSnapshots: { ...apiGraphData.graphSnapshots, ...graphData.graphSnapshots },
            routeNames: [...apiGraphData.routeNames, ...graphData.routeNames.filter((r) => !apiGraphData.routeNames.includes(r))],
          };
          lastApiGraphMeta = { routeNames: apiGraphData.routeNames, nodeIds: [] };
        }
      } catch {
        /* ignore */
      }
    }

    lastJsonPath = jsonPath;
    attachGitHeat(graphData, getGitRepoRootForPath(jsonPath));

    GraphPanel.createOrShow(context.extensionUri, graphData, (traceState) => {
      traceSidebarProvider.updateTraceState(traceState);
    }, (routeNames, nodeIds) => {
      const apiRoutes = lastApiGraphMeta?.routeNames ?? [];
      const fileRoutes = (routeNames || []).filter((r): r is string => typeof r === 'string' && r.startsWith('Import:'));
      const apiNodeIds = lastApiGraphMeta?.nodeIds ?? [];
      const fileNodeIds = nodeIds || [];
      const mergedRoutes = [...apiRoutes, ...fileRoutes.filter((r) => !apiRoutes.includes(r))];
      const mergedNodeIds = [...new Set([...apiNodeIds, ...fileNodeIds])];
      traceSidebarProvider.updateGraphMeta(mergedRoutes, mergedNodeIds, 'file');
      if (!skipRestore) fileDropProvider.updateDroppedFiles(fileRoutes);
    }, (msg) => {
      if ((msg.type as string) === 'cmd:openFile') {
        openFileInEditor(msg.filePath as string);
      } else {
        traceSidebarProvider.forwardToSidebar(msg);
      }
    }, fileRoute);

    traceSidebarProvider.updateGenerateButtonState(true);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to load file graph: ${message}`);
  }
}

export function deactivate() {}
