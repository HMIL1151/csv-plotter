/*
 * CSV Plotter (web) – core logic.
 *
 * Pure functions only: no DOM, no Plotly calls.  Loaded as a classic <script>
 * in the browser (exposes `window.CsvCore`) and via require() in Node tests.
 *
 * Pixel geometry is abstracted behind a "converter" object so that hit
 * testing and drag maths can be tested without a browser:
 *   conv.x2px(x)          data x  -> px (relative to the plot container)
 *   conv.px2x(px)         px      -> data x
 *   conv.y2px(y, yRef)    y in the annotation's Y units -> px (NaN if unavailable)
 *   conv.px2y(py, yRef)   px      -> y in yRef units
 *   conv.plot             {l, t, w, h} plot area in px
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CsvCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // CSV parsing
  // ═══════════════════════════════════════════════════════════════════════════

  function detectDelimiter(text) {
    const end = text.indexOf('\n');
    const line = end === -1 ? text : text.slice(0, end);
    let best = ',', bestCount = 0;
    for (const d of [',', ';', '\t', '|']) {
      let count = 0, quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) count++;
      }
      if (count > bestCount) { best = d; bestCount = count; }
    }
    return best;
  }

  /** RFC-4180-ish parser. Returns {header: string[], rows: string[][]}. */
  function parseCSV(text, delimiter) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const d = delimiter || detectDelimiter(text);
    const rows = [];
    let row = [], field = '', i = 0, quoted = false;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { quoted = true; i++; continue; }
      if (ch === d) { row.push(field); field = ''; i++; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); field = '';
        if (!(row.length === 1 && row[0] === '')) rows.push(row);
        row = [];
        i += (ch === '\r' && text[i + 1] === '\n') ? 2 : 1;
        continue;
      }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { header: [], rows: [] };
    const header = uniqueNames(rows.shift().map((h, k) => h.trim() || `Column ${k + 1}`));
    return { header, rows };
  }

  function uniqueNames(names) {
    const seen = new Map();
    return names.map((n) => {
      const c = seen.get(n) || 0;
      seen.set(n, c + 1);
      return c ? `${n}.${c}` : n;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Values & datasets
  // ═══════════════════════════════════════════════════════════════════════════

  function parseNumber(s) {
    if (s === undefined || s === null) return NaN;
    const t = String(s).trim();
    return t === '' ? NaN : Number(t);
  }

  const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

  /** Parse a date/time string to ms since epoch. Zone-less ISO strings are treated as UTC (as Plotly does). */
  function parseDateUTC(s) {
    if (s === undefined || s === null) return NaN;
    const t = String(s).trim();
    if (!t || /^[-+]?\d+(\.\d+)?$/.test(t)) return NaN;
    const m = ISO_RE.exec(t);
    if (m) {
      let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0),
        m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0);
      if (m[8] && m[8] !== 'Z') {
        const sign = m[8][0] === '-' ? -1 : 1;
        const hh = +m[8].slice(1, 3), mm = +m[8].slice(-2);
        ms -= sign * (hh * 60 + mm) * 60000;
      }
      return ms;
    }
    if (!/[-/:]/.test(t)) return NaN;
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : NaN;
  }

  function detectType(values) {
    let seen = 0, num = 0, date = 0;
    for (let i = 0; i < values.length && seen < 300; i++) {
      const v = values[i];
      if (v === undefined || String(v).trim() === '') continue;
      seen++;
      if (Number.isFinite(parseNumber(v))) num++;
      else if (Number.isFinite(parseDateUTC(v))) date++;
    }
    if (!seen) return 'number';
    if (num / seen >= 0.9) return 'number';
    if (date / seen >= 0.9) return 'date';
    return 'text';
  }

  function createDataset(header, rows, fileName) {
    const types = {};
    const sampleStep = Math.max(1, Math.floor(rows.length / 300));
    header.forEach((h, c) => {
      const sample = [];
      for (let r = 0; r < rows.length && sample.length < 300; r += sampleStep) sample.push(rows[r][c]);
      types[h] = detectType(sample);
    });
    return { fileName: fileName || 'data.csv', columns: header.slice(), rows, n: rows.length, types, _cache: {} };
  }

  /** Numeric view of a column (dates → ms, text → NaN). Cached; same array returned each time. */
  function column(ds, name) {
    if (ds._cache[name]) return ds._cache[name];
    const c = ds.columns.indexOf(name);
    if (c < 0) throw new Error(`Unknown column ${name}`);
    const parse = ds.types[name] === 'date' ? parseDateUTC : parseNumber;
    const out = new Float64Array(ds.n);
    for (let r = 0; r < ds.n; r++) out[r] = parse(ds.rows[r][c]);
    ds._cache[name] = out;
    return out;
  }

  function extent(arr) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return lo <= hi ? [lo, hi] : [0, 1];
  }

  function fileStem(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Column grouping (same rules as the desktop app)
  // ═══════════════════════════════════════════════════════════════════════════

  function parseGroups(cols) {
    const raw = new Map();
    for (const col of cols) {
      const m = /^(.+?)_(\d+.*)$/.exec(col);
      const base = m ? m[1] : col;
      if (!raw.has(base)) raw.set(base, []);
      raw.get(base).push(col);
    }
    const out = new Map();
    for (const [base, members] of raw) out.set(members.length > 1 ? base : members[0], members);
    return out;
  }

  /** [{name, members, isGroup}] – groups first, then single columns, each A–Z. */
  function groupColumns(cols) {
    const items = [...parseGroups(cols)].map(([name, members]) => ({ name, members, isGroup: members.length > 1 }));
    const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return [...items.filter((g) => g.isGroup).sort(byName), ...items.filter((g) => !g.isGroup).sort(byName)];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Labels & export
  // ═══════════════════════════════════════════════════════════════════════════

  function displayLabel(label, unit) {
    return unit ? `${label} [${unit}]` : label;
  }

  function seriesName(doc, col) {
    const s = (doc.series && doc.series[col]) || {};
    return displayLabel((s.label || '').trim() || col, (s.unit || '').trim());
  }

  function xAxisTitle(doc) {
    return displayLabel((doc.xLabel || '').trim() || doc.xCol || '', (doc.xUnit || '').trim());
  }

  function csvEscape(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** CSV text for the X column + selected columns, limited to `range` (inclusive), with display names as headers. */
  function exportCSV(ds, doc, range) {
    const cols = [doc.xCol, ...doc.selected];
    const idx = cols.map((c) => ds.columns.indexOf(c));
    const names = [xAxisTitle(doc), ...doc.selected.map((c) => seriesName(doc, c))];
    const x = column(ds, doc.xCol);
    const lines = [names.map(csvEscape).join(',')];
    for (let r = 0; r < ds.n; r++) {
      if (range && !(x[r] >= range[0] && x[r] <= range[1])) continue;
      lines.push(idx.map((c) => csvEscape(ds.rows[r][c])).join(','));
    }
    return { text: lines.join('\n') + '\n', rowCount: lines.length - 1 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Styles
  // ═══════════════════════════════════════════════════════════════════════════

  const PALETTES = {
    tableau: { label: 'Tableau 10', colors: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'] },
    classic: { label: 'Classic (matplotlib)', colors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'] },
    okabe: { label: 'Okabe–Ito (colour-blind safe)', colors: ['#0072b2', '#e69f00', '#009e73', '#d55e00', '#cc79a7', '#56b4e9', '#f0e442', '#000000'] },
    tol: { label: 'Paul Tol muted', colors: ['#332288', '#88ccee', '#44aa99', '#117733', '#999933', '#ddcc77', '#cc6677', '#882255', '#aa4499'] },
    bold: { label: 'Bold', colors: ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#65a30d', '#4f46e5', '#ca8a04'] },
    mono: { label: 'Monochrome', colors: ['#111827', '#4b5563', '#9ca3af', '#1f2937', '#6b7280', '#d1d5db'] },
  };

  const SANS = 'Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const THEMES = {
    clean: { label: 'Clean', paper: '#ffffff', plot: '#ffffff', font: SANS, fontColor: '#1f2937', grid: '#e8eaee', line: '#9ca3af', mirror: false, boxBg: 'rgba(255,255,255,0.92)', fontSize: 13 },
    publication: { label: 'Publication', paper: '#ffffff', plot: '#ffffff', font: 'Arial, Helvetica, sans-serif', fontColor: '#000000', grid: '#eeeeee', line: '#000000', mirror: true, boxBg: 'rgba(255,255,255,0.95)', fontSize: 14 },
    soft: { label: 'Soft grey', paper: '#ffffff', plot: '#eef0f4', font: SANS, fontColor: '#1f2937', grid: '#ffffff', line: 'rgba(0,0,0,0)', mirror: false, boxBg: 'rgba(255,255,255,0.92)', fontSize: 13 },
    dark: { label: 'Dark', paper: '#0f172a', plot: '#0f172a', font: SANS, fontColor: '#e2e8f0', grid: '#1e293b', line: '#475569', mirror: false, boxBg: 'rgba(15,23,42,0.92)', fontSize: 13 },
    presentation: { label: 'Presentation', paper: '#ffffff', plot: '#ffffff', font: SANS, fontColor: '#111827', grid: '#e5e7eb', line: '#6b7280', mirror: false, boxBg: 'rgba(255,255,255,0.92)', fontSize: 18 },
  };

  const LAYOUTS = { overlay: 'Separate Y axes (overlaid)', shared: 'One shared Y axis', stacked: 'Stacked panels' };
  const LEGENDS = { top: 'Top', right: 'Right', inside: 'Inside (top-left)', bottom: 'Bottom', none: 'Hidden' };
  const DASHES = { solid: 'Solid', dash: 'Dashed', dot: 'Dotted', dashdot: 'Dash-dot' };

  function defaultStyle() {
    return {
      theme: 'clean', palette: 'tableau', layout: 'overlay', lineWidth: 1.6, markers: false,
      grid: true, legend: 'top', fontSize: 13, autoTitle: true, sharedYLabel: '',
      exportWidth: 1600, exportHeight: 900, exportScale: 2,
    };
  }

  function seriesColor(doc, col) {
    const s = doc.series && doc.series[col];
    if (s && s.color) return s.color;
    const pal = (PALETTES[doc.style.palette] || PALETTES.tableau).colors;
    const i = Math.max(0, doc.selected.indexOf(col));
    return pal[i % pal.length];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Annotation model (field names compatible with the desktop app's JSON)
  // ═══════════════════════════════════════════════════════════════════════════

  const AXES_FRACTION = 'Axes fraction (0–1)';

  const K = {
    TEXT: 'Text box', ARROW: 'Arrow + text', BRACKET: 'Span bracket', XSPAN: 'X span (shaded)',
    YSPAN: 'Y span (shaded)', VLINE: 'Vertical line', HLINE: 'Horizontal line', MARKER: 'Point marker', RECT: 'Rectangle',
  };
  const KINDS = [K.TEXT, K.ARROW, K.BRACKET, K.XSPAN, K.YSPAN, K.VLINE, K.HLINE, K.MARKER, K.RECT];

  const KIND_FIELDS = {
    [K.TEXT]: { x: 'X', y: 'Y' },
    [K.ARROW]: { x: 'Arrow tip X', y: 'Arrow tip Y', x2: 'Text X', y2: 'Text Y' },
    [K.BRACKET]: { x: 'Start X', x2: 'End X', y: 'Height Y' },
    [K.XSPAN]: { x: 'Start X', x2: 'End X' },
    [K.YSPAN]: { y: 'Start Y', y2: 'End Y' },
    [K.VLINE]: { x: 'X' },
    [K.HLINE]: { y: 'Y' },
    [K.MARKER]: { x: 'X', y: 'Y' },
    [K.RECT]: { x: 'Corner X', y: 'Corner Y', x2: 'Opposite X', y2: 'Opposite Y' },
  };

  const KIND_STYLES = {
    [K.TEXT]: ['box'],
    [K.ARROW]: ['box', 'width', 'arrow'],
    [K.BRACKET]: ['box', 'width', 'arrow', 'label'],
    [K.XSPAN]: ['box', 'fill', 'label'],
    [K.YSPAN]: ['box', 'fill', 'label'],
    [K.VLINE]: ['box', 'width', 'dash', 'label'],
    [K.HLINE]: ['box', 'width', 'dash', 'label'],
    [K.MARKER]: ['box', 'marker', 'label'],
    [K.RECT]: ['box', 'width', 'dash', 'fill', 'label'],
  };

  const KIND_ICONS = {
    [K.TEXT]: 'T', [K.ARROW]: '↗', [K.BRACKET]: '↔', [K.XSPAN]: '▥', [K.YSPAN]: '▤',
    [K.VLINE]: '│', [K.HLINE]: '─', [K.MARKER]: '●', [K.RECT]: '▭',
  };

  /** How the user creates each kind with the mouse. */
  const KIND_HINTS = {
    [K.TEXT]: 'Click where the text should go',
    [K.ARROW]: 'Press on the point of interest, drag to where the text should go',
    [K.BRACKET]: 'Drag horizontally across the span to label',
    [K.XSPAN]: 'Drag across the X range to shade',
    [K.YSPAN]: 'Drag across the Y range to shade',
    [K.VLINE]: 'Click to place a vertical line',
    [K.HLINE]: 'Click to place a horizontal line',
    [K.MARKER]: 'Click a point to mark it',
    [K.RECT]: 'Drag to draw a rectangle',
  };

  /** Kinds that should follow the data (use a column's Y axis) by default. */
  const DATA_ANCHORED = new Set([K.ARROW, K.MARKER, K.HLINE, K.YSPAN, K.RECT, K.BRACKET]);

  const ARROWSTYLES = {
    '->': { label: 'Arrow', head: 2, side: 'end' },
    '-|>': { label: 'Solid arrow', head: 1, side: 'end' },
    '->>': { label: 'Barbed arrow', head: 3, side: 'end' },
    '-o': { label: 'Dot', head: 6, side: 'end' },
    '-': { label: 'Plain line', head: 0, side: 'none' },
    '<->': { label: 'Double arrow', head: 2, side: 'end+start' },
    '<|-|>': { label: 'Double solid arrow', head: 1, side: 'end+start' },
    '|-|': { label: 'Dimension |—|', head: 0, side: 'none', ticks: true },
    '|<->|': { label: 'Dimension with arrows', head: 2, side: 'end+start', ticks: true },
  };

  const MARKERS = { o: ['Circle', '●'], s: ['Square', '■'], D: ['Diamond', '◆'], '^': ['Triangle up', '▲'], v: ['Triangle down', '▼'], '*': ['Star', '★'], P: ['Plus', '✚'], X: ['Cross', '✖'] };
  const BOXES = { none: 'No box', outline: 'Outlined box', filled: 'Filled box' };
  const LINESTYLES = { '-': 'solid', '--': 'dash', ':': 'dot', '-.': 'dashdot' };

  const ANNOTATION_DEFAULTS = {
    kind: K.TEXT, text: '', x: 0, y: 0.5, x2: null, y2: null, y_ref: AXES_FRACTION,
    color: '#d62728', fontsize: 12, linestyle: '-', linewidth: 1.5, alpha: 0.18,
    box: 'outline', arrowstyle: '->', marker: 'o', markersize: 16,
    text_dx: 0, text_dy: 0, leader: true, visible: true,
  };

  let _idCounter = 0;
  function newId() {
    _idCounter += 1;
    return `a${Date.now().toString(36)}${_idCounter}`;
  }

  /** Coerce any (possibly desktop-app) annotation dict into a complete web annotation. */
  function normalizeAnnotation(d) {
    const a = { id: (d && d.id) || newId() };
    for (const k of Object.keys(ANNOTATION_DEFAULTS)) {
      a[k] = d && d[k] !== undefined ? d[k] : ANNOTATION_DEFAULTS[k];
    }
    if (!KIND_FIELDS[a.kind]) a.kind = K.TEXT;
    if (!BOXES[a.box]) a.box = a.box ? 'outline' : 'none';               // desktop: round/square/…
    if (!ARROWSTYLES[a.arrowstyle]) {
      a.arrowstyle = { fancy: '-|>', simple: '-|>', wedge: '-|>', ']-[': '|-|', '-[': '|-|' }[a.arrowstyle] || '->';
    }
    if (!MARKERS[a.marker]) a.marker = 'o';
    if (!LINESTYLES[a.linestyle]) a.linestyle = '-';
    for (const f of ['x', 'y', 'x2', 'y2']) a[f] = a[f] === null || a[f] === undefined || a[f] === '' ? null : Number(a[f]);
    for (const f of ['fontsize', 'linewidth', 'alpha', 'markersize', 'text_dx', 'text_dy']) a[f] = Number(a[f]);
    a.text = String(a.text || '');
    a.visible = a.visible !== false;
    a.leader = a.leader !== false;
    return a;
  }

  function newAnnotation(kind, props) {
    return normalizeAnnotation(Object.assign({ kind, text: kind === K.XSPAN || kind === K.VLINE || kind === K.HLINE ? '' : 'Label' }, props || {}));
  }

  function validateAnnotation(a) {
    const errors = [];
    const fields = KIND_FIELDS[a.kind];
    if (!fields) return [`Unknown annotation type '${a.kind}'.`];
    for (const [f, label] of Object.entries(fields)) {
      if (a[f] === null || a[f] === undefined || !Number.isFinite(a[f])) errors.push(`'${label}' is required.`);
    }
    return errors;
  }

  function fmtNum(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e9 || a < 1e-3)) return v.toExponential(2);
    return Number(v.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  /** Short position summary. `fmtX` formats X values (e.g. as dates). */
  function describeAnnotation(a, fmtX) {
    const fields = KIND_FIELDS[a.kind] || {};
    const parts = Object.keys(fields).map((f) => `${f}=${f[0] === 'x' && fmtX ? fmtX(a[f]) : fmtNum(a[f])}`);
    if (Object.keys(fields).some((f) => f[0] === 'y')) parts.push(a.y_ref === AXES_FRACTION ? '(fraction)' : `(${a.y_ref})`);
    return parts.join(' ');
  }

  function serializeAnnotations(list) {
    return JSON.stringify({ version: 1, annotations: list.map(({ id, ...rest }) => rest) }, null, 2);
  }

  /** Accepts an annotations file (desktop or web), a bare list, or a project file. */
  function parseAnnotationFile(text) {
    const data = JSON.parse(text);
    const items = Array.isArray(data) ? data : data.annotations || (data.doc && data.doc.annotations) || [];
    return items.map(normalizeAnnotation);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Figure building
  // ═══════════════════════════════════════════════════════════════════════════

  const AXIS_OFFSET_PX = 64;
  const GL_THRESHOLD = 20000;
  const ACCENT = '#2563eb';

  function axisKey(id) { return id[0] + 'axis' + id.slice(1); }

  /** {col: {xid, yid}} for the currently selected series under the current layout mode. */
  function seriesAxes(doc) {
    const n = doc.selected.length;
    const out = {};
    doc.selected.forEach((col, i) => {
      if (doc.style.layout === 'shared') out[col] = { xid: 'x', yid: 'y' };
      else if (doc.style.layout === 'stacked') out[col] = { xid: i === n - 1 ? 'x' : `x${i + 2}`, yid: i === 0 ? 'y' : `y${i + 1}` };
      else out[col] = { xid: 'x', yid: i === 0 ? 'y' : `y${i + 1}` };
    });
    return out;
  }

  function autoTitle(doc, ds) {
    if ((doc.title || '').trim()) return doc.title.trim();
    if (!doc.style.autoTitle || !ds) return '';
    return fileStem(ds.fileName);
  }

  function baseAxis(theme, style) {
    return {
      showgrid: !!style.grid, gridcolor: theme.grid, gridwidth: 1, zeroline: false,
      showline: true, linecolor: theme.line, linewidth: 1, ticks: 'outside', tickcolor: theme.line,
      ticklen: 5, automargin: true, mirror: false,
      title: { font: { size: style.fontSize + 1 }, standoff: 8 },
      tickfont: { size: style.fontSize - 1 },
    };
  }

  /**
   * Build a Plotly figure.
   * opts: {plotSize: {w, h}, selectedId, forExport}
   * Returns {data, layout, refs: {annotations: [], shapes: []}, warnings, axes}
   *   refs.annotations[i] = {id, role}  – role of the i-th Plotly annotation
   */
  function buildFigure(doc, ds, opts) {
    opts = opts || {};
    const style = doc.style;
    const theme = THEMES[style.theme] || THEMES.clean;
    const plotSize = opts.plotSize || { w: 900, h: 500 };
    const axes = seriesAxes(doc);
    const n = doc.selected.length;
    const isDate = ds && ds.types[doc.xCol] === 'date';
    const x = ds ? column(ds, doc.xCol) : [];
    const useGL = ds && ds.n > GL_THRESHOLD;

    const data = doc.selected.map((col) => {
      const s = (doc.series && doc.series[col]) || {};
      const color = seriesColor(doc, col);
      return {
        type: useGL ? 'scattergl' : 'scatter',
        mode: style.markers ? 'lines+markers' : 'lines',
        x, y: column(ds, col), name: seriesName(doc, col),
        xaxis: axes[col].xid, yaxis: axes[col].yid,
        line: { color, width: style.lineWidth, dash: s.dash || 'solid' },
        marker: { color, size: Math.max(3, style.lineWidth * 2.5) },
        hovertemplate: '%{y:.5~g}<extra>%{fullData.name}</extra>',
        connectgaps: false,
      };
    });

    const title = autoTitle(doc, ds);
    const legend = {
      top: { orientation: 'h', x: 0, xanchor: 'left', y: 1.0, yanchor: 'bottom', bgcolor: 'rgba(0,0,0,0)' },
      bottom: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.12, yanchor: 'top', bgcolor: 'rgba(0,0,0,0)' },
      right: { orientation: 'v', x: 1.02, xanchor: 'left', y: 1, yanchor: 'top', bgcolor: 'rgba(0,0,0,0)' },
      inside: { orientation: 'v', x: 0.01, xanchor: 'left', y: 0.99, yanchor: 'top', bgcolor: theme.boxBg, bordercolor: theme.grid, borderwidth: 1 },
    }[style.legend];

    const layout = {
      paper_bgcolor: theme.paper, plot_bgcolor: theme.plot,
      font: { family: theme.font, size: style.fontSize, color: theme.fontColor },
      title: title ? { text: title, x: 0, xref: 'paper', xanchor: 'left', y: 0.98, yref: 'container', yanchor: 'top', font: { size: style.fontSize + 6 } } : undefined,
      margin: { l: 64, r: 28, t: title ? 72 : 36, b: 56, pad: 0 },
      showlegend: style.legend !== 'none' && n > 0,
      legend: Object.assign({ font: { size: style.fontSize - 1 } }, legend || {}),
      hovermode: 'x unified',
      hoverlabel: { font: { family: theme.font } },
      dragmode: 'zoom',
      // Keep the user's zoom across redraws, but reset it when the axes fundamentally change
      uirevision: `${ds ? ds.fileName : ''}|${doc.xCol}|${style.layout}`,
      annotations: [], shapes: [],
    };
    if (style.legend === 'top' && title) layout.margin.t += 8;

    // ── X axis ─────────────────────────────────────────────────────────────
    const xBase = Object.assign(baseAxis(theme, style), {
      type: isDate ? 'date' : 'linear',
      title: Object.assign(baseAxis(theme, style).title, { text: xAxisTitle(doc) }),
      mirror: theme.mirror && style.layout !== 'stacked' ? 'ticks' : false,
    });
    if (doc.range) xBase.range = doc.range.slice();
    else xBase.autorange = true;
    layout.xaxis = xBase;

    // ── Y axes ─────────────────────────────────────────────────────────────
    if (n === 0) {
      layout.yaxis = Object.assign(baseAxis(theme, style), { showticklabels: false, showgrid: false });
    } else if (style.layout === 'shared') {
      const units = [...new Set(doc.selected.map((c) => ((doc.series[c] || {}).unit || '').trim()))];
      let text = (style.sharedYLabel || '').trim();
      if (!text) text = n === 1 ? seriesName(doc, doc.selected[0]) : (units.length === 1 && units[0] ? `Value [${units[0]}]` : 'Value');
      layout.yaxis = Object.assign(baseAxis(theme, style), { mirror: theme.mirror ? 'ticks' : false });
      layout.yaxis.title.text = text;
    } else if (style.layout === 'stacked') {
      const gap = n > 6 ? 0.02 : 0.04;
      const h = (1 - gap * (n - 1)) / n;
      doc.selected.forEach((col, i) => {
        const { xid, yid } = axes[col];
        const top = 1 - i * (h + gap);
        const color = seriesColor(doc, col);
        const ya = Object.assign(baseAxis(theme, style), {
          domain: [Math.max(0, top - h), top], anchor: xid, mirror: theme.mirror ? 'ticks' : false,
        });
        ya.title.text = seriesName(doc, col);
        ya.title.font = { size: style.fontSize, color };
        layout[axisKey(yid)] = ya;
        if (xid !== 'x') {
          layout[axisKey(xid)] = Object.assign(baseAxis(theme, style), {
            matches: 'x', anchor: yid, showticklabels: false, type: xBase.type,
            mirror: theme.mirror ? 'ticks' : false,
          });
        }
      });
      layout.xaxis.anchor = axes[doc.selected[n - 1]].yid;
      layout.xaxis.mirror = theme.mirror ? 'ticks' : false;
    } else {
      // Overlay: series 0 left, 1 right, then alternate outward left/right
      const frac = AXIS_OFFSET_PX / Math.max(300, plotSize.w);
      let left = 0, right = 0;
      const place = doc.selected.map((_, i) => {
        if (i === 0) return { side: 'left', k: 0 };
        if (i === 1) return { side: 'right', k: 0 };
        if (i % 2 === 0) { left += 1; return { side: 'left', k: left }; }
        right += 1; return { side: 'right', k: right };
      });
      const d0 = Math.min(0.4, left * frac), d1 = Math.max(0.6, 1 - right * frac);
      layout.xaxis.domain = [d0, d1];
      doc.selected.forEach((col, i) => {
        const { yid } = axes[col];
        const color = seriesColor(doc, col);
        const ya = Object.assign(baseAxis(theme, style), {
          side: place[i].side, linecolor: color, tickcolor: color,
          tickfont: { size: style.fontSize - 1, color },
          showgrid: i === 0 && !!style.grid,
        });
        ya.title.text = seriesName(doc, col);
        ya.title.font = { size: style.fontSize, color };
        if (i > 0) ya.overlaying = 'y';
        if (place[i].k === 0) ya.anchor = 'x';
        else {
          ya.anchor = 'free';
          ya.position = place[i].side === 'left' ? Math.max(0, d0 - place[i].k * frac) : Math.min(1, d1 + place[i].k * frac);
        }
        layout[axisKey(yid)] = ya;
      });
      if (n === 1 && theme.mirror) layout.yaxis.mirror = 'ticks';
    }

    // ── Annotations ────────────────────────────────────────────────────────
    const refs = { annotations: [], shapes: [] };
    const warnings = [];
    const ctx = { doc, theme, axes, plotSize, selectedId: opts.selectedId, forExport: !!opts.forExport, layout, refs };
    (doc.annotations || []).forEach((a, i) => {
      if (!a.visible) return;
      const errs = validateAnnotation(a);
      if (errs.length) { warnings.push(`#${i + 1}: ${errs.join(' ')}`); return; }
      const usesY = Object.keys(KIND_FIELDS[a.kind]).some((f) => f[0] === 'y');
      if (usesY && a.y_ref !== AXES_FRACTION && !axes[a.y_ref]) {
        warnings.push(`#${i + 1} hidden: Y axis '${a.y_ref}' is not plotted`);
        return;
      }
      renderAnnotation(a, ctx);
    });

    return { data, layout, refs, warnings, axes };
  }

  function yRefId(a, ctx) {
    return a.y_ref === AXES_FRACTION ? 'paper' : ctx.axes[a.y_ref].yid;
  }

  function htmlText(t) {
    return String(t).replace(/\n/g, '<br>');
  }

  function boxProps(a, ctx, selected) {
    const props = { borderpad: 4 };
    if (a.box === 'outline') Object.assign(props, { bgcolor: ctx.theme.boxBg, bordercolor: a.color, borderwidth: 1 });
    else if (a.box === 'filled') Object.assign(props, { bgcolor: a.color, bordercolor: a.color, borderwidth: 1 });
    else Object.assign(props, { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0 });
    if (selected) Object.assign(props, { bordercolor: ACCENT, borderwidth: 2 });
    return props;
  }

  function fontFor(a) {
    return { size: a.fontsize, color: a.box === 'filled' ? '#ffffff' : a.color };
  }

  function pushAnn(ctx, a, role, ann) {
    ann.captureevents = true;
    ctx.layout.annotations.push(ann);
    ctx.refs.annotations.push({ id: a.id, role });
  }

  function pushShape(ctx, a, role, shape) {
    ctx.layout.shapes.push(shape);
    ctx.refs.shapes.push({ id: a.id, role });
  }

  /** Default label placement relative to each kind's anchor (px; ay positive = down). */
  const LABEL_BASE = {
    [K.XSPAN]: { ax: 0, ay: 14, xanchor: 'center', yanchor: 'top' },
    [K.YSPAN]: { ax: 6, ay: 0, xanchor: 'left', yanchor: 'middle' },
    [K.VLINE]: { ax: 5, ay: 5, xanchor: 'left', yanchor: 'top' },
    [K.HLINE]: { ax: 6, ay: -4, xanchor: 'left', yanchor: 'bottom' },
    [K.BRACKET]: { ax: 0, ay: -6, xanchor: 'center', yanchor: 'bottom' },
    [K.MARKER]: { ax: 10, ay: -10, xanchor: 'left', yanchor: 'bottom' },
    [K.RECT]: { ax: 4, ay: 4, xanchor: 'left', yanchor: 'top' },
  };

  function labelAnchor(a) {
    switch (a.kind) {
      case K.XSPAN: return { x: (a.x + a.x2) / 2, y: 1, xref: 'x', yref: 'paper' };
      case K.YSPAN: return { x: 0, y: (a.y + a.y2) / 2, xref: 'x domain' };
      case K.VLINE: return { x: a.x, y: 1, xref: 'x', yref: 'paper' };
      case K.HLINE: return { x: 0, y: a.y, xref: 'x domain' };
      case K.BRACKET: return { x: (a.x + a.x2) / 2, y: a.y, xref: 'x' };
      case K.MARKER: return { x: a.x, y: a.y, xref: 'x' };
      case K.RECT: return { x: Math.min(a.x, a.x2), y: Math.max(a.y, a.y2), xref: 'x' };
      default: return null;
    }
  }

  function addLabel(a, ctx, selected) {
    if (!a.text) return;
    const anchor = labelAnchor(a);
    const base = LABEL_BASE[a.kind];
    const ax = base.ax + a.text_dx, ay = base.ay - a.text_dy;
    const leader = a.leader && Math.hypot(a.text_dx, a.text_dy) >= 3;
    pushAnn(ctx, a, 'label', Object.assign({
      x: anchor.x, y: anchor.y, xref: anchor.xref, yref: anchor.yref || yRefId(a, ctx),
      text: htmlText(a.text), font: fontFor(a), showarrow: true, axref: 'pixel', ayref: 'pixel', ax, ay,
      xanchor: base.xanchor, yanchor: base.yanchor, textangle: base.textangle || 0, align: 'left',
      arrowhead: 0, arrowwidth: 1, arrowcolor: leader ? a.color : 'rgba(0,0,0,0)', standoff: 0,
    }, boxProps(a, ctx, selected)));
  }

  function renderAnnotation(a, ctx) {
    const selected = !ctx.forExport && ctx.selectedId === a.id;
    const yref = yRefId(a, ctx);
    const dash = LINESTYLES[a.linestyle] || 'solid';
    const glow = (shape) => {
      if (!selected) return;
      pushShape(ctx, a, 'selection', Object.assign({}, shape, {
        fillcolor: 'rgba(0,0,0,0)', opacity: 1, layer: 'above',
        line: { color: ACCENT, width: (shape.type === 'line' ? a.linewidth + 5 : 1.5), dash: shape.type === 'line' ? 'solid' : 'dot' },
        ...(shape.type === 'line' ? { opacity: 0.3 } : {}),
      }));
    };

    switch (a.kind) {
      case K.TEXT:
        pushAnn(ctx, a, 'text', Object.assign({
          x: a.x, y: a.y, xref: 'x', yref, text: htmlText(a.text || ' '), font: fontFor(a),
          showarrow: false, xanchor: 'center', yanchor: 'middle', align: 'left',
        }, boxProps(a, ctx, selected)));
        break;

      case K.ARROW: {
        const st = ARROWSTYLES[a.arrowstyle] || ARROWSTYLES['->'];
        const pixelY = yref === 'paper';
        pushAnn(ctx, a, 'arrow', Object.assign({
          x: a.x, y: a.y, xref: 'x', yref, text: htmlText(a.text), font: fontFor(a),
          showarrow: true, axref: 'x', ax: a.x2,
          ayref: pixelY ? 'pixel' : yref, ay: pixelY ? -(a.y2 - a.y) * ctx.plotSize.h : a.y2,
          arrowhead: st.head, startarrowhead: st.head, arrowside: st.side === 'none' ? 'end' : st.side,
          arrowsize: 1, arrowwidth: a.linewidth, arrowcolor: a.color, standoff: 1, startstandoff: 1,
        }, boxProps(a, ctx, selected)));
        break;
      }

      case K.BRACKET: {
        const st = ARROWSTYLES[a.arrowstyle] || ARROWSTYLES['<->'];
        const pixelY = yref === 'paper';
        pushAnn(ctx, a, 'bracket', {
          x: a.x, y: a.y, xref: 'x', yref, text: '', showarrow: true,
          axref: 'x', ax: a.x2, ayref: pixelY ? 'pixel' : yref, ay: pixelY ? 0 : a.y,
          arrowhead: st.head, startarrowhead: st.head, arrowside: st.side === 'none' ? 'end' : st.side,
          arrowsize: 1, arrowwidth: a.linewidth, arrowcolor: selected ? ACCENT : a.color, standoff: 0, startstandoff: 0,
        });
        if (st.side === 'none' && !st.ticks) { /* plain line: head 0 already */ }
        if (st.ticks) {
          for (const xv of [a.x, a.x2]) {
            pushShape(ctx, a, 'tick', {
              type: 'line', xref: 'x', x0: xv, x1: xv, yref, ysizemode: 'pixel', yanchor: a.y, y0: -7, y1: 7,
              line: { color: a.color, width: a.linewidth }, layer: 'above',
            });
          }
        }
        addLabel(a, ctx, selected);
        break;
      }

      case K.XSPAN: {
        const shape = {
          type: 'rect', xref: 'x', yref: 'paper', x0: a.x, x1: a.x2, y0: 0, y1: 1,
          fillcolor: a.color, opacity: a.alpha, line: { width: 0 }, layer: 'below',
        };
        pushShape(ctx, a, 'xspan', shape);
        glow(shape);
        addLabel(a, ctx, selected);
        break;
      }

      case K.YSPAN: {
        const shape = {
          type: 'rect', xref: 'x domain', yref, x0: 0, x1: 1, y0: a.y, y1: a.y2,
          fillcolor: a.color, opacity: a.alpha, line: { width: 0 }, layer: 'below',
        };
        pushShape(ctx, a, 'yspan', shape);
        glow(shape);
        addLabel(a, ctx, selected);
        break;
      }

      case K.VLINE: {
        const shape = { type: 'line', xref: 'x', yref: 'paper', x0: a.x, x1: a.x, y0: 0, y1: 1, line: { color: a.color, width: a.linewidth, dash }, layer: 'above' };
        glow(shape);
        pushShape(ctx, a, 'vline', shape);
        addLabel(a, ctx, selected);
        break;
      }

      case K.HLINE: {
        const shape = { type: 'line', xref: 'x domain', yref, x0: 0, x1: 1, y0: a.y, y1: a.y, line: { color: a.color, width: a.linewidth, dash }, layer: 'above' };
        glow(shape);
        pushShape(ctx, a, 'hline', shape);
        addLabel(a, ctx, selected);
        break;
      }

      case K.MARKER:
        pushAnn(ctx, a, 'marker', {
          x: a.x, y: a.y, xref: 'x', yref, text: (MARKERS[a.marker] || MARKERS.o)[1], showarrow: false,
          font: { size: a.markersize, color: a.color }, xanchor: 'center', yanchor: 'middle',
          bgcolor: 'rgba(0,0,0,0)', borderpad: 0,
          borderwidth: selected ? 1.5 : 0, bordercolor: ACCENT,
        });
        addLabel(a, ctx, selected);
        break;

      case K.RECT: {
        const fill = a.color.length === 7 ? a.color + Math.round(a.alpha * 255).toString(16).padStart(2, '0') : a.color;
        const shape = {
          type: 'rect', xref: 'x', yref, x0: a.x, x1: a.x2, y0: a.y, y1: a.y2,
          fillcolor: fill, line: { color: a.color, width: a.linewidth, dash }, layer: 'above',
        };
        pushShape(ctx, a, 'rect', shape);
        glow(shape);
        addLabel(a, ctx, selected);
        break;
      }
      default:
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Interaction maths (pixel ⇄ annotation)
  // ═══════════════════════════════════════════════════════════════════════════

  function convertY(y, fromRef, toRef, conv) {
    if (y === null || y === undefined || fromRef === toRef) return y;
    return conv.px2y(conv.y2px(y, fromRef), toRef);
  }

  /**
   * Create an annotation from a press at p1 dragged to p2 (px).
   * opts: {yRef, color}
   */
  function createFromDrag(kind, p1, p2, conv, opts) {
    opts = opts || {};
    const yRef = opts.yRef || AXES_FRACTION;
    const P = conv.plot;
    const clicked = Math.hypot(p2.x - p1.x, p2.y - p1.y) < 5;
    let q = p2;
    if (clicked) {
      const dx = P.w * 0.1, dy = P.h * 0.15;
      if (kind === K.ARROW) q = { x: p1.x + (p1.x + 90 < P.l + P.w ? 70 : -70), y: p1.y + (p1.y - 70 > P.t ? -55 : 55) };
      else if (kind === K.BRACKET || kind === K.XSPAN) q = { x: Math.min(P.l + P.w, p1.x + dx), y: p1.y };
      else if (kind === K.YSPAN) q = { x: p1.x, y: Math.max(P.t, p1.y - dy) };
      else if (kind === K.RECT) q = { x: Math.min(P.l + P.w, p1.x + dx), y: Math.max(P.t, p1.y - dy) };
    }
    const x1 = conv.px2x(p1.x), x2 = conv.px2x(q.x);
    const y1 = conv.px2y(p1.y, yRef), y2 = conv.px2y(q.y, yRef);
    const props = { y_ref: yRef };
    if (opts.color) props.color = opts.color;
    switch (kind) {
      case K.TEXT: Object.assign(props, { x: x1, y: y1 }); break;
      case K.ARROW: Object.assign(props, { x: x1, y: y1, x2, y2 }); break;
      case K.BRACKET: Object.assign(props, { x: Math.min(x1, x2), x2: Math.max(x1, x2), y: y1, arrowstyle: '<->' }); break;
      case K.XSPAN: Object.assign(props, { x: Math.min(x1, x2), x2: Math.max(x1, x2) }); break;
      case K.YSPAN: Object.assign(props, { y: Math.min(y1, y2), y2: Math.max(y1, y2) }); break;
      case K.VLINE: Object.assign(props, { x: x1 }); break;
      case K.HLINE: Object.assign(props, { y: y1 }); break;
      case K.MARKER: Object.assign(props, { x: x1, y: y1 }); break;
      case K.RECT: Object.assign(props, { x: Math.min(x1, x2), x2: Math.max(x1, x2), y: Math.min(y1, y2), y2: Math.max(y1, y2) }); break;
      default: break;
    }
    if (kind === K.HLINE || kind === K.VLINE || kind === K.XSPAN || kind === K.MARKER) props.text = '';
    return newAnnotation(kind, props);
  }

  /** Return a copy of `orig` with `fields` moved by (dx, dy) px. */
  function dragAnnotation(orig, fields, dx, dy, conv) {
    const a = Object.assign({}, orig);
    for (const f of fields) {
      if (f === 'text_dx') a.text_dx = Math.round((orig.text_dx + dx) * 10) / 10;
      else if (f === 'text_dy') a.text_dy = Math.round((orig.text_dy - dy) * 10) / 10;
      else if (f[0] === 'x') a[f] = conv.px2x(conv.x2px(orig[f]) + dx);
      else if (f[0] === 'y') a[f] = conv.px2y(conv.y2px(orig[f], orig.y_ref) + dy, orig.y_ref);
    }
    return a;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const vx = x2 - x1, vy = y2 - y1;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / len2)) : 0;
    return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy));
  }

  const ALL_FIELDS = (a) => Object.keys(KIND_FIELDS[a.kind]);

  /**
   * Find what is under (px, py).
   * labelRects: [{id, role, left, top, right, bottom}] – on-screen boxes of Plotly
   *             annotations (text, arrow text, marker glyphs, labels), topmost last.
   * Returns {id, fields, cursor} or null.
   */
  function hitTest(annotations, px, py, conv, labelRects, tol) {
    tol = tol || 6;
    const P = conv.plot;
    const inPlot = px >= P.l - tol && px <= P.l + P.w + tol && py >= P.t - tol && py <= P.t + P.h + tol;

    for (let i = (labelRects || []).length - 1; i >= 0; i--) {
      const r = labelRects[i];
      if (px < r.left - 2 || px > r.right + 2 || py < r.top - 2 || py > r.bottom + 2) continue;
      const a = annotations.find((x) => x.id === r.id);
      if (!a || !a.visible) continue;
      if (r.role === 'text' || r.role === 'marker') return { id: a.id, fields: ['x', 'y'], cursor: 'move' };
      if (r.role === 'arrow') return { id: a.id, fields: ['x2', 'y2'], cursor: 'move' };
      if (r.role === 'label') return { id: a.id, fields: ['text_dx', 'text_dy'], cursor: 'move' };
    }
    if (!inPlot) return null;

    let bodyHit = null;
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (!a.visible || validateAnnotation(a).length) continue;
      const X = (v) => conv.x2px(v);
      const Y = (v) => conv.y2px(v, a.y_ref);
      try {
        switch (a.kind) {
          case K.VLINE:
            if (Math.abs(px - X(a.x)) <= tol) return { id: a.id, fields: ['x'], cursor: 'ew-resize' };
            break;
          case K.HLINE:
            if (Math.abs(py - Y(a.y)) <= tol) return { id: a.id, fields: ['y'], cursor: 'ns-resize' };
            break;
          case K.XSPAN: {
            const [l, r] = [X(a.x), X(a.x2)];
            if (Math.abs(px - l) <= tol) return { id: a.id, fields: ['x'], cursor: 'ew-resize' };
            if (Math.abs(px - r) <= tol) return { id: a.id, fields: ['x2'], cursor: 'ew-resize' };
            if (!bodyHit && px > Math.min(l, r) && px < Math.max(l, r)) bodyHit = { id: a.id, fields: ['x', 'x2'], cursor: 'move' };
            break;
          }
          case K.YSPAN: {
            const [b, t] = [Y(a.y), Y(a.y2)];
            if (Math.abs(py - b) <= tol) return { id: a.id, fields: ['y'], cursor: 'ns-resize' };
            if (Math.abs(py - t) <= tol) return { id: a.id, fields: ['y2'], cursor: 'ns-resize' };
            if (!bodyHit && py > Math.min(b, t) && py < Math.max(b, t)) bodyHit = { id: a.id, fields: ['y', 'y2'], cursor: 'move' };
            break;
          }
          case K.RECT: {
            const x1 = X(a.x), x2 = X(a.x2), y1 = Y(a.y), y2 = Y(a.y2);
            const nx1 = Math.abs(px - x1) <= tol, nx2 = Math.abs(px - x2) <= tol;
            const ny1 = Math.abs(py - y1) <= tol, ny2 = Math.abs(py - y2) <= tol;
            const withinX = px >= Math.min(x1, x2) - tol && px <= Math.max(x1, x2) + tol;
            const withinY = py >= Math.min(y1, y2) - tol && py <= Math.max(y1, y2) + tol;
            const f = [];
            if (withinY && nx1) f.push('x'); else if (withinY && nx2) f.push('x2');
            if (withinX && ny1) f.push('y'); else if (withinX && ny2) f.push('y2');
            if (f.length === 2) return { id: a.id, fields: f, cursor: 'crosshair' };
            if (f.length === 1) return { id: a.id, fields: f, cursor: f[0][0] === 'x' ? 'ew-resize' : 'ns-resize' };
            if (!bodyHit && withinX && withinY) bodyHit = { id: a.id, fields: ['x', 'y', 'x2', 'y2'], cursor: 'move' };
            break;
          }
          case K.BRACKET: {
            const x1 = X(a.x), x2 = X(a.x2), y = Y(a.y);
            if (Math.hypot(px - x1, py - y) <= tol + 2) return { id: a.id, fields: ['x', 'y'], cursor: 'crosshair' };
            if (Math.hypot(px - x2, py - y) <= tol + 2) return { id: a.id, fields: ['x2', 'y'], cursor: 'crosshair' };
            if (distToSegment(px, py, x1, y, x2, y) <= tol) return { id: a.id, fields: ['x', 'x2', 'y'], cursor: 'move' };
            break;
          }
          case K.ARROW: {
            const x1 = X(a.x), y1 = Y(a.y), x2 = X(a.x2), y2 = Y(a.y2);
            if (Math.hypot(px - x1, py - y1) <= tol + 3) return { id: a.id, fields: ['x', 'y'], cursor: 'crosshair' };
            if (distToSegment(px, py, x1, y1, x2, y2) <= tol - 1) return { id: a.id, fields: ALL_FIELDS(a), cursor: 'move' };
            break;
          }
          case K.MARKER:
            if (Math.hypot(px - X(a.x), py - Y(a.y)) <= Math.max(tol, a.markersize / 2)) return { id: a.id, fields: ['x', 'y'], cursor: 'move' };
            break;
          default:
            break;
        }
      } catch (e) { /* axis not plotted – skip */ }
    }
    return bodyHit;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Undo / redo
  // ═══════════════════════════════════════════════════════════════════════════

  class History {
    constructor(limit) { this.limit = limit || 200; this.past = []; this.future = []; }
    /** Record the state *before* a change. */
    push(snapshot) {
      if (this.past.length && this.past[this.past.length - 1] === snapshot) return;
      this.past.push(snapshot);
      if (this.past.length > this.limit) this.past.shift();
      this.future = [];
    }
    undo(current) {
      if (!this.past.length) return null;
      this.future.push(current);
      return this.past.pop();
    }
    redo(current) {
      if (!this.future.length) return null;
      this.past.push(current);
      return this.future.pop();
    }
    get canUndo() { return this.past.length > 0; }
    get canRedo() { return this.future.length > 0; }
  }

  return {
    // csv / data
    detectDelimiter, parseCSV, parseNumber, parseDateUTC, detectType, createDataset, column, extent, fileStem,
    parseGroups, groupColumns,
    // labels / export
    displayLabel, seriesName, xAxisTitle, exportCSV, csvEscape,
    // style
    PALETTES, THEMES, LAYOUTS, LEGENDS, DASHES, defaultStyle, seriesColor,
    // annotations
    AXES_FRACTION, K, KINDS, KIND_FIELDS, KIND_STYLES, KIND_ICONS, KIND_HINTS, DATA_ANCHORED,
    ARROWSTYLES, MARKERS, BOXES, LINESTYLES, ANNOTATION_DEFAULTS,
    normalizeAnnotation, newAnnotation, validateAnnotation, describeAnnotation, fmtNum,
    serializeAnnotations, parseAnnotationFile,
    // figure
    seriesAxes, axisKey, buildFigure, autoTitle, LABEL_BASE,
    // interaction
    convertY, createFromDrag, dragAnnotation, hitTest, distToSegment,
    History,
  };
});
