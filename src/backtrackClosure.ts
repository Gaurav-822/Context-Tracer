/**
 * Build the set of open editor files that transitively import a seed file (reverse import closure).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const IMPORT_REGEX = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|(?:const|var|let)\s+\w+\s*=\s*require\s*\()\s*["'`]([^"'`]+)["'`]/g;

export function extractAllLocalImportSpecsFromText(content: string): string[] {
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_REGEX.lastIndex = 0;
  while ((m = IMPORT_REGEX.exec(stripped)) !== null) {
    const spec = m[1];
    if (spec && !spec.startsWith('#') && (spec.startsWith('.') || spec.startsWith('/'))) {
      out.push(spec);
    }
  }
  return [...new Set(out)];
}

export function resolveLocalFilePath(baseDir: string, importPath: string): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
  const fullPath = path.resolve(baseDir, importPath);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];
  for (const ext of extensions) {
    const candidate = ext ? (fullPath.endsWith(ext) ? fullPath : fullPath + ext) : fullPath;
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const idx = path.join(candidate, `index${ext || '.ts'}`);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

function normRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Compare two project-relative paths (handles minor normalization differences). */
function relPathsEqual(a: string, b: string, projectRoot: string): boolean {
  const na = normRel(a);
  const nb = normRel(b);
  if (na === nb) return true;
  const absA = path.join(projectRoot, na);
  const absB = path.join(projectRoot, nb);
  try {
    return path.resolve(absA) === path.resolve(absB);
  } catch {
    return false;
  }
}

export interface ImporterClosureResult {
  /** All reachable rel paths including seed (workspace-relative). */
  closureRelPaths: string[];
  /** Edges: importer -> imported (imported is the dependency target). */
  edges: Array<{ from: string; to: string }>;
}

/**
 * Among currently open JS/TS documents, find every file that directly or transitively imports `seedRelPath`.
 */
export function computeImporterClosureFromOpenEditors(
  seedRelPath: string,
  projectRoot: string
): ImporterClosureResult {
  const seed = normRel(seedRelPath);
  const edges: Array<{ from: string; to: string }> = [];

  type OpenEntry = { rel: string; abs: string };
  const openFiles: OpenEntry[] = [];

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== 'file') continue;
    const ext = path.extname(doc.uri.fsPath).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) continue;
    const wf = vscode.workspace.getWorkspaceFolder(doc.uri);
    const root = wf?.uri.fsPath ?? projectRoot;
    if (!doc.uri.fsPath.startsWith(root + path.sep) && doc.uri.fsPath !== root) {
      continue;
    }
    const rel = normRel(path.relative(root, doc.uri.fsPath));
    openFiles.push({ rel, abs: doc.uri.fsPath });
  }

  const closure = new Set<string>([seed]);
  const queue: string[] = [seed];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const { rel, abs } of openFiles) {
      if (closure.has(rel)) continue;
      const content = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs)?.getText() ?? '';
      const specs = extractAllLocalImportSpecsFromText(content);
      const importerDir = path.dirname(abs);
      let importsCur = false;
      for (const spec of specs) {
        const resolvedAbs = resolveLocalFilePath(importerDir, spec);
        if (!resolvedAbs) continue;
        const wf = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(resolvedAbs));
        const root = wf?.uri.fsPath ?? projectRoot;
        const resRel = normRel(path.relative(root, resolvedAbs));
        if (relPathsEqual(resRel, cur, projectRoot)) {
          importsCur = true;
          edges.push({ from: rel, to: cur });
          break;
        }
      }
      if (importsCur) {
        closure.add(rel);
        queue.push(rel);
      }
    }
  }

  return {
    closureRelPaths: [...closure].sort((a, b) => a.localeCompare(b)),
    edges,
  };
}
