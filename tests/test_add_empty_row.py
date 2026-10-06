from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))

import add_empty_row  # noqa: E402


class AddEmptyRowTests(unittest.TestCase):
    def write_table(
        self,
        path: Path,
        columns: list[str] | None = None,
        rows: list[object] | None = None,
    ) -> None:
        data = {
            "$schema": "./schema/table.schema.json",
            "columns": columns or ["A", "B", "C"],
            "rows": rows if rows is not None else [{"A": "日本語"}],
        }
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def read_table(self, path: Path) -> dict[str, object]:
        with path.open(encoding="utf-8") as source:
            return json.load(source)

    def test_append_empty_row_and_format(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.json"
            self.write_table(path)

            count = add_empty_row.add_empty_row(path)
            data = self.read_table(path)
            source = path.read_text(encoding="utf-8")

            self.assertEqual(2, count)
            self.assertEqual(
                {"A": "", "B": "", "C": ""},
                data["rows"][-1],
            )
            self.assertEqual("日本語", data["rows"][0]["A"])
            self.assertTrue(source.endswith("\n"))
            self.assertIn('\n  "columns"', source)
            self.assertNotIn("\\u65e5", source)

    def test_insert_at_start_and_middle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.json"
            self.write_table(
                path,
                rows=[{"A": "one"}, {"A": "two"}],
            )
            add_empty_row.add_empty_row(path, 1)
            data = self.read_table(path)
            self.assertEqual("", data["rows"][0]["A"])
            self.assertEqual("one", data["rows"][1]["A"])

            add_empty_row.add_empty_row(path, 3)
            data = self.read_table(path)
            self.assertEqual("", data["rows"][2]["A"])
            self.assertEqual("two", data["rows"][3]["A"])

    def test_added_column_is_included(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.json"
            self.write_table(path, columns=["A", "B", "G"])
            add_empty_row.add_empty_row(path)
            data = self.read_table(path)
            self.assertEqual(
                {"A": "", "B": "", "G": ""},
                data["rows"][-1],
            )

    def test_invalid_position_does_not_change_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.json"
            self.write_table(path)
            before = path.read_bytes()
            with self.assertRaises(add_empty_row.UpdateError):
                add_empty_row.add_empty_row(path, 3)
            self.assertEqual(before, path.read_bytes())

    def test_invalid_position_argument_returns_one(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            exit_code = add_empty_row.main(["--position", "not-a-number"])
        self.assertEqual(1, exit_code)

    def test_invalid_json_and_duplicate_columns_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.json"
            path.write_text('{"columns": [', encoding="utf-8")
            before = path.read_bytes()
            with self.assertRaises(add_empty_row.UpdateError):
                add_empty_row.add_empty_row(path)
            self.assertEqual(before, path.read_bytes())

            self.write_table(path, columns=["A", "A"])
            before = path.read_bytes()
            with self.assertRaises(add_empty_row.UpdateError):
                add_empty_row.add_empty_row(path)
            self.assertEqual(before, path.read_bytes())

    def test_replace_failure_preserves_original(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "table.json"
            self.write_table(path)
            before = path.read_bytes()

            with mock.patch.object(
                add_empty_row.os,
                "replace",
                side_effect=OSError("injected replace failure"),
            ):
                with self.assertRaises(add_empty_row.UpdateError):
                    add_empty_row.add_empty_row(path)

            self.assertEqual(before, path.read_bytes())
            self.assertEqual([], list(path.parent.glob(".*.tmp")))


if __name__ == "__main__":
    unittest.main()
