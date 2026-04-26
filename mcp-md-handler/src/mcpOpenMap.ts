import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const OPEN_MAP_REL = path.join('visualizer', 'mcp', 'open_map.json');

/**
 * Tells the File Graph extension to open a saved graph JSON in Map View. The host workspace must
 * have the extension running; it watches `visualizer/mcp/open_map.json` and then deletes the file.
 * `graphJsonAbsPath` must lie under `workspaceRoot/visualizer/`.
 */
export async function writeOpenMapRequest(workspaceRoot: string, graphJsonAbsPath: string): Promise<string> {
  const root = path.resolve(workspaceRoot);
  const graph = path.resolve(graphJsonAbsPath);
  const vis = path.join(root, 'visualizer') + path.sep;
  if (!graph.startsWith(vis) || !graph.toLowerCase().endsWith('.json')) {
    throw new Error('Graph file must be a .json under the workspace visualizer/ folder.');
  }
  const mcpDir = path.join(root, 'visualizer', 'mcp');
  await fs.mkdir(mcpDir, { recursive: true });
  const rel = path.relative(root, graph).replace(/\\/g, '/');
  const outPath = path.join(mcpDir, 'open_map.json');
  const payload = JSON.stringify({ graphFile: rel }, null, 2) + '\n';
  await fs.writeFile(outPath, payload, 'utf8');
  return outPath;
}

export function mcpOpenMapRelativePath(): string {
  return OPEN_MAP_REL.replace(/\\/g, '/');
}
