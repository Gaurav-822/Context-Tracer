/**
 * Search-based route discovery for Express/MERN repos.
 * Uses regex/file search only - no ts-morph. Lightweight, fast, zero dependencies.
 */

import * as path from "path";
import * as fs from "fs";

const PROJECT_ROOT = process.env.PROJECT_ROOT ? path.resolve(process.env.PROJECT_ROOT) : path.resolve(__dirname, "..");
const EXCLUDE_DIRS = ["node_modules", "build", "dist", ".git", "coverage", "tmp", "vendor"];
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

export interface RouteEntry {
  method: string;
  path: string;
  pathInSource: string;
  source: string;
  sourceAbsolute: string;
}

const ROUTE_REGEX = /\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
const USE_REGEX = /\.use\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const CONFIG_REGEX = /{\s*path\s*:\s*["'`]([^"'`]+)["'`]\s*,\s*router\s*:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
const IMPORT_REGEX = /(?:import\s+(?:(\w+)|{[^}]*?(\w+)[^}]*?})\s+from\s+|(?:const|var|let)\s+(\w+)\s*=\s*require\s*\()\s*["'`]([^"'`]+)["'`]/g;

function normalizePath(base: string, route: string): string {
  const b = base.endsWith("/") && base !== "/" ? base.slice(0, -1) : base;
  const r = route.startsWith("/") ? route : `/${route}`;
  return (b === "" || b === "/" ? r : `${b}${r}`).replace(/\/+/g, "/");
}

function resolveModule(importPath: string, fromDir: string): string | null {
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;
  const base = path.resolve(fromDir, importPath);
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ""]) {
    const p = ext ? (base.endsWith(ext) ? base : base + ext) : base;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    const idx = path.join(p, `index${ext || ".ts"}`);
    if (fs.existsSync(idx)) return idx;
  }
  return fs.existsSync(base + ".ts") ? base + ".ts" : fs.existsSync(base + ".js") ? base + ".js" : null;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDE_DIRS.includes(e.name)) walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
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

function extractRoutesFromContent(
  content: string,
  basePath: string,
  sourceRel: string,
  sourceAbsolute: string
): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const stripped = content.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ROUTE_REGEX.lastIndex = 0;
  let match;
  while ((match = ROUTE_REGEX.exec(stripped)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    routes.push({
      method,
      path: normalizePath(basePath, routePath),
      pathInSource: routePath,
      source: sourceRel,
      sourceAbsolute,
    });
  }
  return routes;
}

export function discoverRoutes(): RouteEntry[] {
  const srcDirs = [
    path.join(PROJECT_ROOT, "src"),
    path.join(PROJECT_ROOT, "server"),
    path.join(PROJECT_ROOT),
  ].filter((d) => fs.existsSync(d));

  const allFiles = [...new Set(srcDirs.flatMap((d) => collectFiles(d)))];
  const fileContents = new Map<string, string>();
  for (const f of allFiles) {
    try {
      fileContents.set(f, fs.readFileSync(f, "utf-8"));
    } catch (_) {}
  }

  const allRoutes: RouteEntry[] = [];
  const basePathByFile = new Map<string, string>();

  for (const file of allFiles) {
    const content = fileContents.get(file)!;
    const imports = extractImports(content);
    const dir = path.dirname(file);
    const isInternal = /internalRoutes|internal\s*routes/i.test(content);
    const prefix = isInternal ? "/internal" : "";
    let m;
    CONFIG_REGEX.lastIndex = 0;
    while ((m = CONFIG_REGEX.exec(content)) !== null) {
      const routeBase = normalizePath(prefix, m[1]);
      const routerId = m[2];
      const spec = imports.get(routerId);
      if (spec) {
        const resolved = resolveModule(spec, dir);
        if (resolved && !resolved.includes("node_modules")) {
          basePathByFile.set(resolved, routeBase);
        }
      }
    }
  }

  const mountQueue: Array<{ file: string; basePath: string }> = [];

  const entryCandidates = ["server.ts", "server.js", "index.ts", "index.js", "app.ts", "app.js"];
  for (const base of srcDirs) {
    for (const name of entryCandidates) {
      const p = path.join(base, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) mountQueue.push({ file: p, basePath: "" });
    }
  }

  const pkgPath = path.join(PROJECT_ROOT, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const main = pkg.main;
      if (main) {
        const full = path.join(PROJECT_ROOT, main);
        if (fs.existsSync(full)) mountQueue.push({ file: full, basePath: "" });
      }
    } catch (_) {}
  }

  const processed = new Set<string>();

  function processFile(filePath: string, basePath: string) {
    const key = `${filePath}:${basePath}`;
    if (processed.has(key)) return;
    processed.add(key);

    const content = fileContents.get(filePath);
    if (!content) return;

    const rel = path.relative(PROJECT_ROOT, filePath);
    const imports = extractImports(content);
    const dir = path.dirname(filePath);

    allRoutes.push(...extractRoutesFromContent(content, basePath, rel, filePath));

    if (basePath === "") {
      if (/(?:app|server|this\.server)\.(get|post)\s*\(\s*["'`]\//.test(content)) {
        const direct = extractRoutesFromContent(content, "", rel, filePath);
        for (const r of direct) {
          if (!allRoutes.some((x) => x.method === r.method && x.path === r.path)) allRoutes.push(r);
        }
      }
      if (/\.use\s*\(\s*["'`]\/swagger["'`]/.test(content)) {
        allRoutes.push({
          method: "GET", path: "/swagger", pathInSource: "/swagger", source: rel, sourceAbsolute: filePath,
        });
        allRoutes.push({
          method: "GET", path: "/swagger/", pathInSource: "/swagger/", source: rel, sourceAbsolute: filePath,
        });
      }
      if (/metricsApp\.get\s*\(\s*["'`]\/metrics["'`]/.test(content)) {
        allRoutes.push({
          method: "GET", path: "/metrics", pathInSource: "/metrics", source: rel, sourceAbsolute: filePath,
        });
      }
    }

    USE_REGEX.lastIndex = 0;
    let useMatch;
    while ((useMatch = USE_REGEX.exec(content)) !== null) {
      const subPath = useMatch[1];
      const routerId = useMatch[2];
      const spec = imports.get(routerId);
      if (spec && (spec.startsWith(".") || spec.startsWith("/"))) {
        const resolved = resolveModule(spec, dir);
        if (resolved && !resolved.includes("node_modules")) {
          const newBase = normalizePath(basePath, subPath);
          const ctx = content.slice(Math.max(0, useMatch.index - 60), useMatch.index + 60);
          if (!/(swaggerUi|swagger\.|helmet|cors|express\.json|errorHandler)/.test(ctx)) {
            processFile(resolved, newBase);
          }
        }
      }
    }
  }

  for (const [file, base] of basePathByFile) {
    const abs = path.resolve(file);
    if (allFiles.includes(abs) || fs.existsSync(abs)) {
      if (!fileContents.has(abs)) {
        try { fileContents.set(abs, fs.readFileSync(abs, "utf-8")); } catch (_) {}
      }
      processFile(abs, base);
    }
  }

  for (const { file, basePath } of mountQueue) {
    const abs = path.resolve(file);
    if (fs.existsSync(abs)) {
      if (!fileContents.has(abs)) {
        try { fileContents.set(abs, fs.readFileSync(abs, "utf-8")); } catch (_) {}
      }
      processFile(abs, basePath);
    }
  }

  const seen = new Set<string>();
  const unique = allRoutes.filter((r) => {
    const k = `${r.method}:${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  unique.sort((a, b) => (a.path !== b.path ? a.path.localeCompare(b.path) : a.method.localeCompare(b.method)));

  return unique;
}

function main() {
  const routes = discoverRoutes();
  console.log("\n=== All Routes (search-based) ===\n");
  console.log(`${"METHOD".padEnd(8)} ${"PATH".padEnd(58)} SOURCE`);
  console.log("-".repeat(120));
  for (const r of routes) {
    console.log(`${r.method.padEnd(8)} ${r.path.padEnd(58)} ${r.source}`);
  }
  console.log("\n" + "-".repeat(120));
  console.log(`Total: ${routes.length} routes\n`);
}

if (require.main === module) {
  main();
}
