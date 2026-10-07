// Run: node --test tests/test_table_filter.cjs
// Uses an existing jsdom install (JSDOM_PATH can point to one); never installs packages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const source = fs.readFileSync(path.join(__dirname, '../js/table-filter.js'), 'utf8');
const prefix = 'json2html:table-state:v1:';

const defaults = [
  { key: 'Header', label: '名前', visible: false },
  { key: 'type', label: '種類' },
  { key: 'notes', label: '備考', visible: false },
];
const defaultRows = [['一', 'A', 'X'], ['二', 'B', 'Y'], ['三', 'A', 'Z']];

function fixture(t, config = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: config.url || 'https://example.test/table.html', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  const columns = config.columns || defaults;
  const data = config.rows || defaultRows;
  document.body.innerHTML = '<div class="table-filter-bar">' +
    '<span id="table-filter-status"></span>' +
    '<button id="table-columns-toggle" class="table-filter-clear">列表示</button>' +
    '<button id="table-filter-clear">フィルターをすべて解除</button></div>' +
    '<table id="data-table"><thead><tr></tr></thead><tbody></tbody></table>' +
    '<div id="table-filter-panel" class="table-filter-panel" role="dialog" hidden></div>' +
    '<div id="table-columns-panel" class="table-columns-panel" role="dialog" hidden></div>' +
    '<button id="outside">外側</button>';
  const table = document.getElementById('data-table');
  if (config.stateKey !== null) table.setAttribute('data-state-key', config.stateKey || 'test-page');
  if (config.policy) table.setAttribute('data-hidden-column-filter', config.policy);
  columns.forEach((column, index) => {
    const th = document.createElement('th');
    th.setAttribute('data-column-key', column.key);
    th.setAttribute('data-column-label', column.label);
    th.setAttribute('data-initial-visible', String(column.visible !== false));
    const label = document.createElement('span');
    label.className = 'th-label';
    label.textContent = column.label;
    const button = document.createElement('button');
    button.className = 'table-filter-toggle';
    button.setAttribute('data-col-index', index);
    button.setAttribute('aria-label', `${column.label} のフィルター`);
    th.append(label, button);
    table.tHead.rows[0].append(th);
  });
  data.forEach(values => {
    const row = table.tBodies[0].insertRow();
    values.forEach(value => {
      const cell = row.insertCell();
      if (value && typeof value === 'object') {
        cell.textContent = value.text || '';
        if (value.html) cell.innerHTML = value.html;
        if (value.black) cell.className = 'cell-black';
        if (value.value !== undefined) cell.setAttribute('data-filter-value', value.value);
        if (value.label) cell.setAttribute('data-filter-label', value.label);
      } else {
        cell.textContent = value;
        cell.setAttribute('data-filter-value', value);
        cell.setAttribute('data-filter-label', value);
      }
    });
  });
  const storage = config.storage || new Map();
  Object.defineProperty(window, 'localStorage', { get() {
    if (config.storageThrows === 'read') throw new Error('storage denied');
    return {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        if (config.storageThrows === 'write') throw new Error('quota exceeded');
        storage.set(key, value);
      },
    };
  } });
  Object.defineProperty(document, 'readyState', { value: config.loading ? 'loading' : 'complete' });
  const originalRows = [...table.tBodies[0].rows];
  if (config.beforeInit) config.beforeInit({ window, document, table });
  window.eval(source);
  if (config.loading) document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const $ = selector => document.querySelector(selector);
  const checks = () => [...document.querySelectorAll('#table-columns-panel input[data-column-index]')];
  const freezeChecks = () => [...document.querySelectorAll('#table-columns-panel input[data-freeze-index]')];
  function change(input, checked) {
    assert.ok(input, 'checkbox exists');
    input.checked = checked;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  function openColumns() {
    if ($('#table-columns-panel').hidden) $('#table-columns-toggle').click();
  }
  return {
    window, document, table, storage, $, change, checks, freezeChecks, openColumns, originalRows,
    visibleRows: () => [...table.tBodies[0].rows].map(r => !r.hidden),
    visibleColumns: () => [...table.tHead.rows[0].cells].map(c => !c.hidden),
    state: () => JSON.parse(storage.values().next().value),
    filter(index, value, checked) {
      const button = table.tHead.rows[0].cells[index].querySelector('button');
      if ($('#table-filter-panel').hidden || button.getAttribute('aria-expanded') !== 'true') button.click();
      const input = [...document.querySelectorAll('#table-filter-panel input')]
        .find(node => node.getAttribute('data-filter-value') === value);
      change(input, checked);
    },
    visibility(index, visible) { openColumns(); change(checks()[index], visible); },
    freeze(index, frozen) { openColumns(); change(freezeChecks()[index], frozen); },
    sort(index, direction) {
      const button = table.tHead.rows[0].cells[index].querySelector('button');
      if ($('#table-filter-panel').hidden || button.getAttribute('aria-expanded') !== 'true') button.click();
      $(`#table-filter-panel [data-sort="${direction}"]`).click();
    },
  };
}

test('initial visibility, label checklist, locked first column, and cells retained in DOM', t => {
  const page = fixture(t, { loading: true });
  assert.deepEqual(page.visibleColumns(), [true, true, false]);
  page.openColumns();
  assert.equal(page.checks()[0].disabled, true);
  assert.equal(page.checks()[0].checked, true);
  assert.match(page.$('#table-columns-panel').textContent, /名前（常に表示）/);
  assert.equal(page.document.activeElement, page.checks()[1]);
  page.visibility(1, false);
  assert.deepEqual(page.visibleColumns(), [true, false, false]);
  for (const row of page.table.rows) {
    assert.equal(row.cells.length, 3);
    assert.equal(row.cells[1].hidden, true);
    assert.equal(row.cells[0].hidden, false);
  }
  // A synthetic change cannot circumvent the locked checkbox.
  page.change(page.checks()[0], false);
  assert.equal(page.checks()[0].checked, true);
  assert.equal(page.table.tHead.rows[0].cells[0].hidden, false);
});

test('only the first column is locked; a second column named Header can hide and restore', t => {
  const columns = [
    { key: 'name', label: '名前', visible: false },
    { key: 'Header', label: 'Header' },
    defaults[2],
  ];
  const page = fixture(t, { columns });
  page.openColumns();
  assert.equal(page.checks()[0].disabled, true);
  assert.equal(page.checks()[1].disabled, false);
  page.visibility(1, false);
  assert.deepEqual(page.visibleColumns(), [true, false, false]);
  assert.equal(page.state().columns.Header.visible, false);
  const reload = fixture(t, { columns, storage: page.storage });
  assert.deepEqual(reload.visibleColumns(), [true, false, false]);
  reload.openColumns();
  assert.equal(reload.checks()[1].disabled, false);
  reload.$('.table-columns-reset').click();
  assert.deepEqual(reload.visibleColumns(), [true, true, false]);
});

test('default clear policy removes hidden filters; reset filters does not reset visibility', t => {
  const page = fixture(t);
  page.filter(1, 'B', false);
  assert.deepEqual(page.visibleRows(), [true, false, true]);
  assert.equal(page.$('#table-filter-status').textContent, '2 / 3 件表示');
  assert.ok(page.table.tHead.rows[0].cells[1].querySelector('button').classList.contains('is-filtered'));
  page.visibility(1, false);
  assert.deepEqual(page.visibleRows(), [true, true, true]);
  assert.equal(page.$('#table-filter-status').textContent, '全 3 件');
  page.filter(0, '一', false);
  page.$('#table-filter-clear').click();
  assert.deepEqual(page.visibleColumns(), [true, false, false]);
  assert.deepEqual(page.visibleRows(), [true, true, true]);
  const reload = fixture(t, { storage: page.storage });
  assert.deepEqual(reload.visibleColumns(), [true, false, false]);
  assert.deepEqual(reload.visibleRows(), [true, true, true]);
});

test('keep policy persists hidden filtering and visible status, including after reload', t => {
  const page = fixture(t, { policy: 'keep' });
  page.filter(1, 'B', false);
  page.visibility(1, false);
  assert.deepEqual(page.visibleRows(), [true, false, true]);
  assert.match(page.$('#table-filter-status').textContent, /非表示列のフィルター適用中: 種類/);
  const reload = fixture(t, { policy: 'keep', storage: page.storage });
  assert.deepEqual(reload.visibleColumns(), [true, false, false]);
  assert.deepEqual(reload.visibleRows(), [true, false, true]);
  assert.match(reload.$('#table-filter-status').textContent, /非表示列/);
  const clearReload = fixture(t, { policy: 'clear', storage: new Map(page.storage) });
  assert.deepEqual(clearReload.visibleRows(), [true, true, true]);
  assert.equal(clearReload.$('#table-filter-status').textContent, '全 3 件');
  assert.equal(clearReload.state().columns.type.selected.B, true);
  reload.$('#table-filter-clear').click();
  assert.deepEqual(reload.visibleColumns(), [true, false, false]);
  assert.equal(reload.$('#table-filter-status').textContent, '全 3 件');
});

test('saved visibility cannot hide the first column; malformed entries fall back to initial state', t => {
  const storage = new Map([[prefix + 'test-page', JSON.stringify({
    version: 1, columns: {
      Header: { visible: false, selected: { '二': false } },
      type: { visible: 'false', selected: { A: 'false', B: false } },
      notes: null,
    },
  })]]);
  const page = fixture(t, { storage });
  assert.deepEqual(page.visibleColumns(), [true, true, false]);
  assert.deepEqual(page.visibleRows(), [true, false, true]);
  assert.equal(page.state().columns.Header.visible, true);
  assert.deepEqual(page.state().columns.type.selected, { A: true, B: false });
});

test('initial visibility reset preserves visible filters, applies hidden-filter policy', t => {
  for (const policy of ['clear', 'keep']) {
    const page = fixture(t, { policy });
    page.visibility(2, true);
    page.filter(2, 'Y', false);
    page.filter(1, 'A', false);
    page.openColumns();
    page.$('.table-columns-reset').click();
    assert.deepEqual(page.visibleColumns(), [true, true, false]);
    assert.deepEqual(page.visibleRows(), policy === 'keep' ? [false, false, false] : [false, true, false]);
    assert.equal(page.document.activeElement, page.$('.table-columns-reset'));
    assert.equal(page.$('#table-columns-panel').hidden, false);
    assert.equal(page.state().columns.type.selected.A, false);
  }
});

test('regeneration restores by original key, prunes old columns/values, selects new values', t => {
  const page = fixture(t, { policy: 'keep' });
  page.filter(1, 'A', false);
  page.filter(1, 'B', false);
  page.visibility(1, false);
  const reload = fixture(t, {
    policy: 'keep', storage: page.storage,
    columns: [defaults[0], { key: 'new', label: '新列', visible: false }, { key: 'type', label: '改名した種類' }],
    rows: [['一', 'N', 'B'], ['二', 'N', 'C']],
  });
  assert.deepEqual(reload.visibleColumns(), [true, false, false]);
  assert.deepEqual(reload.visibleRows(), [false, true]);
  assert.match(reload.$('#table-filter-status').textContent, /改名した種類/);
  const saved = reload.state().columns;
  assert.deepEqual(Object.keys(saved).sort(), ['Header', 'new', 'type']);
  assert.deepEqual(saved.type.selected, { B: false, C: true });
  assert.deepEqual(saved.new.selected, { N: true });
});

test('prototype-like original keys and values remain selectable and persist safely', t => {
  const columns = [defaults[0], { key: '__proto__', label: '<img src=x onerror=alert(1)>' },
    { key: 'constructor', label: 'constructor' }];
  const data = [['一', '__proto__', 'toString'], ['二', 'constructor', 'value']];
  const page = fixture(t, { columns, rows: data, policy: 'keep' });
  page.filter(1, '__proto__', false);
  assert.deepEqual(page.visibleRows(), [false, true]);
  page.visibility(1, false);
  assert.equal(page.$('#table-columns-panel img'), null);
  const reload = fixture(t, { columns, rows: data, policy: 'keep', storage: page.storage });
  assert.deepEqual(reload.visibleRows(), [false, true]);
  assert.equal(reload.state().columns.__proto__.selected.__proto__, false);
  assert.equal({}.polluted, undefined);
});

test('location fallback separates pages; explicit state key survives a changed URL', t => {
  const page = fixture(t, { stateKey: null });
  page.visibility(1, false);
  const reload = fixture(t, { stateKey: null, storage: page.storage });
  assert.deepEqual(reload.visibleColumns(), [true, false, false]);
  const other = fixture(t, { stateKey: null, storage: page.storage, url: 'https://example.test/other.html' });
  assert.deepEqual(other.visibleColumns(), [true, true, false]);
  const keyed = fixture(t, { stateKey: 'stable' });
  keyed.visibility(1, false);
  const relocated = fixture(t, { stateKey: 'stable', storage: keyed.storage, url: 'https://example.test/moved.html' });
  assert.deepEqual(relocated.visibleColumns(), [true, false, false]);
});

test('corrupt storage, incompatible versions, denied reads and failed writes do not break controls', t => {
  for (const raw of ['{broken', 'null', '42', '{"version":99,"columns":{}}']) {
    const page = fixture(t, { storage: new Map([[prefix + 'test-page', raw]]) });
    page.filter(1, 'A', false);
    assert.deepEqual(page.visibleRows(), [false, true, false]);
  }
  for (const storageThrows of ['read', 'write']) {
    const page = fixture(t, { storageThrows });
    page.filter(1, 'A', false);
    assert.deepEqual(page.visibleRows(), [false, true, false]);
    page.visibility(1, false);
    assert.deepEqual(page.visibleRows(), [true, true, true]);
  }
});

test('Escape, click away, mutual exclusion, close buttons and focus restoration', t => {
  const page = fixture(t);
  page.openColumns();
  page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(page.$('#table-columns-panel').hidden, true);
  assert.equal(page.document.activeElement, page.$('#table-columns-toggle'));
  assert.equal(page.$('#table-columns-toggle').getAttribute('aria-expanded'), 'false');
  page.openColumns();
  page.$('#outside').click();
  assert.equal(page.$('#table-columns-panel').hidden, true);
  page.openColumns();
  page.table.tHead.rows[0].cells[1].querySelector('button').click();
  assert.equal(page.$('#table-columns-panel').hidden, true);
  assert.equal(page.$('#table-filter-panel').hidden, false);
  page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(page.document.activeElement, page.table.tHead.rows[0].cells[1].querySelector('button'));
  page.openColumns();
  page.$('#table-columns-panel .table-filter-panel-close').click();
  assert.equal(page.document.activeElement, page.$('#table-columns-toggle'));
  page.openColumns();
  page.$('#outside').focus();
  assert.equal(page.$('#table-columns-panel').hidden, true);
  assert.equal(page.document.activeElement, page.$('#outside'));
});

test('Excel select all/none, combined filters, black/none/empty labels and empty table', t => {
  const page = fixture(t, { rows: [
    ['一', { black: true, label: '黒色' }, 'X'],
    ['二', { value: 'none', label: 'なし' }, 'Y'],
    ['三', '', 'Z'],
  ] });
  page.table.tHead.rows[0].cells[1].querySelector('button').click();
  assert.match(page.$('#table-filter-panel').textContent, /黒色.*なし.*空白/s);
  page.$('.table-filter-select-none').click();
  assert.deepEqual(page.visibleRows(), [false, false, false]);
  assert.equal(page.document.activeElement, page.$('.table-filter-select-none'));
  assert.equal(page.$('#table-filter-panel').hidden, false);
  page.$('.table-filter-select-all').click();
  assert.deepEqual(page.visibleRows(), [true, true, true]);
  page.filter(1, 'black', false);
  page.filter(0, '二', false);
  assert.deepEqual(page.visibleRows(), [false, false, true]);
  const empty = fixture(t, { rows: [] });
  empty.table.tHead.rows[0].cells[1].querySelector('button').click();
  assert.match(empty.$('#table-filter-panel').textContent, /項目がありません/);
  empty.$('.table-filter-select-none').click();
  assert.equal(empty.$('#table-filter-status').textContent, '全 0 件');
});

test('filter changes reuse cached cell values rather than rescanning table cells', t => {
  const page = fixture(t, { rows: Array.from({ length: 500 }, (_, i) => [String(i), i % 2 ? 'A' : 'B', 'N']) });
  for (const row of page.table.tBodies[0].rows) {
    for (const cell of row.cells) {
      cell.getAttribute = () => { throw new Error('unexpected repeated cell scan'); };
    }
  }
  page.filter(1, 'A', false);
  assert.equal(page.visibleRows().filter(Boolean).length, 250);
  page.filter(0, '0', false);
  assert.equal(page.visibleRows().filter(Boolean).length, 249);
});

test('text sort controls switch a single column, preserve row identity and reset original JSON order', t => {
  const page = fixture(t, { rows: [['3', 'A', 'X'], ['1', 'B', 'Y'], ['2', 'A', 'Z']] });
  const originalCells = page.originalRows.map(row => [...row.cells]);
  page.table.tHead.rows[0].cells[1].querySelector('button').click();
  assert.deepEqual([...page.document.querySelectorAll('[data-sort]')].map(b => b.textContent),
    ['昇順', '降順', '逆順', 'ソート解除']);
  const order = () => [...page.table.tBodies[0].rows].map(r => page.originalRows.indexOf(r));
  page.filter(1, 'B', false);
  page.sort(0, 'asc');
  assert.deepEqual(order(), [1, 2, 0]);
  assert.deepEqual(page.visibleRows(), [false, true, true]);
  page.filter(0, '2', false);
  assert.deepEqual(page.visibleRows(), [false, false, true]);
  page.sort(1, 'desc');
  // Equal A values use original order, not the preceding sort order.
  assert.deepEqual(order(), [1, 0, 2]);
  assert.deepEqual([...page.table.tHead.rows[0].cells].map(c => c.getAttribute('aria-sort')),
    ['none', 'descending', 'none']);
  page.sort(2, 'reset');
  assert.deepEqual(order(), [0, 1, 2]);
  assert.deepEqual(page.visibleRows(), [true, false, false]);
  assert.equal(page.state().sort, null);
  page.originalRows.forEach((row, index) => assert.deepEqual([...row.cells], originalCells[index]));
});

test('sorting uses display labels for links/multiline/colors, numeric order, stable ties and empty last', t => {
  const page = fixture(t, { rows: [
    ['0', { html: '<a href="https://z.test">項目2</a>', value: 'url-z', label: '項目2' }, ''],
    ['1', { html: '<div>項目</div><div>10</div>', value: 'raw-a', label: '項目10' }, ''],
    ['2', { html: '<a href="https://a.test">項目2</a>', value: 'url-a', label: '項目2' }, ''],
    ['3', { text: ' \n\t ' }, ''],
    ['4', { black: true, label: '黒' }, ''],
    ['5', { value: 'none', label: 'なし' }, ''],
  ] });
  const order = () => [...page.table.tBodies[0].rows].map(r => r.cells[0].textContent);
  page.sort(1, 'asc');
  assert.deepEqual(order(), ['5', '0', '2', '1', '4', '3']);
  page.filter(1, 'url-z', false);
  assert.equal(page.originalRows[0].hidden, true);
  assert.equal(page.originalRows[2].hidden, false);
  page.sort(1, 'desc');
  assert.deepEqual(order(), ['4', '1', '0', '2', '5', '3']);
  page.filter(1, 'black', false);
  assert.equal(page.originalRows[4].hidden, true);
  assert.ok(page.originalRows[4].cells[1].classList.contains('cell-black'));
});

// Nonmonotonic input makes reversal distinguishable from either sort direction.
// Duplicate values and two blanks also expose stable-tie and empty-last mistakes.
const reverseRows = [
  ['0', '項目2', 'X'], ['1', '', 'Y'], ['2', '項目10', 'Z'],
  ['3', '項目2', 'W'], ['4', '項目1', 'V'], ['5', '', 'U'],
];
const rowOrder = page => [...page.table.tBodies[0].rows].map(row => page.originalRows.indexOf(row));

function assertSortControls(page, index, { sort = null, reversed = false } = {}) {
  const toggle = page.table.tHead.rows[0].cells[index].querySelector('button');
  if (page.$('#table-filter-panel').hidden || toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  for (const direction of ['asc', 'desc', 'reverse', 'reset']) {
    const button = page.$(`#table-filter-panel [data-sort="${direction}"]`);
    assert.ok(button, `${direction} control exists`);
    const pressed = direction === 'reverse' ? reversed : direction === 'reset' ? !sort && !reversed :
      !reversed && !!(sort && sort.key === page.table.tHead.rows[0].cells[index].getAttribute('data-column-key') &&
        sort.direction === direction);
    assert.equal(button.getAttribute('aria-pressed'), String(pressed), `${direction} pressed state`);
  }
  assert.deepEqual([...page.table.tHead.rows[0].cells].map(header => header.getAttribute('aria-sort')),
    [...page.table.tHead.rows[0].cells].map(header => !sort || header.getAttribute('data-column-key') !== sort.key ?
      'none' : reversed ? 'other' : sort.direction === 'asc' ? 'ascending' : 'descending'));
}

test('reverse toggles the current DOM order including duplicates and blanks without sorting', t => {
  const page = fixture(t, { rows: reverseRows });
  const cells = page.originalRows.map(row => [...row.cells]);
  assertSortControls(page, 1);
  assert.equal(page.$('[data-sort="reverse"]').textContent, '逆順');
  page.sort(1, 'reverse');
  assert.deepEqual(rowOrder(page), [5, 4, 3, 2, 1, 0]);
  assert.equal(page.state().sort, null);
  assert.equal(page.state().reversed, true);
  assertSortControls(page, 1, { reversed: true });
  // Reversal is table-wide, even when invoked from a different column menu.
  page.sort(0, 'reverse');
  assert.deepEqual(rowOrder(page), [0, 1, 2, 3, 4, 5]);
  assert.equal(page.state().reversed, false);
  assertSortControls(page, 0);
  // An externally changed DOM order must be reversed as-is, not reconstructed.
  const current = [2, 0, 5, 3, 1, 4];
  current.forEach(index => page.table.tBodies[0].append(page.originalRows[index]));
  page.sort(0, 'reverse');
  assert.deepEqual(rowOrder(page), [4, 1, 3, 5, 0, 2]);
  page.originalRows.forEach((row, index) => assert.deepEqual([...row.cells], cells[index]));
});

test('reverse of asc/desc reverses stable ties and empty-last rows, then restores the sorted order', t => {
  for (const direction of ['asc', 'desc']) {
    const page = fixture(t, { rows: reverseRows });
    const sort = { key: 'type', direction };
    const ordered = direction === 'asc' ? [4, 0, 3, 2, 1, 5] : [2, 0, 3, 4, 1, 5];
    page.sort(1, direction);
    assert.deepEqual(rowOrder(page), ordered);
    assertSortControls(page, 1, { sort });
    page.sort(1, 'reverse');
    assert.deepEqual(rowOrder(page), [...ordered].reverse());
    assert.deepEqual(page.state().sort, sort, 'reverse retains the original comparator direction');
    assert.equal(page.state().reversed, true);
    assertSortControls(page, 1, { sort, reversed: true });
    assertSortControls(page, 0, { sort, reversed: true });
    page.sort(0, 'reverse');
    assert.deepEqual(rowOrder(page), ordered);
    assert.equal(page.state().reversed, false);
    assertSortControls(page, 1, { sort });
  }
});

test('reverse clicks never call Array.sort or construct a comparator after fixture initialization', t => {
  for (const sorted of [false, true]) {
    const page = fixture(t, { rows: reverseRows });
    if (sorted) page.sort(1, 'asc');
    assertSortControls(page, 1, { sort: sorted ? { key: 'type', direction: 'asc' } : null });
    const before = rowOrder(page);
    const originalSort = page.window.Array.prototype.sort;
    const OriginalCollator = page.window.Intl.Collator;
    let sortCalls = 0;
    let comparatorCalls = 0;
    page.window.Array.prototype.sort = function (...args) {
      sortCalls++;
      return originalSort.apply(this, args);
    };
    page.window.Intl.Collator = function (...args) {
      comparatorCalls++;
      return new OriginalCollator(...args);
    };
    try {
      page.sort(1, 'reverse');
      assert.deepEqual(rowOrder(page), [...before].reverse());
      page.sort(1, 'reverse');
      assert.deepEqual(rowOrder(page), before);
      assert.equal(sortCalls, 0, 'reverse must not call sort, even to rebuild the menu');
      assert.equal(comparatorCalls, 0, 'reverse must not reconstruct a comparator');
    } finally {
      page.window.Array.prototype.sort = originalSort;
      page.window.Intl.Collator = OriginalCollator;
    }
  }
});

test('hidden rows reverse too; filters retain row identity and clearing does not undo reversal', t => {
  const page = fixture(t, { rows: reverseRows });
  page.filter(1, '項目2', false);
  page.filter(0, '2', false);
  const hidden = () => page.originalRows.map(row => row.hidden);
  assert.deepEqual(hidden(), [true, false, true, true, false, false]);
  page.sort(1, 'reverse');
  assert.deepEqual(rowOrder(page), [5, 4, 3, 2, 1, 0]);
  assert.deepEqual(hidden(), [true, false, true, true, false, false]);
  page.filter(1, '__empty__', false);
  assert.deepEqual(hidden(), [true, true, true, true, false, true]);
  page.filter(1, '項目2', true);
  assert.deepEqual(hidden(), [false, true, true, false, false, true]);
  assert.deepEqual(rowOrder(page), [5, 4, 3, 2, 1, 0]);
  page.$('#table-filter-clear').click();
  assert.deepEqual(hidden(), [false, false, false, false, false, false]);
  assert.deepEqual(rowOrder(page), [5, 4, 3, 2, 1, 0]);
  assert.equal(page.state().sort, null);
  assert.equal(page.state().reversed, true);
  assertSortControls(page, 1, { reversed: true });
});

test('version1 persists reversal and reload reconstructs original sort then reverses all rows', t => {
  for (const direction of [null, 'asc', 'desc']) {
    const page = fixture(t, { rows: reverseRows });
    page.filter(1, '項目2', false);
    if (direction) page.sort(1, direction);
    page.sort(1, 'reverse');
    const saved = page.state();
    const sort = direction ? { key: 'type', direction } : null;
    assert.equal(saved.version, 1);
    assert.equal(saved.reversed, true);
    assert.deepEqual(saved.sort, sort);
    const reload = fixture(t, { rows: reverseRows, storage: page.storage });
    assert.deepEqual(rowOrder(reload), rowOrder(page));
    assert.deepEqual(reload.originalRows.map(row => row.hidden), [true, false, false, true, false, false]);
    assert.equal(reload.state().reversed, true);
    assert.deepEqual(reload.state().sort, sort);
    assertSortControls(reload, 1, { sort, reversed: true });
    reload.sort(0, 'reverse');
    assert.deepEqual(rowOrder(reload), direction === 'asc' ? [4, 0, 3, 2, 1, 5] :
      direction === 'desc' ? [2, 0, 3, 4, 1, 5] : [0, 1, 2, 3, 4, 5]);
    assert.equal(reload.state().reversed, false);
  }
});

test('old version1 states default reversal to false and only literal true restores reversal', t => {
  for (const flag of [undefined, false, true, 'true', 'false', 1, 0, null, {}, []]) {
    const sort = { key: 'type', direction: 'asc' };
    const saved = { version: 1, sort, columns: {} };
    if (flag !== undefined) saved.reversed = flag;
    const page = fixture(t, { rows: reverseRows,
      storage: new Map([[prefix + 'test-page', JSON.stringify(saved)]]) });
    const reversed = flag === true;
    assert.deepEqual(rowOrder(page), reversed ? [5, 1, 2, 3, 0, 4] : [4, 0, 3, 2, 1, 5]);
    assert.equal(page.state().reversed, reversed, `normalized flag ${JSON.stringify(flag)}`);
    assertSortControls(page, 1, { sort, reversed });
  }
  for (const version of [undefined, '1', 0, 2, 99, null]) {
    const page = fixture(t, { rows: reverseRows, storage: new Map([[prefix + 'test-page', JSON.stringify({
      version, reversed: true, sort: { key: 'type', direction: 'desc' }, columns: {},
    })]]) });
    assert.deepEqual(rowOrder(page), [0, 1, 2, 3, 4, 5]);
    assert.equal(page.state().sort, null);
    assert.equal(page.state().reversed, false);
    assertSortControls(page, 1);
  }
});

test('reset and new asc/desc sort clear reversal, including reselecting the same sort', t => {
  for (const initial of [null, 'asc', 'desc']) {
    for (const next of ['reset', 'asc', 'desc']) {
      const page = fixture(t, { rows: reverseRows });
      if (initial) page.sort(1, initial);
      page.sort(1, 'reverse');
      page.sort(1, next);
      const sort = next === 'reset' ? null : { key: 'type', direction: next };
      const expected = next === 'asc' ? [4, 0, 3, 2, 1, 5] :
        next === 'desc' ? [2, 0, 3, 4, 1, 5] : [0, 1, 2, 3, 4, 5];
      assert.deepEqual(rowOrder(page), expected);
      assert.equal(page.state().reversed, false);
      assert.deepEqual(page.state().sort, sort);
      assertSortControls(page, 1, { sort });
      const reload = fixture(t, { rows: reverseRows, storage: page.storage });
      assert.deepEqual(rowOrder(reload), expected);
      assert.equal(reload.state().reversed, false);
    }
  }
  const page = fixture(t, { rows: reverseRows });
  page.sort(1, 'asc');
  page.sort(1, 'reverse');
  page.sort(0, 'desc');
  assert.deepEqual(rowOrder(page), [5, 4, 3, 2, 1, 0]);
  assertSortControls(page, 0, { sort: { key: 'Header', direction: 'desc' } });
  assert.equal(page.state().reversed, false);
});

test('missing metadata falls back to visible link/multiline text and whitespace empty values', t => {
  const page = fixture(t, { rows: [
    ['0', { html: '<div>Alpha</div><div><a href="https://z.test">2</a></div>' }, ''],
    ['1', { html: '<a href="https://a.test">Alpha 10</a>' }, ''],
    ['2', { html: '<br> \n ' }, ''],
  ] });
  page.sort(1, 'desc');
  assert.deepEqual([...page.table.tBodies[0].rows].map(r => r.cells[0].textContent), ['1', '0', '2']);
  page.filter(1, 'Alpha 2', false);
  assert.equal(page.originalRows[0].hidden, true);
  page.filter(1, '__empty__', false);
  assert.equal(page.originalRows[2].hidden, true);
});

test('version1 adds sort/freezing, restores by key after reordering, and accepts old settings', t => {
  const page = fixture(t);
  page.visibility(2, true);
  page.freeze(2, true);
  page.filter(1, 'B', false);
  page.sort(0, 'asc');
  const saved = page.state();
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.sort, { key: 'Header', direction: 'asc' });
  assert.equal(saved.columns.notes.frozen, true);
  const reload = fixture(t, { storage: page.storage,
    columns: [defaults[0], defaults[2], defaults[1]],
    rows: defaultRows.map(([a, b, c]) => [a, c, b]),
  });
  assert.equal(reload.table.tHead.rows[0].cells[1].classList.contains('is-frozen'), true);
  assert.equal(reload.originalRows[1].hidden, true);
  assert.deepEqual(reload.state().sort, saved.sort);
  const old = fixture(t, { storage: new Map([[prefix + 'test-page', JSON.stringify({
    version: 1, columns: { type: { visible: false, selected: { B: false } } },
  })]]), policy: 'keep' });
  assert.deepEqual(old.visibleColumns(), [true, false, false]);
  assert.deepEqual(old.visibleRows(), [true, false, true]);
  assert.equal(old.state().sort, null);
  assert.deepEqual([...old.table.tHead.rows[0].cells].map(c => c.classList.contains('is-frozen')),
    [true, false, false]);
});

test('incompatible or malformed sort settings cannot restore sort alone', t => {
  for (const saved of [
    { version: 99, sort: { key: 'Header', direction: 'asc' } },
    { version: '1', sort: { key: 'Header', direction: 'asc' } },
    { sort: { key: 'Header', direction: 'asc' } },
    { version: 1, sort: { key: 'missing', direction: 'asc' } },
    { version: 1, sort: { key: 'Header', direction: 'invalid' } },
  ]) {
    const page = fixture(t, { storage: new Map([[prefix + 'test-page', JSON.stringify(saved)]]),
      rows: [['3', 'A', ''], ['1', 'B', ''], ['2', 'A', '']] });
    assert.deepEqual([...page.table.tBodies[0].rows], page.originalRows);
    assert.equal(page.state().sort, null);
    page.sort(0, 'asc');
    assert.equal(page.table.tBodies[0].rows[0], page.originalRows[1]);
  }
});

test('noncontiguous frozen columns use only visible frozen widths; reset and resize update all cells', t => {
  const widths = [80, 90, 100, 110];
  const page = fixture(t, {
    columns: [...defaults.map(c => ({ ...c, visible: true })), { key: 'extra', label: '追加' }],
    rows: [['3', 'A', { black: true }, 'x'], ['1', 'B', 'Y', 'y'], ['2', 'A', 'Z', 'z']],
    beforeInit({ table }) {
      [...table.tHead.rows[0].cells].forEach((c, i) => {
        c.getBoundingClientRect = () => ({ width: widths[i] });
      });
      for (const row of table.tBodies[0].rows) for (const cell of row.cells) {
        cell.getBoundingClientRect = () => { throw new Error('body width must not be measured'); };
      }
    },
  });
  function layout(index, frozen, left) {
    for (const row of page.table.rows) {
      assert.equal(row.cells[index].classList.contains('is-frozen'), frozen);
      assert.equal(row.cells[index].style.left, left);
    }
  }
  page.freeze(2, true);
  layout(0, true, '0px'); layout(1, false, ''); layout(2, true, '80px');
  page.window.dispatchEvent(new page.window.Event('scroll'));
  layout(2, true, '80px');
  page.freeze(1, true);
  layout(2, true, '170px');
  page.visibility(1, false);
  layout(1, false, ''); layout(2, true, '80px');
  page.visibility(1, true);
  layout(2, true, '170px');
  page.freeze(1, false);
  page.visibility(2, false);
  layout(2, false, '');
  page.visibility(2, true);
  layout(2, true, '80px');
  widths[0] = 120;
  page.window.dispatchEvent(new page.window.Event('resize'));
  layout(2, true, '120px');
  page.freeze(0, false);
  assert.equal(page.freezeChecks()[0].checked, true);
  assert.equal(page.freezeChecks()[0].disabled, true);
  layout(0, true, '0px');
  page.sort(0, 'asc');
  page.$('#table-filter-clear').click();
  assert.deepEqual(page.state().sort, { key: 'Header', direction: 'asc' });
  assert.equal(page.state().columns.notes.frozen, true);
  page.openColumns();
  page.$('.table-columns-reset').click();
  layout(0, true, '0px'); layout(2, false, '');
  assert.equal(page.freezeChecks()[2].checked, false);
  assert.equal(page.state().columns.notes.frozen, false);
  assert.deepEqual(page.state().sort, { key: 'Header', direction: 'asc' });
  page.sort(0, 'reset');
  assert.deepEqual([...page.table.tBodies[0].rows], page.originalRows);
  assert.ok(page.originalRows[0].cells[2].classList.contains('cell-black'));
});

test('sort, reset and row filtering recompute widths when table auto-layout changes', t => {
  let page;
  page = fixture(t, {
    rows: [['3', 'A', 'X'], ['1', 'B', 'Y'], ['2', 'A', 'Z']],
    beforeInit({ table }) {
      table.tHead.rows[0].cells[0].getBoundingClientRect = () => ({
        width: table.tBodies[0].rows[0].cells[0].textContent === '1' ? 100 :
          table.tBodies[0].rows[1].hidden ? 60 : 80,
      });
    },
  });
  page.freeze(1, true);
  const left = () => page.originalRows[0].cells[1].style.left;
  assert.equal(left(), '80px');
  page.sort(0, 'asc');
  assert.equal(left(), '100px');
  page.sort(0, 'reset');
  assert.equal(left(), '80px');
  page.filter(1, 'B', false);
  assert.equal(left(), '60px');
  page.$('#table-filter-clear').click();
  assert.equal(left(), '80px');
});

test('ResizeObserver batches header changes and unchanged layout produces no DOM mutations', async t => {
  let notify;
  const frames = [];
  const observed = [];
  let firstWidth = 80;
  let secondWidth = 90;
  let reads = 0;
  const page = fixture(t, { beforeInit({ window, table }) {
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    window.ResizeObserver = class {
      constructor(callback) { notify = callback; }
      observe(target) { observed.push(target); }
    };
    [...table.tHead.rows[0].cells].forEach((cell, index) => {
      cell.getBoundingClientRect = () => {
        reads++;
        return { width: index === 0 ? firstWidth : index === 1 ? secondWidth : 90 };
      };
    });
  } });
  page.freeze(1, true);
  assert.deepEqual(observed, [page.table, ...page.table.tHead.rows[0].cells]);
  const mutations = [];
  const observer = new page.window.MutationObserver(records => mutations.push(...records));
  observer.observe(page.table, { attributes: true, subtree: true });
  const beforeReads = reads;
  notify(); notify(); notify();
  assert.equal(frames.length, 1);
  assert.equal(reads, beforeReads, 'observer callback must defer layout reads/writes');
  frames.shift()();
  await Promise.resolve();
  assert.equal(reads - beforeReads, 2, 'only visible frozen headers measured');
  assert.equal(mutations.length, 0, 'unchanged layout must not feed observer loops');
  firstWidth = 140;
  secondWidth = 30; // Same total table width: only observing the table misses this redistribution.
  assert.equal(firstWidth + secondWidth, 170);
  notify(); frames.shift()();
  await Promise.resolve();
  assert.equal(page.originalRows[0].cells[1].style.left, '140px');
  assert.ok(mutations.length > 0);
  mutations.length = 0;
  notify(); frames.shift()();
  await Promise.resolve();
  assert.equal(mutations.length, 0);
  observer.disconnect();
});
