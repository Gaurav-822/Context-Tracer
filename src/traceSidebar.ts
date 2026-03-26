import * as vscode from 'vscode';
import { TraceState } from './types';

export class TraceSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'apiGraphVisualizer.traceView';

  private view?: vscode.WebviewView;
  private pendingTraceState: TraceState | null = null;
  private pendingGraphMeta: { routeNames: string[]; nodeIds: string[]; graphMode?: 'api' | 'file'; currentRouteId?: string } | null = null;

  private onCommandFromSidebar: ((msg: Record<string, unknown>) => void) | null = null;
  private onSidebarOpened: (() => void) | null = null;
  private onSidebarReady: (() => void) | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public setOnCommandFromSidebar(callback: (msg: Record<string, unknown>) => void): void {
    this.onCommandFromSidebar = callback;
  }

  public setOnSidebarOpened(callback: () => void): void {
    this.onSidebarOpened = callback;
  }

  public setOnSidebarReady(callback: () => void): void {
    this.onSidebarReady = callback;
  }

  public updateGenerateButtonState(jsonExists: boolean): void {
    if (this.view) {
      this.view.webview.postMessage({ type: 'generateBtnState', jsonExists });
    }
  }

  public updateUseLlmState(useLlm: boolean): void {
    if (this.view) {
      this.view.webview.postMessage({ type: 'useLlmState', useLlm });
    }
  }

  public updateAutoFollowState(on: boolean): void {
    if (this.view) {
      this.view.webview.postMessage({ type: 'autoFollowState', on });
    }
  }

  public updateGraphMeta(routeNames: string[], nodeIds: string[], graphMode: 'api' | 'file' = 'api', currentRouteId?: string): void {
    if (this.view) {
      this.view.webview.postMessage({ type: 'graphMeta', routeNames, nodeIds, graphMode, currentRouteId });
    } else {
      this.pendingGraphMeta = { routeNames, nodeIds, graphMode, currentRouteId };
    }
  }

  public updateTraceState(state: TraceState): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'updateTrace',
        nodeData: state.nodeData,
        edgeData: state.tracedEdges.map((key: string) => {
          const [from, to] = key.split(',');
          return { from, to, color: '#FFC107', width: 2 };
        }),
      });
    } else {
      this.pendingTraceState = state;
    }
  }

  /** Forward a message from the graph panel webview to the sidebar webview */
  public forwardToSidebar(msg: Record<string, unknown>): void {
    if (this.view) {
      this.view.webview.postMessage(msg);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.onSidebarOpened) {
        this.onSidebarOpened();
      }
    });

    if (this.onSidebarOpened) {
      this.onSidebarOpened();
    }

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'sidebarReady':
          if (this.onSidebarReady) {
            this.onSidebarReady();
          }
          if (this.pendingGraphMeta) {
            this.view?.webview.postMessage({
              type: 'graphMeta',
              routeNames: this.pendingGraphMeta.routeNames,
              nodeIds: this.pendingGraphMeta.nodeIds,
              graphMode: this.pendingGraphMeta.graphMode ?? 'api',
              currentRouteId: this.pendingGraphMeta.currentRouteId,
            });
            this.pendingGraphMeta = null;
          }
          if (this.pendingTraceState) {
            this.updateTraceState(this.pendingTraceState);
            this.pendingTraceState = null;
          }
          break;
        default:
          if (this.onCommandFromSidebar) {
            this.onCommandFromSidebar(message);
          }
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
    const visNetworkUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'vis-network.min.js'));
    const sidebarCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'sidebar.css'));
    const sidebarJsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'sidebar.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${sidebarCssUri}">
  <title>API Graph Explorer</title>
</head>
<body>
  <div id="sidebar-container">

    <!-- TOP: always visible, fixed height -->
    <div class="sidebar-top">
      <button id="generateBtn" class="generate-btn">Generate Graph</button>
      <div class="section-label trace-row">
        Use AI
        <button id="useAiToggle" class="toggle-btn off">OFF</button>
      </div>
      <div class="divider"></div>
      <div class="section-label">Route / Import</div>
      <div class="search-wrap">
        <input type="text" id="routeSearch" placeholder="Search routes / imports…" autocomplete="off">
        <div id="routeDropdown" class="search-dropdown"></div>
      </div>
      <div class="section-label">Find File</div>
      <div class="search-wrap">
        <input type="text" id="nodeSearch" placeholder="Search files…" autocomplete="off">
        <div id="nodeDropdown" class="search-dropdown"></div>
      </div>
      <div class="section-label">Node size</div>
      <div class="node-size-controls">
        <input type="range" id="nodeSizeSlider" min="40" max="400" value="100" title="Scale nodes and text">
        <span id="nodeSizeValue" class="node-size-value">100%</span>
      </div>
      <div class="section-label trace-row">
        Auto-Follow
        <button id="autoFollowToggle" class="toggle-btn off" title="Pan and highlight graph node when switching editor tabs">OFF</button>
      </div>
      <div class="divider"></div>
    </div>

    <!-- MIDDLE: node info, grows to fill space, scrolls internally -->
    <div class="sidebar-middle">
      <div id="nodeInfo" class="node-info" style="display:none;">
        <div class="node-info-header">
          <span id="nodeInfoBadge" class="node-badge">File</span>
          <span id="nodeInfoName" class="node-name"></span>
        </div>
        <div id="nodeInfoSummary" class="node-summary"></div>
        <div id="nodeInfoPackages" class="node-packages"></div>
        <button id="nodeInfoOpen" class="open-file-btn">Open File</button>
      </div>
    </div>

    <!-- BOTTOM: trace controls + toggle, always pinned to bottom -->
    <div class="sidebar-bottom">
      <div id="traceControls" style="display:none;">
        <div id="traceMiniGraphWrap">
          <div id="traceMiniGraph">
            <div id="traceMiniEmpty">Click API route to trace</div>
          </div>
          <button id="traceExpandBtn" title="Expand graph" class="icon-btn">⤢</button>
        </div>
        <div class="trace-actions">
          <button id="traceUndo" class="ghost-btn">Undo</button>
          <button id="traceRedo" class="ghost-btn">Redo</button>
          <button id="traceClear" class="danger-btn">Clear</button>
        </div>
        <div class="section-label trace-row">
          Local Vision
          <button id="focusModeToggle" class="toggle-btn off">OFF</button>
        </div>
      </div>
      <div class="divider"></div>
      <div class="section-label trace-row">
        Path Trace Mode
        <button id="traceToggle" class="toggle-btn off">OFF</button>
      </div>
    </div>

  </div>

  <script nonce="${nonce}" src="${visNetworkUri}"></script>
  <script nonce="${nonce}" src="${sidebarJsUri}"></script>
</body>
</html>`;
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
