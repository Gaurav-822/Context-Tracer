/**
 * Builds a dependency graph from a single file by tracing all imports.
 * Supports optional LLM summaries via Ollama.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GraphData, GraphSnapshot, NodeData, EdgeData } from './types';
import { getUsedLocalImportSpecs, getUsedPackageSpecs } from './usedImports';

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

function resolveLocalFilePath(baseDir: string, importPath: string): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
  const fullPath = path.resolve(baseDir, importPath);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];
  for (const ext of extensions) {
    const candidate = ext ? (fullPath.endsWith(ext) ? fullPath : fullPath + ext) : fullPath;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const idx = path.join(candidate, `index${ext || '.ts'}`);
    if (fs.existsSync(idx)) return idx;
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
}

async function buildFileNode(
  absPath: string,
  projectRoot: string,
  visited: Set<string>,
  useLlm: boolean
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
    };
  }
  visited.add(absPath);

  const summary = useLlm
    ? await getFileSummaryFromOllama(absPath, path.basename(absPath))
    : 'File dependency';

  const usedLocalSpecs = getUsedLocalImportSpecs(absPath);
  const usedPackages = getUsedPackageSpecs(absPath);
  const packages = Array.from(usedPackages);
  const internalFiles: FileNode[] = [];

  for (const imp of usedLocalSpecs) {
    const resolved = resolveLocalFilePath(fileDir, imp);
    if (resolved) {
      internalFiles.push(await buildFileNode(resolved, projectRoot, visited, useLlm));
    }
  }

  return {
    relPath,
    absPath,
    summary,
    packages,
    internalFiles,
    isCircular: false,
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
      const edgeKey = `${node.relPath}->${child.relPath}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({
          from: node.relPath,
          to: child.relPath,
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
  edges.unshift({ from: routeName, to: rootId, color: { color: 'rgba(255,255,255,0.3)', highlight: '#FFC107', hover: '#FFC107' }, width: 2, selectionWidth: 2, smooth: false });

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

  const root = await buildFileNode(absPath, projectRoot, new Set(), useLlm);
  const relPath = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  const routeName = `Import: ${relPath}`;
  const snapshot = fileNodeToGraphSnapshot(root, routeName);

  return {
    graphSnapshots: { [routeName]: snapshot },
    routeNames: [routeName],
  };
}
