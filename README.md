# CSV Plotter

A quick, interactive plotting tool for exploring, annotating and exporting long CSV files.

There are two versions:

| | **Web app** (`web/`), recommended | **Desktop app** (`csv_plotter.py`) |
|---|---|---|
| Run | `python web/launch.py data.csv`, or open `web/index.html` | `python csv_plotter.py` |
| Install | Nothing | Python, pandas, matplotlib |
| Editing | Click-and-drag on the plot | Dialogs and fields |
| Output | PNG, SVG, clipboard, CSV | CSV (plus matplotlib's save button) |

Annotation JSON files work in both.

---

## Web app

![No install](https://img.shields.io/badge/install-none-brightgreen) ![Plotly](https://img.shields.io/badge/Plotly.js-2.35-blue)

### Running it

**From the terminal** (needs only Python 3.10+, no packages):

```bash
python web/launch.py                  # open the app in your browser
python web/launch.py path/to/data.csv # open it with a file already loaded
```

This serves the app at `http://127.0.0.1:<port>`, which only this computer can reach, and opens your default browser. Press **Ctrl+C** to stop. Options:
- `--port 8000` uses a fixed port.
- `--no-browser` just prints the URL.

Only the CSV you name is served. On Windows, use `py` if `python` isn't on your PATH.

**Or without a terminal:** double-click **`web/index.html`**, or drag it into Chrome, Edge or Firefox. There's no server, no build step and nothing to install. Your data stays in the browser.

- Plotly is loaded from its CDN the first time. To work fully offline, put a copy in `web/vendor/` (see [`web/vendor/README.md`](web/vendor/README.md)).
- Open `web/index.html?sample` to start with the built-in sample data.

### Features

**Data**
- Open a CSV with the button or drag it onto the window. Delimiters (`,` `;` tab `|`) and column types are detected automatically.
- The X axis can be numeric or **date/time**. Text columns are shown but can't be plotted.
- Grouped column picker (`sensor_1`, `sensor_2`, … are grouped under `sensor`), with group tick boxes, filter, All/None and collapse.
- Set the visible X range with the dual slider, by typing start/end values, or by **dragging on the plot to zoom** (double-click resets). All three stay in sync.
- Handles large files: a 14 MB, 200k-row file parses in about 0.2 s, and plots switch to WebGL above 20k points.

**Professional output**
- Themes: Clean, Publication, Soft grey, Dark, Presentation. Palettes include colour-blind-safe Okabe–Ito.
- Layouts: **separate colour-coded Y axes** (balanced left/right), **one shared Y axis**, or **stacked panels** with a shared X axis.
- Title, X label/units, and per-series label, units, colour and line style. Drag series to reorder them (and their axes).
- Line width, font size, grid, data points and legend position.
- **Export** PNG (with high-resolution scale), SVG (vector), copy to clipboard, or CSV of the visible range with your labels as headers. The export size is set separately from the window size.

**Annotations (click and drag)**
- Nine types: text box, arrow + text, span bracket (arrows or `|—|` dimension ends), shaded X span, shaded Y span, vertical line, horizontal line, point marker, rectangle.
- **Create**: pick a tool (toolbar or keyboard shortcut), then click or drag on the plot. Arrows and markers snap to the nearest data point.
- **Edit**:
  - Drag anything to move it.
  - Drag span or rectangle edges and corners, or bracket ends, to resize.
  - Drag a label to move just its text (a leader line is added).
  - Double-click to edit text in place, or right-click for more options.
- **Inspector**: the panel for the selected annotation has its text (with `<b>`, `<i>`, `<sup>` support), exact positions, colours, font size, box style, line style and width, arrow heads, fill opacity, marker shape and label offset.
- **Following the data**: annotations attach to the series you drew them near, so they stay with the data when you zoom or change the range. Switching an annotation's Y axis converts its values.
- **Undo/redo** for everything, plus delete, duplicate, nudge with arrow keys, and bring to front / send to back.

**Saving work**
- Your work is autosaved in the browser for each file name and restored when you reopen the same file.
- **Project ▾**: save or open a project file (labels, styles, selection, annotations), and save or load annotations. These are the same annotation files the desktop app uses.

Press **?** in the app for the full list of shortcuts.

### Development

The code is plain JavaScript with no dependencies or build step:

```
web/
├── index.html       # Page layout
├── css/styles.css
├── js/core.js       # Pure logic: CSV parsing, figure building, hit-testing, drag maths (unit tested)
├── js/app.js        # UI controller: DOM, Plotly and mouse/keyboard handling
├── launch.py        # Terminal launcher: local server + optional CSV preload
├── tests/           # node --test suite for core.js
└── vendor/          # Optional local Plotly copy (git-ignored)
```

Run the tests with `cd web && npm test` (Node 18+).

---

## Desktop app (Python)

### Features

- **Two-window layout** – a compact **Controls** panel alongside a full-size **Plot** window.
- **File browser** – open any CSV file via a standard file dialog (or pass a path on the command line).
- **Configurable X axis** – choose any column as the X axis from a dropdown.
- **Range sliders** – zoom into a sub-range of the X axis without touching the data.
- **Grouped column checkboxes** – columns that share a common prefix (e.g. `sensor_1`, `sensor_2`) are automatically grouped under a collapsible header with a group-level select toggle.
- **Column filter** – type to instantly filter the column list; matching groups expand automatically.
- **Select All / None** – scoped to the current filter text.
- **Custom axis labels & units** – override the display label and units for the X axis and each active Y axis independently.
- **Custom plot title** – set a free-text title that overrides the auto-generated one.
- **Multi-Y-axis plot** – each selected column gets its own colour-coded Y axis with staggered right-hand spines.
- **Export CSV** – save the currently visible (filtered, range-trimmed) data to a new CSV file, with any label/unit overrides applied to the column headers.
- **Annotations** – label the plot with text boxes, arrows + text (straight or curved), span brackets (`<->`, `|-|`, …), shaded X/Y spans, vertical/horizontal reference lines, point markers, and rectangles. Each has its own colour, font size, line style/width, arrow head, text-box style and fill opacity. Annotations survive refreshes and file loads and can be saved/loaded as JSON.
- **Debounced refresh** – slider and X-column changes trigger a delayed re-draw to keep the UI responsive.

---

### Requirements

| Package | Version |
|---------|---------|
| Python | 3.10+ |
| pandas | any recent |
| matplotlib | any recent |
| tkinter | bundled with Python |

Install dependencies with pip:

```bash
pip install pandas matplotlib
```

> **Note:** `tkinter` ships with most standard Python distributions. If it is missing (e.g. on some Linux installs), install it via your package manager:
> ```bash
> sudo apt install python3-tk   # Debian/Ubuntu
> sudo dnf install python3-tkinter  # Fedora
> ```

---

### Usage

```bash
# Launch with the file browser
python csv_plotter.py

# Open a specific file immediately
python csv_plotter.py path/to/data.csv
```

#### Typical workflow

1. Click **Browse…** (or pass a path) to load a CSV.
2. Select the **X Column** (defaults to the first column).
3. Use the **Start / End** sliders to focus on a time/value range.
4. Tick the columns you want to plot in the **Columns** tab; use the filter box to search.
5. *(Optional)* Switch to the **Labels** tab to set a custom title, X-axis label/units, or per-column Y-axis overrides.
6. Click **⟳ Refresh Plot** at any time, or let the auto-refresh fire after slider/checkbox changes.
7. Click **↓ Export CSV** to save the visible slice with renamed headers.
8. *(Optional)* Add annotations from the **Annotations** tab (**+ Add ▾**) or by right-clicking the plot.

#### Annotations

- **Adding** – use **+ Add ▾** in the Annotations tab, or right-click anywhere on the plot to add one at that spot. (Right-click is ignored while the toolbar's pan/zoom mode is active.)
- **Editing** – double-click a row (or select it and click **Edit**). In the editor, **Pick point 1 / 2** lets you set positions by clicking the plot. **Apply** previews the change; **OK** applies it and closes the editor.
- **Moving labels** – drag any annotation's text on the plot (the cursor changes to a move cursor over it). Text boxes and arrow text move their actual position, so the arrow tip stays where it is. Labels on spans, lines, markers, brackets and rectangles get an offset from their anchor instead, and a thin leader line links them back. You can also type the offset in points in the editor (**Reset** sets it back to 0), or untick **Leader line** to hide the line.
- **Coordinates** – X is always in X-column units. Y is in either *axes fraction* (0 = bottom, 1 = top, so it stays at that height on screen) or the units of a plotted column (so it stays with the data when the range changes). If you change the Y axis in the editor, existing Y values are converted for you. An annotation tied to a column that isn't plotted is hidden, and the tab shows a warning.
- **Managing** – Duplicate, Delete, Show/Hide, reorder (↑/↓), Clear All, and **Save… / Load…** to a `.json` file.

---

## Project Structure

```
csv-plotter/
├── web/                  # Browser app (see above)
├── csv_plotter.py        # Desktop app (controls + plot windows)
├── annotations.py        # Desktop annotation model, JSON I/O, matplotlib rendering
├── annotation_dialog.py  # Desktop annotation editor dialog
└── tests/                # Desktop unittest suite
```

Run the desktop tests with:

```bash
python -m unittest discover -s tests -t .
```

---

## License

This project is provided as-is for personal and internal use. No explicit licence has been set — contact the repository owner for reuse enquiries.
