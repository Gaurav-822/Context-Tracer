import * as path from 'path';
import * as vscode from 'vscode';
import type { McpPanelSnapshot } from './mcpConfig';

export type SearchResultType = 'file' | 'folder';

export interface SearchResultItem {
  type: SearchResultType;
  label: string;
  relPath: string;
  absPath: string;
}

export interface WorkspaceSearchParams {
  query: string;
  mode: 'files' | 'folders';
}

export interface SidebarTreeNode {
  type: SearchResultType;
  label: string;
  relPath: string;
  absPath: string;
  children?: SidebarTreeNode[];
  /** When search is active: true only for folders on the path to a match (auto-expand in UI). */
  expandPath?: boolean;
}

export interface SidebarPanelData {
  useLlm: boolean;
  saved: { label: string; absPath: string; relPath: string }[];
  tree: SidebarTreeNode[];
  mcp: McpPanelSnapshot;
}

export type SidebarSavedListMessage = {
  type: 'savedListUpdate';
  saved: { label: string; absPath: string; relPath: string }[];
};
export type SidebarWorkspaceSelectionMessage = {
  type: 'workspaceSelectionUpdate';
  absPath: string;
};
export type SidebarActivatePlacementMessage = {
  type: 'activatePlacement';
};

export type SidebarConnectImportsStateMessage = {
  type: 'graphConnectImportsState';
  show: boolean;
  label: string;
  active: boolean;
};

type OpenRequestMessage = {
  type: 'openResult';
  resultType: SearchResultType;
  absPath: string;
};

type RequestTreeMessage = {
  type: 'requestPanelData';
  query?: string;
  mode?: 'files' | 'folders';
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
};

type OpenSavedMessage = { type: 'openSaved'; absPath: string };
type OpenSavedSaveAsMessage = { type: 'openSavedSaveAs'; absPath: string };
type SavedGraphSaveInPlaceMessage = { type: 'savedGraphSaveInPlace'; absPath: string };
type RenameWorkspaceItemMessage = { type: 'renameWorkspaceItem'; absPath: string };
type CreateFileMessage = { type: 'createFile' };
type CreateFolderMessage = { type: 'createFolder' };
type CreateEmptyGraphMessage = { type: 'createEmptyGraph' };
type SidebarDragPathsMessage = { type: 'sidebarDragPaths'; paths: string[] };
type UndoWorkspaceRevealMessage = { type: 'undoWorkspaceReveal' };
type PlaceInGraphMessage = { type: 'placeInGraph'; absPath: string };
type CancelPlaceInGraphMessage = { type: 'cancelPlaceInGraph' };
type ToggleConnectImportsMessage = { type: 'toggleConnectImports' };
type OpenMdDocMessage = { type: 'openMdDoc'; fileName: string };
type McpCopyConfigMessage = { type: 'mcpCopyConfig' };
type McpRevealMessage = { type: 'mcpReveal' };
type McpOpenReadmeMessage = { type: 'mcpOpenReadme' };
type McpOpenRunnerMessage = { type: 'mcpOpenRunner' };
type McpSetEnabledMessage = { type: 'mcpSetEnabled'; enabled: boolean };

export class SearchSidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hooks: {
      onOpenResult: (result: { resultType: SearchResultType; absPath: string }) => Promise<void>;
      /** Sidebar → graph: internal webview drags often have empty dataTransfer on drop; host stores paths until graph consumes them. */
      onSidebarDragPaths: (paths: string[]) => void;
      onRequestPanelData: (params: {
        query?: string;
        mode?: 'files' | 'folders';
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
      }) => Promise<SidebarPanelData>;
      onToggleLlm: () => Promise<boolean>;
      onOpenSaved: (absPath: string) => Promise<void>;
      /** Double-click a saved graph: pick a new file path and write a copy (includes live layout if Map View has that graph open). */
      onSaveSavedGraphCopyAs: (absPath: string) => Promise<void>;
      /** Sidebar floating menu: overwrite this JSON from Map View (or open then prompt). */
      onSavedGraphSaveInPlace: (absPath: string) => Promise<void>;
      onRenameWorkspaceItem: (absPath: string) => Promise<void>;
      onCreateEmptyGraph: () => Promise<void>;
      onCreateFile: () => Promise<void>;
      onCreateFolder: () => Promise<void>;
      onUndoWorkspaceReveal: () => Promise<void>;
      onPlaceInGraph: (absPath: string) => Promise<void>;
      onCancelPlaceInGraph: () => Promise<void>;
      onToggleConnectImports: () => void;
      onOpenMdDoc: (fileName: string) => Promise<void>;
      onMcpCopyConfig: () => Promise<void>;
      onMcpRevealMcpHandler: () => Promise<void>;
      onMcpOpenReadme: () => Promise<void>;
      onMcpOpenRunnerTerminal: () => Promise<void>;
      onMcpSetEnabled: (enabled: boolean) => Promise<void>;
      /** Snapshot of visualizer/backtracked JSON list (no workspace tree rebuild). */
      listSavedGraphsForSidebar: () => { label: string; absPath: string; relPath: string }[];
    }
  ) {}

  /** Update only the Saved list + count; does not reset workspace search/tree state. */
  postSavedListUpdate(): void {
    if (!this.view) return;
    const saved = this.hooks.listSavedGraphsForSidebar();
    const msg: SidebarSavedListMessage = {
      type: 'savedListUpdate',
      saved,
    };
    void this.view.webview.postMessage(msg);
  }

  postWorkspaceSelection(absPath: string): void {
    if (!this.view) return;
    const msg: SidebarWorkspaceSelectionMessage = {
      type: 'workspaceSelectionUpdate',
      absPath,
    };
    void this.view.webview.postMessage(msg);
  }

  activatePlacementSearch(): void {
    if (!this.view) return;
    const msg: SidebarActivatePlacementMessage = { type: 'activatePlacement' };
    void this.view.show?.(true);
    void this.view.webview.postMessage(msg);
  }

  postGraphConnectImportsState(payload: { showConnectImports: boolean; connectLabel: string; connectActive: boolean }): void {
    if (!this.view) return;
    const msg: SidebarConnectImportsStateMessage = {
      type: 'graphConnectImportsState',
      show: payload.showConnectImports,
      label: payload.connectLabel,
      active: payload.connectActive,
    };
    void this.view.webview.postMessage(msg);
  }

  /** Updates MCP block without rebuilding the workspace tree (e.g. when mcp settings change). */
  postMcpPanelSnapshot(mcp: McpPanelSnapshot): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'mcpUpdate', mcp });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void | Thenable<void> {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = raw as
        | OpenRequestMessage
        | RequestTreeMessage
        | OpenSavedMessage
        | OpenSavedSaveAsMessage
        | SavedGraphSaveInPlaceMessage
        | RenameWorkspaceItemMessage
        | CreateEmptyGraphMessage
        | CreateFileMessage
        | CreateFolderMessage
        | SidebarDragPathsMessage
        | UndoWorkspaceRevealMessage
        | PlaceInGraphMessage
        | CancelPlaceInGraphMessage
        | ToggleConnectImportsMessage
        | OpenMdDocMessage
        | McpCopyConfigMessage
        | McpRevealMessage
        | McpOpenReadmeMessage
        | McpOpenRunnerMessage
        | McpSetEnabledMessage
        | { type: 'ready' };
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

      if (msg.type === 'sidebarDragPaths') {
        const m = msg as SidebarDragPathsMessage;
        const paths = Array.isArray(m.paths) ? m.paths.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
        this.hooks.onSidebarDragPaths(paths);
        return;
      }
      if (msg.type === 'ready') {
        const panel = await this.hooks.onRequestPanelData({});
        void webview.postMessage({ type: 'panelData', panel });
        return;
      }
      if (msg.type === 'requestPanelData') {
        const panel = await this.hooks.onRequestPanelData({
          query: msg.query,
          mode: msg.mode,
          matchCase: !!msg.matchCase,
          wholeWord: !!msg.wholeWord,
          useRegex: !!msg.useRegex,
        });
        void webview.postMessage({ type: 'panelData', panel });
        return;
      }
      if (msg.type === 'openSaved') {
        await this.hooks.onOpenSaved(msg.absPath);
        return;
      }
      if (msg.type === 'openSavedSaveAs') {
        await this.hooks.onSaveSavedGraphCopyAs(msg.absPath);
        return;
      }
      if (msg.type === 'savedGraphSaveInPlace') {
        await this.hooks.onSavedGraphSaveInPlace(msg.absPath);
        return;
      }
      if (msg.type === 'renameWorkspaceItem') {
        await this.hooks.onRenameWorkspaceItem(msg.absPath);
        const panel = await this.hooks.onRequestPanelData({});
        void webview.postMessage({ type: 'panelData', panel });
        return;
      }
      if (msg.type === 'createEmptyGraph') {
        await this.hooks.onCreateEmptyGraph();
        return;
      }
      if (msg.type === 'createFile') {
        await this.hooks.onCreateFile();
        const panel = await this.hooks.onRequestPanelData({});
        void webview.postMessage({ type: 'panelData', panel });
        return;
      }
      if (msg.type === 'createFolder') {
        await this.hooks.onCreateFolder();
        const panel = await this.hooks.onRequestPanelData({});
        void webview.postMessage({ type: 'panelData', panel });
        return;
      }
      if (msg.type === 'undoWorkspaceReveal') {
        await this.hooks.onUndoWorkspaceReveal();
        return;
      }
      if (msg.type === 'openResult') {
        await this.hooks.onOpenResult({ resultType: msg.resultType, absPath: msg.absPath });
        return;
      }
      if (msg.type === 'placeInGraph') {
        await this.hooks.onPlaceInGraph(msg.absPath);
        return;
      }
      if (msg.type === 'cancelPlaceInGraph') {
        await this.hooks.onCancelPlaceInGraph();
        return;
      }
      if (msg.type === 'toggleConnectImports') {
        this.hooks.onToggleConnectImports();
        return;
      }
      if (msg.type === 'openMdDoc' && typeof (msg as OpenMdDocMessage).fileName === 'string') {
        await this.hooks.onOpenMdDoc((msg as OpenMdDocMessage).fileName);
        return;
      }
      if (msg.type === 'mcpCopyConfig') {
        await this.hooks.onMcpCopyConfig();
        return;
      }
      if (msg.type === 'mcpReveal') {
        await this.hooks.onMcpRevealMcpHandler();
        return;
      }
      if (msg.type === 'mcpOpenReadme') {
        await this.hooks.onMcpOpenReadme();
        return;
      }
      if (msg.type === 'mcpOpenRunner') {
        await this.hooks.onMcpOpenRunnerTerminal();
        return;
      }
      if (msg.type === 'mcpSetEnabled' && typeof (msg as { enabled?: boolean }).enabled === 'boolean') {
        await this.hooks.onMcpSetEnabled(!!(msg as { enabled: boolean }).enabled);
        return;
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = webview.cspSource;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: dark; }
    body { font-family: var(--vscode-font-family); padding: 8px; color: var(--vscode-foreground); }
    .row { margin-bottom: 8px; }
    input {
      width: 100%;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      padding: 6px 8px;
      border-radius: 4px;
    }
    .label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      display: block;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .searchTools {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 4px;
    }
    .toolBtn {
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      font-size: 11px;
      line-height: 1;
      padding: 4px 6px;
      cursor: pointer;
      position: relative;
    }
    .toolBtn.active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-focusBorder);
    }
    .toolBtn[data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border: 1px solid var(--vscode-editorHoverWidget-border);
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 11px;
      white-space: nowrap;
      z-index: 1000;
      pointer-events: none;
    }
    .toolBtn.tipLeft[data-tip]:hover::after {
      left: 0;
      right: auto;
    }
    .toggle {
      display: flex;
      gap: 6px;
    }
    .toggleBtn {
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12px;
      min-width: 78px;
      cursor: pointer;
    }
    .toggleBtn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-focusBorder);
    }
    .sectionTitle {
      margin-top: 12px;
      margin-bottom: 6px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      font-weight: 600;
    }
    .sectionHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 10px;
    }
    .workspaceHeader {
      position: sticky;
      top: 0;
      z-index: 20;
      margin-top: 10px;
      margin-left: -8px;
      margin-right: -8px;
      padding: 6px 8px;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      border-top: 1px solid transparent;
      border-bottom: 1px solid transparent;
      transition:
        background-color 180ms ease,
        border-color 180ms ease,
        box-shadow 180ms ease,
        padding-top 180ms ease,
        padding-bottom 180ms ease;
    }
    body.wsScrolled .workspaceHeader {
      padding-top: 4px;
      padding-bottom: 4px;
      background: color-mix(in srgb, var(--vscode-editor-background, var(--vscode-sideBar-background)) 92%, var(--vscode-list-hoverBackground) 8%);
      border-top-color: var(--vscode-panel-border);
      border-bottom-color: var(--vscode-panel-border);
      box-shadow: 0 1px 0 0 var(--vscode-panel-border);
    }
    .sectionHeader .sectionTitle {
      margin: 0;
    }
    .workspaceActions {
      display: flex;
      gap: 4px;
    }
    .wsActionBtn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
      border-radius: 4px;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      cursor: pointer;
      opacity: 0.9;
    }
    .wsActionBtn:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      border-color: var(--vscode-widget-border, transparent);
      color: var(--vscode-foreground);
      opacity: 1;
    }
    .wsActionBtn svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.7;
      vector-effect: non-scaling-stroke;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .result {
      display: block;
      width: 100%;
      text-align: left;
      margin: 0;
      padding: 7px 8px;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
    }
    .result:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-list-hoverBackground);
    }
    .title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
    .savedCountBadge {
      font-size: 11px;
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      margin-left: 4px;
    }
    .treeWrap {
      margin-top: 4px;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 4px;
    }
    .treeList {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .treeItem {
      margin: 0;
      padding: 0;
    }
    .treeRow {
      display: flex;
      align-items: center;
      width: 100%;
      min-height: 22px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      padding: 0 4px;
      cursor: pointer;
      border-radius: 3px;
      text-align: left;
      font-size: 12px;
      line-height: 1.2;
      gap: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .treeRow:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .treeRow.active {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      outline: 1px solid var(--vscode-focusBorder, transparent);
      outline-offset: -1px;
    }
    .treeRow.kbdActive {
      background: var(--vscode-list-hoverBackground, rgba(88,166,255,0.16));
      color: var(--vscode-foreground);
      outline: 1px solid var(--vscode-focusBorder, rgba(88,166,255,0.45));
      outline-offset: -1px;
    }
    .twisty {
      width: 12px;
      color: var(--vscode-descriptionForeground);
      display: inline-flex;
      justify-content: center;
      align-items: center;
      flex: 0 0 12px;
      font-size: 10px;
    }
    .icon {
      width: 14px;
      display: inline-flex;
      justify-content: center;
      flex: 0 0 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .icon.folderIcon::before {
      content: '📁';
      filter: grayscale(1) brightness(0.9);
      opacity: 0.9;
      font-size: 11px;
      line-height: 1;
    }
    .icon.fileIcon::before {
      content: '📄';
      filter: grayscale(1) brightness(0.9);
      opacity: 0.85;
      font-size: 11px;
      line-height: 1;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .children {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .workspaceBody.shrink {
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
    }
    .hidden {
      display: none;
    }
    .nodeBtn {
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      width: 100%;
      text-align: left;
      font-size: 12px;
      padding: 2px 4px;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .nodeBtn:hover { background: var(--vscode-list-hoverBackground); }
    .connect-imports-btn {
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .connect-imports-btn:hover {
      background: var(--vscode-list-hoverBackground) !important;
    }
    .connect-imports-btn.active {
      background: var(--vscode-list-inactiveSelectionBackground) !important;
      border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground)) !important;
    }
    .saved-floating-menu {
      position: fixed;
      z-index: 100000;
      min-width: 168px;
      max-width: min(280px, calc(100vw - 16px));
      padding: 4px 0;
      margin: 0;
      background: var(--vscode-menu-background);
      color: var(--vscode-menu-foreground);
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
      border-radius: 4px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.36);
      display: none;
    }
    .saved-floating-menu.visible {
      display: block;
    }
    .saved-floating-menu .saved-menu-title {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 4px 10px 6px;
      border-bottom: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .saved-floating-menu button {
      display: block;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: 6px 12px;
      margin: 0;
      border: none;
      background: transparent;
      color: var(--vscode-menu-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      cursor: pointer;
    }
    .saved-floating-menu button:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
    }
    .mcp-minimal-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      box-sizing: border-box;
    }
    .mcp-feature-folder {
      margin-top: 0;
    }
    /* Indent nested MCP content (server + tools) under the folder row, like md handler files */
    .mcp-feature-folder > ul.children.treeList {
      margin: 0;
      padding: 0 0 0 24px;
      box-sizing: border-box;
    }
    .mcp-dir-inner.mcp-minimal-row {
      margin-top: 0;
      padding: 0;
    }
    .mcp-enable-label {
      font-size: 11px;
      color: var(--vscode-sideBar-foreground, var(--vscode-foreground));
      font-weight: 500;
    }
    .md-feature-wrap + .md-feature-wrap {
      margin-top: 4px;
    }
    .mcp-tools-section {
      font-size: 10px;
      line-height: 1.45;
      color: var(--vscode-descriptionForeground);
      padding-left: 12px;
      box-sizing: border-box;
    }
    .mcp-tools-heading {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-descriptionForeground);
      margin: 0 0 6px 0;
      font-weight: 600;
    }
    .mcp-tool-block {
      margin: 0 0 2px 0;
    }
    .mcp-tool-block:last-child {
      margin-bottom: 0;
    }
    .mcp-tool-name-row {
      display: flex;
      align-items: center;
      gap: 4px;
      width: 100%;
      box-sizing: border-box;
    }
    .mcp-tool-name-mono {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--vscode-foreground);
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .mcp-tool-id {
      display: block;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--vscode-foreground);
      margin: 0 0 4px 0;
    }
    .mcp-tool-body {
      margin: 0 0 4px 0;
      padding-left: 12px;
      box-sizing: border-box;
    }
    .mcp-tool-body .mcp-tool-desc {
      margin-top: 0;
    }
    .mcp-tool-desc {
      margin: 0 0 6px 0;
    }
    .mcp-tool-param-label {
      margin: 4px 0 2px 0;
      font-size: 10px;
    }
    .mcp-tool-files {
      margin: 0;
      padding: 0 0 0 10px;
      border-left: 2px solid var(--vscode-widget-border, rgba(120, 130, 150, 0.35));
      list-style: none;
    }
    .mcp-tool-files li {
      font-size: 10px;
      margin: 2px 0;
    }
    .mcp-tool-files code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
    }
    .mcp-server-checkbox {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      margin: 0;
      cursor: pointer;
      vertical-align: middle;
      accent-color: var(--vscode-textLink-foreground, var(--vscode-button-background));
    }
    .mcp-server-checkbox:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .mcp-cb-label {
      cursor: pointer;
      flex: 1 1 auto;
      min-width: 0;
    }
  </style>
</head>
<body>
  <div class="row">
    <label class="label" for="query">Search</label>
    <input id="query" type="text" placeholder="Search files/folders..." />
    <div class="searchTools">
      <button id="modeFiles" class="toolBtn tipLeft active" type="button" role="tab" aria-selected="true" title="Search in files only" data-tip="Search in files only" style="min-width:46px;">File</button>
      <button id="modeFolders" class="toolBtn tipLeft" type="button" role="tab" aria-selected="false" title="Search in folders only" data-tip="Search in folders only" style="min-width:46px;">Folder</button>
      <button id="toolCase" type="button" class="toolBtn" title="Match Case" data-tip="Match Case">Aa</button>
      <button id="toolWord" type="button" class="toolBtn active" title="Match Whole Word" data-tip="Match Whole Word">ab</button>
      <button id="toolRegex" type="button" class="toolBtn" title="Use Regular Expression" data-tip="Use Regular Expression">.*</button>
    </div>
  </div>
  <div class="sectionTitle" style="margin-top:10px;">Features</div>
  <div id="graphConnectRow" class="graph-connect-feature" style="display: none; margin: 0 0 6px 0;">
    <button type="button" id="connectImportsFromSidebar" class="treeRow connect-imports-btn" style="width: 100%; box-sizing: border-box; text-align: left; padding: 5px 4px; margin: 0; border: 1px solid var(--vscode-widget-border, rgba(120, 130, 150, 0.35)); border-radius: 4px; background: var(--vscode-sideBar-background, var(--vscode-panel-background));">
      <span class="icon" style="font-size: 13px; margin-right: 6px;">⇢</span><span class="name">Connect imports</span>
    </button>
  </div>
  <div id="features" class="treeWrap"></div>
  <div class="sectionHeader workspaceHeader">
    <div class="sectionTitle">Workspace</div>
    <div class="workspaceActions">
      <button id="wsNewGraph" type="button" class="wsActionBtn" title="Create Empty Graph" data-tip="Create Empty Graph" aria-label="Create Empty Graph">
        <svg viewBox="0 0 16 16"><path d="M3 2.5h10v11H3z"/><path d="M8 5v6M5 8h6"/></svg>
      </button>
      <button id="wsNewFile" type="button" class="wsActionBtn" title="Create New File" data-tip="Create New File" aria-label="Create New File">
        <svg viewBox="0 0 16 16"><path d="M3 1.5h6l3.5 3.5V14.5H3z"/><path d="M9 1.5V5h3.5"/><path d="M8 8v4M6 10h4"/></svg>
      </button>
      <button id="wsNewFolder" type="button" class="wsActionBtn" title="Create New Folder" data-tip="Create New Folder" aria-label="Create New Folder">
        <svg viewBox="0 0 16 16"><path d="M1.5 4.5h5l1.2-1.8h6.8v9.8H1.5z"/><path d="M8 8v4M6 10h4"/></svg>
      </button>
      <button id="wsRefresh" type="button" class="wsActionBtn" title="Refresh Workspace" data-tip="Refresh Workspace" aria-label="Refresh Workspace">
        <svg viewBox="0 0 16 16"><path d="M13 5.5A5.2 5.2 0 1 0 14 8"/><path d="M11.2 2.8H14v2.8"/></svg>
      </button>
      <button id="wsCollapseAll" type="button" class="wsActionBtn" title="Collapse to top level or expand all folders" data-tip="Collapse to top level or expand all folders" aria-label="Collapse or expand all workspace folders">
        <svg viewBox="0 0 16 16"><path d="M3 3.5h10"/><path d="M3 8h10"/><path d="M3 12.5h10"/><path d="M6 5.2 4.2 3.5 6 1.8"/><path d="M10 10.8 11.8 12.5 10 14.2"/></svg>
      </button>
      <button id="wsUndoReveal" type="button" class="wsActionBtn" title="Undo previous workspace selection" data-tip="Undo previous workspace selection" aria-label="Undo previous workspace selection">
        <svg viewBox="0 0 16 16"><path d="M6 4 2.5 7.5 6 11"/><path d="M3 7.5h5.2a4.3 4.3 0 1 1 0 8.6"/></svg>
      </button>
    </div>
  </div>
  <div id="tree" class="treeWrap workspaceBody"></div>
  <div class="sectionTitle" style="margin-top:10px;">Saved <span id="savedCount" class="savedCountBadge"></span></div>
  <div id="saved" class="treeWrap"></div>
  <div id="savedFloatingMenu" class="saved-floating-menu" role="menu" aria-hidden="true">
    <div id="savedFloatingMenuTitle" class="saved-menu-title"></div>
    <button type="button" role="menuitem" data-action="open">Open in Map View</button>
    <button type="button" role="menuitem" data-action="save">Save</button>
    <button type="button" role="menuitem" data-action="saveAs">Save copy as…</button>
  </div>
  <div id="workspaceFloatingMenu" class="saved-floating-menu" role="menu" aria-hidden="true">
    <div id="workspaceFloatingMenuTitle" class="saved-menu-title"></div>
    <button type="button" role="menuitem" data-action="rename">Rename</button>
  </div>

  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const queryEl = document.getElementById('query');
      const toolCaseEl = document.getElementById('toolCase');
      const toolWordEl = document.getElementById('toolWord');
      const toolRegexEl = document.getElementById('toolRegex');
      const modeFilesEl = document.getElementById('modeFiles');
      const modeFoldersEl = document.getElementById('modeFolders');
      const featuresEl = document.getElementById('features');
      const graphConnectRowEl = document.getElementById('graphConnectRow');
      const connectImportsFromSidebarEl = document.getElementById('connectImportsFromSidebar');
      const savedEl = document.getElementById('saved');
      const savedFloatingMenuEl = document.getElementById('savedFloatingMenu');
      const savedFloatingMenuTitleEl = document.getElementById('savedFloatingMenuTitle');
      const savedCountEl = document.getElementById('savedCount');
      const treeEl = document.getElementById('tree');
      const wsNewGraphEl = document.getElementById('wsNewGraph');
      const wsNewFileEl = document.getElementById('wsNewFile');
      const wsNewFolderEl = document.getElementById('wsNewFolder');
      const wsRefreshEl = document.getElementById('wsRefresh');
      const wsCollapseAllEl = document.getElementById('wsCollapseAll');
      const wsUndoRevealEl = document.getElementById('wsUndoReveal');
      const workspaceFloatingMenuEl = document.getElementById('workspaceFloatingMenu');
      const workspaceFloatingMenuTitleEl = document.getElementById('workspaceFloatingMenuTitle');
      const expandedFolderState = new Map();
      let selectedWorkspacePath = '';
      let hadActiveSearch = false;
      let searchDebounceTimer = null;
      const SEARCH_DEBOUNCE_MS = 280;
      let currentMode = 'files';
      let currentQueryText = '';
      let matchCase = false;
      let wholeWord = true;
      let useRegex = false;
      let savedMenuAbsPath = null;
      let workspaceMenuAbsPath = null;
      let placementMode = false;
      let workspaceKeyboardIndex = -1;
      let featuresBlockInitialized = false;

      function applyMcpFromPanel(mcp) {
        if (!mcp) return;
        var tgl = document.getElementById('mcpEnableToggle');
        if (tgl && tgl instanceof HTMLInputElement) {
          /* Mirror legacy switch: "on" = user wants the server; fall back to mcpEnabledAnywhere */
          var want =
            mcp.mcpWanted !== undefined && mcp.mcpWanted !== null
              ? !!mcp.mcpWanted
              : !!mcp.mcpEnabledAnywhere;
          tgl.checked = want;
          tgl.setAttribute('aria-checked', want ? 'true' : 'false');
          tgl.disabled = !mcp.workspaceRoot || (!want && !mcp.distExists);
        }
      }

      function renderFeaturesBlock(panel) {
        if (!featuresEl) return;
        featuresEl.innerHTML = '';
        var mcpFromPanel = panel && panel.mcp ? panel.mcp : null;

        const MD_HANDLER_MCP_FILES = [
          'skills.md',
          'learnings.md',
          'architecture.md',
          'mistakes.md',
          'working.md',
        ];
        const mcpWrap = document.createElement('div');
        mcpWrap.className = 'md-feature-wrap mcp-feature-folder';
        const mcpFolderRow = document.createElement('button');
        mcpFolderRow.type = 'button';
        mcpFolderRow.className = 'treeRow';
        mcpFolderRow.style.paddingLeft = '4px';
        mcpFolderRow.setAttribute('aria-expanded', 'false');
        const mcpTw = document.createElement('span');
        mcpTw.className = 'twisty';
        mcpTw.textContent = '▸';
        const mcpFic = document.createElement('span');
        mcpFic.className = 'icon folderIcon';
        const mcpFnm = document.createElement('span');
        mcpFnm.className = 'name';
        mcpFnm.textContent = 'mcp';
        mcpFolderRow.appendChild(mcpTw);
        mcpFolderRow.appendChild(mcpFic);
        mcpFolderRow.appendChild(mcpFnm);
        const mcpUl = document.createElement('ul');
        mcpUl.className = 'children treeList hidden';

        const liToggle = document.createElement('li');
        liToggle.className = 'treeItem';
        liToggle.style.padding = '4px 4px 6px 0';
        const toggleRow = document.createElement('div');
        toggleRow.className = 'mcp-minimal-row mcp-dir-inner';
        const mcpEnLabel = document.createElement('label');
        mcpEnLabel.className = 'mcp-enable-label mcp-cb-label';
        mcpEnLabel.setAttribute('for', 'mcpEnableToggle');
        mcpEnLabel.textContent = 'Server (explorer-map-md)';
        const mcpCb = document.createElement('input');
        mcpCb.type = 'checkbox';
        mcpCb.id = 'mcpEnableToggle';
        mcpCb.className = 'mcp-server-checkbox';
        mcpCb.setAttribute('aria-label', 'Enable explorer-map-md stdio server (md notes + flow graphs)');
        mcpEnLabel.addEventListener('click', function (ev) {
          ev.stopPropagation();
        });
        mcpCb.addEventListener('click', function (ev) {
          ev.stopPropagation();
        });
        mcpCb.addEventListener('change', function (ev) {
          ev.stopPropagation();
          const el = ev.target;
          if (el instanceof HTMLInputElement) {
            vscode.postMessage({ type: 'mcpSetEnabled', enabled: el.checked });
          }
        });
        toggleRow.appendChild(mcpEnLabel);
        toggleRow.appendChild(mcpCb);
        liToggle.appendChild(toggleRow);
        mcpUl.appendChild(liToggle);

        const liTools = document.createElement('li');
        liTools.className = 'treeItem';
        liTools.style.padding = '2px 4px 10px 0';
        const toolsRoot = document.createElement('div');
        toolsRoot.className = 'mcp-tools-section';
        const th = document.createElement('div');
        th.className = 'mcp-tools-heading';
        th.textContent = 'Exposed tools';

        function wireMcpToolToggle(nameRow, body, twisty) {
          nameRow.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const hid = body.classList.toggle('hidden');
            if (twisty) {
              twisty.textContent = hid ? '▸' : '▾';
            }
            nameRow.setAttribute('aria-expanded', hid ? 'false' : 'true');
          });
        }

        function addMcpToolBlock(name, descText, withFileParam) {
          const block = document.createElement('div');
          block.className = 'mcp-tool-block';
          const nameRow = document.createElement('button');
          nameRow.type = 'button';
          nameRow.className = 'treeRow mcp-tool-name-row';
          nameRow.setAttribute('aria-expanded', 'false');
          const tw = document.createElement('span');
          tw.className = 'twisty';
          tw.textContent = '▸';
          const nm = document.createElement('span');
          nm.className = 'mcp-tool-name-mono';
          nm.textContent = name;
          nameRow.appendChild(tw);
          nameRow.appendChild(nm);
          const body = document.createElement('div');
          body.className = 'mcp-tool-body hidden';
          const toolDesc = document.createElement('div');
          toolDesc.className = 'mcp-tool-desc';
          toolDesc.textContent = descText;
          body.appendChild(toolDesc);
          if (withFileParam) {
            const paramLbl = document.createElement('div');
            paramLbl.className = 'mcp-tool-param-label';
            paramLbl.textContent = 'Parameter fileName:';
            body.appendChild(paramLbl);
            const fileUl = document.createElement('ul');
            fileUl.className = 'mcp-tool-files';
            for (var fi = 0; fi < MD_HANDLER_MCP_FILES.length; fi++) {
              var tli = document.createElement('li');
              tli.appendChild(document.createTextNode('• '));
              var cod = document.createElement('code');
              cod.textContent = MD_HANDLER_MCP_FILES[fi];
              tli.appendChild(cod);
              fileUl.appendChild(tli);
            }
            body.appendChild(fileUl);
          }
          wireMcpToolToggle(nameRow, body, tw);
          block.appendChild(nameRow);
          block.appendChild(body);
          toolsRoot.appendChild(block);
        }

        toolsRoot.appendChild(th);
        addMcpToolBlock(
          'read_md_handler_file',
          'Read the full UTF-8 text of one Markdown file under the workspace md/ folder (via the Agent or MCP client).',
          true
        );
        addMcpToolBlock(
          'write_flow_file_graph',
          "File flows: { order?, fileName, filePath, role }—step number in order, file location only in filePath (not the same as write_workflow_graph’s string ids). Writes visualizer/backtracked/; default opens Map via open_map.json.",
          false
        );
        addMcpToolBlock(
          'write_workflow_graph',
          'Advanced: steps { id, label, detail? } where id is a graph key (e.g. "1","2" for edges)—not filePath; for file paths + order use write_flow_file_graph. Same backtracked folder; optional openInMap.',
          false
        );
        liTools.appendChild(toolsRoot);
        mcpUl.appendChild(liTools);

        mcpFolderRow.addEventListener('click', function () {
          var hidden = mcpUl.classList.toggle('hidden');
          mcpTw.textContent = hidden ? '▸' : '▾';
          mcpFolderRow.setAttribute('aria-expanded', hidden ? 'false' : 'true');
        });
        mcpWrap.appendChild(mcpFolderRow);
        mcpWrap.appendChild(mcpUl);
        featuresEl.appendChild(mcpWrap);

        const wrap = document.createElement('div');
        wrap.className = 'md-feature-wrap';
        const folderRow = document.createElement('button');
        folderRow.type = 'button';
        folderRow.className = 'treeRow';
        folderRow.style.paddingLeft = '4px';
        folderRow.setAttribute('aria-expanded', 'false');
        const tw = document.createElement('span');
        tw.className = 'twisty';
        tw.textContent = '▸';
        const fic = document.createElement('span');
        fic.className = 'icon folderIcon';
        const fnm = document.createElement('span');
        fnm.className = 'name';
        fnm.textContent = '.md';
        folderRow.appendChild(tw);
        folderRow.appendChild(fic);
        folderRow.appendChild(fnm);
        const ul = document.createElement('ul');
        ul.className = 'children treeList hidden';
        for (const f of MD_HANDLER_MCP_FILES) {
          const li = document.createElement('li');
          li.className = 'treeItem';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'treeRow';
          btn.style.paddingLeft = '20px';
          const fi = document.createElement('span');
          fi.className = 'icon fileIcon';
          const nm = document.createElement('span');
          nm.className = 'name';
          nm.textContent = f;
          btn.appendChild(fi);
          btn.appendChild(nm);
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ type: 'openMdDoc', fileName: f });
          });
          li.appendChild(btn);
          ul.appendChild(li);
        }
        folderRow.addEventListener('click', () => {
          const hidden = ul.classList.toggle('hidden');
          tw.textContent = hidden ? '▸' : '▾';
          folderRow.setAttribute('aria-expanded', hidden ? 'false' : 'true');
        });
        wrap.appendChild(folderRow);
        wrap.appendChild(ul);
        featuresEl.appendChild(wrap);
        applyMcpFromPanel(mcpFromPanel);
      }

      function hideSavedFloatingMenu() {
        if (!savedFloatingMenuEl) return;
        savedFloatingMenuEl.classList.remove('visible');
        savedFloatingMenuEl.setAttribute('aria-hidden', 'true');
        savedMenuAbsPath = null;
      }

      function hideWorkspaceFloatingMenu() {
        if (!workspaceFloatingMenuEl) return;
        workspaceFloatingMenuEl.classList.remove('visible');
        workspaceFloatingMenuEl.setAttribute('aria-hidden', 'true');
        workspaceMenuAbsPath = null;
      }

      function showSavedFloatingMenu(clientX, clientY, absPath, label) {
        if (!savedFloatingMenuEl) return;
        savedMenuAbsPath = absPath;
        if (savedFloatingMenuTitleEl) {
          savedFloatingMenuTitleEl.textContent = label || absPath.split(/[/\\\\]/).pop() || absPath;
        }
        savedFloatingMenuEl.classList.add('visible');
        savedFloatingMenuEl.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
          const pad = 8;
          const rect = savedFloatingMenuEl.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let left = clientX;
          let top = clientY;
          if (left + rect.width > vw - pad) left = Math.max(pad, vw - rect.width - pad);
          if (top + rect.height > vh - pad) top = Math.max(pad, vh - rect.height - pad);
          savedFloatingMenuEl.style.left = left + 'px';
          savedFloatingMenuEl.style.top = top + 'px';
        });
      }

      function showWorkspaceFloatingMenu(clientX, clientY, absPath, label) {
        if (!workspaceFloatingMenuEl) return;
        workspaceMenuAbsPath = absPath;
        if (workspaceFloatingMenuTitleEl) {
          workspaceFloatingMenuTitleEl.textContent = label || absPath.split(/[/\\\\]/).pop() || absPath;
        }
        workspaceFloatingMenuEl.classList.add('visible');
        workspaceFloatingMenuEl.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
          const pad = 8;
          const rect = workspaceFloatingMenuEl.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let left = clientX;
          let top = clientY;
          if (left + rect.width > vw - pad) left = Math.max(pad, vw - rect.width - pad);
          if (top + rect.height > vh - pad) top = Math.max(pad, vh - rect.height - pad);
          workspaceFloatingMenuEl.style.left = left + 'px';
          workspaceFloatingMenuEl.style.top = top + 'px';
        });
      }

      if (savedFloatingMenuEl) {
        savedFloatingMenuEl.querySelectorAll('button[data-action]').forEach((btn) => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const path = savedMenuAbsPath;
            const action = btn.getAttribute('data-action');
            hideSavedFloatingMenu();
            if (!path || !action) return;
            if (action === 'open') vscode.postMessage({ type: 'openSaved', absPath: path });
            else if (action === 'save') vscode.postMessage({ type: 'savedGraphSaveInPlace', absPath: path });
            else if (action === 'saveAs') vscode.postMessage({ type: 'openSavedSaveAs', absPath: path });
          });
        });
        document.addEventListener(
          'mousedown',
          (e) => {
            if (!savedFloatingMenuEl.classList.contains('visible')) return;
            if (savedFloatingMenuEl.contains(e.target)) return;
            hideSavedFloatingMenu();
          },
          true
        );
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') hideSavedFloatingMenu();
        });
      }
      if (workspaceFloatingMenuEl) {
        workspaceFloatingMenuEl.querySelectorAll('button[data-action]').forEach((btn) => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const absPath = workspaceMenuAbsPath;
            const action = btn.getAttribute('data-action');
            hideWorkspaceFloatingMenu();
            if (!absPath || !action) return;
            if (action === 'rename') vscode.postMessage({ type: 'renameWorkspaceItem', absPath });
          });
        });
        document.addEventListener(
          'mousedown',
          (e) => {
            if (!workspaceFloatingMenuEl.classList.contains('visible')) return;
            if (workspaceFloatingMenuEl.contains(e.target)) return;
            hideWorkspaceFloatingMenu();
          },
          true
        );
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') hideWorkspaceFloatingMenu();
        });
      }

      function folderKey(node) {
        return String(node.absPath || node.relPath || node.label || '');
      }

      /** HTML5 drag + host fallback when Map View webview receives empty dataTransfer (cross-webview). */
      function bindDragFileSource(el, absPath) {
        if (!el || !absPath) return;
        el.setAttribute('draggable', 'true');
        el.addEventListener('dragstart', function (e) {
          var p = String(absPath);
          vscode.postMessage({ type: 'sidebarDragPaths', paths: [p] });
          try {
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'copy';
              e.dataTransfer.setData('text/plain', p);
            }
          } catch (err) {}
        });
      }

      function doSearch() {
        currentQueryText = String(queryEl.value || '').trim();
        vscode.postMessage({
          type: 'requestPanelData',
          query: currentQueryText,
          mode: currentMode,
          matchCase,
          wholeWord,
          useRegex,
        });
      }

      function setSavedCount(n) {
        if (!savedCountEl) return;
        const c = typeof n === 'number' && n >= 0 ? n : 0;
        savedCountEl.textContent = c === 0 ? '' : '(' + c + ')';
      }

      function renderSavedList(saved) {
        const list = Array.isArray(saved) ? saved : [];
        setSavedCount(list.length);
        savedEl.innerHTML = '';
        if (list.length === 0) {
          const none = document.createElement('div');
          none.className = 'empty';
          none.textContent = 'No saved graphs yet';
          savedEl.appendChild(none);
          return;
        }
        const savedList = document.createElement('ul');
        savedList.className = 'treeList';
        for (const s of list) {
          const li = document.createElement('li');
          li.className = 'treeItem';
          const btn = document.createElement('button');
          btn.className = 'treeRow';
          btn.type = 'button';
          btn.style.paddingLeft = '4px';
          btn.innerHTML = '<span class="twisty"></span><span class="icon fileIcon"></span><span class="name"></span>';
          const nameEl = btn.querySelector('.name');
          if (nameEl) nameEl.textContent = s.label;
          btn.title =
            s.relPath +
            ' — click: open · double-click: save copy as… · right-click: small menu (Open / Save / Save as)';
          let savedRowClickTimer = null;
          btn.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            if (savedRowClickTimer) {
              clearTimeout(savedRowClickTimer);
              savedRowClickTimer = null;
            }
            showSavedFloatingMenu(ev.clientX, ev.clientY, s.absPath, s.label);
          });
          btn.addEventListener('click', (ev) => {
            if (ev.detail > 1) return;
            if (savedRowClickTimer) clearTimeout(savedRowClickTimer);
            savedRowClickTimer = setTimeout(() => {
              savedRowClickTimer = null;
              vscode.postMessage({ type: 'openSaved', absPath: s.absPath });
            }, 280);
          });
          btn.addEventListener('dblclick', (ev) => {
            ev.preventDefault();
            if (savedRowClickTimer) {
              clearTimeout(savedRowClickTimer);
              savedRowClickTimer = null;
            }
            vscode.postMessage({ type: 'openSavedSaveAs', absPath: s.absPath });
          });
          bindDragFileSource(btn, s.absPath);
          li.appendChild(btn);
          savedList.appendChild(li);
        }
        savedEl.appendChild(savedList);
      }

      function scheduleSearch() {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          searchDebounceTimer = null;
          doSearch();
        }, SEARCH_DEBOUNCE_MS);
      }

      let wsScrollRaf = null;
      function updateWorkspaceHeaderScrollState() {
        const y = window.scrollY || document.documentElement.scrollTop || 0;
        document.body.classList.toggle('wsScrolled', y > 24);
      }
      function scheduleWorkspaceHeaderScrollState() {
        if (wsScrollRaf) cancelAnimationFrame(wsScrollRaf);
        wsScrollRaf = requestAnimationFrame(() => {
          wsScrollRaf = null;
          updateWorkspaceHeaderScrollState();
        });
      }

      function workspaceFileRows() {
        return Array.from(treeEl.querySelectorAll('button.treeRow .icon.fileIcon'))
          .map((icon) => icon.closest('button.treeRow'))
          .filter(Boolean);
      }

      function clearWorkspaceKeyboardSelection() {
        treeEl.querySelectorAll('button.treeRow.kbdActive').forEach((row) => row.classList.remove('kbdActive'));
      }

      function applyWorkspaceKeyboardSelection(idx) {
        const rows = workspaceFileRows();
        clearWorkspaceKeyboardSelection();
        if (!rows.length) {
          workspaceKeyboardIndex = -1;
          return;
        }
        const n = rows.length;
        workspaceKeyboardIndex = ((idx % n) + n) % n;
        const row = rows[workspaceKeyboardIndex];
        if (!row) return;
        row.classList.add('kbdActive');
        row.scrollIntoView({ block: 'nearest' });
      }

      function placeKeyboardSelectedFile() {
        const rows = workspaceFileRows();
        if (!rows.length) return false;
        if (workspaceKeyboardIndex < 0 || workspaceKeyboardIndex >= rows.length) {
          applyWorkspaceKeyboardSelection(0);
        }
        const row = rows[workspaceKeyboardIndex];
        const absPath = row && row.getAttribute('data-abs-path');
        if (!absPath) return false;
        vscode.postMessage({ type: 'placeInGraph', absPath });
        placementMode = false;
        clearWorkspaceKeyboardSelection();
        workspaceKeyboardIndex = -1;
        queryEl.value = '';
        return true;
      }

      queryEl.addEventListener('keydown', (e) => {
        if (placementMode && e.key === 'Escape') {
          e.preventDefault();
          placementMode = false;
          clearWorkspaceKeyboardSelection();
          workspaceKeyboardIndex = -1;
          vscode.postMessage({ type: 'cancelPlaceInGraph' });
          return;
        }
        if (placementMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          applyWorkspaceKeyboardSelection(workspaceKeyboardIndex + (e.key === 'ArrowDown' ? 1 : -1));
          return;
        }
        if (placementMode && e.key === 'Enter') {
          e.preventDefault();
          if (placeKeyboardSelectedFile()) return;
        }
        if (e.key === 'Enter') {
          if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
          searchDebounceTimer = null;
          doSearch();
        }
      });
      queryEl.addEventListener('input', scheduleSearch);
      function setMode(mode) {
        currentMode = mode;
        const filesActive = mode === 'files';
        modeFilesEl.classList.toggle('active', filesActive);
        modeFoldersEl.classList.toggle('active', !filesActive);
        modeFilesEl.setAttribute('aria-selected', filesActive ? 'true' : 'false');
        modeFoldersEl.setAttribute('aria-selected', filesActive ? 'false' : 'true');
        doSearch();
      }
      modeFilesEl.addEventListener('click', () => setMode('files'));
      modeFoldersEl.addEventListener('click', () => setMode('folders'));
      wsNewGraphEl.addEventListener('click', () => vscode.postMessage({ type: 'createEmptyGraph' }));
      wsNewFileEl.addEventListener('click', () => vscode.postMessage({ type: 'createFile' }));
      wsNewFolderEl.addEventListener('click', () => vscode.postMessage({ type: 'createFolder' }));
      wsRefreshEl.addEventListener('click', () => doSearch());
      wsCollapseAllEl.addEventListener('click', () => toggleWorkspaceTreeExpandCollapse());
      wsUndoRevealEl.addEventListener('click', () => vscode.postMessage({ type: 'undoWorkspaceReveal' }));
      function setToolState(el, on) { el.classList.toggle('active', on); }
      toolCaseEl.addEventListener('click', () => {
        matchCase = !matchCase;
        setToolState(toolCaseEl, matchCase);
        doSearch();
      });
      toolWordEl.addEventListener('click', () => {
        wholeWord = !wholeWord;
        setToolState(toolWordEl, wholeWord);
        doSearch();
      });
      toolRegexEl.addEventListener('click', () => {
        useRegex = !useRegex;
        setToolState(toolRegexEl, useRegex);
        doSearch();
      });
      if (connectImportsFromSidebarEl) {
        connectImportsFromSidebarEl.addEventListener('click', () => {
          vscode.postMessage({ type: 'toggleConnectImports' });
        });
      }
      window.addEventListener('scroll', scheduleWorkspaceHeaderScrollState, { passive: true });
      updateWorkspaceHeaderScrollState();

      window.addEventListener('message', (event) => {
        const msg = event.data || {};
        if (msg.type === 'mcpUpdate' && msg.mcp) {
          applyMcpFromPanel(msg.mcp);
          return;
        }
        if (msg.type === 'graphConnectImportsState') {
          if (graphConnectRowEl && connectImportsFromSidebarEl) {
            graphConnectRowEl.style.display = msg.show ? 'block' : 'none';
            const name = connectImportsFromSidebarEl.querySelector('.name');
            if (name) {
              name.textContent = String(msg.label || 'Connect imports');
            }
            connectImportsFromSidebarEl.classList.toggle('active', !!msg.active);
          }
          return;
        }
        if (msg.type === 'savedListUpdate') {
          renderSavedList(msg.saved);
          return;
        }
        if (msg.type === 'workspaceSelectionUpdate') {
          selectedWorkspacePath = String(msg.absPath || '');
          revealSelectedInWorkspaceTree();
          return;
        }
        if (msg.type === 'activatePlacement') {
          placementMode = true;
          workspaceKeyboardIndex = -1;
          window.scrollTo({ top: 0, behavior: 'smooth' });
          queryEl.focus();
          queryEl.select();
          if (currentMode !== 'files') setMode('files');
          else doSearch();
          setTimeout(() => {
            applyWorkspaceKeyboardSelection(0);
          }, 140);
          return;
        }
        if (msg.type === 'panelData') {
          const panel = msg.panel || {};
          if (currentQueryText.length > 0) {
            hadActiveSearch = true;
          } else if (hadActiveSearch) {
            expandedFolderState.clear();
            hadActiveSearch = false;
          }
          if (!featuresBlockInitialized) {
            renderFeaturesBlock(panel);
            featuresBlockInitialized = true;
          }
          if (panel.mcp) applyMcpFromPanel(panel.mcp);

          const saved = Array.isArray(panel.saved) ? panel.saved : [];
          const nodes = Array.isArray(panel.tree) ? panel.tree : [];
          renderSavedList(saved);
          treeEl.innerHTML = '';
          if (nodes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No files/folders match this filter';
            treeEl.appendChild(empty);
            return;
          }
          const ul = document.createElement('ul');
          ul.className = 'treeList';
          for (const n of nodes) ul.appendChild(renderNode(n, 0, true));
          treeEl.appendChild(ul);
          if (placementMode) {
            applyWorkspaceKeyboardSelection(workspaceKeyboardIndex >= 0 ? workspaceKeyboardIndex : 0);
          }
          revealSelectedInWorkspaceTree();
          if (currentMode === 'files' && currentQueryText) {
            requestAnimationFrame(function () {
              const hit = treeEl.querySelector('button.treeRow .icon.fileIcon');
              if (hit) {
                const row = hit.closest('button.treeRow');
                if (row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }
            });
          }
        }
      });

      function depthForChildUl(ul) {
        const btn = ul.previousElementSibling;
        if (!btn || !(btn instanceof Element) || !btn.matches('button.treeRow')) return -1;
        const d = btn.getAttribute('data-folder-depth');
        if (d === null || d === '') return -1;
        const n = parseInt(d, 10);
        return Number.isFinite(n) ? n : -1;
      }

      function syncFolderTwistiesFromDom() {
        treeEl.querySelectorAll('.treeRow[data-folder-key]').forEach((row) => {
          const twisty = row.querySelector('.twisty');
          const ul = row.nextElementSibling;
          if (!twisty || !ul || !ul.classList.contains('children')) return;
          const hidden = ul.classList.contains('hidden');
          twisty.textContent = hidden ? '▸' : '▾';
          const key = String(row.getAttribute('data-folder-key') || '');
          if (key) expandedFolderState.set(key, !hidden);
        });
      }

      /**
       * If any nested folder is open → reset to default (roots open, depth ≥ 1 collapsed).
       * If already in that default → expand every folder list.
       */
      function toggleWorkspaceTreeExpandCollapse() {
        const lists = Array.from(treeEl.querySelectorAll('ul.children'));
        if (lists.length === 0) return;
        const nestedLists = lists.filter((ul) => depthForChildUl(ul) >= 1);
        const anyNestedExpanded = nestedLists.some((ul) => !ul.classList.contains('hidden'));
        if (anyNestedExpanded) {
          lists.forEach((ul) => {
            const depth = depthForChildUl(ul);
            ul.classList.toggle('hidden', depth >= 1);
          });
        } else {
          lists.forEach((ul) => ul.classList.remove('hidden'));
        }
        syncFolderTwistiesFromDom();
      }

      function updateWorkspaceSelectionStyles() {
        treeEl.querySelectorAll('button.treeRow.active').forEach((el) => el.classList.remove('active'));
        if (!selectedWorkspacePath) return;
        treeEl.querySelectorAll('button.treeRow[data-abs-path]').forEach((el) => {
          if (el.getAttribute('data-abs-path') === selectedWorkspacePath) {
            el.classList.add('active');
          }
        });
      }

      function revealSelectedInWorkspaceTree() {
        if (!selectedWorkspacePath) return;
        let target = null;
        treeEl.querySelectorAll('button.treeRow[data-abs-path]').forEach((el) => {
          if (!target && el.getAttribute('data-abs-path') === selectedWorkspacePath) {
            target = el;
          }
        });
        if (!target) return;
        let cursor = target.parentElement;
        while (cursor && cursor !== treeEl) {
          if (cursor.tagName === 'UL' && cursor.classList.contains('children')) {
            cursor.classList.remove('hidden');
            const parentRow = cursor.previousElementSibling;
            if (parentRow && parentRow.classList.contains('treeRow')) {
              const twisty = parentRow.querySelector('.twisty');
              if (twisty) twisty.textContent = '▾';
              const key = String(parentRow.getAttribute('data-folder-key') || '');
              if (key) expandedFolderState.set(key, true);
            }
          }
          cursor = cursor.parentElement;
        }
        updateWorkspaceSelectionStyles();
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }

      function renderNode(node, depth, isRoot) {
        const li = document.createElement('li');
        li.className = 'treeItem';
        const pad = 4 + depth * 12;
        if (node.type === 'folder') {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'treeRow';
          row.style.paddingLeft = pad + 'px';
          const key = folderKey(node);
          row.setAttribute('data-folder-key', key);
          row.setAttribute('data-folder-depth', String(depth));
          row.title = node.relPath || node.absPath;
          row.setAttribute('data-abs-path', node.absPath);

          const twisty = document.createElement('span');
          twisty.className = 'twisty';
          const children = Array.isArray(node.children) ? node.children : [];
          const hasChildren = children.length > 0;
          const hasManualState = expandedFolderState.has(key);
          const onMatchPath = node.expandPath === true;
          const defaultExpanded = isRoot;
          const isExpanded = currentQueryText.length > 0
            ? onMatchPath
            : hasManualState
              ? expandedFolderState.get(key) === true
              : defaultExpanded;
          twisty.textContent = hasChildren ? (isExpanded ? '▾' : '▸') : '';

          const icon = document.createElement('span');
          icon.className = 'icon folderIcon';

          const name = document.createElement('span');
          name.className = 'name';
          name.textContent = node.label;

          row.appendChild(twisty);
          row.appendChild(icon);
          row.appendChild(name);
          if (selectedWorkspacePath && node.absPath === selectedWorkspacePath) {
            row.classList.add('active');
          }

          li.appendChild(row);

          row.addEventListener('click', () => {
            selectedWorkspacePath = node.absPath;
            updateWorkspaceSelectionStyles();
            if (hasChildren) {
              const nowHidden = childList.classList.toggle('hidden');
              twisty.textContent = nowHidden ? '▸' : '▾';
              expandedFolderState.set(key, !nowHidden);
            }
            vscode.postMessage({ type: 'openResult', resultType: 'folder', absPath: node.absPath });
          });

          let childList = null;
          if (hasChildren) {
            childList = document.createElement('ul');
            childList.className = 'children' + (isExpanded ? '' : ' hidden');
            for (const c of children) childList.appendChild(renderNode(c, depth + 1, false));
            li.appendChild(childList);
          }
          return li;
        }

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'treeRow';
        row.style.paddingLeft = pad + 'px';
        row.title = node.relPath;
        row.setAttribute('data-abs-path', node.absPath);
        row.innerHTML = '<span class="twisty"></span><span class="icon fileIcon"></span><span class="name"></span>';
        row.querySelector('.name').textContent = node.label;
        if (selectedWorkspacePath && node.absPath === selectedWorkspacePath) {
          row.classList.add('active');
        }
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          hideSavedFloatingMenu();
          showWorkspaceFloatingMenu(ev.clientX, ev.clientY, node.absPath, node.label);
        });
        row.addEventListener('click', () => {
          selectedWorkspacePath = node.absPath;
          updateWorkspaceSelectionStyles();
          vscode.postMessage({ type: 'openResult', resultType: 'file', absPath: node.absPath });
        });
        bindDragFileSource(row, node.absPath);
        li.appendChild(row);
        return li;
      }

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export function relPathFromWorkspace(absPath: string): string {
  const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
  if (!wf) return absPath;
  return path.relative(wf.uri.fsPath, absPath).replace(/\\/g, '/');
}
