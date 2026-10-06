// Run: JSDOM_PATH=/path/to/jsdom node --test tests/test_page_pins.cjs
// The explicit source/origin bridge models postMessage; real file:// storage
// and iframe delivery must also be checked in browser integration tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const source = fs.readFileSync(path.join(__dirname, '../js/page-pins.js'), 'utf8');
const channel = 'json2html:pins:v1';
const entries = [
  { id: '001/index.html', title: 'ページ1', url: '../001/index.html' },
  { id: '002/index.html', title: 'ページ2', url: '../002/index.html' },
  { id: '003/index.html', title: 'ページ3', url: '../003/index.html' },
  { id: 'index.html', title: 'ハブ', url: '../index.html' },
];
const state = ids => Object.fromEntries([...new Set(ids)].map((id, index) => [id, { version: 1, pinned: true, order: index + 1 }]));

function dom(t, url, metadata, body = '') {
  const instance = new JSDOM('<!doctype html><body>' + body + '</body>', { url, runScripts: 'outside-only' });
  t.after(() => instance.window.close());
  const w = instance.window;
  const script = w.document.createElement('script');
  script.type = 'application/json';
  script.id = 'json2html-pins';
  script.textContent = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  w.document.body.append(script);
  Object.defineProperty(w.document, 'readyState', { value: 'complete' });
  return w;
}

function dispatch(w, data, sourceWindow, origin) {
  w.dispatchEvent(new w.MessageEvent('message', { data, source: sourceWindow, origin }));
}

function store(t, options = {}) {
  const url = options.url || 'https://example.test/site/pin-state.html';
  const replies = [];
  const parent = options.parent || { postMessage: (data, origin) => replies.push({ data: JSON.parse(JSON.stringify(data)), origin }) };
  const w = dom(t, url, { role: 'store', entries: options.entries || entries });
  Object.defineProperty(w, 'parent', { value: parent });
  if (options.now !== undefined) w.Date.now = () => options.now;
  const keyURL = new URL(url);
  keyURL.search = '';
  keyURL.hash = '';
  const key = channel + ':' + keyURL.href;
  const itemKey = id => key + ':item:' + encodeURIComponent(id);
  const storage = options.storage || new Map();
  function seed(items) {
    Object.entries(items).forEach(([id, value]) => storage.set(itemKey(id), JSON.stringify(value)));
  }
  if (options.seed) seed(options.seed);
  if (options.raw !== undefined) storage.set(itemKey('001/index.html'), options.raw);
  const errors = { read: false, write: false, access: false, ...options.errors };
  const reads = [];
  const writes = [];
  const api = {
    getItem(k) {
      reads.push(k);
      if (errors.read) throw new Error('read blocked');
      return (options.readStorage || storage).get(k) ?? null;
    },
    setItem(k, value) {
      if (errors.write) throw new Error('quota');
      writes.push(k);
      storage.set(k, value);
      if (options.readStorage) options.readStorage.set(k, value);
    },
  };
  Object.defineProperty(w, 'localStorage', { get() { if (errors.access) throw new Error('denied'); return api; } });
  w.eval(source);
  let counter = 0;
  return {
    w, parent, replies, storage, key, itemKey, errors, seed, reads, writes,
    send(type = 'get', extra = {}, sender = parent, origin = new URL(url).origin) {
      dispatch(w, { channel, type, request_id: ++counter, ...extra }, sender, origin);
      return replies.at(-1)?.data;
    },
    // Summarize durable membership (not a single persisted list) for assertions.
    stored() {
      const items = (options.entries || entries).map(({ id }) => [id, JSON.parse(storage.get(itemKey(id)) || 'null')])
        .filter(([, value]) => value && value.pinned);
      items.sort(([a, av], [b, bv]) => av.order - bv.order || (a < b ? -1 : a > b ? 1 : 0));
      return { version: 1, ids: items.map(([id]) => id) };
    },
    storageEvent(k = itemKey('001/index.html')) { w.dispatchEvent(new w.StorageEvent('storage', { key: k })); },
  };
}

function client(t, options = {}) {
  const url = options.url || 'https://example.test/site/001/index.html';
  const config = {
    role: 'page', store_url: '../pin-state.html', current_id: '001/index.html',
    hub: false, entries, exclude_ids: [], ...options.config,
  };
  const body = '<button id="page-pin-toggle"></button><p id="page-pin-status" hidden></p>' +
    '<ul id="pin-list"></ul><p id="pin-empty"></p>';
  const w = dom(t, url, options.metadata ?? config, options.body ?? body);
  const timers = new Map();
  let timerId = 0;
  w.setTimeout = fn => { timers.set(++timerId, fn); return timerId; };
  w.clearTimeout = id => timers.delete(id);
  w.eval(source);
  const $ = selector => w.document.querySelector(selector);
  const frame = $('iframe');
  const sent = [];
  if (frame) frame.contentWindow.postMessage = (data, origin) => sent.push({ data, origin });
  const c = {
    w, $, config, frame, sent, timers,
    button: $('#page-pin-toggle'),
    status: () => $('#page-pin-status')?.textContent,
    load() { frame.dispatchEvent(new w.Event('load')); },
    reply(ids, overrides = {}, sender = frame.contentWindow, origin = new URL(frame.src).origin) {
      dispatch(w, { channel, type: 'state', request_id: sent.at(-1)?.data.request_id || 1, ids, error: null, recovered: false, ...overrides }, sender, origin);
    },
    links: () => [...w.document.querySelectorAll('#pin-list a')],
    timeout() { [...timers.values()].forEach(fn => fn()); },
  };
  return c;
}

function assertQuiet(c) {
  assert.equal(c.status(), '', 'Normal status must be empty, not merely visually hidden');
  assert.equal(c.$('#page-pin-status').hidden, true, 'Normal status must be hidden');
}

function assertWarning(c, pattern) {
  assert.match(c.status(), pattern);
  assert.equal(c.$('#page-pin-status').hidden, false, 'Errors and corruption warnings must be visible');
}

function bridge(t, options = {}) {
  const c = client(t, options);
  const s = store(t, { ...options.store, parent: c.w, url: c.frame.src });
  const outbound = [];
  c.w.postMessage = (data, origin) => {
    outbound.push({ data, origin });
    dispatch(c.w, data, c.frame.contentWindow, new URL(s.w.location.href).origin);
  };
  c.frame.contentWindow.postMessage = (data, origin) => {
    c.sent.push({ data, origin });
    dispatch(s.w, data, c.w, new URL(c.w.location.href).origin);
  };
  c.load();
  return { c, s, outbound };
}

test('store normalizes URL key, deduplicates, prunes unknown IDs and preserves insertion order', t => {
  const s = store(t, { url: 'https://example.test/site/pin-state.html?x=1#test', seed: state(['002/index.html', 'deleted', '002/index.html', '001/index.html']) });
  assert.deepEqual(s.send().ids, ['002/index.html', '001/index.html']);
  s.send('set', { id: '003/index.html', pinned: true });
  assert.deepEqual(s.stored(), { version: 1, ids: ['002/index.html', '001/index.html', '003/index.html'] });
  s.send('set', { id: '002/index.html', pinned: true });
  assert.deepEqual(s.stored().ids, ['002/index.html', '001/index.html', '003/index.html']);
  s.send('set', { id: '001/index.html', pinned: false });
  assert.deepEqual(s.stored().ids, ['002/index.html', '003/index.html']);
  assert.equal(s.key, channel + ':https://example.test/site/pin-state.html');
  assert.equal(s.replies[0].origin, 'https://example.test');
  assert.equal(s.reads.includes(s.itemKey('deleted')), false);
  assert.equal(s.storage.has(s.key), false, 'no shared list written');
  assert.equal(JSON.parse(s.storage.get(s.itemKey('001/index.html'))).pinned, false, 'unpin writes one tombstone');
});

test('store rejects non-parent sources, mismatched origins and malformed mutations', t => {
  const s = store(t);
  s.send('get', {}, {}, 'https://example.test');
  s.send('get', {}, s.parent, 'https://attacker.test');
  s.send('get', {}, s.parent, 'null');
  for (const bad of [
    { id: 'unknown', pinned: true }, { id: '001/index.html', pinned: 'true' },
    { id: '001/index.html', pinned: true, request_id: 0 },
    { id: '001/index.html', pinned: true, channel: 'other' },
  ]) s.send('set', bad);
  assert.equal(s.replies.length, 0);
  assert.equal(s.storage.size, 0);
});

test('file store accepts only parent/null-origin messages and does not broadcast before handshake', t => {
  const s = store(t, { url: 'file:///site/pin-state.html?x=1#hash' });
  s.storageEvent();
  s.w.dispatchEvent(new s.w.Event('focus'));
  assert.equal(s.replies.length, 0);
  s.send('get', {}, s.parent, 'https://attacker.test');
  s.send('get', {}, {}, 'null');
  assert.equal(s.replies.length, 0);
  s.send();
  assert.equal(s.replies[0].origin, '*');
  assert.equal(s.key, channel + ':file:///site/pin-state.html');
});

test('corrupt/version-mismatched/non-string storage recovers empty, repaired on explicit mutation', t => {
  for (const raw of ['{', 'null', '[]', '{"version":2,"ids":[]}', '{"version":1,"ids":"bad"}', '{"version":1,"ids":[{"url":"javascript:alert(1)"}]}']) {
    const s = store(t, { raw });
    const result = s.send();
    assert.equal(result.recovered, true);
    assert.deepEqual(result.ids, []);
    assert.equal(s.storage.get(s.itemKey('001/index.html')), raw, 'get does not overwrite corrupt data');
    s.send('set', { id: '001/index.html', pinned: true });
    assert.deepEqual(s.stored(), { version: 1, ids: ['001/index.html'] });
  }
});

test('storage access and read exceptions produce error; failed set retains authoritative state', t => {
  for (const failure of ['access', 'read']) {
    const s = store(t, { errors: { [failure]: true } });
    assert.equal(s.send().error, 'read');
    assert.equal(s.send('set', { id: '001/index.html', pinned: true }).error, 'read');
    assert.equal(s.storage.size, 0);
  }
  const s = store(t, { seed: state(['002/index.html']), errors: { write: true } });
  const failed = s.send('set', { id: '001/index.html', pinned: true });
  assert.equal(failed.error, 'write');
  assert.deepEqual(failed.ids, ['002/index.html']);
  assert.deepEqual(s.stored().ids, ['002/index.html']);
});

test('each mutation reads latest shared storage instead of overwriting other client additions', t => {
  const shared = new Map();
  const a = store(t, { storage: shared });
  const b = store(t, { storage: shared });
  a.send(); b.send();
  a.send('set', { id: '001/index.html', pinned: true });
  b.send('set', { id: '002/index.html', pinned: true });
  assert.deepEqual(b.stored().ids, ['001/index.html', '002/index.html']);
});

test('storage changes, clear and focus broadcast a fresh state only to parent', t => {
  const s = store(t);
  s.send();
  s.seed(state(['003/index.html']));
  s.storageEvent('unrelated');
  assert.equal(s.replies.length, 1);
  s.storageEvent();
  assert.equal(s.replies.at(-1).data.request_id, 0);
  assert.deepEqual(s.replies.at(-1).data.ids, ['003/index.html']);
  s.storage.clear();
  s.storageEvent(null);
  assert.deepEqual(s.replies.at(-1).data.ids, []);
  s.w.dispatchEvent(new s.w.Event('focus'));
  assert.equal(s.replies.length, 4);
});

test('client creates hidden accessible store iframe and only trusts its exact source/origin', t => {
  const c = client(t, { config: { store_url: '../pin-state.html?ignored=1#hash' } });
  assert.equal(c.frame.hidden, true);
  assert.equal(c.frame.getAttribute('aria-hidden'), 'true');
  assert.equal(c.frame.title, 'ピン留め保存領域');
  assert.equal(c.frame.src, 'https://example.test/site/pin-state.html');
  assert.equal(c.button.disabled, true);
  assertQuiet(c);
  c.load();
  assertQuiet(c);
  assert.equal(c.sent[0].data.type, 'get');
  assert.equal(c.sent[0].origin, 'https://example.test');
  c.reply(['001/index.html'], {}, c.w);
  c.reply(['001/index.html'], {}, c.frame.contentWindow, 'https://attacker.test');
  c.reply(['001/index.html'], {}, c.frame.contentWindow, 'null');
  assert.equal(c.button.disabled, true);
  c.reply([]);
  assert.equal(c.button.disabled, false);
  assert.equal(c.button.getAttribute('aria-pressed'), 'false');
  assertQuiet(c);
});

test('file client bridge persists toggle and unpin without optimistic saved state', t => {
  const { c, s, outbound } = bridge(t, { url: 'file:///site/001/index.html' });
  assert.equal(c.sent[0].origin, '*');
  c.button.click();
  assert.deepEqual(s.stored().ids, ['001/index.html']);
  assert.equal(c.button.textContent, 'ピン留めを解除');
  assert.equal(c.button.getAttribute('aria-pressed'), 'true');
  assertQuiet(c);
  c.button.click();
  assert.deepEqual(s.stored().ids, []);
  assert.equal(c.button.textContent, 'ピン留め');
  assert.equal(c.button.getAttribute('aria-pressed'), 'false');
  assertQuiet(c);
  assert.equal(outbound.at(-1).origin, '*');
  const unbridged = client(t);
  unbridged.load(); unbridged.reply([]); unbridged.button.click();
  assert.equal(unbridged.button.disabled, true);
  assertQuiet(unbridged);
  assert.equal(unbridged.button.getAttribute('aria-pressed'), 'false');
  assert.equal(unbridged.button.textContent, 'ピン留め');
  unbridged.reply(['001/index.html']);
  assert.equal(unbridged.button.disabled, false);
  assert.equal(unbridged.button.getAttribute('aria-pressed'), 'true');
  assert.equal(unbridged.button.textContent, 'ピン留めを解除');
  assertQuiet(unbridged);
  unbridged.button.click();
  assert.equal(unbridged.button.disabled, true);
  assert.equal(unbridged.button.getAttribute('aria-pressed'), 'true');
  assert.equal(unbridged.button.textContent, 'ピン留めを解除');
  assertQuiet(unbridged);
  unbridged.reply([]);
  assert.equal(unbridged.button.disabled, false);
  assert.equal(unbridged.button.getAttribute('aria-pressed'), 'false');
  assert.equal(unbridged.button.textContent, 'ピン留め');
  assertQuiet(unbridged);
});

test('client rejects malformed, stale and unsolicited responses while a request is pending', t => {
  const c = client(t);
  c.load();
  for (const change of [{ request_id: 0 }, { request_id: 9 }, { channel: 'bad' }, { type: 'get' }, { error: 'invented' }, { recovered: 'yes' }, { ids: [{ href: 'javascript:alert(1)' }] }]) c.reply(['001/index.html'], change);
  assert.equal(c.button.disabled, true);
  c.reply([]);
  c.reply(['001/index.html']); // stale request_id after completion
  assert.equal(c.button.getAttribute('aria-pressed'), 'false');
  c.reply(['001/index.html'], { request_id: 0 });
  assert.equal(c.button.getAttribute('aria-pressed'), 'true');
});

test('client storage errors are visible, never claim saved, and read failures disable actions', t => {
  const { c, s } = bridge(t);
  s.errors.write = true;
  c.button.click();
  assertWarning(c, /保存できませんでした/);
  assert.equal(c.button.getAttribute('aria-pressed'), 'false');
  assert.equal(s.storage.size, 0);
  s.errors.write = false;
  c.button.click();
  assert.equal(c.button.getAttribute('aria-pressed'), 'true');
  assertQuiet(c);
  s.errors.read = true;
  c.w.dispatchEvent(new c.w.Event('focus'));
  assertWarning(c, /読み込めません/);
  assert.equal(c.button.disabled, true);
  s.errors.read = false;
  c.w.dispatchEvent(new c.w.Event('pageshow'));
  assert.equal(c.button.disabled, false);
  assert.equal(c.button.getAttribute('aria-pressed'), 'true');
  assertQuiet(c);
});

test('page and menu corruption warnings disappear after successful recovery', t => {
  for (const menu of [false, true]) {
    const { c, s } = bridge(t, {
      config: menu ? { role: 'menu', hub: true, current_id: 'index.html' } : {},
      store: { raw: 'corrupt' },
    });
    assertWarning(c, /壊れている/);
    if (menu) {
      s.seed(state(['001/index.html']));
      s.storageEvent();
      assert.equal(c.links().length, 1);
    } else {
      assert.equal(c.button.disabled, false);
      c.button.click();
      assert.equal(c.button.getAttribute('aria-pressed'), 'true');
    }
    assertQuiet(c);
  }
});

test('normal and hub pages keep errors visible during retry until a successful response', t => {
  for (const hub of [false, true]) {
    const current_id = hub ? 'index.html' : '001/index.html';
    const c = client(t, { config: { hub, current_id } });
    c.load(); c.reply([current_id]);
    const action = c.button;
    action.click();
    c.reply([current_id], { error: 'write' });
    assertWarning(c, /保存できませんでした/);
    action.click();
    assert.equal(action.disabled, true);
    assertWarning(c, /保存できませんでした/);
    assert.equal(c.button.getAttribute('aria-pressed'), 'true');
    c.reply([]);
    assertQuiet(c);
    assert.equal(c.button.getAttribute('aria-pressed'), 'false');
    c.w.dispatchEvent(new c.w.Event('focus'));
    c.reply([], { error: 'read' });
    assertWarning(c, /読み込めません/);
    c.w.dispatchEvent(new c.w.Event('pageshow'));
    assertWarning(c, /読み込めません/);
    c.reply([]);
    assertQuiet(c);
  }
});

test('link-only menu keeps read errors visible during retry until a successful response', t => {
  const c = client(t, { config: { role: 'menu', hub: true, current_id: 'index.html' } });
  c.load(); c.reply([], { error: 'read' });
  assertWarning(c, /読み込めません/);
  c.w.dispatchEvent(new c.w.Event('pageshow'));
  assertWarning(c, /読み込めません/);
  c.reply(['001/index.html']);
  assertQuiet(c);
  assert.equal(c.links().length, 1);
  assert.equal(c.$('#pin-list button'), null);
  assert.ok(c.sent.every(({ data }) => data.type === 'get'));
});

test('page and menu remain quiet during background reads and unsolicited normal updates', t => {
  for (const menu of [false, true]) {
    const c = client(t, { config: menu ? { role: 'menu', hub: true, current_id: 'index.html' } : {} });
    assertQuiet(c);
    if (menu) {
      assert.equal(c.$('#pin-empty').hidden, true);
      assert.equal(c.$('#pin-empty').textContent, '');
    }
    c.load(); c.reply(['001/index.html']);
    assertQuiet(c);
    for (const name of ['focus', 'pageshow', 'json2html:pins-refresh']) {
      c.w.dispatchEvent(new c.w.Event(name));
      assert.equal(c.sent.at(-1).data.type, 'get');
      assertQuiet(c);
      c.reply(['001/index.html']);
      assertQuiet(c);
    }
    c.reply([], { request_id: 0 });
    assertQuiet(c);
    if (menu) {
      assert.equal(c.links().length, 0);
      assert.equal(c.$('#pin-empty').hidden, false);
      assert.match(c.$('#pin-empty').textContent, /ありません/);
    } else assert.equal(c.button.getAttribute('aria-pressed'), 'false');
  }
});

test('link-only menu uses canonical entries, excludes self/hub duplicates and sorts hints', t => {
  const c = client(t, { config: { role: 'menu', hub: true, current_id: 'index.html', exclude_ids: ['index.html', '002/index.html'], order: ['003/index.html', 'missing', '003/index.html'] } });
  assertQuiet(c);
  c.load();
  assertQuiet(c);
  c.reply(['001/index.html', 'javascript:alert(1)', 'index.html', '002/index.html', '003/index.html', '001/index.html']);
  assert.deepEqual(c.links().map(a => a.textContent), ['ページ3', 'ページ1']);
  assert.deepEqual(c.links().map(a => a.getAttribute('href')), ['../003/index.html', '../001/index.html']);
  assert.ok(c.links().every(a => a.target === '_top'));
  assert.ok(c.links().every(a => a.parentElement.className === 'menu-item menu-relation-parent'));
  assert.ok(c.links().every(a => a.parentElement.children.length === 1));
  assert.equal(c.$('#pin-list button'), null);
  assert.equal(c.$('.pin-remove'), null);
  assert.equal(c.$('#pin-empty').hidden, true);
  assertQuiet(c);
  c.button.click();
  assert.ok(c.sent.every(({ data }) => data.type === 'get'), 'menu cannot mutate pins');
  c.reply([], { request_id: 0 });
  assert.equal(c.$('#pin-empty').hidden, false);
  assert.match(c.$('#pin-empty').textContent, /ありません/);
  assertQuiet(c);
});

test('only displayed page toggle unpins; menu refreshes and unknown/deleted IDs never become links', t => {
  const storage = new Map();
  const { c, s } = bridge(t, { config: { role: 'menu', hub: true, current_id: 'index.html' }, store: { storage, seed: state(['001/index.html', 'deleted']) } });
  const page = bridge(t, { store: { storage } });
  assert.equal(c.links().length, 1);
  assert.equal(c.$('#pin-list button'), null);
  assert.equal(page.c.button.getAttribute('aria-pressed'), 'true');
  page.c.button.click();
  assert.deepEqual(s.stored().ids, []);
  s.storageEvent();
  assert.equal(c.links().length, 0);
  assert.equal(s.writes.length, 0, 'menu store only reads shared membership');
  assert.deepEqual(page.s.writes, [page.s.itemKey('001/index.html')]);
});

test('menu preserves exact anchor and focused pointer target across focus/pageshow refresh', t => {
  for (const entry of [entries[0], { id: '%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%20%25/index.html', title: '日本語 # %', url: '../%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%20%25/index.html' }]) {
    const c = client(t, { config: { role: 'menu', hub: true, current_id: 'index.html', entries: [entry] } });
    c.load(); c.reply([entry.id]);
    const link = c.links()[0];
    const row = link.parentElement;
    assert.equal(c.$('#pin-list button'), null);
    link.focus();
    link.dispatchEvent(new c.w.Event('pointerdown', { bubbles: true }));
    const observer = new c.w.MutationObserver(() => {});
    observer.observe(c.$('#pin-list'), { childList: true, subtree: true });
    for (const name of ['focus', 'pageshow']) {
      c.w.dispatchEvent(new c.w.Event(name));
      assertQuiet(c);
      assert.equal(c.links()[0], link);
      assert.equal(c.w.document.activeElement, link);
      c.reply([entry.id]);
      assert.equal(c.links()[0], link);
      assert.equal(c.$('#pin-list button'), null);
      assert.equal(link.parentElement, row);
      assert.equal(c.w.document.activeElement, link);
      assert.equal(observer.takeRecords().length, 0, 'no child detach, text replacement, or move');
      assertQuiet(c);
    }
    link.dispatchEvent(new c.w.Event('pointerup', { bubbles: true }));
    let clicked = false;
    link.addEventListener('click', event => { event.preventDefault(); clicked = true; });
    link.click();
    assert.equal(clicked, true);
    c.w.dispatchEvent(new c.w.Event('focus'));
    c.reply([entry.id], { error: 'read' });
    assertWarning(c, /読み込めません/);
    assert.equal(c.links()[0], link, 'failed refresh retains anchors');
    assert.ok(c.sent.every(({ data }) => data.type === 'get'));
    assert.equal(observer.takeRecords().length, 0);
    observer.disconnect();
  }
});

test('changed menu membership/order only removes missing rows and reuses remaining links', t => {
  const c = client(t, { config: { role: 'menu', hub: true, current_id: 'index.html' } });
  c.load(); c.reply(['001/index.html', '002/index.html']);
  const [first, second] = c.links();
  c.reply(['002/index.html', '003/index.html', '001/index.html'], { request_id: 0 });
  assert.equal(c.links()[0], second);
  assert.equal(c.links()[2], first);
  const third = c.links()[1];
  second.focus();
  c.reply(['002/index.html', '003/index.html'], { request_id: 0 });
  assert.equal(first.isConnected, false);
  assert.equal(c.links()[0], second);
  assert.equal(c.links()[1], third);
  assert.equal(c.w.document.activeElement, second);
});

test('normal and hub page toggles supersede a pending background get; stale reply is ignored', t => {
  for (const hub of [false, true]) {
    const current_id = hub ? 'index.html' : '001/index.html';
    const c = client(t, { config: { hub, current_id } });
    c.load(); c.reply([current_id]);
    c.w.dispatchEvent(new c.w.Event('focus'));
    const getId = c.sent.at(-1).data.request_id;
    const action = c.button;
    assert.equal(action.disabled, false);
    action.click();
    assert.equal(c.sent.at(-1).data.type, 'set');
    assert.equal(c.sent.at(-1).data.id, current_id);
    assert.equal(c.sent.at(-1).data.pinned, false);
    const setId = c.sent.at(-1).data.request_id;
    assert.ok(setId > getId);
    c.reply([current_id], { request_id: getId });
    assertQuiet(c);
    assert.equal(action.disabled, true);
    c.reply([], { request_id: setId });
    assert.equal(c.button.getAttribute('aria-pressed'), 'false');
    assertQuiet(c);
  }
});

test('titles are plain text, malicious canonical URLs/IDs rejected, encoded filenames supported', t => {
  const safe = { id: 'my%20folder/%23file.html', title: '<img src=x onerror=alert(1)>', url: '../my%20folder/%23file.html' };
  const bad = [
    { id: 'x.html', title: 'X', url: 'javascript:alert(1)' },
    { id: 'y.html', title: 'Y', url: 'https://attacker.test/steal' },
    { id: 'z.html', title: 'Z', url: '//attacker.test/steal' },
    { id: 'w.html', title: 'W', url: '\\attacker.test/steal' },
    { id: '../escape.html', title: 'escape', url: 'escape.html' },
  ];
  const c = client(t, { config: { role: 'menu', hub: true, entries: [safe, ...bad] } });
  c.load(); c.reply([safe.id, ...bad.map(e => e.id)]);
  assert.equal(c.links().length, 1);
  assert.equal(c.links()[0].textContent, safe.title);
  assert.equal(c.$('#pin-list img'), null);
  assert.match(c.links()[0].href, /my%20folder\/%23file.html$/);
});

test('unknown page IDs and menu roles cannot toggle; nonhub menu does not populate pin list', t => {
  for (const config of [{ current_id: 'missing' }, { hub: true, current_id: 'missing' }, { role: 'menu', hub: false }, { role: 'menu', hub: true, current_id: '001/index.html' }]) {
    const c = client(t, { config });
    c.load(); c.reply(['001/index.html']);
    assert.equal(c.button.disabled, true);
    c.button.click();
    assert.equal(c.sent.length, 1);
    assert.equal(c.links().length, 0);
  }
});

test('exclude_ids never blocks normal/ROOT/hub page toggles or changes their saved canonical IDs', t => {
  for (const { current_id, hub } of [
    { current_id: '001/index.html', hub: false },
    { current_id: 'index.html', hub: false },
    { current_id: 'index.html', hub: true },
    { current_id: '003/index.html', hub: true },
  ]) {
    for (const base of ['https://example.test/site/', 'file:///site/']) {
      const store_url = current_id.includes('/') ? '../pin-state.html' : 'pin-state.html';
      const { c, s } = bridge(t, {
        url: base + current_id,
        config: { current_id, hub, store_url, exclude_ids: [current_id] },
      });
      assert.equal(c.frame.src, base + 'pin-state.html');
      assert.equal(c.button.disabled, false);
      c.button.click();
      assert.deepEqual(s.stored().ids, [current_id]);
      assert.equal(c.button.getAttribute('aria-pressed'), 'true');
      assert.equal(c.button.textContent, 'ピン留めを解除');
      assertQuiet(c);
      c.button.click();
      assert.deepEqual(s.stored().ids, []);
      assert.equal(c.button.getAttribute('aria-pressed'), 'false');
      assert.deepEqual(s.writes, [s.itemKey(current_id), s.itemKey(current_id)]);
      assertQuiet(c);
    }
  }
});

test('independent per-ID writes survive simultaneous tabs with stale reads and no shared Web Locks', t => {
  const storage = new Map();
  const a = store(t, { storage, readStorage: new Map(), now: 1000 });
  const b = store(t, { storage, readStorage: new Map(), now: 1000 });
  a.send('set', { id: '001/index.html', pinned: true });
  b.send('set', { id: '002/index.html', pinned: true });
  assert.deepEqual(a.stored().ids, ['001/index.html', '002/index.html']);
  assert.deepEqual(a.writes, [a.itemKey('001/index.html')]);
  assert.deepEqual(b.writes, [b.itemKey('002/index.html')]);
  assert.deepEqual(b.send().ids, ['002/index.html'], 'second tab genuinely has stale reads');
  const fresh = store(t, { storage });
  assert.deepEqual(fresh.send().ids, ['001/index.html', '002/index.html'], 'durable memberships both survive');
  a.send('set', { id: '001/index.html', pinned: false });
  b.send('set', { id: '003/index.html', pinned: true });
  assert.deepEqual(a.stored().ids, ['002/index.html', '003/index.html']);
  assert.deepEqual(fresh.send().ids, ['002/index.html', '003/index.html']);
});

test('same-time pins use canonical ID tie break; repeated pin preserves order; repin moves to end', t => {
  const storage = new Map();
  const a = store(t, { storage, readStorage: new Map(), now: 1000 });
  const b = store(t, { storage, readStorage: new Map(), now: 1000 });
  b.send('set', { id: '002/index.html', pinned: true });
  a.send('set', { id: '001/index.html', pinned: true });
  const fresh = store(t, { storage, now: 1000 });
  assert.deepEqual(fresh.send().ids, ['001/index.html', '002/index.html']);
  const firstRaw = storage.get(fresh.itemKey('001/index.html'));
  assert.deepEqual(JSON.parse(firstRaw), { version: 1, pinned: true, order: 1000 });
  fresh.send('set', { id: '001/index.html', pinned: true });
  assert.equal(storage.get(fresh.itemKey('001/index.html')), firstRaw);
  fresh.send('set', { id: '001/index.html', pinned: false });
  fresh.send('set', { id: '001/index.html', pinned: true });
  assert.deepEqual(fresh.send().ids, ['002/index.html', '001/index.html']);
});

test('corrupt membership is skipped without hiding healthy pins or reading unrelated storage', t => {
  const s = store(t, { raw: '{', seed: state(['002/index.html']) });
  s.storage.set('unrelated-secret', 'private');
  s.storage.set(s.key, JSON.stringify({ version: 1, ids: ['003/index.html'] }));
  const result = s.send();
  assert.equal(result.recovered, true);
  assert.deepEqual(result.ids, ['002/index.html']);
  assert.deepEqual(s.reads, entries.map(({ id }) => s.itemKey(id)));
  s.send('set', { id: '001/index.html', pinned: true });
  assert.equal(s.send().recovered, false);
  assert.deepEqual(s.writes, [s.itemKey('001/index.html')]);
});

test('item validation rejects invalid flags, versions and order values without trusting stored URLs', t => {
  for (const value of [
    { version: 2, pinned: true, order: 1 }, { version: 1, pinned: 'true', order: 1 },
    { version: 1, pinned: true, order: -1 }, { version: 1, pinned: true, order: 1.5 },
    { version: 1, pinned: true, order: Number.MAX_SAFE_INTEGER + 1 },
    { version: 1, pinned: true, order: 'https://attacker.test' },
  ]) {
    const s = store(t, { seed: { '001/index.html': value } });
    assert.equal(s.send().recovered, true);
    assert.deepEqual(s.send().ids, []);
  }
  const s = store(t, { seed: { '001/index.html': { version: 1, pinned: true, order: 1, url: 'javascript:alert(1)', title: '<img>' } } });
  const reply = s.send();
  assert.deepEqual(reply.ids, ['001/index.html']);
  assert.deepEqual(Object.keys(reply).sort(), ['channel', 'error', 'ids', 'recovered', 'request_id', 'type']);
});

test('percent-encoded Japanese, spaces, hash, percent, question mark and colon IDs are pinnable', t => {
  const id = encodeURIComponent('日本語 # %?:') + '/index.html';
  const special = [{ id, title: '日本語 # %?:', url: '../' + id }];
  const { c, s } = bridge(t, { config: { current_id: id, entries: special }, store: { entries: special } });
  c.button.click();
  assert.deepEqual(s.stored().ids, [id]);
  assert.equal(c.button.getAttribute('aria-pressed'), 'true');
  assertQuiet(c);
});

test('iframe error, load timeout and operation timeout disable UI with meaningful status', t => {
  const loading = client(t);
  loading.timeout();
  assert.equal(loading.button.disabled, true);
  assertWarning(loading, /応答がありません/);
  const failed = client(t);
  failed.frame.dispatchEvent(new failed.w.Event('error'));
  assertWarning(failed, /pin-state.html/);
  assert.equal(failed.button.disabled, true);
  const saving = client(t);
  saving.load(); saving.reply([]); saving.button.click(); saving.timeout();
  assertWarning(saving, /保存結果を確認できません/);
  assert.equal(saving.button.disabled, true);
  saving.w.dispatchEvent(new saving.w.Event('focus'));
  saving.reply(['001/index.html']);
  assert.equal(saving.button.getAttribute('aria-pressed'), 'true');
  assertQuiet(saving);
});

test('focus, pageshow, explicit menu refresh and storage event re-read current state', t => {
  const { c, s } = bridge(t);
  for (const name of ['focus', 'pageshow', 'json2html:pins-refresh']) {
    s.seed(state(['001/index.html']));
    c.w.dispatchEvent(new c.w.Event(name));
    assert.equal(c.button.getAttribute('aria-pressed'), 'true');
    assertQuiet(c);
    s.seed({ '001/index.html': { version: 1, pinned: false, order: 2 } });
    s.storageEvent();
    assert.equal(c.button.getAttribute('aria-pressed'), 'false');
    assertQuiet(c);
  }
});

test('successful page mutation explicitly refreshes same-origin menu frame', t => {
  const { c } = bridge(t);
  const menu = c.w.document.createElement('iframe');
  menu.className = 'menu-frame';
  c.w.document.body.append(menu);
  let refreshed = 0;
  menu.contentWindow.addEventListener('json2html:pins-refresh', () => refreshed++);
  c.button.click();
  assert.equal(refreshed, 1);
});

test('invalid metadata and external store URLs fail safely without any iframe or leakage', t => {
  for (const metadata of ['bad json', { role: 'unknown', entries: [] }, { role: 'page', entries, store_url: 'https://attacker.test/store' }]) {
    const c = client(t, { metadata });
    assert.equal(c.frame, null);
    assert.equal(c.button.disabled, true);
    assertWarning(c, /設定|保存先/);
  }
});

test('missing status is created for visible failures and script initialization is idempotent', t => {
  const c = client(t, { body: '<button id="page-pin-toggle"></button>' });
  c.w.eval(source);
  assert.equal(c.w.document.querySelectorAll('iframe').length, 1);
  c.timeout();
  assertWarning(c, /応答がありません/);
  assert.equal(c.$('#page-pin-status').getAttribute('role'), 'status');
});
