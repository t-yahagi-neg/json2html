/**
 * Excel 風の列フィルター。
 * ヘッダ右端のトグルを開き、値ごとのチェックで tbody 行を表示/非表示する。
 * 照合は各セルの data-filter-value / data-filter-label を使う。
 *
 * 選択状態の規約:
 *   selected[value] === false  … 非表示（チェックOFF）
 *   それ以外（true / 未設定）… 表示（チェックON）
 *   ※ UI と行フィルタで同じ判定にそろえること
 */
(function () {
  "use strict";

  var EMPTY_VALUE = "__empty__";
  var COLOR_BLACK = "black";
  var COLOR_NONE = "none";

  function init() {
    var table = document.getElementById("data-table");
    var panel = document.getElementById("table-filter-panel");
    var clearAllButton = document.getElementById("table-filter-clear");
    var statusEl = document.getElementById("table-filter-status");
    var columnsButton = document.getElementById("table-columns-toggle");
    var columnsPanel = document.getElementById("table-columns-panel");
    if (!table || !table.tBodies.length || !panel) {
      return;
    }

    var tbody = table.tBodies[0];
    var rows = Array.prototype.slice.call(tbody.rows);
    var total = rows.length;
    var toggles = table.querySelectorAll("thead .table-filter-toggle");
    // Ordinals are only used to address DOM cells; persisted identities are original keys.
    var headers = Array.prototype.slice.call(table.querySelectorAll("thead th"));
    var columns = headers.map(function (header, index) {
      var label = header.querySelector(".th-label");
      var key = header.getAttribute("data-column-key");
      if (key === null) {
        key = (label || header).textContent.trim();
      }
      var locked = index === 0;
      return {
        key: key,
        label: header.getAttribute("data-column-label") || (label || header).textContent.trim(),
        initialVisible: locked || header.getAttribute("data-initial-visible") !== "false",
        locked: locked,
        frozen: locked,
        visible: true
      };
    });
    var columnState = Object.create(null);
    var optionCache = Object.create(null);
    var valueCache = rows.map(function (row) {
      return columns.map(function (_, index) { return cellFilterValue(row.cells[index]); });
    });
    var labelCache = rows.map(function (row) {
      return columns.map(function (_, index) { return cellFilterLabel(row.cells[index]); });
    });
    var columnCells = columns.map(function (_, index) {
      return Array.prototype.map.call(table.rows, function (row) { return row.cells[index]; })
        .filter(Boolean);
    });
    var frozenLayout = [];
    var keepHiddenFilters = table.getAttribute("data-hidden-column-filter") === "keep";
    var storageKey = "json2html:table-state:v1:" +
      (table.getAttribute("data-state-key") || window.location.href.split("#")[0]);
    var openCol = null;
    var filterAnchor = null;
    var sortState = null;

    function restoreState() {
      var saved;
      try {
        saved = JSON.parse(window.localStorage.getItem(storageKey));
      } catch (_) { /* Storage may be blocked, unavailable, or corrupt. */ }
      // One version gate covers visibility, filtering, freezing AND sorting.
      if (!saved || saved.version !== 1) { saved = null; }
      var savedColumns = saved && saved.columns;
      columns.forEach(function (column, index) {
        var previous = savedColumns && Object.prototype.hasOwnProperty.call(savedColumns, column.key)
          ? savedColumns[column.key] : null;
        column.visible = column.locked || (previous && typeof previous.visible === "boolean"
          ? previous.visible : column.initialVisible);
        column.frozen = column.locked || !!(previous && previous.frozen === true);
        var selected = ensureColumnState(index);
        if (previous && previous.selected && (column.visible || keepHiddenFilters)) {
          Object.keys(selected).forEach(function (value) {
            selected[value] = !Object.prototype.hasOwnProperty.call(previous.selected, value) ||
              previous.selected[value] !== false;
          });
        }
      });
      if (saved && saved.sort && columns.some(function (column) { return column.key === saved.sort.key; }) &&
          (saved.sort.direction === "asc" || saved.sort.direction === "desc")) {
        sortState = { key: saved.sort.key, direction: saved.sort.direction };
      }
    }

    function saveState() {
      var savedColumns = Object.create(null);
      columns.forEach(function (column, index) {
        savedColumns[column.key] = {
          visible: column.visible,
          frozen: column.frozen,
          selected: ensureColumnState(index)
        };
      });
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, columns: savedColumns, sort: sortState }));
      } catch (_) { /* Filtering must remain usable without localStorage. */ }
    }

    function applyVisibility() {
      // Keep every cell in the DOM so filter indices and sticky first-column styles stay stable.
      Array.prototype.forEach.call(table.rows, function (row) {
        columns.forEach(function (column, index) {
          if (row.cells[index]) { row.cells[index].hidden = !column.visible; }
        });
      });
      applyFrozenColumns();
    }

    // Only visible frozen columns contribute to the horizontal offset.
    function applyFrozenColumns() {
      // Read layout before writing styles; never measure each body cell.
      var widths = columns.map(function (column, index) {
        return column.visible && column.frozen ? headers[index].getBoundingClientRect().width : 0;
      });
      var left = 0;
      columns.forEach(function (column, index) {
        var frozen = column.visible && column.frozen;
        var offset = frozen ? left + "px" : "";
        var previous = frozenLayout[index];
        if (!previous || previous.frozen !== frozen || previous.offset !== offset) {
          columnCells[index].forEach(function (cell) {
            if (!previous || previous.frozen !== frozen) { cell.classList.toggle("is-frozen", frozen); }
            if (cell.style.left !== offset) { cell.style.left = offset; }
          });
          frozenLayout[index] = { frozen: frozen, offset: offset };
        }
        if (frozen) { left += widths[index]; }
      });
    }

    function applySort() {
      var index = sortState ? columns.findIndex(function (column) { return column.key === sortState.key; }) : -1;
      var ordered = rows.map(function (row, ordinal) { return { row: row, ordinal: ordinal }; });
      if (index >= 0) {
        var collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
        ordered.sort(function (a, b) {
          var av = valueCache[a.ordinal][index], bv = valueCache[b.ordinal][index];
          if (av === EMPTY_VALUE && bv !== EMPTY_VALUE) { return 1; }
          if (bv === EMPTY_VALUE && av !== EMPTY_VALUE) { return -1; }
          // Keys retain filter identity; labels represent links/multiline/colors to the user.
          var comparison = collator.compare(labelCache[a.ordinal][index], labelCache[b.ordinal][index]);
          return (sortState.direction === "desc" ? -comparison : comparison) || a.ordinal - b.ordinal;
        });
      }
      ordered.forEach(function (item) { tbody.appendChild(item.row); });
      headers.forEach(function (header, ordinal) {
        header.setAttribute("aria-sort", ordinal === index ?
          (sortState.direction === "asc" ? "ascending" : "descending") : "none");
      });
      applyFrozenColumns();
    }

    /** チェックONか（未設定もON扱い） */
    function isChecked(selected, value) {
      return !selected || selected[value] !== false;
    }

    function cellFilterValue(cell) {
      if (!cell) {
        return EMPTY_VALUE;
      }
      // 黒塗りセルは属性が欠けていても black とみなす
      if (cell.classList && cell.classList.contains("cell-black")) {
        return COLOR_BLACK;
      }
      var raw = cell.getAttribute("data-filter-value");
      if (raw !== null && raw !== "") {
        return raw;
      }
      var text = displayText(cell);
      return text === "" ? EMPTY_VALUE : text;
    }

    function displayText(cell) {
      // textContent alone joins adjacent multiline divs and ignores br separators.
      function text(node) {
        if (node.nodeType === 3) { return node.nodeValue; }
        if (node.nodeName === "BR") { return " "; }
        var result = Array.prototype.map.call(node.childNodes, text).join("");
        return result + (node.nodeName === "DIV" || node.nodeName === "P" ? " " : "");
      }
      return text(cell).replace(/\s+/g, " ").trim();
    }

    function cellFilterLabel(cell) {
      if (!cell) {
        return "(空白)";
      }
      if (cell.classList && cell.classList.contains("cell-black")) {
        var blackLabel = cell.getAttribute("data-filter-label");
        return blackLabel && blackLabel !== "" ? blackLabel : "黒";
      }
      var label = cell.getAttribute("data-filter-label");
      if (label !== null && label !== "") {
        return label;
      }
      var text = displayText(cell);
      return text === "" ? "(空白)" : text;
    }

    function collectColumnOptions(colIndex) {
      if (optionCache[colIndex]) { return optionCache[colIndex]; }
      var map = Object.create(null);
      for (var r = 0; r < rows.length; r++) {
        var value = valueCache[r][colIndex];
        var label = labelCache[r][colIndex];
        if (!Object.prototype.hasOwnProperty.call(map, value)) {
          map[value] = label;
        }
      }
      var keys = Object.keys(map);
      keys.sort(function (a, b) {
        // 黒 → その他テキスト → なし → 空白
        var rank = function (v) {
          if (v === COLOR_BLACK) {
            return 0;
          }
          if (v === COLOR_NONE) {
            return 2;
          }
          if (v === EMPTY_VALUE) {
            return 3;
          }
          return 1;
        };
        var ra = rank(a);
        var rb = rank(b);
        if (ra !== rb) {
          return ra - rb;
        }
        return String(map[a]).localeCompare(String(map[b]), "ja");
      });
      optionCache[colIndex] = keys.map(function (key) {
        return { value: key, label: map[key] };
      });
      return optionCache[colIndex];
    }

    /**
     * 列の選択状態を返す。未登録キーは true で埋める（新規値＝最初からON）。
     */
    function ensureColumnState(colIndex) {
      var options = collectColumnOptions(colIndex);
      var columnKey = columns[colIndex].key;
      var selected = columnState[columnKey];
      if (!selected) {
        selected = Object.create(null);
        columnState[columnKey] = selected;
      }
      for (var i = 0; i < options.length; i++) {
        var key = options[i].value;
        if (!Object.prototype.hasOwnProperty.call(selected, key)) {
          selected[key] = true;
        }
      }
      return selected;
    }

    function columnIsFiltered(colIndex) {
      var selected = columnState[columns[colIndex].key];
      if (!selected) {
        return false;
      }
      var options = collectColumnOptions(colIndex);
      if (options.length === 0) {
        return false;
      }
      for (var i = 0; i < options.length; i++) {
        // OFF が1つでもあれば「フィルタ中」
        if (!isChecked(selected, options[i].value)) {
          return true;
        }
      }
      return false;
    }

    function updateToggleActiveState() {
      for (var i = 0; i < toggles.length; i++) {
        var col = Number(toggles[i].getAttribute("data-col-index"));
        if (columnIsFiltered(col)) {
          toggles[i].classList.add("is-filtered");
        } else {
          toggles[i].classList.remove("is-filtered");
        }
      }
    }

    function applyFilter() {
      var visible = 0;
      // Compute active columns once, not once per row (avoids repeated O(rows²) scans).
      var activeColumns = [];
      var hiddenLabels = [];
      columns.forEach(function (column, index) {
        if (columnIsFiltered(index)) {
          activeColumns.push(index);
          if (!column.visible) { hiddenLabels.push(column.label); }
        }
      });

      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var show = true;
        for (var t = 0; t < activeColumns.length; t++) {
          var col = activeColumns[t];
          var selected = columnState[columns[col].key];
          var value = valueCache[r][col];
          // false のときだけ隠す（未設定キーは表示）
          if (!isChecked(selected, value)) {
            show = false;
            break;
          }
        }
        row.hidden = !show;
        if (show) {
          visible += 1;
        }
      }

      if (statusEl) {
        if (activeColumns.length === 0) {
          statusEl.textContent = "全 " + total + " 件";
        } else {
          statusEl.textContent = visible + " / " + total + " 件表示";
        }
        if (keepHiddenFilters && hiddenLabels.length) {
          statusEl.textContent += "（非表示列のフィルター適用中: " + hiddenLabels.join("、") + "）";
        }
      }
      updateToggleActiveState();
      // Hidden rows can change auto-layout column widths.
      applyFrozenColumns();
      saveState();
    }

    function closePanel(restoreFocus) {
      panel.hidden = true;
      panel.innerHTML = "";
      openCol = null;
      for (var i = 0; i < toggles.length; i++) {
        toggles[i].setAttribute("aria-expanded", "false");
      }
      if (restoreFocus && filterAnchor) { filterAnchor.focus(); }
    }

    function positionPanel(anchor, target) {
      target = target || panel;
      var rect = anchor.getBoundingClientRect();
      var panelWidth = Math.min(320, Math.max(240, rect.width), window.innerWidth - 16);
      target.style.minWidth = panelWidth + "px";
      var left = rect.left;
      if (left + panelWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - panelWidth - 8);
      }
      var top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - target.offsetHeight - 8));
      target.style.left = Math.max(8, left) + "px";
      target.style.top = top + "px";
    }

    function setAll(colIndex, checked) {
      var options = collectColumnOptions(colIndex);
      var selected = ensureColumnState(colIndex);
      for (var i = 0; i < options.length; i++) {
        selected[options[i].value] = checked;
      }
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function escapeAttr(text) {
      return escapeHtml(text).replace(/'/g, "&#39;");
    }

    function closeColumnsPanel(restoreFocus) {
      if (!columnsPanel || !columnsButton) { return; }
      columnsPanel.hidden = true;
      columnsButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) { columnsButton.focus(); }
    }

    function setColumnVisible(index, visible) {
      var column = columns[index];
      column.visible = column.locked || visible;
      if (!column.visible && !keepHiddenFilters) {
        delete columnState[column.key];
      }
    }

    function renderColumnsPanel() {
      var html = '<div class="table-filter-panel-header">' +
        '<span class="table-filter-panel-title">表示する列</span>' +
        '<button type="button" class="table-filter-panel-close" aria-label="閉じる">×</button></div>' +
        '<div class="table-filter-panel-actions">' +
        '<button type="button" class="table-columns-reset">初期表示に戻す</button></div>' +
        '<ul class="table-filter-option-list">';
      columns.forEach(function (column, index) {
        html += '<li class="table-filter-option"><label>' +
          '<input type="checkbox" data-column-index="' + index + '" data-column-key="' +
          escapeAttr(column.key) + '"' +
          (column.visible ? ' checked' : '') + (column.locked ? ' disabled' : '') + '>' +
          '<span class="table-filter-option-label">' + escapeHtml(column.label) +
          (column.locked ? '（常に表示）' : '') + '</span></label>' +
          '<label class="column-freeze"><input type="checkbox" data-freeze-index="' + index + '"' +
          (column.frozen ? ' checked' : '') + (column.locked ? ' disabled' : '') +
          '>固定</label></li>';
      });
      columnsPanel.innerHTML = html + '</ul>';
      columnsPanel.querySelector(".table-filter-panel-close").addEventListener("click", function () {
        closeColumnsPanel(true);
      });
      columnsPanel.querySelector(".table-columns-reset").addEventListener("click", function (event) {
        // Rendering replaces the event target; do not mistake its bubbled click for click-away.
        event.stopPropagation();
        columns.forEach(function (column, index) {
          setColumnVisible(index, column.initialVisible);
          column.frozen = column.locked;
        });
        applyVisibility();
        applyFilter();
        renderColumnsPanel();
        columnsPanel.querySelector(".table-columns-reset").focus();
        positionPanel(columnsButton, columnsPanel);
      });
      var checks = columnsPanel.querySelectorAll('input[data-column-index]');
      Array.prototype.forEach.call(checks, function (check) {
        check.addEventListener("change", function () {
          var index = Number(check.getAttribute("data-column-index"));
          setColumnVisible(index, check.checked);
          check.checked = columns[index].visible;
          applyVisibility();
          applyFilter();
        });
      });
      Array.prototype.forEach.call(columnsPanel.querySelectorAll('input[data-freeze-index]'), function (check) {
        check.addEventListener("change", function () {
          var column = columns[Number(check.getAttribute("data-freeze-index"))];
          column.frozen = column.locked || check.checked;
          check.checked = column.frozen;
          applyFrozenColumns();
          saveState();
        });
      });
    }

    if (columnsButton && columnsPanel) {
      columnsButton.setAttribute("aria-controls", columnsPanel.id);
      columnsButton.setAttribute("aria-haspopup", "dialog");
      columnsButton.setAttribute("aria-expanded", "false");
      columnsPanel.classList.add("table-columns-panel");
      columnsPanel.setAttribute("role", "dialog");
      columnsPanel.setAttribute("aria-label", "表示する列");
      columnsPanel.hidden = true;
      columnsButton.addEventListener("click", function () {
        if (!columnsPanel.hidden) {
          closeColumnsPanel(true);
          return;
        }
        closePanel();
        renderColumnsPanel();
        columnsPanel.hidden = false;
        columnsButton.setAttribute("aria-expanded", "true");
        positionPanel(columnsButton, columnsPanel);
        var firstCheck = columnsPanel.querySelector('input:not(:disabled)');
        (firstCheck || columnsPanel.querySelector("button")).focus();
      });
    }

    function renderPanel(colIndex, anchor) {
      closeColumnsPanel();
      filterAnchor = anchor;
      var options = collectColumnOptions(colIndex);
      var selected = ensureColumnState(colIndex);
      var title =
        (anchor.getAttribute("aria-label") || "フィルター").replace(
          / のフィルター$/,
          ""
        );

      var html = "";
      html += '<div class="table-filter-panel-header">';
      html +=
        '<span class="table-filter-panel-title">' + escapeHtml(title) + "</span>";
      html +=
        '<button type="button" class="table-filter-panel-close" aria-label="閉じる">×</button>';
      html += "</div>";
      html += '<div class="table-filter-panel-actions">';
      html += '<button type="button" data-sort="asc" title="昇順" aria-label="昇順">昇順</button>' +
        '<button type="button" data-sort="desc" title="降順" aria-label="降順">降順</button>' +
        '<button type="button" data-sort="reset" title="ソート解除" aria-label="ソート解除">ソート解除</button>';
      html +=
        '<button type="button" class="table-filter-select-all">すべて選択</button>';
      html +=
        '<button type="button" class="table-filter-select-none">すべて解除</button>';
      html += "</div>";
      html += '<ul class="table-filter-option-list">';

      for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var id = "table-filter-opt-" + colIndex + "-" + i;
        var checked = isChecked(selected, opt.value);
        var isColorBlack = opt.value === COLOR_BLACK;
        var isColorNone = opt.value === COLOR_NONE;
        html += '<li class="table-filter-option">';
        html +=
          '<label for="' +
          id +
          '">' +
          '<input type="checkbox" id="' +
          id +
          '" data-filter-value="' +
          escapeAttr(opt.value) +
          '"' +
          (checked ? " checked" : "") +
          ">";
        if (isColorBlack) {
          html +=
            '<span class="table-filter-swatch table-filter-swatch-black" aria-hidden="true"></span>';
        } else if (isColorNone) {
          html +=
            '<span class="table-filter-swatch table-filter-swatch-none" aria-hidden="true"></span>';
        }
        html +=
          '<span class="table-filter-option-label">' +
          escapeHtml(opt.label) +
          "</span></label></li>";
      }

      if (options.length === 0) {
        html +=
          '<li class="table-filter-option table-filter-option-empty">項目がありません</li>';
      }
      html += "</ul>";

      panel.innerHTML = html;
      panel.hidden = false;
      openCol = colIndex;
      positionPanel(anchor);
      Array.prototype.forEach.call(panel.querySelectorAll('[data-sort]'), function (button) {
        var direction = button.getAttribute("data-sort");
        button.setAttribute("aria-pressed", String(direction === "reset" ? !sortState :
          !!(sortState && sortState.key === columns[colIndex].key && sortState.direction === direction)));
        button.addEventListener("click", function () {
          sortState = direction === "reset" ? null : { key: columns[colIndex].key, direction: direction };
          applySort();
          saveState();
          closePanel(true);
        });
      });

      for (var t = 0; t < toggles.length; t++) {
        var expanded =
          Number(toggles[t].getAttribute("data-col-index")) === colIndex;
        toggles[t].setAttribute("aria-expanded", expanded ? "true" : "false");
      }

      var closeBtn = panel.querySelector(".table-filter-panel-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", function () { closePanel(true); });
      }
      var selectAll = panel.querySelector(".table-filter-select-all");
      if (selectAll) {
        selectAll.addEventListener("click", function (event) {
          event.stopPropagation();
          setAll(colIndex, true);
          renderPanel(colIndex, anchor);
          applyFilter();
          panel.querySelector(".table-filter-select-all").focus();
        });
      }
      var selectNone = panel.querySelector(".table-filter-select-none");
      if (selectNone) {
        selectNone.addEventListener("click", function (event) {
          event.stopPropagation();
          setAll(colIndex, false);
          renderPanel(colIndex, anchor);
          applyFilter();
          panel.querySelector(".table-filter-select-none").focus();
        });
      }

      var checks = panel.querySelectorAll('input[type="checkbox"]');
      for (var c = 0; c < checks.length; c++) {
        checks[c].addEventListener("change", function (event) {
          var input = event.target;
          var value = input.getAttribute("data-filter-value");
          if (value === null) {
            return;
          }
          // 明示的に true / false を保存（未設定と false を混同しない）
          ensureColumnState(colIndex)[value] = !!input.checked;
          applyFilter();
        });
      }
      (checks[0] || closeBtn).focus();
    }

    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var button = event.currentTarget;
        var col = Number(button.getAttribute("data-col-index"));
        if (openCol === col && !panel.hidden) {
          closePanel(true);
          return;
        }
        ensureColumnState(col);
        renderPanel(col, button);
      });
    }

    if (clearAllButton) {
      clearAllButton.addEventListener("click", function () {
        columnState = Object.create(null);
        closePanel();
        closeColumnsPanel();
        applyFilter();
      });
    }

    document.addEventListener("click", function (event) {
      if (columnsPanel && !columnsPanel.hidden && !columnsPanel.contains(event.target) &&
          !columnsButton.contains(event.target)) {
        closeColumnsPanel();
      }
      if (panel.hidden) {
        return;
      }
      if (panel.contains(event.target)) {
        return;
      }
      if (event.target.closest && event.target.closest(".table-filter-toggle")) {
        return;
      }
      closePanel();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault();
        closePanel(true);
      }
      if (event.key === "Escape" && columnsPanel && !columnsPanel.hidden) {
        event.preventDefault();
        closeColumnsPanel(true);
      }
    });

    function repositionPanels() {
      if (!panel.hidden && filterAnchor) { positionPanel(filterAnchor); }
      if (columnsPanel && !columnsPanel.hidden) { positionPanel(columnsButton, columnsPanel); }
    }

    // Non-modal dialogs: Tab can leave them; close on focus leaving instead of trapping it.
    document.addEventListener("focusin", function (event) {
      if (!panel.hidden && !panel.contains(event.target) && event.target !== filterAnchor) {
        closePanel();
      }
      if (columnsPanel && !columnsPanel.hidden && !columnsPanel.contains(event.target) &&
          !columnsButton.contains(event.target)) {
        closeColumnsPanel();
      }
    });
    window.addEventListener("scroll", repositionPanels, true);
    window.addEventListener("resize", function () { repositionPanels(); applyFrozenColumns(); });
    if (window.ResizeObserver) {
      var frozenUpdatePending = false;
      var observer = new window.ResizeObserver(function () {
        if (frozenUpdatePending) { return; }
        frozenUpdatePending = true;
        // Leave the observer delivery cycle before writing. Unchanged offsets cause no writes.
        (window.requestAnimationFrame || window.setTimeout).call(window, function () {
          frozenUpdatePending = false;
          applyFrozenColumns();
        });
      });
      observer.observe(table);
      headers.forEach(function (header) { observer.observe(header); });
    }

    restoreState();
    applyVisibility();
    applySort();
    if (statusEl) { statusEl.setAttribute("aria-live", "polite"); }
    applyFilter();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
