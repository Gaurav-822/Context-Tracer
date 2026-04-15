import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const SOFT_DELETED_KEY = 'apiGraphVisualizer.softDeleted';
const DROPPED_FILES_KEY = 'apiGraphVisualizer.droppedFiles';

const SECTION_FEATURES = 'section:features';
const SECTION_SAVED = 'section:saved';
const ARCHIVED_ID = 'archived-section';

const WS_FILE_PREFIX = 'wsfile/';
const WS_DIR_PREFIX = 'wsdir/';
const WS_ROOT_PREFIX = 'wsroot/';

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function toFileNamedBasename(relPath: string): string {
  return relPath.replace(/[/\\]/g, '_').replace(/\s/g, '_') + '.json';
}

// ── Directory listing cache ──────────────────────────────────────────
interface DirCacheEntry {
  dirs: { name: string; abs: string }[];
  files: { name: string; abs: string }[];
  timestamp: number;
}
const dirCache = new Map<string, DirCacheEntry>();
const DIR_CACHE_TTL_MS = 5_000;

async function listDirAsync(dirAbs: string): Promise<DirCacheEntry> {
  const cached = dirCache.get(dirAbs);
  if (cached && Date.now() - cached.timestamp < DIR_CACHE_TTL_MS) return cached;

  const dirUri = vscode.Uri.file(dirAbs);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    const empty: DirCacheEntry = { dirs: [], files: [], timestamp: Date.now() };
    dirCache.set(dirAbs, empty);
    return empty;
  }

  const dirs: { name: string; abs: string }[] = [];
  const files: { name: string; abs: string }[] = [];
  for (const [name, type] of entries) {
    if (type === vscode.FileType.Directory) {
      dirs.push({ name, abs: path.join(dirAbs, name) });
    } else if (
      type === vscode.FileType.File ||
      type === vscode.FileType.SymbolicLink ||
      type === vscode.FileType.Unknown
    ) {
      files.push({ name, abs: path.join(dirAbs, name) });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  const entry: DirCacheEntry = { dirs, files, timestamp: Date.now() };
  dirCache.set(dirAbs, entry);
  return entry;
}

// ── Saved/files_named scan (lazy, cached) ────────────────────────────
let savedCountCache: { count: number; ts: number } | null = null;
const SAVED_CACHE_TTL = 10_000;

async function getSavedCountFast(): Promise<number> {
  if (savedCountCache && Date.now() - savedCountCache.ts < SAVED_CACHE_TTL) return savedCountCache.count;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return 0;
  const dirUri = vscode.Uri.file(path.join(root, 'visualizer', 'backtracked'));
  try {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const count = entries.filter(([n]) => n.endsWith('.json')).length;
    savedCountCache = { count, ts: Date.now() };
    return count;
  } catch {
    return 0;
  }
}

export function scanFilesNamed(projectRoot: string): string[] {
  const dir = path.join(projectRoot, 'visualizer', 'files_named');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const paths: string[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      try {
        const raw = fs.readFileSync(fp, 'utf-8');
        const data = JSON.parse(raw) as { routeNames?: string[] };
        const rn = data.routeNames?.[0];
        if (typeof rn === 'string' && rn.startsWith('Import: ')) {
          paths.push(rn.replace(/^Import:\s*/, ''));
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return paths;
}

export function scanSavedBacktrackedJson(projectRoot: string): string[] {
  const dir = path.join(projectRoot, 'visualizer', 'backtracked');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files: string[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      files.push(fp);
    }
  } catch { /* ignore */ }
  files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return files;
}

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
  dragMimeTypes: readonly string[] = ['text/uri-list', 'text/plain'];

  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private droppedFiles: string[] = [];
  useLlm = false;
  private softDeleted = new Set<string>();
  private lastDraggedRelPaths: string[] = [];
  private savedCountRefreshInFlight = false;
  private hasTriggeredInitialSavedCountRefresh = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.loadState();
  }

  private loadState(): void {
    const sd = this.context.workspaceState.get<string[]>(SOFT_DELETED_KEY);
    if (Array.isArray(sd)) this.softDeleted = new Set(sd);
    const dropped = this.context.workspaceState.get<string[]>(DROPPED_FILES_KEY);
    if (Array.isArray(dropped)) this.droppedFiles = [...new Set(dropped)];
  }

  private saveState(): void {
    this.context.workspaceState.update(SOFT_DELETED_KEY, [...this.softDeleted]);
    this.context.workspaceState.update(DROPPED_FILES_KEY, [...this.droppedFiles]);
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
    this.saveState();
    this._onDidChangeTreeData.fire();
  }

  refreshSavedGraphs(): void {
    savedCountCache = null;
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

  getDroppedFiles(): string[] { return [...this.droppedFiles]; }
  getSoftDeleted(): string[] { return [...this.softDeleted]; }
  hasSoftDeleted(relPath: string): boolean { return this.softDeleted.has(relPath); }

  consumeLastDraggedFiles(): string[] {
    const out = [...this.lastDraggedRelPaths];
    this.lastDraggedRelPaths = [];
    return out;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  private refreshSavedCountInBackground(): void {
    if (this.savedCountRefreshInFlight) return;
    this.savedCountRefreshInFlight = true;
    void (async () => {
      const before = savedCountCache?.count;
      const after = await getSavedCountFast();
      if (before !== after) {
        this._onDidChangeTreeData.fire();
      }
    })().finally(() => {
      this.savedCountRefreshInFlight = false;
    });
  }

  // ── getChildren (fully async, no sync fs on hot path) ──────────────
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element?.id === 'feature:llm') return [];

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

    if (element?.id?.startsWith(WS_ROOT_PREFIX)) {
      const idx = parseInt(element.id.slice(WS_ROOT_PREFIX.length), 10);
      if (Number.isNaN(idx)) return [];
      return this.listDirEntriesAsync(idx, '');
    }

    if (element?.id?.startsWith(WS_DIR_PREFIX)) {
      const rest = element.id.slice(WS_DIR_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return [];
      const wsIndex = parseInt(rest.slice(0, slash), 10);
      if (Number.isNaN(wsIndex)) return [];
      const relPosix = rest.slice(slash + 1);
      return this.listDirEntriesAsync(wsIndex, relPosix);
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

    // Root level: return section headers only (minimal I/O).
    const items: vscode.TreeItem[] = [];

    const featuresSection = new vscode.TreeItem('Features', vscode.TreeItemCollapsibleState.Expanded);
    featuresSection.id = SECTION_FEATURES;
    featuresSection.description = 'Options';
    featuresSection.iconPath = new vscode.ThemeIcon('settings-gear');
    featuresSection.contextValue = 'sectionHeader';
    items.push(featuresSection);

    const savedCount = savedCountCache?.count ?? 0;
    if (!this.hasTriggeredInitialSavedCountRefresh) {
      this.hasTriggeredInitialSavedCountRefresh = true;
      this.refreshSavedCountInBackground();
    }
    const savedSection = new vscode.TreeItem(
      'Saved',
      savedCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    savedSection.id = SECTION_SAVED;
    savedSection.description = `${savedCount} file${savedCount === 1 ? '' : 's'}`;
    savedSection.iconPath = new vscode.ThemeIcon('save-all');
    savedSection.contextValue = 'sectionHeader';
    items.push(savedSection);

    items.push(...this.listWorkspaceRootsAsync());

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

  // ── Async workspace roots ──────────────────────────────────────────
  private listWorkspaceRootsAsync(): vscode.TreeItem[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      const empty = new vscode.TreeItem('No folder open', vscode.TreeItemCollapsibleState.None);
      empty.description = 'Open a workspace folder';
      return [empty];
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

  // ── Async directory listing (uses vscode.workspace.fs + cache) ─────
  private async listDirEntriesAsync(wsIndex: number, relPosix: string): Promise<vscode.TreeItem[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.[wsIndex]) return [];
    const rootAbs = folders[wsIndex].uri.fsPath;
    const dirAbs = relPosix ? path.join(rootAbs, relPosix) : rootAbs;

    const { dirs, files } = await listDirAsync(dirAbs);

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
      ti.iconPath = new vscode.ThemeIcon('file');
      ti.tooltip = relForId;
      ti.contextValue = 'workspaceFile';
      ti.command = {
        command: 'apiGraphVisualizer.loadImportRoute',
        title: 'Open graph',
        arguments: [undefined, `Import: ${relForId}`],
      };
      items.push(ti);
    }
    return items;
  }

  async handleDrop(
    _target: vscode.TreeItem | undefined,
    _dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // Intentionally no-op: file tree interactions should stay separate from graph generation.
  }

  async handleDrag(
    source: readonly vscode.TreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uris: vscode.Uri[] = [];
    const relPaths: string[] = [];
    for (const item of source) {
      if (item.resourceUri && (item.contextValue === 'workspaceFile' || item.contextValue === 'savedGraphFile')) {
        uris.push(item.resourceUri);
      }
      if (item.contextValue === 'workspaceFile') {
        const rel = relPathFromWorkspaceTreeId(item.id);
        if (rel) relPaths.push(rel);
      }
    }
    this.lastDraggedRelPaths = [...new Set(relPaths)];
    if (uris.length === 0) return;
    const uriList = uris.map((u) => u.toString()).join('\n');
    const plain = uris.map((u) => u.fsPath).join('\n');
    dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriList));
    dataTransfer.set('text/plain', new vscode.DataTransferItem(plain));
  }
}
