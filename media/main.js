(function () {
  const vscode = acquireVsCodeApi();

  let graphSnapshots = {};
  let routeNames = [];
  let network = null;
  let nodes = null;
  let edges = null;

  const container = document.getElementById('mynetwork');
  const loadingOverlay = document.getElementById('graph-loading-overlay');
  const nodeCountEl = document.getElementById('nodeCount');
  const edgeCountEl = document.getElementById('edgeCount');
  const traceExpandModal = document.getElementById('trace-expand-modal');
  const traceExpandGraph = document.getElementById('trace-expand-graph');
  const traceExpandClose = document.getElementById('trace-expand-close');
  const controllerMethodsBar = document.getElementById('controller-methods');
  const controllerMethodsTitle = document.getElementById('controller-methods-title');
  const controllerMethodsList = document.getElementById('controller-methods-list');
  const controllerMethodsReset = document.getElementById('controller-methods-reset');

  let traceExpandNetwork = null;

  let _originals = {};
  let _baseNodeSizes = {};
  let nodeSizeScale = 1;
  let traceOn = false;
  let focusModeOn = false;
  let focusModeSelectedNodeId = null;
  let tracedNodesSet = new Set();
  let tracedEdges = new Set();
  let tracedAddHistory = [];
  let traceRedoStack = [];
  let currentMethodDeps = {};
  let currentControllerMethods = {};
  let selectedMethodOnController = null;
  let selectedMethodForTrace = null;
  let currentControllerId = null;
  let currentDefaultMethodId = null;
  let currentRouteId = null;
  let deselectRouteTimeout = null;

  function initNetwork() {
    nodes = new vis.DataSet([]);
    edges = new vis.DataSet([]);

    network = new vis.Network(container, { nodes, edges }, {
      physics: {
        solver: 'barnesHut',
        minVelocity: 0.01,
        barnesHut: {
          gravitationalConstant: -80000,
          centralGravity: 0.02,
          springLength: 400,
          springConstant: 0.02,
          damping: 0.5
        },
        stabilization: {
          enabled: true, iterations: 500, updateInterval: 100,
          onlyDynamicEdges: false, fit: true
        }
      },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.5 } } },
      interaction: { hover: true, selectConnectedEdges: true, tooltipDelay: 150 }
    });

    setupNetworkEvents();
  }

  function findEdgeBetween(a, b) {
    return edges.get().find(e =>
      (e.from === a && e.to === b) || (e.from === b && e.to === a)
    );
  }

  function getNodesConnectedTo(centerId) {
    const visible = new Set([centerId]);
    edges.get().forEach(e => {
      if (e.from === centerId) visible.add(e.to);
      if (e.to === centerId) visible.add(e.from);
    });
    return visible;
  }

  function getPathFromRootToNode(nodeId) {
    const path = new Set();
    let current = nodeId;
    path.add(current);
    while (current) {
      let parent = null;
      for (const key of tracedEdges) {
        const [from, to] = key.split(',');
        if (to === current) { parent = from; break; }
      }
      if (!parent) break;
      path.add(parent);
      current = parent;
    }
    return path;
  }

  function renderFocusMode() {
    if (!nodes || !network) return;
    if (!traceOn || !focusModeOn) {
      nodes.getIds().forEach(id => {
        const n = nodes.get(id);
        if (n && n.hidden) {
          nodes.update({
            id,
            hidden: false,
            label: n.label ?? id,
            font: n.font || { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' }
          });
        }
      });
      return;
    }
    let visible;
    if (focusModeSelectedNodeId && tracedNodesSet.has(focusModeSelectedNodeId)) {
      visible = new Set();
      tracedNodesSet.forEach(id => visible.add(id));
      getNodesConnectedTo(focusModeSelectedNodeId).forEach(id => visible.add(id));
    } else {
      visible = getSelectableNodes();
    }
    nodes.getIds().forEach(id => {
      const shouldShow = visible.has(id);
      const n = nodes.get(id);
      if (!n) return;
      if (n.hidden !== !shouldShow) {
        nodes.update({
          id,
          hidden: !shouldShow,
          label: n.label ?? id,
          font: n.font || { color: '#ffffff', size: 18, face: 'Inter, -apple-system, sans-serif' }
        });
      }
    });
  }

  function updateControllerLabel() {
    if (!currentControllerId || !nodes.get(currentControllerId)) return;
    const baseLabel = currentControllerId;
    const methodName = selectedMethodOnController ? selectedMethodOnController.split('::')[1] : null;
    const newLabel = methodName ? baseLabel + '\n' + methodName : baseLabel;
    nodes.update({ id: currentControllerId, label: newLabel });
  }

  function getMethodDescendants(methodId) {
    const descendants = new Set();
    const queue = [...(currentMethodDeps[methodId] || [])];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!descendants.has(current)) {
        descendants.add(current);
        edges.get().forEach(e => {
          if (e.from === current && !descendants.has(e.to)) queue.push(e.to);
        });
      }
    }
    return descendants;
  }

  function getSelectableNodes() {
    if (tracedNodesSet.size === 0) {
      return currentRouteId ? new Set([currentRouteId]) : new Set();
    }
    if (tracedNodesSet.has(currentControllerId) && selectedMethodOnController && !selectedMethodForTrace) {
      selectedMethodForTrace = selectedMethodOnController;
    }
    const methodDescendants = selectedMethodForTrace ? getMethodDescendants(selectedMethodForTrace) : null;
    const outgoing = new Set();
    tracedNodesSet.forEach(fromId => {
      edges.get().forEach(e => {
        if (e.from !== fromId || tracedNodesSet.has(e.to)) return;
        if (methodDescendants && !methodDescendants.has(e.to)) return;
        outgoing.add(e.to);
      });
    });
    tracedNodesSet.forEach(id => outgoing.add(id));
    return outgoing;
  }

  function getTraceGraphData() {
    const miniNodes = [];
    const miniEdges = [];
    tracedNodesSet.forEach(id => {
      const n = nodes.get(id);
      if (!n) return;
      const shortLabel = (n.label || id).length > 20 ? (n.label || id).slice(0, 17) + '...' : (n.label || id);
      miniNodes.push({
        id, label: shortLabel,
        color: n.color ? (typeof n.color === 'object' ? n.color.background : n.color) : '#1E88E5',
        font: { size: 10, color: '#fff' },
        shape: n.shape || 'box',
        size: 12
      });
    });
    tracedEdges.forEach(key => {
      const [from, to] = key.split(',');
      miniEdges.push({ from, to, color: '#FFC107', width: 2 });
    });
    return { nodes: miniNodes, edges: miniEdges };
  }

  function sendTraceState() {
    const data = getTraceGraphData();
    vscode.postMessage({
      type: 'traceUpdated',
      tracedNodes: Array.from(tracedNodesSet),
      tracedEdges: Array.from(tracedEdges),
      nodeData: data.nodes,
      edgeData: data.edges
    });
  }

  function openTraceExpandModal() {
    if (tracedNodesSet.size === 0) return;
    const data = getTraceGraphData();
    if (data.nodes.length === 0) return;
    const expNodes = data.nodes.map(n => ({
      ...n, label: (nodes.get(n.id)?.label || n.id),
      font: { size: 14 }, size: 18
    }));
    traceExpandGraph.innerHTML = '';
    const expNodesDs = new vis.DataSet(expNodes);
    const expEdgesDs = new vis.DataSet(data.edges);
    traceExpandNetwork = new vis.Network(traceExpandGraph, { nodes: expNodesDs, edges: expEdgesDs }, {
      physics: { enabled: true, solver: 'forceAtlas2Based', forceAtlas2Based: { gravitationalConstant: -50, centralGravity: 0.01, springLength: 120, springConstant: 0.05 } },
      nodes: { borderWidth: 2 },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.6 } }, width: 2 },
      interaction: { dragNodes: true, zoomView: true, dragView: true }
    });
    traceExpandModal.classList.add('visible');
  }

  function renderTrace() {
    if (!traceOn) {
      const nodeUpdates = nodes.getIds().map(id => {
        const n = nodes.get(id);
        const o = _originals[id] || {};
        const c = n?.color && typeof n.color === 'object' ? n.color : {};
        return {
          id,
          label: n?.label ?? id,
          color: { ...c, border: o.border || c.border || '#666' },
          borderWidth: o.borderWidth ?? 1.5,
          opacity: 1
        };
      });
      nodes.update(nodeUpdates);
      const edgeUpdates = edges.getIds().map(id => ({
        id, color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' }, width: 1.5
      }));
      edges.update(edgeUpdates);
      sendTraceState();
      if (focusModeOn) renderFocusMode();
      return;
    }

    const selectable = getSelectableNodes();
    const nodeUpdates = nodes.getIds().map(id => {
      const n = nodes.get(id);
      const o = _originals[id] || {};
      const c = n?.color && typeof n.color === 'object' ? n.color : {};
      const base = { id, label: n?.label ?? id, borderWidth: o.borderWidth ?? 1.5 };
      if (tracedNodesSet.has(id)) {
        return { ...base, color: { ...c, border: '#FFC107' }, opacity: 1 };
      } else if (selectable.has(id)) {
        return { ...base, color: { ...c, border: o.border || c.border || '#666' }, opacity: 1 };
      } else {
        return { ...base, color: { ...c, border: o.border || c.border || '#666' }, opacity: 0.25 };
      }
    });
    nodes.update(nodeUpdates);

    const edgeUpdates = edges.getIds().map(id => ({
      id, color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' }, width: 1.5
    }));
    edges.update(edgeUpdates);
    tracedEdges.forEach(key => {
      const [from, to] = key.split(',');
      const edge = findEdgeBetween(from, to);
      if (edge) edges.update({ id: edge.id, color: { color: '#FFC107', highlight: '#FFC107' }, width: 3 });
    });

    sendTraceState();
    if (focusModeOn) renderFocusMode();
  }

  function traceAddNode(nodeId) {
    let fromId = null;
    if (tracedNodesSet.size === 0) {
      if (nodeId !== currentRouteId) return;
      tracedNodesSet.add(nodeId);
      tracedAddHistory.push({ node: nodeId, from: null });
    } else {
      tracedNodesSet.forEach(tid => {
        if (fromId) return;
        const edge = findEdgeBetween(tid, nodeId);
        if (edge && edge.from === tid && edge.to === nodeId) fromId = tid;
      });
      if (!fromId) return;
      tracedNodesSet.add(nodeId);
      tracedEdges.add(fromId + ',' + nodeId);
      tracedAddHistory.push({ node: nodeId, from: fromId });
    }
    traceRedoStack = [];
    renderTrace();
  }

  function traceUndoFn() {
    if (tracedAddHistory.length === 0) return;
    const { node, from } = tracedAddHistory.pop();
    traceRedoStack.push({ node, from });
    tracedNodesSet.delete(node);
    if (from) tracedEdges.delete(from + ',' + node);
    if (node === currentControllerId) selectedMethodForTrace = null;
    renderTrace();
  }

  function traceRedoFn() {
    if (traceRedoStack.length === 0) return;
    const { node, from } = traceRedoStack.pop();
    tracedNodesSet.add(node);
    if (from) tracedEdges.add(from + ',' + node);
    tracedAddHistory.push({ node, from });
    if (node === currentControllerId && selectedMethodOnController) selectedMethodForTrace = selectedMethodOnController;
    renderTrace();
  }

  function traceClearFn() {
    tracedNodesSet.clear();
    tracedEdges.clear();
    tracedAddHistory = [];
    traceRedoStack = [];
    selectedMethodForTrace = null;
    renderTrace();
  }

  // ── Controller methods bar ─────────────────────────────────────────────
  function showControllerMethodsBar(nodeId) {
    const node = nodes.get(nodeId);
    const methods = currentControllerMethods[nodeId];
    if (!node || !node.isController || !methods || methods.length === 0) {
      hideControllerMethodsBar();
      return;
    }

    controllerMethodsTitle.textContent = (node.label || nodeId).split('\n')[0];
    controllerMethodsList.innerHTML = '';
    methods.forEach(m => {
      const btn = document.createElement('button');
      btn.className = 'cm-item' + (selectedMethodOnController === m.id ? ' active' : '');
      btn.textContent = m.label;
      btn.addEventListener('click', () => {
        selectedMethodOnController = m.id;
        selectedMethodForTrace = selectedMethodOnController;
        updateControllerLabel();
        if (traceOn) renderTrace();
        highlightActiveMethod();
      });
      controllerMethodsList.appendChild(btn);
    });

    controllerMethodsReset.style.display = 'block';
    controllerMethodsReset.onclick = () => {
      selectedMethodOnController = currentDefaultMethodId;
      selectedMethodForTrace = selectedMethodOnController;
      updateControllerLabel();
      if (traceOn) renderTrace();
      highlightActiveMethod();
    };

    controllerMethodsBar.style.display = 'block';
  }

  function highlightActiveMethod() {
    const btns = controllerMethodsList.querySelectorAll('.cm-item');
    btns.forEach(btn => {
      const label = btn.textContent;
      const isActive = selectedMethodOnController && selectedMethodOnController.endsWith('::' + label);
      btn.classList.toggle('active', isActive);
    });
  }

  function hideControllerMethodsBar() {
    controllerMethodsBar.style.display = 'none';
  }

  // ── Node info → sidebar ───────────────────────────────────────────────
  function sendNodeSelected(nodeId) {
    const node = nodes.get(nodeId);
    if (!node) return;

    const titleText = node.title || '';
    const lines = titleText.split('\n');

    let summary = '';
    let packages = '';
    let inSummary = false;
    let inPackages = false;

    for (const line of lines) {
      if (line.startsWith('What it does:')) { inSummary = true; inPackages = false; continue; }
      if (line.startsWith('NPM Packages:')) { inPackages = true; inSummary = false; continue; }
      if (line.startsWith('API Route') || line.startsWith('Usage:')) { inSummary = false; inPackages = false; continue; }
      if (inSummary) summary += (summary ? ' ' : '') + line.trim();
      if (inPackages) packages += (packages ? ', ' : '') + line.trim();
    }

    let nodeType = 'file';
    if (node.isController) nodeType = 'controller';
    else if (node.shape === 'hexagon') nodeType = 'route';
    else if (node.isCircular) nodeType = 'circular';

    let openableFilePath = nodeId;
    if (nodeType === 'route') {
      const outEdges = edges.get().filter(e => e.from === nodeId);
      const controllerId = outEdges.length > 0 ? outEdges[0].to : null;
      if (controllerId) openableFilePath = controllerId;
    }

    vscode.postMessage({
      type: 'nodeSelected',
      nodeId,
      nodeName: node.label || nodeId,
      nodeType,
      openableFilePath,
      summary: summary || '(No summary)',
      packages: packages || 'None',
    });
  }

  function sendNodeDeselected() {
    vscode.postMessage({ type: 'nodeDeselected' });
  }

  function applyNodeSizeScale(scale) {
    nodeSizeScale = scale;
    if (!nodes) return;
    const updates = nodes.getIds().map(id => {
      const base = _baseNodeSizes[id] || { size: 38, fontSize: 18 };
      const n = nodes.get(id);
      const font = n?.font && typeof n.font === 'object' ? n.font : {};
      return {
        id,
        size: base.size * scale,
        font: { ...font, size: Math.round(base.fontSize * scale) }
      };
    });
    nodes.update(updates);
  }

  function loadApiGraph(routeId) {
    if (!graphSnapshots[routeId]) return;

    loadingOverlay.classList.add('visible');
    network.setOptions({ physics: { enabled: true } });

    nodes.clear();
    edges.clear();
    traceClearFn();
    focusModeOn = false;
    focusModeSelectedNodeId = null;
    hideControllerMethodsBar();
    sendNodeDeselected();

    const currentData = graphSnapshots[routeId];
    nodes.add(currentData.nodes);
    edges.add(currentData.edges);
    currentMethodDeps = currentData.methodDeps || {};
    currentControllerMethods = currentData.controllerMethods || {};
    currentControllerId = currentData.controllerId || null;
    currentDefaultMethodId = currentData.defaultMethodId || null;
    currentRouteId = routeId;
    selectedMethodOnController = currentDefaultMethodId;
    selectedMethodForTrace = null;
    _originals = {};
    _baseNodeSizes = {};
    currentData.nodes.forEach(n => {
      const c = n.color;
      _originals[n.id] = { border: (c && c.border) || (typeof c === 'string' ? c : '#666'), borderWidth: n.borderWidth || 1.5 };
      const font = n.font && typeof n.font === 'object' ? n.font : {};
      _baseNodeSizes[n.id] = { size: n.size || 38, fontSize: font.size || 18 };
    });

    nodeCountEl.textContent = currentData.nodes.length;
    edgeCountEl.textContent = currentData.edges.length;

    updateControllerLabel();

    const nodeIds = currentData.nodes
      .filter(n => n.shape !== 'hexagon')
      .map(n => n.id)
      .sort((a, b) => a.localeCompare(b));
    vscode.postMessage({ type: 'graphMetaReady', routeNames, nodeIds, currentRouteId: routeId });

    let done = false;
    const finishLoad = () => {
      if (done) return;
      done = true;
      if (nodeSizeScale !== 1) applyNodeSizeScale(nodeSizeScale);
      network.setOptions({ physics: { enabled: false } });
      const fixAll = nodes.getIds().map(id => ({ id, fixed: true }));
      nodes.update(fixAll);
      network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
      loadingOverlay.classList.remove('visible');
    };

    network.off('stabilizationIterationsDone');
    network.once('stabilizationIterationsDone', finishLoad);
    network.stabilize();
    setTimeout(finishLoad, 3000);
  }

  function setupNetworkEvents() {
    traceExpandClose.addEventListener('click', () => traceExpandModal.classList.remove('visible'));
    traceExpandModal.addEventListener('click', (e) => { if (e.target === traceExpandModal) traceExpandModal.classList.remove('visible'); });

    const centerBtn = document.getElementById('centerBtn');
    if (centerBtn) {
      centerBtn.addEventListener('click', () => { if (network) network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } }); });
    }

    network.on('click', function (params) {
      if (traceOn && params.nodes.length > 0) {
        const clickedNode = params.nodes[0];
        const selectable = getSelectableNodes();
        if (selectable.has(clickedNode) && !tracedNodesSet.has(clickedNode)) {
          traceAddNode(clickedNode);
        }
        return;
      }
    });

    network.on('selectNode', function () {
      if (deselectRouteTimeout) {
        clearTimeout(deselectRouteTimeout);
        deselectRouteTimeout = null;
      }
      const selectedIds = network.getSelectedNodes();
      if (traceOn) {
        if (focusModeOn && selectedIds && selectedIds.length > 0) {
          focusModeSelectedNodeId = selectedIds[0];
          renderFocusMode();
        }
        return;
      }
      if (!selectedIds || selectedIds.length === 0) return;

      const firstId = selectedIds[0];
      sendNodeSelected(firstId);

      const firstNode = nodes.get(firstId);
      if (firstNode && firstNode.isController) {
        showControllerMethodsBar(firstId);
      } else {
        hideControllerMethodsBar();
      }

      if (focusModeOn) {
        focusModeSelectedNodeId = firstId;
        renderFocusMode();
        return;
      }

      const highlighted = new Set(selectedIds);
      selectedIds.forEach(id => {
        (network.getConnectedNodes(id) || []).forEach(cid => highlighted.add(cid));
      });

      const nodeUpdates = nodes.getIds().map(id => {
        const n = nodes.get(id);
        const o = _originals[id] || {};
        const c = n?.color && typeof n.color === 'object' ? n.color : {};
        const base = { id, label: n?.label ?? id };
        if (selectedIds.includes(id)) {
          return { ...base, opacity: 1, color: { ...c, border: o.border || c.border || '#666' }, borderWidth: o.borderWidth ?? 1.5 };
        } else if (highlighted.has(id)) {
          return { ...base, opacity: 1, color: { ...c, border: 'rgba(255,193,7,0.6)' }, borderWidth: 2.5 };
        } else {
          return { ...base, opacity: 0.2, color: { ...c, border: o.border || c.border || '#666' }, borderWidth: o.borderWidth ?? 1.5 };
        }
      });
      nodes.update(nodeUpdates);

      const edgeUpdates = edges.getIds().map(eid => {
        const e = edges.get(eid);
        if (highlighted.has(e.from) && highlighted.has(e.to)) {
          return { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2 };
        }
        return { id: eid, color: { color: 'rgba(255,255,255,0.04)' }, width: 1 };
      });
      edges.update(edgeUpdates);
    });

    network.on('deselectNode', function () {
      if (deselectRouteTimeout) clearTimeout(deselectRouteTimeout);
      if (currentRouteId && nodes.get(currentRouteId)) {
        deselectRouteTimeout = setTimeout(() => {
          deselectRouteTimeout = null;
          focusModeSelectedNodeId = traceOn && focusModeOn ? currentRouteId : null;
          network.selectNodes([currentRouteId]);
        if (traceOn) {
          if (focusModeOn) renderFocusMode();
          else renderTrace();
        } else {
          sendNodeSelected(currentRouteId);
          const firstNode = nodes.get(currentRouteId);
          if (firstNode && firstNode.isController) {
            showControllerMethodsBar(currentRouteId);
          } else {
            hideControllerMethodsBar();
          }
          const highlighted = new Set([currentRouteId]);
          (network.getConnectedNodes(currentRouteId) || []).forEach(cid => highlighted.add(cid));
          const nodeUpdates = nodes.getIds().map(id => {
            const n = nodes.get(id);
            const o = _originals[id] || {};
            const c = n?.color && typeof n.color === 'object' ? n.color : {};
            const base = { id, label: n?.label ?? id };
            if (id === currentRouteId) {
              return { ...base, opacity: 1, color: { ...c, border: o.border || c.border || '#666' }, borderWidth: o.borderWidth ?? 1.5 };
            } else if (highlighted.has(id)) {
              return { ...base, opacity: 1, color: { ...c, border: 'rgba(255,193,7,0.6)' }, borderWidth: 2.5 };
            } else {
              return { ...base, opacity: 0.2, color: { ...c, border: o.border || c.border || '#666' }, borderWidth: o.borderWidth ?? 1.5 };
            }
          });
          nodes.update(nodeUpdates);
          const edgeUpdates = edges.getIds().map(eid => {
            const e = edges.get(eid);
            if (highlighted.has(e.from) && highlighted.has(e.to)) {
              return { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2 };
            }
            return { id: eid, color: { color: 'rgba(255,255,255,0.04)', highlight: '#FFC107', hover: '#FFC107' }, width: 1 };
          });
          edges.update(edgeUpdates);
        }
        }, 50);
        return;
      }
      if (traceOn) {
        if (focusModeOn) {
          focusModeSelectedNodeId = null;
          renderFocusMode();
        }
        return;
      }
      sendNodeDeselected();
      hideControllerMethodsBar();

      if (focusModeOn) {
        focusModeSelectedNodeId = null;
        renderFocusMode();
        return;
      }

      const nodeRestore = nodes.getIds().map(id => {
        const n = nodes.get(id);
        const o = _originals[id] || {};
        const c = n?.color && typeof n.color === 'object' ? n.color : {};
        return {
          id,
          label: n?.label ?? id,
          opacity: 1,
          color: { ...c, border: o.border || c.border || '#666' },
          borderWidth: o.borderWidth ?? 1.5
        };
      });
      nodes.update(nodeRestore);

      const edgeRestore = edges.getIds().map(id => ({
        id, color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' }, width: 1.5
      }));
      edges.update(edgeRestore);
    });

    network.on('doubleClick', function (params) {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodes.get(nodeId);
        if (node) {
          if (node.shape === 'hexagon') {
            const outEdges = edges.get().filter(e => e.from === nodeId);
            if (outEdges.length > 0) {
              vscode.postMessage({ type: 'cmd:openFile', filePath: outEdges[0].to });
            }
          } else {
            vscode.postMessage({ type: 'cmd:openFile', filePath: nodeId });
          }
        }
        return;
      }
      if (params.edges.length > 0 && params.nodes.length === 0) {
        const edge = edges.get(params.edges[0]);
        if (edge && edge.from && edge.to) {
          network.fit({ nodes: [edge.from, edge.to], animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        traceExpandModal.classList.remove('visible');
      }
    });

    network.on('dragStart', function (params) {
      if (params.nodes.length === 0) return;
      const movable = new Set();
      params.nodes.forEach(id => {
        movable.add(id);
        (network.getConnectedNodes(id) || []).forEach(cid => movable.add(cid));
      });
      const updates = nodes.getIds().map(id => ({ id, fixed: !movable.has(id) }));
      nodes.update(updates);
      network.setOptions({ physics: { enabled: true } });
    });
    network.on('dragEnd', function (params) {
      if (params.nodes.length === 0) return;
      const updates = nodes.getIds().map(id => ({ id, fixed: true }));
      nodes.update(updates);
      network.setOptions({ physics: { enabled: false } });
    });

    document.addEventListener('keydown', (e) => {
      if (!traceOn) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); traceUndoFn(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); traceRedoFn(); }
    });
  }

  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'loadGraphData':
        graphSnapshots = message.graphSnapshots;
        routeNames = message.routeNames;

        if (!network) initNetwork();

        if (routeNames.length > 0) {
          const initialRoute = message.initialRouteId && graphSnapshots[message.initialRouteId]
            ? message.initialRouteId
            : routeNames[0];
          loadApiGraph(initialRoute);
        }
        break;

      case 'showTraceModal':
        openTraceExpandModal();
        break;

      case 'cmd:loadRoute':
        if (graphSnapshots[message.routeId]) loadApiGraph(message.routeId);
        break;

      case 'cmd:focusNode': {
        const nid = message.nodeId;
        if (nodes && nodes.get(nid)) {
          network.selectNodes([nid]);
          network.focus(nid, { scale: 1.2, animation: { duration: 800, easingFunction: 'easeInOutQuad' } });
        }
        break;
      }

      case 'cmd:focusNodeInGraph': {
        const filePath = (message.filePath || '').replace(/\\/g, '/');
        const silent = !!message.silent;
        if (!filePath) break;

        function doFocus(nodeId) {
          if (nodes.get(nodeId)) {
            network.selectNodes([nodeId]);
            network.focus(nodeId, { scale: 1.2, animation: { duration: 800, easingFunction: 'easeInOutQuad' } });
            return true;
          }
          return false;
        }

        if (doFocus(filePath)) break;

        let found = false;
        for (const [routeId, snapshot] of Object.entries(graphSnapshots || {})) {
          const hasNode = (snapshot.nodes || []).some(n => n.id === filePath);
          if (hasNode) {
            found = true;
            loadApiGraph(routeId);
            setTimeout(() => {
              if (!doFocus(filePath) && !silent) {
                vscode.postMessage({ type: 'focusNodeNotFound', filePath });
              }
            }, 3200);
            break;
          }
        }
        if (!found && !silent) {
          vscode.postMessage({ type: 'focusNodeNotFound', filePath });
        }
        break;
      }

      case 'cmd:requestGraphMeta': {
        if (routeNames && routeNames.length > 0 && nodes) {
          const nodeIds = nodes.getIds()
            .filter(id => {
              const n = nodes.get(id);
              return n && n.shape !== 'hexagon';
            })
            .sort((a, b) => a.localeCompare(b));
          vscode.postMessage({ type: 'graphMetaReady', routeNames, nodeIds, currentRouteId });
        }
        break;
      }

      case 'cmd:center':
        if (network) network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
        break;

      case 'cmd:focusModeToggle':
        focusModeOn = message.on;
        focusModeSelectedNodeId = null;
        renderFocusMode();
        if (traceOn) renderTrace();
        break;

      case 'cmd:traceToggle':
        traceOn = message.on;
        if (!traceOn) {
          focusModeOn = false;
          focusModeSelectedNodeId = null;
          renderFocusMode();
        }
        hideControllerMethodsBar();
        if (!traceOn) traceClearFn();
        else renderTrace();
        break;

      case 'cmd:traceUndo':
        traceUndoFn();
        break;

      case 'cmd:traceRedo':
        traceRedoFn();
        break;

      case 'cmd:traceClear':
        traceClearFn();
        break;

      case 'cmd:expandTrace':
        openTraceExpandModal();
        break;

      case 'cmd:nodeSizeScale':
        if (typeof message.scale === 'number') applyNodeSizeScale(message.scale);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
