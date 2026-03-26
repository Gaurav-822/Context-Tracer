import {
  ApiJsonData,
  DependencyNode,
  EdgeData,
  GraphData,
  GraphSnapshot,
  MethodInfo,
  NodeData,
} from './types';

export function buildGraphSnapshots(data: ApiJsonData): GraphData {
  const graphSnapshots: Record<string, GraphSnapshot> = {};
  const routeNames: string[] = [];

  for (const api of data.apis ?? []) {
    const apiRoute = api.apiRoute;
    const apiUsage = api.apiUsage ?? '';
    const rootDependency = api.dependencies;
    const handlerMethod = api.handlerMethod;

    if (!apiRoute || !rootDependency) {
      continue;
    }

    routeNames.push(apiRoute);
    const localNodes: Record<string, NodeData> = {};
    const localEdges: EdgeData[] = [];
    const seenEdges = new Set<string>();
    const methodDepsMap: Record<string, string[]> = {};

    function processNode(nodeData: DependencyNode, parentId?: string): void {
      const nodeId = nodeData.fileName;
      if (!nodeId) {
        return;
      }

      const deps = nodeData.dependencies ?? {};

      if (!(nodeId in localNodes)) {
        const summary = nodeData.whatDoesThisFileDo ?? '(No summary available)';
        const packages = deps.packages ?? [];
        const packagesStr = packages.length > 0 ? packages.join(', ') : 'None';

        let tooltip = `${nodeId}\n\nWhat it does:\n${summary}\n\nNPM Packages:\n${packagesStr}`;
        let baseColor: string;
        let borderColor: string;

        if (nodeData.isCircular) {
          baseColor = '#E53935';
          borderColor = '#B71C1C';
          tooltip += '\n\n⚠ CIRCULAR DEPENDENCY';
        } else {
          baseColor = '#1E88E5';
          borderColor = '#0D47A1';
        }

        localNodes[nodeId] = {
          id: nodeId,
          label: nodeId,
          title: tooltip,
          color: {
            background: baseColor,
            border: borderColor,
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
      }

      if (parentId) {
        const edgeKey = `${parentId}->${nodeId}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          localEdges.push({
            from: parentId,
            to: nodeId,
            color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' },
            width: 1.5,
            selectionWidth: 2,
            smooth: false,
          });
        }
      }

      for (const child of deps.internalFiles ?? []) {
        processNode(child, nodeId);
      }
    }

    function processMethodDeps(
      methodDeps: DependencyNode['dependencies'],
      parentId: string
    ): string[] {
      const childIds: string[] = [];
      for (const child of methodDeps?.internalFiles ?? []) {
        const childId = child.fileName;
        if (childId) {
          childIds.push(childId);
          processNode(child, parentId);
        }
      }
      return childIds;
    }

    const routeTooltip = `API Route\n${apiRoute}\n\nUsage:\n${apiUsage}`;
    localNodes[apiRoute] = {
      id: apiRoute,
      label: apiRoute,
      title: routeTooltip,
      color: {
        background: '#43A047',
        border: '#1B5E20',
        highlight: { background: '#66BB6A', border: '#FFC107' },
        hover: { background: '#66BB6A', border: '#FFC107' },
      },
      font: { color: '#ffffff', size: 21, face: 'Inter, -apple-system, sans-serif', bold: true },
      shape: 'hexagon',
      size: 45,
      borderWidth: 2,
      borderWidthSelected: 4,
    };

    const methods = rootDependency.methods ?? [];
    const controllerFile = rootDependency.fileName ?? '';

    if (methods.length > 0) {
      const controllerId = controllerFile;
      const controllerSummary = rootDependency.whatDoesThisFileDo ?? '(No summary)';
      const controllerTooltip = `${controllerFile}\n\nController with ${methods.length} method(s)\n\n${controllerSummary}`;

      localNodes[controllerId] = {
        id: controllerId,
        label: controllerFile,
        title: controllerTooltip,
        color: {
          background: '#7B1FA2',
          border: '#4A148C',
          highlight: { background: '#9C27B0', border: '#FFC107' },
          hover: { background: '#9C27B0', border: '#FFC107' },
        },
        font: { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' },
        shape: 'box',
        size: 40,
        borderWidth: 1.5,
        borderWidthSelected: 3,
        margin: 12,
        isController: true,
      };

      localEdges.push({
        from: apiRoute,
        to: controllerId,
        color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' },
        width: 1.5,
        selectionWidth: 2,
        smooth: false,
      });

      for (const method of methods) {
        const methodName = method.name ?? 'unknown';
        const methodId = `${controllerFile}::${methodName}`;
        const methodDeps = method.dependencies;
        const childIds = processMethodDeps(methodDeps, controllerId);
        methodDepsMap[methodId] = childIds;
      }
    } else {
      processNode(rootDependency, apiRoute);
    }

    const controllerMethodsMap: Record<string, MethodInfo[]> = {};
    let defaultMethodId: string | null = null;

    if (methods.length > 0) {
      const controllerId = controllerFile;
      controllerMethodsMap[controllerId] = methods.map((m) => ({
        id: `${controllerFile}::${m.name ?? 'unknown'}`,
        label: m.name ?? 'unknown',
      }));

      for (const m of methods) {
        if (handlerMethod && m.name === handlerMethod) {
          defaultMethodId = `${controllerFile}::${m.name ?? 'unknown'}`;
          break;
        }
      }
      if (defaultMethodId === null) {
        defaultMethodId = `${controllerFile}::${methods[0].name ?? 'unknown'}`;
      }
    }

    graphSnapshots[apiRoute] = {
      nodes: Object.values(localNodes),
      edges: localEdges,
      methodDeps: methodDepsMap,
      controllerMethods: controllerMethodsMap,
      defaultMethodId,
      controllerId: methods.length > 0 ? controllerFile : null,
    };
  }

  return { graphSnapshots, routeNames };
}
