"""
Plot annotations for CSV Plotter.

Holds the annotation data model, JSON (de)serialisation, and the code that
turns annotations into matplotlib artists.  Contains no tkinter code so it can
be tested headless.

Coordinates
-----------
* X values are always in data units of the X column (shared by every Y axis).
* Y values are interpreted according to ``Annotation.y_ref``:
    - ``AXES_FRACTION`` → 0 = bottom of the plot, 1 = top.
    - a column name     → data units of that column's Y axis.  If that column
      is not currently plotted the annotation is skipped.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, fields

from matplotlib.colors import to_rgba
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle
from matplotlib.transforms import blended_transform_factory

AXES_FRACTION = "Axes fraction (0–1)"

# ── Annotation kinds ──────────────────────────────────────────────────────────
TEXT    = "Text box"
ARROW   = "Arrow + text"
VLINE   = "Vertical line"
HLINE   = "Horizontal line"
XSPAN   = "X span (shaded)"
YSPAN   = "Y span (shaded)"
BRACKET = "Span bracket"
MARKER  = "Point marker"
RECT    = "Rectangle"

KINDS = [TEXT, ARROW, BRACKET, XSPAN, YSPAN, VLINE, HLINE, MARKER, RECT]

# Which coordinate fields each kind uses, and how to label them in the UI.
KIND_FIELDS: dict[str, dict[str, str]] = {
    TEXT:    {"x": "X", "y": "Y"},
    ARROW:   {"x": "Arrow tip X", "y": "Arrow tip Y", "x2": "Text X", "y2": "Text Y"},
    BRACKET: {"x": "Start X", "x2": "End X", "y": "Height Y"},
    XSPAN:   {"x": "Start X", "x2": "End X"},
    YSPAN:   {"y": "Start Y", "y2": "End Y"},
    VLINE:   {"x": "X"},
    HLINE:   {"y": "Y"},
    MARKER:  {"x": "X", "y": "Y"},
    RECT:    {"x": "Corner X", "y": "Corner Y", "x2": "Opposite X", "y2": "Opposite Y"},
}

# Which style options are relevant to each kind.
KIND_STYLES: dict[str, set[str]] = {
    TEXT:    {"box"},
    ARROW:   {"box", "line", "arrow", "connection"},
    BRACKET: {"box", "line", "arrow"},
    XSPAN:   {"box", "fill"},
    YSPAN:   {"box", "fill"},
    VLINE:   {"box", "line"},
    HLINE:   {"box", "line"},
    MARKER:  {"box", "marker"},
    RECT:    {"box", "line", "fill"},
}

LINESTYLES  = {"solid": "-", "dashed": "--", "dotted": ":", "dash-dot": "-."}
BOXSTYLES   = ["none", "round", "square", "round4", "sawtooth", "roundtooth", "larrow", "rarrow"]
ARROWSTYLES = ["->", "-|>", "<->", "<|-|>", "|-|", "]-[", "-[", "fancy", "simple", "wedge", "-"]
CONNECTIONS = {"straight": "arc3", "curved": "arc3,rad=0.25",
               "curved (other way)": "arc3,rad=-0.25", "angled": "angle3,angleA=0,angleB=90"}
MARKERS     = {"circle": "o", "square": "s", "diamond": "D", "triangle": "^",
               "star": "*", "plus": "P", "cross": "X"}

ZORDER = 10


@dataclass
class Annotation:
    kind: str = TEXT
    text: str = ""
    x: float = 0.0
    y: float = 0.5
    x2: float | None = None
    y2: float | None = None
    y_ref: str = AXES_FRACTION
    color: str = "#d62728"
    fontsize: float = 9.0
    linestyle: str = "-"
    linewidth: float = 1.2
    alpha: float = 0.2              # fill opacity for spans / rectangles
    box: str = "round"              # text bbox style or "none"
    arrowstyle: str = "->"
    connection: str = "arc3"
    marker: str = "o"
    visible: bool = True

    # ── Helpers ───────────────────────────────────────────────────────────────

    def uses(self, field_name: str) -> bool:
        return field_name in KIND_FIELDS.get(self.kind, {})

    def validate(self) -> list[str]:
        """Return a list of human-readable problems (empty if valid)."""
        errors = []
        if self.kind not in KIND_FIELDS:
            errors.append(f"Unknown annotation type '{self.kind}'.")
            return errors
        for name, label in KIND_FIELDS[self.kind].items():
            if getattr(self, name) is None:
                errors.append(f"'{label}' is required.")
        return errors

    def describe(self) -> str:
        """Short position summary for list display."""
        parts = []
        for name, label in KIND_FIELDS.get(self.kind, {}).items():
            val = getattr(self, name)
            parts.append(f"{name}={_fmt(val)}")
        s = ", ".join(parts)
        if any(n.startswith("y") for n in KIND_FIELDS.get(self.kind, {})):
            s += "  (frac)" if self.y_ref == AXES_FRACTION else f"  ({self.y_ref})"
        return s

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Annotation":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})


def _fmt(v) -> str:
    if v is None:
        return "—"
    return f"{v:,.4g}"


# ── Serialisation ─────────────────────────────────────────────────────────────

def dumps(annotations: list[Annotation]) -> str:
    return json.dumps({"version": 1, "annotations": [a.to_dict() for a in annotations]},
                      indent=2)


def loads(text: str) -> list[Annotation]:
    data = json.loads(text)
    items = data["annotations"] if isinstance(data, dict) else data
    return [Annotation.from_dict(d) for d in items]


# ── Coordinate helpers ────────────────────────────────────────────────────────

class AxisNotPlotted(LookupError):
    pass


def _y_axes_transform(y_ref, host_ax, axes_by_col):
    """Transform whose *y* component maps the annotation's Y units."""
    if y_ref == AXES_FRACTION:
        return host_ax.transAxes
    ax = axes_by_col.get(y_ref)
    if ax is None:
        raise AxisNotPlotted(y_ref)
    return ax.transData


def point_transform(y_ref, host_ax, axes_by_col):
    """Transform for (x in data units, y in y_ref units)."""
    return blended_transform_factory(host_ax.transData,
                                     _y_axes_transform(y_ref, host_ax, axes_by_col))


def display_to_coords(px, py, y_ref, host_ax, axes_by_col) -> tuple[float, float]:
    """Convert a display-pixel position (e.g. a mouse click) to annotation coords."""
    t = point_transform(y_ref, host_ax, axes_by_col)
    x, y = t.inverted().transform((px, py))
    return float(x), float(y)


def convert_y(y, from_ref, to_ref, host_ax, axes_by_col) -> float:
    """Re-express a Y value from one reference axis in another."""
    if y is None or from_ref == to_ref:
        return y
    _, py = _y_axes_transform(from_ref, host_ax, axes_by_col).transform((0, y))
    _, out = _y_axes_transform(to_ref, host_ax, axes_by_col).inverted().transform((0, py))
    return float(out)


# ── Rendering ─────────────────────────────────────────────────────────────────

def _bbox(ann: Annotation):
    if ann.box == "none":
        return None
    return dict(boxstyle=ann.box, fc="white", ec=ann.color, alpha=0.9, lw=0.8)


def _label(draw_ax, ann, xy, transform, offset=(0, 0), **kw):
    if not ann.text:
        return
    draw_ax.annotate(
        ann.text, xy=xy, xycoords=transform,
        xytext=offset, textcoords="offset points",
        fontsize=ann.fontsize, color=ann.color, bbox=_bbox(ann),
        annotation_clip=True, zorder=ZORDER + 1, **kw,
    )


def render_annotation(ann: Annotation, host_ax, axes_by_col, draw_ax=None) -> None:
    """
    Draw a single annotation.

    host_ax     – the primary axes (defines the shared X transform and plot area)
    axes_by_col – {column name: axes} for every plotted Y column
    draw_ax     – axes the artists are attached to (default host_ax).  Use the
                  top-most twin so annotations render above all data lines.

    Raises AxisNotPlotted if ann.y_ref refers to a column that is not plotted,
    ValueError if the annotation is invalid.
    """
    errors = ann.validate()
    if errors:
        raise ValueError("; ".join(errors))

    draw_ax = draw_ax or host_ax
    k = ann.kind
    line_kw = dict(color=ann.color, linestyle=ann.linestyle, linewidth=ann.linewidth)

    if k == TEXT:
        t = point_transform(ann.y_ref, host_ax, axes_by_col)
        draw_ax.annotate(
            ann.text or " ", xy=(ann.x, ann.y), xycoords=t, ha="center", va="center",
            fontsize=ann.fontsize, color=ann.color, bbox=_bbox(ann),
            annotation_clip=True, zorder=ZORDER + 1,
        )

    elif k == ARROW:
        t = point_transform(ann.y_ref, host_ax, axes_by_col)
        draw_ax.annotate(
            ann.text, xy=(ann.x, ann.y), xycoords=t,
            xytext=(ann.x2, ann.y2), textcoords=t, ha="center", va="center",
            fontsize=ann.fontsize, color=ann.color, bbox=_bbox(ann),
            arrowprops=dict(arrowstyle=ann.arrowstyle, connectionstyle=ann.connection,
                            shrinkA=2, shrinkB=2, **line_kw),
            annotation_clip=False, zorder=ZORDER + 1,
        )

    elif k == BRACKET:
        t = point_transform(ann.y_ref, host_ax, axes_by_col)
        draw_ax.annotate(
            "", xy=(ann.x, ann.y), xycoords=t, xytext=(ann.x2, ann.y), textcoords=t,
            arrowprops=dict(arrowstyle=ann.arrowstyle, shrinkA=0, shrinkB=0, **line_kw),
            annotation_clip=False, zorder=ZORDER,
        )
        _label(draw_ax, ann, ((ann.x + ann.x2) / 2, ann.y), t, offset=(0, 4),
               ha="center", va="bottom")

    elif k == XSPAN:
        t = blended_transform_factory(host_ax.transData, host_ax.transAxes)
        draw_ax.add_artist(Rectangle(
            (ann.x, 0), ann.x2 - ann.x, 1, transform=t,
            facecolor=ann.color, edgecolor=ann.color, alpha=ann.alpha,
            linewidth=0, zorder=ZORDER - 5,
        ))
        _label(draw_ax, ann, ((ann.x + ann.x2) / 2, 1), t, offset=(0, -4),
               ha="center", va="top")

    elif k == YSPAN:
        t = blended_transform_factory(host_ax.transAxes,
                                      _y_axes_transform(ann.y_ref, host_ax, axes_by_col))
        draw_ax.add_artist(Rectangle(
            (0, ann.y), 1, ann.y2 - ann.y, transform=t,
            facecolor=ann.color, edgecolor=ann.color, alpha=ann.alpha,
            linewidth=0, zorder=ZORDER - 5,
        ))
        _label(draw_ax, ann, (0, (ann.y + ann.y2) / 2), t, offset=(4, 0),
               ha="left", va="center")

    elif k == VLINE:
        t = blended_transform_factory(host_ax.transData, host_ax.transAxes)
        draw_ax.add_artist(Line2D([ann.x, ann.x], [0, 1], transform=t, zorder=ZORDER, **line_kw))
        _label(draw_ax, ann, (ann.x, 1), t, offset=(3, -4),
               ha="left", va="top", rotation=90)

    elif k == HLINE:
        t = blended_transform_factory(host_ax.transAxes,
                                      _y_axes_transform(ann.y_ref, host_ax, axes_by_col))
        draw_ax.add_artist(Line2D([0, 1], [ann.y, ann.y], transform=t, zorder=ZORDER, **line_kw))
        _label(draw_ax, ann, (0, ann.y), t, offset=(4, 3), ha="left", va="bottom")

    elif k == MARKER:
        t = point_transform(ann.y_ref, host_ax, axes_by_col)
        draw_ax.add_artist(Line2D(
            [ann.x], [ann.y], transform=t, marker=ann.marker, markersize=8,
            color=ann.color, markeredgecolor="black", markeredgewidth=0.6,
            linestyle="none", zorder=ZORDER,
        ))
        _label(draw_ax, ann, (ann.x, ann.y), t, offset=(7, 7), ha="left", va="bottom")

    elif k == RECT:
        t = point_transform(ann.y_ref, host_ax, axes_by_col)
        draw_ax.add_artist(Rectangle(
            (ann.x, ann.y), ann.x2 - ann.x, ann.y2 - ann.y, transform=t,
            facecolor=to_rgba(ann.color, ann.alpha), edgecolor=ann.color,
            linestyle=ann.linestyle, linewidth=ann.linewidth, zorder=ZORDER - 5,
        ))
        _label(draw_ax, ann, (min(ann.x, ann.x2), max(ann.y, ann.y2)), t,
               offset=(3, -3), ha="left", va="top")


def render_annotations(annotations, host_ax, axes_by_col, draw_ax=None) -> list[str]:
    """
    Draw every visible annotation.  Problems are collected, not raised, so one
    bad annotation never breaks the plot.  Returns a list of warning strings.
    """
    warnings = []
    for i, ann in enumerate(annotations, start=1):
        if not ann.visible:
            continue
        try:
            render_annotation(ann, host_ax, axes_by_col, draw_ax)
        except AxisNotPlotted as exc:
            warnings.append(f"#{i} hidden: Y axis '{exc.args[0]}' is not plotted")
        except Exception as exc:  # noqa: BLE001 – keep the plot alive
            warnings.append(f"#{i} error: {exc}")
    return warnings
