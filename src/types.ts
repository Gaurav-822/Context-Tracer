export interface NodeColor {
  background: string;
  border: string;
  highlight: { background: string; border: string };
  hover: { background: string; border: string };
}

export interface NodeData {
  id: string;
  label: string;
  title: string;
  color: NodeColor;
  font: Record<string, unknown>;
  shape: string;
  size: number;
  borderWidth: number;
  borderWidthSelected: number;
  margin?: number;
  isController?: boolean;
  /** BFS depth from entry file (0 = entry). Used for layered reveal in the webview. */
  importLevel?: number;
}

export interface EdgeData {
  from: string;
  to: string;
  color: { color: string; highlight: string; hover: string };
  width: number;
  selectionWidth: number;
  smooth: boolean;
}

export interface MethodInfo {
  id: string;
  label: string;
}

export interface GraphSnapshot {
  nodes: NodeData[];
  edges: EdgeData[];
  methodDeps: Record<string, string[]>;
  controllerMethods: Record<string, MethodInfo[]>;
  defaultMethodId: string | null;
  controllerId: string | null;
}

/** Written into saved JSON after Backtrack; UI state does not rely on filename. */
export interface GraphDataBacktrackMeta {
  seedNodeRelPath: string;
  closureRelPaths: string[];
  generatedAt: number;
}

export interface GraphData {
  graphSnapshots: Record<string, GraphSnapshot>;
  routeNames: string[];
  gitHeatByPath?: Record<string, number>;
  backtrack?: GraphDataBacktrackMeta;
}

export interface TraceState {
  tracedNodes: string[];
  tracedEdges: string[];
  nodeData: Array<{
    id: string;
    label: string;
    color: string;
    shape: string;
  }>;
}

export interface ApiJsonData {
  apis: ApiEntry[];
}

export interface ApiEntry {
  apiRoute?: string;
  apiUsage?: string;
  dependencies?: DependencyNode;
  handlerMethod?: string;
}

export interface DependencyNode {
  fileName?: string;
  whatDoesThisFileDo?: string;
  isCircular?: boolean;
  methods?: MethodNode[];
  dependencies?: {
    packages?: string[];
    internalFiles?: DependencyNode[];
  };
}

export interface MethodNode {
  name?: string;
  dependencies?: {
    packages?: string[];
    internalFiles?: DependencyNode[];
  };
}
