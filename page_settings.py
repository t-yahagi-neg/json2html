"""Resolve shared/page settings; relative asset paths belong to their JSON file."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

CONFIG_NAME = "json2html.config.json"
ALIGNMENTS = {"left", "center", "right"}


class SettingsError(ValueError):
    pass


def empty(value: Any) -> bool:
    return value is None or value == ""


def optional_object(value: Any, name: str) -> dict[str, Any]:
    if empty(value):
        return {}
    if not isinstance(value, dict):
        raise SettingsError(f"{name}はオブジェクトで指定してください。")
    return value


def alignment(value: Any, name: str) -> str | None:
    if empty(value):
        return None
    if not isinstance(value, str) or value not in ALIGNMENTS:
        raise SettingsError(f"{name}はleft / center / rightで指定してください。")
    return value


def merge_settings(target: dict[str, Any], source: dict[str, Any], base: Path) -> None:
    for key, value in optional_object(source.get("assets"), "assets").items():
        if key not in {"css", "js"} or empty(value):
            continue
        if (
            not isinstance(value, str)
            or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
            or value.startswith(("/", "\\"))
        ):
            raise SettingsError(f"assets.{key}はローカルの相対パスを指定してください。")
        target["assets"][key] = (base / value).resolve()
    for key, value in optional_object(source.get("alignment"), "alignment").items():
        if key in {"header", "body"}:
            parsed = alignment(value, f"alignment.{key}")
            if parsed is not None:
                target["alignment"][key] = parsed
    policy = source.get("hidden_column_filter")
    if not empty(policy):
        if policy not in ("clear", "keep"):
            raise SettingsError(
                "hidden_column_filterはclear / keepで指定してください。"
            )
        target["hidden_column_filter"] = policy
    show_warnings = source.get("show_warnings")
    if not empty(show_warnings):
        if not isinstance(show_warnings, bool):
            raise SettingsError("show_warningsは真偽値を指定してください。")
        target["show_warnings"] = show_warnings
    for column, raw in optional_object(
        source.get("column_options"), "column_options"
    ).items():
        options = optional_object(raw, f"column_options.{column}")
        merged = target["column_options"].setdefault(column, {})
        for key, value in options.items():
            if empty(value):
                continue
            if key in {"header_align", "align"}:
                merged[key] = alignment(value, f"column_options.{column}.{key}")
            elif key == "label":
                if not isinstance(value, str):
                    raise SettingsError(
                        f"column_options.{column}.labelは文字列を指定してください。"
                    )
                merged[key] = value
            elif key == "visible":
                if not isinstance(value, bool):
                    raise SettingsError(
                        f"column_options.{column}.visibleは真偽値を指定してください。"
                    )
                merged[key] = value


def defaults() -> dict[str, Any]:
    return {
        "assets": {},
        "alignment": {},
        "column_options": {},
        "hidden_column_filter": "clear",
        "show_warnings": True,
    }


def title_for(data: dict[str, Any], fallback: str) -> str:
    value = data.get("title")
    if empty(value):
        return fallback
    if not isinstance(value, str):
        raise SettingsError("titleは文字列を指定してください。")
    return value


def relative_url(path: Path, base: Path) -> str:
    return quote(Path(os.path.relpath(path, base)).as_posix(), safe="/-._~")


def resolve_settings(
    data: dict[str, Any], directory: Path, root: Path, bundle: Path
) -> dict[str, Any]:
    directory, root = directory.resolve(), root.resolve()
    relative = directory.relative_to(root)
    chain = [root]
    for part in relative.parts:
        chain.append(chain[-1] / part)
    result = defaults()
    for location in chain:
        config_path = location / CONFIG_NAME
        if config_path.exists():
            try:
                source = json.loads(config_path.read_text(encoding="utf-8"))
                if not isinstance(source, dict):
                    raise SettingsError(
                        "設定のトップレベルはオブジェクトを指定してください。"
                    )
                merge_settings(result, source, location)
            except (OSError, ValueError) as error:
                raise SettingsError(f"{config_path}: {error}") from error
    merge_settings(result, data, directory)
    for key, suffix in (("css", "css/style.css"), ("js", "js")):
        if key not in result["assets"]:
            result["assets"][key] = next(
                (
                    location / suffix
                    for location in reversed(chain)
                    if (location / suffix).exists()
                ),
                bundle / suffix,
            )
    css = result["assets"]["css"]
    js = result["assets"]["js"]
    for asset in (css, js / "table-filter.js", js / "sidebar-toggle.js"):
        if not asset.is_file():
            raise SettingsError(f"参照ファイルが見つかりません: {asset}")
    result["css_url"] = relative_url(css, directory)
    result["filter_js_url"] = relative_url(js / "table-filter.js", directory)
    result["sidebar_js_url"] = relative_url(js / "sidebar-toggle.js", directory)
    return result
