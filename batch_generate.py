"""Batch generation and directory-neighbour menus, using the existing renderer."""

from __future__ import annotations

import json
import os
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import generate
from page_settings import (
    CONFIG_NAME,
    SettingsError,
    relative_url,
    resolve_settings,
    title_for,
)
from pin_support import configured_pin_page, metadata, order_from_menu, store_document
from pin_transaction import ScopeHistory


@dataclass
class GenerationResult:
    directory: Path
    status: str
    detail: str = ""


@dataclass
class Page:
    directory: Path
    title: str
    settings: dict[str, Any]
    index_html: str
    warnings: list[str]
    data: dict[str, Any]


def discover_tables(root: Path, config_dirs: list[Path] | None = None) -> list[Path]:
    paths: list[Path] = []

    def fail(error: OSError) -> None:
        raise error

    for current, directories, files in os.walk(root, followlinks=False, onerror=fail):
        location = Path(current)
        directories[:] = sorted(
            name
            for name in directories
            if not name.startswith(".") and not (location / name).is_symlink()
        )
        path = location / "table.json"
        if config_dirs is not None and CONFIG_NAME in files:
            config_dirs.append(location)
        if "table.json" in files and not path.is_symlink():
            paths.append(path)
    return sorted(paths)


def menu_for(
    page: Page, pages: dict[Path, Page], hub: Path | None = None
) -> dict[str, Any]:
    directory = page.directory
    neighbours: list[Path] = []
    if directory.parent in pages:
        neighbours.append(directory.parent)
    neighbours.extend(
        sorted(
            (
                other
                for other in pages
                if other != directory and other.parent == directory.parent
            ),
            key=lambda path: path.name,
        )
    )
    neighbours.extend(
        sorted(
            (other for other in pages if other.parent == directory),
            key=lambda path: path.name,
        )
    )
    if hub is not None:
        if directory == hub:
            neighbours = [directory.parent] if directory.parent in pages else []
        else:
            neighbours = [hub] + [other for other in neighbours if other != hub]
    return {
        "items": [
            {
                "type": "link",
                "text": pages[other].title,
                "url": relative_url(other / "index.html", directory),
                "relation": (
                    "parent"
                    if other == hub or other == directory.parent
                    else "child"
                    if other.parent == directory
                    else "sibling"
                ),
            }
            for other in neighbours
        ]
    }


def publish(documents: dict[Path, str]) -> bool:
    """Return False if all outputs are byte-identical; otherwise replace as a group."""
    if all(
        path.is_file() and path.read_bytes() == text.encode("utf-8")
        for path, text in documents.items()
    ):
        return False
    temporary: dict[Path, Path | None] = {}
    try:
        for path, text in documents.items():
            temporary[path] = generate.write_temporary(path, text)
        generate.publish_pair(temporary, list(documents))
    finally:
        for path in temporary.values():
            if path is not None and path.exists():
                path.unlink()
    return True


def generate_tree(root: Path) -> list[GenerationResult]:
    with ExitStack() as cleanup:
        return _generate_tree(root, cleanup)


def _generate_tree(root: Path, cleanup: ExitStack) -> list[GenerationResult]:
    root = root.resolve()
    results: dict[Path, GenerationResult] = {}
    if not root.is_dir():
        return [GenerationResult(root, "ERROR", "対象ディレクトリが見つかりません。")]
    config_dirs: list[Path] = []
    try:
        tables = discover_tables(root, config_dirs)
    except OSError as error:
        return [GenerationResult(root, "ERROR", f"探索できません: {error}")]
    # A declaration owns its subtree, independent of the command's search root.
    # Invalid declarations remain boundaries too: never silently fall back to an
    # ancestor hub or overwrite a possibly hand-edited menu as a normal menu.
    hubs: dict[Path, Path] = {}
    scope_errors: dict[Path, str] = {}
    for location in config_dirs:
        try:
            hub = configured_pin_page(location)
            if hub is not None:
                hubs[location] = hub
        except (SettingsError, OSError) as error:
            scope_errors[location] = str(error)
    boundaries = sorted(
        set(hubs) | set(scope_errors), key=lambda p: len(p.parts), reverse=True
    )

    def owner(directory: Path) -> Path | None:
        return next(
            (scope for scope in boundaries if directory.is_relative_to(scope)), None
        )

    if not tables:
        if boundaries:
            return [
                GenerationResult(
                    scope,
                    "ERROR",
                    scope_errors.get(scope, "pin_pageには有効なtable.jsonが必要です。"),
                )
                for scope in sorted(boundaries)
            ]
        return [GenerationResult(root, "SKIP", "table.jsonがありません。")]
    pages: dict[Path, Page] = {}
    for table in tables:
        directory = table.parent
        try:
            data = generate.load_json_file(table, str(table))
            generate.validate_table_structure(data)
            title = title_for(data, directory.name)
            settings = resolve_settings(data, directory, root, generate.SCRIPT_DIR)
            html, warnings = generate.build_index(data, title, settings=settings)
            pages[directory] = Page(directory, title, settings, html, warnings, data)
        except (generate.GenerationError, SettingsError, OSError) as error:
            results[directory] = GenerationResult(directory, "ERROR", str(error))

    histories: dict[Path, ScopeHistory] = {}

    def block_scope(scope: Path, detail: str, failure: Path | None = None) -> None:
        failure = failure or scope
        rollback_errors: list[str] = []
        if scope in histories:
            rollback_errors = histories[scope].restore()
            if rollback_errors:
                detail += "（出力の復元にも失敗: " + "; ".join(rollback_errors) + "）"
        for directory in list(pages):
            if owner(directory) == scope:
                results[directory] = GenerationResult(
                    directory,
                    "ERROR" if rollback_errors else "SKIP",
                    "ピン留め出力の復元に失敗。専用ページのエラー詳細を確認してください。"
                    if rollback_errors
                    else "ピン留め設定・専用ページのエラーにより実行前の出力を保持",
                )
                del pages[directory]
        results[failure] = GenerationResult(failure, "ERROR", detail)

    hint_menus: dict[Path, dict[str, Any]] = {}
    # A referenced hub must never be downgraded to a normal page just because
    # a nested declaration takes ownership of its directory.
    for scope, hub in hubs.items():
        if owner(hub) != scope and hubs.get(owner(hub)) != hub:
            pages.pop(hub, None)
            results[hub] = GenerationResult(
                hub, "ERROR", "pin_pageが別のピン留め設定範囲と競合しています。"
            )
    for scope in boundaries:
        if scope in scope_errors:
            block_scope(scope, scope_errors[scope])
            continue
        hub = hubs[scope]
        try:
            if hub not in pages or owner(hub) != scope:
                raise SettingsError(
                    "pin_pageには同じ設定範囲内の有効なtable.jsonが必要です。"
                )
            for directory, page in pages.items():
                if owner(directory) != scope:
                    continue
                asset = page.settings["assets"]["js"] / "page-pins.js"
                if not asset.is_file():
                    raise SettingsError(f"ピン留め用JSが見つかりません: {asset}")
            hint_menu: dict[str, Any] = {"items": []}
            if (hub / "menu.json").exists():
                hint_menu = generate.load_json_file(
                    hub / "menu.json", "ピン留め用menu.json"
                )
                generate.validate_menu_structure(hint_menu)
            hint_menus[scope] = hint_menu
        except (generate.GenerationError, SettingsError, OSError) as error:
            block_scope(scope, str(error))
    while pages:
        failed = []
        # Publish all shared stores first, before any clients in their scopes.
        ordered = sorted(pages, key=lambda path: (path not in hubs.values(), str(path)))
        for directory in ordered:
            if directory not in pages:
                continue
            page = pages[directory]
            scope = owner(directory)
            hub = hubs.get(scope)
            try:
                menu = menu_for(page, pages, hub)
                pin_data = None
                pin_js_url = "./js/page-pins.js"
                index_html = page.index_html
                if hub is not None:
                    scope_pages = {
                        path: value
                        for path, value in pages.items()
                        if owner(path) == scope
                    }
                    order = order_from_menu(hint_menus[scope], hub, scope, scope_pages)
                    pin_data = metadata(directory, scope, hub, scope_pages, order)
                    pin_js_url = relative_url(
                        page.settings["assets"]["js"] / "page-pins.js", directory
                    )
                    index_html, _ = generate.build_index(
                        page.data,
                        page.title,
                        settings=page.settings,
                        pin_data=pin_data,
                        pin_js_url=pin_js_url,
                    )
                menu_html, _ = generate.build_menu(
                    menu,
                    css_url=page.settings["css_url"],
                    show_warnings=page.settings["show_warnings"],
                    pin_data={**pin_data, "role": "menu"} if pin_data else None,
                    pin_js_url=pin_js_url,
                )
                documents = {
                    directory / "menu.json": json.dumps(
                        menu, ensure_ascii=False, indent=2
                    )
                    + "\n",
                    directory / "menu.html": menu_html,
                    directory / "index.html": index_html,
                }
                if directory == hub:
                    # menu.json belongs to the user on the hub, unlike generated neighbour menus.
                    if (hub / "menu.json").exists():
                        del documents[hub / "menu.json"]
                    else:
                        documents[hub / "menu.json"] = '{"items": []}\n'
                    documents[hub / "pin-state.html"] = store_document(
                        pin_data, pin_js_url
                    )
                needs_change = not all(
                    path.is_file() and path.read_bytes() == text.encode("utf-8")
                    for path, text in documents.items()
                )
                if hub is not None and needs_change:
                    if scope not in histories:
                        histories[scope] = ScopeHistory()
                        cleanup.callback(histories[scope].close)
                    histories[scope].prepare(documents)
                changed = publish(documents)
                if hub is not None and changed:
                    histories[scope].changed(documents)
                previous = results.get(directory)
                status = (
                    "OK"
                    if changed or (previous and previous.status == "OK")
                    else "SKIP"
                )
                detail = f"警告 {len(page.warnings)}件" if page.warnings else ""
                results[directory] = GenerationResult(directory, status, detail)
            except (generate.GenerationError, OSError) as error:
                results[directory] = GenerationResult(directory, "ERROR", str(error))
                failed.append(directory)
                if directory == hub:
                    block_scope(scope, str(error), directory)
                else:
                    del pages[directory]
        if not failed:
            break
        # Rebuild successful neighbours too: a failed new page must not leave dead links.
        # Each retry removes at least one page, so persistent write failures cannot loop.
    return sorted(results.values(), key=lambda result: str(result.directory))
