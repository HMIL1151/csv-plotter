/*
 * CSV Plotter (web) – UI controller.
 * Wires the DOM and Plotly to the pure logic in core.js (window.CsvCore).
 */
(function () {
  'use strict';

  const C = window.CsvCore;
  const { K, AXES_FRACTION: FRACTION } = C;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
  const gd = $('#plot');
  const wrap = $('#plot-wrap');

  if (!window.Plotly) {
    document.body.innerHTML = '<div style="padding:40px;font:15px sans-serif">Could not load Plotly. Connect to the internet once, ' +
      'or download <code>plotly-2.35.2.min.js</code> into <code>web/vendor/</code> (see README).</div>';
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════════

  function newDoc() {
    return { xCol: '', selected: [], series: {}, xLabel: '', xUnit: '', title: '', style: C.defaultStyle(), annotations: [], range: null };
  }

  const state = {
    ds: null,
    doc: newDoc(),
    selectedId: null,
    tool: null,             // annotation kind being placed, or null for select/move
    toolSticky: false,
    fig: null,              // last built figure (refs, axes, warnings)
    history: new C.History(),
    expanded: new Set(),    // expanded column groups
    filter: '',
    gesture: null,          // in-progress drag / creation
    pendingProject: null,
  };

  const ANN_COLORS = ['#d62728', '#1f2937', '#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04'];

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  function toast(msg, opts) {
    opts = opts || {};
    const t = el('div', { class: 'toast' + (opts.error ? ' error' : '') }, el('span', {}, msg));
    if (opts.action) t.append(el('button', { onclick: () => { opts.action.run(); t.remove(); } }, opts.action.label));
    $('#toasts').append(t);
    setTimeout(() => t.remove(), opts.ms || (opts.action ? 7000 : 3200));
  }

  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function pickFile(input) {
    return new Promise((resolve) => {
      input.value = '';
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }

  const isDateX = () => state.ds && state.ds.types[state.doc.xCol] === 'date';

  function fmtX(v) {
    if (!Number.isFinite(v)) return '';
    if (isDateX()) return new Date(v).toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
    return C.fmtNum(v);
  }

  function parseX(s) {
    s = String(s).trim();
    if (!s) return NaN;
    if (isDateX()) {
      const d = C.parseDateUTC(s);
      return Number.isFinite(d) ? d : Number(s);
    }
    return Number(s.replace(/,/g, ''));
  }

  /** Editable number: ~8 significant digits, no grouping or exponent for everyday magnitudes. */
  function plainNum(v) {
    if (!Number.isFinite(v)) return '';
    return String(Number(v.toPrecision(8)));
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    const d = C.parseDateUTC(v);
    return Number.isFinite(d) ? d : Number(v);
  }

  function selectedAnn() {
    return state.doc.annotations.find((a) => a.id === state.selectedId) || null;
  }

  function kindColor(a) { return a.color; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Change management (undo history + autosave)
  // ═══════════════════════════════════════════════════════════════════════════

  function snapshot() {
    const { range, ...rest } = state.doc;
    return JSON.stringify(rest);
  }

  let lastKey = null, lastTime = 0;
  /**
   * Apply a change to the document.
   *  opts.key   – coalesce rapid edits with the same key into one undo step
   *  opts.from  – panel that made the change (it won't be rebuilt, keeping focus)
   */
  function commit(mutate, opts) {
    opts = opts || {};
    const now = Date.now();
    if (!(opts.key && opts.key === lastKey && now - lastTime < 1500)) state.history.push(snapshot());
    lastKey = opts.key || null;
    lastTime = now;
    mutate(state.doc);
    afterChange(opts);
  }

  function afterChange(opts) {
    opts = opts || {};
    schedulePlot();
    renderPanels(opts.from);
    scheduleSave();
    updateUndoButtons();
  }

  function restore(snap) {
    const parsed = JSON.parse(snap);
    state.doc = Object.assign(newDoc(), parsed, { range: state.doc.range });
    if (!selectedAnn()) state.selectedId = null;
    afterChange();
  }

  function undo() {
    const s = state.history.undo(snapshot());
    if (s) { restore(s); toast('Undone'); }
  }

  function redo() {
    const s = state.history.redo(snapshot());
    if (s) { restore(s); toast('Redone'); }
  }

  function updateUndoButtons() {
    $('#btn-undo').disabled = !state.history.canUndo;
    $('#btn-redo').disabled = !state.history.canRedo;
  }

  let saveTimer = null;
  function scheduleSave() {
    if (!state.ds) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem('csvplotter:' + state.ds.fileName, JSON.stringify(state.doc)); } catch (e) { /* quota / private mode */ }
    }, 400);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Loading data
  // ═══════════════════════════════════════════════════════════════════════════

  async function loadFile(file) {
    if (!file) return;
    const big = file.size > 20e6;
    if (big) toast(`Reading ${(file.size / 1e6).toFixed(0)} MB…`);
    try {
      const text = await file.text();
      loadText(text, file.name);
    } catch (err) {
      toast(`Could not read file: ${err.message}`, { error: true });
    }
  }

  function loadText(text, name) {
    const t0 = performance.now();
    const { header, rows } = C.parseCSV(text);
    if (!header.length || !rows.length) { toast('That file has no data rows.', { error: true }); return; }
    const ds = C.createDataset(header, rows, name);
    state.ds = ds;
    state.history = new C.History();
    state.selectedId = null;
    state.expanded.clear();
    state.filter = '';
    $('#col-filter').value = '';

    const fresh = freshDocFor(ds);
    let restored = null;
    try { restored = JSON.parse(localStorage.getItem('csvplotter:' + name) || 'null'); } catch (e) { restored = null; }
    if (state.pendingProject) {
      state.doc = sanitizeDoc(state.pendingProject, ds) || fresh;
      state.pendingProject = null;
      toast('Applied the project you opened to this file.');
    } else if (restored && sanitizeDoc(restored, ds)) {
      state.doc = sanitizeDoc(restored, ds);
      toast(`Restored your previous work on ${name}.`, {
        action: { label: 'Start fresh', run: () => actions['reset-project']() },
      });
    } else {
      state.doc = fresh;
    }

    $('#file-name').innerHTML = '';
    $('#file-name').append(el('b', {}, name), ` · ${ds.n.toLocaleString()} rows · ${ds.columns.length} columns`);
    $('#empty').hidden = true;
    setTool(null);
    updateUndoButtons();
    renderPanels();
    schedulePlot();
    const ms = performance.now() - t0;
    if (ms > 1500) toast(`Loaded in ${(ms / 1000).toFixed(1)} s`);
  }

  function freshDocFor(ds) {
    const doc = newDoc();
    doc.xCol = ds.columns.find((c) => ds.types[c] !== 'text') || ds.columns[0];
    const firstY = ds.columns.find((c) => c !== doc.xCol && ds.types[c] === 'number');
    if (firstY) doc.selected = [firstY];
    return doc;
  }

  /** Make a stored/loaded doc safe for this dataset. Returns null if unusable. */
  function sanitizeDoc(raw, ds) {
    if (!raw || typeof raw !== 'object') return null;
    const doc = Object.assign(newDoc(), raw);
    doc.style = Object.assign(C.defaultStyle(), raw.style || {});
    if (!ds.columns.includes(doc.xCol)) return null;
    doc.selected = (doc.selected || []).filter((c) => ds.columns.includes(c) && c !== doc.xCol);
    doc.series = doc.series || {};
    doc.annotations = (doc.annotations || []).map(C.normalizeAnnotation);
    if (!Array.isArray(doc.range) || doc.range.length !== 2) doc.range = null;
    return doc;
  }

  function makeSampleCSV() {
    const lines = ['ElapsedMs,engine_temp_1,engine_temp_2,engine_temp_3,oil_pressure,rpm,throttle_pct,battery_v'];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    for (let i = 0; i <= 3000; i++) {
      const t = i * 20;
      const s = t / 1000;
      const throttle = s < 8 ? 10 : s < 30 ? 10 + 70 * Math.min(1, (s - 8) / 4) : s < 42 ? 35 : 12;
      const rpm = 800 + throttle * 45 + 120 * Math.sin(s * 1.7) + 30 * rnd();
      const warm = 1 - Math.exp(-s / 18);
      const temps = [0, 1, 2].map((k) => 22 + (68 + k * 6) * warm + (s > 30 && s < 42 ? 6 : 0) + 0.8 * rnd() + k * 1.5);
      const oil = 1.2 + rpm / 1600 + 0.05 * rnd();
      const batt = 12.4 + (rpm > 1200 ? 1.8 : 0.3) + 0.04 * rnd() - (s > 50 && s < 51 ? 1.5 : 0);
      lines.push([t, ...temps.map((v) => v.toFixed(2)), oil.toFixed(3), rpm.toFixed(0), throttle.toFixed(1), batt.toFixed(3)].join(','));
    }
    return lines.join('\n');
  }

  function loadSample() {
    const name = 'sample_engine_run.csv';
    const seen = !!localStorage.getItem('csvplotter:' + name);
    loadText(makeSampleCSV(), name);
    if (seen) return;
    // First visit: show off a styled plot with a few annotations
    Object.assign(state.doc, {
      selected: ['engine_temp_1', 'rpm'],
      series: { engine_temp_1: { label: 'Coolant temperature', unit: '°C' }, rpm: { label: 'Engine speed', unit: 'rpm' } },
      xLabel: 'Time', xUnit: 'ms', title: 'Engine warm-up test',
      annotations: [
        C.newAnnotation(K.XSPAN, { x: 8000, x2: 30000, text: 'Acceleration', color: '#2563eb', alpha: 0.1, box: 'none' }),
        C.newAnnotation(K.ARROW, { x: 41000, y: 89.5, x2: 50000, y2: 70, y_ref: 'engine_temp_1', text: 'Peak under load', color: '#1f2937' }),
        C.newAnnotation(K.VLINE, { x: 42000, text: 'Throttle released', color: '#6b7280', linestyle: '--', linewidth: 1.2, box: 'none' }),
      ],
    });
    renderPanels();
    schedulePlot();
    scheduleSave();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Plot rendering
  // ═══════════════════════════════════════════════════════════════════════════

  const PLOT_CONFIG = {
    responsive: true, displaylogo: false, scrollZoom: true, doubleClick: 'autosize',
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toImage'],
  };

  let plotFrame = 0;
  let plotReady = false;

  function schedulePlot() {
    if (plotFrame) return;
    plotFrame = requestAnimationFrame(() => { plotFrame = 0; renderPlot(); });
  }

  function plotSize() {
    const fl = gd._fullLayout;
    if (fl && fl._size) return { w: fl._size.w, h: fl._size.h };
    return { w: Math.max(300, wrap.clientWidth - 140), h: Math.max(200, wrap.clientHeight - 130) };
  }

  function renderPlot() {
    if (!state.ds) return;
    const doc = state.doc;
    $('#no-series').hidden = doc.selected.length > 0;
    const fig = C.buildFigure(doc, state.ds, { plotSize: plotSize(), selectedId: state.selectedId });
    state.fig = fig;
    Plotly.react(gd, fig.data, fig.layout, PLOT_CONFIG).then(() => {
      if (!plotReady) {
        plotReady = true;
        gd.on('plotly_relayout', onPlotRelayout);
      }
    });
    renderWarnings(fig.warnings);
  }

  function onPlotRelayout(ev) {
    if (!ev || state.gesture) return;
    const keys = Object.keys(ev);
    if (keys.some((k) => /^xaxis\d*\.autorange$/.test(k))) {
      state.doc.range = null;
    } else {
      const r0 = keys.find((k) => /^xaxis\d*\.range\[0\]$/.test(k));
      const r1 = keys.find((k) => /^xaxis\d*\.range\[1\]$/.test(k));
      const rk = keys.find((k) => /^xaxis\d*\.range$/.test(k));
      if (r0 && r1) state.doc.range = [toNum(ev[r0]), toNum(ev[r1])];
      else if (rk) state.doc.range = ev[rk].map(toNum);
      else return;
    }
    syncRangeUI();
    scheduleSave();
  }

  new ResizeObserver(() => { if (plotReady) Plotly.Plots.resize(gd); }).observe(wrap);

  /** Pixel converters bound to the current Plotly layout. */
  function getConv() {
    const fl = gd._fullLayout;
    if (!fl || !fl.xaxis || !state.fig || !state.doc.selected.length) return null;
    const xa = fl.xaxis, s = fl._size, axes = state.fig.axes;
    const yaFor = (ref) => {
      const a = axes[ref];
      return a ? fl[C.axisKey(a.yid)] : null;
    };
    return {
      plot: { l: xa._offset, t: s.t, w: xa._length, h: s.h },
      x2px: (x) => xa._offset + xa.l2p(x),
      px2x: (px) => xa.p2l(px - xa._offset),
      y2px: (y, ref) => {
        if (ref === FRACTION) return s.t + (1 - y) * s.h;
        const ya = yaFor(ref);
        return ya ? ya._offset + ya.l2p(y) : NaN;
      },
      px2y: (py, ref) => {
        if (ref === FRACTION) return 1 - (py - s.t) / s.h;
        const ya = yaFor(ref);
        return ya ? ya.p2l(py - ya._offset) : NaN;
      },
    };
  }

  /** On-screen boxes of Plotly annotation texts, mapped to our annotations. */
  function labelRects() {
    if (!state.fig) return [];
    const base = gd.getBoundingClientRect();
    const out = [];
    for (const node of $$('.annotation', gd)) {
      const ref = state.fig.refs.annotations[+node.getAttribute('data-index')];
      if (!ref || ref.role === 'bracket') continue;
      const textNode = node.querySelector('.annotation-text-g') || node;
      const r = textNode.getBoundingClientRect();
      if (!r.width) continue;
      out.push({ id: ref.id, role: ref.role, left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top });
    }
    return out;
  }

  function localPoint(e) {
    const r = gd.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ── Nearest data point (for snapping & choosing the Y axis) ───────────────
  const sortedCache = new WeakMap();
  function isSorted(arr) {
    if (sortedCache.has(arr)) return sortedCache.get(arr);
    let ok = true;
    for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) { ok = false; break; }
    sortedCache.set(arr, ok);
    return ok;
  }

  function nearestIndices(arr, v) {
    if (isSorted(arr)) {
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
      return [Math.max(0, lo - 1), lo, Math.min(arr.length - 1, lo + 1)];
    }
    let best = 0, bd = Infinity;
    for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; best = i; } }
    return [best];
  }

  function nearestSeriesPoint(p, conv) {
    const xs = C.column(state.ds, state.doc.xCol);
    const xv = conv.px2x(p.x);
    let best = null;
    for (const col of state.doc.selected) {
      const ys = C.column(state.ds, col);
      for (const i of nearestIndices(xs, xv)) {
        if (!Number.isFinite(ys[i]) || !Number.isFinite(xs[i])) continue;
        const d = Math.hypot(conv.x2px(xs[i]) - p.x, conv.y2px(ys[i], col) - p.y);
        if (!best || d < best.dist) best = { col, x: xs[i], y: ys[i], dist: d };
      }
    }
    return best;
  }

  function stackedColumnAt(p) {
    const fl = gd._fullLayout;
    for (const col of state.doc.selected) {
      const ya = fl[C.axisKey(state.fig.axes[col].yid)];
      if (p.y >= ya._offset - 4 && p.y <= ya._offset + ya._length + 4) return col;
    }
    return state.doc.selected[0];
  }

  function chooseYRef(kind, p, conv) {
    if (!C.DATA_ANCHORED.has(kind)) return FRACTION;
    if (state.doc.style.layout === 'stacked') return stackedColumnAt(p);
    const near = nearestSeriesPoint(p, conv);
    return near ? near.col : state.doc.selected[0];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mouse interaction on the plot (create, select, drag)
  // ═══════════════════════════════════════════════════════════════════════════

  function inPlotArea(p, conv) {
    const P = conv.plot;
    return p.x >= P.l && p.x <= P.l + P.w && p.y >= P.t && p.y <= P.t + P.h;
  }

  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !state.ds || e.target.closest('.modebar') || e.target === $('#inline-editor')) return;
    const conv = getConv();
    if (!conv) return;
    const p = localPoint(e);
    closeInlineEditor(true);

    if (state.tool) {
      if (!inPlotArea(p, conv)) return;
      e.preventDefault();
      e.stopPropagation();
      startCreate(state.tool, p, conv, e);
      return;
    }

    const hit = C.hitTest(state.doc.annotations, p.x, p.y, conv, labelRects());
    if (!hit) {
      if (state.selectedId) select(null);
      return;     // let Plotly zoom / pan
    }
    e.preventDefault();
    e.stopPropagation();
    if (state.selectedId !== hit.id) select(hit.id);
    if (e.detail >= 2) { openInlineEditor(hit.id); return; }
    state.gesture = {
      type: 'drag', id: hit.id, fields: hit.fields, p0: p, conv, moved: false,
      orig: Object.assign({}, selectedAnn()), before: snapshot(),
    };
    wrap.classList.add('dragging');
  }, true);

  function startCreate(kind, p, conv, e) {
    const yRef = chooseYRef(kind, p, conv);
    const color = lastAnnColor();
    const a = C.createFromDrag(kind, p, p, conv, { yRef, color });
    state.gesture = { type: 'create', kind, id: a.id, p1: p, conv, yRef, color, before: snapshot(), snap: !e.altKey, sticky: e.shiftKey || state.toolSticky };
    snapCreated(a, p, conv);
    state.doc.annotations.push(a);
    state.selectedId = a.id;
    schedulePlot();
  }

  function snapCreated(a, p1, conv) {
    const g = state.gesture;
    if (!g.snap || (a.kind !== K.MARKER && a.kind !== K.ARROW)) return;
    const near = nearestSeriesPoint(p1, conv);
    if (near && near.dist <= 16 && near.col === a.y_ref) { a.x = near.x; a.y = near.y; }
  }

  window.addEventListener('mousemove', (e) => {
    const g = state.gesture;
    if (!g) { updateHoverCursor(e); return; }
    const p = localPoint(e);
    if (g.type === 'create') {
      const idx = state.doc.annotations.findIndex((a) => a.id === g.id);
      if (idx < 0) return;
      const a = C.createFromDrag(g.kind, g.p1, p, g.conv, { yRef: g.yRef, color: g.color });
      a.id = g.id;
      snapCreated(a, g.p1, g.conv);
      state.doc.annotations[idx] = a;
    } else {
      const dx = p.x - g.p0.x, dy = p.y - g.p0.y;
      if (!g.moved && Math.hypot(dx, dy) < 3) return;
      g.moved = true;
      const idx = state.doc.annotations.findIndex((a) => a.id === g.id);
      if (idx < 0) return;
      state.doc.annotations[idx] = C.dragAnnotation(g.orig, g.fields, dx, dy, g.conv);
      syncInspectorValues();
    }
    schedulePlot();
  });

  window.addEventListener('mouseup', () => {
    const g = state.gesture;
    if (!g) return;
    state.gesture = null;
    wrap.classList.remove('dragging');
    if (g.type === 'create') {
      state.history.push(g.before);
      if (!g.sticky) setTool(null);
      afterChange();
      const a = selectedAnn();
      if (a && a.text && a.kind !== K.MARKER) setTimeout(() => openInlineEditor(a.id, true), 30);
      showTab('notes');
    } else if (g.moved) {
      state.history.push(g.before);
      afterChange();
    }
  });

  let hoverCursor = '';
  function updateHoverCursor(e) {
    let cur = '';
    if (state.ds && !state.tool && wrap.contains(e.target) && !e.buttons) {
      const conv = getConv();
      if (conv) {
        const hit = C.hitTest(state.doc.annotations, ...Object.values(localPoint(e)), conv, labelRects());
        if (hit) cur = hit.cursor;
      }
    }
    if (cur !== hoverCursor) {
      if (hoverCursor) wrap.classList.remove('cur-' + hoverCursor);
      if (cur) wrap.classList.add('cur-' + cur);
      hoverCursor = cur;
    }
  }

  /** Colour for new annotations: the last colour the user explicitly picked. */
  let annColor = C.ANNOTATION_DEFAULTS.color;
  function lastAnnColor() { return annColor; }

  // ── Context menu ──────────────────────────────────────────────────────────
  wrap.addEventListener('contextmenu', (e) => {
    if (!state.ds) return;
    const conv = getConv();
    if (!conv) return;
    e.preventDefault();
    const p = localPoint(e);
    const hit = C.hitTest(state.doc.annotations, p.x, p.y, conv, labelRects());
    const items = [];
    if (hit) {
      select(hit.id);
      const a = selectedAnn();
      items.push(['title', a.kind]);
      if (a.kind !== K.MARKER || a.text !== undefined) items.push(['✎', 'Edit text', () => openInlineEditor(a.id)]);
      items.push(['⧉', 'Duplicate', duplicateSelected]);
      items.push(['⤒', 'Bring to front', () => reorderSelected(Infinity)]);
      items.push(['⤓', 'Send to back', () => reorderSelected(-Infinity)]);
      items.push(['◌', 'Hide', () => toggleVisible(a.id)]);
      items.push(['🗑', 'Delete', deleteSelected]);
    } else if (inPlotArea(p, conv)) {
      items.push(['title', 'Add here']);
      for (const kind of C.KINDS) {
        items.push([C.KIND_ICONS[kind], kind, () => {
          const yRef = chooseYRef(kind, p, conv);
          const a = C.createFromDrag(kind, p, p, conv, { yRef, color: lastAnnColor() });
          commit((d) => d.annotations.push(a));
          select(a.id);
          if (a.text) setTimeout(() => openInlineEditor(a.id, true), 30);
        }]);
      }
    }
    items.push(['sep']);
    items.push(['⤢', 'Reset zoom', () => { state.doc.range = null; syncRangeUI(); Plotly.relayout(gd, { 'xaxis.autorange': true, ...yAutorange() }); }]);
    showContextMenu(e.clientX, e.clientY, items);
  });

  function yAutorange() {
    const out = {};
    for (const k of Object.keys(gd._fullLayout || {})) if (/^yaxis\d*$/.test(k)) out[k + '.autorange'] = true;
    return out;
  }

  function showContextMenu(x, y, items) {
    const m = $('#context-menu');
    m.innerHTML = '';
    for (const [ic, label, fn] of items) {
      if (ic === 'title') m.append(el('div', { class: 'menu-title' }, label));
      else if (ic === 'sep') m.append(el('hr'));
      else m.append(el('button', { onclick: () => { hideContextMenu(); fn(); } }, el('span', { class: 'ic' }, ic), label));
    }
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  }
  function hideContextMenu() { $('#context-menu').hidden = true; }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#context-menu')) hideContextMenu(); });

  // ── Inline text editor ────────────────────────────────────────────────────
  let inlineId = null;
  function openInlineEditor(id, selectAll) {
    const a = state.doc.annotations.find((x) => x.id === id);
    if (!a) return;
    const rects = labelRects().filter((r) => r.id === id && r.role !== 'marker');
    const conv = getConv();
    let left, top;
    if (rects.length) { left = rects[0].left; top = rects[0].top; }
    else if (conv) {
      const xs = a.x !== null ? conv.x2px(a.x) : conv.plot.l + 20;
      left = xs; top = a.y !== null ? conv.y2px(a.y, a.y_ref) : conv.plot.t + 20;
      if (!Number.isFinite(top)) top = conv.plot.t + 20;
    } else return;
    const ed = $('#inline-editor');
    inlineId = id;
    ed.value = a.text;
    ed.style.left = Math.max(4, left - 4) + 'px';
    ed.style.top = Math.max(4, top - 4) + 'px';
    ed.style.width = Math.max(160, (rects[0] ? rects[0].right - rects[0].left : 0) + 40) + 'px';
    ed.style.height = Math.max(34, 22 * (a.text.split('\n').length) + 12) + 'px';
    ed.style.color = a.color;
    ed.hidden = false;
    ed.focus();
    if (selectAll) ed.select();
  }

  function closeInlineEditor(save) {
    const ed = $('#inline-editor');
    if (ed.hidden || !inlineId) return;
    const id = inlineId;
    inlineId = null;
    ed.hidden = true;
    const a = state.doc.annotations.find((x) => x.id === id);
    if (save && a && ed.value !== a.text) {
      const text = ed.value;
      commit((d) => { d.annotations.find((x) => x.id === id).text = text; });
    }
  }

  $('#inline-editor').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeInlineEditor(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeInlineEditor(false); }
    e.stopPropagation();
  });
  $('#inline-editor').addEventListener('blur', () => closeInlineEditor(true));

  // ═══════════════════════════════════════════════════════════════════════════
  // Annotation actions
  // ═══════════════════════════════════════════════════════════════════════════

  function select(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    schedulePlot();
    renderAnnotationList();
    renderInspector();
  }

  function setTool(kind) {
    state.tool = kind;
    $$('#tools button[data-tool]').forEach((b) => b.classList.toggle('active', (b.dataset.tool || null) === (kind || '')));
    $$('#ann-add button').forEach((b) => b.classList.toggle('active', b.dataset.tool === kind));
    wrap.classList.toggle('tool-active', !!kind);
    $('#tool-hint').textContent = kind
      ? `${C.KIND_HINTS[kind]}.  Shift = keep tool · Esc = cancel`
      : (state.ds ? 'Click an annotation to select it · drag to move · double-click to edit text · right-click for options' : '');
  }

  function deleteSelected() {
    const id = state.selectedId;
    if (!id) return;
    commit((d) => { d.annotations = d.annotations.filter((a) => a.id !== id); });
    state.selectedId = null;
    renderInspector();
    renderAnnotationList();
  }

  function duplicateSelected() {
    const a = selectedAnn();
    if (!a) return;
    const conv = getConv();
    let copy = C.normalizeAnnotation(Object.assign({}, a, { id: null }));
    if (conv) copy = C.dragAnnotation(copy, Object.keys(C.KIND_FIELDS[a.kind]), 16, -16, conv);
    commit((d) => d.annotations.splice(d.annotations.indexOf(a) + 1, 0, copy));
    select(copy.id);
  }

  function reorderSelected(to) {
    const a = selectedAnn();
    if (!a) return;
    commit((d) => {
      const i = d.annotations.indexOf(a);
      d.annotations.splice(i, 1);
      const j = to === Infinity ? d.annotations.length : to === -Infinity ? 0 : Math.max(0, Math.min(d.annotations.length, i + to));
      d.annotations.splice(j, 0, a);
    });
  }

  function toggleVisible(id) {
    commit((d) => { const a = d.annotations.find((x) => x.id === id); a.visible = !a.visible; });
  }

  function nudgeSelected(dx, dy) {
    const a = selectedAnn();
    const conv = getConv();
    if (!a || !conv) return;
    const moved = C.dragAnnotation(a, Object.keys(C.KIND_FIELDS[a.kind]), dx, dy, conv);
    commit((d) => { d.annotations[d.annotations.indexOf(a)] = moved; }, { key: 'nudge-' + a.id });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Panels
  // ═══════════════════════════════════════════════════════════════════════════

  function renderPanels(skip) {
    if (skip !== 'data') renderDataPanel();
    if (skip !== 'series') renderSeriesPanel();
    if (skip !== 'style') renderStylePanel();
    renderAnnotationList();
    if (skip !== 'inspector') renderInspector();
    else syncInspectorValues();
  }

  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === (name === 'series' ? 'series' : name)));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ── Data panel ────────────────────────────────────────────────────────────
  function renderDataPanel() {
    const ds = state.ds;
    const doc = state.doc;
    const xs = $('#x-col');
    xs.innerHTML = '';
    if (!ds) { $('#col-list').innerHTML = '<div class="empty-list">No file loaded</div>'; return; }
    for (const c of ds.columns) {
      const t = ds.types[c];
      xs.append(el('option', { value: c, disabled: t === 'text' }, c + (t === 'date' ? '  (date/time)' : t === 'text' ? '  (text)' : '')));
    }
    xs.value = doc.xCol;
    syncRangeUI();
    renderColumnList();
  }

  function renderColumnList() {
    const ds = state.ds, doc = state.doc;
    const list = $('#col-list');
    list.innerHTML = '';
    const term = state.filter.toLowerCase();
    const cols = ds.columns.filter((c) => c !== doc.xCol);
    let shown = 0;
    const colRow = (col, child, label) => {
      const t = ds.types[col];
      const on = doc.selected.includes(col);
      const cb = el('input', { type: 'checkbox', checked: on, disabled: t === 'text' });
      const row = el('label', { class: 'col-row' + (child ? ' child' : '') + (t === 'text' ? ' disabled' : ''), title: col },
        cb,
        el('span', { class: 'name' }, label || col),
        t !== 'number' ? el('span', { class: 'tag' }, t) : null,
        on ? el('span', { class: 'dot', style: { background: C.seriesColor(doc, col) } }) : null);
      cb.addEventListener('change', () => toggleColumns([col], cb.checked));
      shown++;
      return row;
    };
    for (const g of C.groupColumns(cols)) {
      if (!g.isGroup) {
        if (!term || g.name.toLowerCase().includes(term)) list.append(colRow(g.name));
        continue;
      }
      const baseMatch = !term || g.name.toLowerCase().includes(term);
      const members = g.members.filter((c) => baseMatch || c.toLowerCase().includes(term));
      if (!members.length) continue;
      const expanded = state.expanded.has(g.name) || !!term;
      const plottable = g.members.filter((c) => ds.types[c] !== 'text');
      const nOn = plottable.filter((c) => doc.selected.includes(c)).length;
      const cb = el('input', { type: 'checkbox', checked: nOn > 0 && nOn === plottable.length });
      cb.indeterminate = nOn > 0 && nOn < plottable.length;
      cb.addEventListener('change', () => toggleColumns(plottable, cb.checked));
      const head = el('div', { class: 'col-row' },
        el('span', { class: 'twisty' }, expanded ? '▼' : '▶'),
        cb,
        el('span', { class: 'name' }, g.name),
        el('span', { class: 'count' }, `${nOn ? nOn + '/' : ''}${g.members.length}`));
      head.addEventListener('click', (e) => {
        if (e.target === cb) return;
        if (state.expanded.has(g.name)) state.expanded.delete(g.name); else state.expanded.add(g.name);
        renderColumnList();
      });
      list.append(head);
      if (expanded) for (const c of members) list.append(colRow(c, true, c.slice(g.name.length + 1) || c));
    }
    if (!shown && !list.children.length) list.append(el('div', { class: 'empty-list' }, 'No matching columns'));
    $('#sel-count').textContent = doc.selected.length ? `${doc.selected.length} plotted` : '';
  }

  let warnedManyAxes = false;
  function toggleColumns(cols, on) {
    commit((d) => {
      if (on) for (const c of cols) { if (!d.selected.includes(c)) d.selected.push(c); }
      else d.selected = d.selected.filter((c) => !cols.includes(c));
    }, { from: undefined });
    if (state.doc.selected.length > 6 && state.doc.style.layout === 'overlay' && !warnedManyAxes) {
      warnedManyAxes = true;
      toast('Lots of Y axes – stacked panels may be easier to read.', {
        action: { label: 'Switch to stacked', run: () => commit((d) => { d.style.layout = 'stacked'; }) },
      });
    }
  }

  $('#x-col').addEventListener('change', (e) => {
    const v = e.target.value;
    commit((d) => { d.xCol = v; d.range = null; d.selected = d.selected.filter((c) => c !== v); });
  });
  $('#col-filter').addEventListener('input', (e) => { state.filter = e.target.value; renderColumnList(); });
  $('#col-all').addEventListener('click', () => {
    if (!state.ds) return;
    const term = state.filter.toLowerCase();
    const cols = state.ds.columns.filter((c) => c !== state.doc.xCol && state.ds.types[c] !== 'text' && (!term || c.toLowerCase().includes(term)));
    toggleColumns(cols, true);
  });
  $('#col-none').addEventListener('click', () => commit((d) => { d.selected = []; }));
  $('#col-collapse').addEventListener('click', () => { state.expanded.clear(); renderColumnList(); });

  // ── Range controls ────────────────────────────────────────────────────────
  const SLIDER_MAX = 1000;
  function xExtent() { return state.ds ? C.extent(C.column(state.ds, state.doc.xCol)) : [0, 1]; }

  function syncRangeUI() {
    if (!state.ds) return;
    const [mn, mx] = xExtent();
    const [lo, hi] = state.doc.range || [mn, mx];
    const toS = (v) => Math.round(((v - mn) / ((mx - mn) || 1)) * SLIDER_MAX);
    const a = Math.max(0, Math.min(SLIDER_MAX, toS(Math.min(lo, hi))));
    const b = Math.max(0, Math.min(SLIDER_MAX, toS(Math.max(lo, hi))));
    $('#range-lo').value = a;
    $('#range-hi').value = b;
    $('#range-fill').style.left = (a / SLIDER_MAX * 100) + '%';
    $('#range-fill').style.right = (100 - b / SLIDER_MAX * 100) + '%';
    if (document.activeElement !== $('#range-lo-text')) $('#range-lo-text').value = fmtX(Math.min(lo, hi));
    if (document.activeElement !== $('#range-hi-text')) $('#range-hi-text').value = fmtX(Math.max(lo, hi));
  }

  function setRange(lo, hi) {
    const [mn, mx] = xExtent();
    if (!Number.isFinite(lo)) lo = mn;
    if (!Number.isFinite(hi)) hi = mx;
    if (lo > hi) [lo, hi] = [hi, lo];
    state.doc.range = lo <= mn && hi >= mx ? null : [lo, hi];
    syncRangeUI();
    schedulePlot();
    scheduleSave();
  }

  function onSlider() {
    const [mn, mx] = xExtent();
    let a = +$('#range-lo').value, b = +$('#range-hi').value;
    if (a > b) [a, b] = [b, a];
    setRange(mn + (a / SLIDER_MAX) * (mx - mn), mn + (b / SLIDER_MAX) * (mx - mn));
  }
  $('#range-lo').addEventListener('input', onSlider);
  $('#range-hi').addEventListener('input', onSlider);
  for (const id of ['#range-lo-text', '#range-hi-text']) {
    $(id).addEventListener('change', () => setRange(parseX($('#range-lo-text').value), parseX($('#range-hi-text').value)));
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  }
  $('#range-reset').addEventListener('click', () => { setRange(-Infinity, Infinity); Plotly.relayout(gd, yAutorange()); });

  // ── Labels / series panel ─────────────────────────────────────────────────
  function bindText(id, get, set) {
    const input = $(id);
    input.addEventListener('input', () => commit((d) => set(d, input.value), { key: id, from: 'series' }));
    return () => { if (document.activeElement !== input) input.value = get(state.doc) || ''; };
  }
  const syncTitle = bindText('#title', (d) => d.title, (d, v) => { d.title = v; });
  const syncXLabel = bindText('#x-label', (d) => d.xLabel, (d, v) => { d.xLabel = v; });
  const syncXUnit = bindText('#x-unit', (d) => d.xUnit, (d, v) => { d.xUnit = v; });
  const syncShared = bindText('#shared-y', (d) => d.style.sharedYLabel, (d, v) => { d.style.sharedYLabel = v; });
  $('#auto-title').addEventListener('change', (e) => commit((d) => { d.style.autoTitle = e.target.checked; }, { from: 'series' }));

  function renderSeriesPanel() {
    const doc = state.doc;
    syncTitle(); syncXLabel(); syncXUnit(); syncShared();
    $('#auto-title').checked = doc.style.autoTitle;
    $('#title').placeholder = state.ds && doc.style.autoTitle ? `Auto: ${C.fileStem(state.ds.fileName)}` : 'No title';
    $('#x-label').placeholder = doc.xCol || 'Label';
    $('#shared-y-field').hidden = doc.style.layout !== 'shared';

    const list = $('#series-list');
    list.innerHTML = '';
    if (!doc.selected.length) { list.append(el('div', { class: 'empty-list' }, 'No series plotted yet')); return; }
    doc.selected.forEach((col) => {
      const s = doc.series[col] || {};
      const upd = (field, value) => commit((d) => { d.series[col] = Object.assign({}, d.series[col], { [field]: value }); }, { key: `series-${col}-${field}`, from: 'series' });
      const color = el('input', { type: 'color', value: C.seriesColor(doc, col), title: 'Line colour' });
      color.addEventListener('input', () => upd('color', color.value));
      const label = el('input', { value: s.label || '', placeholder: col });
      label.addEventListener('input', () => upd('label', label.value));
      const unit = el('input', { value: s.unit || '', placeholder: 'Units' });
      unit.addEventListener('input', () => upd('unit', unit.value));
      const dash = el('select', {}, Object.entries(C.DASHES).map(([v, l]) => el('option', { value: v, selected: (s.dash || 'solid') === v }, l)));
      dash.addEventListener('change', () => upd('dash', dash.value));
      const resetColor = s.color ? el('button', { class: 'link', onclick: () => upd('color', '') }, 'auto colour') : null;
      const remove = el('button', { class: 'btn small icon ghost', title: 'Remove from plot', onclick: () => toggleColumns([col], false) }, '×');
      const row = el('div', { class: 'series-row', draggable: 'true' },
        el('span', { class: 'handle', title: 'Drag to reorder' }, '⠿'), color, label, unit, remove,
        el('div', { class: 'sub' }, el('span', { class: 'orig', title: col }, col), dash, resetColor));
      row.dataset.col = col;
      list.append(row);
    });
  }

  // drag-to-reorder series
  let dragCol = null;
  $('#series-list').addEventListener('dragstart', (e) => {
    const row = e.target.closest('.series-row');
    if (!row) return;
    dragCol = row.dataset.col;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  $('#series-list').addEventListener('dragover', (e) => {
    if (!dragCol) return;
    e.preventDefault();
    $$('.series-row', $('#series-list')).forEach((r) => r.classList.remove('drop-before'));
    const row = e.target.closest('.series-row');
    if (row) row.classList.add('drop-before');
  });
  $('#series-list').addEventListener('drop', (e) => {
    if (!dragCol) return;
    e.preventDefault();
    const row = e.target.closest('.series-row');
    const target = row ? row.dataset.col : null;
    const col = dragCol;
    dragCol = null;
    if (target === col) { renderSeriesPanel(); return; }
    commit((d) => {
      d.selected = d.selected.filter((c) => c !== col);
      const i = target ? d.selected.indexOf(target) : d.selected.length;
      d.selected.splice(i, 0, col);
    });
  });
  $('#series-list').addEventListener('dragend', () => { dragCol = null; renderSeriesPanel(); });

  // ── Style panel ───────────────────────────────────────────────────────────
  const LAYOUT_ICONS = {
    overlay: '<svg viewBox="0 0 44 28"><rect x="1" y="1" width="42" height="26" rx="3" fill="none" stroke="currentColor"/><path d="M5 20l8-8 7 5 8-9 8 6" stroke="#4e79a7" stroke-width="2" fill="none"/><path d="M5 9l9 7 8-3 7 6 9-9" stroke="#e15759" stroke-width="2" fill="none"/></svg>',
    shared: '<svg viewBox="0 0 44 28"><rect x="1" y="1" width="42" height="26" rx="3" fill="none" stroke="currentColor"/><path d="M5 22l8-6 7 3 8-8 10 2" stroke="#4e79a7" stroke-width="2" fill="none"/><path d="M5 16l9-4 8 4 7-7 9 1" stroke="#e15759" stroke-width="2" fill="none"/></svg>',
    stacked: '<svg viewBox="0 0 44 28"><rect x="1" y="1" width="42" height="12" rx="2" fill="none" stroke="currentColor"/><rect x="1" y="15" width="42" height="12" rx="2" fill="none" stroke="currentColor"/><path d="M5 10l8-5 7 3 8-4 10 3" stroke="#4e79a7" stroke-width="2" fill="none"/><path d="M5 23l9-3 8 2 7-4 9 2" stroke="#e15759" stroke-width="2" fill="none"/></svg>',
  };

  function initStylePanel() {
    const opts = (sel, obj, labelOf) => { $(sel).innerHTML = ''; for (const [k, v] of Object.entries(obj)) $(sel).append(el('option', { value: k }, labelOf ? labelOf(v) : v)); };
    opts('#s-theme', C.THEMES, (t) => t.label);
    opts('#s-palette', C.PALETTES, (p) => p.label);
    opts('#s-legend', C.LEGENDS);
    for (const [k, label] of Object.entries(C.LAYOUTS)) {
      const b = el('button', { 'data-layout': k, title: label });
      b.innerHTML = LAYOUT_ICONS[k];
      b.append(label.split(' (')[0]);
      b.addEventListener('click', () => commit((d) => { d.style.layout = k; }));
      $('#s-layout').append(b);
    }
    const st = (fn, key) => (e) => commit((d) => fn(d.style, e.target), { key, from: 'style' });
    $('#s-theme').addEventListener('change', (e) => commit((d) => { d.style.theme = e.target.value; d.style.fontSize = C.THEMES[e.target.value].fontSize; }));
    $('#s-palette').addEventListener('change', st((s, t) => { s.palette = t.value; }));
    $('#s-legend').addEventListener('change', st((s, t) => { s.legend = t.value; }));
    $('#s-lw').addEventListener('input', st((s, t) => { s.lineWidth = +t.value; $('#s-lw-out').textContent = t.value; }, 'lw'));
    $('#s-fs').addEventListener('input', st((s, t) => { s.fontSize = +t.value; $('#s-fs-out').textContent = t.value + ' px'; }, 'fs'));
    $('#s-grid').addEventListener('change', st((s, t) => { s.grid = t.checked; }));
    $('#s-markers').addEventListener('change', st((s, t) => { s.markers = t.checked; }));
    $('#s-preset').addEventListener('change', (e) => {
      if (!e.target.value) return;
      const [w, h] = e.target.value.split('x').map(Number);
      commit((d) => { d.style.exportWidth = w; d.style.exportHeight = h; });
    });
    $('#s-w').addEventListener('change', st((s, t) => { s.exportWidth = Math.max(200, +t.value || 1600); }));
    $('#s-h').addEventListener('change', st((s, t) => { s.exportHeight = Math.max(200, +t.value || 900); }));
    $('#s-scale').addEventListener('change', st((s, t) => { s.exportScale = Math.max(1, Math.min(6, +t.value || 2)); }));
  }

  function renderStylePanel() {
    const s = state.doc.style;
    $('#s-theme').value = s.theme;
    $('#s-palette').value = s.palette;
    $('#s-legend').value = s.legend;
    $('#s-lw').value = s.lineWidth; $('#s-lw-out').textContent = s.lineWidth;
    $('#s-fs').value = s.fontSize; $('#s-fs-out').textContent = s.fontSize + ' px';
    $('#s-grid').checked = s.grid;
    $('#s-markers').checked = s.markers;
    $('#s-w').value = s.exportWidth; $('#s-h').value = s.exportHeight; $('#s-scale').value = s.exportScale;
    $('#s-preset').value = `${s.exportWidth}x${s.exportHeight}`;
    if (!$('#s-preset').value) $('#s-preset').value = '';
    $$('#s-layout button').forEach((b) => b.classList.toggle('active', b.dataset.layout === s.layout));
    const pv = $('#palette-preview');
    pv.innerHTML = '';
    for (const c of (C.PALETTES[s.palette] || C.PALETTES.tableau).colors) pv.append(el('span', { style: { background: c } }));
  }

  // ── Annotation list ───────────────────────────────────────────────────────
  function renderAnnotationList() {
    const list = $('#ann-list');
    list.innerHTML = '';
    const anns = state.doc.annotations;
    $('#ann-count').textContent = anns.length || '';
    if (!anns.length) {
      list.append(el('div', { class: 'empty-list' }, 'No annotations yet. Pick a tool above (or right-click the plot) to add one.'));
      return;
    }
    anns.forEach((a, i) => {
      const eye = el('button', { class: 'eye', title: a.visible ? 'Hide' : 'Show', onclick: (e) => { e.stopPropagation(); toggleVisible(a.id); } }, a.visible ? '◉' : '○');
      const row = el('div', { class: 'ann-row' + (a.id === state.selectedId ? ' selected' : '') + (a.visible ? '' : ' hidden-ann') },
        el('span', { class: 'ic', style: { background: kindColor(a) } }, C.KIND_ICONS[a.kind]),
        el('div', { class: 'main' },
          el('div', { class: 'title' }, a.text ? a.text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ') : a.kind),
          el('div', { class: 'desc' }, `#${i + 1} ${a.text ? a.kind + ' · ' : ''}${C.describeAnnotation(a, isDateX() ? fmtX : null)}`)),
        eye);
      row.addEventListener('click', () => select(a.id));
      row.addEventListener('dblclick', () => { select(a.id); const t = $('#inspector textarea'); if (t) t.focus(); });
      list.append(row);
    });
  }

  function renderWarnings(warnings) {
    const box = $('#ann-warnings');
    box.innerHTML = '';
    for (const w of warnings || []) box.append(el('div', {}, '⚠ ' + w));
  }

  $('#ann-clear').addEventListener('click', () => {
    if (!state.doc.annotations.length) return;
    const n = state.doc.annotations.length;
    commit((d) => { d.annotations = []; });
    state.selectedId = null;
    renderInspector();
    toast(`Removed ${n} annotation${n > 1 ? 's' : ''}.`, { action: { label: 'Undo', run: undo } });
  });

  // ── Inspector ─────────────────────────────────────────────────────────────
  let inspectorFor = null;   // `${id}|${kind}|${selected cols}` the inspector was built for

  function renderInspector() {
    const insp = $('#inspector');
    const a = selectedAnn();
    if (!a) { insp.hidden = true; inspectorFor = null; return; }
    const sig = `${a.id}|${a.kind}|${a.y_ref}|${state.doc.selected.join(',')}`;
    if (sig === inspectorFor && !insp.hidden) { syncInspectorValues(); return; }
    inspectorFor = sig;
    insp.hidden = false;
    insp.innerHTML = '';

    const id = a.id;
    const set = (field, value, coalesce) => {
      commit((d) => {
        const t = d.annotations.find((x) => x.id === id);
        if (t) t[field] = value;
      }, { key: coalesce === false ? null : `insp-${id}-${field}`, from: 'inspector' });
    };
    const styles = new Set(C.KIND_STYLES[a.kind]);

    // header
    const kindSel = el('select', {}, C.KINDS.map((k) => el('option', { value: k, selected: k === a.kind }, `${C.KIND_ICONS[k]}  ${k}`)));
    kindSel.addEventListener('change', () => changeKind(id, kindSel.value));
    insp.append(el('div', { class: 'insp-head' },
      el('span', { class: 'ic', style: { background: a.color } }, C.KIND_ICONS[a.kind]), kindSel,
      el('button', { class: 'btn small icon ghost', title: 'Close (Esc)', onclick: () => select(null) }, '×')));

    // text
    const ta = el('textarea', { rows: 3, placeholder: a.kind === K.MARKER ? 'Optional label' : 'Text (supports <b>, <i>, <sup>)', 'data-field': 'text' });
    ta.value = a.text;
    ta.addEventListener('input', () => set('text', ta.value));
    insp.append(el('div', { class: 'insp-section' }, el('h4', {}, 'Text'), ta));

    // position
    const pos = el('div', { class: 'insp-grid' });
    for (const [f, label] of Object.entries(C.KIND_FIELDS[a.kind])) {
      const inp = el('input', { class: 'mono', 'data-field': f });
      inp.addEventListener('change', () => {
        const v = f[0] === 'x' ? parseX(inp.value) : Number(inp.value.replace(/,/g, ''));
        if (Number.isFinite(v)) set(f, v, false); else syncInspectorValues();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      pos.append(el('label', {}, label, inp));
    }
    const posSection = el('div', { class: 'insp-section' }, el('h4', {}, 'Position'), pos);
    if (Object.keys(C.KIND_FIELDS[a.kind]).some((f) => f[0] === 'y')) {
      const refs = [FRACTION, ...state.doc.selected];
      if (!refs.includes(a.y_ref)) refs.push(a.y_ref);
      const ySel = el('select', {}, refs.map((r) => el('option', { value: r, selected: r === a.y_ref }, r === FRACTION ? 'Fraction of plot height (0–1)' : `${C.seriesName(state.doc, r)} axis`)));
      ySel.addEventListener('change', () => changeYRef(id, ySel.value));
      posSection.append(el('label', { class: 'insp-row' }, el('label', {}, 'Y measured on', ySel)));
    }
    posSection.append(el('p', { class: 'hint' }, 'Or just drag it on the plot.'));
    insp.append(posSection);

    // style
    const sty = el('div', { class: 'insp-section' }, el('h4', {}, 'Style'));
    const sw = el('div', { class: 'swatches' });
    const colorIn = el('input', { type: 'color', value: toHex(a.color), 'data-field': 'color' });
    colorIn.addEventListener('input', () => { annColor = colorIn.value; set('color', colorIn.value); });
    for (const c of ANN_COLORS) {
      sw.append(el('button', { style: { background: c }, class: a.color === c ? 'active' : '', title: c, onclick: () => { annColor = c; set('color', c, false); renderInspectorForce(); } }));
    }
    sw.append(colorIn);
    sty.append(sw);

    const grid = el('div', { class: 'insp-grid' });
    const num = (field, label, min, max, step) => {
      const inp = el('input', { type: 'number', min, max, step, 'data-field': field });
      inp.addEventListener('input', () => { if (inp.value !== '' && Number.isFinite(+inp.value)) set(field, +inp.value); });
      grid.append(el('label', {}, label, inp));
    };
    const sel = (field, label, options) => {
      const s = el('select', { 'data-field': field }, Object.entries(options).map(([v, l]) => el('option', { value: v }, l)));
      s.addEventListener('change', () => set(field, s.value, false));
      grid.append(el('label', {}, label, s));
    };
    if (a.text !== undefined) num('fontsize', 'Font size', 6, 72, 1);
    if (styles.has('box')) sel('box', 'Text box', C.BOXES);
    if (styles.has('width')) num('linewidth', 'Line width', 0.5, 10, 0.5);
    if (styles.has('dash')) sel('linestyle', 'Line style', { '-': 'Solid', '--': 'Dashed', ':': 'Dotted', '-.': 'Dash-dot' });
    if (styles.has('arrow')) sel('arrowstyle', a.kind === K.BRACKET ? 'Ends' : 'Arrow head', Object.fromEntries(Object.entries(C.ARROWSTYLES).map(([k, v]) => [k, v.label])));
    if (styles.has('marker')) { sel('marker', 'Marker', Object.fromEntries(Object.entries(C.MARKERS).map(([k, v]) => [k, `${v[1]} ${v[0]}`]))); num('markersize', 'Marker size', 6, 60, 1); }
    sty.append(grid);
    if (styles.has('fill')) {
      const r = el('input', { type: 'range', min: 0, max: 1, step: 0.02, 'data-field': 'alpha' });
      r.addEventListener('input', () => set('alpha', +r.value));
      sty.append(el('label', { class: 'insp-row' }, el('label', {}, 'Fill opacity', r)));
    }
    insp.append(sty);

    // label offset
    if (styles.has('label')) {
      const g2 = el('div', { class: 'insp-grid' });
      for (const [f, label] of [['text_dx', 'Right (px)'], ['text_dy', 'Up (px)']]) {
        const inp = el('input', { type: 'number', step: 1, 'data-field': f });
        inp.addEventListener('input', () => { if (Number.isFinite(+inp.value)) set(f, +inp.value); });
        g2.append(el('label', {}, label, inp));
      }
      const leader = el('input', { type: 'checkbox', 'data-field': 'leader' });
      leader.addEventListener('change', () => set('leader', leader.checked, false));
      insp.append(el('div', { class: 'insp-section' },
        el('h4', {}, 'Label offset'), g2,
        el('div', { class: 'insp-row' },
          el('label', { class: 'check' }, leader, 'Leader line'),
          el('button', { class: 'btn small', onclick: () => { commit((d) => { const t = d.annotations.find((x) => x.id === id); t.text_dx = 0; t.text_dy = 0; }); } }, 'Reset position')),
        el('p', { class: 'hint' }, 'Tip: drag the label on the plot.')));
    }

    // actions
    const vis = el('input', { type: 'checkbox', 'data-field': 'visible' });
    vis.addEventListener('change', () => set('visible', vis.checked, false));
    insp.append(el('div', { class: 'insp-section' },
      el('label', { class: 'check' }, vis, 'Visible'),
      el('div', { class: 'insp-actions' },
        el('button', { class: 'btn small', onclick: duplicateSelected }, '⧉ Duplicate'),
        el('button', { class: 'btn small danger', onclick: deleteSelected }, '🗑 Delete'),
        el('button', { class: 'btn small', onclick: () => reorderSelected(Infinity) }, '⤒ To front'),
        el('button', { class: 'btn small', onclick: () => reorderSelected(-Infinity) }, '⤓ To back'))));

    syncInspectorValues();
  }

  function renderInspectorForce() { inspectorFor = null; renderInspector(); }

  /** Push current annotation values into the inspector inputs without rebuilding (keeps focus). */
  function syncInspectorValues() {
    const a = selectedAnn();
    const insp = $('#inspector');
    if (!a || insp.hidden) return;
    for (const inp of $$('[data-field]', insp)) {
      if (inp === document.activeElement) continue;
      const f = inp.dataset.field;
      const v = a[f];
      if (inp.type === 'checkbox') inp.checked = !!v;
      else if (inp.type === 'color') inp.value = toHex(v);
      else if (['x', 'x2'].includes(f)) inp.value = isDateX() ? fmtX(v) : plainNum(v);
      else if (['y', 'y2'].includes(f)) inp.value = plainNum(v);
      else inp.value = v === null || v === undefined ? '' : v;
    }
    const ic = $('.insp-head .ic', insp);
    if (ic) ic.style.background = a.color;
  }

  function toHex(c) {
    if (/^#[0-9a-f]{6}$/i.test(c)) return c;
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = c;
    return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : '#000000';
  }

  function changeKind(id, kind) {
    const conv = getConv();
    commit((d) => {
      const i = d.annotations.findIndex((x) => x.id === id);
      const old = d.annotations[i];
      const fresh = C.normalizeAnnotation(Object.assign({}, old, { kind }));
      // fill coordinates the new kind needs but the old one lacked
      if (conv) {
        const P = conv.plot;
        const fx = (fr) => conv.px2x(P.l + fr * P.w);
        const fy = (fr) => conv.px2y(P.t + (1 - fr) * P.h, fresh.y_ref);
        if (!Number.isFinite(fresh.x)) fresh.x = fx(0.4);
        if (!Number.isFinite(fresh.x2)) fresh.x2 = conv.px2x(conv.x2px(fresh.x) + P.w * 0.15);
        if (!Number.isFinite(fresh.y)) fresh.y = fy(0.5);
        if (!Number.isFinite(fresh.y2)) fresh.y2 = conv.px2y(conv.y2px(fresh.y, fresh.y_ref) - P.h * 0.2, fresh.y_ref);
      }
      d.annotations[i] = fresh;
    });
    renderInspectorForce();
  }

  function changeYRef(id, ref) {
    const conv = getConv();
    commit((d) => {
      const a = d.annotations.find((x) => x.id === id);
      if (conv) {
        for (const f of ['y', 'y2']) {
          if (a[f] === null) continue;
          const v = C.convertY(a[f], a.y_ref, ref, conv);
          if (Number.isFinite(v)) a[f] = v;
        }
      }
      a.y_ref = ref;
    });
    renderInspectorForce();
  }

  // ── Toolbars ──────────────────────────────────────────────────────────────
  const TOOL_KEYS = { [K.TEXT]: 't', [K.ARROW]: 'a', [K.BRACKET]: 'b', [K.XSPAN]: 's', [K.YSPAN]: 'y', [K.VLINE]: 'l', [K.HLINE]: 'h', [K.MARKER]: 'm', [K.RECT]: 'r' };

  function initToolbars() {
    const tools = $('#tools');
    tools.append(el('button', { 'data-tool': '', title: 'Select & move (V)', class: 'active', onclick: () => setTool(null) }, '➚'));
    tools.append(el('span', { class: 'sep' }));
    for (const kind of C.KINDS) {
      const pick = (e) => { state.toolSticky = e.detail >= 2; setTool(state.tool === kind && e.detail < 2 ? null : kind); };
      tools.append(el('button', { 'data-tool': kind, title: `${kind} (${TOOL_KEYS[kind].toUpperCase()}) – double-click to keep active`, onclick: pick }, C.KIND_ICONS[kind]));
      $('#ann-add').append(el('button', { 'data-tool': kind, onclick: pick }, el('span', { class: 'ic' }, C.KIND_ICONS[kind]), kind.replace(' (shaded)', '')));
    }
    setTool(null);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Export, project files
  // ═══════════════════════════════════════════════════════════════════════════

  async function exportImage(format) {
    if (!state.ds || !state.doc.selected.length) { toast('Plot something first.', { error: true }); return null; }
    const s = state.doc.style;
    const plot = { w: s.exportWidth - 140, h: s.exportHeight - 140 };
    const fig = C.buildFigure(state.doc, state.ds, { plotSize: plot, forExport: true });
    fig.layout.width = s.exportWidth;
    fig.layout.height = s.exportHeight;
    // keep the current zoom (including Y zoom) in the export
    const fl = gd._fullLayout;
    for (const k of Object.keys(fig.layout)) {
      if (/^[xy]axis\d*$/.test(k) && fl[k] && !fig.layout[k].matches) {
        fig.layout[k].range = fl[k].range.slice();
        fig.layout[k].autorange = false;
      }
    }
    return Plotly.toImage({ data: fig.data, layout: fig.layout }, { format, width: s.exportWidth, height: s.exportHeight, scale: format === 'png' ? s.exportScale : 1 });
  }

  function baseName() { return state.ds ? C.fileStem(state.ds.fileName) : 'plot'; }

  const actions = {
    open: async () => loadFile(await pickFile($('#file-input'))),
    sample: loadSample,
    'export-png': async () => { const url = await exportImage('png'); if (url) download(`${baseName()}.png`, await (await fetch(url)).blob()); },
    'export-svg': async () => { const url = await exportImage('svg'); if (url) download(`${baseName()}.svg`, await (await fetch(url)).blob()); },
    'copy-png': async () => {
      const url = await exportImage('png');
      if (!url) return;
      try {
        const blob = await (await fetch(url)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('Image copied to clipboard.');
      } catch (err) {
        toast('Your browser blocked clipboard access here – use Export PNG instead.', { error: true });
      }
    },
    'export-csv': () => {
      if (!state.ds || !state.doc.selected.length) { toast('Select some columns first.', { error: true }); return; }
      const { text, rowCount } = C.exportCSV(state.ds, state.doc, state.doc.range);
      download(`${baseName()}_export.csv`, text, 'text/csv');
      toast(`Exported ${rowCount.toLocaleString()} rows.`);
    },
    'save-project': () => {
      const data = { app: 'csv-plotter-web', version: 1, fileName: state.ds ? state.ds.fileName : null, doc: state.doc };
      download(`${baseName()}.plot.json`, JSON.stringify(data, null, 2), 'application/json');
    },
    'open-project': async () => {
      const f = await pickFile($('#json-input'));
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.doc) throw new Error('Not a CSV Plotter project file');
        if (!state.ds) {
          state.pendingProject = data.doc;
          toast(`Project loaded – now open ${data.fileName || 'its CSV file'}.`);
          return;
        }
        const doc = sanitizeDoc(data.doc, state.ds);
        if (!doc) throw new Error(`This project uses column '${data.doc.xCol}', which isn't in this file`);
        commit((d) => Object.assign(d, doc));
        toast('Project applied.');
      } catch (err) { toast(`Could not open project: ${err.message}`, { error: true }); }
    },
    'save-annotations': () => {
      if (!state.doc.annotations.length) { toast('There are no annotations to save.'); return; }
      download(`${baseName()}_annotations.json`, C.serializeAnnotations(state.doc.annotations), 'application/json');
    },
    'load-annotations': async () => {
      const f = await pickFile($('#json-input'));
      if (!f) return;
      try {
        const loaded = C.parseAnnotationFile(await f.text());
        const replace = state.doc.annotations.length && confirm('Replace the current annotations?\n\nOK = replace, Cancel = add to them');
        commit((d) => { d.annotations = replace ? loaded : d.annotations.concat(loaded); });
        toast(`Loaded ${loaded.length} annotation${loaded.length === 1 ? '' : 's'}.`);
      } catch (err) { toast(`Could not read annotations: ${err.message}`, { error: true }); }
    },
    'reset-project': () => {
      if (!state.ds) return;
      commit((d) => Object.assign(d, freshDocFor(state.ds)));
      state.selectedId = null;
      renderInspector();
      toast('Started fresh.', { action: { label: 'Undo', run: undo } });
    },
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn && actions[btn.dataset.action]) {
      e.preventDefault();
      $$('.dropdown.open').forEach((d) => d.classList.remove('open'));
      actions[btn.dataset.action]();
      return;
    }
    const dd = e.target.closest('.dropdown');
    $$('.dropdown.open').forEach((d) => { if (d !== dd) d.classList.remove('open'); });
    if (dd && e.target.closest('.dropdown > .btn')) dd.classList.toggle('open');
  });

  $('#btn-open').addEventListener('click', actions.open);
  $('#btn-sample').addEventListener('click', loadSample);
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-help').addEventListener('click', () => { $('#help').hidden = false; });
  $('#help').addEventListener('click', (e) => { if (e.target.id === 'help' || e.target.hasAttribute('data-close')) $('#help').hidden = true; });

  // ── Drag & drop files ─────────────────────────────────────────────────────
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#drop-overlay').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (/\.json$/i.test(f.name)) {
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        if (data.doc) { state.pendingProject = null; if (state.ds) { const doc = sanitizeDoc(data.doc, state.ds); if (doc) commit((d) => Object.assign(d, doc)); } else state.pendingProject = data.doc; }
        else { const loaded = C.parseAnnotationFile(text); commit((d) => { d.annotations = d.annotations.concat(loaded); }); toast(`Added ${loaded.length} annotations.`); }
      } catch (err) { toast(`Could not read ${f.name}: ${err.message}`, { error: true }); }
    } else loadFile(f);
  });

  // ── Keyboard ──────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      hideContextMenu();
      $('#help').hidden = true;
      if (typing) { e.target.blur(); return; }
      if (state.tool) setTool(null); else select(null);
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); actions.open(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) { e.preventDefault(); deleteSelected(); return; }
    if (e.key === 'Enter' && state.selectedId) { e.preventDefault(); openInlineEditor(state.selectedId); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && state.selectedId) {
      e.preventDefault();
      const m = e.shiftKey ? 10 : 1;
      nudgeSelected(arrows[e.key][0] * m, arrows[e.key][1] * m);
      return;
    }
    if (e.key === '?') { $('#help').hidden = false; return; }
    if (!state.ds) return;
    const k = e.key.toLowerCase();
    if (k === 'v') { setTool(null); return; }
    const kind = Object.keys(TOOL_KEYS).find((kk) => TOOL_KEYS[kk] === k);
    if (kind) { state.toolSticky = false; setTool(kind); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════════════════════

  initStylePanel();
  initToolbars();
  renderPanels();
  updateUndoButtons();

  if (/[?&]sample\b/.test(location.search)) loadSample();

  // Expose for debugging / automated smoke tests
  window.CsvPlotterApp = { state, getConv, labelRects, loadText, loadSample, commit, select, setTool, actions, exportImage };
})();
