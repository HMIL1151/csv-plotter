#!/usr/bin/env python3
"""
CSV Plotter
-----------
Two-window tool:
  • Controls window  – file browser, ElapsedMs range sliders, column checkboxes
  • Plot window      – matplotlib figure; each active column gets its own Y axis

Usage:
    python csv_plotter.py [optional_csv_path]
"""

import re
import sys
from collections import OrderedDict
from dataclasses import fields, replace
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import pandas as pd
import matplotlib
matplotlib.use("TkAgg")
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.figure import Figure
from matplotlib.backend_tools import Cursors

import annotations as an
from annotation_dialog import AnnotationDialog

# ── Colour cycle ──────────────────────────────────────────────────────────────
COLORS = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
    "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5",
    "#c49c94", "#f7b6d2", "#dbdb8d", "#9edae5", "#ad494a",
]

SPINE_OFFSET_PT = 55   # points between consecutive right-side Y axes
MAX_AXES_WARNING = 10  # warn user when more than this many axes are active


def _parse_groups(cols: list) -> OrderedDict:
    """
    Group columns by their prefix before the first _<digits> segment.
    Returns OrderedDict: base_name -> [col, ...]
    Groups with only one member are keyed by the full column name.
    """
    raw: dict = OrderedDict()
    for col in cols:
        m = re.match(r'^(.+?)_(\d+.*)$', col)
        base = m.group(1) if m else col
        raw.setdefault(base, []).append(col)
    result: OrderedDict = OrderedDict()
    for base, members in raw.items():
        if len(members) > 1:
            result[base] = members
        else:
            result[members[0]] = members
    return result


def _assign(target, source) -> None:
    """Copy every dataclass field from source onto target (keeps target's identity)."""
    for f in fields(target):
        setattr(target, f.name, getattr(source, f.name))


class CsvPlotter:
    def __init__(self, initial_path: str | None = None):
        self.df: pd.DataFrame | None = None
        self.column_vars: dict[str, tk.BooleanVar] = {}

        # (col_name, var, checkbutton_widget, group_name_or_None)
        self._cb_rows: list[tuple] = []
        # direct children of cb_frame in render order: ("flat", widget) | ("group", widget)
        self._direct_children: list[tuple] = []
        # group_name -> {cols, expanded, var, toggle_btn, child_frame, hdr_frm, grp_outer}
        self._groups: dict[str, dict] = {}

        self._csv_filename = ""
        self._loading = False          # suppress x-col trace during file load
        self._refresh_pending = False

        # Per-column label and unit overrides – persist across refreshes
        self._label_vars: dict[str, tk.StringVar] = {}
        self._unit_vars:  dict[str, tk.StringVar] = {}

        # Plot annotations – persist across refreshes and file loads
        self._annotations: list[an.Annotation] = []
        self._host_ax = None                 # primary axes of the current plot
        self._axes_by_col: dict = {}         # column -> axes of the current plot
        self._pick_request = None            # (y_ref, callback) awaiting a plot click
        self._label_artists: dict = {}       # annotation index -> text artist on the plot
        self._drag = None                    # in-progress label drag state
        self._hover_label = False            # cursor currently over a draggable label
        self._annot_dialogs: list = []       # (state, dialog) for open editors

        # ── Control window (root) ─────────────────────────────────────────────
        self.ctrl = tk.Tk()
        self.ctrl.title("CSV Plot Controls")
        self.ctrl.resizable(True, True)
        self._build_controls()

        # ── Plot window (Toplevel) ────────────────────────────────────────────
        self.plot_win = tk.Toplevel(self.ctrl)
        self.plot_win.title("CSV Plot")
        self.plot_win.resizable(True, True)
        self.plot_win.protocol("WM_DELETE_WINDOW", self._on_close)
        self._build_plot_window()

        self.ctrl.protocol("WM_DELETE_WINDOW", self._on_close)

        # Position side-by-side
        self.ctrl.update_idletasks()
        self.ctrl.geometry("460x860+0+40")
        self.plot_win.geometry("1100x700+480+40")

        if initial_path:
            self._load_file(initial_path)

        self.ctrl.mainloop()

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def _on_close(self):
        self.ctrl.destroy()

    # ── Controls window ───────────────────────────────────────────────────────

    def _build_controls(self):
        pad = {"padx": 10, "pady": 4}

        # ── File browser ──────────────────────────────────────────────────────
        file_frm = ttk.LabelFrame(self.ctrl, text="CSV File", padding=6)
        file_frm.pack(fill="x", **pad)
        self.file_label = ttk.Label(
            file_frm, text="No file selected", foreground="gray",
            wraplength=340, anchor="w",
        )
        self.file_label.pack(side="left", fill="x", expand=True)
        ttk.Button(file_frm, text="Browse…", command=self._browse_file).pack(side="right")

        # ── X-Axis & Range ────────────────────────────────────────────────────
        range_frm = ttk.LabelFrame(self.ctrl, text="X-Axis & Range", padding=6)
        range_frm.pack(fill="x", **pad)
        range_frm.columnconfigure(1, weight=1)

        ttk.Label(range_frm, text="X Column").grid(row=0, column=0, sticky="w")
        self._x_col_var = tk.StringVar()
        self._x_col_combo = ttk.Combobox(
            range_frm, textvariable=self._x_col_var, state="readonly", width=22,
        )
        self._x_col_combo.grid(row=0, column=1, columnspan=2, sticky="ew", padx=6, pady=2)
        self._x_col_var.trace_add("write", lambda *_: self._on_x_col_change())

        ttk.Separator(range_frm, orient="horizontal").grid(
            row=1, column=0, columnspan=3, sticky="ew", pady=4,
        )

        ttk.Label(range_frm, text="Start").grid(row=2, column=0, sticky="w")
        self.start_var = tk.DoubleVar(value=0.0)
        self.start_lbl = ttk.Label(range_frm, text="—", width=14, anchor="e")
        self.start_lbl.grid(row=2, column=2, sticky="e", padx=(4, 0))
        self.start_slider = ttk.Scale(
            range_frm, variable=self.start_var, orient="horizontal",
            from_=0, to=1, command=self._on_slider,
        )
        self.start_slider.grid(row=2, column=1, sticky="ew", padx=6, pady=2)

        ttk.Label(range_frm, text="End").grid(row=3, column=0, sticky="w")
        self.end_var = tk.DoubleVar(value=1.0)
        self.end_lbl = ttk.Label(range_frm, text="—", width=14, anchor="e")
        self.end_lbl.grid(row=3, column=2, sticky="e", padx=(4, 0))
        self.end_slider = ttk.Scale(
            range_frm, variable=self.end_var, orient="horizontal",
            from_=0, to=1, command=self._on_slider,
        )
        self.end_slider.grid(row=3, column=1, sticky="ew", padx=6, pady=2)

        btn_row = ttk.Frame(self.ctrl)
        btn_row.pack(pady=(2, 2))
        ttk.Button(
            btn_row, text="⟳  Refresh Plot", command=self._refresh_plot,
        ).pack(side="left", padx=4)
        ttk.Button(
            btn_row, text="↓  Export CSV", command=self._export_csv,
        ).pack(side="left", padx=4)

        # ── Notebook: Columns | Labels ────────────────────────────────────────
        nb = ttk.Notebook(self.ctrl)
        nb.pack(fill="both", expand=True, padx=10, pady=4)

        # ── Tab 1: Columns ────────────────────────────────────────────────────
        col_tab = ttk.Frame(nb, padding=4)
        nb.add(col_tab, text="Columns")

        tbar = ttk.Frame(col_tab)
        tbar.pack(fill="x", pady=(0, 4))
        ttk.Label(tbar, text="Filter:").pack(side="left")
        self.filter_var = tk.StringVar()
        self.filter_var.trace_add("write", lambda *_: self._apply_filter())
        ttk.Entry(tbar, textvariable=self.filter_var).pack(
            side="left", fill="x", expand=True, padx=4,
        )
        ttk.Button(tbar, text="All",  width=4, command=self._sel_all ).pack(side="left", padx=1)
        ttk.Button(tbar, text="None", width=4, command=self._sel_none).pack(side="left", padx=1)
        ttk.Button(tbar, text="⊟",   width=3, command=self._collapse_all).pack(side="left", padx=1)

        list_frm = ttk.Frame(col_tab)
        list_frm.pack(fill="both", expand=True)

        self.cb_canvas = tk.Canvas(list_frm, highlightthickness=0)
        sb = ttk.Scrollbar(list_frm, orient="vertical", command=self.cb_canvas.yview)
        self.cb_canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.cb_canvas.pack(side="left", fill="both", expand=True)

        self.cb_frame = ttk.Frame(self.cb_canvas)
        self._cb_win = self.cb_canvas.create_window((0, 0), window=self.cb_frame, anchor="nw")

        self.cb_frame.bind(
            "<Configure>",
            lambda e: self.cb_canvas.configure(scrollregion=self.cb_canvas.bbox("all")),
        )
        self.cb_canvas.bind(
            "<Configure>",
            lambda e: self.cb_canvas.itemconfig(self._cb_win, width=e.width),
        )
        self.cb_canvas.bind(
            "<Enter>", lambda e: self.cb_canvas.bind_all("<MouseWheel>", self._on_mwheel_cb),
        )
        self.cb_canvas.bind("<Leave>", lambda e: self.cb_canvas.unbind_all("<MouseWheel>"))

        # ── Tab 2: Labels ─────────────────────────────────────────────────────
        lbl_tab = ttk.Frame(nb, padding=6)
        nb.add(lbl_tab, text="Labels")
        lbl_tab.columnconfigure(1, weight=1)

        ttk.Label(lbl_tab, text="Custom Title:").grid(row=0, column=0, sticky="w", pady=2)
        self._custom_title_var = tk.StringVar()
        ttk.Entry(lbl_tab, textvariable=self._custom_title_var).grid(
            row=0, column=1, sticky="ew", padx=6, pady=2,
        )

        ttk.Separator(lbl_tab, orient="horizontal").grid(
            row=1, column=0, columnspan=2, sticky="ew", pady=6,
        )

        ttk.Label(lbl_tab, text="X-Axis",
                  font=("", 9, "bold")).grid(row=2, column=0, columnspan=2, sticky="w")
        ttk.Label(lbl_tab, text="Label:").grid(row=3, column=0, sticky="w", pady=1)
        self._x_label_var = tk.StringVar()
        ttk.Entry(lbl_tab, textvariable=self._x_label_var).grid(
            row=3, column=1, sticky="ew", padx=6, pady=1,
        )
        ttk.Label(lbl_tab, text="Units:").grid(row=4, column=0, sticky="w", pady=1)
        self._x_unit_var = tk.StringVar()
        ttk.Entry(lbl_tab, textvariable=self._x_unit_var).grid(
            row=4, column=1, sticky="ew", padx=6, pady=1,
        )

        ttk.Separator(lbl_tab, orient="horizontal").grid(
            row=5, column=0, columnspan=2, sticky="ew", pady=6,
        )

        ttk.Label(lbl_tab, text="Y-Axis Overrides",
                  font=("", 9, "bold")).grid(row=6, column=0, columnspan=2, sticky="w")
        ttk.Label(lbl_tab, text="Active columns only — refresh to update list",
                  foreground="gray", font=("", 8),
                  ).grid(row=7, column=0, columnspan=2, sticky="w")

        hdr = ttk.Frame(lbl_tab)
        hdr.grid(row=8, column=0, columnspan=2, sticky="ew", pady=(4, 0))
        ttk.Label(hdr, text="Column",         width=20, anchor="w", font=("", 8, "bold")).pack(side="left")
        ttk.Label(hdr, text="Label Override", width=18, anchor="w", font=("", 8, "bold")).pack(side="left")
        ttk.Label(hdr, text="Units",          width=7,  anchor="w", font=("", 8, "bold")).pack(side="left")

        ov_frm = ttk.Frame(lbl_tab)
        ov_frm.grid(row=9, column=0, columnspan=2, sticky="nsew", pady=2)
        lbl_tab.rowconfigure(9, weight=1)

        self._ov_canvas = tk.Canvas(ov_frm, highlightthickness=0)
        ov_sb = ttk.Scrollbar(ov_frm, orient="vertical", command=self._ov_canvas.yview)
        self._ov_canvas.configure(yscrollcommand=ov_sb.set)
        ov_sb.pack(side="right", fill="y")
        self._ov_canvas.pack(side="left", fill="both", expand=True)

        self._ov_inner = ttk.Frame(self._ov_canvas)
        self._ov_win = self._ov_canvas.create_window((0, 0), window=self._ov_inner, anchor="nw")

        self._ov_inner.bind(
            "<Configure>",
            lambda e: self._ov_canvas.configure(scrollregion=self._ov_canvas.bbox("all")),
        )
        self._ov_canvas.bind(
            "<Configure>",
            lambda e: self._ov_canvas.itemconfig(self._ov_win, width=e.width),
        )
        self._ov_canvas.bind(
            "<Enter>", lambda e: self._ov_canvas.bind_all("<MouseWheel>", self._on_mwheel_ov),
        )
        self._ov_canvas.bind("<Leave>", lambda e: self._ov_canvas.unbind_all("<MouseWheel>"))

        # ── Tab 3: Annotations ────────────────────────────────────────────────
        self._build_annotations_tab(nb)

    def _on_mwheel_cb(self, event):
        self.cb_canvas.yview_scroll(-1 * (event.delta // 120), "units")

    def _on_mwheel_ov(self, event):
        self._ov_canvas.yview_scroll(-1 * (event.delta // 120), "units")

    # ── Plot window ───────────────────────────────────────────────────────────

    def _build_plot_window(self):
        self.fig = Figure(figsize=(11, 6))
        ax = self.fig.add_subplot(111)
        ax.text(
            0.5, 0.5, "Load a CSV and select columns to plot",
            ha="center", va="center", transform=ax.transAxes,
            fontsize=13, color="#aaa",
        )

        self.canvas_fig = FigureCanvasTkAgg(self.fig, master=self.plot_win)
        self._toolbar = NavigationToolbar2Tk(self.canvas_fig, self.plot_win, pack_toolbar=False)
        self._toolbar.update()
        self._toolbar.pack(side="bottom", fill="x")
        self.canvas_fig.get_tk_widget().pack(fill="both", expand=True)
        self.canvas_fig.mpl_connect("button_press_event", self._on_plot_click)
        self.canvas_fig.mpl_connect("motion_notify_event", self._on_plot_motion)
        self.canvas_fig.mpl_connect("button_release_event", self._on_plot_release)
        self.canvas_fig.draw()

    # ── File loading ──────────────────────────────────────────────────────────

    def _browse_file(self):
        path = filedialog.askopenfilename(
            title="Open CSV File",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
        if path:
            self._load_file(path)

    def _load_file(self, path: str):
        try:
            self.df = pd.read_csv(path, low_memory=False)
        except Exception as exc:
            messagebox.showerror("Load Error", str(exc))
            return

        self._csv_filename = path.replace("\\", "/").split("/")[-1]
        self.file_label.config(text=self._csv_filename, foreground="black")
        self.plot_win.title(f"CSV Plot — {self._csv_filename}")

        # Reset per-column overrides
        self._label_vars.clear()
        self._unit_vars.clear()

        # Set X column to first column, suppressing the change callback
        all_cols = list(self.df.columns)
        self._x_col_combo["values"] = all_cols
        self._loading = True
        self._x_col_var.set(all_cols[0] if all_cols else "")
        self._loading = False

        self._init_sliders()
        self._populate_checkboxes()
        self._refresh_plot()

    # ── X column change ─────────────────────────────────────────────────────

    def _on_x_col_change(self):
        if self._loading or self.df is None:
            return
        self._init_sliders()
        self._populate_checkboxes()
        if not self._refresh_pending:
            self._refresh_pending = True
            self.ctrl.after(100, self._debounced_refresh)

    # ── Sliders ───────────────────────────────────────────────────────────────

    def _init_sliders(self):
        if self.df is None:
            return
        x_col = self._x_col_var.get()
        if not x_col or x_col not in self.df.columns:
            return
        col_data = pd.to_numeric(self.df[x_col], errors="coerce")
        mn, mx = float(col_data.min()), float(col_data.max())
        for slider, var, lbl, val in [
            (self.start_slider, self.start_var, self.start_lbl, mn),
            (self.end_slider,   self.end_var,   self.end_lbl,   mx),
        ]:
            slider.config(from_=mn, to=mx)
            var.set(val)
            lbl.config(text=f"{val:,.2f}")

    def _on_slider(self, _=None):
        self.start_lbl.config(text=f"{self.start_var.get():,.2f}")
        self.end_lbl.config(  text=f"{self.end_var.get():,.2f}")
        if not self._refresh_pending:
            self._refresh_pending = True
            self.ctrl.after(150, self._debounced_refresh)

    def _debounced_refresh(self):
        self._refresh_pending = False
        self._refresh_plot()

    # ── Checkboxes (grouped, sorted) ───────────────────────────────────────────────

    def _populate_checkboxes(self):
        for w in self.cb_frame.winfo_children():
            w.destroy()
        self.column_vars.clear()
        self._cb_rows.clear()
        self._groups.clear()
        self._direct_children.clear()

        if self.df is None:
            return

        x_col = self._x_col_var.get()
        cols = [c for c in self.df.columns if c != x_col]
        parsed = _parse_groups(cols)

        # Groups (>1 member) alpha first, then singles alpha
        groups_items  = sorted(
            [(k, v) for k, v in parsed.items() if len(v) > 1],
            key=lambda t: t[0].lower(),
        )
        singles_items = sorted(
            [(k, v) for k, v in parsed.items() if len(v) == 1],
            key=lambda t: t[0].lower(),
        )

        for base, members in groups_items + singles_items:
            if len(members) == 1:
                # ── Flat (ungrouped) checkbox ─────────────────────────────
                col = members[0]
                var = tk.BooleanVar(value=False)
                cb = ttk.Checkbutton(
                    self.cb_frame, text=col, variable=var,
                    command=self._refresh_plot,
                )
                cb.pack(anchor="w", padx=4)
                self.column_vars[col] = var
                self._cb_rows.append((col, var, cb, None))
                self._direct_children.append(("flat", cb))
            else:
                # ── Group: collapsible header + child checkboxes ──────────
                grp_outer = ttk.Frame(self.cb_frame)
                grp_outer.pack(fill="x")

                hdr_frm = ttk.Frame(grp_outer)
                hdr_frm.pack(fill="x")

                grp_var = tk.BooleanVar(value=False)
                child_frame = ttk.Frame(grp_outer)
                # child_frame starts collapsed (not packed)

                toggle_btn = ttk.Button(
                    hdr_frm, text="\u25b6", width=2,
                    command=lambda b=base: self._toggle_group(b),
                )
                toggle_btn.pack(side="left", padx=(2, 0))

                ttk.Checkbutton(
                    hdr_frm,
                    text=f"{base}  ({len(members)})",
                    variable=grp_var,
                    command=lambda b=base: self._on_group_cb_click(b),
                ).pack(side="left", padx=2)

                for col in members:
                    var = tk.BooleanVar(value=False)
                    suffix = col[len(base) + 1:]
                    child_cb = ttk.Checkbutton(
                        child_frame, text=suffix, variable=var,
                        command=lambda b=base: self._on_child_change(b),
                    )
                    child_cb.pack(anchor="w", padx=(28, 4))
                    self.column_vars[col] = var
                    self._cb_rows.append((col, var, child_cb, base))

                self._groups[base] = {
                    "cols":        members,
                    "expanded":    False,
                    "var":         grp_var,
                    "toggle_btn":  toggle_btn,
                    "child_frame": child_frame,
                    "hdr_frm":     hdr_frm,
                    "grp_outer":   grp_outer,
                }
                self._direct_children.append(("group", grp_outer))

    def _toggle_group(self, base: str):
        g = self._groups[base]
        if g["expanded"]:
            g["child_frame"].pack_forget()
            g["toggle_btn"].config(text="\u25b6")
            g["expanded"] = False
        else:
            g["child_frame"].pack(fill="x")
            g["toggle_btn"].config(text="\u25bc")
            g["expanded"] = True

    def _collapse_all(self):
        for g in self._groups.values():
            if g["expanded"]:
                g["child_frame"].pack_forget()
                g["toggle_btn"].config(text="\u25b6")
                g["expanded"] = False

    def _on_group_cb_click(self, base: str):
        g = self._groups[base]
        state = g["var"].get()
        for col in g["cols"]:
            self.column_vars[col].set(state)
        self._refresh_plot()

    def _on_child_change(self, base: str):
        self._update_group_var(base)
        self._refresh_plot()

    def _update_group_var(self, base: str):
        g = self._groups[base]
        g["var"].set(all(self.column_vars[c].get() for c in g["cols"]))

    def _apply_filter(self):
        term = self.filter_var.get().lower()

        # Forget all direct children of cb_frame (reset pack order)
        for _, w in self._direct_children:
            w.pack_forget()

        if not term:
            # Restore in original order, honouring current expanded state
            for kind, w in self._direct_children:
                if kind == "flat":
                    w.pack(anchor="w", padx=4)
                else:
                    w.pack(fill="x")
            for base, g in self._groups.items():
                g["child_frame"].pack_forget()
                for col, _var, cb, grp in self._cb_rows:
                    if grp == base:
                        cb.pack_forget()
                if g["expanded"]:
                    g["child_frame"].pack(fill="x")
                    for col, _var, cb, grp in self._cb_rows:
                        if grp == base:
                            cb.pack(anchor="w", padx=(28, 4))
            return

        # Re-pack only matching items (preserving original order)
        for kind, w in self._direct_children:
            if kind == "flat":
                row = next((r for r in self._cb_rows if r[2] is w), None)
                if row and term in row[0].lower():
                    w.pack(anchor="w", padx=4)
            else:
                base = next(
                    (b for b, g in self._groups.items() if g["grp_outer"] is w), None,
                )
                if base is None:
                    continue
                g = self._groups[base]
                base_matches  = term in base.lower()
                matching_cols = [c for c in g["cols"] if term in c.lower()]
                if not base_matches and not matching_cols:
                    continue  # hide whole group

                w.pack(fill="x")
                if not g["expanded"]:
                    g["toggle_btn"].config(text="\u25bc")
                    g["expanded"] = True
                g["child_frame"].pack(fill="x")
                for col, _var, cb, grp in self._cb_rows:
                    if grp == base:
                        cb.pack_forget()
                for col, _var, cb, grp in self._cb_rows:
                    if grp != base:
                        continue
                    if base_matches or term in col.lower():
                        cb.pack(anchor="w", padx=(28, 4))

    def _sel_all(self):
        term = self.filter_var.get().lower()
        for col, var, _cb, _grp in self._cb_rows:
            if term in col.lower():
                var.set(True)
        for base in self._groups:
            self._update_group_var(base)
        self._refresh_plot()

    def _sel_none(self):
        for _col, var, _cb, _grp in self._cb_rows:
            var.set(False)
        for g in self._groups.values():
            g["var"].set(False)
        self._refresh_plot()

    # ── Y-Axis Overrides panel ────────────────────────────────────────────────

    def _rebuild_overrides_panel(self, active: list):
        for col in active:
            if col not in self._label_vars:
                self._label_vars[col] = tk.StringVar(value=col)
            if col not in self._unit_vars:
                self._unit_vars[col] = tk.StringVar(value="")

        for w in self._ov_inner.winfo_children():
            w.destroy()

        if not active:
            ttk.Label(
                self._ov_inner, text="No columns selected.", foreground="gray", font=("", 8),
            ).pack(anchor="w", padx=4, pady=4)
            return

        for col in active:
            row = ttk.Frame(self._ov_inner)
            row.pack(fill="x", padx=2, pady=1)
            display = col if len(col) <= 20 else col[:17] + "…"
            ttk.Label(row, text=display, width=20, anchor="w",
                      font=("", 8)).pack(side="left")
            ttk.Entry(row, textvariable=self._label_vars[col], width=18,
                      font=("", 8)).pack(side="left", padx=2)
            ttk.Entry(row, textvariable=self._unit_vars[col],  width=7,
                      font=("", 8)).pack(side="left", padx=2)

    # ── Export ─────────────────────────────────────────────────────────────────

    def _export_csv(self):
        if self.df is None:
            messagebox.showwarning("Export", "No CSV loaded.")
            return

        active = [col for col, var, _cb, _grp in self._cb_rows if var.get()]
        if not active:
            messagebox.showwarning("Export", "No columns selected.")
            return

        x_col = self._x_col_var.get()
        t0 = min(self.start_var.get(), self.end_var.get())
        t1 = max(self.start_var.get(), self.end_var.get())

        x_data  = pd.to_numeric(self.df[x_col], errors="coerce")
        mask    = (x_data >= t0) & (x_data <= t1)
        df_view = self.df[mask][[x_col] + active].copy()

        # Build rename map: only rename columns where the user has set a custom label
        rename = {}
        x_lbl_override = self._x_label_var.get().strip()
        x_unit_override = self._x_unit_var.get().strip()
        if x_lbl_override or x_unit_override:
            x_display = f"{x_lbl_override or x_col} [{x_unit_override}]" if x_unit_override else (x_lbl_override or x_col)
            rename[x_col] = x_display
        for col in active:
            lv = self._label_vars.get(col)
            uv = self._unit_vars.get(col)
            label = lv.get().strip() if lv else ""
            units = uv.get().strip() if uv else ""
            if label or units:
                rename[col] = f"{label or col} [{units}]" if units else (label or col)
        if rename:
            df_view = df_view.rename(columns=rename)

        path = filedialog.asksaveasfilename(
            title="Export CSV",
            defaultextension=".csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
            initialfile=self._csv_filename.replace(".csv", "_export.csv"),
        )
        if not path:
            return

        try:
            df_view.to_csv(path, index=False)
            messagebox.showinfo("Export", f"Saved {len(df_view)} rows to:\n{path}")
        except Exception as exc:
            messagebox.showerror("Export Error", str(exc))

    # ── Annotations ───────────────────────────────────────────────────────────

    def _build_annotations_tab(self, nb):
        tab = ttk.Frame(nb, padding=6)
        nb.add(tab, text="Annotations")

        bar = ttk.Frame(tab)
        bar.pack(fill="x")
        add_btn = ttk.Menubutton(bar, text="+ Add ▾")
        add_menu = tk.Menu(add_btn, tearoff=False)
        for kind in an.KINDS:
            add_menu.add_command(label=kind, command=lambda k=kind: self._add_annotation(k))
        add_btn["menu"] = add_menu
        add_btn.pack(side="left", padx=(0, 2))
        for text, cmd in [("Edit", self._edit_annotation),
                          ("Duplicate", self._duplicate_annotation),
                          ("Delete", self._delete_annotation),
                          ("Show/Hide", self._toggle_annotation)]:
            ttk.Button(bar, text=text, command=cmd).pack(side="left", padx=1)

        cols = ("show", "kind", "text", "pos")
        tree_frm = ttk.Frame(tab)
        tree_frm.pack(fill="both", expand=True, pady=4)
        self._annot_tree = ttk.Treeview(tree_frm, columns=cols, show="headings",
                                        selectmode="browse", height=10)
        for col, heading, width, stretch in [
            ("show", "Show", 40, False), ("kind", "Type", 100, False),
            ("text", "Text", 110, True), ("pos", "Position", 160, True),
        ]:
            self._annot_tree.heading(col, text=heading)
            self._annot_tree.column(col, width=width, stretch=stretch, anchor="w")
        tsb = ttk.Scrollbar(tree_frm, orient="vertical", command=self._annot_tree.yview)
        self._annot_tree.configure(yscrollcommand=tsb.set)
        tsb.pack(side="right", fill="y")
        self._annot_tree.pack(side="left", fill="both", expand=True)
        self._annot_tree.bind("<Double-1>", lambda e: self._edit_annotation())
        self._annot_tree.bind("<Delete>", lambda e: self._delete_annotation())

        bar2 = ttk.Frame(tab)
        bar2.pack(fill="x")
        for text, cmd in [("↑", lambda: self._move_annotation(-1)),
                          ("↓", lambda: self._move_annotation(1))]:
            ttk.Button(bar2, text=text, width=3, command=cmd).pack(side="left", padx=1)
        ttk.Button(bar2, text="Clear All", command=self._clear_annotations).pack(side="left", padx=1)
        ttk.Button(bar2, text="Load…", command=self._load_annotations).pack(side="right", padx=1)
        ttk.Button(bar2, text="Save…", command=self._save_annotations).pack(side="right", padx=1)

        ttk.Label(
            tab, foreground="gray", font=("", 8), wraplength=400, justify="left",
            text="Tip: right-click the plot to add an annotation at that point. "
                 "Use ‘Pick point’ in the editor to place points by clicking the plot. "
                 "Y values can be axes fraction (0–1) or a plotted column's units.",
        ).pack(anchor="w", pady=(6, 0))
        self._annot_status = ttk.Label(tab, text="", foreground="#b35900",
                                       font=("", 8), wraplength=400, justify="left")
        self._annot_status.pack(anchor="w")

    def _refresh_annot_list(self, select: int | None = None):
        tree = self._annot_tree
        tree.delete(*tree.get_children())
        for i, a in enumerate(self._annotations):
            text = a.text.replace("\n", " ")
            tree.insert("", "end", iid=str(i), values=(
                "✓" if a.visible else "", a.kind, text, a.describe(),
            ))
        if select is not None and 0 <= select < len(self._annotations):
            tree.selection_set(str(select))
            tree.see(str(select))

    def _selected_annotation(self) -> int | None:
        sel = self._annot_tree.selection()
        return int(sel[0]) if sel else None

    def _annotations_changed(self, select: int | None = None):
        self._refresh_annot_list(select)
        self._refresh_plot()

    def _y_ref_choices(self) -> list[str]:
        return [an.AXES_FRACTION] + list(self._axes_by_col)

    def _default_annotation(self, kind: str, px=None, py=None) -> an.Annotation:
        """
        New annotation of `kind`, placed at display pixel (px, py) if given,
        otherwise near the middle of the current view.
        """
        data_anchored = {an.ARROW, an.MARKER, an.HLINE, an.YSPAN, an.RECT, an.BRACKET}
        y_ref = an.AXES_FRACTION
        if kind in data_anchored and self._axes_by_col:
            y_ref = next(iter(self._axes_by_col))   # follow the data when ranges change
        ann = an.Annotation(kind=kind, y_ref=y_ref,
                            text="" if kind in (an.XSPAN, an.VLINE, an.HLINE) else "Label")
        if kind == an.BRACKET:
            ann.arrowstyle = "<->"

        host = self._host_ax
        if host is None:
            # Nothing plotted: fall back to the slider range and axes fraction
            t0 = min(self.start_var.get(), self.end_var.get())
            t1 = max(self.start_var.get(), self.end_var.get())
            ann.y_ref = an.AXES_FRACTION
            ann.x,  ann.y  = t0 + 0.4 * (t1 - t0), 0.5
            ann.x2, ann.y2 = t0 + 0.6 * (t1 - t0), 0.75
            return ann

        # Work in axes-fraction space, then convert to the annotation's units
        if px is None:
            fx, fy = 0.4, 0.5
        else:
            fx, fy = host.transAxes.inverted().transform((px, py))
        fx2 = fx + 0.15 if fx < 0.8 else fx - 0.15
        fy2 = fy + 0.2 if fy < 0.75 else fy - 0.2
        if kind == an.BRACKET:
            fy2 = fy

        def to_coords(f_x, f_y):
            dx, dy = host.transAxes.transform((f_x, f_y))
            return an.display_to_coords(dx, dy, ann.y_ref, host, self._axes_by_col)

        ann.x, ann.y = to_coords(fx, fy)
        ann.x2, ann.y2 = to_coords(fx2, fy2)
        return ann

    def _open_annotation_dialog(self, ann: an.Annotation, index: int | None):
        # Track the edited annotation by identity (not list index) so reordering,
        # deleting, or dragging while the editor is open can't hit the wrong one.
        state = {"obj": self._annotations[index] if index is not None else None}

        def on_apply(new_ann: an.Annotation):
            i = self._index_of(state["obj"])
            if i is None:
                self._annotations.append(new_ann)
                state["obj"] = new_ann
                i = len(self._annotations) - 1
            else:
                _assign(state["obj"], new_ann)
            self._annotations_changed(select=i)

        def convert_y(y, from_ref, to_ref):
            if self._host_ax is None:
                raise LookupError("no plot")
            return an.convert_y(y, from_ref, to_ref, self._host_ax, self._axes_by_col)

        dlg = AnnotationDialog(
            self.ctrl, ann, self._y_ref_choices(), on_apply,
            self._request_pick, convert_y,
            title="Add Annotation" if index is None else f"Edit Annotation #{index + 1}",
        )
        self._annot_dialogs = [(s, d) for s, d in self._annot_dialogs if d.winfo_exists()]
        self._annot_dialogs.append((state, dlg))

    def _index_of(self, obj) -> int | None:
        return next((i for i, a in enumerate(self._annotations) if a is obj), None)

    def _add_annotation(self, kind: str, px=None, py=None):
        self._open_annotation_dialog(self._default_annotation(kind, px, py), None)

    def _edit_annotation(self):
        i = self._selected_annotation()
        if i is not None:
            self._open_annotation_dialog(self._annotations[i], i)

    def _duplicate_annotation(self):
        i = self._selected_annotation()
        if i is None:
            return
        self._annotations.insert(i + 1, replace(self._annotations[i]))
        self._annotations_changed(select=i + 1)

    def _delete_annotation(self):
        i = self._selected_annotation()
        if i is None:
            return
        del self._annotations[i]
        self._annotations_changed(select=min(i, len(self._annotations) - 1))

    def _toggle_annotation(self):
        i = self._selected_annotation()
        if i is None:
            return
        self._annotations[i].visible = not self._annotations[i].visible
        self._annotations_changed(select=i)

    def _move_annotation(self, delta: int):
        i = self._selected_annotation()
        if i is None:
            return
        j = i + delta
        if 0 <= j < len(self._annotations):
            a = self._annotations
            a[i], a[j] = a[j], a[i]
            self._annotations_changed(select=j)

    def _clear_annotations(self):
        if self._annotations and messagebox.askyesno(
            "Clear annotations", f"Remove all {len(self._annotations)} annotations?",
        ):
            self._annotations.clear()
            self._annotations_changed()

    def _save_annotations(self):
        if not self._annotations:
            messagebox.showinfo("Save annotations", "There are no annotations to save.")
            return
        base = self._csv_filename.rsplit(".", 1)[0] if self._csv_filename else "plot"
        path = filedialog.asksaveasfilename(
            title="Save Annotations", defaultextension=".json",
            filetypes=[("Annotation files", "*.json"), ("All files", "*.*")],
            initialfile=f"{base}_annotations.json",
        )
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(an.dumps(self._annotations))
        except OSError as exc:
            messagebox.showerror("Save annotations", str(exc))

    def _load_annotations(self):
        path = filedialog.askopenfilename(
            title="Load Annotations",
            filetypes=[("Annotation files", "*.json"), ("All files", "*.*")],
        )
        if not path:
            return
        try:
            with open(path, encoding="utf-8") as fh:
                loaded = an.loads(fh.read())
        except Exception as exc:
            messagebox.showerror("Load annotations", f"Could not read annotations:\n{exc}")
            return
        if self._annotations and messagebox.askyesno(
            "Load annotations", "Replace the current annotations?\n"
                                "(No = append to the existing list)",
        ):
            self._annotations.clear()
        self._annotations.extend(loaded)
        self._annotations_changed()

    def _request_pick(self, y_ref: str, callback) -> bool:
        if self._host_ax is None:
            return False
        self._pick_request = (y_ref, callback)
        self.plot_win.lift()
        return True

    def _on_plot_click(self, event):
        if self._host_ax is None or self._toolbar.mode != "":
            return
        if event.button == 1 and not self._pick_request:
            self._start_label_drag(event)
            return
        if event.inaxes is None:
            return
        if event.button == 1 and self._pick_request:
            y_ref, callback = self._pick_request
            self._pick_request = None
            try:
                x, y = an.display_to_coords(event.x, event.y, y_ref,
                                            self._host_ax, self._axes_by_col)
            except an.AxisNotPlotted:
                messagebox.showwarning("Pick point", f"Y axis '{y_ref}' is not plotted.")
                return
            callback(x, y)
        elif event.button == 3:
            menu = tk.Menu(self.plot_win, tearoff=False)
            for kind in an.KINDS:
                menu.add_command(
                    label=f"Add {kind} here",
                    command=lambda k=kind, px=event.x, py=event.y: self._add_annotation(k, px, py),
                )
            menu.tk_popup(self.plot_win.winfo_pointerx(), self.plot_win.winfo_pointery())

    # ── Dragging annotation labels ──────────────────────────────────────────────────────

    def _label_at(self, event) -> int | None:
        """Index of the top-most annotation label under the mouse, if any."""
        for i in sorted(self._label_artists, reverse=True):
            artist = self._label_artists[i]
            if artist.get_visible() and artist.contains(event)[0]:
                return i
        return None

    def _start_label_drag(self, event):
        i = self._label_at(event)
        if i is None:
            return
        artist = self._label_artists[i]
        self._drag = {
            "index": i, "artist": artist, "x0": event.x, "y0": event.y,
            "orig": replace(self._annotations[i]), "xyann0": artist.xyann, "new": None,
        }
        self._refresh_annot_list(select=i)

    def _on_plot_motion(self, event):
        if self._drag is None:
            self._update_hover_cursor(event)
            return
        d = self._drag
        orig = d["orig"]
        new = an.move_label(orig, event.x - d["x0"], event.y - d["y0"],
                            self._host_ax, self._axes_by_col, self.fig.dpi)
        d["new"] = new
        # Live preview by moving the existing artist (no full re-plot)
        artist = d["artist"]
        if orig.kind == an.TEXT:
            artist.xy = (new.x, new.y)
        elif orig.kind == an.ARROW:
            artist.xyann = (new.x2, new.y2)
        else:
            x0, y0 = d["xyann0"]
            artist.xyann = (x0 + new.text_dx - orig.text_dx, y0 + new.text_dy - orig.text_dy)
        self.canvas_fig.draw_idle()

    def _on_plot_release(self, event):
        d, self._drag = self._drag, None
        if d is None or d["new"] is None:
            return
        target = self._annotations[d["index"]]
        _assign(target, d["new"])
        for state, dlg in self._annot_dialogs:
            if state["obj"] is target and dlg.winfo_exists():
                dlg.sync_position(target)
        self._annotations_changed(select=d["index"])

    def _update_hover_cursor(self, event):
        over = (self._host_ax is not None and self._toolbar.mode == ""
                and not self._pick_request and self._label_at(event) is not None)
        if over != self._hover_label:
            self._hover_label = over
            self.canvas_fig.set_cursor(Cursors.MOVE if over else Cursors.POINTER)

    def _set_annot_status(self, warnings: list[str]):
        self._annot_status.config(text="\n".join(warnings))

    # ── Plot ──────────────────────────────────────────────────────────────────

    def _refresh_plot(self):
        if self.df is None:
            return

        active = [col for col, var, _cb, _grp in self._cb_rows if var.get()]

        t0 = min(self.start_var.get(), self.end_var.get())
        t1 = max(self.start_var.get(), self.end_var.get())

        x_col = self._x_col_var.get()
        if not x_col or x_col not in self.df.columns:
            return

        x_data  = pd.to_numeric(self.df[x_col], errors="coerce")
        mask    = (x_data >= t0) & (x_data <= t1)
        df_view = self.df[mask]
        x       = pd.to_numeric(df_view[x_col], errors="coerce").values

        self.fig.clear()
        self._host_ax = None
        self._axes_by_col = {}
        self._label_artists = {}
        self._drag = None

        # Title: custom if provided, otherwise auto-generated
        custom = self._custom_title_var.get().strip()
        title  = custom if custom else f"{self._csv_filename}  |  {x_col}: {t0:,.2f} \u2013 {t1:,.2f}"
        self.fig.suptitle(title, fontsize=9, y=0.999)

        # Compute display label for X axis (shared by empty state and plot)
        x_lbl     = self._x_label_var.get().strip() or x_col
        x_units   = self._x_unit_var.get().strip()
        x_display = f"{x_lbl} [{x_units}]" if x_units else x_lbl

        # Empty / no-selection state
        if not active or df_view.empty:
            ax = self.fig.add_subplot(111)
            ax.set_xlabel(x_display)
            msg = (
                "No data in selected range."
                if (df_view.empty and active)
                else "No columns selected."
            )
            ax.text(0.5, 0.5, msg, ha="center", va="center",
                    transform=ax.transAxes, fontsize=13, color="#aaa")
            self._set_annot_status(
                ["Annotations are hidden until something is plotted."]
                if any(a.visible for a in self._annotations) else []
            )
            self.canvas_fig.draw()
            self._rebuild_overrides_panel(active)
            return

        if len(active) > MAX_AXES_WARNING:
            if not messagebox.askyesno(
                "Many axes",
                f"{len(active)} columns are active.\n"
                "Plotting this many Y axes may be slow and cluttered.\n"
                "Continue?",
            ):
                self._rebuild_overrides_panel(active)
                return

        # Host axis + twin axes for extra columns
        ax0        = self.fig.add_subplot(111)
        extra_axes = [ax0.twinx() for _ in range(len(active) - 1)]
        axes       = [ax0] + extra_axes

        for i, ax in enumerate(extra_axes):
            ax.spines["right"].set_position(("outward", i * SPINE_OFFSET_PT))
            ax.spines["left"].set_visible(False)
            ax.spines["top"].set_visible(False)
        ax0.spines["top"].set_visible(False)

        lines = []
        for i, (ax, col) in enumerate(zip(axes, active)):
            color = COLORS[i % len(COLORS)]
            y     = pd.to_numeric(df_view[col], errors="coerce").values

            lv = self._label_vars.get(col)
            uv = self._unit_vars.get(col)
            label = (lv.get().strip() if lv else "") or col
            units = uv.get().strip() if uv else ""
            display_label = f"{label} [{units}]" if units else label

            (line,) = ax.plot(x, y, color=color, linewidth=1.0, label=display_label)
            ax.set_ylabel(display_label, color=color, fontsize=7, labelpad=2)
            ax.tick_params(axis="y", labelcolor=color, labelsize=6)
            lines.append(line)

        x_lbl   = self._x_label_var.get().strip() or x_col
        x_units = self._x_unit_var.get().strip()
        x_display = f"{x_lbl} [{x_units}]" if x_units else x_lbl
        ax0.set_xlabel(x_display)

        n_extra   = len(active) - 1
        fig_w_pt  = self.fig.get_figwidth() * self.fig.dpi
        right_pad = (n_extra * SPINE_OFFSET_PT) / fig_w_pt
        right     = max(0.45, 0.97 - right_pad)
        self.fig.subplots_adjust(left=0.07, right=right, bottom=0.10, top=0.93)

        ncol = max(1, len(lines) // 25)
        ax0.legend(
            lines, [l.get_label() for l in lines],
            loc="upper left", fontsize=7, framealpha=0.75, ncol=ncol,
        )

        # Annotations go on the top-most axes so they render above every line
        self._host_ax = ax0
        self._axes_by_col = dict(zip(active, axes))
        self._set_annot_status(an.render_annotations(
            self._annotations, ax0, self._axes_by_col, draw_ax=axes[-1],
            label_artists=self._label_artists,
        ))

        self.canvas_fig.draw()
        self._rebuild_overrides_panel(active)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    initial = sys.argv[1] if len(sys.argv) > 1 else None
    CsvPlotter(initial_path=initial)
