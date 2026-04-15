(function () {
  const vscode = acquireVsCodeApi();
  const container = document.getElementById('mynetwork');
  const loadingOverlay = document.getElementById('graph-loading-overlay');
  const dropOverlay = document.getElementById('graph-drop-overlay');
  const nodeCountEl = document.getElementById('nodeCount');
  const edgeCountEl = document.getElementById('edgeCount');
  const centerBtn = document.getElementById('centerBtn');
  const connectBtn = document.getElementById('connectBtn');
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
  let connectMode = false;
  let connectFromNodeId = null;
  let dragDepth = 0;
  /** Pending setTimeouts for BFS layer reveal (cleared when switching graphs). */
  let layerRevealTimers = [];
  /** Dynamic zoom bounds adjusted per graph size. */
  let dynamicMinZoom = 0.08;
  let dynamicMaxZoom = 2.2;
  let internalZoomAdjust = false;
  /** User/manual baseline scale (auto-size + cmd:nodeSizeScale update this). */
  let userNodeSizeScale = 1;
  /** rAF batching for zoom-responsive text/node sizing. */
  let zoomReadableScaleRaf = 0;
  /** Stable BFS import level lookup by node id (works for both normal/layered loads). */
  let nodeImportLevelById = Object.create(null);
  /** Keyboard BFS navigation state anchored to currently selected node. */
  let bfsNavAnchorNodeId = null;
  let bfsNavCurrentLevel = null;
  let bfsNavIsActive = false;

  function clearLayerRevealTimers() {
    layerRevealTimers.forEach((id) => clearTimeout(id));
    layerRevealTimers = [];
  }

  function updateZoomBounds(totalNodes) {
    if (totalNodes > 1200) {
      dynamicMinZoom = 0.04;
      dynamicMaxZoom = 1.1;
      return;
    }
    if (totalNodes > 700) {
      dynamicMinZoom = 0.05;
      dynamicMaxZoom = 1.25;
      return;
    }
    if (totalNodes > 350) {
      dynamicMinZoom = 0.06;
      dynamicMaxZoom = 1.45;
      return;
    }
    if (totalNodes > 120) {
      dynamicMinZoom = 0.08;
      dynamicMaxZoom = 1.8;
      return;
    }
    dynamicMinZoom = 0.1;
    dynamicMaxZoom = 2.4;
  }

  function zoomReadableBoost(zoomScale) {
    const z = Math.max(0.02, Number(zoomScale) || 1);
    // When zoomed out, increase node/text size so labels remain readable.
    // When zoomed in, avoid giant labels.
    return Math.max(0.85, Math.min(2.6, Math.pow(1 / z, 0.45)));
  }

  function applyEffectiveNodeScale(effectiveScale) {
    nodeSizeScale = effectiveScale;
    if (!nodes) return;
    nodes.update(
      nodes.getIds().map((id) => {
        const base = baseNodeSizes[id] || { size: 38, fontSize: 18 };
        const n = nodes.get(id);
        const font = n?.font && typeof n.font === 'object' ? n.font : {};
        return { id, size: base.size * effectiveScale, font: { ...font, size: Math.round(base.fontSize * effectiveScale) } };
      })
    );
  }

  function scheduleZoomReadableSizing(zoomScale) {
    if (zoomReadableScaleRaf) cancelAnimationFrame(zoomReadableScaleRaf);
    const boost = zoomReadableBoost(zoomScale);
    const effective = userNodeSizeScale * boost;
    zoomReadableScaleRaf = requestAnimationFrame(() => {
      zoomReadableScaleRaf = 0;
      applyEffectiveNodeScale(effective);
    });
  }

  function getSessionSnapshot(sessionKey, routeId) {
    const s = sessions.get(sessionKey);
    if (!s || !s.graphSnapshots) return null;
    const snap = s.graphSnapshots[routeId];
    return snap || null;
  }

  function normalizeNodePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
  }

  /** Must match initNetwork — reapplied after physics toggles so pan/zoom stay enabled. */
  const NETWORK_INTERACTION = {
    hover: true,
    selectConnectedEdges: false,
    tooltipDelay: 0,
    dragNodes: true,
    dragView: true,
    zoomView: false,
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
        if (activeSessionKey === key) return;
        activeSessionKey = key;
        renderTabBar();
        applyActiveSession();
      });
      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'cmd:saveSession', sourceJsonPath: key, saveToSaved: true });
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
      progressiveReveal:
        message.progressiveReveal !== undefined ? !!message.progressiveReveal : !!prev?.progressiveReveal,
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
          springLength: 250,
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
    if (connectBtn) {
      const updateConnectBtn = () => {
        connectBtn.classList.toggle('active', connectMode);
        if (connectMode && connectFromNodeId) {
          connectBtn.textContent = `Select target for ${connectFromNodeId.split('/').pop() || connectFromNodeId}`;
        } else {
          connectBtn.textContent = connectMode ? 'Connect: pick source node' : 'Connect imports';
        }
      };
      connectBtn.addEventListener('click', () => {
        connectMode = !connectMode;
        connectFromNodeId = null;
        updateConnectBtn();
      });
      updateConnectBtn();
    }
    network.on('selectNode', () => {
      const selectedIds = network.getSelectedNodes();
      if (!selectedIds || selectedIds.length === 0) return;
      const selectedId = selectedIds[0];
      bfsNavAnchorNodeId = selectedId;
      bfsNavCurrentLevel = getNodeImportLevel(selectedId);
      bfsNavIsActive = false;
      if (connectMode && activeSessionKey && currentRouteId) {
        const picked = selectedId;
        if (!connectFromNodeId) {
          connectFromNodeId = picked;
          if (connectBtn) {
            connectBtn.textContent = `Select target for ${picked.split('/').pop() || picked}`;
            connectBtn.classList.add('active');
          }
          return;
        }
        if (connectFromNodeId && connectFromNodeId !== picked) {
          vscode.postMessage({
            type: 'cmd:connectNodes',
            fromNodeId: connectFromNodeId,
            toNodeId: picked,
            routeId: currentRouteId,
            sourceJsonPath: activeSessionKey,
          });
        }
        connectFromNodeId = null;
        connectMode = false;
        if (connectBtn) {
          connectBtn.textContent = 'Connect imports';
          connectBtn.classList.remove('active');
        }
      }
      highlightAround(selectedIds);
    });

    network.on('deselectNode', () => {
      bfsNavAnchorNodeId = null;
      bfsNavCurrentLevel = null;
      bfsNavIsActive = false;
      restoreStyles();
    });
    network.on('hoverNode', (params) => {
      if (!params || !params.node) return;
      highlightEdgesForNodes(new Set([params.node]));
    });
    network.on('blurNode', () => {
      applyCurrentHighlightMode();
    });
    network.on('hoverEdge', (params) => {
      if (!params || !params.edge) return;
      highlightSingleEdge(params.edge);
    });
    network.on('blurEdge', () => {
      applyCurrentHighlightMode();
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
    if (container) {
      // ── Wheel: pan (scroll) or zoom (ctrlKey=pinch via Chromium convention) ──
      container.addEventListener('wheel', (ev) => {
        if (!network) return;
        ev.preventDefault();
        if (ev.ctrlKey) {
          // Chromium fires ctrlKey=true for trackpad pinch gesture
          doZoom(ev.deltaY, ev.clientX, ev.clientY);
        } else {
          // Regular two-finger scroll → pan
          const s = Math.max(0.01, network.getScale() || 1);
          const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
          const pos = network.getViewPosition();
          network.moveTo({
            position: { x: pos.x + (ev.deltaX * unit) / s, y: pos.y + (ev.deltaY * unit) / s },
            scale: s,
            animation: false,
          });
        }
      }, { passive: false });

      // ── Pointer-based pinch: tracks two actual touch/pointer contacts ──
      // Works as fallback when ctrlKey pinch is intercepted by Electron/VS Code.
      const _pinchPointers = new Map();
      let _pinchLastDist = null;
      let _pinchMidClient = null;

      const _pinchDown = (ev) => {
        _pinchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      };
      const _pinchMove = (ev) => {
        if (!_pinchPointers.has(ev.pointerId)) return;
        _pinchPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (_pinchPointers.size !== 2) { _pinchLastDist = null; return; }
        const pts = [..._pinchPointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        _pinchMidClient = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        if (_pinchLastDist !== null && dist > 0) {
          // Direct distance ratio: spread fingers → zoom in (ratio > 1), pinch → zoom out
          doZoomByFactor(dist / _pinchLastDist, _pinchMidClient.x, _pinchMidClient.y);
        }
        _pinchLastDist = dist;
      };
      const _pinchUp = (ev) => {
        _pinchPointers.delete(ev.pointerId);
        if (_pinchPointers.size < 2) { _pinchLastDist = null; _pinchMidClient = null; }
      };
      container.addEventListener('pointerdown', _pinchDown);
      container.addEventListener('pointermove', _pinchMove);
      container.addEventListener('pointerup', _pinchUp);
      container.addEventListener('pointercancel', _pinchUp);
    }

    function doZoom(deltaY, clientX, clientY) {
      // 2x wheel pinch sensitivity from current baseline (0.003 -> 0.006)
      doZoomByFactor(Math.exp(-deltaY * 0.006), clientX, clientY);
    }

    function doZoomByFactor(factor, clientX, clientY) {
      if (!network || !container) return;
      const currentScale = Math.max(0.01, network.getScale() || 1);
      const targetScale = Math.max(dynamicMinZoom, Math.min(dynamicMaxZoom, currentScale * factor));
      if (Math.abs(targetScale - currentScale) < 1e-6) return;

      const rect = container.getBoundingClientRect();
      // Canvas point that should stay fixed under cursor/fingers
      const focusCanvas = network.DOMtoCanvas({ x: clientX - rect.left, y: clientY - rect.top });
      // Current canvas-space view center
      const viewCenter = network.getViewPosition();
      // After scaling by `factor`, shift the center so focusCanvas stays put on screen:
      //   newCenter = focusCanvas + (viewCenter - focusCanvas) / factor
      const f = targetScale / currentScale;
      const newCenter = {
        x: focusCanvas.x + (viewCenter.x - focusCanvas.x) / f,
        y: focusCanvas.y + (viewCenter.y - focusCanvas.y) / f,
      };
      internalZoomAdjust = true;
      network.moveTo({ position: newCenter, scale: targetScale, animation: false });
      setTimeout(() => { internalZoomAdjust = false; }, 0);
      scheduleZoomReadableSizing(targetScale);
    }

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

    function extractDroppedPaths(dt) {
      const payloads = [];
      const files = Array.from(dt.files || []);
      for (const f of files) {
        if (f?.path) payloads.push(f.path);
        if (f?.name) payloads.push(f.name);
      }
      const uriList = dt.getData('text/uri-list');
      if (uriList) {
        uriList.split(/[\r\n]+/).forEach((line) => {
          const s = String(line || '').trim();
          if (s) payloads.push(s);
        });
      }
      const plain = dt.getData('text/plain');
      if (plain) {
        plain.split(/[\r\n]+/).forEach((line) => {
          let s = String(line || '').trim();
          if (!s) return;
          // VS Code sometimes drags as "label\t/path/to/file.ts"
          if (s.includes('\t')) {
            const parts = s.split('\t').map((x) => x.trim()).filter(Boolean);
            s = parts[parts.length - 1] || s;
          }
          if (s) payloads.push(s);
        });
      }
      return [...new Set(payloads.filter(Boolean))];
    }

    function handleGraphDrop(e) {
      if (!activeSessionKey || !currentRouteId) return;
      if (!e.dataTransfer) return;
      let dropX;
      let dropY;
      if (network && container) {
        const rect = container.getBoundingClientRect();
        const dom = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const canvas = network.DOMtoCanvas(dom);
        dropX = canvas.x;
        dropY = canvas.y;
      }
      const deduped = extractDroppedPaths(e.dataTransfer);
      if (deduped.length === 0) {
        vscode.postMessage({
          type: 'cmd:addRecentTreeDrag',
          routeId: currentRouteId,
          sourceJsonPath: activeSessionKey,
          dropX,
          dropY,
        });
        return;
      }
      let i = 0;
      for (const droppedPath of deduped) {
        vscode.postMessage({
          type: 'cmd:addNodeFromDrop',
          droppedPath,
          routeId: currentRouteId,
          sourceJsonPath: activeSessionKey,
          dropX: typeof dropX === 'number' ? dropX + i * 36 : undefined,
          dropY: typeof dropY === 'number' ? dropY + i * 20 : undefined,
        });
        i += 1;
      }
    }

    function showDropOverlay() {
      if (!dropOverlay) return;
      dropOverlay.classList.add('visible');
    }

    function hideDropOverlay() {
      if (!dropOverlay) return;
      dropOverlay.classList.remove('visible');
    }

    if (container) {
      container.addEventListener('contextmenu', onGraphContextMenu, true);
    }

    // Capture drag/drop at page level to prevent VS Code default behavior
    // (opening files) and always route drops into current graph session.
    const onDragEnter = (e) => {
      if (!e.dataTransfer) return;
      dragDepth += 1;
      e.preventDefault();
      e.stopPropagation();
      showDropOverlay();
    };
    const onDragOver = (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      showDropOverlay();
    };
    const onDragLeave = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideDropOverlay();
    };
    const onDrop = (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      hideDropOverlay();
      handleGraphDrop(e);
    };
    window.addEventListener('dragenter', onDragEnter, true);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('dragleave', onDragLeave, true);
    window.addEventListener('drop', onDrop, true);
    document.addEventListener('dragenter', onDragEnter, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('dragleave', onDragLeave, true);
    document.addEventListener('drop', onDrop, true);
    if (dropOverlay) {
      dropOverlay.addEventListener('dragenter', onDragEnter, true);
      dropOverlay.addEventListener('dragover', onDragOver, true);
      dropOverlay.addEventListener('dragleave', onDragLeave, true);
      dropOverlay.addEventListener('drop', onDrop, true);
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
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (isTextInputElement(document.activeElement)) return;
          const direction = e.key === 'ArrowDown' ? 1 : -1;
          if (highlightAdjacentImportLevel(direction)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
          const s = activeSessionKey && sessions.get(activeSessionKey);
          if (s && s.backtrackDirty) {
            e.preventDefault();
            vscode.postMessage({ type: 'cmd:saveSession', sourceJsonPath: activeSessionKey });
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

  function isTextInputElement(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || !!el.isContentEditable;
  }

  function getNodeImportLevel(nodeId) {
    const lv = nodeImportLevelById[nodeId];
    return typeof lv === 'number' ? lv : 0;
  }

  function getImportLevelRange() {
    const levels = Object.values(nodeImportLevelById).filter((v) => typeof v === 'number');
    if (levels.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...levels), max: Math.max(...levels) };
  }

  function highlightAdjacentImportLevel(direction) {
    if (!network || !nodes || !edges) return false;
    const selectedIds = network.getSelectedNodes() || [];
    if (selectedIds.length === 0) return false;

    const selectedId = selectedIds[0];
    const anchorId = bfsNavAnchorNodeId || selectedId;
    const { min, max } = getImportLevelRange();
    const currentLevel =
      typeof bfsNavCurrentLevel === 'number' ? bfsNavCurrentLevel : getNodeImportLevel(selectedId);
    const targetLevel = Math.max(min, Math.min(max, currentLevel + direction));
    if (targetLevel === currentLevel) return false;

    bfsNavAnchorNodeId = anchorId;
    bfsNavCurrentLevel = targetLevel;
    bfsNavIsActive = true;

    return renderBfsLevelHighlight(targetLevel, selectedId);
  }

  function highlightAround(selectedIds) {
    const highlighted = new Set(selectedIds);
    const selectedSet = new Set(selectedIds);
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
        const touchesSelected = selectedSet.has(e.from) || selectedSet.has(e.to);
        if (touchesSelected) {
          return { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2.2 };
        }
        return { id: eid, color: { color: 'rgba(255,255,255,0.04)', highlight: '#FFC107', hover: '#FFC107' }, width: 1 };
      })
    );
  }

  function renderBfsLevelHighlight(targetLevel, selectedId) {
    const ids = nodes.getIds();
    const targetIds = new Set(ids.filter((id) => getNodeImportLevel(id) === targetLevel));
    nodes.update(
      ids.map((id) => {
        const n = nodes.get(id);
        const o = originals[id] || {};
        const c = n?.color && typeof n.color === 'object' ? n.color : {};
        const base = { id, label: n?.label ?? id };
        if (id === selectedId) {
          return {
            ...base,
            opacity: 1,
            color: { ...c, border: o.border || c.border || '#666' },
            borderWidth: Math.max(2.2, o.borderWidth ?? 1.5),
          };
        }
        if (targetIds.has(id)) {
          return {
            ...base,
            opacity: 1,
            color: { ...c, border: '#FFC107' },
            borderWidth: 3,
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
    highlightEdgesForCurrentLevel(targetIds);
    return true;
  }

  function applyCurrentHighlightMode() {
    const selectedIds = network ? network.getSelectedNodes() || [] : [];
    if (selectedIds.length === 0) {
      restoreStyles();
      return;
    }
    const selectedId = selectedIds[0];
    if (bfsNavIsActive && typeof bfsNavCurrentLevel === 'number') {
      renderBfsLevelHighlight(bfsNavCurrentLevel, selectedId);
      return;
    }
    highlightAround(selectedIds);
  }

  function highlightEdgesForNodes(nodeIdSet) {
    edges.update(
      edges.getIds().map((eid) => {
        const e = edges.get(eid);
        if (nodeIdSet.has(e.from) || nodeIdSet.has(e.to)) {
          return { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2.2 };
        }
        return { id: eid, color: { color: 'rgba(255,255,255,0.04)', highlight: '#FFC107', hover: '#FFC107' }, width: 1 };
      })
    );
  }

  function highlightEdgesForCurrentLevel(levelNodeIds) {
    edges.update(
      edges.getIds().map((eid) => {
        const e = edges.get(eid);
        const fromInLevel = levelNodeIds.has(e.from);
        const toInLevel = levelNodeIds.has(e.to);
        if (fromInLevel || toInLevel) {
          return { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2.2 };
        }
        return { id: eid, color: { color: 'rgba(255,255,255,0.04)', highlight: '#FFC107', hover: '#FFC107' }, width: 1 };
      })
    );
  }

  function highlightSingleEdge(edgeId) {
    const hovered = edges.get(edgeId);
    if (!hovered) return;
    const endpointIds = new Set([hovered.from, hovered.to]);
    nodes.update(
      nodes.getIds().map((id) => {
        const n = nodes.get(id);
        const o = originals[id] || {};
        const c = n?.color && typeof n.color === 'object' ? n.color : {};
        const base = { id, label: n?.label ?? id };
        if (endpointIds.has(id)) {
          return { ...base, opacity: 1, color: { ...c, border: '#FFC107' }, borderWidth: 3 };
        }
        return {
          ...base,
          opacity: 0.28,
          color: { ...c, border: o.border || c.border || '#666' },
          borderWidth: o.borderWidth ?? 1.5,
        };
      })
    );
    edges.update(
      edges.getIds().map((eid) =>
        eid === edgeId
          ? { id: eid, color: { color: '#FFC107', highlight: '#FFC107', hover: '#FFC107' }, width: 2.8 }
          : { id: eid, color: { color: 'rgba(255,255,255,0.04)', highlight: '#FFC107', hover: '#FFC107' }, width: 1 }
      )
    );
  }

  function applyNodeSizeScale(scale) {
    userNodeSizeScale = scale;
    const currentZoom = network ? network.getScale() : 1;
    scheduleZoomReadableSizing(currentZoom);
  }

  function computeAutoNodeScale(nodeCount) {
    if (nodeCount > 1200) return 0.72;
    if (nodeCount > 900) return 0.78;
    if (nodeCount > 700) return 0.84;
    if (nodeCount > 500) return 0.9;
    if (nodeCount > 350) return 0.95;
    if (nodeCount > 240) return 0.98;
    if (nodeCount > 150) return 1.02;
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

  /**
   * Seed node coordinates so first paint isn't clumped at the center.
   * Physics then refines from this spread-out baseline.
   */
  function seedInitialNodePositions(items) {
    const count = items.length;
    if (count <= 1) return items;
    const minRadius = 220;
    const perNode = 9;
    const radius = Math.max(minRadius, Math.round((count * perNode) / (2 * Math.PI)));
    return items.map((n, idx) => {
      if (typeof n.x === 'number' && typeof n.y === 'number') return n;
      const angle = (idx / count) * Math.PI * 2;
      return {
        ...n,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });
  }

  function getImportLevel(n) {
    return typeof n.importLevel === 'number' ? n.importLevel : 0;
  }

  /**
   * Rough box width for vis "box" nodes (long file paths need wide spacing or they overlap).
   */
  function estimateLabelBoxWidth(n) {
    const label = String(n.label || n.id || '');
    const len = label.length;
    return Math.max(260, Math.min(720, 12 * len + 120));
  }

  /**
   * If nodes in the same level are linked, spread them vertically in a wave so
   * straight same-level edges are still visible (no curved edge rendering needed).
   */
  function buildSameLevelYOffsetMap(level, nodeList, rawEdges) {
    if (!nodeList || nodeList.length <= 1) return new Map();
    const levelById = new Map(nodeList.map((n) => [n.id, level]));
    const degree = new Map(nodeList.map((n) => [n.id, 0]));
    for (const e of rawEdges || []) {
      const fromLv = levelById.get(e.from);
      const toLv = levelById.get(e.to);
      if (fromLv !== level || toLv !== level) continue;
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
    }
    const linked = nodeList.filter((n) => (degree.get(n.id) || 0) > 0);
    if (linked.length <= 1) return new Map();

    const yOffset = new Map();
    const sorted = [...linked].sort(
      (a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || String(a.id).localeCompare(String(b.id))
    );
    const step = 34;
    sorted.forEach((n, idx) => {
      const band = Math.ceil((idx + 1) / 2);
      const sign = idx % 2 === 0 ? 1 : -1;
      yOffset.set(n.id, sign * band * step);
    });
    return yOffset;
  }

  /**
   * Fixed top-to-bottom layout: level 0 = entry file, then direct imports, etc.
   * Horizontal positions use cumulative widths so adjacent nodes never share the same space.
   * For same-level relations we offset node Y positions (not edge arcs).
   */
  function positionNodesForImportLevel(level, nodeList, rawEdges) {
    const count = nodeList.length;
    const vStep = 190;
    const y = level * vStep;
    if (count === 0) return [];
    const margin = 24;
    const widths = nodeList.map((n) => estimateLabelBoxWidth(n));
    const yOffsetById = buildSameLevelYOffsetMap(level, nodeList, rawEdges);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + (count - 1) * margin;
    let leftEdge = -totalWidth / 2;
    return nodeList.map((n, i) => {
      const w = widths[i];
      const x = leftEdge + w / 2;
      leftEdge += w + margin;
      const yOffset = yOffsetById.get(n.id) || 0;
      const { title: _omitTitle, importLevel: _il, ...rest } = n;
      return { ...rest, x, y: y + yOffset };
    });
  }

  function addEdgesIfBothEndsVisible(rawEdges) {
    const visible = new Set(nodes.getIds());
    for (const e of rawEdges) {
      if (!visible.has(e.from) || !visible.has(e.to)) continue;
      const existing = edges.get({
        filter: (item) => item.from === e.from && item.to === e.to,
      });
      if (existing && existing.length > 0) continue;
      const id = `${e.from}->${e.to}`;
      const { title: _t, ...rest } = e;
      edges.add({ id, ...rest });
    }
  }

  /**
   * Import graphs with importLevel: reveal one BFS layer at a time (no full physics reload).
   */
  function loadGraphLayered(current, routeId, rawEdges) {
    network.setOptions({
      physics: { enabled: false },
      interaction: NETWORK_INTERACTION,
    });
    try {
      network.stopSimulation();
    } catch (e) {
      /* ignore */
    }

    const byLevel = new Map();
    for (const n of current.nodes || []) {
      const lv = getImportLevel(n);
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push(n);
    }
    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    const totalNodes = (current.nodes || []).length;
    const totalEdges = (rawEdges || []).length;
    updateZoomBounds(totalNodes);
    let levelIndex = 0;
    const stepMs = 165;

    const fitMaxZoom =
      totalNodes > 1200 ? 0.15 :
      totalNodes > 700 ? 0.18 :
      totalNodes > 350 ? 0.22 :
      totalNodes > 150 ? 0.28 :
      totalNodes > 60 ? 0.38 :
      0.5;

    const step = () => {
      if (levelIndex >= sortedLevels.length) {
        nodeCountEl.textContent = String(totalNodes);
        edgeCountEl.textContent = String(edges.length);
        const nodeIds = (current.nodes || []).map((n) => n.id).sort((a, b) => a.localeCompare(b));
        vscode.postMessage({ type: 'graphMetaReady', routeNames, nodeIds, currentRouteId: routeId });
        network.fit({ animation: { duration: 380, easingFunction: 'easeInOutQuad' }, maxZoomLevel: fitMaxZoom });
        if (loadingOverlay) loadingOverlay.classList.remove('visible');
        syncNetworkSize();
        return;
      }
      const lv = sortedLevels[levelIndex];
      const batch = byLevel.get(lv) || [];
      const positioned = positionNodesForImportLevel(lv, batch, rawEdges || []);
      nodes.add(positioned);
      addEdgesIfBothEndsVisible(rawEdges || []);
      if (loadingOverlay && levelIndex === 0) loadingOverlay.classList.remove('visible');
      nodeCountEl.textContent = String(nodes.length);
      edgeCountEl.textContent = String(edges.length);
      network.fit({ animation: { duration: 220, easingFunction: 'easeInOutQuad' }, maxZoomLevel: fitMaxZoom });
      levelIndex += 1;
      const tid = setTimeout(step, stepMs);
      layerRevealTimers.push(tid);
    };

    step();
  }

  function loadGraph(routeId) {
    const activeSession = activeSessionKey ? sessions.get(activeSessionKey) : null;
    const snap = graphSnapshots[routeId];
    if (!snap) {
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      return;
    }
    clearLayerRevealTimers();
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
    nodeImportLevelById = Object.create(null);
    (current.nodes || []).forEach((n) => {
      nodeImportLevelById[n.id] = getImportLevel(n);
    });
    bfsNavAnchorNodeId = null;
    bfsNavCurrentLevel = null;
    bfsNavIsActive = false;
    hideNodeInfoPopover();
    nodeTitleById = Object.create(null);
    (current.nodes || []).forEach((n) => {
      nodeTitleById[n.id] = typeof n.title === 'string' ? n.title : '';
    });
    // Omit `title` from the DataSet — vis treats title: '' as a real title and shows the hover popup.
    const nodesForVisRaw = (current.nodes || []).map((n) => {
      const { title: _omitTitle, ...rest } = n;
      return rest;
    });
    const edgesForVis = (current.edges || []).map((e) => {
      const { title: _omitTitle, ...rest } = e;
      return rest;
    });

    currentRouteId = routeId;
    originals = {};
    baseNodeSizes = {};
    (current.nodes || []).forEach((n) => {
      const c = n.color;
      const normalizedBaseSize = Math.min(Math.max(n.size || 42, 42), 64);
      originals[n.id] = {
        border: (c && c.border) || (typeof c === 'string' ? c : '#666'),
        borderWidth: n.borderWidth || 1.5,
      };
      const font = n.font && typeof n.font === 'object' ? n.font : {};
      const normalizedFontSize = Math.min(Math.max(font.size || 20, 18), 28);
      baseNodeSizes[n.id] = { size: normalizedBaseSize, fontSize: normalizedFontSize };
    });

    const totalNodes = (current.nodes || []).length;
    updateZoomBounds(totalNodes);
    const hasImportLevels = (current.nodes || []).some((n) => typeof n.importLevel === 'number');
    const shouldProgressiveReveal = !!(activeSession && activeSession.progressiveReveal);

    if (hasImportLevels && shouldProgressiveReveal && totalNodes > 0) {
      const autoScale = computeAutoNodeScale(totalNodes);
      if (userNodeSizeScale === 1 && autoScale !== 1) {
        applyNodeSizeScale(autoScale);
      } else if (userNodeSizeScale !== 1) {
        applyNodeSizeScale(userNodeSizeScale);
      } else {
        scheduleZoomReadableSizing(network ? network.getScale() : 1);
      }
      loadGraphLayered({ nodes: nodesForVisRaw }, routeId, edgesForVis);
      return;
    }

    const nodesForVis = seedInitialNodePositions(nodesForVisRaw);
    nodes.add(nodesForVis);
    edges.add(edgesForVis);

    nodeCountEl.textContent = String(totalNodes);
    edgeCountEl.textContent = String((current.edges || []).length);
    const nodeIds = (current.nodes || []).map((n) => n.id).sort((a, b) => a.localeCompare(b));
    vscode.postMessage({ type: 'graphMetaReady', routeNames, nodeIds, currentRouteId: routeId });

    const autoScale = computeAutoNodeScale(totalNodes);
    if (userNodeSizeScale === 1 && autoScale !== 1) {
      applyNodeSizeScale(autoScale);
    } else if (userNodeSizeScale !== 1) {
      applyNodeSizeScale(userNodeSizeScale);
    } else {
      scheduleZoomReadableSizing(network ? network.getScale() : 1);
    }

    const fitMaxZoom =
      totalNodes > 1200 ? 0.15 :
      totalNodes > 700 ? 0.18 :
      totalNodes > 350 ? 0.22 :
      totalNodes > 150 ? 0.28 :
      totalNodes > 60 ? 0.38 :
      0.5;
    const stabilizationIterations =
      totalNodes > 1200 ? 2400 :
      totalNodes > 700 ? 1800 :
      totalNodes > 350 ? 1300 :
      totalNodes > 150 ? 900 :
      600;
    const springLength =
      totalNodes > 1200 ? 280 :
      totalNodes > 700 ? 260 :
      totalNodes > 350 ? 240 :
      totalNodes > 150 ? 220 :
      200;
    network.setOptions({
      physics: {
        enabled: true,
        solver: 'barnesHut',
        barnesHut: {
          gravitationalConstant: -50000,
          centralGravity: 0.02,
          springLength,
          springConstant: 0.02,
          damping: 0.45,
          avoidOverlap: 0.35,
        },
        stabilization: { enabled: true, iterations: stabilizationIterations, fit: false },
      },
    });

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
    network.stabilize(stabilizationIterations);
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
      case 'cmd:addNodeApplied': {
        if (!message.sourceJsonPath || !message.routeId || !message.node) break;
        const snap = getSessionSnapshot(message.sourceJsonPath, message.routeId);
        const incomingIdNorm = normalizeNodePath(message.node.id);
        if (snap && !snap.nodes.some((n) => normalizeNodePath(n.id) === incomingIdNorm)) {
          snap.nodes.push(message.node);
        }
        if (
          activeSessionKey === message.sourceJsonPath &&
          currentRouteId === message.routeId &&
          nodes &&
          nodes.getIds().every((id) => normalizeNodePath(id) !== incomingIdNorm)
        ) {
          const { title: _omitTitle, ...rest } = message.node;
          nodes.add(rest);
          const c = message.node.color;
          const normalizedBaseSize = Math.min(Math.max(message.node.size || 42, 42), 64);
          originals[message.node.id] = {
            border: (c && c.border) || (typeof c === 'string' ? c : '#666'),
            borderWidth: message.node.borderWidth || 1.5,
          };
          const font = message.node.font && typeof message.node.font === 'object' ? message.node.font : {};
          const normalizedFontSize = Math.min(Math.max(font.size || 20, 18), 28);
          baseNodeSizes[message.node.id] = { size: normalizedBaseSize, fontSize: normalizedFontSize };
          nodeTitleById[message.node.id] = typeof message.node.title === 'string' ? message.node.title : '';
          if (nodeCountEl) nodeCountEl.textContent = String(nodes.length);
        }
        break;
      }
      case 'cmd:addEdgeApplied': {
        if (!message.sourceJsonPath || !message.routeId || !message.edge) break;
        const snap = getSessionSnapshot(message.sourceJsonPath, message.routeId);
        if (
          snap &&
          !snap.edges.some((e) => e.from === message.edge.from && e.to === message.edge.to)
        ) {
          snap.edges.push(message.edge);
        }
        if (activeSessionKey === message.sourceJsonPath && currentRouteId === message.routeId && edges) {
          const edgeId = `${message.edge.from}->${message.edge.to}`;
          const existing = edges.get({
            filter: (e) => e.from === message.edge.from && e.to === message.edge.to,
          });
          if (!existing || existing.length === 0) {
            edges.add({ id: edgeId, ...message.edge });
            if (edgeCountEl) edgeCountEl.textContent = String(edges.length);
          }
        }
        break;
      }
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
