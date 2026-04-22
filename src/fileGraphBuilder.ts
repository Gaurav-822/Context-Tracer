/**
 * Builds a dependency graph from a single file by tracing all imports.
 * Supports optional LLM summaries via Ollama.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GraphData, GraphSnapshot, NodeData, EdgeData } from './types';
import { getAllLocalImportSpecsForGraph, getUsedPackageSpecs } from './usedImports';

const IMPORT_REGEX = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|(?:const|var|let)\s+\w+\s*=\s*require\s*\()\s*["'`]([^"'`]+)["'`]/g;

function extractImportsFromFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stripped = content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const imports: string[] = [];
    let m;
    IMPORT_REGEX.lastIndex = 0;
    while ((m = IMPORT_REGEX.exec(stripped)) !== null) {
      const spec = m[1];
      if (spec && !spec.startsWith('#')) {
        imports.push(spec);
      }
    }
    return [...new Set(imports)];
  } catch {
    return [];
  }
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

/** Single-segment npm packages like `react`; path-alias imports like `views/foo` are not bare. */
function isBareNpmPackage(spec: string): boolean {
  if (spec.startsWith('.') || spec.startsWith('/')) return false;
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length <= 2;
  }
  return !spec.includes('/');
}

/**
 * Resolve import spec to a project file: relative (`./x`), absolute `/`, path aliases (`views/...`, `@/...`, `~/...`).
 */
function resolveImportSpecifier(baseDir: string, spec: string, projectRoot: string): string | null {
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

const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function getFileSummaryFromOllama(filePath: string, fileName: string): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const truncated = content.split('\n').slice(0, 100).join('\n');
    const prompt = `Explain this file's purpose in 1-2 short sentences. No filler.\n\n${truncated}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b',
        prompt,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return '(LLM unavailable)';
    const data = (await res.json()) as { response?: string };
    return (data?.response ?? '').trim().replace(/\n/g, ' ') || '(No summary)';
  } catch {
    return '(LLM unavailable)';
  }
}

interface FileNode {
  relPath: string;
  absPath: string;
  summary: string;
  packages: string[];
  internalFiles: FileNode[];
  isCircular: boolean;
  depth: number;
}

async function buildFileNode(
  absPath: string,
  projectRoot: string,
  visited: Set<string>,
  useLlm: boolean,
  depth: number
): Promise<FileNode> {
  const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  const fileDir = path.dirname(absPath);

  if (visited.has(absPath)) {
    return {
      relPath,
      absPath,
      summary: '(circular)',
      packages: [],
      internalFiles: [],
      isCircular: true,
      depth,
    };
  }
  visited.add(absPath);

  const summary = useLlm
    ? await getFileSummaryFromOllama(absPath, path.basename(absPath))
    : 'File dependency';

  const allLocalSpecs = getAllLocalImportSpecsForGraph(absPath);
  const usedPackages = getUsedPackageSpecs(absPath);
  const packages = Array.from(usedPackages);
  const internalFiles: FileNode[] = [];

  for (const imp of allLocalSpecs) {
    const resolved = resolveImportSpecifier(fileDir, imp, projectRoot);
    if (resolved) {
      internalFiles.push(await buildFileNode(resolved, projectRoot, visited, useLlm, depth + 1));
    }
  }

  return {
    relPath,
    absPath,
    summary,
    packages,
    internalFiles,
    isCircular: false,
    depth,
  };
}

function fileNodeToGraphSnapshot(
  root: FileNode,
  routeName: string
): GraphSnapshot {
  const nodes: NodeData[] = [];
  const edges: EdgeData[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();

  function addNode(node: FileNode, isRoot: boolean) {
    if (seenNodes.has(node.relPath)) return;
    seenNodes.add(node.relPath);

    const packagesStr = node.packages.length > 0 ? node.packages.join(', ') : 'None';
    const tooltip = `${node.relPath}\n\nWhat it does:\n${node.summary}\n\nNPM Packages:\n${packagesStr}${node.isCircular ? '\n\n⚠ CIRCULAR' : ''}`;

    const baseColor = node.isCircular ? '#E53935' : isRoot ? '#7B1FA2' : '#1E88E5';
    const borderColor = node.isCircular ? '#B71C1C' : isRoot ? '#4A148C' : '#0D47A1';

    nodes.push({
      id: node.relPath,
      label: node.relPath,
      title: tooltip,
      importLevel: node.depth,
      color: {
        background: baseColor,
        border: borderColor,
        highlight: { background: '#42A5F5', border: '#FFC107' },
        hover: { background: '#42A5F5', border: '#FFC107' },
      },
      font: { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' },
      shape: 'box',
      size: isRoot ? 40 : 38,
      borderWidth: 1.5,
      borderWidthSelected: 3,
      margin: 12,
      isController: isRoot,
    });

    for (const child of node.internalFiles) {
      const edgeKey = `${child.relPath}->${node.relPath}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          from: child.relPath,
          to: node.relPath,
          color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' },
          width: 1.5,
          selectionWidth: 2,
          smooth: false,
        });
      }
      addNode(child, false);
    }
  }

  addNode(root, true);

  const rootId = root.relPath;
  nodes.unshift({
    id: routeName,
    label: routeName,
    title: `Import root: ${rootId}`,
    importLevel: -1,
    color: {
      background: '#43A047',
      border: '#2E7D32',
      highlight: { background: '#66BB6A', border: '#FFC107' },
      hover: { background: '#66BB6A', border: '#FFC107' },
    },
    font: { color: '#ffffff', size: 16, face: 'Inter, -apple-system, sans-serif' },
    shape: 'hexagon',
    size: 36,
    borderWidth: 1.5,
    borderWidthSelected: 3,
    margin: 10,
  });
  edges.unshift({ from: rootId, to: routeName, color: { color: 'rgba(255,255,255,0.3)', highlight: '#FFC107', hover: '#FFC107' }, width: 2, selectionWidth: 2, smooth: false });

  return {
    nodes,
    edges,
    methodDeps: {},
    controllerMethods: {},
    defaultMethodId: null,
    controllerId: rootId,
  };
}

export async function buildFileGraph(
  entryPath: string,
  projectRoot: string,
  useLlm: boolean
): Promise<GraphData> {
  const absPath = path.isAbsolute(entryPath) ? entryPath : path.join(projectRoot, entryPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new Error(`File not found: ${entryPath}`);
  }

  const root = await buildFileNode(absPath, projectRoot, new Set(), useLlm, 0);
  const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  const routeName = `Import: ${relPath}`;
  const snapshot = fileNodeToGraphSnapshot(root, routeName);

  return {
    graphSnapshots: { [routeName]: snapshot },
    routeNames: [routeName],
  };
}
