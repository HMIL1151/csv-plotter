import importlib.util
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "launch", Path(__file__).resolve().parent.parent / "web" / "launch.py")
launch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(launch)


class LaunchServerTests(unittest.TestCase):
    def _start(self, csv=None):
        server, url = launch.make_server(csv)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return url

    def _get(self, url):
        with urllib.request.urlopen(url, timeout=5) as res:
            return res.status, res.read()

    def test_serves_the_app_on_localhost(self):
        url = self._start()
        self.assertTrue(url.startswith("http://127.0.0.1:"))
        status, body = self._get(url)
        self.assertEqual(status, 200)
        self.assertIn(b"CSV Plotter", body)

    def test_csv_is_exposed_and_referenced_in_the_url(self):
        with tempfile.TemporaryDirectory() as d:
            csv = Path(d) / "my run.csv"
            csv.write_bytes(b"t,v\n0,1\n1,2\n")
            url = self._start(csv)
            file_param = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["file"][0]
            self.assertEqual(file_param, "/__data/my run.csv")
            base = url.split("/index.html")[0]
            status, body = self._get(base + urllib.parse.quote(file_param))
            self.assertEqual((status, body), (200, b"t,v\n0,1\n1,2\n"))

    def test_only_the_given_csv_is_exposed(self):
        with tempfile.TemporaryDirectory() as d:
            csv = Path(d) / "a.csv"
            csv.write_text("x\n1\n", encoding="utf-8")
            (Path(d) / "secret.csv").write_text("nope", encoding="utf-8")
            base = self._start(csv).split("/index.html")[0]
            for path in ("/__data/secret.csv", "/__data/../a.csv", "/__data/"):
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    self._get(base + path)
                self.assertEqual(ctx.exception.code, 404)

    def test_missing_csv_is_an_error(self):
        with self.assertRaises(FileNotFoundError):
            launch.make_server("does/not/exist.csv")


if __name__ == "__main__":
    unittest.main()
