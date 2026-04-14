import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const VALID_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SOFT_DELETED_KEY = 'apiGraphVisualizer.softDeleted';

const SECTION_FEATURES = 'section:features';
const SECTION_SAVED = 'section:saved';
const SECTION_FILES = 'section:files';
const ARCHIVED_ID = 'archived-section';

/** id: wsfile/<wsIndex>/<posixRelPath> */
const WS_FILE_PREFIX = 'wsfile/';
const WS_DIR_PREFIX = 'wsdir/';
const WS_ROOT_PREFIX = 'wsroot/';

function isValidFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VALID_EXTS.includes(ext);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function shouldSkipDirName(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === '.svn' || name === '.hg';
}

/** Convert relative path to safe filename for visualizer/files_named/ */
export function toFileNamedBasename(relPath: string): string {
  return relPath.replace(/[/\\]/g, '_').replace(/\s/g, '_') + '.json';
}

/** Scan visualizer/files_named/ and return relPaths from JSON routeNames */
export function scanFilesNamed(projectRoot: string): string[] {
  const dir = path.join(projectRoot, 'visualizer', 'files_named');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const paths: string[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      if (!fs.statSync(fp).isFile()) continue;
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data = JSON.parse(raw) as { routeNames?: string[] };
        const rn = data.routeNames?.[0];
        if (typeof rn === 'string' && rn.startsWith('Import: ')) {
          paths.push(rn.replace(/^Import:\s*/, ''));
        }
      } catch {
        /* skip invalid json */
      }
    }
  } catch {
    /* ignore */
  }
  return paths;
}

/** Scan visualizer/backtracked and return saved graph JSON absolute paths. */
export function scanSavedBacktrackedJson(projectRoot: string): string[] {
  const dir = path.join(projectRoot, 'visualizer', 'backtracked');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      if (!fs.statSync(fp).isFile()) continue;
      files.push(fp);
    }
  } catch {
    /* ignore */
  }
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return files;
}

/**
 * Parse workspace file tree id → posix rel path (from workspace folder root).
 * Returns undefined if not a workspace file id.
 */
export function relPathFromWorkspaceTreeId(id: string | undefined): string | undefined {
  if (!id || !id.startsWith(WS_FILE_PREFIX)) return undefined;
  const rest = id.slice(WS_FILE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  return rest.slice(slash + 1);
}

export class FileDropTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.TreeDragAndDropController<vscode.TreeItem>
{
  dropMimeTypes = ['text/uri-list', 'files'];
  dragMimeTypes: readonly string[] = [];

  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private droppedFiles: string[] = [];
  useLlm = false;
  private softDeleted = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private onBuild: (filePathOrUri: string | vscode.Uri, useLlm: boolean) => void,
    private onBuildMany?: (paths: (string | vscode.Uri)[], useLlm: boolean) => void
  ) {
    this.loadState();
  }

  private loadState(): void {
    const sd = this.context.workspaceState.get<string[]>(SOFT_DELETED_KEY);
    if (Array.isArray(sd)) this.softDeleted = new Set(sd);
  }

  private saveState(): void {
    this.context.workspaceState.update(SOFT_DELETED_KEY, [...this.softDeleted]);
  }

  toggleUseLlm(): void {
    this.useLlm = !this.useLlm;
    this._onDidChangeTreeData.fire();
  }

  refreshFromFilesNamed(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;
    const root = folders[0].uri.fsPath;
    const fromDisk = scanFilesNamed(root);
    const active = fromDisk.filter((p) => !this.softDeleted.has(p));
    const merged = new Set([...this.droppedFiles, ...active]);
    this.droppedFiles = [...merged];
    this._onDidChangeTreeData.fire();
  }

  /** Refresh tree sections that depend on saved graph files. */
  refreshSavedGraphs(): void {
    this._onDidChangeTreeData.fire();
  }

  updateDroppedFiles(importRoutes: string[]): void {
    const newPaths = importRoutes.map((r) => r.replace(/^Import:\s*/, ''));
    for (const p of newPaths) {
      if (p) {
        this.softDeleted.delete(p);
        if (!this.droppedFiles.includes(p)) this.droppedFiles.push(p);
      }
    }
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  softDelete(relPaths: string[]): void {
    for (const p of relPaths) {
      this.softDeleted.add(p);
      this.droppedFiles = this.droppedFiles.filter((x) => x !== p);
    }
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  softDeleteRemove(relPaths: string[]): void {
    for (const p of relPaths) this.softDeleted.delete(p);
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  /** Remove from both lists (used after hard delete) */
  removeCompletely(relPaths: string[]): void {
    const set = new Set(relPaths);
    this.droppedFiles = this.droppedFiles.filter((p) => !set.has(p));
    for (const p of relPaths) this.softDeleted.delete(p);
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  revive(relPaths: string[]): void {
    for (const p of relPaths) {
      this.softDeleted.delete(p);
      if (!this.droppedFiles.includes(p)) this.droppedFiles.push(p);
    }
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  removeFromDroppedFiles(relPaths: string[]): void {
    const set = new Set(relPaths);
    this.droppedFiles = this.droppedFiles.filter((p) => !set.has(p));
    for (const p of relPaths) this.softDeleted.delete(p);
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  getDroppedFiles(): string[] {
    return [...this.droppedFiles];
  }

  getSoftDeleted(): string[] {
    return [...this.softDeleted];
  }

  hasSoftDeleted(relPath: string): boolean {
    return this.softDeleted.has(relPath);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private listWorkspaceRoots(): vscode.TreeItem[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      const empty = new vscode.TreeItem('No folder open', vscode.TreeItemCollapsibleState.None);
      empty.description = 'Open a workspace folder';
      return [empty];
    }
    if (folders.length === 1) {
      return this.listDirEntries(0, '');
    }
    return folders.map((wf, i) => {
      const ti = new vscode.TreeItem(wf.name, vscode.TreeItemCollapsibleState.Collapsed);
      ti.id = `${WS_ROOT_PREFIX}${i}`;
      ti.resourceUri = wf.uri;
      ti.iconPath = new vscode.ThemeIcon('folder-opened');
      ti.tooltip = wf.uri.fsPath;
      return ti;
    });
  }

  private listDirEntries(wsIndex: number, relPosix: string): vscode.TreeItem[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.[wsIndex]) return [];
    const rootAbs = folders[wsIndex].uri.fsPath;
    const dirAbs = relPosix ? path.join(rootAbs, relPosix) : rootAbs;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs: { name: string; abs: string }[] = [];
    const files: { name: string; abs: string }[] = [];
    for (const d of dirents) {
      const name = d.name;
      if (d.isDirectory()) {
        if (shouldSkipDirName(name)) continue;
        dirs.push({ name, abs: path.join(dirAbs, name) });
      } else if (d.isFile() && isValidFile(name)) {
        files.push({ name, abs: path.join(dirAbs, name) });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const items: vscode.TreeItem[] = [];
    for (const { name, abs } of dirs) {
      const childRel = relPosix ? `${relPosix}/${name}` : name;
      const ti = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
      ti.id = `${WS_DIR_PREFIX}${wsIndex}/${childRel}`;
      ti.resourceUri = vscode.Uri.file(abs);
      ti.iconPath = new vscode.ThemeIcon('folder');
      ti.tooltip = toPosix(path.relative(rootAbs, abs));
      ti.contextValue = 'workspaceFolder';
      items.push(ti);
    }
    for (const { name, abs } of files) {
      const childRel = relPosix ? `${relPosix}/${name}` : name;
      const relForId = toPosix(childRel);
      const ti = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
      ti.id = `${WS_FILE_PREFIX}${wsIndex}/${relForId}`;
      ti.resourceUri = vscode.Uri.file(abs);
      ti.description = relForId;
      ti.iconPath = new vscode.ThemeIcon('file-code');
      ti.tooltip = `Open import map for ${relForId}`;
      ti.contextValue = 'workspaceFile';
      const uri = vscode.Uri.file(abs);
      ti.command = {
        command: 'apiGraphVisualizer.buildFromResource',
        title: 'Open map',
        arguments: [uri],
      };
      items.push(ti);
    }
    return items;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element?.id === 'feature:llm') {
      return [];
    }

    if (element?.id === SECTION_FEATURES) {
      const llmItem = new vscode.TreeItem('Use AI', vscode.TreeItemCollapsibleState.None);
      llmItem.id = 'feature:llm';
      llmItem.description = this.useLlm ? 'ON' : 'OFF';
      llmItem.tooltip = 'Click to toggle LLM summaries for import graphs';
      llmItem.iconPath = new vscode.ThemeIcon(this.useLlm ? 'sparkle' : 'circle-outline');
      llmItem.command = { command: 'apiGraphVisualizer.toggleFileGraphLlm', title: 'Toggle' };
      llmItem.contextValue = 'toggleOption';
      return [llmItem];
    }

    if (element?.id === SECTION_SAVED) {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) return [];
      const root = folders[0].uri.fsPath;
      const saved = scanSavedBacktrackedJson(root);
      return saved.map((fp) => {
        const base = path.basename(fp);
        const rel = toPosix(path.relative(root, fp));
        const ti = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.None);
        ti.iconPath = new vscode.ThemeIcon('save');
        ti.description = 'backtracked';
        ti.tooltip = rel;
        ti.contextValue = 'savedGraphFile';
        ti.command = {
          command: 'apiGraphVisualizer.loadSavedGraph',
          title: 'Open saved graph',
          arguments: [vscode.Uri.file(fp)],
        };
        return ti;
      });
    }

    if (element?.id === SECTION_FILES) {
      return this.listWorkspaceRoots();
    }

    if (element?.id?.startsWith(WS_ROOT_PREFIX)) {
      const idx = parseInt(element.id.slice(WS_ROOT_PREFIX.length), 10);
      if (Number.isNaN(idx)) return [];
      return this.listDirEntries(idx, '');
    }

    if (element?.id?.startsWith(WS_DIR_PREFIX)) {
      const rest = element.id.slice(WS_DIR_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return [];
      const wsIndex = parseInt(rest.slice(0, slash), 10);
      if (Number.isNaN(wsIndex)) return [];
      const relPosix = rest.slice(slash + 1);
      return this.listDirEntries(wsIndex, relPosix);
    }

    if (element?.id === ARCHIVED_ID) {
      return [...this.softDeleted].sort((a, b) => a.localeCompare(b)).map((file) => {
        const ti = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
        ti.iconPath = new vscode.ThemeIcon('file-code');
        ti.tooltip = `Archived: ${file}`;
        ti.contextValue = 'softDeletedFile';
        ti.command = { command: 'apiGraphVisualizer.loadImportRoute', title: 'Load', arguments: [undefined, `Import: ${file}`] };
        return ti;
      });
    }

    const items: vscode.TreeItem[] = [];

    const featuresSection = new vscode.TreeItem('Features', vscode.TreeItemCollapsibleState.Expanded);
    featuresSection.id = SECTION_FEATURES;
    featuresSection.description = 'Options';
    featuresSection.iconPath = new vscode.ThemeIcon('settings-gear');
    featuresSection.contextValue = 'sectionHeader';
    items.push(featuresSection);

    const folders = vscode.workspace.workspaceFolders;
    const root = folders?.[0]?.uri.fsPath;
    const savedCount = root ? scanSavedBacktrackedJson(root).length : 0;
    const savedSection = new vscode.TreeItem(
      'Saved',
      savedCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    savedSection.id = SECTION_SAVED;
    savedSection.description = `${savedCount} file${savedCount === 1 ? '' : 's'}`;
    savedSection.iconPath = new vscode.ThemeIcon('save-all');
    savedSection.contextValue = 'sectionHeader';
    items.push(savedSection);

    const filesSection = new vscode.TreeItem('Files', vscode.TreeItemCollapsibleState.Expanded);
    filesSection.id = SECTION_FILES;
    filesSection.description = 'Workspace';
    filesSection.iconPath = new vscode.ThemeIcon('folder');
    filesSection.contextValue = 'sectionHeader';
    items.push(filesSection);

    if (this.softDeleted.size > 0) {
      const archivedSection = new vscode.TreeItem('Archived', vscode.TreeItemCollapsibleState.Collapsed);
      archivedSection.id = ARCHIVED_ID;
      archivedSection.description = `${this.softDeleted.size} file${this.softDeleted.size === 1 ? '' : 's'}`;
      archivedSection.iconPath = new vscode.ThemeIcon('archive');
      archivedSection.contextValue = 'sectionHeader';
      items.push(archivedSection);
    }

    return items;
  }

  async handleDrop(
    _target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uris: vscode.Uri[] = [];

    const fileItem = dataTransfer.get('files');
    if (fileItem) {
      const file = fileItem.asFile();
      if (file?.uri && isValidFile(file.uri.fsPath)) uris.push(file.uri);
    }

    if (uris.length === 0) {
      const uriItem = dataTransfer.get('text/uri-list');
      if (uriItem) {
        const s = await uriItem.asString();
        const lines = s.trim().split(/[\r\n]+/).filter(Boolean);
        for (const uriStr of lines) {
          try {
            const parsed = vscode.Uri.parse(uriStr);
            if ((parsed.scheme === 'file' || parsed.scheme === 'vscode-file') && isValidFile(parsed.fsPath)) {
              uris.push(parsed);
              continue;
            }
          } catch {
            /* fallback */
          }
          if (uriStr.startsWith('file://') || uriStr.startsWith('vscode-file://') || uriStr.startsWith('vscode://file/')) {
            let pathPart = uriStr
              .replace(/^file:\/\/\/?/i, '')
              .replace(/^vscode-file:\/\/[^/]+\//i, '')
              .replace(/^vscode:\/\/file\//i, '');
            if (pathPart) {
              pathPart = decodeURIComponent(pathPart);
              if (!pathPart.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(pathPart)) pathPart = '/' + pathPart;
              const u = vscode.Uri.file(pathPart);
              if (isValidFile(u.fsPath)) uris.push(u);
            }
          }
        }
      }
    }

    if (uris.length === 0) {
      vscode.window.showWarningMessage('Select .ts, .tsx, .js, .jsx, .mjs, or .cjs files.');
      return;
    }
    if (uris.length === 1) {
      this.onBuild(uris[0], this.useLlm);
    } else if (this.onBuildMany) {
      this.onBuildMany(uris, this.useLlm);
    } else {
      for (const u of uris) this.onBuild(u, this.useLlm);
    }
  }
}
