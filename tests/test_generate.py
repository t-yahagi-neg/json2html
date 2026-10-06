from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT_DIR = Path(__file__).resolve().parents[1]
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(PROJECT_DIR))

import generate  # noqa: E402


class GenerateTests(unittest.TestCase):
    def load_fixture(self, name: str) -> object:
        with (FIXTURES_DIR / name).open(encoding="utf-8") as source:
            return json.load(source)

    def prepare_project(
        self,
        base_dir: Path,
        table_fixture: str = "table_valid.json",
        menu_fixture: str = "menu_valid.json",
    ) -> None:
        shutil.copy(FIXTURES_DIR / table_fixture, base_dir / "table.json")
        shutil.copy(FIXTURES_DIR / menu_fixture, base_dir / "menu.json")

    def test_valid_table_and_menu(self) -> None:
        index, table_warnings = generate.build_index(
            self.load_fixture("table_valid.json")
        )
        menu, menu_warnings = generate.build_menu(self.load_fixture("menu_valid.json"))

        self.assertEqual([], table_warnings)
        self.assertEqual([], menu_warnings)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", index)
        # データ内の script はエスケープ。表フィルタ用の外部 script のみ許可
        self.assertNotIn("<script>alert", index)
        self.assertIn("table-filter.js", index)
        self.assertIn("sidebar-toggle", index)
        self.assertIn("sidebar-toggle.js", index)
        self.assertIn("table-filter-toggle", index)
        self.assertIn("data-col-index", index)
        self.assertIn("data-filter-value", index)
        self.assertIn("data-filter-label", index)
        self.assertIn("?mode=test&amp;page=1", index)
        self.assertIn('target="_blank"', index)
        self.assertIn('rel="noopener noreferrer"', index)
        self.assertIn('class="cell-black"', index)
        self.assertIn('class="multiline-cell"', index)
        self.assertIn("multiline-link-line", index)
        self.assertIn("multiline-empty-line", index)
        self.assertIn("&lt;b&gt;文字列&lt;/b&gt;", index)
        self.assertIn('target="_top"', menu)
        self.assertIn("menu-item-text", menu)

    def test_menu_link_relations_use_only_allowed_classes(self) -> None:
        for relation in ("parent", "sibling", "child"):
            with self.subTest(relation=relation):
                menu, warnings = generate.build_menu(
                    {
                        "items": [
                            {
                                "type": "link",
                                "text": "page",
                                "url": "page/index.html",
                                "relation": relation,
                            }
                        ]
                    }
                )
                self.assertEqual([], warnings)
                self.assertIn(f'<li class="menu-item menu-relation-{relation}">', menu)
                self.assertIn('<a href="page/index.html" target="_top">page</a>', menu)

    def test_missing_and_unknown_relations_default_silently_to_sibling(self) -> None:
        for extra in (
            {},
            {"relation": None},
            {"relation": ""},
            {"relation": "unknown"},
            {"relation": "Parent"},
            {"relation": 1},
            {"relation": False},
            {"relation": []},
            {"relation": {}},
            {"relation": 'parent" onclick="alert(1)'},
        ):
            with self.subTest(extra=extra):
                item = {"type": "link", "text": "page", "url": "index.html", **extra}
                menu, warnings = generate.build_menu({"items": [item]})
                self.assertEqual([], warnings)
                self.assertIn('<li class="menu-item menu-relation-sibling">', menu)
                self.assertNotIn("menu-relation-parent", menu)
                self.assertNotIn("onclick", menu)

    def test_warnings_are_embedded(self) -> None:
        index, table_warnings = generate.build_index(
            self.load_fixture("table_warning.json")
        )
        menu, menu_warnings = generate.build_menu(
            self.load_fixture("menu_warning.json")
        )

        self.assertGreaterEqual(len(table_warnings), 7)
        self.assertEqual(4, len(menu_warnings))
        self.assertIn("未定義の列", index)
        self.assertIn("未対応の形式", index)
        self.assertIn("最後の列だけ", index)
        self.assertIn("multiline.lines内", index)
        self.assertIn("table.json読み込み時の警告", index)
        self.assertIn("menu.json読み込み時の警告", menu)
        self.assertNotIn('href="ftp://', menu)

    def test_hidden_warnings_are_still_collected(self) -> None:
        table = self.load_fixture("table_warning.json")
        menu = self.load_fixture("menu_warning.json")
        _, expected_table_warnings = generate.build_index(table)
        _, expected_menu_warnings = generate.build_menu(menu)
        table["show_warnings"] = False
        index, table_warnings = generate.build_index(table)
        menu_html, menu_warnings = generate.build_menu(menu, show_warnings=False)

        self.assertEqual(expected_table_warnings, table_warnings)
        self.assertEqual(expected_menu_warnings, menu_warnings)
        self.assertNotIn('class="data-messages"', index)
        self.assertNotIn('class="menu-messages"', menu_html)
        self.assertNotIn("table.json読み込み時の警告", index)
        self.assertNotIn("menu.json読み込み時の警告", menu_html)
        self.assertIn("<table", index)
        self.assertIn('class="menu-list"', menu_html)
        self.assertNotIn('href="ftp://', menu_html)

    def test_generate_files_applies_warning_setting_to_both_pages(self) -> None:
        with tempfile.TemporaryDirectory(dir=PROJECT_DIR.parent) as directory:
            base_dir = Path(directory)
            self.prepare_project(base_dir, "table_warning.json", "menu_warning.json")
            table = self.load_fixture("table_warning.json")
            expected = generate.generate_files(base_dir)
            for setting in (False, True, None, ""):
                with self.subTest(setting=setting):
                    table["show_warnings"] = setting
                    (base_dir / "table.json").write_text(
                        json.dumps(table), encoding="utf-8"
                    )
                    self.assertEqual(expected, generate.generate_files(base_dir))
                    for name, marker in (
                        ("index.html", 'class="data-messages"'),
                        ("menu.html", 'class="menu-messages"'),
                    ):
                        document = (base_dir / name).read_text(encoding="utf-8")
                        self.assertEqual(setting is not False, marker in document)

    def test_invalid_json_preserves_existing_html(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base_dir = Path(directory)
            (base_dir / "table.json").write_text(
                '{"columns": [',
                encoding="utf-8",
            )
            shutil.copy(
                FIXTURES_DIR / "menu_valid.json",
                base_dir / "menu.json",
            )
            (base_dir / "index.html").write_text(
                "old index",
                encoding="utf-8",
            )
            (base_dir / "menu.html").write_text(
                "old menu",
                encoding="utf-8",
            )

            with self.assertRaises(generate.GenerationError):
                generate.generate_files(base_dir)

            self.assertEqual(
                "old index",
                (base_dir / "index.html").read_text(encoding="utf-8"),
            )
            self.assertEqual(
                "old menu",
                (base_dir / "menu.html").read_text(encoding="utf-8"),
            )

    def test_second_publish_failure_rolls_back_both_html(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base_dir = Path(directory)
            self.prepare_project(base_dir)
            index_path = base_dir / "index.html"
            menu_path = base_dir / "menu.html"
            index_path.write_text("old index", encoding="utf-8")
            menu_path.write_text("old menu", encoding="utf-8")
            original_replace = os.replace

            def replace_with_failure(
                source: str | os.PathLike[str],
                destination: str | os.PathLike[str],
            ) -> None:
                source_path = Path(source)
                if (
                    Path(destination) == menu_path
                    and source_path.name.startswith(".menu.html.")
                    and source_path.name.endswith(".tmp")
                ):
                    raise OSError("injected menu publish failure")
                original_replace(source, destination)

            with mock.patch.object(
                generate.os,
                "replace",
                side_effect=replace_with_failure,
            ):
                with self.assertRaises(generate.GenerationError):
                    generate.generate_files(base_dir)

            self.assertEqual(
                "old index",
                index_path.read_text(encoding="utf-8"),
            )
            self.assertEqual(
                "old menu",
                menu_path.read_text(encoding="utf-8"),
            )
            self.assertEqual([], list(base_dir.glob(".*.tmp")))
            self.assertEqual([], list(base_dir.glob(".*.backup")))


if __name__ == "__main__":
    unittest.main()
