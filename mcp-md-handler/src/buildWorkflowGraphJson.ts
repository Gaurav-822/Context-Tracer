import * as path from 'node:path';

/** Same as import-graph file nodes (fileGraphBuilder) — "File dependency" in the map legend. */
const FILE_DEP_NODE: { bg: string; border: string } = { bg: '#1E88E5', border: '#0D47A1' };

const EDGE_COLOR = { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' };

export function slugifyForFilename(s: string): string {
  const t = s
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return t || 'flow';
}

export type WorkflowStepIn = { id: string; label: string; detail?: string };
export type WorkflowEdgeIn = { from: string; to: string };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Coerce many LLM/JSON forms into a step list. Models often pass a **single** step object, or
 * a map of index → step, instead of a JSON **array** — which otherwise collapses to one node.
 */
export function coerceWorkflowStepsInput(raw: unknown): unknown[] {
  if (raw == null) {
    throw new Error('`steps` is required: use a JSON array of { "id", "label", "detail?" }.');
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error('`steps` array must be non-empty.');
    }
    return raw;
  }
  if (isPlainObject(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      throw new Error('`steps` object must be non-empty.');
    }
    const allNumericStringKeys = keys.every((k) => /^(0|[1-9]\d*)$/.test(k));
    if (allNumericStringKeys) {
      return [...keys]
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => (raw as Record<string, unknown>)[k]);
    }
    if ('id' in raw || 'label' in raw) {
      return [raw];
    }
    // Named keys like s1, s2 — preserve insertion order, common for hand-authored maps
    return keys.map((k) => (raw as Record<string, unknown>)[k]);
  }
  throw new Error('`steps` must be a JSON array of step objects, or a single step object, or a map of index → step.');
}

export type FileFlowStepIn = {
  /** 1-based step order in the flow; items are sorted by this before building edges. */
  order: number;
  fileName: string;
  filePath: string;
  role: string;
};

/**
 * Coerce `files` the same way as `steps` (array, index map, or single object).
 */
export function coerceFileFlowInput(raw: unknown): unknown[] {
  if (raw == null) {
    throw new Error(
      '`files` is required: use a JSON array of { order?, fileName, filePath, role }. (Unlike write_workflow_graph `id`, the step index goes in `order` and the repo path in `filePath`.)'
    );
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error('`files` array must be non-empty.');
    }
    return raw.map((item, i) => {
      if (isPlainObject(item) && (item as Record<string, unknown>).order == null) {
        return { ...item, order: i + 1 };
      }
      return item;
    });
  }
  if (isPlainObject(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      throw new Error('`files` object must be non-empty.');
    }
    const allNumericStringKeys = keys.every((k) => /^(0|[1-9]\d*)$/.test(k));
    if (allNumericStringKeys) {
      return [...keys]
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => {
          const v = (raw as Record<string, unknown>)[k];
          if (v && isPlainObject(v) && (v as Record<string, unknown>).order == null) {
            return { ...v, order: Number(k) + 1 };
          }
          return v;
        });
    }
    if ('fileName' in raw || 'filePath' in raw || 'role' in raw) {
      const o = raw as Record<string, unknown>;
      return [o.order == null ? { ...o, order: 1 } : o];
    }
    return keys.map((k) => (raw as Record<string, unknown>)[k]);
  }
  throw new Error('`files` must be a JSON array of file objects, or one object, or a map of index → file.');
}

/**
 * `node.id` in the map is the value sent on double‑click to open the file; it must be a
 * **workspace‑relative** path (POSIX), same as import graphs, e.g. `src/routes/index.ts`.
 */
export function normalizeRepoRelativeFilePath(workspaceRoot: string, filePath: string, fileName: string): string {
  const root = path.resolve(workspaceRoot);
  let p = String(filePath ?? '').trim();
  if (!p) p = String(fileName ?? '').trim();
  p = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) {
    throw new Error(
      'filePath (or fileName) is required. Use the path from the workspace root, e.g. src/routes/index.ts — not a short fragment that omits the src/ (or other) parent folder.'
    );
  }
  if (/^\d{1,6}$/.test(p) && !p.includes('.')) {
    throw new Error(
      `filePath was "${p}" (digits only). The map node id is this value and must be a file path, not a step number. Use the "order" field for sequence and filePath for the workspace‑relative file (e.g. src/api/handler.ts).`
    );
  }
  if (p.includes('..')) {
    throw new Error('filePath must not contain `..`');
  }
  let abs: string;
  if (path.isAbsolute(p) || /^[a-zA-Z]:\//.test(p) || (p.length >= 2 && p[1] === ':')) {
    abs = path.normalize(p);
  } else {
    abs = path.normalize(path.join(root, p));
  }
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || rel === '' || (rel !== '.' && rel.startsWith('/'))) {
    throw new Error(
      'filePath must resolve under the workspace root. Pass the full repo path from the root (e.g. src/middleware/auth.ts) so the map can open the file on double‑click; avoid values like "routes/x.ts" when the file lives under "src/".'
    );
  }
  return rel === '.' ? path.basename(abs).replace(/\\/g, '/') : rel;
}

/**
 * Turn the three fields into graph steps. `id` = repo‑relative file path (for double‑click open); `label` = short.
 */
export function fileFlowToWorkflowSteps(files: FileFlowStepIn[], workspaceRoot: string): WorkflowStepIn[] {
  return files.map((f) => {
    const fn = String(f.fileName ?? '').trim() || 'file';
    const role = String(f.role ?? '').trim();
    const id = normalizeRepoRelativeFilePath(workspaceRoot, f.filePath, fn);
    const baseFromName = path.basename(fn.replace(/\\/g, '/'));
    const baseFromId = path.basename(id);
    const label = (baseFromName || baseFromId).length > 300 ? (baseFromName || baseFromId).slice(0, 300) : baseFromName || baseFromId;
    const detailParts = [`File: ${id}`, role && `In this flow: ${role}`].filter(Boolean) as string[];
    const detail = detailParts.join('\n\n');
    return { id, label, detail };
  });
}

/**
 * The map view uses a node DataSet: duplicate `id` values would collapse to one node on screen.
 * Renames later duplicates: `1`, `1__2`, `1__3`, …
 */
export function ensureUniqueStepIds(steps: WorkflowStepIn[]): WorkflowStepIn[] {
  const used = new Set<string>();
  return steps.map((s, i) => {
    const base = (s.id != null && String(s.id).trim() !== '' ? String(s.id).trim() : null) || `step${i + 1}`;
    let id = base;
    if (!used.has(id)) {
      used.add(id);
      return { ...s, id };
    }
    let n = 2;
    let candidate = `${base}__${n}`;
    while (used.has(candidate)) {
      n += 1;
      candidate = `${base}__${n}`;
    }
    used.add(candidate);
    return { ...s, id: candidate };
  });
}

/**
 * For each pre-dedup id, ordered list of final node ids in step order (resolves which "1" an edge means).
 */
function buildOldIdToNewIdLists(raw: WorkflowStepIn[], out: WorkflowStepIn[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (let i = 0; i < raw.length; i += 1) {
    const base =
      (raw[i].id != null && String(raw[i].id).trim() !== '' ? String(raw[i].id).trim() : null) || `step${i + 1}`;
    if (!m.has(base)) m.set(base, []);
    m.get(base)!.push(out[i].id);
  }
  return m;
}

/**
 * If edge endpoints use the same old id for multiple steps, consume the next new id in order (same
 * cursors for `from` and `to` in one edge, then the next edge).
 */
function resolveEdgeEndpoint(
  p: string,
  lists: Map<string, string[]>,
  cursors: Map<string, number>,
  idSet: Set<string>
): string {
  const L = lists.get(p);
  if (L && L.length) {
    const c = cursors.get(p) ?? 0;
    if (c < L.length) {
      const n = L[c]!;
      cursors.set(p, c + 1);
      return n;
    }
  }
  if (idSet.has(p)) return p;
  throw new Error(`Edge references unknown id: ${p}`);
}

/**
 * Produces a JSON document compatible with the File Graph `GraphData` format
 * (single `Flow:` route, box nodes, directed edges).
 */
export function buildWorkflowGraphData(
  title: string,
  steps: WorkflowStepIn[],
  explicitEdges: WorkflowEdgeIn[] | undefined
): { graphData: Record<string, unknown>; routeName: string; relativePath: string; filename: string } {
  const routeName = `Flow: ${title.trim().slice(0, 200) || 'workflow'}`;

  const stepsUnique = ensureUniqueStepIds(steps);
  const idSet = new Set(stepsUnique.map((s) => s.id));
  if (idSet.size !== stepsUnique.length) {
    throw new Error('Each step id must be unique.');
  }
  const idLists = buildOldIdToNewIdLists(steps, stepsUnique);

  const nodes = stepsUnique.map((s, i) => {
    const c = FILE_DEP_NODE;
    const detail = s.detail?.trim() ? `${s.label}\n\n${s.detail}` : s.label;
    return {
      id: s.id,
      label: s.label,
      title: detail,
      importLevel: i,
      color: {
        background: c.bg,
        border: c.border,
        highlight: { background: '#42A5F5', border: '#FFC107' },
        hover: { background: '#42A5F5', border: '#FFC107' },
      },
      font: { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' },
      shape: 'box',
      size: 38,
      borderWidth: 1.5,
      borderWidthSelected: 3,
      margin: 12,
    };
  });

  let edges: { from: string; to: string; color: typeof EDGE_COLOR; width: number; selectionWidth: number; smooth: boolean }[];

  if (explicitEdges && explicitEdges.length > 0) {
    const cursors = new Map<string, number>();
    edges = explicitEdges.map((e) => {
      const from = resolveEdgeEndpoint(e.from, idLists, cursors, idSet);
      const to = resolveEdgeEndpoint(e.to, idLists, cursors, idSet);
      return {
        from,
        to,
        color: EDGE_COLOR,
        width: 1.5,
        selectionWidth: 2,
        smooth: false,
      };
    });
  } else {
    edges = [];
    for (let i = 0; i < stepsUnique.length - 1; i++) {
      edges.push({
        from: stepsUnique[i].id,
        to: stepsUnique[i + 1].id,
        color: EDGE_COLOR,
        width: 1.5,
        selectionWidth: 2,
        smooth: false,
      });
    }
  }

  const snapshot = {
    nodes,
    edges,
    methodDeps: {} as Record<string, string[]>,
    controllerMethods: {} as Record<string, { id: string; label: string }[]>,
    defaultMethodId: null,
    controllerId: null,
  };

  const graphData = {
    graphSnapshots: { [routeName]: snapshot },
    routeNames: [routeName],
  };

  const slug = slugifyForFilename(title);
  const filename = `backtracked_workflow_${slug}_${Date.now()}.json`;
  const relativePath = path.join('visualizer', 'backtracked', filename);

  return { graphData, routeName, relativePath, filename };
}
