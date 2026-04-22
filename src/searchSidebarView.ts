import * as path from 'path';
import * as vscode from 'vscode';

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
}

export type SidebarSavedListMessage = {
  type: 'savedListUpdate';
  saved: { label: string; absPath: string; relPath: string }[];
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

type ToggleLlmMessage = { type: 'toggleLlm' };
type OpenSavedMessage = { type: 'openSaved'; absPath: string };
type OpenSavedSaveAsMessage = { type: 'openSavedSaveAs'; absPath: string };
type SavedGraphSaveInPlaceMessage = { type: 'savedGraphSaveInPlace'; absPath: string };
type CreateFileMessage = { type: 'createFile' };
type CreateFolderMessage = { type: 'createFolder' };
type SidebarDragPathsMessage = { type: 'sidebarDragPaths'; paths: string[] };

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
      onCreateFile: () => Promise<void>;
      onCreateFolder: () => Promise<void>;
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
        | ToggleLlmMessage
        | OpenSavedMessage
        | OpenSavedSaveAsMessage
        | SavedGraphSaveInPlaceMessage
        | CreateFileMessage
        | CreateFolderMessage
        | SidebarDragPathsMessage
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
      if (msg.type === 'toggleLlm') {
        const useLlm = await this.hooks.onToggleLlm();
        void webview.postMessage({ type: 'llmState', useLlm });
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
      if (msg.type === 'openResult') {
        await this.hooks.onOpenResult({ resultType: msg.resultType, absPath: msg.absPath });
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
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 8px 0; }
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
  <div class="hint">Filter the workspace: <strong>File</strong> = filenames only; <strong>Folder</strong> = folder paths. With <strong>ab</strong> off, matches use word chunks (camelCase, separators). Click a file to build the graph.</div>
  <div class="sectionTitle" style="margin-top:10px;">Features</div>
  <div id="features" class="treeWrap"></div>
  <div class="sectionHeader">
    <div class="sectionTitle">Workspace</div>
    <div class="workspaceActions">
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
      const savedEl = document.getElementById('saved');
      const savedFloatingMenuEl = document.getElementById('savedFloatingMenu');
      const savedFloatingMenuTitleEl = document.getElementById('savedFloatingMenuTitle');
      const savedCountEl = document.getElementById('savedCount');
      const treeEl = document.getElementById('tree');
      const wsNewFileEl = document.getElementById('wsNewFile');
      const wsNewFolderEl = document.getElementById('wsNewFolder');
      const wsRefreshEl = document.getElementById('wsRefresh');
      const wsCollapseAllEl = document.getElementById('wsCollapseAll');
      let toggleLlmEl = null;
      let llmSubEl = null;
      const expandedFolderState = new Map();
      let hadActiveSearch = false;
      let searchDebounceTimer = null;
      const SEARCH_DEBOUNCE_MS = 280;
      let currentMode = 'files';
      let currentQueryText = '';
      let matchCase = false;
      let wholeWord = true;
      let useRegex = false;
      let savedMenuAbsPath = null;

      function hideSavedFloatingMenu() {
        if (!savedFloatingMenuEl) return;
        savedFloatingMenuEl.classList.remove('visible');
        savedFloatingMenuEl.setAttribute('aria-hidden', 'true');
        savedMenuAbsPath = null;
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

      queryEl.addEventListener('keydown', (e) => {
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
      wsNewFileEl.addEventListener('click', () => vscode.postMessage({ type: 'createFile' }));
      wsNewFolderEl.addEventListener('click', () => vscode.postMessage({ type: 'createFolder' }));
      wsRefreshEl.addEventListener('click', () => doSearch());
      wsCollapseAllEl.addEventListener('click', () => toggleWorkspaceTreeExpandCollapse());
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

      window.addEventListener('message', (event) => {
        const msg = event.data || {};
        if (msg.type === 'llmState') {
          if (llmSubEl) llmSubEl.textContent = msg.useLlm ? 'ON' : 'OFF';
          return;
        }
        if (msg.type === 'savedListUpdate') {
          renderSavedList(msg.saved);
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
          featuresEl.innerHTML = '';
          const featureBtn = document.createElement('button');
          featureBtn.type = 'button';
          featureBtn.className = 'treeRow';
          featureBtn.style.paddingLeft = '4px';
          featureBtn.innerHTML = '<span class="twisty"></span><span class="icon">⚙</span><span class="name">Use AI</span><span id="llmStateInline" class="sub" style="margin-left:auto;"></span>';
          featureBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleLlm' }));
          featuresEl.appendChild(featureBtn);
          toggleLlmEl = featureBtn;
          llmSubEl = featureBtn.querySelector('#llmStateInline');
          if (llmSubEl) llmSubEl.textContent = panel.useLlm ? 'ON' : 'OFF';

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

          li.appendChild(row);

          if (hasChildren) {
            const childList = document.createElement('ul');
            childList.className = 'children' + (isExpanded ? '' : ' hidden');
            for (const c of children) childList.appendChild(renderNode(c, depth + 1, false));
            row.addEventListener('click', () => {
              const nowHidden = childList.classList.toggle('hidden');
              twisty.textContent = nowHidden ? '▸' : '▾';
              expandedFolderState.set(key, !nowHidden);
            });
            li.appendChild(childList);
          }
          return li;
        }

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'treeRow';
        row.style.paddingLeft = pad + 'px';
        row.title = node.relPath;
        row.innerHTML = '<span class="twisty"></span><span class="icon fileIcon"></span><span class="name"></span>';
        row.querySelector('.name').textContent = node.label;
        row.addEventListener('click', () => {
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
