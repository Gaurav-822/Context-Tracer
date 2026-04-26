/**
 * stdio MCP server: read allowlisted files under {EXPLORER_MAP_WORKSPACE_ROOT}/md, and
 * write File Graph–compatible flow JSON to visualizer/backtracked/ (Saved graphs).
 * Optional request file under visualizer/mcp/ asks the running extension to open Map View.
 * Keep MD_HANDLER_BASENAMES in sync with MD_FEATURE_FILES in the extension (src/extension.ts).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildWorkflowGraphData,
  coerceFileFlowInput,
  coerceWorkflowStepsInput,
  fileFlowToWorkflowSteps,
  type FileFlowStepIn,
} from './buildWorkflowGraphJson';
import { mcpOpenMapRelativePath, writeOpenMapRequest } from './mcpOpenMap';

/** Basenames only — same set as the Explorer Map "md handler" (see extension MD_FEATURE_FILES). */
const fileNameSchema = z.enum([
  'skills.md',
  'learnings.md',
  'architecture.md',
  'mistakes.md',
  'working.md',
]);

function resolveUnderMdDir(workspaceRoot: string, baseName: string): string {
  const mdDir = path.resolve(workspaceRoot, 'md');
  const full = path.resolve(mdDir, baseName);
  const prefix = mdDir + path.sep;
  if (full !== mdDir && !full.startsWith(prefix)) {
    throw new Error('Path escapes md directory');
  }
  if (path.basename(full) !== baseName) {
    throw new Error('Invalid file name');
  }
  return full;
}

const backtrackedDir = (root: string) => path.resolve(root, 'visualizer', 'backtracked');

function assertUnderBacktracked(workspaceRoot: string, absFilePath: string): void {
  const expected = backtrackedDir(workspaceRoot) + path.sep;
  const resolved = path.resolve(absFilePath);
  if (resolved !== backtrackedDir(workspaceRoot) && !resolved.startsWith(expected)) {
    throw new Error('Path escapes visualizer/backtracked');
  }
}

const stepSchema = z.object({
  id: z
    .preprocess((v) => (v == null || v === '' ? undefined : String(v).trim().slice(0, 200)), z.string().min(1).max(200))
    .describe(
      'Graph **node id** (internal key): used for default ordering and for custom **edges** `from` / `to`. Short strings like "1", "2", "3" or "s1", "s2" are a normal convention for uniqueness and references—they are **not** workspace file paths or line numbers. You may use a repo-relative path as `id` if each step is a file and the map should open that file on double-click, but that is a different use than **write_flow_file_graph**, which has separate **filePath** and **order** fields. The tool rewrites duplicate ids so nodes do not collapse.'
    ),
  label: z
    .preprocess((v) => (v == null || v === '' ? undefined : String(v).trim().slice(0, 500)), z.string().min(1).max(500))
    .describe('Short line shown in the map.'),
  detail: z
    .preprocess(
      (v) => (v == null || v === undefined || v === '' ? undefined : String(v).slice(0, 8000)),
      z.string().max(8000).optional()
    ),
});

const fileStepSchema = z.object({
  order: z.preprocess(
    (v) => {
      if (v == null || v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    },
    z.number().int().min(1).max(1000).optional()
  ),
  fileName: z.preprocess(
    (v) => (v == null || v === '' ? undefined : String(v).trim().slice(0, 300)),
    z.string().min(1).max(300)
  ),
  filePath: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .refine(
      (v) => v == null || v === undefined || typeof v === 'string',
      { message: 'filePath must be a string (workspace-relative path), not a number—use order for step sequence (1, 2, 3, …).' }
    )
    .transform((v) => (typeof v === 'string' ? v.trim().slice(0, 4000) : ''))
    .pipe(
      z
        .string()
        .min(1)
        .max(4000)
        .refine(
          (s) => !/^\d+$/.test(s),
          { message: 'filePath must be a workspace-relative path string (e.g. src/routes/handler.ts). A bare number is invalid—use the "order" field for step sequence, not filePath.' }
        )
    ),
  role: z.preprocess(
    (v) => (v == null || v === undefined ? undefined : String(v).trim().slice(0, 8000)),
    z.string().min(1).max(8000)
  ),
});

type StepParsed = z.infer<typeof stepSchema>;

async function persistBacktrackedJson(
  root: string,
  title: string,
  steps: StepParsed[],
  explicitEdges: { from: string; to: string }[] | undefined
) {
  const built = buildWorkflowGraphData(title, steps, explicitEdges);
  const dir = backtrackedDir(root);
  await fs.mkdir(dir, { recursive: true });
  const absPath = path.join(dir, path.basename(built.filename));
  assertUnderBacktracked(root, absPath);
  await fs.writeFile(absPath, JSON.stringify(built.graphData, null, 2) + '\n', 'utf8');
  return { absPath, relPath: built.relativePath, routeName: built.routeName, nodeCount: steps.length };
}

const server = new McpServer(
  { name: 'explorer-map-md-handler', version: '0.3.1' },
  {
    instructions:
      'Explorer Map MCP: **Start with explorer_map_workspace_status** to confirm the workspace and env, then **read_md_handler_file** for md/ notes. Two graph writers: (1) **write_flow_file_graph** — **filePath** = repo-relative path, **order** = step sequence. (2) **write_workflow_graph** — **steps** { **id**, label, detail? } where **id** is graph key only. If the Agent says this server is not connected, the user should enable the server and its tools under Cursor **Settings → Tools & MCP**, fully restart Cursor, and start a new chat; **explorer_map_workspace_status** still works when the process is up.',
  }
);

function requireRoot(): { root: string } | { isError: true; text: string } {
  const root = process.env.EXPLORER_MAP_WORKSPACE_ROOT?.trim();
  if (!root) {
    return {
      isError: true,
      text: 'Set environment variable EXPLORER_MAP_WORKSPACE_ROOT to your VS Code / Cursor workspace folder (the folder that contains visualizer/).',
    };
  }
  return { root };
}

const MD_HANDLER_BASENAMES = [
  'skills.md',
  'learnings.md',
  'architecture.md',
  'mistakes.md',
  'working.md',
] as const;

server.registerTool(
  'explorer_map_workspace_status',
  {
    description:
      '**Use first** in any Agent turn: returns JSON with EXPLORER_MAP_WORKSPACE_ROOT, which `md/*.md` notes exist, and `visualizer/backtracked/`. Confirms the MCP process is the correct project. If the Agent does not list other Explorer Map tools, tell the user to enable this server in Cursor **Settings → Tools & MCP** (turn on the server and its tool toggles), quit and restart Cursor, and start a new chat; many servers (GitKraken, Sentry, etc.) can push Explorer Map tools off the available list until some are disabled.',
    inputSchema: z.object({}),
  },
  async () => {
    const r = requireRoot();
    if ('isError' in r) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: r.text, fixEnv: 'Set EXPLORER_MAP_WORKSPACE_ROOT in mcp.json env for this stdio server.' }, null, 2),
          },
        ],
        isError: true,
      };
    }
    const { root } = r;
    const mdDir = path.join(root, 'md');
    const details: { file: string; exists: boolean; bytes?: number }[] = [];
    for (const f of MD_HANDLER_BASENAMES) {
      const p = path.join(mdDir, f);
      try {
        const st = await fs.stat(p);
        details.push({ file: f, exists: true, bytes: st.size });
      } catch {
        details.push({ file: f, exists: false });
      }
    }
    const bt = backtrackedDir(root);
    let backtrackedDirExists = false;
    let backtrackedFileCount = 0;
    try {
      const entries = await fs.readdir(bt, { withFileTypes: true });
      backtrackedDirExists = true;
      backtrackedFileCount = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).length;
    } catch {
      /* dir missing is ok */
    }
    const payload = {
      ok: true,
      server: 'explorer-map-md-handler',
      version: '0.3.1',
      workspaceRoot: root,
      mdDirectory: mdDir,
      mdFiles: details,
      visualizerBacktrackedDir: bt,
      backtrackedDirExists,
      backtrackedJsonFileCount: backtrackedFileCount,
      nextSteps: [
        'To read a note: call read_md_handler_file with fileName (e.g. skills.md).',
        'To build a file flow graph: call write_flow_file_graph with title and files [{ order, fileName, filePath, role }].',
        'If tools from this server are missing in chat: Cursor Settings → Tools & MCP → enable this server and its tools → restart Cursor → new chat. Reduce other MCP servers if you hit a tool limit.',
      ],
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  'read_md_handler_file',
  {
    description:
      'Read the full UTF-8 text of one Markdown file from the workspace `md/` folder (skills, learnings, architecture, mistakes, working). Call **explorer_map_workspace_status** first if you need to confirm paths or which files exist.',
    inputSchema: z.object({
      fileName: fileNameSchema.describe('Which md handler file to read (basename under md/).'),
    }),
  },
  async ({ fileName }) => {
    const r = requireRoot();
    if ('isError' in r) {
      return { content: [{ type: 'text' as const, text: r.text }], isError: true };
    }
    const { root } = r;
    let abs: string;
    try {
      abs = resolveUnderMdDir(root, fileName);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: m }], isError: true };
    }
    try {
      const text = await fs.readFile(abs, 'utf8');
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      const msg =
        code === 'ENOENT'
          ? `File not found: ${abs} (open the file once from Explorer Map → md handler to create it, or add md/ under your workspace).`
          : e instanceof Error
            ? e.message
            : String(e);
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  }
);

server.registerTool(
  'write_flow_file_graph',
  {
    description:
      '**Preferred** flow tool for **files in sequence**: use **filePath** (string, repo-relative) and **order** (step sequence). Do **not** reuse **write_workflow_graph**’s pattern of "1", "2" as **id**s here—there is no `id` on this tool; a step index belongs in **order**, and the real file location belongs in **filePath** only. **fileName**, **role** label the node. openInMap (default) requests Map View.',
    inputSchema: z.object({
      title: z.string().min(1).max(300).describe('Short title for the flow (Map route and output filename).'),
      files: z.unknown().describe(
        'JSON **array** of { order?, fileName, filePath, role }, or 0,1,2 index map, or one object. **filePath** = string, path from workspace root. **order** = step sequence (1-based); if omitted, index order is used.'
      ),
      openInMap: z
        .boolean()
        .optional()
        .describe('If true (default), write a bridge file so the extension opens Map View when it is running. If false, only write JSON.'),
    }),
  },
  async ({ title, files: filesRaw, openInMap }) => {
    const r = requireRoot();
    if ('isError' in r) {
      return { content: [{ type: 'text' as const, text: r.text }], isError: true };
    }
    const { root } = r;
    const shouldOpen = openInMap !== false;
    let filesParsed: FileFlowStepIn[];
    try {
      const coerced = coerceFileFlowInput(filesRaw);
      const pr = z.array(fileStepSchema).min(1).max(100).safeParse(coerced);
      if (!pr.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: pr.error.issues
                .map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message)
                .join('; '),
            },
          ],
          isError: true,
        };
      }
      const enriched = pr.data.map((f, i) => ({
        ...f,
        order: f.order ?? i + 1,
        __i: i,
      }));
      enriched.sort((a, b) => a.order - b.order || a.__i - b.__i);
      filesParsed = enriched.map(({ __i, ...f }): FileFlowStepIn => ({ ...f, order: f.order! }));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: m }], isError: true };
    }
    const steps = fileFlowToWorkflowSteps(filesParsed, root);
    let out: { absPath: string; relPath: string; routeName: string; nodeCount: number };
    try {
      out = await persistBacktrackedJson(root, title, steps, undefined);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: m }], isError: true };
    }
    let openNote = '';
    if (shouldOpen) {
      try {
        await writeOpenMapRequest(root, out.absPath);
        openNote = `\nMap View open requested (wrote ${mcpOpenMapRelativePath()}). The File Graph / Explorer Map extension must be running.`;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        openNote = `\nCould not request Map View: ${m}`;
      }
    }
    const msg =
      `Wrote ${out.absPath}\n` +
      `Route: ${out.routeName}\n` +
      `Relative: ${out.relPath}\n` +
      `Files in flow: ${out.nodeCount}\n` +
      (shouldOpen ? openNote : '\nOpen the JSON from Explorer Map → Saved if you set openInMap to false.') +
      '\nThe agent should not echo the full graph JSON; only the fields above are needed.';
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

server.registerTool(
  'write_workflow_graph',
  {
    description:
      'Advanced: raw **steps** and optional **edges**. Each **id** is the graph node key (for **edges** `from`/`to`). Strings like "1", "2" are conventional **key** values, not file paths; you may use repo-relative paths as **id** if you want the map to use path-shaped keys and open files, but the usual file-flow workflow is **write_flow_file_graph** (separate **filePath** and **order**). Writes visualizer/backtracked/ JSON.',
    inputSchema: z.object({
      title: z.string().min(1).max(300).describe('Short title for the flow (route name and filename).'),
      steps: z.unknown().describe(
        'JSON **array** of { id, label, detail? } in flow order, or map 0,1,2… → step, or one object. **id** = unique node key (edges use these strings), not a substitute for **write_flow_file_graph**’s filePath. Numeric-looking ids are fine as keys, not as workspace paths.'
      ),
      edges: z
        .array(
          z.object({
            from: z.string().min(1),
            to: z.string().min(1),
          })
        )
        .optional()
        .describe('If omitted, default edges follow step list order. **from** / **to** are **id** values from steps (e.g. "1" → "2"), not file paths unless your ids are paths intentionally.'),
      openInMap: z
        .boolean()
        .optional()
        .describe('If true, also request the extension to open Map View (default false for this advanced tool).'),
    }),
  },
  async ({ title, steps: stepsRaw, edges: edgesArg, openInMap }) => {
    const r = requireRoot();
    if ('isError' in r) {
      return { content: [{ type: 'text' as const, text: r.text }], isError: true };
    }
    const { root } = r;
    let stepsParsed: StepParsed[];
    try {
      const coerced = coerceWorkflowStepsInput(stepsRaw);
      const pr = z.array(stepSchema).min(1).max(100).safeParse(coerced);
      if (!pr.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: pr.error.issues
                .map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message)
                .join('; '),
            },
          ],
          isError: true,
        };
      }
      stepsParsed = pr.data;
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: m }], isError: true };
    }
    const explicitEdges = edgesArg && edgesArg.length > 0 ? edgesArg : undefined;
    let out: { absPath: string; relPath: string; routeName: string; nodeCount: number };
    try {
      out = await persistBacktrackedJson(root, title, stepsParsed, explicitEdges);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: m }], isError: true };
    }
    let extra = '';
    if (openInMap) {
      try {
        await writeOpenMapRequest(root, out.absPath);
        extra = `\nMap View open requested via ${mcpOpenMapRelativePath()}.`;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        extra = `\nCould not request Map View: ${m}`;
      }
    }
    const msg =
      `Wrote ${out.absPath}\n` +
      `Route: ${out.routeName}\n` +
      `Relative: ${out.relPath}\n` +
      `Nodes written: ${out.nodeCount}\n` +
      extra +
      '\nOpen from Saved (backtracked) in Explorer Map if Map View did not open.';
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
