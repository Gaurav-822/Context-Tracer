(function () {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('mynetwork');
  const loadingOverlay = document.getElementById('graph-loading-overlay');
  const nodeCountEl = document.getElementById('nodeCount');
  const edgeCountEl = document.getElementById('edgeCount');
  const centerBtn = document.getElementById('centerBtn');
  const tabBar = document.getElementById('graph-tab-bar');
  const nodeInfoPopover = document.getElementById('nodeInfoPopover');
  const nodeInfoTitle = document.getElementById('nodeInfoTitle');
  const nodeInfoPath = document.getElementById('nodeInfoPath');
  const nodeInfoBody = document.getElementById('nodeInfoBody');
  const nodeInfoClose = document.getElementById('nodeInfoClose');
  const nodeInfoBacktrack = document.getElementById('nodeInfoBacktrack');

  /** @type {Map<string, { graphSnapshots: object, routeNames: string[], initialRouteId?: string }>} */
  const sessions = new Map();
  /** Tab order (sourceJsonPath keys) */
  let sessionOrder = [];
  let activeSessionKey = null;

  let graphSnapshots = {};
  let routeNames = [];
  let currentRouteId = null;
  let network = null;
  let nodes = null;
  let edges = null;
  let nodeSizeScale = 1;
  let originals = {};
  let baseNodeSizes = {};
  /** Full tooltip text from graph JSON (hover disabled; details via right-click). */
  let nodeTitleById = Object.create(null);
  let lastInfoNodeId = null;

  /** Must match initNetwork — reapplied after physics toggles so pan/zoom stay enabled. */
  const NETWORK_INTERACTION = {
    hover: false,
    selectConnectedEdges: true,
    tooltipDelay: 0,
    dragNodes: true,
    dragView: true,
    zoomView: true,
    multiselect: true,
  };

  function syncNetworkSize() {
    if (!network || !container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;
    try {
      network.setSize(`${w}px`, `${h}px`);
      network.setOptions({ interaction: NETWORK_INTERACTION });
      network.redraw();
    } catch (e) {
      /* ignore */
    }
  }

  function fileBasename(p) {
    const s = String(p).replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    const base = i >= 0 ? s.slice(i + 1) : s;
    return base.replace(/\.json$/i, '') || base;
  }

  function labelForSession(key) {
    const s = sessions.get(key);
    if (!s) return fileBasename(key);
    const imp = (s.routeNames || []).find((r) => r.startsWith('Import:'));
    const short = imp ? imp.replace(/^Import:\s*/, '').trim() : fileBasename(key);
    return short.length > 30 ? `${short.slice(0, 27)}…` : short;
  }

  function renderTabBar() {
    if (!tabBar) return;
    tabBar.innerHTML = '';
    sessionOrder.forEach((key) => {
      const s = sessions.get(key);
      const tab = document.createElement('button');
      tab.type = 'button';
      let tabCls = 'graph-tab' + (key === activeSessionKey ? ' active' : '');
      if (s && s.isBacktrackSession) tabCls += ' graph-tab--backtrack';
      tab.className = tabCls;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', key === activeSessionKey ? 'true' : 'false');
      if (s && s.backtrackDirty) {
        const dirtyDot = document.createElement('span');
        dirtyDot.className = 'graph-tab-dirty';
        dirtyDot.title = 'Not saved — press Ctrl+S or click tab to save';
        tab.appendChild(dirtyDot);
      }
      const label = document.createElement('span');
      label.className = 'graph-tab-label';
      label.textContent = (s && s.displayLabel) || labelForSession(key);
      tab.appendChild(label);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'graph-tab-close';
      close.setAttribute('aria-label', `Close ${labelForSession(key)}`);
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        sessions.delete(key);
        sessionOrder = sessionOrder.filter((k) => k !== key);
        if (activeSessionKey === key) {
          activeSessionKey = sessionOrder.length ? sessionOrder[sessionOrder.length - 1] : null;
        }
        renderTabBar();
        if (activeSessionKey) {
          applyActiveSession();
        } else {
          graphSnapshots = {};
          routeNames = [];
          currentRouteId = null;
          hideNodeInfoPopover();
          if (nodes) nodes.clear();
          if (edges) edges.clear();
          if (nodeCountEl) nodeCountEl.textContent = '0';
          if (edgeCountEl) edgeCountEl.textContent = '0';
          if (loadingOverlay) loadingOverlay.classList.remove('visible');
        }
      });
      tab.appendChild(close);
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        const sess = sessions.get(key);
        if (activeSessionKey === key) {
          if (sess && sess.isBacktrackSession && sess.backtrackDirty) {
            vscode.postMessage({ type: 'cmd:saveBacktrackPrompt', sourceJsonPath: key });
          }
          return;
        }
        activeSessionKey = key;
        renderTabBar();
        applyActiveSession();
      });
      tabBar.appendChild(tab);
    });
  }

  function applyActiveSession() {
    const s = activeSessionKey ? sessions.get(activeSessionKey) : null;
    if (!s || !container) return;
    graphSnapshots = s.graphSnapshots || {};
    routeNames = s.routeNames || [];
    if (!network) initNetwork();
    syncNetworkSize();
    if (routeNames.length === 0) {
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      return;
    }
    const initial =
      s.initialRouteId && graphSnapshots[s.initialRouteId]
        ? s.initialRouteId
        : routeNames[0];
    loadGraph(initial);
  }

  function handleUpsertSession(message) {
    const { sourceJsonPath, graphSnapshots: gs, routeNames: rn, initialRouteId: ir } = message;
    const prev = sessions.get(sourceJsonPath);
    sessions.set(sourceJsonPath, {
      graphSnapshots: gs || {},
      routeNames: rn || [],
      initialRouteId: ir,
      isBacktrackSession:
        message.isBacktrackSession !== undefined ? !!message.isBacktrackSession : !!prev?.isBacktrackSession,
      backtrackDirty: message.backtrackDirty !== undefined ? !!message.backtrackDirty : !!prev?.backtrackDirty,
      displayLabel: message.displayLabel !== undefined ? message.displayLabel : prev?.displayLabel,
    });
    if (!sessionOrder.includes(sourceJsonPath)) sessionOrder.push(sourceJsonPath);
    activeSessionKey = sourceJsonPath;
    renderTabBar();
    applyActiveSession();
  }

  function initNetwork() {
    nodes = new vis.DataSet([]);
    edges = new vis.DataSet([]);
    network = new vis.Network(container, { nodes, edges }, {
      physics: {
        enabled: true,
        solver: 'barnesHut',
        barnesHut: {
          gravitationalConstant: -50000,
          centralGravity: 0.02,
          springLength: 320,
          springConstant: 0.02,
          damping: 0.45,
        },
        stabilization: { enabled: true, iterations: 400, fit: true },
      },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.5 } } },
      interaction: NETWORK_INTERACTION,
    });

    if (typeof ResizeObserver !== 'undefined' && container) {
      const ro = new ResizeObserver(() => {
        syncNetworkSize();
      });
      ro.observe(container);
      const canvas = container.querySelector('.vis-network canvas');
      if (canvas) ro.observe(canvas);
    }
    syncNetworkSize();
    window.addEventListener('resize', () => {
      syncNetworkSize();
    });

    if (centerBtn) {
      centerBtn.addEventListener('click', () => {
        network.fit({ animation: { duration: 450, easingFunction: 'easeInOutQuad' } });
      });
    }

    network.on('selectNode', () => {
      const selectedIds = network.getSelectedNodes();
      if (!selectedIds || selectedIds.length === 0) return;
      highlightAround(selectedIds);
    });

    network.on('deselectNode', () => {
      restoreStyles();
    });

    network.on('doubleClick', (params) => {
      if (!params.nodes || params.nodes.length === 0) return;
      hideNodeInfoPopover();
      vscode.postMessage({ type: 'cmd:openFile', filePath: params.nodes[0] });
    });

    network.on('click', (params) => {
      if (!params.nodes || params.nodes.length === 0) {
        hideNodeInfoPopover();
      }
    });

    /** Right-click / two-finger click (Mac trackpad) opens node details + backtrack. */
    function onGraphContextMenu(e) {
      if (!network || !container) return;
      const data = getCanvasRelativePointerForContextMenu(e);
      if (!data) return;
      const nodeId = network.getNodeAt(data.pointer);
      if (nodeId === undefined || nodeId === null) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeInfoPopover(nodeId, data.dom);
    }

    if (container) {
      container.addEventListener('contextmenu', onGraphContextMenu, true);
    }

    if (nodeInfoClose) {
      nodeInfoClose.addEventListener('click', (e) => {
        e.stopPropagation();
        hideNodeInfoPopover();
      });
    }
    if (nodeInfoBacktrack) {
      nodeInfoBacktrack.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!lastInfoNodeId) return;
        vscode.postMessage({
          type: 'cmd:backtrack',
          nodeId: lastInfoNodeId,
          routeId: currentRouteId,
          sourceJsonPath: activeSessionKey,
        });
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideNodeInfoPopover();
    });
    window.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          const s = activeSessionKey && sessions.get(activeSessionKey);
          if (s && s.isBacktrackSession && s.backtrackDirty) {
            e.preventDefault();
            vscode.postMessage({ type: 'cmd:saveBacktrack', sourceJsonPath: activeSessionKey });
          }
        }
      },
      true
    );
  }

  function getCanvasRelativePointerForContextMenu(e) {
    const canvas = container && container.querySelector('.vis-network canvas');
    if (!canvas) return null;
    const cx = e.clientX;
    const cy = e.clientY;
    if (cx === undefined || cy === undefined) return null;
    const rect = canvas.getBoundingClientRect();
    const pointer = { x: cx - rect.left, y: cy - rect.top };
    return { pointer, dom: { x: pointer.x, y: pointer.y } };
  }

  function hideNodeInfoPopover() {
    lastInfoNodeId = null;
    if (nodeInfoPopover) nodeInfoPopover.style.display = 'none';
  }

  function positionNodeInfoPopover(dom) {
    if (!nodeInfoPopover || !container || !dom) return;
    nodeInfoPopover.style.display = 'block';
    const rect = container.getBoundingClientRect();
    let left = rect.left + dom.x + 12;
    let top = rect.top + dom.y + 12;
    const margin = 8;
    const w = nodeInfoPopover.offsetWidth;
    const h = nodeInfoPopover.offsetHeight;
    left = Math.min(left, window.innerWidth - w - margin);
    left = Math.max(margin, left);
    top = Math.min(top, window.innerHeight - h - margin);
    top = Math.max(margin, top);
    nodeInfoPopover.style.left = `${left}px`;
    nodeInfoPopover.style.top = `${top}px`;
  }

  function parseTooltipSections(raw) {
    const text = String(raw || '');
    const lines = text.split('\n');
    let summary = '';
    let packages = '';
    let inSummary = false;
    let inPackages = false;
    for (const line of lines) {
      if (line.startsWith('What it does:')) {
        inSummary = true;
        inPackages = false;
        continue;
      }
      if (line.startsWith('NPM Packages:')) {
        inPackages = true;
        inSummary = false;
        continue;
      }
      if (inSummary) summary += (summary ? ' ' : '') + line.trim();
      if (inPackages) packages += (packages ? ', ' : '') + line.trim();
    }
    const bodyParts = [];
    if (summary) bodyParts.push(summary);
    else if (text.trim()) bodyParts.push(text.trim());
    else bodyParts.push('(No description)');
    if (packages && packages !== 'None') {
      bodyParts.push('');
      bodyParts.push('Packages: ' + packages);
    }
    return bodyParts.join('\n');
  }

  function showNodeInfoPopover(nodeId, dom) {
    if (!nodeInfoPopover || !nodes) return;
    lastInfoNodeId = nodeId;
    const n = nodes.get(nodeId);
    const label = n && n.label ? String(n.label) : nodeId;
    if (nodeInfoTitle) nodeInfoTitle.textContent = label;
    if (nodeInfoPath) nodeInfoPath.textContent = nodeId;
    if (nodeInfoBody) nodeInfoBody.textContent = parseTooltipSections(nodeTitleById[nodeId]);
    positionNodeInfoPopover(dom || { x: 24, y: 24 });
  }

  function restoreStyles() {
    const nodeRestore = nodes.getIds().map((id) => {
      const n = nodes.get(id);
      const o = originals[id] || {};
      const c = n?.color && typeof n.color === 'object' ? n.color : {};
      return {
        id,
        label: n?.label ?? id,
        opacity: 1,
        color: { ...c, border: o.border || c.border || '#666' },
        borderWidth: o.borderWidth ?? 1.5,
      };
    });
    nodes.update(nodeRestore);
    const edgeRestore = edges.getIds().map((id) => ({
      id,
      color: { color: 'rgba(255,255,255,0.15)', highlight: '#FFC107', hover: '#FFC107' },
      width: 1.5,
    }));
    edges.update(edgeRestore);
  }

  function highlightAround(selectedIds) {
    const highlighted = new Set(selectedIds);
    selectedIds.forEach((id) => {
      (network.getConnectedNodes(id) || []).forEach((cid) => highlighted.add(cid));
    });
    nodes.update(
      nodes.getIds().map((id) => {
        const n = nodes.get(id);
        const o = originals[id] || {};
        const c = n?.color && typeof n.color === 'object' ? n.color : {};
        const base = { id, label: n?.label ?? id };
        if (selectedIds.includes(id)) {
          return {
            ...base,
            opacity: 1,
            color: { ...c, border: o.border || c.border || '#666' },
            borderWidth: o.borderWidth ?? 1.5,
          };
        }
        if (highlighted.has(id)) {
          return {
            ...base,
            opacity: 1,
            color: { ...c, border: 'rgba(255,193,7,0.6)' },
            borderWidth: 2.5,
          };
        }
        return {
          ...base,
          opacity: 0.2,
          color: { ...c, border: o.border || c.border || '#666' },
          borderWidth: o.borderWidth ?? 1.5,
        };
      })
    );
    edges.update(
      edges.getIds().map((eid) => {
        const e = edges.get(eid);
        if (highlighted.has(e.from) && highlighted.has(e.to)) {
          return { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2 };
        }
        return { id: eid, color: { color: 'rgba(255,255,255,0.04)' }, width: 1 };
      })
    );
  }

  function applyNodeSizeScale(scale) {
    nodeSizeScale = scale;
    if (!nodes) return;
    nodes.update(
      nodes.getIds().map((id) => {
        const base = baseNodeSizes[id] || { size: 38, fontSize: 18 };
        const n = nodes.get(id);
        const font = n?.font && typeof n.font === 'object' ? n.font : {};
        return { id, size: base.size * scale, font: { ...font, size: Math.round(base.fontSize * scale) } };
      })
    );
  }

  function computeAutoNodeScale(nodeCount) {
    if (nodeCount > 1200) return 0.34;
    if (nodeCount > 900) return 0.4;
    if (nodeCount > 700) return 0.48;
    if (nodeCount > 500) return 0.56;
    if (nodeCount > 350) return 0.66;
    if (nodeCount > 240) return 0.76;
    if (nodeCount > 150) return 0.86;
    if (nodeCount > 40) return 0.72;
    if (nodeCount > 25) return 0.84;
    return 1;
  }

  function stripEntryNodes(snapshot) {
    const entryIds = new Set((snapshot.nodes || []).filter((n) => n.shape === 'hexagon').map((n) => n.id));
    if (entryIds.size === 0) return snapshot;
    return {
      ...snapshot,
      nodes: (snapshot.nodes || []).filter((n) => !entryIds.has(n.id)),
      edges: (snapshot.edges || []).filter((e) => !entryIds.has(e.from) && !entryIds.has(e.to)),
    };
  }

  function loadGraph(routeId) {
    const snap = graphSnapshots[routeId];
    if (!snap) {
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      return;
    }
    if (loadingOverlay) loadingOverlay.classList.add('visible');
    try {
      network.stopSimulation();
    } catch (e) {
      /* ignore */
    }
    network.setOptions({ physics: { enabled: true } });
    network.setOptions({ interaction: NETWORK_INTERACTION });
    nodes.clear();
    edges.clear();

    const current = stripEntryNodes(snap);
    hideNodeInfoPopover();
    nodeTitleById = Object.create(null);
    (current.nodes || []).forEach((n) => {
      nodeTitleById[n.id] = typeof n.title === 'string' ? n.title : '';
    });
    // Omit `title` from the DataSet — vis treats title: '' as a real title and shows the hover popup.
    const nodesForVis = (current.nodes || []).map((n) => {
      const { title: _omitTitle, ...rest } = n;
      return rest;
    });
    const edgesForVis = (current.edges || []).map((e) => {
      const { title: _omitTitle, ...rest } = e;
      return rest;
    });
    nodes.add(nodesForVis);
    edges.add(edgesForVis);
    currentRouteId = routeId;
    originals = {};
    baseNodeSizes = {};
    (current.nodes || []).forEach((n) => {
      const c = n.color;
      const normalizedBaseSize = Math.min(n.size || 38, 24);
      originals[n.id] = {
        border: (c && c.border) || (typeof c === 'string' ? c : '#666'),
        borderWidth: n.borderWidth || 1.5,
      };
      const font = n.font && typeof n.font === 'object' ? n.font : {};
      const normalizedFontSize = Math.min(font.size || 18, 13);
      baseNodeSizes[n.id] = { size: normalizedBaseSize, fontSize: normalizedFontSize };
    });

    const totalNodes = (current.nodes || []).length;
    nodeCountEl.textContent = String(totalNodes);
    edgeCountEl.textContent = String((current.edges || []).length);
    const nodeIds = (current.nodes || []).map((n) => n.id).sort((a, b) => a.localeCompare(b));
    vscode.postMessage({ type: 'graphMetaReady', routeNames, nodeIds, currentRouteId: routeId });

    const autoScale = computeAutoNodeScale(totalNodes);
    if (nodeSizeScale === 1 && autoScale !== 1) {
      applyNodeSizeScale(autoScale);
    } else if (nodeSizeScale !== 1) {
      applyNodeSizeScale(nodeSizeScale);
    }

    const fitMaxZoom =
      totalNodes > 1200 ? 0.15 :
      totalNodes > 700 ? 0.18 :
      totalNodes > 350 ? 0.22 :
      totalNodes > 150 ? 0.28 :
      totalNodes > 60 ? 0.38 :
      0.5;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      network.setOptions({ physics: { enabled: false } });
      network.setOptions({ interaction: NETWORK_INTERACTION });
      network.fit({ animation: false, maxZoomLevel: fitMaxZoom });
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      syncNetworkSize();
    };

    const finishAfterTimeout = () => {
      if (done) return;
      // If stabilization is still running, don't freeze a clumped layout.
      // Keep interaction enabled and hide the overlay; stabilization events will call finish.
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      syncNetworkSize();
    };
    network.once('stabilizationIterationsDone', finish);
    network.once('stabilized', finish);
    network.stabilize();
    setTimeout(finishAfterTimeout, 4000);
  }

  function focusNodeInGraph(filePath, silent) {
    const target = String(filePath || '').replace(/\\/g, '/');
    if (!target) return;
    const doFocus = (id) => {
      if (!nodes.get(id)) return false;
      network.selectNodes([id]);
      network.focus(id, { scale: 1.2, animation: { duration: 800, easingFunction: 'easeInOutQuad' } });
      return true;
    };
    if (doFocus(target)) return;
    let foundRoute = null;
    for (const [rid, snapshot] of Object.entries(graphSnapshots || {})) {
      if ((snapshot.nodes || []).some((n) => n.id === target)) {
        foundRoute = rid;
        break;
      }
    }
    if (!foundRoute) {
      if (!silent) vscode.postMessage({ type: 'focusNodeNotFound', filePath: target });
      return;
    }
    loadGraph(foundRoute);
    setTimeout(() => {
      if (!doFocus(target) && !silent) {
        vscode.postMessage({ type: 'focusNodeNotFound', filePath: target });
      }
    }, 2400);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'upsertSession':
        handleUpsertSession(message);
        break;
      case 'sessionState': {
        const ent = sessions.get(message.sourceJsonPath);
        if (ent) {
          if (message.isBacktrackSession !== undefined) ent.isBacktrackSession = !!message.isBacktrackSession;
          if (message.backtrackDirty !== undefined) ent.backtrackDirty = !!message.backtrackDirty;
          if (message.displayLabel !== undefined) ent.displayLabel = message.displayLabel;
          renderTabBar();
        }
        break;
      }
      case 'loadGraphData':
        graphSnapshots = message.graphSnapshots || {};
        routeNames = message.routeNames || [];
        if (!network) initNetwork();
        if (routeNames.length > 0) {
          const initial =
            message.initialRouteId && graphSnapshots[message.initialRouteId]
              ? message.initialRouteId
              : routeNames[0];
          loadGraph(initial);
        } else if (loadingOverlay) {
          loadingOverlay.classList.remove('visible');
        }
        break;
      case 'cmd:loadRoute':
        if (graphSnapshots[message.routeId]) loadGraph(message.routeId);
        break;
      case 'cmd:focusNode':
        if (nodes && nodes.get(message.nodeId)) {
          network.selectNodes([message.nodeId]);
          network.focus(message.nodeId, { scale: 1.2, animation: { duration: 800, easingFunction: 'easeInOutQuad' } });
        }
        break;
      case 'cmd:focusNodeInGraph':
        focusNodeInGraph(message.filePath, !!message.silent);
        break;
      case 'cmd:requestGraphMeta':
        if (nodes) {
          const nodeIds = nodes.getIds().sort((a, b) => a.localeCompare(b));
          vscode.postMessage({ type: 'graphMetaReady', routeNames, nodeIds, currentRouteId });
        }
        break;
      case 'cmd:center':
        if (network) network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
        break;
      case 'cmd:nodeSizeScale':
        if (typeof message.scale === 'number') applyNodeSizeScale(message.scale);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
