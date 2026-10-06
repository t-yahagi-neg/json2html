#!/usr/bin/env python3
"""table.jsonへの絶対パスのシンボリックリンクを平坦に作成する。"""

from __future__ import annotations

import os
from pathlib import Path
import stat
import sys


def discover_tables(source: Path, destination: Path) -> list[Path]:
    """宛先とディレクトリリンクを除外し、通常ファイルだけを探す。"""

    def fail(error: OSError) -> None:
        raise error

    tables = []
    for current, directories, files in os.walk(
        source, topdown=True, followlinks=False, onerror=fail
    ):
        directory = Path(current)
        directories[:] = sorted(
            name
            for name in directories
            if directory / name != destination
            and not stat.S_ISLNK((directory / name).lstat().st_mode)
        )
        table = directory / "table.json"
        if "table.json" in files and stat.S_ISREG(table.lstat().st_mode):
            tables.append(table)
    return sorted(tables)


def validate_links(
    tables: list[Path], source: Path, destination: Path
) -> tuple[list[tuple[Path, Path, bool]], list[str]]:
    """作成前に全出力名と既存エントリを検証する。"""
    plan = []
    errors = []
    names: dict[str, Path] = {}
    for table in tables:
        depth = len(table.parent.relative_to(source).parts)
        name = "_" * max(depth - 1, 0) + table.parent.name + ".json"
        link = destination / name
        if name in names:
            errors.append(f"出力名が衝突しています: {link} ({names[name]} / {table})")
        else:
            names[name] = table

        skip = False
        try:
            mode = link.lstat().st_mode
        except FileNotFoundError:
            pass
        except OSError as error:
            errors.append(f"宛先を確認できません: {link}: {error}")
        else:
            if stat.S_ISLNK(mode):
                try:
                    skip = link.resolve(strict=True) == table
                except (OSError, RuntimeError):
                    pass
            if not skip:
                errors.append(
                    f"既存のファイル・ディレクトリ・別リンクを保持します: {link}"
                )
        plan.append((link, table, skip))
    return plan, errors


def main(arguments: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if arguments is None else arguments
    total = created = skipped = error_count = 0
    try:
        if len(arguments) != 2:
            raise ValueError(
                "引数は2個です。使い方: python3 link_tables.py SOURCE DESTINATION"
            )
        if any(value == "" for value in arguments):
            raise ValueError("SOURCEとDESTINATIONに空文字は指定できません。")
        source, destination = (
            Path(value).expanduser().resolve() for value in arguments
        )
        if not source.is_dir():
            raise ValueError(
                f"SOURCEは実在するディレクトリを指定してください: {source}"
            )
        if source == destination:
            raise ValueError("SOURCEとDESTINATIONに同じディレクトリは指定できません。")
        if destination.exists() and not destination.is_dir():
            raise ValueError(
                f"DESTINATIONはディレクトリを指定してください: {destination}"
            )

        tables = discover_tables(source, destination)
        total = len(tables)
        plan, errors = validate_links(tables, source, destination)
        if errors:
            error_count = len(errors)
            for error in errors:
                print(f"ERROR: {error}", file=sys.stderr)
            return 1

        destination.mkdir(parents=True, exist_ok=True)
        for link, table, skip in plan:
            if skip:
                skipped += 1
                print(f"SKIP: 同一対象へのリンクを保持: {link} -> {table}")
            else:
                # symlink_toは既存エントリを置換しない。検証後の競合もエラーにする。
                link.symlink_to(table)
                created += 1
                print(f"作成: {link} -> {table}")
        return 0
    except (OSError, RuntimeError, ValueError) as error:
        error_count += 1
        print(f"ERROR: 処理を中止しました: {error}", file=sys.stderr)
        return 1
    finally:
        result = "中止" if error_count else "完了"
        print(
            f"{result}: 対象 {total}件、作成 {created}件、"
            f"SKIP {skipped}件、エラー {error_count}件"
        )


if __name__ == "__main__":
    sys.exit(main())
