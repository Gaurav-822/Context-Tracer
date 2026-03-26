/**
 * Detects which imports are actually used in a file.
 * Uses TypeScript's lightweight parser (createSourceFile) - no full program/type-checker.
 * Falls back to regex when parsing fails (e.g. syntax errors, non-TS files).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const IMPORT_MAP_REGEX = /import\s+(?:(?:(\w+)|{([^}]*)})\s+from|(\w+)\s*=\s*require)\s*["'`]([^"'`]+)["'`]/g;
const REQUIRE_REGEX = /(?:const|var|let)\s+(\w+)\s*=\s*require\s*\(['"`]([^'"`]+)['"`]\)/g;

function extractImportMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  let m;
  IMPORT_MAP_REGEX.lastIndex = 0;
  while ((m = IMPORT_MAP_REGEX.exec(content)) !== null) {
    const spec = m[4];
    if (m[1]) map.set(m[1], spec);
    else if (m[2]) {
      for (const part of m[2].split(',')) {
        const trimmed = part.trim();
        if (!trimmed || trimmed.startsWith('type ')) continue;
        const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
        const localName = asMatch ? asMatch[2] : trimmed.split(/\s+/)[0];
        if (localName) map.set(localName, spec);
      }
    } else if (m[3]) map.set(m[3], spec);
  }
  REQUIRE_REGEX.lastIndex = 0;
  while ((m = REQUIRE_REGEX.exec(content)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

function stripImportExportStatements(content: string): string {
  return content
    .replace(/import\s+[\s\S]*?from\s+['"`][^'"`]+['"`]\s*;?\s*/g, '')
    .replace(/import\s+['"`][^'"`]+['"`]\s*;?\s*/g, '')
    .replace(/export\s+[\s\S]*?from\s+['"`][^'"`]+['"`]\s*;?\s*/g, '')
    .replace(/(?:const|var|let)\s+\w+\s*=\s*require\s*\(['"`][^'"`]+['"`]\)\s*;?\s*/g, '');
}

function getIdentifiersUsedInCode(code: string, importMap: Map<string, string>): Set<string> {
  const used = new Set<string>();
  for (const [ident] of importMap) {
    const re = new RegExp(`\\b${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(code)) used.add(ident);
  }
  return used;
}

/** Regex-based fallback when AST parsing fails. */
function getUsedSpecsRegex(
  content: string,
  filter: (spec: string) => boolean
): Set<string> {
  const codeWithoutImports = stripImportExportStatements(content);
  const importMap = extractImportMap(content);
  const usedIdents = getIdentifiersUsedInCode(codeWithoutImports, importMap);
  const usedSpecs = new Set<string>();
  for (const ident of usedIdents) {
    const spec = importMap.get(ident);
    if (spec && filter(spec)) usedSpecs.add(spec);
  }
  return usedSpecs;
}

/** Collect all identifier names used in the AST, excluding import declarations. */
function collectUsedIdentifiers(sourceFile: ts.SourceFile): Set<string> {
  const used = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) return; // skip entire import - its ids are declarations, not uses
    if (ts.isImportClause(node)) return; // part of import
    if (ts.isImportSpecifier(node)) return;
    if (ts.isNamespaceImport(node)) return;

    if (ts.isIdentifier(node)) {
      used.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return used;
}

/** Extract import specs and their local identifiers from the AST. */
function getImportSpecsFromAst(sourceFile: ts.SourceFile): Array<{ spec: string; idents: string[] }> {
  const result: Array<{ spec: string; idents: string[] }> = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const specStr = spec.text;

    const clause = stmt.importClause;
    if (!clause) continue; // side-effect import, no bindings

    const idents: string[] = [];

    if (clause.name) idents.push(clause.name.text);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        idents.push(clause.namedBindings.name.text);
      } else if (ts.isNamedImports(clause.namedBindings)) {
        for (const elem of clause.namedBindings.elements) {
          idents.push(elem.name.text);
        }
      }
    }

    if (idents.length > 0) result.push({ spec: specStr, idents });
  }

  return result;
}

/** Fast AST-based detection: parse only, no type checker. */
function getUsedSpecsFromAst(
  content: string,
  filter: (spec: string) => boolean,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TS
): Set<string> | null {
  try {
    const sourceFile = ts.createSourceFile(
      'file.ts',
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    );

    const used = collectUsedIdentifiers(sourceFile);
    const importSpecs = getImportSpecsFromAst(sourceFile);
    const result = new Set<string>();

    for (const { spec, idents } of importSpecs) {
      if (!filter(spec)) continue;
      for (const id of idents) {
        if (used.has(id)) {
          result.add(spec);
          break;
        }
      }
    }
    return result;
  } catch {
    return null;
  }
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.js') return ts.ScriptKind.JS;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Add require() specs that are used (AST only handles import syntax). */
function mergeRequireUsed(content: string, result: Set<string>, filter: (s: string) => boolean): void {
  const requireMap = new Map<string, string>();
  let m;
  REQUIRE_REGEX.lastIndex = 0;
  while ((m = REQUIRE_REGEX.exec(content)) !== null) {
    requireMap.set(m[1], m[2]);
  }
  if (requireMap.size === 0) return;
  const codeWithoutImports = stripImportExportStatements(content);
  const usedIdents = getIdentifiersUsedInCode(codeWithoutImports, requireMap);
  for (const ident of usedIdents) {
    const spec = requireMap.get(ident);
    if (spec && filter(spec)) result.add(spec);
  }
}

/** Return local import specs (./ or /) that are actually used in the file. */
export function getUsedLocalImportSpecs(filePath: string): Set<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const filter = (s: string) => s.startsWith('.') || s.startsWith('/');
    const astResult = getUsedSpecsFromAst(content, filter, getScriptKind(filePath));
    if (astResult !== null) {
      mergeRequireUsed(content, astResult, filter);
      return astResult;
    }
    return getUsedSpecsRegex(content, filter);
  } catch {
    return new Set();
  }
}

/** Return package import specs that are actually used in the file. */
export function getUsedPackageSpecs(filePath: string): Set<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const filter = (s: string) => !s.startsWith('.') && !s.startsWith('/');
    const astResult = getUsedSpecsFromAst(content, filter, getScriptKind(filePath));
    if (astResult !== null) {
      mergeRequireUsed(content, astResult, filter);
      return astResult;
    }
    return getUsedSpecsRegex(content, filter);
  } catch {
    return new Set();
  }
}
