import * as vscode from 'vscode';
import { GraphData, TraceState } from './types';

export class GraphPanel {
  public static currentPanel: GraphPanel | undefined;
  private static readonly viewType = 'apiGraphVisualizer.graphView';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private graphData: GraphData | null = null;
  private initialRouteId: string | undefined = undefined;
  private onTraceUpdate: ((state: TraceState) => void) | null = null;
  private onGraphMetaReady: ((routeNames: string[], nodeIds: string[], currentRouteId?: string) => void) | null = null;
  private onForwardToSidebar: ((msg: Record<string, unknown>) => void) | null = null;

  public static createOrShow(
    extensionUri: vscode.Uri,
    graphData: GraphData,
    onTraceUpdate: (state: TraceState) => void,
    onGraphMetaReady: (routeNames: string[], nodeIds: string[], currentRouteId?: string) => void,
    onForwardToSidebar: (msg: Record<string, unknown>) => void,
    initialRouteId?: string
  ): GraphPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (GraphPanel.currentPanel) {
      GraphPanel.currentPanel.panel.reveal(column);
      GraphPanel.currentPanel.graphData = graphData;
      GraphPanel.currentPanel.initialRouteId = initialRouteId;
      GraphPanel.currentPanel.onTraceUpdate = onTraceUpdate;
      GraphPanel.currentPanel.onGraphMetaReady = onGraphMetaReady;
      GraphPanel.currentPanel.onForwardToSidebar = onForwardToSidebar;
      GraphPanel.currentPanel.sendGraphData();
      return GraphPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'API Graph',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'icon-dark.svg'),
    };

    GraphPanel.currentPanel = new GraphPanel(
      panel, extensionUri, graphData, onTraceUpdate, onGraphMetaReady, onForwardToSidebar, initialRouteId
    );
    return GraphPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    graphData: GraphData,
    onTraceUpdate: (state: TraceState) => void,
    onGraphMetaReady: (routeNames: string[], nodeIds: string[], currentRouteId?: string) => void,
    onForwardToSidebar: (msg: Record<string, unknown>) => void,
    initialRouteId?: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.graphData = graphData;
    this.initialRouteId = initialRouteId;
    this.onTraceUpdate = onTraceUpdate;
    this.onGraphMetaReady = onGraphMetaReady;
    this.onForwardToSidebar = onForwardToSidebar;

    this.panel.webview.html = this.getHtmlForWebview();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'ready':
            this.sendGraphData();
            break;
          case 'traceUpdated':
            if (this.onTraceUpdate) {
              this.onTraceUpdate({
                tracedNodes: message.tracedNodes,
                tracedEdges: message.tracedEdges,
                nodeData: message.nodeData,
              });
            }
            break;
          case 'graphMetaReady':
            if (this.onGraphMetaReady) {
              this.onGraphMetaReady(message.routeNames, message.nodeIds, message.currentRouteId);
            }
            break;
          case 'nodeSelected':
          case 'nodeDeselected':
          case 'cmd:openFile':
            if (this.onForwardToSidebar) {
              this.onForwardToSidebar(message);
            }
            break;
          case 'focusNodeNotFound':
            vscode.window.showInformationMessage(
              `"${message.filePath}" is not in the current API graph. Generate or update the graph to include it.`
            );
            break;
        }
      },
      null,
      this.disposables
    );
  }

  public reveal(): void {
    this.panel.reveal();
  }

  public handleSidebarCommand(msg: Record<string, unknown>): void {
    this.panel.webview.postMessage(msg);
  }

  public focusNodeInGraph(filePath: string, silent = false): void {
    this.panel.webview.postMessage({ type: 'cmd:focusNodeInGraph', filePath, silent });
  }

  public requestGraphMeta(): void {
    this.panel.webview.postMessage({ type: 'cmd:requestGraphMeta' });
  }

  public showTraceModal(): void {
    this.panel.webview.postMessage({ type: 'showTraceModal' });
  }

  private sendGraphData(): void {
    if (this.graphData) {
      const msg: Record<string, unknown> = {
        type: 'loadGraphData',
        graphSnapshots: this.graphData.graphSnapshots,
        routeNames: this.graphData.routeNames,
      };
      if (this.initialRouteId && this.graphData.graphSnapshots[this.initialRouteId]) {
        msg.initialRouteId = this.initialRouteId;
      }
      this.panel.webview.postMessage(msg);
    }
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
  <title>API Graph Visualizer</title>
</head>
<body>
  <div id="graph-loading-overlay" class="visible">
    <div class="spinner"></div>
    <span>Loading graph…</span>
  </div>

  <div id="mynetwork"></div>

  <div id="controller-methods" style="display:none;">
    <div id="controller-methods-title"></div>
    <div id="controller-methods-list"></div>
    <button id="controller-methods-reset" style="display:none;">Reset to default</button>
  </div>

  <div id="legend">
    <div class="item"><div class="dot" style="background:#43A047;"></div> API Route (entry)</div>
    <div class="item"><div class="dot" style="background:#7B1FA2;"></div> Controller</div>
    <div class="item"><div class="dot" style="background:#1E88E5;"></div> File dependency</div>
    <div class="item"><div class="dot" style="background:#E53935;"></div> Circular dependency</div>
    <div class="item"><div class="dot" style="background:#FFC107;"></div> Traced path</div>
  </div>

  <div id="stats">
    <span id="nodeCount">0</span> files &middot; <span id="edgeCount">0</span> connections
  </div>

  <button id="centerBtn" title="Center graph">⊙ Center</button>

  <div id="trace-expand-modal">
    <div id="trace-expand-content">
      <div id="trace-expand-header">
        <h4>Traced Path Graph</h4>
        <button id="trace-expand-close">Close</button>
      </div>
      <div id="trace-expand-graph"></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${visNetworkUri}"></script>
  <script nonce="${nonce}" src="${mainJsUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.currentPanel = undefined;
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
