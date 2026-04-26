import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const DEBOUNCE_MS = 120;
const lastHandledByKey = new Map<string, number>();

type OpenMapBody = { graphFile?: string; fsPath?: string };

/**
 * Watches `visualizer/mcp/open_map.json` in each workspace folder. The MCP server writes a short
 * JSON request; this bridge loads the graph and brings Map View to the front, then removes the
 * request file. This is the supported way to open Map View from a stdio MCP process.
 */
export function registerMcpOpenMapFileWatcher(
  context: vscode.ExtensionContext,
  onOpenGraphJson: (absPath: string) => Promise<void>
): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return;

  for (const wf of folders) {
    const pattern = new vscode.RelativePattern(wf, 'visualizer/mcp/open_map.json');
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const run = (uri: vscode.Uri) => {
      const k = uri.toString();
      const now = Date.now();
      if (now - (lastHandledByKey.get(k) || 0) < DEBOUNCE_MS) return;
      lastHandledByKey.set(k, now);
      void (async () => {
        try {
          await processOpenMapFile(uri, wf.uri.fsPath, onOpenGraphJson);
        } catch {
          /* ignore */
        }
      })();
    };
    w.onDidCreate(run);
    w.onDidChange(run);
    context.subscriptions.push(w);
  }
}

async function processOpenMapFile(
  uri: vscode.Uri,
  workspaceRoot: string,
  onOpenGraphJson: (absPath: string) => Promise<void>
): Promise<void> {
  let text: string;
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    text = new TextDecoder('utf-8').decode(buf);
  } catch {
    return;
  }
  let body: OpenMapBody;
  try {
    body = JSON.parse(text) as OpenMapBody;
  } catch {
    return;
  }

  const root = path.resolve(workspaceRoot);
  const visPrefix = path.join(root, 'visualizer') + path.sep;

  let abs: string | undefined;
  if (body.fsPath && path.isAbsolute(body.fsPath)) {
    const n = path.normalize(body.fsPath);
    if (n.startsWith(visPrefix) && n.toLowerCase().endsWith('.json')) abs = n;
  } else if (body.graphFile && typeof body.graphFile === 'string') {
    const rel = body.graphFile.replace(/^[/\\]+/, '');
    if (!rel.includes('..')) {
      const n = path.normalize(path.join(root, rel));
      if (n.startsWith(visPrefix) && n.toLowerCase().endsWith('.json')) abs = n;
    }
  }

  if (!abs) {
    void vscode.window.showWarningMessage('MCP open map: path must be a .json under visualizer/.');
  } else {
    let ok = false;
    try {
      ok = fs.existsSync(abs) && fs.statSync(abs).isFile();
    } catch {
      ok = false;
    }
    if (ok) {
      await onOpenGraphJson(abs);
    }
  }

  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch {
    /* ignore */
  }
}
