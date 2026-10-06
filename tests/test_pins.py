"""Pin-page contract tests through the public batch entry point.

All input/output fixtures live in temporary directories under test_dir; the
checked-in sample pages are never generated or modified by this module.
"""

from __future__ import annotations

from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote, unquote, urlsplit

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

import batch_generate as batch  # noqa: E402


class Tags(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.tags = []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def attributes(self, tag):
        return [attrs for name, attrs in self.tags if name == tag]


class PinTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".pins-test-", dir=PROJECT.parent
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "root"
        self.root.mkdir()

    def page(self, relative, **extra):
        directory = self.root / relative
        directory.mkdir(parents=True, exist_ok=True)
        data = {
            "title": relative or "root",
            "columns": ["A"],
            "rows": [{"A": "value"}],
            **extra,
        }
        (directory / "table.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
        return directory

    def config(self, directory, data):
        (directory / "json2html.config.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )

    def enable(self, relative="pins"):
        self.config(self.root, {"pin_page": "./" + relative})

    def generate(self, root=None):
        return {
            result.directory: result
            for result in batch.generate_tree(root or self.root)
        }

    def assert_success(self, results, status="OK"):
        self.assertTrue(results, "generate_tree returned no results")
        self.assertEqual(
            {status},
            {result.status for result in results.values()},
            [
                (str(path), result.status, result.detail)
                for path, result in results.items()
            ],
        )

    def read(self, directory, name="index.html"):
        return (directory / name).read_text(encoding="utf-8")

    def menu(self, directory):
        return json.loads(self.read(directory, "menu.json"))["items"]

    def metadata(self, directory, name="index.html"):
        source = self.read(directory, name)
        matches = []
        # Parse each script's attributes independently of their order, spacing,
        # quote style, and any extra attributes added by the renderer.
        for match in re.finditer(
            r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script\s*>",
            source,
            flags=re.IGNORECASE | re.DOTALL,
        ):
            attrs = Tags("<script" + match["attrs"] + "></script>").attributes(
                "script"
            )[0]
            if attrs.get("id") == "json2html-pins":
                self.assertEqual("application/json", attrs.get("type"))
                matches.append(json.loads(match["body"]))
        self.assertEqual(
            1, len(matches), f"Expected one pins metadata script in {directory / name}"
        )
        return matches[0]

    def page_id(self, directory, scope=None):
        return quote(
            (directory / "index.html").relative_to(scope or self.root).as_posix(),
            safe="/-._~",
        )

    def relative_url(self, target, directory):
        return quote(Path(os.path.relpath(target, directory)).as_posix(), safe="/-._~")

    def link_targets(self, directory):
        return [
            attrs["href"]
            for attrs in Tags(self.read(directory, "menu.html")).attributes("a")
            if "href" in attrs
        ]

    def snapshot(self, root=None):
        root = root or self.root
        paths = set(root.rglob("*.html")) | set(root.rglob("menu.json"))
        return {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths}

    def assert_catalog(self, metadata, expected, scope=None):
        entries = metadata["entries"]
        ids = [entry["id"] for entry in entries]
        self.assertEqual(len(ids), len(set(ids)), "Catalog IDs must be unique")
        self.assertEqual({self.page_id(path, scope) for path in expected}, set(ids))
        for entry in entries:
            self.assertTrue({"id", "title", "url"}.issubset(entry))
            self.assertIsInstance(entry["title"], str)
            self.assertIsInstance(entry["url"], str)
            parsed = urlsplit(entry["url"])
            self.assertFalse(
                parsed.scheme or parsed.netloc or parsed.query or parsed.fragment
            )
            self.assertFalse(parsed.path.startswith("/"))

    def assert_pin_asset(self, directory, name):
        scripts = Tags(self.read(directory, name)).attributes("script")
        sources = [attrs["src"] for attrs in scripts if "src" in attrs]
        pins = [
            src
            for src in sources
            if unquote(urlsplit(src).path).endswith("/page-pins.js")
            or src == "page-pins.js"
        ]
        self.assertEqual(
            1, len(pins), f"Missing or duplicated page-pins.js in {directory / name}"
        )
        self.assertEqual(
            self.relative_url(PROJECT / "js/page-pins.js", directory), pins[0]
        )

    def test_status_is_initially_empty_and_hidden_for_page_and_hub_menu(self):
        root = self.page("")
        hub = self.page("pins")
        self.enable()
        self.assert_success(self.generate())
        for directory, name, tag in (
            (root, "index.html", "span"),
            (hub, "index.html", "span"),
            (hub, "menu.html", "p"),
        ):
            with self.subTest(directory=directory, name=name):
                source = self.read(directory, name)
                statuses = [
                    attrs
                    for attrs in Tags(source).attributes(tag)
                    if attrs.get("id") == "page-pin-status"
                ]
                self.assertEqual(1, len(statuses))
                self.assertIn("hidden", statuses[0])
                self.assertEqual("status", statuses[0]["role"])
                self.assertRegex(
                    source, rf'<{tag}\b[^>]*id="page-pin-status"[^>]*></{tag}>'
                )

    def test_hub_and_normal_pages_have_pin_controls_and_registered_current_ids(self):
        root = self.page("")
        hub = self.page("pins", title="ピン専用")
        self.enable()
        self.assert_success(self.generate())
        self.assert_scope(root, hub, [root, hub])
        for directory in (root, hub):
            with self.subTest(directory=directory):
                source = self.read(directory)
                buttons = Tags(source).attributes("button")
                pin_buttons = [b for b in buttons if b.get("id") == "page-pin-toggle"]
                self.assertEqual(1, len(pin_buttons))
                self.assertEqual("false", pin_buttons[0]["aria-pressed"])
                self.assertIn("disabled", pin_buttons[0])
                self.assertRegex(
                    source,
                    r'id="table-filter-clear">[^<]*</button>\s*'
                    r'<button\b[^>]*id="page-pin-toggle"',
                )
                data = self.metadata(directory)
                current = [e for e in data["entries"] if e["id"] == data["current_id"]]
                self.assertEqual(1, len(current))
                self.assertEqual("index.html", current[0]["url"])
                self.assertIn(self.page_id(hub), data["exclude_ids"])
        store_entries = self.metadata(hub, "pin-state.html")["entries"]
        self.assertIn({"id": "pins/index.html", "title": "ピン専用"}, store_entries)
        self.assertEqual(["../index.html"], self.link_targets(hub))

    def test_absent_null_and_empty_root_setting_leave_defaults_unchanged(self):
        root = self.page("")
        child = self.page("child")
        self.assert_success(self.generate())
        original = self.snapshot()
        for data in ({}, {"pin_page": None}, {"pin_page": ""}):
            with self.subTest(data=data):
                self.config(root, data)
                self.assert_success(self.generate(), "SKIP")
                self.assertEqual(original, self.snapshot())
                self.assertEqual(
                    ["child/index.html"], [item["url"] for item in self.menu(root)]
                )
                self.assertEqual(
                    ["../index.html"], [item["url"] for item in self.menu(child)]
                )
                for directory in (root, child):
                    for name in ("index.html", "menu.html"):
                        self.assertNotIn("json2html-pins", self.read(directory, name))
                        self.assertNotIn("page-pins.js", self.read(directory, name))
                        self.assertNotIn("page-pin-toggle", self.read(directory, name))
                self.assertEqual([], list(self.root.rglob("pin-state.html")))

    def test_child_config_enables_pins_but_table_pin_page_is_ignored(self):
        root = self.page("", pin_page="./pins")
        ignored_hub = self.page("pins")
        child = self.page("child", pin_page={"invalid": True})
        hub = self.page("child/pins", pin_page=False)
        leaf = self.page("child/leaf", pin_page="./not-real")
        self.config(child, {"pin_page": "./pins"})
        self.assert_success(self.generate())
        self.assertEqual(
            [hub / "pin-state.html"], list(self.root.rglob("pin-state.html"))
        )
        for directory in (root, ignored_hub):
            for name in ("index.html", "menu.html"):
                self.assertNotIn("json2html-pins", self.read(directory, name))
                self.assertNotIn("page-pins.js", self.read(directory, name))
        for directory in (child, hub, leaf):
            metadata = self.metadata(directory)
            self.assertIs(metadata["hub"], directory == hub)
            self.assertEqual(self.page_id(directory, child), metadata["current_id"])
            self.assert_catalog(metadata, [child, hub, leaf], child)
            self.assertEqual(
                self.relative_url(hub / "pin-state.html", directory),
                metadata["store_url"],
            )

    def test_absent_null_and_empty_child_settings_inherit_scope_ignoring_table_values(
        self,
    ):
        root = self.page("", pin_page="./not-real")
        hub = self.page("pins", pin_page=False)
        children = []
        for name, config in (
            ("absent", {}),
            ("null", {"pin_page": None}),
            ("empty", {"pin_page": ""}),
        ):
            child = self.page(name, pin_page="https://example.invalid")
            self.config(child, config)
            children.extend((child, self.page(name + "/deep", pin_page=[])))
        self.config(hub, {"pin_page": None})
        self.enable()
        self.assert_success(self.generate())
        for directory in (root, *children, hub):
            metadata = self.metadata(directory)
            self.assertIs(metadata["hub"], directory == hub)
            self.assertEqual(self.page_id(directory), metadata["current_id"])
            self.assert_catalog(metadata, [root, hub, *children])
            self.assertEqual(
                self.relative_url(hub / "pin-state.html", directory),
                metadata["store_url"],
            )

    def test_normal_menus_start_with_unique_hub_and_never_link_self(self):
        pages = [
            self.page(path)
            for path in ("", "pins", "pins/child", "other", "other/deep")
        ]
        hub = self.root / "pins"
        self.enable()
        self.assert_success(self.generate())
        expected_relations = {
            ".": ["parent", "child"],
            "pins/child": ["parent"],
            "other": ["parent", "parent", "child"],
            "other/deep": ["parent", "parent"],
        }
        for directory in pages:
            if directory == hub:
                continue
            with self.subTest(directory=directory):
                urls = [item["url"] for item in self.menu(directory)]
                hub_url = self.relative_url(hub / "index.html", directory)
                self.assertEqual(hub_url, urls[0])
                self.assertEqual(1, urls.count(hub_url))
                self.assertEqual(len(urls), len(set(urls)))
                self.assertEqual(urls, self.link_targets(directory))
                relations = expected_relations[
                    directory.relative_to(self.root).as_posix()
                ]
                self.assertEqual(
                    relations, [i["relation"] for i in self.menu(directory)]
                )
                self.assertEqual(
                    [f"menu-item menu-relation-{r}" for r in relations],
                    [
                        a["class"]
                        for a in Tags(self.read(directory, "menu.html")).attributes(
                            "li"
                        )
                    ],
                )
                for url in urls:
                    self.assertNotEqual(
                        directory / "index.html", (directory / unquote(url)).resolve()
                    )

    def assert_scope(self, scope, hub, pages):
        for directory in pages:
            for name in ("index.html", "menu.html"):
                data = self.metadata(directory, name)
                self.assert_catalog(data, pages, scope)
                self.assertEqual(self.page_id(directory, scope), data["current_id"])
                self.assertIs(data["hub"], directory == hub)
                self.assertEqual(
                    self.relative_url(hub / "pin-state.html", directory),
                    data["store_url"],
                )
                for entry in data["entries"]:
                    self.assertEqual(
                        self.relative_url(scope / unquote(entry["id"]), directory),
                        entry["url"],
                    )
        store = self.metadata(hub, "pin-state.html")
        self.assertEqual("store", store["role"])
        self.assertEqual(
            {self.page_id(directory, scope) for directory in pages},
            {entry["id"] for entry in store["entries"]},
        )

    def test_parent_and_direct_generation_keep_scope_metadata_and_hub_hint_bytes(self):
        self.page("")
        self.page("unscoped")
        for with_table in (False, True):
            with self.subTest(config_directory_has_table=with_table):
                name = "with-table" if with_table else "config-only"
                scope = self.root / name
                hub = self.page(name + "/pins")
                child = self.page(name + "/日本語 # %/leaf")
                pages = [hub, child]
                if with_table:
                    pages.append(self.page(name))
                self.config(scope, {"pin_page": "./pins"})
                hints = (
                    ' {\n  "items": ['
                    + json.dumps(
                        {
                            "type": "link",
                            "text": "手動順序",
                            "url": self.relative_url(child / "index.html", hub),
                        },
                        ensure_ascii=False,
                    )
                    + "]\n }\n\n"
                ).encode("utf-8")
                hint_path = hub / "menu.json"
                hint_path.write_bytes(hints)
                hint_mtime = hint_path.stat().st_mtime_ns
                self.assert_success(self.generate(scope))
                before = {
                    (directory, output): self.metadata(directory, output)
                    for directory in pages
                    for output in ("index.html", "menu.html")
                }
                before[(hub, "pin-state.html")] = self.metadata(hub, "pin-state.html")
                for command_root in (self.root, scope):
                    results = self.generate(command_root)
                    self.assertTrue(
                        all(r.status in {"OK", "SKIP"} for r in results.values())
                    )
                    self.assert_scope(scope, hub, pages)
                    for (directory, output), data in before.items():
                        self.assertEqual(data, self.metadata(directory, output))
                    self.assertEqual(hints, hint_path.read_bytes())
                    self.assertEqual(hint_mtime, hint_path.stat().st_mtime_ns)
                    self.assertEqual(
                        [self.page_id(child, scope)], self.metadata(hub)["order"]
                    )
                if not with_table:
                    self.assertFalse((scope / "index.html").exists())
                    self.assertEqual([], self.link_targets(hub))

    def test_independent_scopes_isolate_catalogs_but_keep_global_menu_neighbours(self):
        root = self.page("")
        plain = self.page("plain")
        scopes = []
        for name in ("left", "right"):
            scope = self.page(name)
            hub = self.page(name + "/pins")
            child = self.page(name + "/child")
            self.page(name + "/pins/deep")
            self.config(scope, {"pin_page": "./pins"})
            scopes.append((scope, hub, child))
        self.assert_success(self.generate())
        for scope, hub, child in scopes:
            self.assert_scope(scope, hub, [scope, hub, child, hub / "deep"])
            other = next(item[0] for item in scopes if item[0] != scope)
            self.assertEqual(
                [
                    self.relative_url(target / "index.html", scope)
                    for target in (hub, root, *sorted((other, plain)), child)
                ],
                [item["url"] for item in self.menu(scope)],
            )
            self.assertEqual(["../index.html"], self.link_targets(hub))
            self.assertIn('id="pin-list"', self.read(hub, "menu.html"))
        self.assertEqual(
            ["left/index.html", "plain/index.html", "right/index.html"],
            self.link_targets(root),
        )
        self.assertEqual(
            ["../index.html", "../left/index.html", "../right/index.html"],
            self.link_targets(plain),
        )
        for directory in (root, plain):
            self.assertNotIn("json2html-pins", self.read(directory))

    def test_parent_display_settings_still_inherit_from_command_root(self):
        scope = self.page("scope")
        hub = self.page("scope/pins")
        child = self.page("scope/child")
        css = self.root / "parent-style.css"
        css.write_text("/* distinct inherited stylesheet */\n", encoding="utf-8")
        self.config(
            self.root,
            {
                "assets": {
                    "css": "./parent-style.css",
                    "js": os.path.relpath(PROJECT / "js", self.root),
                },
                "alignment": {"header": "right", "body": "center"},
            },
        )
        self.config(scope, {"pin_page": "./pins", "alignment": {"header": "left"}})
        self.assert_success(self.generate())
        self.assert_scope(scope, hub, [scope, hub, child])
        for directory in (scope, hub, child):
            html = self.read(directory)
            self.assertIn('<td style="text-align: center"', html)
            self.assertIn('class="th-label" style="text-align: left"', html)
            for output in ("index.html", "menu.html"):
                links = Tags(self.read(directory, output)).attributes("link")
                self.assertIn(
                    self.relative_url(css, directory), [a.get("href") for a in links]
                )
                self.assert_pin_asset(directory, output)
        pin_data = self.metadata(child)
        self.assert_success(self.generate(scope))
        self.assertEqual(pin_data, self.metadata(child))
        self.assertNotIn('<td style="text-align: center"', self.read(child))
        self.assertNotIn("parent-style.css", self.read(child))

    def test_nested_nonempty_scope_overrides_and_empty_declarations_inherit_nearest(
        self,
    ):
        root = self.page("")
        hub = self.page("pins")
        outer_child = self.page("outer-child")
        nested = self.page("nested")
        nested_hub = self.page("nested/pins")
        inherited = []
        for name, data in (
            ("absent", {}),
            ("null", {"pin_page": None}),
            ("empty", {"pin_page": ""}),
        ):
            directory = self.page("nested/" + name)
            self.config(directory, data)
            inherited.extend((directory, self.page("nested/" + name + "/deep")))
        self.enable()
        self.config(nested, {"pin_page": "./pins"})
        self.assert_success(self.generate())
        self.assert_scope(root, hub, [root, hub, outer_child])
        self.assert_scope(nested, nested_hub, [nested, nested_hub, *inherited])
        self.assertIn("nested/index.html", self.link_targets(root))
        self.assertIn("../index.html", self.link_targets(nested))
        self.assertEqual(["../index.html"], self.link_targets(nested_hub))

    def test_invalid_scope_hubs_preserve_outputs_without_blocking_neighbours(self):
        self.page("")
        bad = self.page("bad")
        bad_hub = self.page("bad/pins")
        self.page("bad/child")
        good = self.page("good")
        good_hub = self.page("good/pins")
        good_child = self.page("good/child")
        self.config(good, {"pin_page": "./pins"})
        cases = (
            "outside",
            "missing",
            "invalid-value",
            "malformed-config",
            "malformed-table",
            "invalid-table",
            "malformed-menu",
        )
        for case in cases:
            with self.subTest(case=case):
                self.config(bad, {"pin_page": "./pins"})
                self.page("bad/pins")
                (bad_hub / "menu.json").write_bytes(b'{ "items": [] }\n\n')
                self.assertTrue(
                    all(r.status in {"OK", "SKIP"} for r in self.generate().values())
                )
                if case == "outside":
                    self.config(bad, {"pin_page": "../good/pins"})
                elif case == "missing":
                    self.config(bad, {"pin_page": "./missing"})
                elif case == "invalid-value":
                    self.config(bad, {"pin_page": ["./pins"]})
                elif case == "malformed-config":
                    (bad / "json2html.config.json").write_text("{", encoding="utf-8")
                elif case == "malformed-table":
                    (bad_hub / "table.json").write_text("{", encoding="utf-8")
                elif case == "invalid-table":
                    self.page("bad/pins", columns=[])
                else:
                    (bad_hub / "menu.json").write_bytes(b"{ broken hint file\n")
                before = self.snapshot(bad)
                self.page("bad/child", title="Must not publish " + case)
                self.page("good/child", title="Updated " + case)
                results = self.generate()
                self.assertTrue(
                    any(
                        r.status == "ERROR"
                        for p, r in results.items()
                        if p == bad or bad in p.parents
                    )
                )
                self.assertEqual(before, self.snapshot(bad))
                self.assertEqual("OK", results[good_child].status)
                self.assertIn("Updated " + case, self.read(good_child))
                self.assert_scope(good, good_hub, [good, good_hub, good_child])

    def test_hub_in_overriding_scope_is_invalid_even_inside_config_subtree(self):
        self.page("")
        self.page("pins")
        self.page("child")
        nested = self.page("nested")
        nested_hub = self.page("nested/pins")
        nested_child = self.page("nested/child")
        self.enable()
        self.config(nested, {"pin_page": "./pins"})
        self.assert_success(self.generate())
        before = {
            p: value for p, value in self.snapshot().items() if nested not in p.parents
        }
        self.enable("nested/pins")
        self.page("child", title="Outer scope must remain unchanged")
        self.page("nested/child", title="Independent nested scope updated")
        results = self.generate()
        self.assertTrue(any(r.status == "ERROR" for r in results.values()))
        self.assertEqual(
            before,
            {
                p: value
                for p, value in self.snapshot().items()
                if nested not in p.parents
            },
        )
        self.assertEqual("OK", results[nested_child].status)
        self.assert_scope(nested, nested_hub, [nested, nested_hub, nested_child])

    def test_one_bridge_publish_failure_keeps_its_scope_and_other_scope_proceeds(self):
        scopes = []
        for name in ("bad", "good"):
            scope = self.page(name)
            hub = self.page(name + "/pins")
            child = self.page(name + "/child")
            self.config(scope, {"pin_page": "./pins"})
            scopes.append((scope, hub, child))
        self.assert_success(self.generate())
        bad, bad_hub, _ = scopes[0]
        good, good_hub, good_child = scopes[1]
        before = self.snapshot(bad)
        for scope, hub, child in scopes:
            self.page(scope.name + "/pins", title="Changed hub " + scope.name)
            self.page(scope.name + "/child", title="Changed child " + scope.name)
        new_client = self.page("bad/new-client")
        replace = os.replace
        failures = []

        def fail_bridge(source, destination):
            if Path(destination) == bad_hub / "pin-state.html" and str(source).endswith(
                ".tmp"
            ):
                failures.append(destination)
                raise OSError("injected scoped bridge failure")
            return replace(source, destination)

        with mock.patch("generate.os.replace", side_effect=fail_bridge):
            results = self.generate()
        self.assertTrue(failures)
        self.assertEqual("ERROR", results[bad_hub].status)
        self.assertEqual(before, self.snapshot(bad))
        self.assertEqual("OK", results[good_child].status)
        self.assertIn("Changed child good", self.read(good_child))
        self.assert_scope(good, good_hub, [good, good_hub, good_child])
        for output in ("index.html", "menu.html", "menu.json"):
            self.assertFalse((new_client / output).exists())
        self.assertEqual([], list(self.root.rglob("*.tmp")))
        self.assertEqual([], list(self.root.rglob("*.backup")))

    def test_invalid_nested_declaration_blocks_fallback_but_not_valid_scopes(self):
        root = self.page("")
        hub = self.page("pins")
        outer_child = self.page("child")
        nested = self.page("nested")
        self.page("nested/pins")
        self.page("nested/child")
        deeper = self.page("nested/independent")
        deeper_hub = self.page("nested/independent/pins")
        deeper_child = self.page("nested/independent/child")
        self.enable()
        self.config(deeper, {"pin_page": "./pins"})
        for value in (False, ["./pins"], "../pins"):
            with self.subTest(pin_page=value):
                self.config(nested, {"pin_page": "./pins"})
                self.assertTrue(
                    all(r.status in {"OK", "SKIP"} for r in self.generate().values())
                )
                before = {
                    p: state
                    for p, state in self.snapshot(nested).items()
                    if deeper not in p.parents
                }
                self.config(nested, {"pin_page": value})
                self.page("nested/child", title="Blocked " + str(value))
                self.page("child", title="Outer updated " + str(value))
                self.page(
                    "nested/independent/child", title="Deeper updated " + str(value)
                )
                results = self.generate()
                self.assertEqual("ERROR", results[nested].status)
                self.assertIn("pin_page", results[nested].detail)
                self.assertEqual(
                    before,
                    {
                        p: state
                        for p, state in self.snapshot(nested).items()
                        if deeper not in p.parents
                    },
                )
                self.assertEqual("OK", results[outer_child].status)
                self.assertEqual("OK", results[deeper_child].status)
                self.assert_scope(root, hub, [root, hub, outer_child])
                self.assert_scope(
                    deeper, deeper_hub, [deeper, deeper_hub, deeper_child]
                )
                self.assertNotIn("nested/index.html", self.link_targets(root))

    def test_conflicting_parent_hub_keeps_custom_menu_when_child_overrides_scope(self):
        self.page("")
        child = self.page("child")
        old_hub = self.page("child/old-hub")
        new_hub = self.page("child/new-hub")
        leaf = self.page("child/leaf")
        self.enable("child/old-hub")
        self.assert_success(self.generate())
        hints = b' { "items": [], "note": "old hub must remain user-owned" }\n\n'
        (old_hub / "menu.json").write_bytes(hints)
        before = self.snapshot(old_hub)
        self.config(child, {"pin_page": "./new-hub"})
        results = self.generate()
        self.assertTrue(any(r.status == "ERROR" for r in results.values()))
        self.assertEqual(before, self.snapshot(old_hub))
        self.assertEqual("OK", results[new_hub].status)
        self.assert_scope(child, new_hub, [child, new_hub, leaf])
        self.assertNotIn("old-hub/index.html", self.link_targets(child))
        self.generate()
        self.assertEqual(before, self.snapshot(old_hub))

    def test_retry_hub_failure_rolls_back_whole_scope_and_unrelated_scope_proceeds(
        self,
    ):
        scope = self.page("affected")
        hub = self.page("affected/pins")
        good = self.page("affected/a-good")
        failed = self.page("affected/z-failed")
        other = self.page("unrelated")
        other_hub = self.page("unrelated/pins")
        other_child = self.page("unrelated/child")
        self.config(scope, {"pin_page": "./pins"})
        self.config(other, {"pin_page": "./pins"})
        self.assert_success(self.generate())
        (hub / "menu.json").write_bytes(b'{ "items": [], "note": "preserve hints" }\n')
        before = self.snapshot(scope)
        self.page("affected/pins", title="First hub publication will succeed")
        self.page("affected/a-good", title="Must be rolled back after retry failure")
        self.page("affected/z-failed", title="Client publication fails")
        new_client = self.page("affected/m-new")
        self.page("unrelated/child", title="Unrelated update must survive")
        replace = os.replace
        hub_attempts = []
        client_failures = []
        good_publications = []

        def fail_retry(source, destination):
            destination = Path(destination)
            if str(source).endswith(".tmp"):
                if destination == hub / "pin-state.html":
                    hub_attempts.append(destination)
                    if len(hub_attempts) == 2:
                        raise OSError("injected retry hub failure")
                if destination == good / "index.html":
                    good_publications.append(destination)
                if destination == failed / "index.html":
                    client_failures.append(destination)
                    raise OSError("injected first-pass client failure")
            return replace(source, destination)

        with mock.patch("generate.os.replace", side_effect=fail_retry):
            results = self.generate()
        self.assertEqual(2, len(hub_attempts), "Failure must occur on hub retry")
        self.assertTrue(client_failures)
        self.assertTrue(
            good_publications, "A successful client must be rolled back too"
        )
        self.assertEqual("ERROR", results[hub].status)
        self.assertIn("injected retry hub failure", results[hub].detail)
        self.assertEqual(before, self.snapshot(scope))
        for output in ("index.html", "menu.html", "menu.json"):
            self.assertFalse((new_client / output).exists())
        self.assertEqual("OK", results[other_child].status)
        self.assertIn("Unrelated update must survive", self.read(other_child))
        self.assert_scope(other, other_hub, [other, other_hub, other_child])
        self.assertNotIn("../affected/index.html", self.link_targets(other))
        self.assertEqual([], list(self.root.rglob("*.tmp")))
        self.assertEqual([], list(self.root.rglob("*.backup")))

    def test_metadata_relative_urls_assets_encoded_ids_and_script_escaping(self):
        title = '</script><script id="injected">alert("x")</script> & 日本語'
        root = self.page("")
        parent = self.page("group")
        hub = self.page("group/pins")
        child = self.page("日本語 # %/deep & page", title=title)
        pages = [root, parent, hub, child]
        self.enable("group/pins")
        self.assert_success(self.generate())
        for directory in pages:
            for name, role in (("index.html", "page"), ("menu.html", "menu")):
                with self.subTest(directory=directory, name=name):
                    metadata = self.metadata(directory, name)
                    self.assertEqual(role, metadata["role"])
                    self.assertEqual(self.page_id(directory), metadata["current_id"])
                    self.assertIs(metadata["hub"], directory == hub)
                    self.assertEqual(
                        self.relative_url(hub / "pin-state.html", directory),
                        metadata["store_url"],
                    )
                    matching = [
                        entry
                        for entry in metadata["entries"]
                        if entry["id"] == self.page_id(child)
                    ]
                    self.assertEqual(title, matching[0]["title"])
                    for entry in metadata["entries"]:
                        target = self.root / unquote(entry["id"])
                        self.assertEqual(
                            self.relative_url(target, directory), entry["url"]
                        )
                    self.assert_pin_asset(directory, name)
                    scripts = Tags(self.read(directory, name)).attributes("script")
                    self.assertFalse(
                        any(attrs.get("id") == "injected" for attrs in scripts)
                    )
                    # The hub and its parent are pinnable but excluded from the
                    # hub's dynamic menu to avoid self/duplicate links.
                    self.assert_catalog(metadata, pages)
        self.assertIn("%23", self.metadata(child)["current_id"])
        self.assertIn("%25", self.metadata(child)["current_id"])

    def test_hub_hints_are_byte_preserved_and_only_exact_local_pages_ordered(self):
        root = self.page("")
        hub = self.page("pins")
        first = self.page("first")
        second = self.page("日本語 # %")
        failed = self.page("failed", columns=[])
        first_url = self.relative_url(first / "index.html", hub)
        second_url = self.relative_url(second / "index.html", hub)
        urls = [
            second_url,
            "https://example.invalid/first/index.html",
            "//example.invalid/first/index.html",
            "/first/index.html",
            "../first/",
            first_url + "?mode=1",
            first_url + "#section",
            "javascript:alert(1)",
            "data:text/html,hello",
            "../../outside/index.html",
            "../missing/index.html",
            "../failed/index.html",
            first_url,
            second_url,
        ]
        hints = {
            "note": "手動編集を保持",
            "items": [
                {"type": "link", "text": "manual label", "url": url} for url in urls
            ],
        }
        raw = ("  " + json.dumps(hints, ensure_ascii=False, indent=3) + "\n\n").encode(
            "utf-8"
        )
        hint_path = hub / "menu.json"
        hint_path.write_bytes(raw)
        original_mtime = hint_path.stat().st_mtime_ns
        self.enable()
        results = self.generate()
        self.assertEqual("ERROR", results[failed].status)
        self.assertEqual(raw, hint_path.read_bytes())
        self.assertEqual(original_mtime, hint_path.stat().st_mtime_ns)
        self.assertEqual(["../index.html"], self.link_targets(hub))
        self.assertNotIn("manual label", self.read(hub, "menu.html"))
        self.generate()
        self.assertEqual(raw, hint_path.read_bytes())
        self.assertEqual(original_mtime, hint_path.stat().st_mtime_ns)
        for name in ("index.html", "menu.html"):
            metadata = self.metadata(hub, name)
            self.assertEqual(
                [self.page_id(second), self.page_id(first)], metadata["order"]
            )
            self.assertEqual(
                {self.page_id(hub), self.page_id(root)}, set(metadata["exclude_ids"])
            )
            self.assert_catalog(metadata, [root, hub, first, second])

    def test_missing_hint_initialized_once_bridge_generated_and_repeat_skips(self):
        self.page("")
        hub = self.page("pins")
        self.enable()
        self.assert_success(self.generate())
        self.assertEqual({"items": []}, json.loads(self.read(hub, "menu.json")))
        bridge = hub / "pin-state.html"
        self.assertTrue(bridge.is_file())
        self.assertEqual("store", self.metadata(hub, "pin-state.html")["role"])
        self.assert_pin_asset(hub, "pin-state.html")
        self.assertEqual([], self.metadata(hub, "menu.html")["order"])
        original = self.snapshot()
        self.assert_success(self.generate(), "SKIP")
        self.assertEqual(original, self.snapshot())
        bridge.unlink()
        self.assertEqual("OK", self.generate()[hub].status)
        self.assertEqual(original[bridge][0], bridge.read_bytes())
        (hub / "menu.json").unlink()
        self.generate()
        self.assertEqual({"items": []}, json.loads(self.read(hub, "menu.json")))
        self.assert_success(self.generate(), "SKIP")

    def test_hub_menu_contains_only_immediate_parent_and_runtime_list(self):
        self.page("")
        parent = self.page("group")
        hub = self.page("group/pins")
        self.page("group/sibling")
        self.page("group/pins/child")
        self.enable("group/pins")
        self.assert_success(self.generate())
        self.assertEqual(["../index.html"], self.link_targets(hub))
        lists = Tags(self.read(hub, "menu.html")).attributes("ul")
        self.assertEqual(
            ["menu-item menu-relation-parent"],
            [a["class"] for a in Tags(self.read(hub, "menu.html")).attributes("li")],
        )
        self.assertEqual(1, sum(attrs.get("id") == "pin-list" for attrs in lists))
        metadata = self.metadata(hub, "menu.html")
        self.assertEqual(
            {self.page_id(hub), self.page_id(parent)}, set(metadata["exclude_ids"])
        )

    def test_hub_does_not_promote_grandparent_when_immediate_parent_is_missing(self):
        self.page("")
        hub = self.page("missing/pins")
        self.page("missing/sibling")
        self.page("missing/pins/child")
        self.enable("missing/pins")
        self.assert_success(self.generate())
        self.assertEqual([], self.link_targets(hub))
        self.assertEqual(
            [self.page_id(hub)], self.metadata(hub, "menu.html")["exclude_ids"]
        )

    def test_hub_does_not_link_failed_immediate_parent(self):
        self.page("")
        parent = self.page("group", columns=[])
        hub = self.page("group/pins")
        self.enable("group/pins")
        results = self.generate()
        self.assertEqual("ERROR", results[parent].status)
        self.assertEqual("OK", results[hub].status)
        self.assertEqual([], self.link_targets(hub))

    def test_invalid_root_pin_values_report_error_without_changing_outputs(self):
        self.page("")
        hub = self.page("pins")
        self.page("other")
        self.enable()
        self.assert_success(self.generate())
        original = self.snapshot()
        for value in (
            False,
            True,
            0,
            1,
            1.5,
            [],
            {},
            ["./pins"],
            {"path": "./pins"},
            "https://example.invalid/pins",
            "file:///tmp/pins",
            "//example.invalid/pins",
            str(hub),
            "../outside",
            "pins/../../outside",
            "./missing",
            "./pins/table.json",
        ):
            with self.subTest(value=value):
                self.config(self.root, {"pin_page": value})
                results = self.generate()
                errors = [
                    result for result in results.values() if result.status == "ERROR"
                ]
                self.assertTrue(
                    errors,
                    [(result.status, result.detail) for result in results.values()],
                )
                self.assertTrue(any("pin_page" in result.detail for result in errors))
                self.assertEqual(original, self.snapshot())

    def test_existing_directory_without_valid_table_is_invalid_hub(self):
        self.page("")
        self.page("pins")
        self.enable()
        self.assert_success(self.generate())
        original = self.snapshot()
        invalid = self.root / "invalid"
        invalid.mkdir()
        self.enable("invalid")
        for contents in (None, "{", '{"columns": [], "rows": []}'):
            with self.subTest(contents=contents):
                if contents is not None:
                    (invalid / "table.json").write_text(contents, encoding="utf-8")
                self.assertIn(
                    "ERROR", [result.status for result in self.generate().values()]
                )
                self.assertEqual(original, self.snapshot())

    def test_symlink_escape_is_invalid_and_preserves_outputs(self):
        self.page("")
        self.page("pins")
        self.enable()
        self.assert_success(self.generate())
        original = self.snapshot()
        outside = self.root.parent / "outside"
        outside.mkdir()
        (outside / "table.json").write_text(
            '{"columns": ["A"], "rows": []}', encoding="utf-8"
        )
        (self.root / "escape").symlink_to(outside, target_is_directory=True)
        self.enable("escape")
        self.assertIn("ERROR", [result.status for result in self.generate().values()])
        self.assertEqual(original, self.snapshot())
        self.assertEqual(
            ["table.json"], sorted(path.name for path in outside.iterdir())
        )

    def test_regeneration_removes_failed_and_deleted_pages_from_all_catalogs(self):
        root = self.page("")
        hub = self.page("pins")
        failed = self.page("failed")
        removed = self.page("removed")
        other = self.page("other")
        self.enable()
        self.assert_success(self.generate())
        failed_outputs = {
            failed / name: (failed / name).read_bytes()
            for name in ("index.html", "menu.html", "menu.json")
        }
        (failed / "table.json").write_text("{", encoding="utf-8")
        (removed / "table.json").unlink()
        results = self.generate()
        self.assertEqual("ERROR", results[failed].status)
        self.assertNotIn(removed, results)
        for directory in (root, hub, other):
            self.assertEqual("OK", results[directory].status)
            for name in ("index.html", "menu.html"):
                self.assert_catalog(self.metadata(directory, name), [root, hub, other])
        self.assertEqual(
            failed_outputs, {path: path.read_bytes() for path in failed_outputs}
        )
        repeated = self.generate()
        self.assertEqual("ERROR", repeated[failed].status)
        for directory in (root, hub, other):
            self.assertEqual("SKIP", repeated[directory].status)

    def test_bridge_publish_failure_restores_existing_hub_and_leaves_clients_unchanged(
        self,
    ):
        self.page("")
        hub = self.page("pins")
        self.page("existing")
        self.enable()
        self.assert_success(self.generate())
        hints = b'{ "items" : [], "note" : "keep exact bytes" }\n\n'
        (hub / "menu.json").write_bytes(hints)
        original = self.snapshot()
        self.page("pins", title="changed hub title")
        self.page("existing", title="changed client title")
        new_client = self.page("new-client")
        replace = os.replace
        failures = []

        def fail_bridge(source, destination):
            if Path(destination) == hub / "pin-state.html" and str(source).endswith(
                ".tmp"
            ):
                failures.append(Path(destination))
                raise OSError("injected pin-state publish failure")
            return replace(source, destination)

        with mock.patch("generate.os.replace", side_effect=fail_bridge):
            results = self.generate()
        self.assertTrue(failures, "Failure injection must reach bridge publication")
        self.assertEqual("ERROR", results[hub].status)
        self.assertIn("injected pin-state publish failure", results[hub].detail)
        self.assertEqual(original, self.snapshot())
        for name in ("index.html", "menu.html", "menu.json"):
            self.assertFalse((new_client / name).exists())
        self.assertEqual([], list(self.root.rglob("*.tmp")))
        self.assertEqual([], list(self.root.rglob("*.backup")))

    def test_failed_client_publication_is_removed_from_regenerated_catalogs(self):
        root = self.page("")
        hub = self.page("pins")
        failed = self.page("failed")
        other = self.page("other")
        self.enable()
        replace = os.replace
        failures = []

        def fail_client(source, destination):
            if Path(destination) == failed / "index.html" and str(source).endswith(
                ".tmp"
            ):
                failures.append(Path(destination))
                raise OSError("injected client publish failure")
            return replace(source, destination)

        with mock.patch("generate.os.replace", side_effect=fail_client):
            results = self.generate()
        self.assertTrue(failures)
        self.assertEqual("ERROR", results[failed].status)
        for directory in (root, hub, other):
            self.assertEqual("OK", results[directory].status)
            for name in ("index.html", "menu.html"):
                entries = self.metadata(directory, name)["entries"]
                ids = {entry["id"] for entry in entries}
                self.assertNotIn(self.page_id(failed), ids)
                self.assertEqual(
                    {self.page_id(path) for path in (root, hub, other)}, ids
                )
        store_ids = {
            entry["id"] for entry in self.metadata(hub, "pin-state.html")["entries"]
        }
        self.assertNotIn(self.page_id(failed), store_ids)
        self.assertEqual({self.page_id(path) for path in (root, hub, other)}, store_ids)
        for name in ("index.html", "menu.html", "menu.json"):
            self.assertFalse((failed / name).exists())

    def test_first_bridge_publish_failure_leaves_no_new_hub_or_client_outputs(self):
        pages = [self.page(path) for path in ("", "pins", "client")]
        hub = self.root / "pins"
        self.enable()
        replace = os.replace
        failures = []

        def fail_bridge(source, destination):
            if Path(destination) == hub / "pin-state.html" and str(source).endswith(
                ".tmp"
            ):
                failures.append(Path(destination))
                raise OSError("injected initial pin-state publish failure")
            return replace(source, destination)

        with mock.patch("generate.os.replace", side_effect=fail_bridge):
            results = self.generate()
        self.assertTrue(failures, "Failure injection must reach bridge publication")
        self.assertEqual("ERROR", results[hub].status)
        for directory in pages:
            for name in ("index.html", "menu.html", "menu.json", "pin-state.html"):
                self.assertFalse((directory / name).exists(), str(directory / name))
        self.assertEqual([], list(self.root.rglob("*.tmp")))
        self.assertEqual([], list(self.root.rglob("*.backup")))


if __name__ == "__main__":
    unittest.main()
