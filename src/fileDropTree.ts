import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const VALID_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SOFT_DELETED_KEY = 'apiGraphVisualizer.softDeleted';

function isValidFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VALID_EXTS.includes(ext);
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

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const FILES_ID = 'files-section';
    const ARCHIVED_ID = 'archived-section';

    if (element?.id === 'add-files-option') {
      const llmItem = new vscode.TreeItem('Use AI', vscode.TreeItemCollapsibleState.None);
      llmItem.id = 'llm-option';
      llmItem.description = this.useLlm ? 'ON' : 'OFF';
      llmItem.tooltip = 'Click to toggle LLM summaries for import graphs';
      llmItem.iconPath = new vscode.ThemeIcon(this.useLlm ? 'sparkle' : 'circle-outline');
      llmItem.command = { command: 'apiGraphVisualizer.toggleFileGraphLlm', title: 'Toggle' };
      llmItem.contextValue = 'toggleOption';
      return [llmItem];
    }

    if (element?.id === 'llm-option') {
      return [];
    }

    if (element?.id === FILES_ID) {
      return this.droppedFiles.map((file) => {
        const ti = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
        ti.iconPath = new vscode.ThemeIcon('file-code');
        ti.tooltip = `Import: ${file}`;
        ti.contextValue = 'fileItem';
        ti.command = { command: 'apiGraphVisualizer.loadImportRoute', title: 'Load', arguments: [undefined, `Import: ${file}`] };
        return ti;
      });
    }

    if (element?.id === ARCHIVED_ID) {
      return [...this.softDeleted].map((file) => {
        const ti = new vscode.TreeItem(file, vscode.TreeItemCollapsibleState.None);
        ti.iconPath = new vscode.ThemeIcon('file-code');
        ti.tooltip = `Archived: ${file}`;
        ti.contextValue = 'softDeletedFile';
        ti.command = { command: 'apiGraphVisualizer.loadImportRoute', title: 'Load', arguments: [undefined, `Import: ${file}`] };
        return ti;
      });
    }

    const items: vscode.TreeItem[] = [];

    const dropItem = new vscode.TreeItem('Add files', vscode.TreeItemCollapsibleState.Expanded);
    dropItem.id = 'add-files-option';
    dropItem.description = 'Drop or browse';
    dropItem.tooltip = 'Drag .ts/.js files here or click to browse';
    dropItem.iconPath = new vscode.ThemeIcon('add');
    dropItem.command = { command: 'apiGraphVisualizer.pickFileForGraph', title: 'Browse' };

    items.push(dropItem);

    const filesSection = new vscode.TreeItem('Files', vscode.TreeItemCollapsibleState.Expanded);
    filesSection.id = FILES_ID;
    filesSection.description = this.droppedFiles.length > 0 ? `${this.droppedFiles.length} file${this.droppedFiles.length === 1 ? '' : 's'}` : 'Empty';
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
