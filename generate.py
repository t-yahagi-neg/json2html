#!/usr/bin/env python3
"""table.json と menu.json からHTMLを生成する。"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, TypedDict

from page_settings import SettingsError, defaults, merge_settings, title_for
from pin_support import scripts as pin_scripts

PAGE_TITLE = "タイトル"
MENU_TITLE = "メニュー"

SCRIPT_DIR = Path(__file__).resolve().parent
SCHEME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")


class BreadcrumbLabel(TypedDict):
    title: str


class BreadcrumbItem(BreadcrumbLabel, total=False):
    url: str | None


class GenerationError(Exception):
    """HTML生成を中止する致命的エラー。"""


def html_escape(value: str) -> str:
    return html.escape(value, quote=True)


def load_json_file(path: Path, display_name: str) -> Any:
    if not path.is_file():
        raise GenerationError(f"{display_name}が見つかりません。")
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise GenerationError(f"{display_name}を読み込めません: {error}") from error
    try:
        return json.loads(source)
    except json.JSONDecodeError as error:
        raise GenerationError(
            f"{display_name}のJSON構文が不正です。\n"
            f"{error.lineno}行目 {error.colno}列目付近を確認してください。"
        ) from error


def validate_columns(columns: Any, display_name: str) -> list[str]:
    if not isinstance(columns, list) or not columns:
        raise GenerationError(
            f"{display_name}のcolumnsは1件以上の配列で指定してください。"
        )
    validated: list[str] = []
    seen: set[str] = set()
    for index, column in enumerate(columns, start=1):
        if not isinstance(column, str):
            raise GenerationError(
                f"{display_name}のcolumns[{index}]は文字列ではありません。"
            )
        if column == "":
            raise GenerationError(f"{display_name}のcolumns[{index}]が空です。")
        if column in seen:
            raise GenerationError(f"{display_name}の列名「{column}」が重複しています。")
        seen.add(column)
        validated.append(column)
    return validated


def validate_table_structure(data: Any) -> tuple[list[str], list[dict[str, Any]]]:
    if not isinstance(data, dict):
        raise GenerationError(
            "table.jsonのトップレベルはオブジェクトで指定してください。"
        )
    if "columns" not in data:
        raise GenerationError("table.jsonにcolumnsがありません。")
    if "rows" not in data:
        raise GenerationError("table.jsonにrowsがありません。")
    columns = validate_columns(data["columns"], "table.json")
    rows = data["rows"]
    if not isinstance(rows, list):
        raise GenerationError("table.jsonのrowsは配列で指定してください。")
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise GenerationError(
                f"table.jsonのrows[{index}]はオブジェクトではありません。"
            )
    return columns, rows


def validate_menu_structure(data: Any) -> list[Any]:
    if not isinstance(data, dict):
        raise GenerationError(
            "menu.jsonのトップレベルはオブジェクトで指定してください。"
        )
    if "items" not in data:
        raise GenerationError("menu.jsonにitemsがありません。")
    items = data["items"]
    if not isinstance(items, list):
        raise GenerationError("menu.jsonのitemsは配列で指定してください。")
    return items


def table_url_is_supported(url: str) -> bool:
    return url.startswith(("http://", "https://"))


def menu_url_is_supported(url: str) -> bool:
    if url.startswith(("http://", "https://", "./", "../", "/", "#")):
        return True
    return SCHEME_PATTERN.match(url) is None


def fallback_text(value: Any) -> str:
    if isinstance(value, dict) and isinstance(value.get("text"), str):
        return value["text"]
    return ""


def render_link(
    value: dict[str, Any],
    context: str,
    warnings: list[str],
) -> tuple[str, bool]:
    text = value.get("text")
    url = value.get("url")
    usable_text = text if isinstance(text, str) else ""

    if not isinstance(text, str):
        warnings.append(
            f"{context}：リンクのtextが文字列ではないため、空文字として表示しました。"
        )
        return "", False
    if text == "":
        warnings.append(
            f"{context}：リンクの表示文字列が空のため、空文字として表示しました。"
        )
        return "", False
    if not isinstance(url, str):
        warnings.append(
            f"{context}：リンクのurlが文字列ではないため、"
            "通常文字列として表示しました。"
        )
        return html_escape(usable_text), False
    if url == "":
        warnings.append(
            f"{context}：リンクのURLが空のため、通常文字列として表示しました。"
        )
        return html_escape(usable_text), False
    if not table_url_is_supported(url):
        warnings.append(
            f"{context}：URL「{url}」は未対応の形式です。通常文字列として表示しました。"
        )
        return html_escape(usable_text), False
    anchor = (
        f'<a href="{html_escape(url)}" target="_blank" '
        f'rel="noopener noreferrer">{html_escape(text)}</a>'
    )
    return anchor, True


def render_multiline_line(
    value: Any,
    context: str,
    warnings: list[str],
    allow_links: bool,
) -> str:
    if isinstance(value, str):
        if value == "":
            return '<div class="multiline-line multiline-empty-line"><br></div>'
        return f'<div class="multiline-line">{html_escape(value)}</div>'

    if isinstance(value, dict) and value.get("type") == "link":
        if not allow_links:
            text = fallback_text(value)
            if text == "":
                return '<div class="multiline-line multiline-empty-line"><br></div>'
            return f'<div class="multiline-line">{html_escape(text)}</div>'
        rendered, is_link = render_link(value, context, warnings)
        if is_link:
            return f'<div class="multiline-line multiline-link-line">{rendered}</div>'
        if rendered == "":
            return '<div class="multiline-line multiline-empty-line"><br></div>'
        return f'<div class="multiline-line">{rendered}</div>'

    warnings.append(
        f"{context}：multiline.lines内では文字列とlinkだけを使用できます。"
        "未対応要素を通常文字列または空行として表示しました。"
    )
    text = fallback_text(value)
    if text == "":
        return '<div class="multiline-line multiline-empty-line"><br></div>'
    return f'<div class="multiline-line">{html_escape(text)}</div>'


# フィルター用（Excel 風チェックリスト）。表示ラベルと照合キーを分離する。
FILTER_EMPTY_VALUE = "__empty__"
FILTER_EMPTY_LABEL = "(空白)"
FILTER_COLOR_BLACK_VALUE = "black"
FILTER_COLOR_BLACK_LABEL = "黒"
FILTER_COLOR_NONE_VALUE = "none"
FILTER_COLOR_NONE_LABEL = "なし"


def filter_data_attrs(filter_value: str, filter_label: str) -> str:
    return (
        f' data-filter-value="{html_escape(filter_value)}"'
        f' data-filter-label="{html_escape(filter_label)}"'
    )


def make_td(
    inner_html: str,
    *,
    filter_value: str,
    filter_label: str,
    css_class: str | None = None,
) -> str:
    class_attr = f' class="{css_class}"' if css_class else ""
    attrs = filter_data_attrs(filter_value, filter_label)
    if inner_html == "":
        return f"<td{class_attr}{attrs}></td>"
    return f"<td{class_attr}{attrs}>{inner_html}</td>"


def text_filter_meta(text: str) -> tuple[str, str]:
    if text == "":
        return FILTER_EMPTY_VALUE, FILTER_EMPTY_LABEL
    return text, text


def multiline_filter_text(lines: list[Any]) -> str:
    parts: list[str] = []
    for line in lines:
        if isinstance(line, str):
            if line != "":
                parts.append(line)
            continue
        if isinstance(line, dict) and line.get("type") == "link":
            text = line.get("text")
            if isinstance(text, str) and text != "":
                parts.append(text)
    return " / ".join(parts)


def render_multiline_cell(
    value: dict[str, Any],
    row_number: int,
    column_name: str,
    warnings: list[str],
    is_last_column: bool,
) -> str:
    lines = value.get("lines")
    context = f"table.json {row_number}行目相当 {column_name}列"
    if not isinstance(lines, list):
        warnings.append(
            f"{context}：multilineのlinesが配列ではないため、空セルとして表示しました。"
        )
        return make_td(
            "",
            filter_value=FILTER_EMPTY_VALUE,
            filter_label=FILTER_EMPTY_LABEL,
        )

    if not is_last_column:
        warnings.append(
            f"{context}：multilineは最後の列だけで使用できます。"
            "各行を通常文字列として表示し、リンクは生成しませんでした。"
        )

    rendered_lines = [
        render_multiline_line(
            line,
            f"{context} {line_number}番目の行",
            warnings,
            allow_links=is_last_column,
        )
        for line_number, line in enumerate(lines, start=1)
    ]
    content = "\n".join(f"                  {rendered}" for rendered in rendered_lines)
    filter_text = multiline_filter_text(lines)
    filter_value, filter_label = text_filter_meta(filter_text)
    return make_td(
        f"\n{content}\n                ",
        filter_value=filter_value,
        filter_label=filter_label,
        css_class="multiline-cell",
    )


def render_table_cell(
    value: Any,
    row_number: int,
    column_name: str,
    warnings: list[str],
    is_last_column: bool,
) -> str:
    context = f"table.json {row_number}行目相当 {column_name}列"
    if isinstance(value, str):
        filter_value, filter_label = text_filter_meta(value)
        return make_td(
            html_escape(value) if value else "",
            filter_value=filter_value,
            filter_label=filter_label,
        )
    if not isinstance(value, dict):
        warnings.append(f"{context}：セル形式が不正なため、空セルとして表示しました。")
        return make_td(
            "",
            filter_value=FILTER_EMPTY_VALUE,
            filter_label=FILTER_EMPTY_LABEL,
        )

    cell_type = value.get("type")
    if cell_type == "link":
        rendered, _ = render_link(value, context, warnings)
        text = value.get("text") if isinstance(value.get("text"), str) else ""
        filter_value, filter_label = text_filter_meta(text)
        return make_td(
            rendered,
            filter_value=filter_value,
            filter_label=filter_label,
        )
    if cell_type == "color":
        color = value.get("color")
        if color == "black":
            # 色セル: 黒塗り。フィルター項目は「黒」
            return make_td(
                "",
                filter_value=FILTER_COLOR_BLACK_VALUE,
                filter_label=FILTER_COLOR_BLACK_LABEL,
                css_class="cell-black",
            )
        # 未対応色は空表示。フィルター上は「なし」（色指定なしに近い扱い）
        warnings.append(
            f"{context}：色「{color}」は未対応のため、空セルとして表示しました。"
        )
        return make_td(
            "",
            filter_value=FILTER_COLOR_NONE_VALUE,
            filter_label=FILTER_COLOR_NONE_LABEL,
        )
    if cell_type == "multiline":
        return render_multiline_cell(
            value,
            row_number,
            column_name,
            warnings,
            is_last_column,
        )

    warnings.append(
        f"{context}：セルtype「{cell_type}」は未対応です。"
        "通常文字列または空セルとして表示しました。"
    )
    text = fallback_text(value)
    filter_value, filter_label = text_filter_meta(text)
    return make_td(
        html_escape(text) if text else "",
        filter_value=filter_value,
        filter_label=filter_label,
    )


def build_index(
    table_data: Any,
    page_title: str | None = None,
    *,
    settings: dict[str, Any] | None = None,
    pin_data: dict[str, Any] | None = None,
    pin_js_url: str = "./js/page-pins.js",
    breadcrumbs: list[BreadcrumbItem] | None = None,
) -> tuple[str, list[str]]:
    columns, rows = validate_table_structure(table_data)
    try:
        if settings is None:
            settings = defaults()
            merge_settings(settings, table_data, SCRIPT_DIR)
        if page_title is None:
            page_title = title_for(table_data, PAGE_TITLE)
    except SettingsError as error:
        raise GenerationError(str(error)) from error
    column_options = settings["column_options"]
    warnings: list[str] = []
    column_set = set(columns)
    # 1行目: 列名 + 右端の Excel 風フィルタートグル（2行目以降＝tbody を対象）
    header_cells: list[str] = []
    for index, column in enumerate(columns):
        options = column_options.get(column, {})
        label = html_escape(options.get("label", column))
        visible = index == 0 or options.get("visible", True)
        header_align = options.get("header_align", settings["alignment"].get("header"))
        label_style = f' style="text-align: {header_align}"' if header_align else ""
        header_cells.append(
            f'                <th data-column-key="{html_escape(column)}"'
            f' data-column-label="{label}" data-initial-visible="{str(visible).lower()}">\n'
            '                  <div class="th-head">\n'
            f'                    <span class="th-label"{label_style}>{label}</span>\n'
            f'                    <button type="button"'
            f' class="table-filter-toggle"'
            f' data-col-index="{index}"'
            f' aria-expanded="false"'
            f' aria-haspopup="dialog"'
            f' title="{label} のフィルター"'
            f' aria-label="{label} のフィルター">\n'
            '                      <span class="table-filter-toggle-icon"'
            ' aria-hidden="true">▾</span>\n'
            "                    </button>\n"
            "                  </div>\n"
            "                </th>"
        )
    header_html = "\n".join(header_cells)

    rendered_rows: list[str] = []
    last_index = len(columns) - 1
    for row_number, row in enumerate(rows, start=1):
        for key in row:
            if key not in column_set:
                warnings.append(
                    f"table.json {row_number}行目相当："
                    f"未定義の列「{key}」を無視しました。"
                )
        cells = [
            render_table_cell(
                row.get(column, ""),
                row_number,
                column,
                warnings,
                index == last_index,
            )
            for index, column in enumerate(columns)
        ]
        for index, column in enumerate(columns):
            body_align = column_options.get(column, {}).get(
                "align", settings["alignment"].get("body")
            )
            if body_align:
                cells[index] = cells[index].replace(
                    "<td", f'<td style="text-align: {body_align}"', 1
                )
        rendered_rows.append(
            "              <tr>\n"
            + "\n".join(f"                {cell}" for cell in cells)
            + "\n              </tr>"
        )

    warning_html = ""
    if warnings and settings.get("show_warnings", True):
        items = "\n".join(
            f"          <li>{html_escape(message)}</li>" for message in warnings
        )
        warning_html = f"""
      <section class="data-messages">
        <h2>table.json読み込み時の警告</h2>
        <ul>
{items}
        </ul>
      </section>"""

    title = html_escape(page_title)
    ancestors = []
    for item in breadcrumbs or []:
        label = html_escape(item["title"])
        url = item.get("url")
        content = f'<a href="{html_escape(url)}">{label}</a>' if url else label
        ancestors.append(f"<li>{content}</li>")
    breadcrumb_html = (
        '<nav class="breadcrumbs" aria-label="パンくず"><ol>'
        + "".join(ancestors)
        + f'<li aria-current="page">{title}</li></ol></nav>'
    )
    css_url = html_escape(settings.get("css_url", "./css/style.css"))
    filter_js_url = html_escape(settings.get("filter_js_url", "./js/table-filter.js"))
    sidebar_js_url = html_escape(
        settings.get("sidebar_js_url", "./js/sidebar-toggle.js")
    )
    hidden_filter = settings["hidden_column_filter"]
    body_rows = "\n".join(rendered_rows)
    pin_controls = ""
    if pin_data is not None:
        pin_controls = """
          <button type="button" class="table-filter-clear" id="page-pin-toggle"
            aria-pressed="false" disabled>ピン留め</button>
          <span id="page-pin-status" class="pin-status" role="status" aria-live="polite" hidden></span>"""
    document = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link rel="stylesheet" href="{css_url}">
</head>
<body>
  <div class="page-layout">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-toolbar">
        <button
          type="button"
          class="sidebar-toggle"
          id="sidebar-toggle"
          aria-expanded="true"
          aria-controls="menu-frame"
          title="メニューを縮小">
          <span class="sidebar-toggle-icon" aria-hidden="true">«</span>
          <span class="sidebar-toggle-label">メニュー</span>
        </button>
      </div>
      <iframe
        id="menu-frame"
        src="./menu.html"
        class="menu-frame"
        title="メニュー">
      </iframe>
    </aside>

    <main class="main-content">
      <header class="page-header">
        {breadcrumb_html}
        <h1>{title}</h1>
      </header>

      <section class="table-section">
        <div class="table-filter-bar">
          <span class="table-filter-status" id="table-filter-status" aria-live="polite"></span>
          <button type="button" class="table-filter-clear" id="table-columns-toggle"
            aria-expanded="false" aria-controls="table-columns-panel" aria-haspopup="dialog">
            表示列
          </button>
          <button type="button" class="table-filter-clear" id="table-filter-clear">
            すべてのフィルターをクリア
          </button>{pin_controls}
        </div>
        <div class="table-scroll">
          <table id="data-table" data-hidden-column-filter="{hidden_filter}">
            <thead>
              <tr>
{header_html}
              </tr>
            </thead>
            <tbody>
{body_rows}
            </tbody>
          </table>
        </div>
      </section>{warning_html}
    </main>
  </div>
  <div
    id="table-filter-panel"
    class="table-filter-panel"
    hidden
    role="dialog"
    aria-label="列フィルター">
  </div>
  <div id="table-columns-panel" class="table-columns-panel" hidden
    role="dialog" aria-label="表示列の設定"></div>
  <script src="{filter_js_url}" defer></script>
  <script src="{sidebar_js_url}" defer></script>
{pin_scripts(pin_data, pin_js_url)}</body>
</html>
"""
    return document, warnings


def render_menu_item(
    value: Any,
    item_number: int,
    warnings: list[str],
) -> str | None:
    context = f"menu.json {item_number}番目の項目"
    if not isinstance(value, dict):
        warnings.append(f"{context}：項目形式が不正なため無視しました。")
        return None

    item_type = value.get("type")
    text = value.get("text")
    if item_type == "text":
        if not isinstance(text, str):
            warnings.append(
                f"{context}：textが文字列ではないため空文字として表示しました。"
            )
            text = ""
        return (
            '      <li class="menu-item menu-item-text">\n'
            f"        <span>{html_escape(text)}</span>\n"
            "      </li>"
        )

    if item_type == "link":
        url = value.get("url")
        usable_text = text if isinstance(text, str) else ""
        reason: str | None = None
        if not isinstance(text, str) or text == "":
            reason = "表示文字列が空または文字列ではありません"
        elif not isinstance(url, str) or url == "":
            reason = "URLが空または文字列ではありません"
        elif not menu_url_is_supported(url):
            reason = f"URL「{url}」は未対応の形式です"

        if reason is None:
            relation = value.get("relation")
            if relation not in ("parent", "sibling", "child"):
                relation = "sibling"
            return (
                f'      <li class="menu-item menu-relation-{relation}">\n'
                f'        <a href="{html_escape(url)}" target="_top">'
                f"{html_escape(text)}</a>\n"
                "      </li>"
            )
        warnings.append(f"{context}：{reason}。通常文字列として表示しました。")
        return (
            '      <li class="menu-item menu-item-text">\n'
            f"        <span>{html_escape(usable_text)}</span>\n"
            "      </li>"
        )

    warnings.append(
        f"{context}：type「{item_type}」は未対応です。"
        "通常文字列または空項目として表示しました。"
    )
    usable_text = text if isinstance(text, str) else ""
    return (
        '      <li class="menu-item menu-item-text">\n'
        f"        <span>{html_escape(usable_text)}</span>\n"
        "      </li>"
    )


def build_menu(
    menu_data: Any,
    menu_title: str = MENU_TITLE,
    *,
    css_url: str = "./css/style.css",
    show_warnings: bool = True,
    pin_data: dict[str, Any] | None = None,
    pin_js_url: str = "./js/page-pins.js",
) -> tuple[str, list[str]]:
    items = validate_menu_structure(menu_data)
    warnings: list[str] = []
    rendered_items = [
        rendered
        for item_number, item in enumerate(items, start=1)
        if (rendered := render_menu_item(item, item_number, warnings)) is not None
    ]

    if rendered_items:
        menu_body = (
            '    <ul class="menu-list">\n' + "\n".join(rendered_items) + "\n    </ul>"
        )
    else:
        menu_body = '    <p class="menu-empty">メニュー項目はありません。</p>'

    warning_html = ""
    if warnings and show_warnings:
        warning_items = "\n".join(
            f"        <li>{html_escape(message)}</li>" for message in warnings
        )
        warning_html = f"""
    <section class="menu-messages">
      <h2>menu.json読み込み時の警告</h2>
      <ul>
{warning_items}
      </ul>
    </section>"""

    title = html_escape(menu_title)
    pin_list = ""
    if pin_data is not None and pin_data["hub"]:
        pin_list = """
    <h2>ピン留めしたページ</h2>
    <ul id="pin-list" class="menu-list"></ul>
    <p id="pin-empty">ピン留めしたページはありません。</p>
    <p id="page-pin-status" class="pin-status" role="status" aria-live="polite" hidden></p>"""
    document = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <link rel="stylesheet" href="{html_escape(css_url)}">
</head>
<body class="menu-page">
  <nav class="menu">
    <h2>{title}</h2>
{menu_body}{pin_list}{warning_html}
  </nav>
{pin_scripts(pin_data, pin_js_url)}</body>
</html>
"""
    return document, warnings


def write_temporary(output_path: Path, content: str) -> Path:
    try:
        descriptor, name = tempfile.mkstemp(
            prefix=f".{output_path.name}.",
            suffix=".tmp",
            dir=str(output_path.parent),
        )
        try:
            with os.fdopen(
                descriptor,
                "w",
                encoding="utf-8",
                newline="\n",
            ) as temporary:
                temporary.write(content)
                temporary.flush()
                os.fsync(temporary.fileno())
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            try:
                os.unlink(name)
            except OSError:
                pass
            raise
    except OSError as error:
        raise GenerationError(
            f"{output_path.name}の一時ファイルを書き込めません: {error}"
        ) from error
    return Path(name)


def unique_backup_path(output_path: Path) -> Path:
    descriptor, name = tempfile.mkstemp(
        prefix=f".{output_path.name}.",
        suffix=".backup",
        dir=str(output_path.parent),
    )
    os.close(descriptor)
    return Path(name)


def publish_pair(
    temporary_files: dict[Path, Path | None],
    outputs: list[Path],
) -> None:
    for output in outputs:
        if output.is_dir():
            raise GenerationError(f"{output.name}を書き込めません。")

    backups: dict[Path, Path | None] = {output: None for output in outputs}
    published: set[Path] = set()
    try:
        for output in outputs:
            if os.path.lexists(output):
                backup = unique_backup_path(output)
                try:
                    os.replace(output, backup)
                except OSError:
                    try:
                        backup.unlink()
                    except OSError:
                        pass
                    raise
                backups[output] = backup

        for output in outputs:
            temporary = temporary_files[output]
            if temporary is None:
                raise OSError(f"{output.name}の一時ファイルがありません")
            os.replace(temporary, output)
            published.add(output)
            temporary_files[output] = None
    except OSError as error:
        rollback_errors: list[str] = []
        for output in reversed(outputs):
            backup = backups[output]
            try:
                if backup is not None and os.path.lexists(backup):
                    if os.path.lexists(output):
                        os.unlink(output)
                    os.replace(backup, output)
                elif output in published and os.path.lexists(output):
                    os.unlink(output)
            except OSError as rollback_error:
                rollback_errors.append(f"{output.name}: {rollback_error}")
        detail = f"生成ファイルを置き換えられません: {error}"
        if rollback_errors:
            detail += "（旧ファイルの復元にも失敗: " + "; ".join(rollback_errors) + "）"
        raise GenerationError(detail) from error
    else:
        for backup in backups.values():
            if backup is not None:
                try:
                    backup.unlink()
                except OSError:
                    pass


def generate_files(base_dir: Path = SCRIPT_DIR) -> tuple[list[str], list[str]]:
    table_path = base_dir / "table.json"
    menu_path = base_dir / "menu.json"
    index_path = base_dir / "index.html"
    menu_html_path = base_dir / "menu.html"
    outputs = [index_path, menu_html_path]
    temporary_files: dict[Path, Path | None] = {}

    try:
        table_data = load_json_file(table_path, "table.json")
        menu_data = load_json_file(menu_path, "menu.json")
        index_html, table_warnings = build_index(table_data)
        menu_html, menu_warnings = build_menu(
            menu_data, show_warnings=table_data.get("show_warnings") is not False
        )
        temporary_files[index_path] = write_temporary(index_path, index_html)
        temporary_files[menu_html_path] = write_temporary(
            menu_html_path,
            menu_html,
        )
        publish_pair(temporary_files, outputs)
    finally:
        for temporary in temporary_files.values():
            if temporary is not None and os.path.lexists(temporary):
                try:
                    temporary.unlink()
                except OSError:
                    pass
    return table_warnings, menu_warnings


def main(arguments: list[str] | None = None) -> int:
    import argparse

    from batch_generate import generate_tree

    parser = argparse.ArgumentParser(
        description="配下のtable.jsonからHTMLと階層メニューを一括生成します。"
    )
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path.cwd(),
        help="探索の起点（省略時は現在のディレクトリ）",
    )
    options = parser.parse_args(arguments)
    results = generate_tree(options.root)
    for result in results:
        print(f"{result.status}: {result.directory} {result.detail}".rstrip())
    counts = {
        name: sum(result.status == name for result in results)
        for name in ("OK", "SKIP", "ERROR")
    }
    print(
        f"結果: 生成 {counts['OK']} / スキップ {counts['SKIP']} / エラー {counts['ERROR']}"
    )
    return 1 if counts["ERROR"] else 0


if __name__ == "__main__":
    sys.exit(main())
