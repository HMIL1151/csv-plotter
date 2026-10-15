# CSV Plotter

A quick, interactive plotting tool for exploring and visualising long CSV files. Built with Python, tkinter, pandas, and matplotlib.

![Python](https://img.shields.io/badge/Python-3.10%2B-blue?logo=python)

---

## Features

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

## Requirements

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

## Usage

```bash
# Launch with the file browser
python csv_plotter.py

# Open a specific file immediately
python csv_plotter.py path/to/data.csv
```

### Typical workflow

1. Click **Browse…** (or pass a path) to load a CSV.
2. Select the **X Column** (defaults to the first column).
3. Use the **Start / End** sliders to focus on a time/value range.
4. Tick the columns you want to plot in the **Columns** tab; use the filter box to search.
5. *(Optional)* Switch to the **Labels** tab to set a custom title, X-axis label/units, or per-column Y-axis overrides.
6. Click **⟳ Refresh Plot** at any time, or let the auto-refresh fire after slider/checkbox changes.
7. Click **↓ Export CSV** to save the visible slice with renamed headers.
8. *(Optional)* Add annotations from the **Annotations** tab (**+ Add ▾**) or by right-clicking the plot.

### Annotations

- **Adding** – use **+ Add ▾** in the Annotations tab, or right-click anywhere on the plot to add one at that spot. (Right-click is ignored while the toolbar's pan/zoom mode is active.)
- **Editing** – double-click a row (or select it and click **Edit**). In the editor, **Pick point 1 / 2** lets you set positions by clicking the plot. **Apply** previews the change; **OK** applies it and closes the editor.
- **Coordinates** – X is always in X-column units. Y is in either *axes fraction* (0 = bottom, 1 = top, so it stays at that height on screen) or the units of a plotted column (so it stays with the data when the range changes). If you change the Y axis in the editor, existing Y values are converted for you. An annotation tied to a column that isn't plotted is hidden, and the tab shows a warning.
- **Managing** – Duplicate, Delete, Show/Hide, reorder (↑/↓), Clear All, and **Save… / Load…** to a `.json` file.

---

## Project Structure

```
csv-plotter/
├── csv_plotter.py        # Application (controls + plot windows)
├── annotations.py        # Annotation model, JSON I/O, matplotlib rendering
├── annotation_dialog.py  # Tk editor dialog for a single annotation
└── tests/                # unittest suite
```

Run the tests with:

```bash
python -m unittest discover -s tests -t .
```

---

## License

This project is provided as-is for personal and internal use. No explicit licence has been set — contact the repository owner for reuse enquiries.
