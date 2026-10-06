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
  window.eval(source);
  if (config.loading) document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const $ = selector => document.querySelector(selector);
  const checks = () => [...document.querySelectorAll('#table-columns-panel input')];
  function change(input, checked) {
    assert.ok(input, 'checkbox exists');
    input.checked = checked;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  function openColumns() {
    if ($('#table-columns-panel').hidden) $('#table-columns-toggle').click();
  }
  return {
    window, document, table, storage, $, change, checks, openColumns,
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
