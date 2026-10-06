from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

import link_tables  # noqa: E402


class LinkTablesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix=".link-tables-test-", dir=PROJECT.parent
        )
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "root"
        self.root.mkdir()
        self.destination = self.base / "output"

    def table(self, relative=""):
        directory = self.root / relative
        directory.mkdir(parents=True, exist_ok=True)
        table = directory / "table.json"
        table.write_bytes(b'{"untouched": true}\n')
        return table

    def run_command(self, *arguments, **kwargs):
        args = arguments or (self.root, self.destination)
        return subprocess.run(
            [sys.executable, str(PROJECT / "link_tables.py"), *map(str, args)],
            capture_output=True,
            text=True,
            check=False,
            **kwargs,
        )

    def run_main(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = link_tables.main([str(self.root), str(self.destination)])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_root_and_depth_one_two_three_preserve_json_and_html(self):
        expected = {
            "root.json": self.table(),
            "001.json": self.table("001"),
            "_0021.json": self.table("002/0021"),
            "__name.json": self.table("002/0021/name"),
        }
        for table in expected.values():
            table.with_name("index.html").write_text("<p>保持</p>", encoding="utf-8")
        originals = {
            path: (path.read_bytes(), path.stat().st_mtime_ns)
            for table in expected.values()
            for path in (table, table.with_name("index.html"))
        }
        self.destination = self.base / "new" / "nested" / "output"
        result = self.run_command()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("対象 4件、作成 4件、SKIP 0件、エラー 0件", result.stdout)
        self.assertEqual(set(expected), {p.name for p in self.destination.iterdir()})
        for name, target in expected.items():
            link = self.destination / name
            self.assertTrue(link.is_symlink())
            self.assertEqual(str(target), os.readlink(link))
            self.assertTrue(Path(os.readlink(link)).is_absolute())
        self.assertEqual(
            originals,
            {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in originals},
        )

    def test_japanese_spaces_relative_paths(self):
        self.root = self.base / "日本語 入力"
        target = self.table("子 空白")
        self.destination = self.base / "日本語 出力"
        result = self.run_command(
            "日本語 入力/../日本語 入力",
            "日本語 出力",
            cwd=self.base,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(str(target), os.readlink(self.destination / "子 空白.json"))

    def test_branch_name_collision_is_preflighted(self):
        self.table("000-valid")
        self.table("branch-a/same")
        self.table("branch-b/same")
        result = self.run_command()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("衝突", result.stderr)
        self.assertIn("作成 0件", result.stdout)
        self.assertFalse(self.destination.exists())

    def test_root_and_child_name_collision(self):
        self.table()
        self.table("root")
        result = self.run_command()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("root.json", result.stderr)
        self.assertFalse(self.destination.exists())

    def test_prefix_name_collision_between_depths(self):
        self.table("_same")
        self.table("branch/same")
        result = self.run_command()
        self.assertNotEqual(0, result.returncode)
        self.assertFalse(self.destination.exists())

    def test_existing_entries_are_preserved_and_all_checked_before_creation(self):
        self.table("000-valid")
        self.destination.mkdir()
        existing = {}
        for name in ("file", "directory", "dangling", "wrong", "loop"):
            self.table(name)
            existing[name] = self.destination / (name + ".json")
        existing["file"].write_bytes(b"keep existing file")
        existing["directory"].mkdir()
        (existing["directory"] / "keep.txt").write_text("keep", encoding="utf-8")
        existing["dangling"].symlink_to(self.base / "missing")
        other = self.base / "other.json"
        other.write_text("other", encoding="utf-8")
        existing["wrong"].symlink_to(other)
        existing["loop"].symlink_to("loop.json")
        before = {name: p.lstat() for name, p in existing.items()}
        result = self.run_command()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("作成 0件", result.stdout)
        self.assertEqual(5, result.stderr.count("ERROR:"))
        self.assertEqual(
            set(p.name for p in existing.values()), set(os.listdir(self.destination))
        )
        self.assertEqual(before, {name: p.lstat() for name, p in existing.items()})
        self.assertEqual(b"keep existing file", existing["file"].read_bytes())
        self.assertEqual("keep", (existing["directory"] / "keep.txt").read_text())
        self.assertEqual(str(self.base / "missing"), os.readlink(existing["dangling"]))
        self.assertEqual(str(other), os.readlink(existing["wrong"]))
        self.assertEqual("loop.json", os.readlink(existing["loop"]))

    def test_rerun_skips_without_replacing_links(self):
        self.table()
        self.table("001")
        first = self.run_command()
        self.assertEqual(0, first.returncode, first.stderr)
        before = {p: p.lstat() for p in self.destination.iterdir()}
        second = self.run_command()
        self.assertEqual(0, second.returncode, second.stderr)
        self.assertIn("作成 0件、SKIP 2件", second.stdout)
        self.assertEqual(before, {p: p.lstat() for p in before})

    def test_existing_relative_link_to_same_target_is_skipped(self):
        target = self.table()
        self.destination.mkdir()
        link = self.destination / "root.json"
        relative = os.path.relpath(target, self.destination)
        link.symlink_to(relative)
        before = link.lstat()
        result = self.run_command()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("SKIP 1件", result.stdout)
        self.assertEqual(relative, os.readlink(link))
        self.assertEqual(before, link.lstat())

    def test_source_errors(self):
        regular = self.base / "source-file"
        regular.write_text("keep", encoding="utf-8")
        for source in (self.base / "missing", regular):
            with self.subTest(source=source):
                result = self.run_command(source, self.destination)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("SOURCE", result.stderr)
                self.assertFalse(self.destination.exists())

    def test_same_source_destination_including_resolved_alias(self):
        self.table()
        alias = self.base / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for destination in (self.root, self.root / ".." / "root", alias):
            with self.subTest(destination=destination):
                result = self.run_command(self.root, destination)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("同じディレクトリ", result.stderr)
                self.assertEqual(["table.json"], os.listdir(self.root))

    def test_destination_file_or_file_parent_errors(self):
        self.table()
        self.destination.write_bytes(b"keep")
        for destination in (self.destination, self.destination / "child"):
            with self.subTest(destination=destination):
                result = self.run_command(self.root, destination)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("ERROR:", result.stderr)
                self.assertEqual(b"keep", self.destination.read_bytes())

    def test_requires_exactly_two_arguments(self):
        for arguments in ([], [str(self.root)], [str(self.root)] * 3):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, str(PROJECT / "link_tables.py"), *arguments],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(0, result.returncode)
                self.assertIn("引数は2個", result.stderr)
                self.assertFalse(self.destination.exists())

    def test_empty_arguments_fail_without_writing(self):
        table = self.table()
        before = set(self.base.rglob("*"))
        for arguments in (("", self.destination), (self.root, ""), ("", "")):
            with self.subTest(arguments=arguments):
                result = self.run_command(*arguments, cwd=self.base)
                self.assertNotEqual(0, result.returncode)
                self.assertIn("空文字は指定できません", result.stderr)
                self.assertIn("対象 0件、作成 0件", result.stdout)
                self.assertEqual(before, set(self.base.rglob("*")))
                self.assertEqual(b'{"untouched": true}\n', table.read_bytes())

    def test_internal_destination_entire_subtree_is_excluded(self):
        target = self.table()
        self.destination = self.root / "nested" / "output"
        excluded = self.table("nested/output/deep/inside")
        excluded_root = self.table("nested/output")
        included = self.table("nested/output-other")
        result = self.run_command()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("対象 2件", result.stdout)
        self.assertEqual(str(target), os.readlink(self.destination / "root.json"))
        self.assertEqual(
            str(included), os.readlink(self.destination / "_output-other.json")
        )
        self.assertEqual(b'{"untouched": true}\n', excluded.read_bytes())
        self.assertEqual(b'{"untouched": true}\n', excluded_root.read_bytes())
        self.assertEqual(0, self.run_command().returncode)

    def test_symlink_directories_and_table_symlinks_are_not_followed(self):
        target = self.table("real")
        (self.root / "alias").symlink_to(target.parent, target_is_directory=True)
        (self.root / "cycle").symlink_to(self.root, target_is_directory=True)
        external = self.base / "external"
        external.mkdir()
        (external / "table.json").write_text("{}", encoding="utf-8")
        (self.root / "external").symlink_to(external, target_is_directory=True)
        for name, linked_target in (
            ("linked-table", target),
            ("broken", self.base / "missing"),
        ):
            directory = self.root / name
            directory.mkdir()
            (directory / "table.json").symlink_to(linked_target)
        result = self.run_command()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(["real.json"], os.listdir(self.destination))

    def test_hidden_directory_included_but_nonregular_tables_excluded(self):
        self.table(".hidden")
        (self.root / "table.json").mkdir()
        fifo_dir = self.root / "fifo"
        fifo_dir.mkdir()
        os.mkfifo(fifo_dir / "table.json")
        result = self.run_command()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual([".hidden.json"], os.listdir(self.destination))

    def test_empty_source_creates_destination_and_reports_zero(self):
        result = self.run_command()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("対象 0件、作成 0件", result.stdout)
        self.assertTrue(self.destination.is_dir())

    def test_scan_error_is_not_success(self):
        def failed_walk(*args, **kwargs):
            kwargs["onerror"](PermissionError("探索テスト"))
            return iter(())

        with mock.patch.object(link_tables.os, "walk", side_effect=failed_walk):
            code, stdout, stderr = self.run_main()
        self.assertNotEqual(0, code)
        self.assertIn("探索テスト", stderr)
        self.assertIn("中止", stdout)
        self.assertFalse(self.destination.exists())

    def test_mkdir_error_is_not_success(self):
        self.table()
        with mock.patch.object(Path, "mkdir", side_effect=PermissionError("作成不可")):
            code, stdout, stderr = self.run_main()
        self.assertNotEqual(0, code)
        self.assertIn("作成不可", stderr)
        self.assertIn("作成 0件", stdout)

    def test_creation_error_reports_partial_count_and_preserves_created_link(self):
        first = self.table("a")
        self.table("b")
        original = Path.symlink_to

        def fail_second(path, target, **kwargs):
            if path.name == "b.json":
                raise PermissionError("途中失敗")
            return original(path, target, **kwargs)

        with mock.patch.object(Path, "symlink_to", new=fail_second):
            code, stdout, stderr = self.run_main()
        self.assertNotEqual(0, code)
        self.assertIn("途中失敗", stderr)
        self.assertIn("中止: 対象 2件、作成 1件、SKIP 0件、エラー 1件", stdout)
        self.assertEqual(str(first), os.readlink(self.destination / "a.json"))
        self.assertFalse((self.destination / "b.json").exists())

    def test_racing_existing_file_is_never_replaced(self):
        self.table()
        original = Path.symlink_to

        def competing_file(path, target, **kwargs):
            path.write_bytes(b"concurrent file")
            return original(path, target, **kwargs)

        with mock.patch.object(Path, "symlink_to", new=competing_file):
            code, stdout, stderr = self.run_main()
        self.assertNotEqual(0, code)
        self.assertIn("ERROR:", stderr)
        self.assertIn("作成 0件", stdout)
        self.assertEqual(
            b"concurrent file", (self.destination / "root.json").read_bytes()
        )


if __name__ == "__main__":
    unittest.main()
