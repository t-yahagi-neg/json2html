from __future__ import annotations

import json
import os
import re
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
    def test_single_page_breadcrumb_is_current_without_link(self) -> None:
        for breadcrumbs in (None, []):
            with self.subTest(breadcrumbs=breadcrumbs):
                document, _ = generate.build_index(
                    {"columns": ["A"], "rows": [], "title": "単ページ"},
                    breadcrumbs=breadcrumbs,
                )
                nav = (
                    '<nav class="breadcrumbs" aria-label="パンくず"><ol>'
                    '<li aria-current="page">単ページ</li></ol></nav>'
                )
                self.assertIn(nav, document)
                self.assertLess(document.index(nav), document.index("<h1>"))

    def test_breadcrumbs_escape_labels_and_urls_and_keep_unlinked_ancestors(self):
        document, _ = generate.build_index(
            {"columns": ["A"], "rows": []},
            '<current & "page">',
            breadcrumbs=[
                {"title": '<root & "page">', "url": '../index.html?a=1&b="2"'},
                {"title": "<missing>", "url": None},
                {"title": "no URL"},
            ],
        )
        self.assertIn(
            '<ol><li><a href="../index.html?a=1&amp;b=&quot;2&quot;">'
            "&lt;root &amp; &quot;page&quot;&gt;</a></li>"
            "<li>&lt;missing&gt;</li><li>no URL</li>"
            '<li aria-current="page">&lt;current &amp; &quot;page&quot;&gt;</li>'
            "</ol></nav>",
            document,
        )
        self.assertEqual(1, document.count('aria-current="page"'))

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

        self.assertEqual(6, len(table_warnings))
        self.assertEqual(4, len(menu_warnings))
        self.assertIn("未定義の列", index)
        self.assertIn("未対応の形式", index)
        self.assertNotIn("最後の列だけ", index)
        self.assertIn(
            '<a href="https://example.com/" target="_blank" '
            'rel="noopener noreferrer">最終列以外のリンク</a>',
            index,
        )
        self.assertIn("multiline.lines内", index)
        self.assertIn("table.json読み込み時の警告", index)
        self.assertIn("menu.json読み込み時の警告", menu)
        self.assertNotIn('href="ftp://', menu)

    def test_local_file_links_in_every_column_and_cell_type(self) -> None:
        columns = ["first", "middle", "last"]
        text = '<日本語 & "link"\'>'
        escaped_text = "&lt;日本語 &amp; &quot;link&quot;&#x27;&gt;"
        for url, escaped_url in (
            ("file:///Users/test/index.html", "file:///Users/test/index.html"),
            (
                "file:///Users/test/日本語 空白.html",
                "file:///Users/test/日本語 空白.html",
            ),
            (
                "file:///Users/test/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.html#section?x=1",
                "file:///Users/test/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.html#section?x=1",
            ),
            (
                "file:///Users/test/a & b.html?x=\"<値>\"&y='ok'#見出し",
                "file:///Users/test/a &amp; b.html?x=&quot;&lt;値&gt;&quot;"
                "&amp;y=&#x27;ok&#x27;#見出し",
            ),
            ("file:///Users/test/no-extension", "file:///Users/test/no-extension"),
            ("file:///Users/test/data.txt", "file:///Users/test/data.txt"),
        ):
            for cell_type in ("link", "multiline"):
                with self.subTest(url=url, cell_type=cell_type):
                    link = {"type": "link", "text": text, "url": url}
                    cell = (
                        link
                        if cell_type == "link"
                        else {"type": "multiline", "lines": [link]}
                    )
                    document, warnings = generate.build_index(
                        {"columns": columns, "rows": [dict.fromkeys(columns, cell)]}
                    )
                    self.assertEqual([], warnings)
                    cells = re.findall(r"<td\b.*?</td>", document, re.DOTALL)
                    self.assertEqual(3, len(cells))
                    self.assertEqual([cells[0]] * 3, cells)
                    anchor = (
                        f'<a href="{escaped_url}" target="_blank" '
                        f'rel="noopener noreferrer">{escaped_text}</a>'
                    )
                    for rendered in cells:
                        self.assertEqual(1, rendered.count(anchor))
                        self.assertIn(f'data-filter-value="{escaped_text}"', rendered)
                        self.assertIn(f'data-filter-label="{escaped_text}"', rendered)
                        if cell_type == "multiline":
                            self.assertIn(
                                '<div class="multiline-line multiline-link-line">'
                                f"{anchor}</div>",
                                rendered,
                            )

    def test_standalone_invalid_urls_fall_back_in_every_column(self) -> None:
        columns = ["first", "middle", "last"]
        for url in (
            "file://host/path/index.html",
            "file:/Users/test/index.html",
            "javascript:alert(1)",
            "data:text/html,<b>unsafe</b>",
            "ftp://example.com/",
            "./relative.html",
        ):
            with self.subTest(url=url):
                cell = {"type": "link", "text": "<unsafe>&", "url": url}
                document, warnings = generate.build_index(
                    {"columns": columns, "rows": [dict.fromkeys(columns, cell)]}
                )
                self.assertEqual(3, len(warnings))
                cells = re.findall(r"<td\b.*?</td>", document, re.DOTALL)
                self.assertEqual(3, len(cells))
                for column, rendered, warning in zip(columns, cells, warnings):
                    self.assertIn(f"{column}列", warning)
                    self.assertIn("未対応の形式", warning)
                    self.assertNotIn("<a ", rendered)
                    self.assertIn('data-filter-value="&lt;unsafe&gt;&amp;"', rendered)
                    self.assertIn("&lt;unsafe&gt;&amp;</td>", rendered)

    def test_menu_still_rejects_file_and_other_unsupported_schemes(self) -> None:
        for url in (
            "file:///Users/test/index.html",
            "file://host/path/index.html",
            "file:/Users/test/index.html",
            "javascript:alert(1)",
            "data:text/html,<b>unsafe</b>",
            "ftp://example.com/",
        ):
            with self.subTest(url=url):
                menu, warnings = generate.build_menu(
                    {"items": [{"type": "link", "text": "<unsafe>&", "url": url}]}
                )
                self.assertEqual(1, len(warnings))
                self.assertIn("未対応の形式", warnings[0])
                self.assertNotIn("<a ", menu)
                self.assertIn("&lt;unsafe&gt;&amp;", menu)

    def test_multiline_links_are_identical_in_every_column(self) -> None:
        columns = ["first", "middle", "last"]
        cell = {
            "type": "multiline",
            "lines": [
                "説明",
                "",
                {"type": "link", "text": "リンク", "url": "https://example.com/"},
                "",
            ],
        }
        document, warnings = generate.build_index(
            {"columns": columns, "rows": [dict.fromkeys(columns, cell)]}
        )
        self.assertEqual([], warnings)
        cells = re.findall(r"<td\b.*?</td>", document, re.DOTALL)
        self.assertEqual(3, len(cells))
        self.assertEqual([cells[0]] * 3, cells)
        for rendered in cells:
            self.assertIn('class="multiline-cell"', rendered)
            self.assertEqual(2, rendered.count("multiline-empty-line"))
            self.assertIn('data-filter-value="説明 / リンク"', rendered)
            self.assertIn('data-filter-label="説明 / リンク"', rendered)
            self.assertIn(
                '<div class="multiline-line multiline-link-line">'
                '<a href="https://example.com/" target="_blank" '
                'rel="noopener noreferrer">リンク</a></div>',
                rendered,
            )

    def test_multiline_links_escape_text_and_urls_in_every_column(self) -> None:
        for column in ("first", "middle", "last"):
            with self.subTest(column=column):
                document, warnings = generate.build_index(
                    {
                        "columns": ["first", "middle", "last"],
                        "rows": [
                            {
                                column: {
                                    "type": "multiline",
                                    "lines": [
                                        {
                                            "type": "link",
                                            "text": '<b>&"link"</b>',
                                            "url": 'https://example.com/?a=1&b="<value>"',
                                        }
                                    ],
                                }
                            }
                        ],
                    }
                )
                self.assertEqual([], warnings)
                self.assertIn(
                    '<a href="https://example.com/?a=1&amp;b=&quot;&lt;value&gt;&quot;" '
                    'target="_blank" rel="noopener noreferrer">'
                    "&lt;b&gt;&amp;&quot;link&quot;&lt;/b&gt;</a>",
                    document,
                )
                self.assertNotIn("<b>", document)
                self.assertIn(
                    'data-filter-value="&lt;b&gt;&amp;&quot;link&quot;&lt;/b&gt;"',
                    document,
                )
                self.assertIn(
                    'data-filter-label="&lt;b&gt;&amp;&quot;link&quot;&lt;/b&gt;"',
                    document,
                )

    def test_multiline_invalid_urls_fall_back_in_every_column(self) -> None:
        for column in ("first", "middle", "last"):
            for url, warning in (
                ("file://host/path/index.html", "未対応の形式"),
                ("file:/Users/test/index.html", "未対応の形式"),
                ("javascript:alert(1)", "未対応の形式"),
                ("data:text/html,<b>unsafe</b>", "未対応の形式"),
                ("ftp://example.com/", "未対応の形式"),
                ("./relative.html", "未対応の形式"),
                ("", "URLが空"),
                (None, "urlが文字列ではない"),
            ):
                with self.subTest(column=column, url=url):
                    document, warnings = generate.build_index(
                        {
                            "columns": ["first", "middle", "last"],
                            "rows": [
                                {
                                    column: {
                                        "type": "multiline",
                                        "lines": [
                                            {
                                                "type": "link",
                                                "text": "<unsafe>&",
                                                "url": url,
                                            }
                                        ],
                                    }
                                }
                            ],
                        }
                    )
                    self.assertEqual(1, len(warnings))
                    self.assertIn(f"{column}列 1番目の行", warnings[0])
                    self.assertIn(warning, warnings[0])
                    rendered = re.findall(r"<td\b.*?</td>", document, re.DOTALL)[
                        ["first", "middle", "last"].index(column)
                    ]
                    self.assertNotIn("<a ", rendered)
                    self.assertNotIn("multiline-link-line", rendered)
                    self.assertIn(
                        '<div class="multiline-line">&lt;unsafe&gt;&amp;</div>',
                        rendered,
                    )
                    self.assertIn('data-filter-value="&lt;unsafe&gt;&amp;"', rendered)
                    self.assertIn('data-filter-label="&lt;unsafe&gt;&amp;"', rendered)

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
