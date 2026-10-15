import unittest

import matplotlib
matplotlib.use("Agg")
from matplotlib.figure import Figure
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle
from matplotlib.text import Annotation as MplAnnotation

import annotations as an


def _make_plot():
    fig = Figure(figsize=(6, 4), dpi=100)
    host = fig.add_subplot(111)
    twin = host.twinx()
    host.plot([0, 10], [0, 100])
    twin.plot([0, 10], [-1, 1])
    host.set_xlim(0, 10)
    host.set_ylim(0, 100)
    twin.set_ylim(-1, 1)
    fig.canvas.draw()
    return fig, host, twin, {"a": host, "b": twin}


class ModelTests(unittest.TestCase):
    def test_round_trip_json(self):
        anns = [an.Annotation(kind=an.ARROW, text="peak", x=1, y=2, x2=3, y2=4, y_ref="a"),
                an.Annotation(kind=an.XSPAN, text="warmup", x=0, x2=5, visible=False)]
        self.assertEqual(an.loads(an.dumps(anns)), anns)

    def test_from_dict_ignores_unknown_keys(self):
        ann = an.Annotation.from_dict({"kind": an.VLINE, "x": 2, "bogus": 1})
        self.assertEqual((ann.kind, ann.x), (an.VLINE, 2))

    def test_validate_reports_missing_required_fields(self):
        errs = an.Annotation(kind=an.XSPAN, x=1, x2=None).validate()
        self.assertEqual(len(errs), 1)
        self.assertIn("End X", errs[0])
        self.assertEqual(an.Annotation(kind=an.XSPAN, x=1, x2=2).validate(), [])

    def test_every_kind_has_fields_and_styles(self):
        for kind in an.KINDS:
            self.assertIn(kind, an.KIND_FIELDS)
            self.assertIn(kind, an.KIND_STYLES)


class CoordinateTests(unittest.TestCase):
    def test_display_to_coords_round_trips_through_column_axis(self):
        _fig, host, twin, axes = _make_plot()
        px, py = twin.transData.transform((4, 0.5))
        x, y = an.display_to_coords(px, py, "b", host, axes)
        self.assertAlmostEqual(x, 4)
        self.assertAlmostEqual(y, 0.5)

    def test_display_to_coords_axes_fraction(self):
        _fig, host, _twin, axes = _make_plot()
        px, py = host.transAxes.transform((0.5, 0.25))
        x, y = an.display_to_coords(px, py, an.AXES_FRACTION, host, axes)
        self.assertAlmostEqual(x, 5)
        self.assertAlmostEqual(y, 0.25)

    def test_convert_y_between_axes(self):
        _fig, host, _twin, axes = _make_plot()
        self.assertAlmostEqual(an.convert_y(50, "a", "b", host, axes), 0.0)
        self.assertAlmostEqual(an.convert_y(0.0, "b", an.AXES_FRACTION, host, axes), 0.5)


class RenderTests(unittest.TestCase):
    def _sample(self, kind):
        return an.Annotation(kind=kind, text="lbl", x=2, y=0.5, x2=6, y2=0.8)

    def test_every_kind_renders_without_error(self):
        for kind in an.KINDS:
            with self.subTest(kind=kind):
                fig, host, twin, axes = _make_plot()
                warnings = an.render_annotations([self._sample(kind)], host, axes, twin)
                self.assertEqual(warnings, [])
                fig.canvas.draw()

    def test_xspan_adds_rectangle_without_changing_limits(self):
        fig, host, twin, axes = _make_plot()
        an.render_annotations([an.Annotation(kind=an.XSPAN, x=-50, x2=50)], host, axes, twin)
        self.assertTrue(any(isinstance(a, Rectangle) for a in twin.get_children()))
        self.assertEqual(host.get_xlim(), (0, 10))

    def test_vline_adds_line_and_label(self):
        fig, host, twin, axes = _make_plot()
        an.render_annotations([an.Annotation(kind=an.VLINE, x=3, text="t0")], host, axes, twin)
        self.assertTrue(any(isinstance(a, Line2D) for a in twin.get_children()))
        self.assertTrue(any(isinstance(t, MplAnnotation) and t.get_text() == "t0"
                            for t in twin.texts))

    def test_hidden_annotations_are_skipped(self):
        fig, host, twin, axes = _make_plot()
        n_before = len(twin.texts)
        an.render_annotations([an.Annotation(text="x", visible=False)], host, axes, twin)
        self.assertEqual(len(twin.texts), n_before)

    def test_unplotted_axis_produces_warning_not_exception(self):
        fig, host, twin, axes = _make_plot()
        warnings = an.render_annotations(
            [an.Annotation(kind=an.HLINE, y=1, y_ref="missing")], host, axes, twin)
        self.assertEqual(len(warnings), 1)
        self.assertIn("missing", warnings[0])

    def test_invalid_annotation_produces_warning(self):
        fig, host, twin, axes = _make_plot()
        warnings = an.render_annotations(
            [an.Annotation(kind=an.RECT, x=1, y=1, x2=None, y2=None)], host, axes, twin)
        self.assertEqual(len(warnings), 1)


class LabelMoveTests(unittest.TestCase):
    def _render_one(self, ann):
        fig, host, twin, axes = _make_plot()
        artists = {}
        an.render_annotations([ann], host, axes, twin, label_artists=artists)
        fig.canvas.draw()
        return fig, host, axes, artists

    def test_label_artists_are_reported_by_index(self):
        _fig, _host, _axes, artists = self._render_one(
            an.Annotation(kind=an.MARKER, text="pt", x=5, y=50, y_ref="a"))
        self.assertEqual(artists[0].get_text(), "pt")

    def test_unlabelled_annotations_have_no_artist(self):
        _fig, _host, _axes, artists = self._render_one(
            an.Annotation(kind=an.VLINE, x=5, text=""))
        self.assertEqual(artists, {})

    def test_nudge_shifts_label_and_adds_leader(self):
        base = an.Annotation(kind=an.MARKER, text="pt", x=5, y=50, y_ref="a")
        _f, _h, _a, plain = self._render_one(base)
        nudged = an.Annotation(kind=an.MARKER, text="pt", x=5, y=50, y_ref="a",
                               text_dx=20, text_dy=-10)
        _f, _h, _a, moved = self._render_one(nudged)
        (px, py), (mx, my) = plain[0].xyann, moved[0].xyann
        self.assertAlmostEqual(mx - px, 20)
        self.assertAlmostEqual(my - py, -10)
        self.assertIsNone(plain[0].arrow_patch)
        self.assertIsNotNone(moved[0].arrow_patch)

    def test_leader_can_be_disabled(self):
        _f, _h, _a, artists = self._render_one(an.Annotation(
            kind=an.MARKER, text="pt", x=5, y=50, y_ref="a", text_dx=30, leader=False))
        self.assertIsNone(artists[0].arrow_patch)

    def test_move_label_nudges_offset_in_points(self):
        fig, host, axes, _ = self._render_one(an.Annotation())
        ann = an.Annotation(kind=an.XSPAN, text="s", x=1, x2=2, text_dx=5)
        new = an.move_label(ann, 100, -50, host, axes, dpi=100)
        self.assertAlmostEqual(new.text_dx, 5 + 72)
        self.assertAlmostEqual(new.text_dy, -36)
        self.assertEqual((new.x, new.x2), (1, 2))
        self.assertEqual(ann.text_dx, 5)   # original untouched

    def test_move_label_moves_arrow_text_coordinate(self):
        fig, host, axes, _ = self._render_one(an.Annotation())
        ann = an.Annotation(kind=an.ARROW, x=1, y=10, x2=5, y2=50, y_ref="a")
        px, py = host.transData.transform((5, 50))
        tx, ty = host.transData.transform((6, 60))
        new = an.move_label(ann, tx - px, ty - py, host, axes, dpi=100)
        self.assertAlmostEqual(new.x2, 6)
        self.assertAlmostEqual(new.y2, 60)
        self.assertEqual((new.x, new.y), (1, 10))   # arrow tip stays put

    def test_move_label_moves_text_box_coordinate(self):
        fig, host, axes, _ = self._render_one(an.Annotation())
        ann = an.Annotation(kind=an.TEXT, x=5, y=0.5)
        dx, _ = host.transData.transform((6, 0)) - host.transData.transform((5, 0))
        new = an.move_label(ann, dx, 0, host, axes, dpi=100)
        self.assertAlmostEqual(new.x, 6)
        self.assertAlmostEqual(new.y, 0.5)
        self.assertEqual((new.text_dx, new.text_dy), (0, 0))


if __name__ == "__main__":
    unittest.main()
