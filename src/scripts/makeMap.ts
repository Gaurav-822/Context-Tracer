/**
 * API dependency graph mapper.
 * Discovers APIs via list-routes-search, analyzes each handler, and outputs:
 * "What does this file do -> Dependencies" (packages + internal files).
 *
 * Run: ts-node scripts/makeMap.ts
 * Requires: Ollama running with qwen2.5:1.5b
 * Uses num_gpu to prefer GPU acceleration when available (fallback: CPU).
 *
 * Caches LLM summaries in scripts/llm_summary_cache.json so previously
 * processed files are not sent to Ollama again (cache invalidates on file change).
 */

import * as fs from 'fs';
import * as path from 'path';
import { discoverRoutes, RouteEntry } from './list-routes-search';
import { getUsedLocalImportSpecs, getUsedPackageSpecs } from '../usedImports';

const PROJECT_ROOT = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : path.resolve(__dirname, '..');

const USE_LLM = process.argv.includes('--llm');

const IMPORT_REGEX = /(?:import\s+(?:(\w+)|{[^}]*?(\w+)[^}]*?})\s+from\s+|(?:const|var|let)\s+(\w+)\s*=\s*require\s*\()\s*["'`]([^"'`]+)["'`]/g;

function resolveModule(importPath: string, fromDir: string): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
  const base = path.resolve(fromDir, importPath);
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '']) {
    const p = ext ? (base.endsWith(ext) ? base : base + ext) : base;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    const idx = path.join(p, `index${ext || '.ts'}`);
    if (fs.existsSync(idx)) return idx;
  }
  return fs.existsSync(base + '.ts') ? base + '.ts' : fs.existsSync(base + '.js') ? base + '.js' : null;
}

function extractImports(content: string): Map<string, string> {
  const map = new Map<string, string>();
  let m;
  IMPORT_REGEX.lastIndex = 0;
  while ((m = IMPORT_REGEX.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3];
    const spec = m[4];
    if (name && spec) map.set(name, spec);
  }
  return map;
}

function extractImportMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const importRegex = /import\s+(?:(?:(\w+)|{([^}]*)})\s+from|(\w+)\s*=\s*require)\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = importRegex.exec(content)) !== null) {
    const spec = m[4];
    if (m[1]) map.set(m[1], spec);
    else if (m[2]) {
      for (const part of m[2].split(',')) {
        const asMatch = part.trim().match(/^(\w+)\s+as\s+(\w+)$/);
        const localName = asMatch ? asMatch[2] : part.trim().split(/\s+/)[0];
        if (localName) map.set(localName, spec);
      }
    } else if (m[3]) map.set(m[3], spec);
  }
  const requireRegex = /(?:const|var|let)\s+(\w+)\s*=\s*require\s*\(['"`]([^'"`]+)['"`]\)/g;
  while ((m = requireRegex.exec(content)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

function extractMethodsFromController(content: string): Array<{ name: string; body: string }> {
  const methods: Array<{ name: string; body: string }> = [];
  const seen = new Set<string>();

  const classMethodRegex = /(?:^\s*(?:static\s+|async\s+|private\s+|public\s+)*)(\w+)\s*(?:=\s*async\s*)?\s*\([^)]*\)\s*(?::\s*[^{]+?)?\s*\{/gm;
  const objectMethodRegex = /(?:^\s*)(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/gm;

  function extractBody(openBraceIdx: number): string {
    let depth = 1;
    let i = openBraceIdx + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    return content.slice(openBraceIdx + 1, i - 1);
  }

  for (const regex of [classMethodRegex, objectMethodRegex]) {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (['constructor', 'if', 'for', 'while', 'switch'].includes(name) || seen.has(name)) continue;
      seen.add(name);
      const openBraceIdx = match.index + match[0].length - 1;
      const body = extractBody(openBraceIdx);
      methods.push({ name, body });
    }
  }
  return methods;
}

function getIdentifiersUsedInCode(code: string, importMap: Map<string, string>): Set<string> {
  const used = new Set<string>();
  for (const [ident] of importMap) {
    const re = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(code)) used.add(ident);
  }
  return used;
}

interface ResolvedHandler {
  handlerFile: string;
  methodName: string | null;
}

function resolveHandlerInfo(route: RouteEntry): ResolvedHandler | null {
  const content = fs.readFileSync(route.sourceAbsolute, 'utf-8');
  const imports = extractImports(content);
  const dir = path.dirname(route.sourceAbsolute);
  const escapedPath = route.pathInSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const method = route.method.toLowerCase();
  const routeRegex = new RegExp(
    `\\.${method}\\s*\\(\\s*["'\`]${escapedPath}["'\`]\\s*,\\s*([\\s\\S]*?)\\n?\\)\\s*[,;]`,
    'i'
  );
  const match = content.match(routeRegex);
  if (!match) return null;
  const argsStr = match[1];
  const idents = argsStr.match(/[a-zA-Z_$][a-zA-Z0-9_$.]*/g);
  if (!idents || idents.length === 0) return null;
  const lastIdent = idents[idents.length - 1];
  const methodName = lastIdent.includes('.') ? lastIdent.split('.')[1] : null;
  const handlerId = lastIdent.includes('.') ? lastIdent.split('.')[0] : lastIdent;
  const spec = imports.get(handlerId);
  if (!spec || !spec.startsWith('.')) return null;
  const handlerFile = resolveModule(spec, dir);
  if (!handlerFile) return null;
  return { handlerFile, methodName };
}

// --- Ollama & dependency graph ---
const summaryCache = new Map<string, string>();
const CACHE_FILE = path.resolve(__dirname, 'llm_summary_cache.json');

interface PersistedCacheEntry {
  summary: string;
  mtime: number;
}

function loadPersistedCache(): Map<string, PersistedCacheEntry> {
  const cache = new Map<string, PersistedCacheEntry>();
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, PersistedCacheEntry>;
      for (const [k, v] of Object.entries(obj)) {
        if (v?.summary != null && typeof v.mtime === 'number') cache.set(k, v);
      }
    }
  } catch (_) {}
  return cache;
}

function saveToPersistedCache(key: string, summary: string, mtime: number) {
  try {
    const cache = loadPersistedCache();
    cache.set(key, { summary, mtime });
    const obj: Record<string, PersistedCacheEntry> = {};
    cache.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (_) {}
}

const persistedCache = loadPersistedCache();
if (persistedCache.size > 0) {
  console.log(`Loaded ${persistedCache.size} cached LLM summary(ies) from ${path.basename(CACHE_FILE)}\n`);
}

const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
let hasLoggedConnectionError = false;

interface OllamaGenerateResponse {
  response?: string;
}

async function checkOllamaConnection(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function getFileSummary(filePath: string, fileName: string): Promise<string> {
  const absPath = path.resolve(filePath);
  if (summaryCache.has(absPath)) return summaryCache.get(absPath)!;

  if (!USE_LLM) {
    const summary = `Module: ${fileName}`;
    summaryCache.set(absPath, summary);
    return summary;
  }

  const cacheKey = path.relative(PROJECT_ROOT, absPath);
  const cached = persistedCache.get(cacheKey);
  if (cached) {
    try {
      const stat = fs.statSync(absPath, { throwIfNoEntry: false });
      if (stat && Math.floor(stat.mtimeMs) === cached.mtime) {
        summaryCache.set(absPath, cached.summary);
        return cached.summary;
      }
    } catch (_) {}
  }

  console.log(`Asking Ollama to summarize: ${fileName}...`);
  try {
    const fullContent = fs.readFileSync(absPath, 'utf-8');
    const stat = fs.statSync(absPath, { throwIfNoEntry: false });
    const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
    const truncatedCode = fullContent.split('\n').slice(0, 150).join('\n');
    const prompt = `You are an expert developer. Read the following code and explain its primary purpose. Be extremely concise. Keep your response to a maximum of 3 short sentences. Do not use introductory filler like 'This file is...'. State the functionality directly.\n\nCode:\n${truncatedCode}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b',
        prompt,
        stream: false,
        options: { num_gpu: 99 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as OllamaGenerateResponse;
    const summary = (data?.response ?? '').trim().replace(/\n/g, ' ') || 'No summary generated.';
    summaryCache.set(absPath, summary);
    saveToPersistedCache(cacheKey, summary, mtime);
    return summary;
  } catch (err: any) {
    if (!hasLoggedConnectionError) {
      hasLoggedConnectionError = true;
      const cause = err?.cause?.code || err?.code || err?.message;
      console.error(`\nOllama connection failed. Error: ${cause}\n`);
    }
    return 'Error generating summary.';
  }
}

async function getMethodSummary(filePath: string, methodName: string, methodBody: string): Promise<string> {
  const absPath = path.resolve(filePath);
  const cacheKey = `${path.relative(PROJECT_ROOT, absPath)}::${methodName}`;
  const inMemoryKey = cacheKey;

  if (summaryCache.has(inMemoryKey)) return summaryCache.get(inMemoryKey)!;

  if (!USE_LLM) {
    const summary = `Handler: ${methodName}`;
    summaryCache.set(inMemoryKey, summary);
    return summary;
  }

  const cached = persistedCache.get(cacheKey);
  if (cached) {
    try {
      const stat = fs.statSync(absPath, { throwIfNoEntry: false });
      if (stat && Math.floor(stat.mtimeMs) === cached.mtime) {
        summaryCache.set(inMemoryKey, cached.summary);
        return cached.summary;
      }
    } catch (_) {}
  }

  console.log(`Asking Ollama to summarize method: ${path.basename(filePath)}.${methodName}...`);
  try {
    const stat = fs.statSync(absPath, { throwIfNoEntry: false });
    const mtime = stat ? Math.floor(stat.mtimeMs) : 0;
    const truncatedBody = methodBody.split('\n').slice(0, 80).join('\n');
    const prompt = `You are an expert developer. Read this single method and explain what it does in one short sentence. Be direct. No filler.\n\nMethod:\n${truncatedBody}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    const response = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b',
        prompt,
        stream: false,
        options: { num_gpu: 99 },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as OllamaGenerateResponse;
    const summary = (data?.response ?? '').trim().replace(/\n/g, ' ') || 'No summary generated.';
    summaryCache.set(inMemoryKey, summary);
    saveToPersistedCache(cacheKey, summary, mtime);
    return summary;
  } catch (err: any) {
    if (!hasLoggedConnectionError) {
      hasLoggedConnectionError = true;
      const cause = err?.cause?.code || err?.code || err?.message;
      console.error(`\nOllama connection failed. Error: ${cause}\n`);
    }
    return 'Error generating summary.';
  }
}

function extractImportsFromFile(filePath: string): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const importRegex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
    const imports: string[] = [];
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (importPath) imports.push(importPath);
    }
    return imports;
  } catch {
    return [];
  }
}

function resolveLocalFilePath(baseDir: string, importPath: string): string | null {
  const fullPath = path.join(baseDir, importPath);
  const extensions = ['.ts', '.tsx', '.js', '/index.ts', '/index.js'];
  for (const ext of extensions) if (fs.existsSync(fullPath + ext)) return fullPath + ext;
  if (fs.existsSync(fullPath)) return fullPath;
  return null;
}

interface GraphNode {
  fileName: string;
  whatDoesThisFileDo: string;
  dependencies: {
    packages: string[];
    internalFiles: GraphNode[];
  };
  isCircular?: boolean;
}

interface ControllerMethod {
  name: string;
  summary: string;
  usedByRoutes?: string[];
  dependencies: {
    packages: string[];
    internalFiles: GraphNode[];
  };
}

interface ControllerGraphNode extends Omit<GraphNode, 'dependencies'> {
  methods: ControllerMethod[];
  dependencies: GraphNode['dependencies'];
}

async function buildDependencyGraph(filePath: string, visitedFiles: Set<string>): Promise<GraphNode> {
  const relName = path.relative(PROJECT_ROOT, filePath);
  const fileDir = path.dirname(filePath);

  if (visitedFiles.has(filePath)) {
    return { fileName: relName, whatDoesThisFileDo: '(circular)', dependencies: { packages: [], internalFiles: [] }, isCircular: true };
  }
  visitedFiles.add(filePath);

  const whatDoesThisFileDo = await getFileSummary(filePath, path.basename(filePath));
  const usedLocalSpecs = getUsedLocalImportSpecs(filePath);
  const usedPackages = getUsedPackageSpecs(filePath);
  const packages = Array.from(usedPackages);
  const internalFiles: GraphNode[] = [];

  for (const importPath of usedLocalSpecs) {
    const resolvedPath = resolveLocalFilePath(fileDir, importPath);
    if (resolvedPath) {
      internalFiles.push(await buildDependencyGraph(resolvedPath, visitedFiles));
    } else {
      internalFiles.push({
        fileName: importPath + ' (Not Found)',
        whatDoesThisFileDo: 'File not found.',
        dependencies: { packages: [], internalFiles: [] },
      });
    }
  }

  return {
    fileName: relName,
    whatDoesThisFileDo,
    dependencies: {
      packages,
      internalFiles,
    },
  };
}

async function buildControllerGraph(
  filePath: string,
  routeMethodMap: Map<string, string[]>,
  visitedFiles: Set<string>,
): Promise<ControllerGraphNode> {
  const relName = path.relative(PROJECT_ROOT, filePath);
  const fileDir = path.dirname(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const importMap = extractImportMap(content);
  const methods = extractMethodsFromController(content);
  const whatDoesThisFileDo = await getFileSummary(filePath, path.basename(filePath));

  const controllerMethods: ControllerMethod[] = [];

  for (const { name, body } of methods) {
    const usedIdents = getIdentifiersUsedInCode(body, importMap);
    const packages = new Set<string>();
    const internalFiles: GraphNode[] = [];

    for (const ident of usedIdents) {
      const spec = importMap.get(ident);
      if (!spec) continue;
      if (spec.startsWith('.')) {
        const resolvedPath = resolveLocalFilePath(fileDir, spec);
        if (resolvedPath) {
          const node = await buildDependencyGraphForPath(resolvedPath, visitedFiles);
          if (!internalFiles.some((n) => n.fileName === node.fileName)) {
            internalFiles.push(node);
          }
        }
      } else {
        packages.add(spec);
      }
    }

    const summary = await getMethodSummary(filePath, name, body);
    const usedByRoutes = routeMethodMap.get(name) ?? [];

    controllerMethods.push({
      name,
      summary,
      usedByRoutes: usedByRoutes.length > 0 ? usedByRoutes : undefined,
      dependencies: {
        packages: Array.from(packages),
        internalFiles,
      },
    });
  }

  const usedLocalSpecs = getUsedLocalImportSpecs(filePath);
  const usedPackages = getUsedPackageSpecs(filePath);
  const allPackages = Array.from(usedPackages);
  const allInternalFiles: GraphNode[] = [];
  for (const importPath of usedLocalSpecs) {
    const resolvedPath = resolveLocalFilePath(fileDir, importPath);
    if (resolvedPath) {
      allInternalFiles.push(await buildDependencyGraphForPath(resolvedPath, visitedFiles));
    }
  }

  return {
    fileName: relName,
    whatDoesThisFileDo,
    methods: controllerMethods,
    dependencies: {
      packages: Array.from(allPackages),
      internalFiles: allInternalFiles,
    },
  };
}

async function buildDependencyGraphForPath(filePath: string, visitedFiles: Set<string>): Promise<GraphNode> {
  const visited = new Set(visitedFiles);
  return buildDependencyGraph(filePath, visited);
}

async function run() {
  console.log('\n=== API MAPPER (Graph: What does this file do -> Dependencies + Controller Methods) ===\n');

  const routes = discoverRoutes();
  if (routes.length === 0) {
    console.error('No routes discovered.');
    process.exit(1);
  }

  // Include every route: resolved controller handler OR inline handler (use route source file as entry)
  const routesToMap: Array<{ route: RouteEntry; handler: ResolvedHandler | null }> = [];
  for (const r of routes) {
    const handler = resolveHandlerInfo(r);
    if (handler && fs.existsSync(handler.handlerFile)) {
      routesToMap.push({ route: r, handler });
    } else {
      // Inline handler: route is defined in r.sourceAbsolute; use that file as dependency root
      routesToMap.push({ route: r, handler: null });
    }
  }
  if (routesToMap.length === 0) {
    console.error('No routes to map.');
    process.exit(1);
  }

  if (USE_LLM) {
    const ollamaOk = await checkOllamaConnection();
    if (!ollamaOk) {
      console.error('Cannot reach Ollama at', OLLAMA_BASE);
      console.error('   Run: ollama serve && ollama pull qwen2.5:1.5b');
      process.exit(1);
    }
    console.log('Ollama connected. Analyzing...\n');
  } else {
    console.log('Analyzing (no LLM)...\n');
  }

  const apis: Array<{
    apiRoute: string;
    apiUsage: string;
    entryFile: string;
    handlerMethod: string | null;
    dependencies: ControllerGraphNode | GraphNode;
  }> = [];

  const handlerFileToRoutes = new Map<string, Array<{ route: RouteEntry; methodName: string | null }>>();
  for (const { route, handler } of routesToMap) {
    const entryPath = handler ? handler.handlerFile : route.sourceAbsolute;
    const list = handlerFileToRoutes.get(entryPath) ?? [];
    list.push({ route, methodName: handler?.methodName ?? null });
    handlerFileToRoutes.set(entryPath, list);
  }

  const routeMethodMapByFile = new Map<string, Map<string, string[]>>();
  for (const [entryPath, list] of handlerFileToRoutes) {
    const methodToRoutes = new Map<string, string[]>();
    for (const { route, methodName } of list) {
      if (methodName) {
        const apiRoute = `${route.method} ${route.path}`;
        const arr = methodToRoutes.get(methodName) ?? [];
        arr.push(apiRoute);
        methodToRoutes.set(methodName, arr);
      }
    }
    routeMethodMapByFile.set(entryPath, methodToRoutes);
  }

  const processedControllers = new Map<string, ControllerGraphNode>();
  const processedInlineFiles = new Map<string, GraphNode>();

  for (const { route, handler } of routesToMap) {
    const apiRoute = `${route.method} ${route.path}`;
    const entryPath = handler ? handler.handlerFile : route.sourceAbsolute;
    const entrySource = path.relative(PROJECT_ROOT, entryPath);
    const isInline = handler === null;

    console.log(`API ${apis.length + 1}: ${apiRoute}`);
    console.log(`   Route defined in: ${route.source}`);
    console.log(`   Handler: ${entrySource}${handler?.methodName ? ` (method: ${handler.methodName})` : isInline ? ' (inline)' : ''}\n`);

    let dependencies: ControllerGraphNode | GraphNode;

    if (isInline) {
      // Inline handler: build dependency graph from the route file itself (cache per file)
      if (processedInlineFiles.has(entryPath)) {
        dependencies = processedInlineFiles.get(entryPath)!;
      } else {
        const visitedFiles = new Set<string>();
        const graph = await buildDependencyGraph(entryPath, visitedFiles);
        processedInlineFiles.set(entryPath, graph);
        dependencies = graph;
      }
    } else if (processedControllers.has(entryPath)) {
      dependencies = processedControllers.get(entryPath)!;
    } else {
      const routeMethodMap = routeMethodMapByFile.get(entryPath) ?? new Map();
      const visitedFiles = new Set<string>();
      const content = fs.readFileSync(entryPath, 'utf-8');
      const methods = extractMethodsFromController(content);

      if (methods.length > 0) {
        const controllerNode = await buildControllerGraph(entryPath, routeMethodMap, visitedFiles);
        processedControllers.set(entryPath, controllerNode);
        dependencies = controllerNode;
      } else {
        dependencies = await buildDependencyGraph(entryPath, visitedFiles);
      }
    }

    apis.push({
      apiRoute,
      apiUsage: isInline ? `${apiRoute} -> ${entrySource}` : `${apiRoute} -> Controller (${entrySource})`,
      entryFile: path.basename(entryPath),
      handlerMethod: handler?.methodName ?? null,
      dependencies,
    });
  }

  const graphOutput = {
    title: 'Graph Struct for the APIs (with controller methods and per-method dependency maps)',
    apis,
  };

  const visualizerDir = path.join(PROJECT_ROOT, 'visualizer');
  if (!fs.existsSync(visualizerDir)) fs.mkdirSync(visualizerDir, { recursive: true });
  const outputPath = path.join(visualizerDir, 'api_graph_output.json');
  fs.writeFileSync(outputPath, JSON.stringify(graphOutput, null, 2), 'utf-8');

  console.log(`\nDone! Mapped ${apis.length} API(s). Output: ${outputPath}\n`);
}

run();
