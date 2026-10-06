#!/usr/bin/env python3
"""table.jsonへ現在のcolumnsに対応した空行を追加する。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
TABLE_PATH = SCRIPT_DIR / "table.json"


class UpdateError(Exception):
    """table.jsonの更新を中止するエラー。"""


class UpdateArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise UpdateError(f"引数が不正です: {message}")


def load_table(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise UpdateError("table.jsonが見つかりません。")
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise UpdateError(f"table.jsonを読み込めません: {error}") from error
    try:
        data = json.loads(source)
    except json.JSONDecodeError as error:
        raise UpdateError(
            "table.jsonのJSON構文が不正です。\n"
            f"{error.lineno}行目 {error.colno}列目付近を確認してください。"
        ) from error
    if not isinstance(data, dict):
        raise UpdateError("table.jsonのトップレベルはオブジェクトで指定してください。")
    if "columns" not in data or not isinstance(data["columns"], list):
        raise UpdateError("table.jsonのcolumnsは配列で指定してください。")
    if "rows" not in data or not isinstance(data["rows"], list):
        raise UpdateError("table.jsonのrowsは配列で指定してください。")

    seen: set[str] = set()
    for index, column in enumerate(data["columns"], start=1):
        if not isinstance(column, str):
            raise UpdateError(f"table.jsonのcolumns[{index}]は文字列ではありません。")
        if column == "":
            raise UpdateError(f"table.jsonのcolumns[{index}]が空です。")
        if column in seen:
            raise UpdateError(f"列名「{column}」が重複しています。")
        seen.add(column)
    if not data["columns"]:
        raise UpdateError("table.jsonのcolumnsが空です。")
    return data


def write_table_atomically(path: Path, data: dict[str, Any]) -> None:
    temporary_path: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(
            prefix=".table.json.",
            suffix=".tmp",
            dir=str(path.parent),
        )
        temporary_path = Path(name)
        with os.fdopen(
            descriptor,
            "w",
            encoding="utf-8",
            newline="\n",
        ) as temporary:
            json.dump(data, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())

        with temporary_path.open(encoding="utf-8") as saved:
            json.load(saved)
        os.replace(temporary_path, path)
        temporary_path = None
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise UpdateError(f"table.jsonを書き込めません: {error}") from error
    finally:
        if temporary_path is not None and os.path.lexists(temporary_path):
            try:
                temporary_path.unlink()
            except OSError:
                pass


def add_empty_row(path: Path, position: int | None = None) -> int:
    data = load_table(path)
    columns: list[str] = data["columns"]
    rows: list[Any] = data["rows"]
    insert_position = len(rows) + 1 if position is None else position
    if insert_position < 1 or insert_position > len(rows) + 1:
        raise UpdateError(f"--positionは1から{len(rows) + 1}の範囲で指定してください。")

    empty_row = {column: "" for column in columns}
    rows.insert(insert_position - 1, empty_row)
    write_table_atomically(path, data)
    return len(rows)


def parse_arguments(arguments: list[str] | None = None) -> argparse.Namespace:
    parser = UpdateArgumentParser(
        description="table.jsonへ空のデータ行を追加します。",
    )
    parser.add_argument(
        "--position",
        type=int,
        help="挿入位置（1始まり）。省略時は末尾へ追加します。",
    )
    return parser.parse_args(arguments)


def main(arguments: list[str] | None = None) -> int:
    try:
        options = parse_arguments(arguments)
        row_count = add_empty_row(TABLE_PATH, options.position)
    except UpdateError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print("INFO: table.jsonに空行を追加しました。")
    print(f"INFO: 追加後のデータ行数は{row_count}行です。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
