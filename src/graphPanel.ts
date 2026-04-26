import * as vscode from 'vscode';
import { GraphData } from './types';

export type GraphPanelLoadMode = 'newWindow' | 'refreshOpenOrOpen';

/** Webview → extension when saving so node x/y from vis-network are persisted. */
export type SaveSessionPayload = {
  sourceJsonPath: string;
  saveToSaved?: boolean;
  graphSnapshots?: GraphData['graphSnapshots'];
};

/** Sent to webview to add/update a graph session (tabs live inside the single Map View panel). */
export interface UpsertSessionMessage {
  type: 'upsertSession';
  sourceJsonPath: string;
  graphSnapshots: GraphData['graphSnapshots'];
  routeNames: string[];
  initialRouteId: string | undefined;
  /** add: new tab (or replace same path). replace: update existing tab for this JSON only. */
  sessionMode: 'add' | 'replace';
  /** Explicit session flags (do not infer from filename). */
  isBacktrackSession?: boolean;
  backtrackDirty?: boolean;
  /** Tab dirty dot for layout edits; cleared on save. */
  unsavedChanges?: boolean;
  /** Optional tab label (e.g. "backtracked · file.json"). */
  displayLabel?: string;
  /** True = level-by-level reveal, false = load all at once. */
  progressiveReveal?: boolean;
  /** If true, webview should start inline tab rename for this session. */
  startRename?: boolean;
  /**
   * With sessionMode `replace` on the already-active tab: patch the current route in the webview
   * (add/remove nodes/edges to match JSON) without a full reload — preserves pan/zoom/selection.
   */
  mergeInPlace?: boolean;
}

export interface SessionStateMessage {
  type: 'sessionState';
  sourceJsonPath: string;
  isBacktrackSession?: boolean;
  backtrackDirty?: boolean;
  /** True when layout or graph content changed since last save (yellow tab dot). */
  unsavedChanges?: boolean;
  displayLabel?: string;
}

export class GraphPanel {
  private static readonly viewType = 'apiGraphVisualizer.graphView';
  /** Single Map View editor tab; multiple graphs are tabs inside its webview. */
  static instance: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private onGraphMetaReady: ((routeNames: string[], nodeIds: string[], currentRouteId?: string) => void) | null = null;
  private onOpenFileFromGraph: ((filePath: string) => void) | null = null;
  private onSelectFileInWorkspaceFromGraph: ((filePath: string) => void) | null = null;
  private onBacktrack:
    | ((payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => void)
    | null = null;
  private onRevertTraceNode:
    | ((payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => void)
    | null = null;
  private onSaveBacktrack: ((sourceJsonPath: string) => void) | null = null;
  private onSaveBacktrackPrompt: ((sourceJsonPath: string) => void) | null = null;
  private onAddNodeFromDrop:
    | ((payload: {
      droppedPath: string;
      routeId: string;
      sourceJsonPath: string;
      dropX?: number;
      dropY?: number;
    }) => void)
    | null = null;
  private onAddRecentTreeDrag:
    | ((payload: { routeId: string; sourceJsonPath: string; dropX?: number; dropY?: number }) => void)
    | null = null;
  private onCreateEmptyGraph: (() => void) | null = null;
  private onRenameSession:
    | ((payload: { sourceJsonPath: string; displayLabel: string }) => void)
    | null = null;
  private onSearchWorkspaceFiles:
    | ((payload: { query: string; sourceJsonPath: string; requestToken: string }) => void)
    | null = null;
  private onStartSidebarPlacement:
    | ((payload: { routeId: string; sourceJsonPath: string; dropX: number; dropY: number }) => void)
    | null = null;
  private onGraphDrop:
    | ((payload: {
        routeId: string;
        sourceJsonPath: string;
        pathsFromDataTransfer: string[];
        dropX?: number;
        dropY?: number;
      }) => void)
    | null = null;
  private onConnectNodes:
    | ((payload: { fromNodeId: string; toNodeId: string; routeId: string; sourceJsonPath: string }) => void)
    | null = null;
  private onGraphSidebarState:
    | ((payload: { showConnectImports: boolean; connectLabel: string; connectActive: boolean }) => void)
    | null = null;
  private onSaveMdFile:
    | ((payload: { fileName: string; content: string }) => void | Promise<void>)
    | null = null;
  private onSaveSession: ((payload: SaveSessionPayload) => void) | null = null;
  private pendingUpsert: UpsertSessionMessage | null = null;
  private readonly exportWaiters = new Map<
    string,
    { resolve: (v: { graphSnapshots: GraphData['graphSnapshots']; routeNames: string[] } | null) => void; timeout: ReturnType<typeof setTimeout> }
  >();

  public static open(
    extensionUri: vscode.Uri,
    graphData: GraphData,
    onGraphMetaReady: (routeNames: string[], nodeIds: string[], currentRouteId?: string) => void,
    onOpenFileFromGraph: (filePath: string) => void,
    onSelectFileInWorkspaceFromGraph: (filePath: string) => void,
    initialRouteId: string | undefined,
    sourceJsonPath: string,
    mode: GraphPanelLoadMode,
    hooks?: {
      onBacktrack?: (payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => void;
      onRevertTraceNode?: (payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => void;
      onSaveBacktrack?: (sourceJsonPath: string) => void;
      onSaveBacktrackPrompt?: (sourceJsonPath: string) => void;
      onAddNodeFromDrop?: (payload: {
        droppedPath: string;
        routeId: string;
        sourceJsonPath: string;
        dropX?: number;
        dropY?: number;
      }) => void;
      onAddRecentTreeDrag?: (payload: { routeId: string; sourceJsonPath: string; dropX?: number; dropY?: number }) => void;
      onCreateEmptyGraph?: () => void;
      onRenameSession?: (payload: { sourceJsonPath: string; displayLabel: string }) => void;
      onSearchWorkspaceFiles?: (payload: { query: string; sourceJsonPath: string; requestToken: string }) => void;
      onStartSidebarPlacement?: (payload: { routeId: string; sourceJsonPath: string; dropX: number; dropY: number }) => void;
      onGraphDrop?: (payload: {
        routeId: string;
        sourceJsonPath: string;
        pathsFromDataTransfer: string[];
        dropX?: number;
        dropY?: number;
      }) => void;
      onConnectNodes?: (payload: { fromNodeId: string; toNodeId: string; routeId: string; sourceJsonPath: string }) => void;
      onGraphSidebarState?: (payload: { showConnectImports: boolean; connectLabel: string; connectActive: boolean }) => void;
      onSaveMdFile?: (payload: { fileName: string; content: string }) => void | Promise<void>;
      onSaveSession?: (payload: SaveSessionPayload) => void;
      /** When loading JSON that was saved after backtrack, restore tab styling without inferring from filename. */
      initialSession?: {
        isBacktrackSession?: boolean;
        backtrackDirty?: boolean;
        displayLabel?: string;
        progressiveReveal?: boolean;
        startRename?: boolean;
      };
    }
  ): GraphPanel {
    const sessionMode: 'add' | 'replace' =
      mode === 'refreshOpenOrOpen' ? 'replace' : 'add';

    const ini = hooks?.initialSession;
    const msg: UpsertSessionMessage = {
      type: 'upsertSession',
      sourceJsonPath,
      graphSnapshots: graphData.graphSnapshots,
      routeNames: graphData.routeNames,
      initialRouteId,
      sessionMode,
      isBacktrackSession: ini?.isBacktrackSession ?? false,
      backtrackDirty: ini?.backtrackDirty ?? false,
      unsavedChanges: false,
      progressiveReveal: ini?.progressiveReveal ?? false,
      startRename: ini?.startRename ?? false,
    };
    if (ini?.displayLabel !== undefined) {
      msg.displayLabel = ini.displayLabel;
    }

    if (GraphPanel.instance) {
      GraphPanel.instance.onGraphMetaReady = onGraphMetaReady;
      GraphPanel.instance.onOpenFileFromGraph = onOpenFileFromGraph;
      GraphPanel.instance.onSelectFileInWorkspaceFromGraph = onSelectFileInWorkspaceFromGraph;
      GraphPanel.instance.onBacktrack = hooks?.onBacktrack ?? null;
      GraphPanel.instance.onRevertTraceNode = hooks?.onRevertTraceNode ?? null;
      GraphPanel.instance.onSaveBacktrack = hooks?.onSaveBacktrack ?? null;
      GraphPanel.instance.onSaveBacktrackPrompt = hooks?.onSaveBacktrackPrompt ?? null;
      GraphPanel.instance.onAddNodeFromDrop = hooks?.onAddNodeFromDrop ?? null;
      GraphPanel.instance.onAddRecentTreeDrag = hooks?.onAddRecentTreeDrag ?? null;
      GraphPanel.instance.onCreateEmptyGraph = hooks?.onCreateEmptyGraph ?? null;
      GraphPanel.instance.onRenameSession = hooks?.onRenameSession ?? null;
      GraphPanel.instance.onSearchWorkspaceFiles = hooks?.onSearchWorkspaceFiles ?? null;
      GraphPanel.instance.onStartSidebarPlacement = hooks?.onStartSidebarPlacement ?? null;
      GraphPanel.instance.onGraphDrop = hooks?.onGraphDrop ?? null;
      GraphPanel.instance.onConnectNodes = hooks?.onConnectNodes ?? null;
      GraphPanel.instance.onGraphSidebarState = hooks?.onGraphSidebarState ?? null;
      GraphPanel.instance.onSaveMdFile = hooks?.onSaveMdFile ?? null;
      GraphPanel.instance.onSaveSession = hooks?.onSaveSession ?? null;
      GraphPanel.instance.deliverUpsert(msg);
      GraphPanel.instance.reveal();
      return GraphPanel.instance;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    const webviewPanel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Map View',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    webviewPanel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg'),
    };

    GraphPanel.instance = new GraphPanel(
      webviewPanel,
      extensionUri,
      onGraphMetaReady,
      onOpenFileFromGraph,
      onSelectFileInWorkspaceFromGraph,
      hooks?.onBacktrack ?? null,
      hooks?.onRevertTraceNode ?? null,
      hooks?.onSaveBacktrack ?? null,
      hooks?.onSaveBacktrackPrompt ?? null,
      hooks?.onAddNodeFromDrop ?? null,
      hooks?.onAddRecentTreeDrag ?? null,
      hooks?.onCreateEmptyGraph ?? null,
      hooks?.onRenameSession ?? null,
      hooks?.onSearchWorkspaceFiles ?? null,
      hooks?.onStartSidebarPlacement ?? null,
      hooks?.onGraphDrop ?? null,
      hooks?.onConnectNodes ?? null,
      hooks?.onGraphSidebarState ?? null,
      hooks?.onSaveMdFile ?? null,
      hooks?.onSaveSession ?? null,
      msg
    );
    GraphPanel.instance.reveal();
    return GraphPanel.instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    onGraphMetaReady: (routeNames: string[], nodeIds: string[], currentRouteId?: string) => void,
    onOpenFileFromGraph: (filePath: string) => void,
    onSelectFileInWorkspaceFromGraph: (filePath: string) => void,
    onBacktrack: GraphPanel['onBacktrack'],
    onRevertTraceNode: GraphPanel['onRevertTraceNode'],
    onSaveBacktrack: GraphPanel['onSaveBacktrack'],
    onSaveBacktrackPrompt: GraphPanel['onSaveBacktrackPrompt'],
    onAddNodeFromDrop: GraphPanel['onAddNodeFromDrop'],
    onAddRecentTreeDrag: GraphPanel['onAddRecentTreeDrag'],
    onCreateEmptyGraph: GraphPanel['onCreateEmptyGraph'],
    onRenameSession: GraphPanel['onRenameSession'],
    onSearchWorkspaceFiles: GraphPanel['onSearchWorkspaceFiles'],
    onStartSidebarPlacement: GraphPanel['onStartSidebarPlacement'],
    onGraphDrop: GraphPanel['onGraphDrop'],
    onConnectNodes: GraphPanel['onConnectNodes'],
    onGraphSidebarState: GraphPanel['onGraphSidebarState'],
    onSaveMdFile: GraphPanel['onSaveMdFile'],
    onSaveSession: GraphPanel['onSaveSession'],
    firstUpsert: UpsertSessionMessage
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.onGraphMetaReady = onGraphMetaReady;
    this.onOpenFileFromGraph = onOpenFileFromGraph;
    this.onSelectFileInWorkspaceFromGraph = onSelectFileInWorkspaceFromGraph;
    this.onBacktrack = onBacktrack;
    this.onRevertTraceNode = onRevertTraceNode;
    this.onSaveBacktrack = onSaveBacktrack;
    this.onSaveBacktrackPrompt = onSaveBacktrackPrompt;
    this.onAddNodeFromDrop = onAddNodeFromDrop;
    this.onAddRecentTreeDrag = onAddRecentTreeDrag;
    this.onCreateEmptyGraph = onCreateEmptyGraph;
    this.onRenameSession = onRenameSession;
    this.onSearchWorkspaceFiles = onSearchWorkspaceFiles;
    this.onStartSidebarPlacement = onStartSidebarPlacement;
    this.onGraphDrop = onGraphDrop;
    this.onConnectNodes = onConnectNodes;
    this.onGraphSidebarState = onGraphSidebarState;
    this.onSaveMdFile = onSaveMdFile;
    this.onSaveSession = onSaveSession;
    this.pendingUpsert = firstUpsert;

    this.panel.webview.html = this.getHtmlForWebview();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'ready':
            if (this.pendingUpsert) {
              this.deliverUpsert(this.pendingUpsert);
              this.pendingUpsert = null;
            }
            break;
          case 'graphMetaReady':
            if (this.onGraphMetaReady) {
              this.onGraphMetaReady(message.routeNames, message.nodeIds, message.currentRouteId);
            }
            break;
          case 'cmd:openFile':
            if (this.onOpenFileFromGraph && message.filePath) {
              this.onOpenFileFromGraph(message.filePath as string);
            }
            break;
          case 'cmd:selectInWorkspace':
            if (this.onSelectFileInWorkspaceFromGraph && message.filePath) {
              this.onSelectFileInWorkspaceFromGraph(message.filePath as string);
            }
            break;
          case 'cmd:backtrack':
            if (
              this.onBacktrack &&
              typeof message.nodeId === 'string' &&
              typeof message.sourceJsonPath === 'string'
            ) {
              this.onBacktrack({
                nodeId: message.nodeId,
                routeId: typeof message.routeId === 'string' ? message.routeId : '',
                sourceJsonPath: message.sourceJsonPath,
              });
            }
            break;
          case 'cmd:revertTraceNode':
            if (
              this.onRevertTraceNode &&
              typeof message.nodeId === 'string' &&
              typeof message.sourceJsonPath === 'string'
            ) {
              this.onRevertTraceNode({
                nodeId: message.nodeId,
                routeId: typeof message.routeId === 'string' ? message.routeId : '',
                sourceJsonPath: message.sourceJsonPath,
              });
            }
            break;
          case 'cmd:saveBacktrack':
            if (this.onSaveBacktrack && typeof message.sourceJsonPath === 'string') {
              this.onSaveBacktrack(message.sourceJsonPath);
            }
            break;
          case 'cmd:saveBacktrackPrompt':
            if (this.onSaveBacktrackPrompt && typeof message.sourceJsonPath === 'string') {
              this.onSaveBacktrackPrompt(message.sourceJsonPath);
            }
            break;
          case 'cmd:addNodeFromDrop':
            if (
              this.onAddNodeFromDrop &&
              typeof message.droppedPath === 'string' &&
              typeof message.routeId === 'string' &&
              typeof message.sourceJsonPath === 'string'
            ) {
              this.onAddNodeFromDrop({
                droppedPath: message.droppedPath,
                routeId: message.routeId,
                sourceJsonPath: message.sourceJsonPath,
                dropX: typeof message.dropX === 'number' ? message.dropX : undefined,
                dropY: typeof message.dropY === 'number' ? message.dropY : undefined,
              });
            }
            break;
          case 'cmd:addRecentTreeDrag':
            if (
              this.onAddRecentTreeDrag &&
              typeof message.routeId === 'string' &&
              typeof message.sourceJsonPath === 'string'
            ) {
              this.onAddRecentTreeDrag({
                routeId: message.routeId,
                sourceJsonPath: message.sourceJsonPath,
                dropX: typeof message.dropX === 'number' ? message.dropX : undefined,
                dropY: typeof message.dropY === 'number' ? message.dropY : undefined,
              });
            }
            break;
          case 'cmd:createEmptyGraph':
            if (this.onCreateEmptyGraph) this.onCreateEmptyGraph();
            break;
          case 'cmd:renameSession':
            if (
              this.onRenameSession &&
              typeof message.sourceJsonPath === 'string' &&
              typeof message.displayLabel === 'string'
            ) {
              this.onRenameSession({
                sourceJsonPath: message.sourceJsonPath,
                displayLabel: message.displayLabel,
              });
            }
            break;
          case 'cmd:searchWorkspaceFiles':
            if (
              this.onSearchWorkspaceFiles &&
              typeof message.query === 'string' &&
              typeof message.sourceJsonPath === 'string' &&
              typeof message.requestToken === 'string'
            ) {
              this.onSearchWorkspaceFiles({
                query: message.query,
                sourceJsonPath: message.sourceJsonPath,
                requestToken: message.requestToken,
              });
            }
            break;
          case 'cmd:startSidebarPlacement':
            if (
              this.onStartSidebarPlacement &&
              typeof message.routeId === 'string' &&
              typeof message.sourceJsonPath === 'string' &&
              typeof message.dropX === 'number' &&
              typeof message.dropY === 'number'
            ) {
              this.onStartSidebarPlacement({
                routeId: message.routeId,
                sourceJsonPath: message.sourceJsonPath,
                dropX: message.dropX,
                dropY: message.dropY,
              });
            }
            break;
          case 'cmd:graphDrop':
            if (
              this.onGraphDrop &&
              typeof message.routeId === 'string' &&
              typeof message.sourceJsonPath === 'string' &&
              Array.isArray((message as { pathsFromDataTransfer?: unknown }).pathsFromDataTransfer)
            ) {
              this.onGraphDrop({
                routeId: message.routeId,
                sourceJsonPath: message.sourceJsonPath,
                pathsFromDataTransfer: (message as { pathsFromDataTransfer: string[] }).pathsFromDataTransfer,
                dropX: typeof message.dropX === 'number' ? message.dropX : undefined,
                dropY: typeof message.dropY === 'number' ? message.dropY : undefined,
              });
            }
            break;
          case 'cmd:connectNodes':
            if (
              this.onConnectNodes &&
              typeof message.fromNodeId === 'string' &&
              typeof message.toNodeId === 'string' &&
              typeof message.routeId === 'string' &&
              typeof message.sourceJsonPath === 'string'
            ) {
              this.onConnectNodes({
                fromNodeId: message.fromNodeId,
                toNodeId: message.toNodeId,
                routeId: message.routeId,
                sourceJsonPath: message.sourceJsonPath,
              });
            }
            break;
          case 'cmd:graphSidebarState': {
            const m = message as {
              type: string;
              showConnectImports?: unknown;
              connectLabel?: unknown;
              connectActive?: unknown;
            };
            if (this.onGraphSidebarState) {
              this.onGraphSidebarState({
                showConnectImports: !!m.showConnectImports,
                connectLabel: typeof m.connectLabel === 'string' ? m.connectLabel : 'Connect imports',
                connectActive: !!m.connectActive,
              });
            }
            break;
          }
          case 'cmd:saveMdFile': {
            const m = message as { type: string; fileName?: unknown; content?: unknown };
            if (this.onSaveMdFile && typeof m.fileName === 'string' && typeof m.content === 'string') {
              void Promise.resolve(
                this.onSaveMdFile({
                  fileName: m.fileName,
                  content: m.content,
                })
              );
            }
            break;
          }
          case 'cmd:saveSession':
            if (this.onSaveSession && typeof message.sourceJsonPath === 'string') {
              const gs = (message as { graphSnapshots?: unknown }).graphSnapshots;
              this.onSaveSession({
                sourceJsonPath: message.sourceJsonPath,
                saveToSaved: !!message.saveToSaved,
                graphSnapshots:
                  gs && typeof gs === 'object' && !Array.isArray(gs)
                    ? (gs as GraphData['graphSnapshots'])
                    : undefined,
              });
            }
            break;
          case 'focusNodeNotFound':
            vscode.window.showInformationMessage(
              `"${message.filePath}" is not in the current import graph. Rebuild the graph from that file if needed.`
            );
            break;
          case 'graphSnapshotExport': {
            const token = typeof message.replyToken === 'string' ? message.replyToken : '';
            const w = token ? this.exportWaiters.get(token) : undefined;
            if (w) {
              clearTimeout(w.timeout);
              this.exportWaiters.delete(token);
              if (message.error === 'noSession') {
                w.resolve(null);
              } else {
                const gs = (message as { graphSnapshots?: unknown }).graphSnapshots;
                const rn = (message as { routeNames?: unknown }).routeNames;
                w.resolve({
                  graphSnapshots:
                    gs && typeof gs === 'object' && !Array.isArray(gs)
                      ? (gs as GraphData['graphSnapshots'])
                      : {},
                  routeNames: Array.isArray(rn) ? (rn as string[]) : [],
                });
              }
            }
            break;
          }
        }
      },
      null,
      this.disposables
    );
  }

  private deliverUpsert(msg: UpsertSessionMessage): void {
    this.panel.webview.postMessage(msg);
  }

  public reveal(): void {
    this.panel.reveal();
  }

  public focusNodeInGraph(filePath: string, silent = false): void {
    this.panel.webview.postMessage({ type: 'cmd:focusNodeInGraph', filePath, silent });
  }

  public requestGraphMeta(): void {
    this.panel.webview.postMessage({ type: 'cmd:requestGraphMeta' });
  }

  /** Update tab dirty / backtrack flags without replacing graph data. */
  public postSessionState(msg: Omit<SessionStateMessage, 'type'>): void {
    this.panel.webview.postMessage({ type: 'sessionState', ...msg });
  }

  /** Push a full session update (e.g. after backtrack merge). */
  public deliverUpsertExternal(msg: UpsertSessionMessage): void {
    this.deliverUpsert(msg);
  }

  public postWebviewMessage(message: unknown): void {
    this.panel.webview.postMessage(message);
  }

  /**
   * Ask the webview for the latest graphSnapshots + routeNames for a session (flushes positions if that tab is active).
   * Resolves null if the session is not loaded or the request times out.
   */
  public requestSnapshotExport(sourceJsonPath: string): Promise<{ graphSnapshots: GraphData['graphSnapshots']; routeNames: string[] } | null> {
    return new Promise((resolve) => {
      const token = `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      const timeout = setTimeout(() => {
        this.exportWaiters.delete(token);
        resolve(null);
      }, 10_000);
      this.exportWaiters.set(token, { resolve, timeout });
      void this.panel.webview.postMessage({
        type: 'cmd:exportGraphSnapshot',
        sourceJsonPath,
        replyToken: token,
      });
    });
  }

  /** Focus Map View, switch to this session tab if needed, then run the same save as Ctrl+S / tab double-click. */
  public async requestActivateAndSave(sourceJsonPath: string, saveToSaved: boolean): Promise<void> {
    this.panel.reveal();
    void this.panel.webview.postMessage({
      type: 'cmd:activateSessionAndSave',
      sourceJsonPath,
      saveToSaved: !!saveToSaved,
    });
    await new Promise((r) => setTimeout(r, 750));
  }

  private getHtmlForWebview(): string {
    const webview = this.panel.webview;
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');

    const visNetworkUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'vis-network.min.js'));
    const mainCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.css'));
    const mainJsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${mainCssUri}">
  <title>Map View</title>
</head>
<body ondragover="event.preventDefault();event.stopPropagation();" ondrop="event.preventDefault();event.stopPropagation();">
  <div id="graph-loading-overlay" class="visible">
    <div class="spinner"></div>
    <span>Loading file graph…</span>
  </div>
  <div id="graph-drop-overlay">
    <div class="drop-hint">Drop files here to add nodes<br><small>From Explorer Map, Explorer, or Finder</small></div>
  </div>

  <div id="graph-app">
    <div id="graph-tab-bar" class="graph-tab-bar" role="tablist" aria-label="Open map views"></div>
    <div id="mynetwork" class="graph-canvas-wrap"></div>
  </div>

  <div id="legend">
    <div class="item"><div class="dot" style="background:#7B1FA2;"></div> Entry file</div>
    <div class="item"><div class="dot" style="background:#1E88E5;"></div> File dependency</div>
    <div class="item"><div class="dot" style="background:#E53935;"></div> Circular dependency</div>
  </div>

  <div id="stats">
    <span id="nodeCount">0</span> files &middot; <span id="edgeCount">0</span> connections
  </div>
  <div id="dragHelp">Pan: two-finger scroll on the graph. Drag on empty canvas: rectangle select (merges with any current click-selection; click empty first to replace). Drag files onto the graph to add nodes.</div>

  <button id="centerBtn" title="Center graph">⊙ Center</button>

  <div id="mdEditorBackdrop" class="md-editor-backdrop" aria-hidden="true"></div>
  <div id="mdEditorDock" class="md-editor-dock" role="complementary" aria-label="Markdown notes" aria-hidden="true">
    <div class="md-editor-main">
      <div class="md-editor-toolbar">
        <span id="mdEditorTitle" class="md-editor-title">—</span>
        <div class="md-editor-toolbar-spacer"></div>
        <span id="mdEditorDirty" class="md-editor-dirty" style="display: none">●</span>
        <button type="button" id="mdEditorSave" class="md-editor-toolbar-btn" title="Save (⌘S / Ctrl+S)">Save</button>
      </div>
      <textarea id="mdEditorBody" class="md-editor-body" spellcheck="true" wrap="soft" placeholder="Write Markdown…"></textarea>
    </div>
    <div
      id="mdEditorSizeStrip"
      class="md-editor-size-strip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize editor width"
      title="Drag to resize width"
    >
      <span id="mdEditorSizeIcon" class="md-editor-size-icon" aria-hidden="true">▶</span>
    </div>
  </div>

  <div id="nodeInfoPopover" class="node-info-popover" style="display: none;" role="dialog" aria-label="Node details">
    <button type="button" id="nodeInfoClose" class="node-info-close" aria-label="Close">&times;</button>
    <div id="nodeInfoTitle" class="node-info-heading"></div>
    <div id="nodeInfoPath" class="node-info-path"></div>
    <div id="nodeInfoBody" class="node-info-body"></div>
    <button type="button" id="nodeInfoNext" class="node-info-next">Next</button>
    <button type="button" id="nodeInfoRevert" class="node-info-next">Revert Trace</button>
  </div>

  <script nonce="${nonce}" src="${visNetworkUri}"></script>
  <script nonce="${nonce}" src="${mainJsUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    for (const [, w] of this.exportWaiters) {
      clearTimeout(w.timeout);
      w.resolve(null);
    }
    this.exportWaiters.clear();
    GraphPanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
