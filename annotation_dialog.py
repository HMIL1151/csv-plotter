"""
Tk dialog for creating / editing a single plot annotation.
"""

from __future__ import annotations

import tkinter as tk
from dataclasses import replace
from tkinter import colorchooser, messagebox, ttk

from matplotlib.colors import to_rgba

import annotations as an


def _invert(d: dict) -> dict:
    return {v: k for k, v in d.items()}


class AnnotationDialog(tk.Toplevel):
    """
    parent        – owning window
    ann           – annotation to edit (a copy is edited; the original is untouched)
    y_refs        – Y-axis reference choices (AXES_FRACTION + plotted columns)
    on_apply      – called with the edited Annotation on Apply / OK
    request_pick  – request_pick(y_ref, callback) arms a click-on-plot pick; the
                    callback receives (x, y).  Returns False if picking is unavailable.
    convert_y     – convert_y(y, from_ref, to_ref) -> float; may raise
    """

    def __init__(self, parent, ann: an.Annotation, y_refs: list[str],
                 on_apply, request_pick, convert_y, title="Annotation"):
        super().__init__(parent)
        self.title(title)
        self.transient(parent)
        self.resizable(False, False)

        self._ann = replace(ann)
        self._on_apply = on_apply
        self._request_pick = request_pick
        self._convert_y = convert_y

        y_refs = list(y_refs)
        if ann.y_ref not in y_refs:
            y_refs.append(ann.y_ref)   # keep refs to currently-unplotted columns
        self._y_refs = y_refs

        self._build()
        self._load(self._ann)
        self._on_kind_change()
        self.bind("<Escape>", lambda e: self.destroy())

    # ── Layout ────────────────────────────────────────────────────────────────

    def _build(self):
        frm = ttk.Frame(self, padding=8)
        frm.pack(fill="both", expand=True)
        frm.columnconfigure(1, weight=1)

        ttk.Label(frm, text="Type:").grid(row=0, column=0, sticky="w")
        self.kind_var = tk.StringVar()
        cb = ttk.Combobox(frm, textvariable=self.kind_var, values=an.KINDS,
                          state="readonly", width=24)
        cb.grid(row=0, column=1, sticky="ew", pady=2)
        cb.bind("<<ComboboxSelected>>", lambda e: self._on_kind_change())

        ttk.Label(frm, text="Text:").grid(row=1, column=0, sticky="nw", pady=2)
        self.text_box = tk.Text(frm, width=34, height=3, font=("", 9), wrap="word")
        self.text_box.grid(row=1, column=1, sticky="ew", pady=2)

        # ── Position ──────────────────────────────────────────────────────────
        pos = ttk.LabelFrame(frm, text="Position", padding=6)
        pos.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(6, 2))
        pos.columnconfigure(1, weight=1)
        pos.columnconfigure(3, weight=1)

        ttk.Label(pos, text="Y axis:").grid(row=0, column=0, sticky="w")
        self.y_ref_var = tk.StringVar()
        self._prev_y_ref = None
        yref_cb = ttk.Combobox(pos, textvariable=self.y_ref_var, values=self._y_refs,
                               state="readonly")
        yref_cb.grid(row=0, column=1, columnspan=3, sticky="ew", pady=2)
        yref_cb.bind("<<ComboboxSelected>>", lambda e: self._on_y_ref_change())
        self._yref_widgets = [yref_cb]

        self.coord_vars: dict[str, tk.StringVar] = {}
        self.coord_labels: dict[str, ttk.Label] = {}
        self.coord_entries: dict[str, ttk.Entry] = {}
        for name, row, col in [("x", 1, 0), ("y", 1, 2), ("x2", 2, 0), ("y2", 2, 2)]:
            lbl = ttk.Label(pos, text=name, width=11)
            lbl.grid(row=row, column=col, sticky="w", pady=1)
            var = tk.StringVar()
            ent = ttk.Entry(pos, textvariable=var, width=12)
            ent.grid(row=row, column=col + 1, sticky="ew", padx=(0, 6), pady=1)
            self.coord_vars[name], self.coord_labels[name], self.coord_entries[name] = var, lbl, ent

        pick_row = ttk.Frame(pos)
        pick_row.grid(row=3, column=0, columnspan=4, sticky="w", pady=(4, 0))
        self.pick1_btn = ttk.Button(pick_row, text="⌖ Pick point 1",
                                    command=lambda: self._pick(1))
        self.pick1_btn.pack(side="left")
        self.pick2_btn = ttk.Button(pick_row, text="⌖ Pick point 2",
                                    command=lambda: self._pick(2))
        self.pick2_btn.pack(side="left", padx=4)
        self.pick_status = ttk.Label(pos, text="", foreground="gray", font=("", 8))
        self.pick_status.grid(row=4, column=0, columnspan=4, sticky="w")

        # ── Style ─────────────────────────────────────────────────────────────
        sty = ttk.LabelFrame(frm, text="Style", padding=6)
        sty.grid(row=3, column=0, columnspan=2, sticky="ew", pady=2)
        sty.columnconfigure(1, weight=1)
        self._style_rows: dict[str, list[tk.Widget]] = {}

        def row(key, label, widget, r):
            l = ttk.Label(sty, text=label)
            l.grid(row=r, column=0, sticky="w", pady=1)
            widget.grid(row=r, column=1, sticky="ew", pady=1)
            self._style_rows.setdefault(key, []).extend([l, widget])

        # Colour (always shown)
        col_frm = ttk.Frame(sty)
        self.color_var = tk.StringVar()
        ttk.Entry(col_frm, textvariable=self.color_var, width=10).pack(side="left")
        self.swatch = tk.Label(col_frm, width=3, relief="groove")
        self.swatch.pack(side="left", padx=4)
        ttk.Button(col_frm, text="Choose…", command=self._choose_color).pack(side="left")
        self.color_var.trace_add("write", lambda *_: self._update_swatch())
        row("always", "Colour:", col_frm, 0)

        self.fontsize_var = tk.StringVar()
        row("always", "Font size:",
            ttk.Spinbox(sty, from_=5, to=40, textvariable=self.fontsize_var, width=6), 1)

        self.box_var = tk.StringVar()
        row("box", "Text box:",
            ttk.Combobox(sty, textvariable=self.box_var, values=an.BOXSTYLES,
                         state="readonly", width=14), 2)

        self.linestyle_var = tk.StringVar()
        row("line", "Line style:",
            ttk.Combobox(sty, textvariable=self.linestyle_var, values=list(an.LINESTYLES),
                         state="readonly", width=14), 3)

        self.linewidth_var = tk.StringVar()
        row("line", "Line width:",
            ttk.Spinbox(sty, from_=0.25, to=10, increment=0.25,
                        textvariable=self.linewidth_var, width=6), 4)

        self.arrowstyle_var = tk.StringVar()
        row("arrow", "Arrow head:",
            ttk.Combobox(sty, textvariable=self.arrowstyle_var, values=an.ARROWSTYLES,
                         state="readonly", width=14), 5)

        self.connection_var = tk.StringVar()
        row("connection", "Arrow path:",
            ttk.Combobox(sty, textvariable=self.connection_var, values=list(an.CONNECTIONS),
                         state="readonly", width=14), 6)

        self.alpha_var = tk.DoubleVar()
        row("fill", "Fill opacity:",
            ttk.Scale(sty, variable=self.alpha_var, from_=0.0, to=1.0, orient="horizontal"), 7)

        self.marker_var = tk.StringVar()
        row("marker", "Marker:",
            ttk.Combobox(sty, textvariable=self.marker_var, values=list(an.MARKERS),
                         state="readonly", width=14), 8)

        self.visible_var = tk.BooleanVar()
        ttk.Checkbutton(frm, text="Visible", variable=self.visible_var).grid(
            row=4, column=0, columnspan=2, sticky="w", pady=(4, 0))

        btns = ttk.Frame(frm)
        btns.grid(row=5, column=0, columnspan=2, sticky="e", pady=(8, 0))
        ttk.Button(btns, text="Apply",  command=self._apply).pack(side="left", padx=2)
        ttk.Button(btns, text="OK",     command=self._ok).pack(side="left", padx=2)
        ttk.Button(btns, text="Cancel", command=self.destroy).pack(side="left", padx=2)

    # ── Load / collect ────────────────────────────────────────────────────────

    def _load(self, a: an.Annotation):
        self.kind_var.set(a.kind)
        self.text_box.insert("1.0", a.text)
        self.y_ref_var.set(a.y_ref)
        self._prev_y_ref = a.y_ref
        for name in ("x", "y", "x2", "y2"):
            v = getattr(a, name)
            self.coord_vars[name].set("" if v is None else f"{v:.6g}")
        self.color_var.set(a.color)
        self.fontsize_var.set(f"{a.fontsize:g}")
        self.box_var.set(a.box)
        self.linestyle_var.set(_invert(an.LINESTYLES).get(a.linestyle, "solid"))
        self.linewidth_var.set(f"{a.linewidth:g}")
        self.arrowstyle_var.set(a.arrowstyle)
        self.connection_var.set(_invert(an.CONNECTIONS).get(a.connection, "straight"))
        self.alpha_var.set(a.alpha)
        self.marker_var.set(_invert(an.MARKERS).get(a.marker, "circle"))
        self.visible_var.set(a.visible)

    def _collect(self) -> an.Annotation | None:
        """Build an Annotation from the form, or show an error and return None."""
        try:
            coords = {}
            for name, var in self.coord_vars.items():
                s = var.get().strip().replace(",", "")
                coords[name] = float(s) if s else None
            fontsize  = float(self.fontsize_var.get())
            linewidth = float(self.linewidth_var.get())
        except ValueError as exc:
            messagebox.showerror("Annotation", f"Invalid number: {exc}", parent=self)
            return None

        a = an.Annotation(
            kind=self.kind_var.get(),
            text=self.text_box.get("1.0", "end-1c"),
            y_ref=self.y_ref_var.get(),
            color=self.color_var.get().strip() or "black",
            fontsize=fontsize,
            linestyle=an.LINESTYLES.get(self.linestyle_var.get(), "-"),
            linewidth=linewidth,
            alpha=round(float(self.alpha_var.get()), 3),
            box=self.box_var.get(),
            arrowstyle=self.arrowstyle_var.get(),
            connection=an.CONNECTIONS.get(self.connection_var.get(), "arc3"),
            marker=an.MARKERS.get(self.marker_var.get(), "o"),
            visible=self.visible_var.get(),
            **coords,
        )
        errors = a.validate()
        try:
            to_rgba(a.color)
        except ValueError:
            errors.append(f"'{a.color}' is not a valid colour.")
        if errors:
            messagebox.showerror("Annotation", "\n".join(errors), parent=self)
            return None
        return a

    # ── Behaviour ─────────────────────────────────────────────────────────────

    def _on_kind_change(self):
        kind = self.kind_var.get()
        used = an.KIND_FIELDS.get(kind, {})
        for name in ("x", "y", "x2", "y2"):
            if name in used:
                self.coord_labels[name].config(text=used[name] + ":")
                self.coord_labels[name].grid()
                self.coord_entries[name].grid()
            else:
                self.coord_labels[name].grid_remove()
                self.coord_entries[name].grid_remove()

        uses_y = any(n.startswith("y") for n in used)
        for w in self._yref_widgets:
            w.config(state="readonly" if uses_y else "disabled")

        has_p2 = "x2" in used or "y2" in used
        if has_p2:
            self.pick2_btn.pack(side="left", padx=4)
        else:
            self.pick2_btn.pack_forget()

        styles = an.KIND_STYLES.get(kind, set()) | {"always"}
        for key, widgets in self._style_rows.items():
            for w in widgets:
                (w.grid if key in styles else w.grid_remove)()

        # Sensible defaults when switching to a type that needs a second point
        if kind == an.BRACKET and self.arrowstyle_var.get() == "->":
            self.arrowstyle_var.set("<->")

    def _on_y_ref_change(self):
        new = self.y_ref_var.get()
        old = self._prev_y_ref
        self._prev_y_ref = new
        if old == new:
            return
        for name in ("y", "y2"):
            s = self.coord_vars[name].get().strip()
            if not s:
                continue
            try:
                v = self._convert_y(float(s), old, new)
            except Exception:
                continue   # leave value as typed if we can't convert
            self.coord_vars[name].set(f"{v:.6g}")

    def _pick(self, which: int):
        y_ref = self.y_ref_var.get()

        def done(x, y):
            if not self.winfo_exists():
                return
            used = an.KIND_FIELDS.get(self.kind_var.get(), {})
            xn, yn = ("x", "y") if which == 1 else ("x2", "y2")
            if xn in used:
                self.coord_vars[xn].set(f"{x:.6g}")
            if yn in used:
                self.coord_vars[yn].set(f"{y:.6g}")
            self.pick_status.config(text="")
            self.lift()

        if self._request_pick(y_ref, done):
            self.pick_status.config(text=f"Click on the plot to set point {which}…")
        else:
            self.pick_status.config(text="Nothing plotted to pick from.")

    def _choose_color(self):
        _, hex_ = colorchooser.askcolor(color=self.color_var.get() or None, parent=self)
        if hex_:
            self.color_var.set(hex_)

    def _update_swatch(self):
        try:
            self.swatch.config(bg=self.color_var.get())
        except tk.TclError:
            pass

    def _apply(self) -> bool:
        a = self._collect()
        if a is None:
            return False
        self._on_apply(a)
        return True

    def _ok(self):
        if self._apply():
            self.destroy()
