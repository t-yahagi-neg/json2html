"""Static pin metadata; browser state is never written into source JSON files."""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from page_settings import CONFIG_NAME, SettingsError, empty, relative_url


def configured_pin_page(root: Path) -> Path | None:
    """Resolve one declaration against its config directory, not the CLI root."""
    config = root / CONFIG_NAME
    if not config.exists():
        return None
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SettingsError(f"{config}: {error}") from error
    if not isinstance(data, dict):
        raise SettingsError(f"{config}: 設定はオブジェクトを指定してください。")
    value = data.get("pin_page")
    if empty(value):
        return None
    if (
        not isinstance(value, str)
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
        or value.startswith(("/", "\\"))
        or "\\" in value
    ):
        raise SettingsError(
            "pin_pageは設定ディレクトリ内への相対パスを指定してください。"
        )
    candidate = root / value
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise SettingsError("pin_pageは設定ディレクトリの外を指定できません。")
    if any(
        path.is_symlink() for path in (candidate, *candidate.parents) if path != root
    ):
        raise SettingsError("pin_pageにシンボリックリンクは指定できません。")
    return resolved


def page_id(directory: Path, root: Path) -> str:
    return relative_url(directory / "index.html", root)


def order_from_menu(
    menu: dict[str, Any], hub: Path, root: Path, pages: dict
) -> list[str]:
    """Only known local page links are ordering hints; never trust arbitrary URLs."""
    known = {directory / "index.html": page_id(directory, root) for directory in pages}
    order: list[str] = []
    for item in menu["items"]:
        if not isinstance(item, dict) or item.get("type") != "link":
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url or "\\" in url:
            continue
        try:
            parsed = urlsplit(url)
            if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
                continue
            decoded = unquote(parsed.path)
            if decoded.startswith("/") or "\x00" in decoded:
                continue
            identifier = known.get((hub / decoded).resolve())
        except ValueError:
            continue
        if identifier and identifier not in order:
            order.append(identifier)
    return order


def metadata(
    directory: Path, root: Path, hub: Path, pages: dict, order: list[str]
) -> dict:
    return {
        "role": "page",
        "store_url": relative_url(hub / "pin-state.html", directory),
        "current_id": page_id(directory, root),
        "hub": directory == hub,
        "entries": [
            {
                "id": page_id(path, root),
                "title": page.title,
                "url": relative_url(path / "index.html", directory),
            }
            for path, page in sorted(pages.items())
        ],
        "order": order,
        "exclude_ids": [
            page_id(path, root) for path in (hub, hub.parent) if path in pages
        ],
    }


def scripts(data: dict | None, js_url: str) -> str:
    if data is None:
        return ""
    # JSON is raw-text inside script, not an HTML attribute; escape '<' explicitly.
    payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    return (
        f'  <script id="json2html-pins" type="application/json">{payload}</script>\n'
        f'  <script src="{html.escape(js_url, quote=True)}" defer></script>\n'
    )


def store_document(data: dict, js_url: str) -> str:
    store_data = {
        "role": "store",
        "entries": [
            {"id": entry["id"], "title": entry["title"]} for entry in data["entries"]
        ],
    }
    return (
        '<!DOCTYPE html>\n<html lang="ja">\n<head><meta charset="UTF-8">'
        "<title>ピン留め保存領域</title></head>\n<body>\n"
        + scripts(store_data, js_url)
        + "</body>\n</html>\n"
    )
