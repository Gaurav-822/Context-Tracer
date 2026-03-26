(function () {
  const vscode = acquireVsCodeApi();

  // ── DOM refs ──────────────────────────────────────────────────────────
  const generateBtn    = document.getElementById('generateBtn');
  const routeSearch    = document.getElementById('routeSearch');
  const routeDropdown  = document.getElementById('routeDropdown');
  const nodeSearch     = document.getElementById('nodeSearch');
  const nodeDropdown   = document.getElementById('nodeDropdown');
  const traceToggle    = document.getElementById('traceToggle');
  const focusModeToggle = document.getElementById('focusModeToggle');
  const useAiToggle    = document.getElementById('useAiToggle');
  const traceControls  = document.getElementById('traceControls');
  const traceUndo      = document.getElementById('traceUndo');
  const traceRedo      = document.getElementById('traceRedo');
  const traceClear     = document.getElementById('traceClear');
  const traceMiniGraph = document.getElementById('traceMiniGraph');
  const traceMiniEmpty = document.getElementById('traceMiniEmpty');
  const traceExpandBtn = document.getElementById('traceExpandBtn');
  const nodeInfo       = document.getElementById('nodeInfo');
  const nodeInfoBadge  = document.getElementById('nodeInfoBadge');
  const nodeInfoName   = document.getElementById('nodeInfoName');
  const nodeInfoSummary = document.getElementById('nodeInfoSummary');
  const nodeInfoPackages = document.getElementById('nodeInfoPackages');
  const nodeInfoOpen   = document.getElementById('nodeInfoOpen');
  const nodeSizeSlider = document.getElementById('nodeSizeSlider');
  const nodeSizeValue  = document.getElementById('nodeSizeValue');
  const autoFollowToggle = document.getElementById('autoFollowToggle');

  let traceOn = false;
  let traceMiniNetwork = null;
  let currentSelectedNodeId = null;
  // ── Generate / Update button ──────────────────────────────────────────
  generateBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cmd:runMapper' });
  });

  // ── Use AI toggle (Trace Graph - separate from Build From File) ────────
  if (useAiToggle) {
    useAiToggle.addEventListener('click', () => {
      vscode.postMessage({ type: 'cmd:toggleTraceGraphLlm' });
    });
  }

  // ── File drop zone: build graph from file ──────────────────────────────
  // ── Custom searchable dropdown helper ─────────────────────────────────
  function makeSearchDropdown(input, dropdown, allItems, onSelect, options) {
    const clearOnFocus = options && options.clearOnFocus;
    let isOpen = false;
    let highlightIdx = -1;

    function renderItems(items) {
      dropdown.innerHTML = '';
      if (items.length === 0) {
        dropdown.style.display = 'none';
        isOpen = false;
        return;
      }
      items.forEach((item, i) => {
        const el = document.createElement('div');
        el.className = 'search-option';
        el.textContent = item;
        el.setAttribute('data-value', item);
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          selectItem(item);
        });
        dropdown.appendChild(el);
      });
      dropdown.style.display = 'block';
      isOpen = true;
      highlightIdx = -1;
    }

    function filterAndRender(query) {
      const q = query.toLowerCase().trim();
      const filtered = q
        ? allItems.filter(it => it.toLowerCase().includes(q)).slice(0, 80)
        : allItems.slice(0, 80);
      renderItems(filtered);
    }

    function selectItem(value) {
      input.value = value;
      dropdown.style.display = 'none';
      isOpen = false;
      onSelect(value);
    }

    function setHighlight(idx) {
      const opts = dropdown.querySelectorAll('.search-option');
      opts.forEach((el, i) => el.classList.toggle('highlighted', i === idx));
      if (opts[idx]) opts[idx].scrollIntoView({ block: 'nearest' });
      highlightIdx = idx;
    }

    input.addEventListener('focus', () => {
      if (clearOnFocus) {
        input.value = '';
      }
      filterAndRender(input.value);
    });

    if (clearOnFocus) {
      input.addEventListener('click', () => {
        input.value = '';
        filterAndRender(input.value);
      });
    }

    input.addEventListener('input', () => {
      filterAndRender(input.value);
    });

    input.addEventListener('keydown', (e) => {
      if (!isOpen) return;
      const opts = dropdown.querySelectorAll('.search-option');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(Math.min(highlightIdx + 1, opts.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight(Math.max(highlightIdx - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIdx >= 0 && opts[highlightIdx]) {
          selectItem(opts[highlightIdx].getAttribute('data-value'));
        }
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        isOpen = false;
      }
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        dropdown.style.display = 'none';
        isOpen = false;
      }, 150);
    });

    return {
      setItems(items) {
        allItems.length = 0;
        allItems.push(...items);
      }
    };
  }

  let routeItems = [];
  let nodeItems = [];

  const routeDropdownCtrl = makeSearchDropdown(routeSearch, routeDropdown, routeItems, (value) => {
    vscode.postMessage({ type: 'cmd:loadRoute', routeId: value });
  }, { clearOnFocus: true });

  const nodeDropdownCtrl = makeSearchDropdown(nodeSearch, nodeDropdown, nodeItems, (value) => {
    vscode.postMessage({ type: 'cmd:focusNode', nodeId: value });
  });

  // ── Node info: open file button ───────────────────────────────────────
  nodeInfoOpen.addEventListener('click', () => {
    if (currentSelectedNodeId) {
      vscode.postMessage({ type: 'cmd:openFile', filePath: currentSelectedNodeId });
    }
  });

  // ── Local Vision toggle (inside trace controls, only when Path Trace is ON) ─
  if (focusModeToggle) {
    focusModeToggle.addEventListener('click', () => {
      const on = focusModeToggle.classList.contains('off');
      focusModeToggle.textContent = on ? 'ON' : 'OFF';
      focusModeToggle.classList.toggle('on',  on);
      focusModeToggle.classList.toggle('off', !on);
      vscode.postMessage({ type: 'cmd:focusModeToggle', on });
    });
  }

  // ── Trace toggle ──────────────────────────────────────────────────────
  traceToggle.addEventListener('click', () => {
    traceOn = !traceOn;
    traceToggle.textContent = traceOn ? 'ON' : 'OFF';
    traceToggle.classList.toggle('on',  traceOn);
    traceToggle.classList.toggle('off', !traceOn);
    traceControls.style.display = traceOn ? 'block' : 'none';
    if (!traceOn && focusModeToggle) {
      focusModeToggle.textContent = 'OFF';
      focusModeToggle.classList.remove('on');
      focusModeToggle.classList.add('off');
      vscode.postMessage({ type: 'cmd:focusModeToggle', on: false });
    }
    vscode.postMessage({ type: 'cmd:traceToggle', on: traceOn });
  });

  traceUndo.addEventListener('click', () => vscode.postMessage({ type: 'cmd:traceUndo' }));
  traceRedo.addEventListener('click', () => vscode.postMessage({ type: 'cmd:traceRedo' }));
  traceClear.addEventListener('click', () => vscode.postMessage({ type: 'cmd:traceClear' }));
  traceExpandBtn.addEventListener('click', () => vscode.postMessage({ type: 'cmd:expandTrace' }));

  if (nodeSizeSlider) {
    nodeSizeSlider.addEventListener('input', () => {
      const val = parseInt(nodeSizeSlider.value, 10);
      if (nodeSizeValue) nodeSizeValue.textContent = val + '%';
      vscode.postMessage({ type: 'cmd:nodeSizeScale', scale: val / 100 });
    });
  }
  if (autoFollowToggle) {
    autoFollowToggle.addEventListener('click', () => {
      const on = autoFollowToggle.classList.contains('off');
      autoFollowToggle.textContent = on ? 'ON' : 'OFF';
      autoFollowToggle.classList.toggle('on', on);
      autoFollowToggle.classList.toggle('off', !on);
      vscode.postMessage({ type: 'cmd:autoFollowToggle', on });
    });
  }

  // ── Messages from extension ───────────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;

    switch (msg.type) {

      case 'generateBtnState':
        generateBtn.textContent = msg.jsonExists ? 'Update Graph' : 'Generate Graph';
        break;

      case 'useLlmState':
        if (useAiToggle) {
          const on = !!msg.useLlm;
          useAiToggle.textContent = on ? 'ON' : 'OFF';
          useAiToggle.classList.toggle('on', on);
          useAiToggle.classList.toggle('off', !on);
        }
        break;

      case 'autoFollowState':
        if (autoFollowToggle) {
          const on = !!msg.on;
          autoFollowToggle.textContent = on ? 'ON' : 'OFF';
          autoFollowToggle.classList.toggle('on', on);
          autoFollowToggle.classList.toggle('off', !on);
        }
        break;

      case 'graphMeta': {
        routeItems.length = 0;
        routeItems.push(...(msg.routeNames || []));
        const routeNames = msg.routeNames || [];
        const currentRouteId = msg.currentRouteId;
        if (routeNames.length > 0) {
          routeSearch.value = (currentRouteId && routeNames.includes(currentRouteId)) ? currentRouteId : routeNames[0];
        } else {
          routeSearch.value = '';
        }

        nodeItems.length = 0;
        nodeItems.push(...(msg.nodeIds || []));
        nodeSearch.value = '';

        traceOn = false;
        traceToggle.textContent = 'OFF';
        traceToggle.classList.remove('on');
        traceToggle.classList.add('off');
        traceControls.style.display = 'none';
        if (focusModeToggle) {
          focusModeToggle.textContent = 'OFF';
          focusModeToggle.classList.remove('on');
          focusModeToggle.classList.add('off');
        }
        clearMiniGraph();
        hideNodeInfo();
        break;
      }

      case 'nodeSelected': {
        currentSelectedNodeId = msg.openableFilePath ?? msg.nodeId;
        const badgeColors = {
          route: '#43A047', controller: '#7B1FA2', file: '#1E88E5', circular: '#E53935',
        };
        const badgeLabels = {
          route: 'Route', controller: 'Controller', file: 'File', circular: 'Circular',
        };
        nodeInfoBadge.textContent = badgeLabels[msg.nodeType] || 'File';
        nodeInfoBadge.style.background = badgeColors[msg.nodeType] || '#1E88E5';
        nodeInfoName.textContent = msg.nodeName || msg.nodeId;
        nodeInfoSummary.textContent = msg.summary || '';
        nodeInfoPackages.textContent = msg.packages && msg.packages !== 'None'
          ? 'Packages: ' + msg.packages
          : '';
        nodeInfoPackages.style.display = (msg.packages && msg.packages !== 'None') ? 'block' : 'none';
        nodeInfoOpen.style.display = (msg.nodeType === 'route' && msg.openableFilePath) || msg.nodeType !== 'route' ? 'block' : 'none';
        nodeInfo.style.display = 'block';
        break;
      }

      case 'nodeDeselected':
        hideNodeInfo();
        break;

      case 'updateTrace': {
        const { nodeData, edgeData } = msg;
        if (!nodeData || nodeData.length === 0) {
          clearMiniGraph();
          traceExpandBtn.style.opacity = '0.4';
          traceExpandBtn.style.pointerEvents = 'none';
          return;
        }
        traceExpandBtn.style.opacity = '1';
        traceExpandBtn.style.pointerEvents = 'auto';
        renderMiniGraph(nodeData, edgeData || []);
        break;
      }
    }
  });

  function hideNodeInfo() {
    nodeInfo.style.display = 'none';
    currentSelectedNodeId = null;
  }

  function clearMiniGraph() {
    if (traceMiniNetwork) { traceMiniNetwork.destroy(); traceMiniNetwork = null; }
    traceMiniGraph.innerHTML = '';
    if (traceMiniEmpty) {
      traceMiniEmpty.style.display = 'flex';
    } else {
      traceMiniGraph.innerHTML = '<div id="traceMiniEmpty">Click API route to trace</div>';
    }
  }

  function renderMiniGraph(nodeData, edgeData) {
    if (traceMiniNetwork) { traceMiniNetwork.destroy(); traceMiniNetwork = null; }
    traceMiniGraph.innerHTML = '';
    const nodesDs = new vis.DataSet(nodeData);
    const edgesDs = new vis.DataSet(edgeData);
    traceMiniNetwork = new vis.Network(traceMiniGraph, { nodes: nodesDs, edges: edgesDs }, {
      physics: {
        enabled: true, solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -30, centralGravity: 0.01, springLength: 80, springConstant: 0.05 }
      },
      nodes: { borderWidth: 1 },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.4 } } },
      interaction: { dragNodes: true, zoomView: true, dragView: true }
    });
  }

  vscode.postMessage({ type: 'sidebarReady' });
})();
