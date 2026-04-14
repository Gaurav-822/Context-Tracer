/**
 * Merge backtrack closure nodes/edges into an existing route snapshot.
 */

import * as path from 'path';
import { GraphData, GraphSnapshot, NodeData, EdgeData } from './types';

function makeBacktrackNode(rel: string): NodeData {
  const base = '#1E88E5';
  const border = '#F9A825';
  return {
    id: rel,
    label: path.basename(rel),
    title: `${rel}\n\nWhat it does:\n(Added via backtrack — from open editors)\n\nNPM Packages:\nNone`,
    color: {
      background: base,
      border,
      highlight: { background: '#42A5F5', border: '#FFC107' },
      hover: { background: '#42A5F5', border: '#FFC107' },
    },
    font: { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' },
    shape: 'box',
    size: 36,
    borderWidth: 2.5,
    borderWidthSelected: 3,
    margin: 12,
  };
}

function makeBacktrackEdge(from: string, to: string): EdgeData {
  return {
    from,
    to,
    color: { color: 'rgba(249,168,37,0.6)', highlight: '#FFC107', hover: '#FFC107' },
    width: 2,
    selectionWidth: 2,
    smooth: false,
  };
}

export interface BacktrackMergeResult {
  /** Nodes newly added (excludes any id already in the snapshot). */
  newNodesAdded: number;
  newEdgesAdded: number;
}

/**
 * Adds nodes only for closure paths not already in the snapshot, then edges for backtrack importer links.
 */
export function mergeBacktrackIntoRoute(
  graphData: GraphData,
  routeId: string,
  closureRelPaths: string[],
  edges: Array<{ from: string; to: string }>
): BacktrackMergeResult {
  const snap = graphData.graphSnapshots[routeId];
  if (!snap) return { newNodesAdded: 0, newEdgesAdded: 0 };

  const ids = new Set(snap.nodes.map((n) => n.id));
  const edgeKeys = new Set(snap.edges.map((e) => `${e.from}->${e.to}`));
  let newNodesAdded = 0;
  let newEdgesAdded = 0;

  for (const rel of closureRelPaths) {
    if (!rel || rel.includes('::')) continue;
    if (ids.has(rel)) continue;
    ids.add(rel);
    snap.nodes.push(makeBacktrackNode(rel));
    newNodesAdded += 1;
  }

  for (const e of edges) {
    const k = `${e.from}->${e.to}`;
    if (edgeKeys.has(k)) continue;
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    edgeKeys.add(k);
    snap.edges.push(makeBacktrackEdge(e.from, e.to));
    newEdgesAdded += 1;
  }

  return { newNodesAdded, newEdgesAdded };
}
