from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

import batch_generate as batch  # noqa: E402
import generate  # noqa: E402
import page_settings  # noqa: E402


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".batch-test-", dir=PROJECT.parent
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "00"
        self.root.mkdir()

    def page(self, relative, **extra):
        directory = self.root / relative
        directory.mkdir(parents=True, exist_ok=True)
        data = {"columns": ["A", "B"], "rows": [{"A": "one", "B": "two"}], **extra}
        (directory / "table.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
        return directory

    def config(self, directory, data):
        (directory / "json2html.config.json").write_text(
            json.dumps(data), encoding="utf-8"
        )

    def menu(self, directory):
        return json.loads((directory / "menu.json").read_text())["items"]

    def warning_page(self, relative, **extra):
        return self.page(
            relative,
            rows=[{"A": "one", "B": [], "unknown": "ignored"}],
            **extra,
        )

    def breadcrumbs(self, directory):
        document = (directory / "index.html").read_text()
        match = re.search(
            r'<nav class="breadcrumbs" aria-label="パンくず"><ol>(.*?)</ol></nav>',
            document,
        )
        self.assertIsNotNone(match)
        self.assertLess(match.start(), document.index("<h1>"))
        self.assertEqual(1, match.group(1).count('aria-current="page"'))
        return match.group(1)

    def test_breadcrumbs_three_levels_and_root_current(self):
        root = self.page("", title="最上位")
        parent = self.page("parent", title="親ページ")
        child = self.page("parent/child", title="現在ページ")
        batch.generate_tree(self.root)
        self.assertEqual('<li aria-current="page">最上位</li>', self.breadcrumbs(root))
        self.assertEqual(
            '<li><a href="../index.html">最上位</a></li>'
            '<li aria-current="page">親ページ</li>',
            self.breadcrumbs(parent),
        )
        self.assertEqual(
            '<li><a href="../../index.html">最上位</a></li>'
            '<li><a href="../index.html">親ページ</a></li>'
            '<li aria-current="page">現在ページ</li>',
            self.breadcrumbs(child),
        )

    def test_breadcrumbs_keep_missing_ancestors_including_root(self):
        child = self.page("missing/child", title="子")
        batch.generate_tree(self.root)
        self.assertEqual(
            '<li>00</li><li>missing</li><li aria-current="page">子</li>',
            self.breadcrumbs(child),
        )
        self.page("", title="ROOT")
        batch.generate_tree(self.root)
        self.assertEqual(
            '<li><a href="../../index.html">ROOT</a></li>'
            '<li>missing</li><li aria-current="page">子</li>',
            self.breadcrumbs(child),
        )

    def test_breadcrumbs_never_link_above_generation_root(self):
        self.page("", title="outside")
        subtree = self.page("parent", title="限定ROOT")
        child = self.page("parent/child", title="子")
        batch.generate_tree(subtree)
        self.assertEqual(
            '<li aria-current="page">限定ROOT</li>', self.breadcrumbs(subtree)
        )
        self.assertEqual(
            '<li><a href="../index.html">限定ROOT</a></li>'
            '<li aria-current="page">子</li>',
            self.breadcrumbs(child),
        )

    def test_breadcrumbs_encode_urls_and_escape_resolved_titles(self):
        self.page("", title='<ROOT & "title">')
        self.page("日本語 # %", title="")
        self.page("日本語 # %/親", title="<親>")
        child = self.page("日本語 # %/親/child", title="<子>")
        hidden = self.page(".hidden/child")
        (self.root / "linked").symlink_to(child.parent, target_is_directory=True)
        results = batch.generate_tree(self.root)
        self.assertEqual(4, len(results))
        self.assertFalse((hidden / "index.html").exists())
        self.assertEqual(
            '<li><a href="../../../index.html">&lt;ROOT &amp; &quot;title&quot;&gt;</a></li>'
            '<li><a href="../../index.html">日本語 # %</a></li>'
            '<li><a href="../index.html">&lt;親&gt;</a></li>'
            '<li aria-current="page">&lt;子&gt;</li>',
            self.breadcrumbs(child),
        )
        # Ancestor links are relative ../ paths even when directory names need encoding.
        self.assertNotIn("%2523", self.breadcrumbs(child))

    def test_breadcrumbs_remove_failed_ancestor_link_after_publish_retry(self):
        self.page("", title="ROOT")
        parent = self.page("parent", title="失敗する親")
        child = self.page("parent/child", title="子")
        batch.generate_tree(self.root)
        old_parent = (parent / "index.html").read_bytes()
        self.page("parent", title="更新失敗")
        publish = batch.publish

        def fail_parent(documents):
            if next(iter(documents)).parent == parent:
                raise OSError("injected ancestor failure")
            return publish(documents)

        with mock.patch.object(batch, "publish", side_effect=fail_parent):
            results = {r.directory: r.status for r in batch.generate_tree(self.root)}
        self.assertEqual("ERROR", results[parent])
        self.assertEqual("OK", results[child])
        self.assertEqual(old_parent, (parent / "index.html").read_bytes())
        self.assertEqual(
            '<li><a href="../../index.html">ROOT</a></li>'
            '<li>parent</li><li aria-current="page">子</li>',
            self.breadcrumbs(child),
        )

    def test_breadcrumbs_invalid_ancestor_is_unlinked_despite_old_output(self):
        self.page("", title="ROOT")
        parent = self.page("parent", title="親")
        child = self.page("parent/child", title="子")
        batch.generate_tree(self.root)
        (parent / "table.json").write_text("{")
        batch.generate_tree(self.root)
        self.assertEqual(
            '<li><a href="../../index.html">ROOT</a></li>'
            '<li>parent</li><li aria-current="page">子</li>',
            self.breadcrumbs(child),
        )

    def test_breadcrumbs_ancestor_failure_on_retry_removes_published_link(self):
        self.page("", title="ROOT")
        parent = self.page("parent", title="親")
        child = self.page("parent/child", title="子")
        failing = self.page("zz-failing")
        publish = batch.publish
        parent_attempts = 0

        def fail_on_retry(documents):
            nonlocal parent_attempts
            directory = next(iter(documents)).parent
            if directory == failing:
                raise OSError("force another pass")
            if directory == parent:
                parent_attempts += 1
                if parent_attempts == 2:
                    self.assertIn(
                        '<a href="../index.html">親</a>', self.breadcrumbs(child)
                    )
                    raise OSError("ancestor fails during retry")
            return publish(documents)

        with mock.patch.object(batch, "publish", side_effect=fail_on_retry):
            results = {r.directory: r.status for r in batch.generate_tree(self.root)}
        self.assertEqual(2, parent_attempts)
        self.assertEqual("ERROR", results[parent])
        self.assertEqual("ERROR", results[failing])
        self.assertEqual("OK", results[child])
        self.assertEqual(
            '<li><a href="../../index.html">ROOT</a></li>'
            '<li>parent</li><li aria-current="page">子</li>',
            self.breadcrumbs(child),
        )

    def test_show_warnings_defaults_to_true(self):
        self.assertIs(True, page_settings.defaults()["show_warnings"])
        directory = self.warning_page("")
        result = batch.generate_tree(self.root)[0]
        self.assertEqual("OK", result.status)
        self.assertEqual("警告 2件", result.detail)
        html = (directory / "index.html").read_text()
        self.assertIn('<section class="data-messages">', html)
        self.assertIn("table.json読み込み時の警告", html)

    def test_show_warnings_inherits_and_table_and_nested_config_override(self):
        expected = {
            "": False,
            "inherited": False,
            "table-override": True,
            "nested": True,
            "nested/child": True,
        }
        for relative in expected:
            extra = {"show_warnings": True} if relative == "table-override" else {}
            self.warning_page(relative, **extra)
        self.config(self.root, {"show_warnings": False})
        self.config(self.root / "nested", {"show_warnings": True})
        results = {r.directory: r for r in batch.generate_tree(self.root)}
        self.assertEqual(len(expected), len(results))
        for relative, visible in expected.items():
            with self.subTest(relative=relative):
                directory = self.root / relative
                self.assertEqual("OK", results[directory].status)
                self.assertEqual("警告 2件", results[directory].detail)
                html = (directory / "index.html").read_text()
                self.assertEqual(visible, '<section class="data-messages">' in html)
                self.assertEqual(visible, "table.json読み込み時の警告" in html)
                self.assertEqual(visible, "未定義の列" in html)
                self.assertEqual(visible, "セル形式が不正" in html)

    def test_show_warnings_null_and_empty_inherit(self):
        for inherited in (False, True):
            for blank in (None, ""):
                with self.subTest(inherited=inherited, blank=blank):
                    self.config(self.root, {"show_warnings": inherited})
                    directory = self.warning_page("child", show_warnings=blank)
                    self.config(directory, {"show_warnings": blank})
                    settings = page_settings.resolve_settings(
                        {"show_warnings": blank}, directory, self.root, PROJECT
                    )
                    self.assertIs(inherited, settings["show_warnings"])
                    result = batch.generate_tree(self.root)[0]
                    self.assertIn(result.status, ("OK", "SKIP"))
                    self.assertEqual("警告 2件", result.detail)
                    html = (directory / "index.html").read_text()
                    self.assertEqual(
                        inherited, '<section class="data-messages">' in html
                    )

    def test_enabling_show_warnings_regenerates_once_then_skips(self):
        directory = self.warning_page("child")
        self.config(self.root, {"show_warnings": False})
        first = batch.generate_tree(self.root)[0]
        self.assertEqual("OK", first.status)
        self.assertEqual("警告 2件", first.detail)
        hidden_html = (directory / "index.html").read_bytes()
        skipped = batch.generate_tree(self.root)[0]
        self.assertEqual("SKIP", skipped.status)
        self.assertEqual("警告 2件", skipped.detail)

        self.config(self.root, {"show_warnings": True})
        regenerated = batch.generate_tree(self.root)[0]
        self.assertEqual("OK", regenerated.status)
        self.assertEqual("警告 2件", regenerated.detail)
        self.assertNotEqual(hidden_html, (directory / "index.html").read_bytes())
        self.assertIn(
            "table.json読み込み時の警告", (directory / "index.html").read_text()
        )
        outputs = [
            directory / name for name in ("index.html", "menu.html", "menu.json")
        ]
        before = {
            path: (path.read_bytes(), path.stat().st_mtime_ns) for path in outputs
        }
        skipped = batch.generate_tree(self.root)[0]
        self.assertEqual("SKIP", skipped.status)
        self.assertEqual("警告 2件", skipped.detail)
        self.assertEqual(
            before,
            {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in outputs},
        )

    def test_invalid_show_warnings_preserves_outputs(self):
        directory = self.warning_page("")
        self.assertEqual("OK", batch.generate_tree(self.root)[0].status)
        outputs = [
            directory / name for name in ("index.html", "menu.html", "menu.json")
        ]
        before = {
            path: (path.read_bytes(), path.stat().st_mtime_ns) for path in outputs
        }
        for source in ("table", "config"):
            for value in (
                "false",
                "true",
                0,
                1,
                0.0,
                1.5,
                {},
                {"value": False},
                [],
                [False],
            ):
                with self.subTest(source=source, value=value):
                    self.config(self.root, {})
                    self.warning_page("")
                    if source == "table":
                        self.warning_page("", show_warnings=value)
                    else:
                        self.config(self.root, {"show_warnings": value})
                    result = batch.generate_tree(self.root)[0]
                    self.assertEqual("ERROR", result.status)
                    self.assertIn("show_warnings", result.detail)
                    self.assertEqual(
                        before,
                        {
                            path: (path.read_bytes(), path.stat().st_mtime_ns)
                            for path in outputs
                        },
                    )

    def test_hidden_warnings_do_not_suppress_fatal_structure_errors(self):
        self.config(self.root, {"show_warnings": False})
        for extra in ({"columns": []}, {"rows": {}}, {"rows": ["invalid row"]}):
            with self.subTest(extra=extra):
                self.page("", show_warnings=False, **extra)
                result = batch.generate_tree(self.root)[0]
                self.assertEqual("ERROR", result.status)
                self.assertIn("table.json", result.detail)
                for name in ("index.html", "menu.html", "menu.json"):
                    self.assertFalse((self.root / name).exists())

    def test_exact_requested_neighbours_and_order(self):
        paths = ["", "001", "002", "002/0021", "002/0022", "003", "003/0031"]
        for path in paths:
            self.page(path, title=Path(path).name if path else "00")
        results = batch.generate_tree(self.root)
        self.assertEqual(["OK"] * 7, [r.status for r in results])
        expected = {
            "": ["001", "002", "003"],
            "001": ["00", "002", "003"],
            "002": ["00", "001", "003", "0021", "0022"],
            "002/0021": ["002", "0022"],
            "002/0022": ["002", "0021"],
            "003": ["00", "001", "002", "0031"],
            "003/0031": ["003"],
        }
        expected_relations = {
            "": ["child", "child", "child"],
            "001": ["parent", "sibling", "sibling"],
            "002": ["parent", "sibling", "sibling", "child", "child"],
            "002/0021": ["parent", "sibling"],
            "002/0022": ["parent", "sibling"],
            "003": ["parent", "sibling", "sibling", "child"],
            "003/0031": ["parent"],
        }
        for path, labels in expected.items():
            with self.subTest(path=path):
                self.assertEqual(
                    labels, [i["text"] for i in self.menu(self.root / path)]
                )
                self.assertEqual(
                    expected_relations[path],
                    [i["relation"] for i in self.menu(self.root / path)],
                )
                self.assertEqual(
                    expected_relations[path],
                    re.findall(
                        r'<li class="menu-item menu-relation-(parent|sibling|child)">',
                        (self.root / path / "menu.html").read_text(),
                    ),
                )
        self.assertEqual(
            [
                "../index.html",
                "../001/index.html",
                "../003/index.html",
                "0021/index.html",
                "0022/index.html",
            ],
            [i["url"] for i in self.menu(self.root / "002")],
        )

    def test_skip_and_dependency_updates_and_missing_output(self):
        parent = self.page("", title="root")
        child = self.page("001", title="before")
        self.assertTrue(all(r.status == "OK" for r in batch.generate_tree(self.root)))
        files = list(self.root.rglob("*.html")) + list(self.root.rglob("menu.json"))
        before = {path: path.stat().st_mtime_ns for path in files}
        self.assertTrue(all(r.status == "SKIP" for r in batch.generate_tree(self.root)))
        self.assertEqual(before, {path: path.stat().st_mtime_ns for path in files})
        self.page("001", title="after")
        self.assertTrue(all(r.status == "OK" for r in batch.generate_tree(self.root)))
        self.assertEqual("after", self.menu(parent)[0]["text"])
        (child / "menu.html").unlink()
        results = {r.directory: r.status for r in batch.generate_tree(self.root)}
        self.assertEqual("OK", results[child])
        (child / "table.json").unlink()
        batch.generate_tree(self.root)
        self.assertEqual([], self.menu(parent))

    def test_settings_inherit_from_declaration_location_and_override(self):
        self.page("", title="root")
        child = self.page(
            "001",
            title="<child>",
            assets={"css": "", "js": None},
            alignment={"header": "", "body": "right"},
            column_options={
                "A": {"label": "名前", "visible": False},
                "B": {"align": "left", "visible": False},
            },
        )
        (self.root / "shared").mkdir()
        css = self.root / "shared" / "style.css"
        css.write_text("body {}")
        self.config(
            self.root,
            {
                "assets": {"css": "./shared/style.css"},
                "alignment": {"header": "center", "body": "left"},
            },
        )
        self.assertTrue(all(r.status == "OK" for r in batch.generate_tree(self.root)))
        html = (child / "index.html").read_text()
        self.assertIn('href="../shared/style.css"', html)
        self.assertIn('href="../shared/style.css"', (child / "menu.html").read_text())
        self.assertIn("<title>&lt;child&gt;</title>", html)
        self.assertIn('data-column-label="名前" data-initial-visible="true"', html)
        self.assertIn('data-column-label="B" data-initial-visible="false"', html)
        self.assertIn('<td style="text-align: right"', html)
        self.assertIn('<td style="text-align: left"', html)
        self.assertIn("text-align: center", html)

    def test_blank_new_settings_are_optional(self):
        self.page(
            "",
            title="",
            assets="",
            alignment=None,
            column_options="",
            hidden_column_filter=None,
        )
        result = batch.generate_tree(self.root)
        self.assertEqual("OK", result[0].status)
        self.assertIn("<title>00</title>", (self.root / "index.html").read_text())

    def test_invalid_page_preserves_outputs_and_other_pages_continue(self):
        self.page("", title="root")
        child = self.page("001", title="child")
        batch.generate_tree(self.root)
        original = {
            path: path.read_bytes()
            for path in child.iterdir()
            if path.name != "table.json"
        }
        (child / "table.json").write_text("{")
        results = batch.generate_tree(self.root)
        self.assertEqual(["OK", "ERROR"], [r.status for r in results])
        self.assertEqual([], self.menu(self.root))
        self.assertEqual(original, {path: path.read_bytes() for path in original})

    def test_publish_failure_restores_all_three_outputs(self):
        self.page("", title="before")
        batch.generate_tree(self.root)
        outputs = [
            self.root / name for name in ("index.html", "menu.html", "menu.json")
        ]
        original = {path: path.read_bytes() for path in outputs}
        self.page("", title="after")
        replace = os.replace

        def fail(source, destination):
            if Path(destination).name == "index.html" and str(source).endswith(".tmp"):
                raise OSError("injected third write failure")
            return replace(source, destination)

        with mock.patch.object(generate.os, "replace", side_effect=fail):
            result = batch.generate_tree(self.root)
        self.assertEqual("ERROR", result[0].status)
        self.assertEqual(original, {path: path.read_bytes() for path in outputs})
        self.assertEqual([], list(self.root.glob(".*.tmp")))
        self.assertEqual([], list(self.root.glob(".*.backup")))

    def test_failed_new_page_is_removed_from_successful_neighbour_menus(self):
        self.page("", title="root")
        child = self.page("001", title="cannot write")
        other = self.page("002", title="can write")
        publish = batch.publish

        def fail_child(documents):
            if next(iter(documents)).parent == child:
                raise OSError("injected unwritable child")
            return publish(documents)

        with mock.patch.object(batch, "publish", side_effect=fail_child):
            results = batch.generate_tree(self.root)
        self.assertEqual(["OK", "ERROR", "OK"], [result.status for result in results])
        self.assertEqual(["can write"], [item["text"] for item in self.menu(self.root)])
        self.assertEqual(["root"], [item["text"] for item in self.menu(other)])
        self.assertFalse((child / "index.html").exists())

    def test_encoded_links_and_excluded_symlinks_and_hidden_directories(self):
        self.page("")
        child = self.page("日本語 # %", title='"<name>"')
        self.page(".hidden")
        (self.root / "linked").symlink_to(child, target_is_directory=True)
        batch.generate_tree(self.root)
        items = self.menu(self.root)
        self.assertEqual(1, len(items))
        self.assertIn("%23", items[0]["url"])
        self.assertIn("%25", items[0]["url"])
        self.assertIn("&lt;name&gt;", (self.root / "menu.html").read_text())

    def test_no_promotion_over_missing_table_and_root_boundary(self):
        self.page("")
        grandchild = self.page("missing/child")
        batch.generate_tree(self.root)
        self.assertEqual([], self.menu(self.root))
        self.assertEqual([], self.menu(grandchild))
        batch.generate_tree(grandchild)
        self.assertEqual([], self.menu(grandchild))

    def test_missing_asset_and_invalid_setting_report_errors(self):
        for extra in (
            {"assets": {"css": "missing.css"}},
            {"alignment": {"body": "bad"}},
            {"title": 3},
        ):
            with self.subTest(extra=extra):
                self.page("", **extra)
                self.assertEqual("ERROR", batch.generate_tree(self.root)[0].status)
                self.assertFalse((self.root / "index.html").exists())

    def test_cli_defaults_to_cwd_and_returns_failure_for_invalid_page(self):
        self.page("")
        command = [sys.executable, str(PROJECT / "generate.py")]
        result = subprocess.run(command, cwd=self.root, text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("生成 1 / スキップ 0 / エラー 0", result.stdout)
        (self.root / "table.json").write_text("{")
        result = subprocess.run(command, cwd=self.root, text=True, capture_output=True)
        self.assertEqual(1, result.returncode)
        self.assertIn("エラー 1", result.stdout)


if __name__ == "__main__":
    unittest.main()
