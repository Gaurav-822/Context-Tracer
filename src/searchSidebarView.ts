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
}

export interface SidebarPanelData {
  useLlm: boolean;
  saved: { label: string; absPath: string; relPath: string }[];
  tree: SidebarTreeNode[];
}

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
type CreateFileMessage = { type: 'createFile' };
type CreateFolderMessage = { type: 'createFolder' };

export class SearchSidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hooks: {
      onOpenResult: (result: { resultType: SearchResultType; absPath: string }) => Promise<void>;
      onRequestPanelData: (params: {
        query?: string;
        mode?: 'files' | 'folders';
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
      }) => Promise<SidebarPanelData>;
      onToggleLlm: () => Promise<boolean>;
      onOpenSaved: (absPath: string) => Promise<void>;
      onCreateFile: () => Promise<void>;
      onCreateFolder: () => Promise<void>;
    }
  ) {}

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
      const msg = raw as OpenRequestMessage | RequestTreeMessage | ToggleLlmMessage | OpenSavedMessage | CreateFileMessage | CreateFolderMessage | { type: 'ready' };
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

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
      <button id="toolWord" type="button" class="toolBtn" title="Match Whole Word" data-tip="Match Whole Word">ab</button>
      <button id="toolRegex" type="button" class="toolBtn" title="Use Regular Expression" data-tip="Use Regular Expression">.*</button>
    </div>
  </div>
  <div class="hint">Type to filter Workspace. Click a file to build graph, or folder to reveal it.</div>
  <div class="sectionTitle">Build From File</div>
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
      <button id="wsCollapseAll" type="button" class="wsActionBtn" title="Collapse/Expand All" data-tip="Collapse / Expand All" aria-label="Collapse or Expand All">
        <svg viewBox="0 0 16 16"><path d="M3 3.5h10"/><path d="M3 8h10"/><path d="M3 12.5h10"/><path d="M6 5.2 4.2 3.5 6 1.8"/><path d="M10 10.8 11.8 12.5 10 14.2"/></svg>
      </button>
    </div>
  </div>
  <div id="tree" class="treeWrap workspaceBody"></div>
  <div class="sectionTitle" style="margin-top:10px;">Saved</div>
  <div id="saved" class="treeWrap"></div>

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
      const treeEl = document.getElementById('tree');
      const wsNewFileEl = document.getElementById('wsNewFile');
      const wsNewFolderEl = document.getElementById('wsNewFolder');
      const wsRefreshEl = document.getElementById('wsRefresh');
      const wsCollapseAllEl = document.getElementById('wsCollapseAll');
      let toggleLlmEl = null;
      let llmSubEl = null;
      const expandedFolderState = new Map();
      let searchDebounceTimer = null;
      const SEARCH_DEBOUNCE_MS = 280;
      let currentMode = 'files';
      let currentQueryText = '';
      let matchCase = false;
      let wholeWord = false;
      let useRegex = false;

      function folderKey(node) {
        return String(node.absPath || node.relPath || node.label || '');
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
      wsCollapseAllEl.addEventListener('click', () => toggleCollapseAll());
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
        if (msg.type === 'panelData') {
          const panel = msg.panel || {};
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
          savedEl.innerHTML = '';
          if (saved.length === 0) {
            const none = document.createElement('div');
            none.className = 'empty';
            none.textContent = '0 files';
            savedEl.appendChild(none);
          } else {
            const savedList = document.createElement('ul');
            savedList.className = 'treeList';
            for (const s of saved) {
              const li = document.createElement('li');
              li.className = 'treeItem';
              const btn = document.createElement('button');
              btn.className = 'treeRow';
              btn.type = 'button';
              btn.style.paddingLeft = '4px';
              btn.innerHTML = '<span class="twisty"></span><span class="icon fileIcon"></span><span class="name">' + s.label + '</span>';
              btn.title = s.relPath;
              btn.addEventListener('click', () => vscode.postMessage({ type: 'openSaved', absPath: s.absPath }));
              li.appendChild(btn);
              savedList.appendChild(li);
            }
            savedEl.appendChild(savedList);
          }
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
        }
      });

      function toggleCollapseAll() {
        const lists = Array.from(treeEl.querySelectorAll('.children'));
        if (lists.length === 0) return;
        const anyExpanded = lists.some((el) => !el.classList.contains('hidden'));
        const targetExpand = !anyExpanded;
        lists.forEach((el) => {
          el.classList.toggle('hidden', !targetExpand);
        });
        const rows = Array.from(treeEl.querySelectorAll('.treeRow'));
        rows.forEach((row) => {
          const twisty = row.querySelector('.twisty');
          if (!twisty || !twisty.textContent) return;
          twisty.textContent = targetExpand ? '▾' : '▸';
        });
        const folderRows = Array.from(treeEl.querySelectorAll('.treeRow'));
        folderRows.forEach((row) => {
          const title = String(row.getAttribute('title') || '');
          if (!title) return;
          expandedFolderState.set(title, targetExpand);
        });
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
          row.title = node.relPath || node.absPath;

          const twisty = document.createElement('span');
          twisty.className = 'twisty';
          const children = Array.isArray(node.children) ? node.children : [];
          const hasChildren = children.length > 0;
          const key = folderKey(node);
          const hasManualState = expandedFolderState.has(key);
          const isExpanded = hasManualState ? expandedFolderState.get(key) === true : currentQueryText.length > 0;
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
