import * as vscode from 'vscode';
import { GraphData } from './types';

export type GraphPanelLoadMode = 'newWindow' | 'refreshOpenOrOpen';

/** Sent to webview to add/update a graph session (tabs live inside the single Import graph panel). */
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
  /** Optional tab label (e.g. "backtracked · file.json"). */
  displayLabel?: string;
}

export interface SessionStateMessage {
  type: 'sessionState';
  sourceJsonPath: string;
  isBacktrackSession?: boolean;
  backtrackDirty?: boolean;
  displayLabel?: string;
}

export class GraphPanel {
  private static readonly viewType = 'apiGraphVisualizer.graphView';
  /** Single Import graph editor tab; multiple graphs are tabs inside its webview. */
  static instance: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private onGraphMetaReady: ((routeNames: string[], nodeIds: string[], currentRouteId?: string) => void) | null = null;
  private onOpenFileFromGraph: ((filePath: string) => void) | null = null;
  private onBacktrack:
    | ((payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => void)
    | null = null;
  private onSaveBacktrack: ((sourceJsonPath: string) => void) | null = null;
  private onSaveBacktrackPrompt: ((sourceJsonPath: string) => void) | null = null;
  private pendingUpsert: UpsertSessionMessage | null = null;

  public static open(
    extensionUri: vscode.Uri,
    graphData: GraphData,
    onGraphMetaReady: (routeNames: string[], nodeIds: string[], currentRouteId?: string) => void,
    onOpenFileFromGraph: (filePath: string) => void,
    initialRouteId: string | undefined,
    sourceJsonPath: string,
    mode: GraphPanelLoadMode,
    hooks?: {
      onBacktrack?: (payload: { nodeId: string; routeId: string; sourceJsonPath: string }) => void;
      onSaveBacktrack?: (sourceJsonPath: string) => void;
      onSaveBacktrackPrompt?: (sourceJsonPath: string) => void;
      /** When loading JSON that was saved after backtrack, restore tab styling without inferring from filename. */
      initialSession?: {
        isBacktrackSession?: boolean;
        backtrackDirty?: boolean;
        displayLabel?: string;
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
    };
    if (ini?.displayLabel !== undefined) {
      msg.displayLabel = ini.displayLabel;
    }

    if (GraphPanel.instance) {
      GraphPanel.instance.onGraphMetaReady = onGraphMetaReady;
      GraphPanel.instance.onOpenFileFromGraph = onOpenFileFromGraph;
      GraphPanel.instance.onBacktrack = hooks?.onBacktrack ?? null;
      GraphPanel.instance.onSaveBacktrack = hooks?.onSaveBacktrack ?? null;
      GraphPanel.instance.onSaveBacktrackPrompt = hooks?.onSaveBacktrackPrompt ?? null;
      GraphPanel.instance.deliverUpsert(msg);
      GraphPanel.instance.reveal();
      return GraphPanel.instance;
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    const webviewPanel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Import graph',
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
      hooks?.onBacktrack ?? null,
      hooks?.onSaveBacktrack ?? null,
      hooks?.onSaveBacktrackPrompt ?? null,
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
    onBacktrack: GraphPanel['onBacktrack'],
    onSaveBacktrack: GraphPanel['onSaveBacktrack'],
    onSaveBacktrackPrompt: GraphPanel['onSaveBacktrackPrompt'],
    firstUpsert: UpsertSessionMessage
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.onGraphMetaReady = onGraphMetaReady;
    this.onOpenFileFromGraph = onOpenFileFromGraph;
    this.onBacktrack = onBacktrack;
    this.onSaveBacktrack = onSaveBacktrack;
    this.onSaveBacktrackPrompt = onSaveBacktrackPrompt;
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
          case 'focusNodeNotFound':
            vscode.window.showInformationMessage(
              `"${message.filePath}" is not in the current import graph. Rebuild the graph from that file if needed.`
            );
            break;
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
  <title>Import graph</title>
</head>
<body>
  <div id="graph-loading-overlay" class="visible">
    <div class="spinner"></div>
    <span>Loading file graph…</span>
  </div>

  <div id="graph-app">
    <div id="graph-tab-bar" class="graph-tab-bar" role="tablist" aria-label="Open import graphs"></div>
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

  <button id="centerBtn" title="Center graph">⊙ Center</button>

  <div id="nodeInfoPopover" class="node-info-popover" style="display: none;" role="dialog" aria-label="Node details">
    <button type="button" id="nodeInfoClose" class="node-info-close" aria-label="Close">&times;</button>
    <div id="nodeInfoTitle" class="node-info-heading"></div>
    <div id="nodeInfoPath" class="node-info-path"></div>
    <div id="nodeInfoBody" class="node-info-body"></div>
    <button type="button" id="nodeInfoBacktrack" class="node-info-backtrack">Backtrack</button>
  </div>

  <script nonce="${nonce}" src="${visNetworkUri}"></script>
  <script nonce="${nonce}" src="${mainJsUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
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
