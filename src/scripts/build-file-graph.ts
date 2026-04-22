/**
 * Build import graph from a file, with optional LLM summaries.
 * Run: npx ts-node build-file-graph.ts <file-path> [--llm]
 * Requires: PROJECT_ROOT env, Ollama (when --llm)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getUsedLocalImportSpecs, getUsedPackageSpecs } from '../usedImports';

const PROJECT_ROOT = process.env.PROJECT_ROOT
  ? path.resolve(process.env.PROJECT_ROOT)
  : path.resolve(__dirname, '../..');

const IMPORT_REGEX = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|(?:const|var|let)\s+\w+\s*=\s*require\s*\()\s*["'`]([^"'`]+)["'`]/g;
const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

function extractImports(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stripped = content.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const imports: string[] = [];
    let m;
    IMPORT_REGEX.lastIndex = 0;
    while ((m = IMPORT_REGEX.exec(stripped)) !== null) {
      const spec = m[1];
      if (spec && !spec.startsWith('#')) imports.push(spec);
    }
    return [...new Set(imports)];
  } catch {
    return [];
  }
}

function resolveLocal(baseDir: string, imp: string): string | null {
  if (!imp.startsWith('.') && !imp.startsWith('/')) return null;
  const full = path.resolve(baseDir, imp);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '']) {
    const c = ext ? (full.endsWith(ext) ? full : full + ext) : full;
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    const idx = path.join(c, `index${ext || '.ts'}`);
    if (fs.existsSync(idx)) return idx;
  }
  return null;
}

async function ollamaSummary(filePath: string): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const truncated = content.split('\n').slice(0, 100).join('\n');
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b',
        prompt: `Explain this file's purpose in 1-2 short sentences. No filler.\n\n${truncated}`,
        stream: false,
      }),
    });
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

let totalFiles = 0;
let processedCount = 0;

async function buildNode(
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

  processedCount++;
  if (useLlm) {
    process.stdout.write(`\r⏳ [${processedCount}/${totalFiles}] Ollama: ${relPath}...`);
  }

  const summary = useLlm ? await ollamaSummary(absPath) : 'File dependency';

  const usedLocalSpecs = getUsedLocalImportSpecs(absPath);
  const packages = Array.from(getUsedPackageSpecs(absPath));
  const internalFiles: FileNode[] = [];

  for (const imp of usedLocalSpecs) {
    const resolved = resolveLocal(fileDir, imp);
    if (resolved) {
      internalFiles.push(await buildNode(resolved, projectRoot, visited, useLlm));
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

function countFiles(absPath: string, projectRoot: string, visited: Set<string>): number {
  if (visited.has(absPath)) return 0;
  visited.add(absPath);
  const fileDir = path.dirname(absPath);
  const usedLocalSpecs = getUsedLocalImportSpecs(absPath);
  let n = 1;
  for (const imp of usedLocalSpecs) {
    const resolved = resolveLocal(fileDir, imp);
    if (resolved) n += countFiles(resolved, projectRoot, visited);
  }
  return n;
}

function toGraphSnapshot(root: FileNode, routeName: string) {
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const seenEdges = new Set<string>();

  function add(n: FileNode, isRoot: boolean) {
    if (seen.has(n.relPath)) return;
    seen.add(n.relPath);
    const pkgStr = n.packages.length ? n.packages.join(', ') : 'None';
    const tooltip = `${n.relPath}\n\nWhat it does:\n${n.summary}\n\nNPM Packages:\n${pkgStr}${n.isCircular ? '\n\n⚠ CIRCULAR' : ''}`;
    const bg = n.isCircular ? '#E53935' : isRoot ? '#7B1FA2' : '#1E88E5';
    const border = n.isCircular ? '#B71C1C' : isRoot ? '#4A148C' : '#0D47A1';
    nodes.push({
      id: n.relPath,
      label: n.relPath,
      title: tooltip,
      color: { background: bg, border, highlight: { background: '#42A5F5', border: '#FFC107' }, hover: { background: '#42A5F5', border: '#FFC107' } },
      font: { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' },
      shape: 'box',
      size: isRoot ? 40 : 38,
      borderWidth: 1.5,
      borderWidthSelected: 3,
      margin: 12,
      isController: isRoot,
    });
    for (const c of n.internalFiles) {
      const key = `${c.relPath}->${n.relPath}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({
          from: c.relPath,
          to: n.relPath,
          color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' },
          width: 1.5,
          selectionWidth: 2,
          smooth: false,
        });
      }
      add(c, false);
    }
  }
  add(root, true);

  const rootId = root.relPath;
  nodes.unshift({
    id: routeName,
    label: routeName,
    title: `Import root: ${rootId}`,
    color: { background: '#43A047', border: '#2E7D32', highlight: { background: '#66BB6A', border: '#FFC107' }, hover: { background: '#66BB6A', border: '#FFC107' } },
    font: { color: '#ffffff', size: 16, face: 'Inter, -apple-system, sans-serif' },
    shape: 'hexagon',
    size: 36,
    borderWidth: 1.5,
    borderWidthSelected: 3,
    margin: 10,
  });
  edges.unshift({
    from: rootId,
    to: routeName,
    color: { color: 'rgba(255,255,255,0.3)', highlight: '#FFC107', hover: '#FFC107' },
    width: 2,
    selectionWidth: 2,
    smooth: false,
  });

  return {
    nodes,
    edges,
    methodDeps: {},
    controllerMethods: {},
    defaultMethodId: null,
    controllerId: rootId,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const llmIdx = args.indexOf('--llm');
  const useLlm = llmIdx >= 0;
  if (useLlm) args.splice(llmIdx, 1);
  const outIdx = args.indexOf('--out');
  let outPath: string | undefined;
  if (outIdx >= 0 && args[outIdx + 1]) {
    outPath = args[outIdx + 1];
    args.splice(outIdx, 2);
  }
  const fileArg = args[0];

  if (!fileArg) {
    console.error('Usage: npx ts-node build-file-graph.ts <file-path> [--llm] [--out <path>]');
    process.exit(1);
  }

  const absPath = path.isAbsolute(fileArg) ? fileArg : path.join(PROJECT_ROOT, fileArg);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    console.error(`File not found: ${fileArg}`);
    process.exit(1);
  }

  const relPath = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, '/');
  console.log('\n=== Build Import Graph ===\n');
  console.log(`Entry: ${relPath}`);
  console.log(`LLM: ${useLlm ? 'ON (Ollama)' : 'OFF'}\n`);

  totalFiles = countFiles(absPath, PROJECT_ROOT, new Set());
  processedCount = 0;

  if (useLlm) {
    console.log(`Found ${totalFiles} file(s). Tracing with Ollama...\n`);
  }

  const root = await buildNode(absPath, PROJECT_ROOT, new Set(), useLlm);
  if (useLlm) console.log(''); // newline after progress

  const routeName = `Import: ${relPath}`;
  const snapshot = toGraphSnapshot(root, routeName);
  const output = {
    graphSnapshots: { [routeName]: snapshot },
    routeNames: [routeName],
  };

  const writePath = outPath ?? path.join(PROJECT_ROOT, 'visualizer', 'file_graph_output.json');
  const writeDir = path.dirname(writePath);
  if (!fs.existsSync(writeDir)) fs.mkdirSync(writeDir, { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`\n✅ Done! ${totalFiles} file(s). Output: ${writePath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
