/* Shared pin store protocol (v1):
 * client -> store: {channel, type:'get'|'set', request_id, id?, pinned?}
 * store -> client: {channel, type:'state', request_id, ids, error, recovered}
 * request_id: positive safe integer; 0 is an unsolicited storage/focus update.
 * set writes only that canonical ID's membership key; never a shared list.
 * Storage key: channel + ':' + storeURL + ':item:' + encodeURIComponent(id).
 * Value: {version:1, pinned:boolean, order:nonnegative safe integer}.
 * order is a monotonic millisecond timestamp; equal times sort by canonical ID.
 * Titles/URLs are never stored. Legacy whole-list keys are not read/migrated.
 */
(function () {
  'use strict';
  const CHANNEL = 'json2html:pins:v1';
  const TIMEOUT = 8000;
  const REFRESH = 'json2html:pins-refresh';

  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validId(id) {
    if (typeof id !== 'string' || !id || /[\s\\:?#]/.test(id) || id.startsWith('/')) return false;
    try {
      return id.split('/').every(part => {
        const decoded = decodeURIComponent(part);
        return decoded && decoded !== '.' && decoded !== '..' && !/[/\\\x00-\x1f\x7f]/.test(decoded);
      });
    } catch (_) { return false; }
  }

  function idsOnly(ids, entries) {
    return [...new Set(ids.filter(id => typeof id === 'string' && entries.has(id)))];
  }

  function localURL(value) {
    if (typeof value !== 'string' || !value || /^[\s/\\]/.test(value) || /[\\\x00-\x1f]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
    try {
      const url = new URL(value, window.location.href);
      if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.protocol !== window.location.protocol || url.origin !== window.location.origin) return null;
      return url;
    } catch (_) { return null; }
  }

  function trusted(event, source, url) {
    if (event.source !== source) return false;
    return url.protocol === 'file:'
      ? window.location.protocol === 'file:' && event.origin === 'null'
      : ['http:', 'https:'].includes(url.protocol) && event.origin === url.origin;
  }

  function start() {
    const metadata = document.getElementById('json2html-pins');
    if (!metadata || metadata.dataset.pinsInitialized) return;
    metadata.dataset.pinsInitialized = 'true';
    let config;
    const toggle = document.getElementById('page-pin-toggle');
    let status = document.getElementById('page-pin-status');
    function message(text = '', error = false) {
      if (!status) {
        status = document.createElement('p');
        status.id = 'page-pin-status';
        status.hidden = true;
        document.body.append(status);
      }
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = error ? text : '';
      status.hidden = !error;
      status.classList.toggle('pin-status-error', error);
    }
    message();
    if (toggle) {
      toggle.type = 'button';
      toggle.classList.add('table-filter-clear');
      toggle.disabled = true;
      toggle.setAttribute('aria-pressed', 'false');
      toggle.textContent = 'ピン留め';
    }
    try {
      config = JSON.parse(metadata.textContent);
      if (!record(config) || !['page', 'menu', 'store'].includes(config.role) || !Array.isArray(config.entries)) throw new Error('metadata');
    } catch (_) {
      message('ピン留めの設定を読み込めません。ページを再生成してください。', true);
      return;
    }
    const entries = new Map();
    config.entries.forEach(entry => {
      if (!record(entry) || !validId(entry.id) || typeof entry.title !== 'string' || entries.has(entry.id)) return;
      if (config.role !== 'store' && !localURL(entry.url)) return;
      entries.set(entry.id, entry);
    });
    if (config.role === 'store') {
      startStore(entries);
      return;
    }
    const storeURL = localURL(config.store_url);
    if (!storeURL) {
      message('ピン留めの保存先が不正です。ページを再生成してください。', true);
      return;
    }
    // All clients must load the exact same URL, including under file://.
    storeURL.search = '';
    storeURL.hash = '';
    const excluded = new Set(Array.isArray(config.exclude_ids) ? config.exclude_ids : []);
    if (config.hub && typeof config.current_id === 'string') excluded.add(config.current_id);
    const canToggle = config.role === 'page' && entries.has(config.current_id);
    const list = config.role === 'menu' && config.hub ? document.getElementById('pin-list') : null;
    const empty = list ? document.getElementById('pin-empty') : null;
    let ids = [];
    let ready = false;
    let pending = null;
    let sequence = 0;
    let timer;
    const rows = new Map();
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'ピン留め保存領域';
    frame.src = storeURL.href;

    function render() {
      const pinned = ids.includes(config.current_id);
      if (toggle) {
        toggle.disabled = !ready || (pending && pending.type === 'set') || !canToggle;
        toggle.setAttribute('aria-pressed', String(pinned && canToggle));
        toggle.textContent = pinned && canToggle ? 'ピン留めを解除' : 'ピン留め';
      }
      if (!list) return;
      list.classList.add('menu-list');
      const visible = ids.filter(id => !excluded.has(id));
      const hints = Array.isArray(config.order) ? config.order : [];
      const ordered = [...new Set([...hints.filter(id => visible.includes(id)), ...visible])];
      const visibleIds = new Set(ordered);
      rows.forEach((row, id) => {
        if (!visibleIds.has(id)) {
          row.element.remove();
          rows.delete(id);
        }
      });
      ordered.forEach((id, index) => {
        let row = rows.get(id);
        if (!row) {
          const entry = entries.get(id);
          const element = document.createElement('li');
          element.className = 'menu-item menu-relation-parent';
          const link = document.createElement('a');
          link.href = entry.url;
          link.target = '_top';
          link.textContent = entry.title;
          element.append(link);
          row = { element };
          rows.set(id, row);
        }
        // No DOM detach/move at all when the order is unchanged. In particular,
        // focus/pageshow refresh must not remove a link between down/up events.
        if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] || null);
      });
      if (empty) {
        empty.hidden = ordered.length > 0 || !ready;
        empty.textContent = ready ? 'ピン留めしたページはありません。' : '';
      }
    }

    function failed(text) {
      clearTimeout(timer);
      pending = null;
      ready = false;
      render();
      message(text, true);
    }

    function armTimeout() {
      clearTimeout(timer);
      timer = setTimeout(() => failed('ピン留め保存領域から応答がありません。保存結果を確認できません。ファイルの配置やブラウザーの設定を確認し、再読み込みしてください。'), TIMEOUT);
    }

    function request(type, id, pinned) {
      // A user action may supersede a background get; its late reply is ignored.
      if (pending && (type === 'get' || pending.type === 'set')) return;
      if (type === 'set' && (!ready || !entries.has(id))) return;
      pending = { type, request_id: ++sequence };
      render();
      armTimeout();
      try {
        frame.contentWindow.postMessage({ channel: CHANNEL, ...pending, ...(type === 'set' ? { id, pinned } : {}) }, storeURL.protocol === 'file:' ? '*' : storeURL.origin);
      } catch (_) {
        failed('ピン留め保存領域に接続できません。再読み込みしてください。');
      }
    }

    function refresh() { request('get'); }

    function refreshMenu() {
      // Same-origin menus need an explicit refresh if no storage event fires.
      // file:// may forbid DOM access: focus/pageshow still re-read the store.
      document.querySelectorAll('iframe.menu-frame').forEach(menu => {
        try { menu.contentWindow.dispatchEvent(new menu.contentWindow.Event(REFRESH)); } catch (_) { /* opaque file origin */ }
      });
    }

    window.addEventListener('message', event => {
      if (!trusted(event, frame.contentWindow, storeURL)) return;
      const data = event.data;
      if (!record(data) || data.channel !== CHANNEL || data.type !== 'state' || !Number.isSafeInteger(data.request_id) || data.request_id < 0 || !Array.isArray(data.ids) || !data.ids.every(id => typeof id === 'string') || ![null, 'read', 'write'].includes(data.error) || typeof data.recovered !== 'boolean') return;
      if (pending ? data.request_id !== pending.request_id : data.request_id !== 0) return;
      const wasSet = pending && pending.type === 'set';
      clearTimeout(timer);
      pending = null;
      ids = idsOnly(data.ids, entries);
      ready = data.error !== 'read';
      render();
      if (data.error) {
        message(data.error === 'read'
          ? 'ピン留めを読み込めません。ブラウザーでローカル保存が許可されているか確認してください。'
          : 'ピン留めを保存できませんでした。保存容量やブラウザーの設定を確認してください。変更は保存されていません。', true);
      } else if (data.recovered) {
        message('一部の保存データが壊れているため、該当するピン留めを読み飛ばしました。対象ページの操作で保存し直せます。', true);
      } else {
        message();
      }
      if (wasSet && !data.error) refreshMenu();
    });
    if (toggle && canToggle) toggle.addEventListener('click', () => request('set', config.current_id, !ids.includes(config.current_id)));
    frame.addEventListener('load', () => {
      pending = null;
      ready = false;
      refresh();
    });
    frame.addEventListener('error', () => failed('ピン留め保存領域を読み込めません。pin-state.html の配置を確認してください。'));
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener(REFRESH, refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    render();
    armTimeout();
    document.body.append(frame);
  }

  function startStore(entries) {
    if (window.parent === window) return;
    const ownURL = new URL(window.location.href);
    if (!['file:', 'http:', 'https:'].includes(ownURL.protocol)) return;
    ownURL.search = '';
    ownURL.hash = '';
    const key = CHANNEL + ':' + ownURL.href;
    const itemKeys = new Map([...entries.keys()].map(id => [id, key + ':item:' + encodeURIComponent(id)]));
    const knownKeys = new Set(itemKeys.values());
    // HTTP peers must share our origin. file:// peers have opaque (null) origins;
    // the exact parent WindowProxy and file protocol are the trust boundary.
    let connected = false;
    let lastOrder = 0;
    function read() {
      const items = new Map();
      let recovered = false;
      try {
        const storage = window.localStorage;
        // Read only generated canonical IDs, never enumerate unrelated storage.
        itemKeys.forEach((itemKey, id) => {
          const raw = storage.getItem(itemKey);
          if (raw === null) return;
          try {
            const parsed = JSON.parse(raw);
            if (!record(parsed) || parsed.version !== 1 || typeof parsed.pinned !== 'boolean' || !Number.isSafeInteger(parsed.order) || parsed.order < 0) throw new Error('invalid item');
            items.set(id, parsed);
            lastOrder = Math.max(lastOrder, parsed.order);
          } catch (_) { recovered = true; }
        });
      } catch (_) { return { ids: [], items, error: 'read', recovered: false }; }
      const ids = [...items.keys()].filter(id => items.get(id).pinned);
      ids.sort((a, b) => items.get(a).order - items.get(b).order || (a < b ? -1 : a > b ? 1 : 0));
      return { ids, items, error: null, recovered };
    }
    function reply(requestId, state) {
      const { ids, error, recovered } = state;
      window.parent.postMessage({ channel: CHANNEL, type: 'state', request_id: requestId, ids, error, recovered }, ownURL.protocol === 'file:' ? '*' : ownURL.origin);
    }
    window.addEventListener('message', event => {
      if (!trusted(event, window.parent, ownURL)) return;
      const data = event.data;
      if (!record(data) || data.channel !== CHANNEL || !['get', 'set'].includes(data.type) || !Number.isSafeInteger(data.request_id) || data.request_id < 1) return;
      if (data.type === 'set' && (!entries.has(data.id) || typeof data.pinned !== 'boolean')) return;
      connected = true;
      let state = read();
      if (data.type === 'set' && !state.error) {
        const previous = state.items.get(data.id);
        const order = data.pinned && previous && previous.pinned ? previous.order
          : Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), lastOrder + 1));
        try {
          // A stale tab may not see another tab's latest items, but it cannot
          // overwrite them: this operation writes exactly one membership key.
          // Same-ID simultaneous changes use localStorage's last-write wins.
          window.localStorage.setItem(itemKeys.get(data.id), JSON.stringify({ version: 1, pinned: data.pinned, order }));
          lastOrder = Math.max(lastOrder, order);
          state = read();
        } catch (_) { state = { ...state, error: 'write' }; }
      }
      reply(data.request_id, state);
    });
    window.addEventListener('storage', event => {
      if (!connected || (event.key !== null && !knownKeys.has(event.key))) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch (_) { /* report through read() */ }
      reply(0, read());
    });
    ['focus', 'pageshow'].forEach(name => window.addEventListener(name, () => { if (connected) reply(0, read()); }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());
