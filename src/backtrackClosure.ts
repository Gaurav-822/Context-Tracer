/**
 * Find files that import a seed module: open-editor transitive closure, or full-workspace direct importers.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getAllLocalImportSpecsForGraph } from './usedImports';

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

function tryResolveFileOnDisk(fullPathNoExt: string): string | null {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];
  for (const ext of extensions) {
    const candidate = ext ? (fullPathNoExt.endsWith(ext) ? fullPathNoExt : fullPathNoExt + ext) : fullPathNoExt;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
    const idx = path.join(candidate, `index${ext || '.ts'}`);
    try {
      if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function isBareNpmPackage(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length <= 2;
  }
  return !spec.includes('/');
}

/** Resolve a graph-relevant import spec to an absolute file under `projectRoot` (relative, /, @/, ~/, path aliases). */
export function resolveProjectImportToAbs(baseDir: string, spec: string, projectRoot: string): string | null {
  const normRoot = path.resolve(projectRoot);
  const underProject = (abs: string) => {
    const r = path.resolve(abs);
    return r === normRoot || r.startsWith(normRoot + path.sep);
  };

  if (spec.startsWith('.') || spec.startsWith('/')) {
    const fullPath = spec.startsWith('/') ? spec : path.resolve(baseDir, spec);
    const hit = tryResolveFileOnDisk(fullPath);
    return hit && underProject(hit) ? hit : null;
  }

  if (isBareNpmPackage(spec)) return null;

  const candidates: string[] = [];
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    candidates.push(path.join(projectRoot, 'src', spec.slice(2)));
  }
  candidates.push(path.join(projectRoot, spec));
  candidates.push(path.join(projectRoot, 'src', spec));

  for (const c of candidates) {
    const hit = tryResolveFileOnDisk(c);
    if (hit && underProject(hit)) return hit;
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
  /** Edges: imported module -> importer (same convention as the main graph). */
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
          edges.push({ from: cur, to: rel });
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

const WORKSPACE_SCAN_EXCLUDE =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**,**/coverage/**}';

/**
 * Every workspace JS/TS file that has a static import / export-from / dynamic import() / require()
 * resolving to `seedRelPath` (one hop only). Same edge convention as the graph: from imported → importer.
 */
export async function computeDirectImportersFromWorkspace(
  seedRelPath: string,
  projectRoot: string,
  token?: vscode.CancellationToken
): Promise<ImporterClosureResult> {
  const seed = normRel(seedRelPath);
  const projRootAbs = path.resolve(projectRoot);
  const seedAbs = path.resolve(projRootAbs, seed.split('/').join(path.sep));
  const edgeKeys = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const importers = new Set<string>();

  const uris = await vscode.workspace.findFiles(
    '**/*.{ts,tsx,js,jsx,mjs,cjs}',
    WORKSPACE_SCAN_EXCLUDE,
    12000,
    token
  );

  for (const uri of uris) {
    if (token?.isCancellationRequested) break;
    const importerAbs = uri.fsPath;
    if (!importerAbs.startsWith(projRootAbs + path.sep) && importerAbs !== projRootAbs) continue;

    const rel = normRel(path.relative(projectRoot, importerAbs));
    if (rel === seed || rel.includes('::')) continue;

    let specs: Set<string>;
    try {
      specs = getAllLocalImportSpecsForGraph(importerAbs);
    } catch {
      continue;
    }
    if (specs.size === 0) continue;

    const importerDir = path.dirname(importerAbs);
    for (const spec of specs) {
      const resolved = resolveProjectImportToAbs(importerDir, spec, projectRoot);
      if (!resolved) continue;
      if (path.resolve(resolved) !== path.resolve(seedAbs)) continue;
      const k = `${seed}->${rel}`;
      if (!edgeKeys.has(k)) {
        edgeKeys.add(k);
        edges.push({ from: seed, to: rel });
      }
      importers.add(rel);
      break;
    }
  }

  const closureRelPaths = [seed, ...[...importers].sort((a, b) => a.localeCompare(b))];
  return { closureRelPaths, edges };
}
