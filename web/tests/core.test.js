'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const { K } = C;

// Linear fake of the browser converter: plot area 100..900 x 50..450 px,
// X data 0..10, column 'a' 0..100, column 'b' -1..1.
function fakeConv() {
  const plot = { l: 100, t: 50, w: 800, h: 400 };
  const yr = { a: [0, 100], b: [-1, 1] };
  return {
    plot,
    x2px: (x) => plot.l + (x / 10) * plot.w,
    px2x: (px) => ((px - plot.l) / plot.w) * 10,
    y2px: (y, ref) => {
      if (ref === C.AXES_FRACTION) return plot.t + (1 - y) * plot.h;
      if (!yr[ref]) return NaN;
      const [lo, hi] = yr[ref];
      return plot.t + (1 - (y - lo) / (hi - lo)) * plot.h;
    },
    px2y: (py, ref) => {
      const f = 1 - (py - plot.t) / plot.h;
      if (ref === C.AXES_FRACTION) return f;
      const [lo, hi] = yr[ref];
      return lo + f * (hi - lo);
    },
  };
}

function sampleDataset() {
  const { header, rows } = C.parseCSV('t,temp_1,temp_2,label\n0,1,10,a\n1,2,20,b\n2,3,30,c\n3,4,40,d\n');
  return C.createDataset(header, rows, 'run.csv');
}

function sampleDoc(extra) {
  return Object.assign({
    xCol: 't', selected: ['temp_1', 'temp_2'], series: {}, xLabel: '', xUnit: '', title: '',
    style: C.defaultStyle(), annotations: [], range: null,
  }, extra || {});
}

// ── CSV ────────────────────────────────────────────────────────────────────
test('parseCSV handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
  const { header, rows } = C.parseCSV('\ufeffa,b\r\n1,"x, ""y"""\r\n\r\n2,"multi\nline"\r\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows, [['1', 'x, "y"'], ['2', 'multi\nline']]);
});

test('parseCSV auto-detects semicolons and tabs, and de-duplicates headers', () => {
  assert.deepEqual(C.parseCSV('a;b\n1;2').rows, [['1', '2']]);
  assert.deepEqual(C.parseCSV('a\tb\n1\t2').rows, [['1', '2']]);
  assert.deepEqual(C.parseCSV('v,v,\n1,2,3').header, ['v', 'v.1', 'Column 3']);
});

test('parseDateUTC treats zone-less ISO as UTC and honours offsets', () => {
  assert.equal(C.parseDateUTC('2024-01-02 03:04:05'), Date.UTC(2024, 0, 2, 3, 4, 5));
  assert.equal(C.parseDateUTC('2024-01-02T03:04:05.250Z'), Date.UTC(2024, 0, 2, 3, 4, 5, 250));
  assert.equal(C.parseDateUTC('2024-01-02T03:00:00+02:00'), Date.UTC(2024, 0, 2, 1));
  assert.ok(Number.isNaN(C.parseDateUTC('12345')));
});

test('column types are detected and numeric views are cached', () => {
  const { header, rows } = C.parseCSV('when,v,name\n2024-01-01,1,a\n2024-01-02,,b\n');
  const ds = C.createDataset(header, rows, 'x.csv');
  assert.deepEqual(ds.types, { when: 'date', v: 'number', name: 'text' });
  const v = C.column(ds, 'v');
  assert.equal(v[0], 1);
  assert.ok(Number.isNaN(v[1]));
  assert.equal(C.column(ds, 'v'), v);
  assert.equal(C.column(ds, 'when')[1], Date.UTC(2024, 0, 2));
});

test('groupColumns matches desktop grouping: groups first, then singles, A–Z', () => {
  const g = C.groupColumns(['zeta', 'sensor_2', 'alpha', 'sensor_1', 'b_1x', 'b_2x']);
  assert.deepEqual(g.map((x) => [x.name, x.members]), [
    ['b', ['b_1x', 'b_2x']], ['sensor', ['sensor_2', 'sensor_1']], ['alpha', ['alpha']], ['zeta', ['zeta']],
  ]);
});

test('exportCSV applies range and renamed headers', () => {
  const ds = sampleDataset();
  const doc = sampleDoc({ selected: ['temp_1'], series: { temp_1: { label: 'Temp', unit: '°C' } }, xUnit: 's' });
  const { text, rowCount } = C.exportCSV(ds, doc, [1, 2]);
  assert.equal(rowCount, 2);
  assert.equal(text, 't [s],Temp [°C]\n1,2\n2,3\n');
});

// ── Annotations model ──────────────────────────────────────────────────────
test('normalizeAnnotation accepts desktop JSON and maps unsupported styles', () => {
  const a = C.normalizeAnnotation({ kind: K.ARROW, text: 'peak', x: 1, y: 2, x2: 3, y2: 4, box: 'round', arrowstyle: 'fancy', connection: 'arc3', fontsize: 9 });
  assert.equal(a.box, 'outline');
  assert.equal(a.arrowstyle, '-|>');
  assert.equal(a.fontsize, 9);
  assert.equal(a.connection, undefined);
  assert.ok(a.id);
});

test('annotation files round-trip and accept bare lists / project files', () => {
  const list = [C.newAnnotation(K.XSPAN, { x: 1, x2: 2, text: 's' })];
  const back = C.parseAnnotationFile(C.serializeAnnotations(list));
  assert.equal(back[0].x2, 2);
  assert.equal(C.parseAnnotationFile(JSON.stringify([{ kind: K.VLINE, x: 3 }]))[0].x, 3);
  assert.equal(C.parseAnnotationFile(JSON.stringify({ doc: { annotations: [{ kind: K.HLINE, y: 1 }] } }))[0].y, 1);
});

test('validateAnnotation reports missing coordinates', () => {
  assert.equal(C.validateAnnotation(C.newAnnotation(K.XSPAN, { x: 1, x2: null })).length, 1);
  assert.deepEqual(C.validateAnnotation(C.newAnnotation(K.XSPAN, { x: 1, x2: 2 })), []);
});

// ── Figure building ────────────────────────────────────────────────────────
test('overlay layout gives each series its own coloured Y axis', () => {
  const fig = C.buildFigure(sampleDoc(), sampleDataset());
  assert.equal(fig.data.length, 2);
  assert.equal(fig.data[1].yaxis, 'y2');
  assert.equal(fig.layout.yaxis2.overlaying, 'y');
  assert.equal(fig.layout.yaxis2.side, 'right');
  assert.equal(fig.layout.yaxis2.tickfont.color, fig.data[1].line.color);
});

test('overlay layout with many series places extra axes outward and shrinks the domain', () => {
  const ds = C.createDataset(['t', 'a', 'b', 'c', 'd'], [['0', '1', '2', '3', '4']], 'x.csv');
  const fig = C.buildFigure(sampleDoc({ selected: ['a', 'b', 'c', 'd'] }), ds, { plotSize: { w: 1000, h: 500 } });
  const [d0, d1] = fig.layout.xaxis.domain;
  assert.ok(d0 > 0 && d1 < 1);
  assert.equal(fig.layout.yaxis3.anchor, 'free');
  assert.ok(fig.layout.yaxis3.position < d0);
  assert.ok(fig.layout.yaxis4.position > d1);
});

test('uirevision changes with file, X column and layout so stale zoom is dropped', () => {
  const ds = sampleDataset();
  const a = C.buildFigure(sampleDoc(), ds).layout.uirevision;
  const doc = sampleDoc();
  doc.style.layout = 'stacked';
  assert.notEqual(C.buildFigure(doc, ds).layout.uirevision, a);
  assert.notEqual(C.buildFigure(sampleDoc({ xCol: 'temp_1' }), ds).layout.uirevision, a);
  assert.equal(C.buildFigure(sampleDoc({ title: 'x' }), ds).layout.uirevision, a);
});

test('stacked layout uses one panel per series with matched X axes', () => {
  const doc = sampleDoc();
  doc.style.layout = 'stacked';
  const fig = C.buildFigure(doc, sampleDataset());
  assert.equal(fig.data[0].xaxis, 'x2');
  assert.equal(fig.data[1].xaxis, 'x');
  assert.equal(fig.layout.xaxis2.matches, 'x');
  assert.ok(fig.layout.yaxis.domain[0] > fig.layout.yaxis2.domain[1]);
});

test('shared layout puts everything on one axis with a common unit label', () => {
  const doc = sampleDoc({ series: { temp_1: { unit: 'K' }, temp_2: { unit: 'K' } } });
  doc.style.layout = 'shared';
  const fig = C.buildFigure(doc, sampleDataset());
  assert.deepEqual(fig.data.map((d) => d.yaxis), ['y', 'y']);
  assert.equal(fig.layout.yaxis.title.text, 'Value [K]');
});

test('every annotation kind renders and is mapped back to its id', () => {
  const ds = sampleDataset();
  const anns = C.KINDS.map((kind) => C.newAnnotation(kind, { text: 'lbl', x: 1, y: 0.5, x2: 2, y2: 0.8, arrowstyle: '|<->|' }));
  const fig = C.buildFigure(sampleDoc({ annotations: anns }), ds);
  assert.deepEqual(fig.warnings, []);
  const ids = new Set([...fig.refs.annotations, ...fig.refs.shapes].map((r) => r.id));
  assert.equal(ids.size, C.KINDS.length);
  assert.equal(fig.layout.annotations.length, fig.refs.annotations.length);
  assert.equal(fig.layout.shapes.length, fig.refs.shapes.length);
});

test('label nudges move the label and switch on a leader line', () => {
  const ds = sampleDataset();
  const a = C.newAnnotation(K.MARKER, { text: 'pt', x: 1, y: 2, y_ref: 'temp_1', text_dx: 30, text_dy: 20 });
  const fig = C.buildFigure(sampleDoc({ annotations: [a] }), ds);
  const i = fig.refs.annotations.findIndex((r) => r.role === 'label');
  const lbl = fig.layout.annotations[i];
  assert.equal(lbl.ax, C.LABEL_BASE[K.MARKER].ax + 30);
  assert.equal(lbl.ay, C.LABEL_BASE[K.MARKER].ay - 20);
  assert.equal(lbl.arrowcolor, a.color);
  assert.equal(lbl.yref, 'y');
});

test('annotations on unplotted axes are hidden with a warning', () => {
  const a = C.newAnnotation(K.HLINE, { y: 1, y_ref: 'missing' });
  const fig = C.buildFigure(sampleDoc({ annotations: [a] }), sampleDataset());
  assert.equal(fig.layout.shapes.length, 0);
  assert.match(fig.warnings[0], /missing/);
});

test('selection decoration is omitted from exports', () => {
  const a = C.newAnnotation(K.XSPAN, { x: 1, x2: 2 });
  const doc = sampleDoc({ annotations: [a] });
  const live = C.buildFigure(doc, sampleDataset(), { selectedId: a.id });
  const exp = C.buildFigure(doc, sampleDataset(), { selectedId: a.id, forExport: true });
  assert.ok(live.refs.shapes.some((r) => r.role === 'selection'));
  assert.ok(!exp.refs.shapes.some((r) => r.role === 'selection'));
});

// ── Interaction ────────────────────────────────────────────────────────────
test('createFromDrag builds spans from a drag and sensible defaults from a click', () => {
  const conv = fakeConv();
  const span = C.createFromDrag(K.XSPAN, { x: 500, y: 200 }, { x: 260, y: 220 }, conv);
  assert.equal(span.x, 2);
  assert.equal(span.x2, 5);
  const clicked = C.createFromDrag(K.XSPAN, { x: 500, y: 200 }, { x: 501, y: 200 }, conv);
  assert.ok(clicked.x2 > clicked.x);
  const arrow = C.createFromDrag(K.ARROW, { x: 500, y: 250 }, { x: 600, y: 150 }, conv, { yRef: 'a' });
  assert.deepEqual([arrow.x, arrow.y, arrow.x2, arrow.y2], [5, 50, 6.25, 75]);
  assert.equal(arrow.y_ref, 'a');
});

test('dragAnnotation moves only the requested fields, in the right units', () => {
  const conv = fakeConv();
  const a = C.newAnnotation(K.RECT, { x: 1, y: 10, x2: 2, y2: 20, y_ref: 'a' });
  const moved = C.dragAnnotation(a, ['x2', 'y2'], 80, -40, conv);
  assert.deepEqual([moved.x, moved.y, moved.x2, moved.y2].map((v) => +v.toFixed(9)), [1, 10, 3, 30]);
  const lbl = C.dragAnnotation(C.newAnnotation(K.MARKER, { text_dx: 5 }), ['text_dx', 'text_dy'], 10, 10, conv);
  assert.deepEqual([lbl.text_dx, lbl.text_dy], [15, -10]);
});

test('hitTest finds labels, edges and bodies with the right priority', () => {
  const conv = fakeConv();
  const span = C.newAnnotation(K.XSPAN, { x: 2, x2: 6 });
  const line = C.newAnnotation(K.VLINE, { x: 4 });
  const anns = [span, line];
  assert.deepEqual(C.hitTest(anns, 420, 200, conv).fields, ['x']);          // the line inside the span wins
  assert.equal(C.hitTest(anns, 420, 200, conv).id, line.id);
  assert.deepEqual(C.hitTest(anns, 262, 200, conv).fields, ['x']);          // span left edge
  assert.deepEqual(C.hitTest(anns, 580, 200, conv).fields, ['x2']);         // span right edge
  assert.deepEqual(C.hitTest(anns, 350, 200, conv).fields, ['x', 'x2']);    // span body
  assert.equal(C.hitTest(anns, 800, 200, conv), null);
  const rects = [{ id: span.id, role: 'label', left: 340, right: 380, top: 190, bottom: 210 }];
  assert.deepEqual(C.hitTest(anns, 350, 200, conv, rects).fields, ['text_dx', 'text_dy']);
});

test('convertY re-expresses values between axes', () => {
  const conv = fakeConv();
  assert.equal(C.convertY(50, 'a', 'b', conv), 0);
  assert.equal(C.convertY(0, 'b', C.AXES_FRACTION, conv), 0.5);
});

test('History supports undo and redo', () => {
  const h = new C.History();
  h.push('s0');
  h.push('s1');
  assert.equal(h.undo('s2'), 's1');
  assert.equal(h.undo('s1'), 's0');
  assert.equal(h.redo('s0'), 's1');
  h.push('x');
  assert.equal(h.canRedo, false);
});
