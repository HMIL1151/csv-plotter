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
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

import pandas as pd
import matplotlib
matplotlib.use("TkAgg")
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.figure import Figure

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

        ttk.Button(
            self.ctrl, text="⟳  Refresh Plot", command=self._refresh_plot,
        ).pack(pady=(2, 2))

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
        toolbar = NavigationToolbar2Tk(self.canvas_fig, self.plot_win, pack_toolbar=False)
        toolbar.update()
        toolbar.pack(side="bottom", fill="x")
        self.canvas_fig.get_tk_widget().pack(fill="both", expand=True)
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

        self.canvas_fig.draw()
        self._rebuild_overrides_panel(active)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    initial = sys.argv[1] if len(sys.argv) > 1 else None
    CsvPlotter(initial_path=initial)
