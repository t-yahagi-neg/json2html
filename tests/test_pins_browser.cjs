// Chrome integration tests for pins on real file:// pages, without security bypass flags.
// NODE_PATH=/path/to/node_modules \
//   node --test tests/test_pins_browser.cjs
// Only unique fixtures below test_dir are generated or modified. KEEP_BROWSER_FIXTURE=1
// retains them for inspection; otherwise cleanup runs even when an assertion fails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const chromeOptions = {
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  viewport: { width: 1280, height: 800 },
};
const titles = {
  '': '親一覧',
  pins: 'ピン一覧',
  branch: '中間一覧',
  'branch/deep': '深いページ',
  second: '第二ページ',
  unpinned: '未選択ページ',
};
const deep = 'branch/deep';

async function eventually(read, expected, message) {
  const deadline = Date.now() + 10000;
  let actual;
  do {
    actual = await read();
    try {
      assert.deepEqual(actual, expected);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        assert.deepEqual(actual, expected, message);
      }
    }
    await delay(50);
  } while (true);
}

async function assertQuietStatus(scope) {
  const status = scope.locator('#page-pin-status');
  await status.waitFor({ state: 'attached' });
  assert.deepEqual(await status.evaluate(node => ({ text: node.textContent, hidden: node.hidden })),
    { text: '', hidden: true }, 'Normal status must be empty and hidden');
  assert.equal(await status.isVisible(), false, 'Normal status must not occupy visible space');
}

async function assertQuietPageAndMenu(page) {
  await assertQuietStatus(page);
  await assertQuietStatus(page.frameLocator('#menu-frame'));
}

async function assertVisibleWarning(scope, pattern) {
  const status = scope.locator('#page-pin-status');
  await status.waitFor({ state: 'visible' });
  await eventually(async () => pattern.test(await status.textContent()), true, 'Expected visible warning');
  assert.equal(await status.evaluate(node => node.hidden), false);
}

function fixtureFor(t) {
  const fixture = fs.mkdtempSync(path.join(project, '..', '.browser-json2html-pins-'));
  const root = path.join(fixture, 'site');
  const contexts = new Set();
  const errors = [];
  fs.mkdirSync(root);
  t.after(async () => {
    try {
      await Promise.all([...contexts].map(context => context.close()));
    } finally {
      if (process.env.KEEP_BROWSER_FIXTURE) console.error('Pins fixtures retained:', fixture);
      else fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  function writePage(name, title = titles[name]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'table.json'), JSON.stringify({
      title, columns: ['名前'], rows: [{ 名前: title }],
    }));
  }
  for (const name of Object.keys(titles)) writePage(name);
  fs.writeFileSync(path.join(root, 'json2html.config.json'), JSON.stringify({
    pin_page: './pins',
    assets: {
      css: path.relative(root, path.join(project, 'css/style.css')),
      js: path.relative(root, path.join(project, 'js')),
    },
  }));

  function generate() {
    return execFileSync(process.env.PYTHON || 'python3', [path.join(project, 'generate.py'), root], {
      encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: 30000,
    });
  }
  const url = (name = '') => pathToFileURL(path.join(root, name, 'index.html')).href;

  async function launch(profile = 'profile') {
    const context = await chromium.launchPersistentContext(path.join(fixture, profile), chromeOptions);
    contexts.add(context);
    context.on('close', () => contexts.delete(context));
    const observe = page => {
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
    };
    context.pages().forEach(observe);
    context.on('page', observe);
    return context;
  }

  async function visit(page, name) {
    await page.goto(url(name));
    await page.locator('#menu-frame').waitFor();
    await page.locator('#page-pin-toggle').waitFor();
    assert.equal(await page.locator('script[src$="page-pins.js"]').count(), 1);
  }
  async function setPinned(page, value) {
    const button = page.locator('#page-pin-toggle');
    await eventually(() => button.isEnabled(), true, 'Pin bridge must become ready');
    await eventually(() => button.getAttribute('aria-pressed'), String(!value), 'Initial pressed state');
    await button.click();
    await eventually(() => button.getAttribute('aria-pressed'), String(value), 'Updated pressed state');
    await eventually(() => button.isEnabled(), true, 'Save response must re-enable the toggle');
    assert.equal(await button.textContent(), value ? 'ピン留めを解除' : 'ピン留め');
    await assertQuietPageAndMenu(page);
  }
  const pinLinks = page => page.frameLocator('#menu-frame').locator('#pin-list a');
  async function assertPins(page, names, labels = names.map(name => titles[name])) {
    const links = pinLinks(page);
    await eventually(() => links.evaluateAll(nodes => nodes.map(node => node.href)), names.map(url), 'Pinned URL order');
    await eventually(() => links.allTextContents(), labels, 'Current catalog titles');
    assert.deepEqual(await links.evaluateAll(nodes => nodes.map(node => node.target)), names.map(() => '_top'));
    assert.equal(await page.frameLocator('#menu-frame').locator('.pin-remove, #pin-list button').count(), 0);
    await assertQuietPageAndMenu(page);
  }
  async function assertParentOnly(page) {
    const links = page.frameLocator('#menu-frame').locator('a');
    assert.deepEqual(await links.evaluateAll(nodes => nodes.filter(node => !node.closest('#pin-list'))
      .map(node => ({ href: node.href, target: node.target }))), [{ href: url(), target: '_top' }]);
  }
  async function metadata(page) {
    const node = page.locator('script#json2html-pins');
    assert.equal(await node.getAttribute('type'), 'application/json');
    const data = JSON.parse(await node.textContent());
    assert.ok(data && typeof data === 'object', 'Hub must embed JSON metadata');
    return data;
  }
  return { root, writePage, generate, launch, url, visit, setPinned, pinLinks, assertPins, assertParentOnly, metadata, errors };
}

test('file:// pins: quiet loading/saving/refresh and acknowledged blue toggle, including hover', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  await context.addInitScript(() => {
    window.__holdPinReplies = true;
    window.__pinReplies = [];
    window.addEventListener('message', event => {
      if (!window.__holdPinReplies || event.data?.channel !== 'json2html:pins:v1' || event.data.type !== 'state') return;
      event.stopImmediatePropagation();
      window.__pinReplies.push(event);
    }, true);
    window.__releasePinReplies = () => {
      window.__holdPinReplies = false;
      for (const event of window.__pinReplies.splice(0)) {
        window.dispatchEvent(new MessageEvent('message', {
          data: event.data, source: event.source, origin: event.origin,
        }));
      }
    };
  });
  const page = context.pages()[0];
  const button = page.locator('#page-pin-toggle');
  const colors = () => button.evaluate(node => {
    const css = getComputedStyle(node);
    return { background: css.backgroundColor, color: css.color };
  });
  const blue = { background: 'rgb(11, 87, 208)', color: 'rgb(255, 255, 255)' };
  async function release(scope) {
    await eventually(() => scope.evaluate(() => window.__pinReplies.length > 0), true, 'A real bridge reply must be held');
    await scope.evaluate(() => window.__releasePinReplies());
  }
  async function currentMenuFrame() {
    const iframe = await page.locator('#menu-frame').elementHandle();
    const frame = await iframe.contentFrame();
    await iframe.dispose();
    assert.ok(frame, 'Menu frame must be loaded');
    return frame;
  }
  await f.visit(page, deep);
  await eventually(() => page.evaluate(() => window.__pinReplies.length > 0), true);
  assert.equal(await button.isDisabled(), true);
  await assertQuietPageAndMenu(page);
  await release(page);
  await release(await currentMenuFrame());
  await eventually(() => button.isEnabled(), true);
  await page.mouse.move(0, 0);
  const gray = await colors();
  assert.deepEqual(gray, { background: 'rgb(238, 241, 246)', color: 'rgb(26, 26, 26)' });
  await button.hover();
  const grayHover = await colors();
  assert.deepEqual(grayHover, { background: 'rgb(224, 229, 238)', color: 'rgb(26, 26, 26)' });

  for (const pinned of [true, false]) {
    await page.evaluate(() => { window.__holdPinReplies = true; });
    await button.click();
    await eventually(() => page.evaluate(() => window.__pinReplies.length > 0), true);
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute('aria-pressed'), String(!pinned), 'No optimistic pressed state');
    assert.equal(await button.textContent(), pinned ? 'ピン留め' : 'ピン留めを解除');
    assert.deepEqual(await colors(), pinned ? grayHover : blue, 'Pending save retains the previous background');
    await assertQuietPageAndMenu(page);
    await release(page);
    await eventually(() => button.isEnabled(), true);
    assert.equal(await button.getAttribute('aria-pressed'), String(pinned));
    assert.equal(await button.textContent(), pinned ? 'ピン留めを解除' : 'ピン留め');
    await page.mouse.move(0, 0);
    assert.deepEqual(await colors(), pinned ? blue : gray);
    await button.hover();
    assert.deepEqual(await colors(), pinned ? blue : grayHover, 'Hover preserves the registered blue/white state');
    await assertQuietPageAndMenu(page);
  }
  for (const name of ['focus', 'pageshow', 'json2html:pins-refresh']) {
    await page.evaluate(eventName => {
      window.__holdPinReplies = true;
      window.dispatchEvent(new Event(eventName));
    }, name);
    await assertQuietPageAndMenu(page);
    await release(page);
    await assertQuietPageAndMenu(page);
  }

  await f.setPinned(page, true);
  await f.visit(page, 'pins');
  const menuFrame = await currentMenuFrame();
  await eventually(() => menuFrame.evaluate(() => window.__pinReplies.length > 0), true);
  await assertQuietPageAndMenu(page);
  await release(page);
  await release(menuFrame);
  await f.assertPins(page, [deep]);
  await f.setPinned(page, true);
  assert.deepEqual(await colors(), blue, 'The hub uses the same acknowledged pin toggle');
  await f.assertPins(page, [deep]);
  await f.setPinned(page, false);
  await f.assertPins(page, [deep]);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: insertion order, top navigation, restored toggle and removal', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  await f.visit(page, deep);
  await f.setPinned(page, true);
  await f.visit(page, 'second');
  await f.setPinned(page, true);
  await f.visit(page, 'pins');
  await f.metadata(page);
  assert.equal(await page.locator('#page-pin-toggle').count(), 1);
  assert.equal(await page.locator('#data-table tbody').innerText(), titles.pins, 'Existing hub table is retained');
  await f.assertPins(page, [deep, 'second']);
  await f.assertParentOnly(page);

  await f.pinLinks(page).first().click();
  await page.waitForURL(f.url(deep));
  assert.equal(page.mainFrame().url(), f.url(deep), 'Pinned navigation must replace the top page');
  assert.equal(await page.title(), titles[deep]);
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
  await f.setPinned(page, false);
  await f.visit(page, 'pins');
  await f.assertPins(page, ['second']);
  await f.assertParentOnly(page);
  await page.reload();
  await f.assertPins(page, ['second']);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: hub first without duplicate links and one canonical hidden bridge URL', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  const bridgeURLs = new Set();
  for (const name of Object.keys(titles)) {
    await f.visit(page, name);
    if (name !== 'pins') {
      const links = page.frameLocator('#menu-frame').locator('a');
      await eventually(async () => (await links.evaluateAll(nodes => nodes.map(node => node.href)))[0], f.url('pins'));
      const hrefs = await links.evaluateAll(nodes => nodes.map(node => node.href));
      assert.equal(hrefs.filter(href => href === f.url('pins')).length, 1);
      assert.equal(new Set(hrefs).size, hrefs.length, `Duplicate menu links on ${name || 'root'}`);
      assert.equal(await links.first().getAttribute('target'), '_top');
      assert.equal(await page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'false');
    }
    await assertQuietPageAndMenu(page);
    await eventually(async () => page.frames().some(frame => /\/pin-state\.html(?:[?#]|$)/.test(frame.url())), true);
    for (const frame of page.frames()) {
      if (!/\/pin-state\.html(?:[?#]|$)/.test(frame.url())) continue;
      bridgeURLs.add(frame.url());
      const parsed = new URL(frame.url());
      assert.equal(parsed.protocol, 'file:');
      assert.equal(parsed.search, '', 'Client identity must not change the bridge URL');
      assert.equal(parsed.hash, '');
      assert.ok(fs.existsSync(require('node:url').fileURLToPath(parsed)), 'Bridge HTML must be generated');
      const iframe = await frame.frameElement();
      assert.equal(await iframe.isVisible(), false, 'State bridge must be hidden');
      await iframe.dispose();
    }
  }
  assert.equal(bridgeURLs.size, 1, 'Every index/menu client must resolve the exact same bridge URL');
  assert.deepEqual(f.errors, []);
});

test('file:// pins: regeneration preserves pins, refreshes titles and excludes deleted pages', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  for (const name of [deep, 'second']) {
    await f.visit(page, name);
    await f.setPinned(page, true);
  }
  await f.visit(page, 'pins');
  await f.assertPins(page, [deep, 'second']);
  f.writePage(deep, '更新した深いページ');
  f.generate();
  await page.reload();
  await f.assertPins(page, [deep, 'second'], ['更新した深いページ', titles.second]);
  await f.visit(page, deep);
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');

  fs.unlinkSync(path.join(f.root, 'second', 'table.json'));
  f.generate();
  await f.visit(page, 'pins');
  await f.assertPins(page, [deep], ['更新した深いページ']);
  const metadata = JSON.stringify(await f.metadata(page));
  assert.ok(!metadata.includes(titles.second), 'Deleted page must leave the generated catalog');
  assert.equal(await page.frameLocator('#menu-frame').getByRole('link', { name: titles.second, exact: true }).count(), 0);
  await f.assertParentOnly(page);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: manual hub menu order hints survive generation and only sort selected pages', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  for (const name of [deep, 'second']) {
    await f.visit(page, name);
    await f.setPinned(page, true);
  }
  await f.visit(page, 'pins');
  await f.assertPins(page, [deep, 'second']);
  const menuPath = path.join(f.root, 'pins', 'menu.json');
  const hintNames = ['unpinned', 'second', deep];
  const hints = { items: hintNames.map(name => ({
    type: 'link', text: titles[name],
    url: `../${name.split('/').map(encodeURIComponent).join('/')}/index.html`,
  })) };
  const hintBytes = JSON.stringify(hints, null, 4) + '\n\n';
  fs.writeFileSync(menuPath, hintBytes);
  f.generate();
  assert.equal(fs.readFileSync(menuPath, 'utf8'), hintBytes, 'Preserve manual hub order hints byte-identically');
  await page.reload();
  await f.assertPins(page, ['second', deep]);
  await f.assertParentOnly(page);
  assert.equal(await page.frameLocator('#menu-frame').getByRole('link', { name: titles.unpinned, exact: true }).count(), 0);
  f.generate();
  assert.equal(fs.readFileSync(menuPath, 'utf8'), hintBytes, 'Repeated generation also preserves hint bytes');
  await page.reload();
  await f.assertPins(page, ['second', deep]);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: saved state survives closing and restarting the persistent Chrome profile', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  let context = await f.launch();
  let page = context.pages()[0];
  await f.visit(page, deep);
  await f.setPinned(page, true);
  await f.visit(page, 'pins');
  await f.assertPins(page, [deep]);
  await context.close();
  context = await f.launch();
  page = context.pages()[0];
  await f.visit(page, 'pins');
  await f.assertPins(page, [deep]);
  await f.visit(page, deep);
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.errors, []);
});

test('file:// pins: bridge-only denied storage disables pinning and visibly reports unavailable', { timeout: 90000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch('denied-profile');
  await context.addInitScript(() => {
    if (!/\/pin-state\.html$/.test(window.location.pathname)) return;
    window.__pinsStorageDenied = true;
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    window.__restorePinsStorage = () => Object.defineProperty(window, 'localStorage', original);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage denied by pins browser test', 'SecurityError'); },
    });
  });
  const page = context.pages()[0];
  await f.visit(page, deep);
  const unavailable = /保存でき|保存不可|読み込めません|利用でき|使用でき|利用不可|使用不可|unavailable|denied|not available/i;
  await assertVisibleWarning(page, unavailable);
  await assertVisibleWarning(page.frameLocator('#menu-frame'), unavailable);
  assert.equal(await page.locator('#page-pin-toggle').isDisabled(), true);
  assert.equal(await page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'false');
  const bridges = page.frames().filter(frame => /\/pin-state\.html(?:[?#]|$)/.test(frame.url()));
  assert.ok(bridges.length > 0, 'Failure must come from the shared bridge');
  for (const bridge of bridges) assert.equal(await bridge.evaluate(() => window.__pinsStorageDenied), true);
  assert.equal(await page.evaluate(() => {
    localStorage.setItem('pins-browser-denial-scope', 'works');
    const value = localStorage.getItem('pins-browser-denial-scope');
    localStorage.removeItem('pins-browser-denial-scope');
    return value;
  }), 'works', 'Only bridge storage is mocked, not the parent page');
  await f.visit(page, 'pins');
  await f.assertParentOnly(page);
  await eventually(() => f.pinLinks(page).count(), 0);
  await assertVisibleWarning(page, unavailable);
  await assertVisibleWarning(page.frameLocator('#menu-frame'), unavailable);
  for (const frame of page.frames()) {
    if (/\/pin-state\.html$/.test(frame.url())) await frame.evaluate(() => window.__restorePinsStorage());
  }
  for (const frame of page.frames()) {
    if (await frame.locator('#page-pin-status').count()) {
      await frame.evaluate(() => window.dispatchEvent(new Event('focus')));
      await eventually(() => frame.locator('#page-pin-status').evaluate(node => node.hidden), true,
        'Successful read recovery must hide the previous error');
    }
  }
  await assertQuietPageAndMenu(page);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: encoded local paths remain pinnable and navigate correctly', { timeout: 60000 }, async t => {
  const f = fixtureFor(t);
  const name = 'branch/日本語 # %';
  const title = '特殊文字パス';
  f.writePage(name, title);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  await f.visit(page, name);
  await f.setPinned(page, true);
  await f.visit(page, 'pins');
  await f.assertPins(page, [name], [title]);
  await f.pinLinks(page).first().click();
  await page.waitForURL(f.url(name));
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
  await f.setPinned(page, false);
  await f.visit(page, 'pins');
  await f.assertPins(page, []);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: hub toolbar toggles its own persistent pin without self-links or menu buttons', { timeout: 60000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  await f.visit(page, 'pins');
  assert.equal(await page.locator('#table-filter-clear').evaluate(node =>
    node.nextElementSibling?.id), 'page-pin-toggle', 'Hub pin toggle belongs next to Clear');
  const [clear, pin] = await Promise.all([
    page.locator('#table-filter-clear').boundingBox(), page.locator('#page-pin-toggle').boundingBox(),
  ]);
  assert.ok(Math.abs(clear.y - pin.y) < 1 && pin.x > clear.x + clear.width);
  await f.setPinned(page, true);
  const bridge = page.frames().find(frame => /\/pin-state\.html$/.test(frame.url()));
  assert.ok(bridge);
  assert.equal(await bridge.evaluate(() => {
    const key = `json2html:pins:v1:${location.href}:item:${encodeURIComponent('pins/index.html')}`;
    return JSON.parse(localStorage.getItem(key)).pinned;
  }), true);
  await page.reload();
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
  await f.assertPins(page, []);
  await f.assertParentOnly(page);
  assert.equal(await page.frameLocator('#menu-frame').locator('button').count(), 0);
  f.generate();
  await page.reload();
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
  await f.visit(page, 'branch');
  const hrefs = await page.frameLocator('#menu-frame').locator('a').evaluateAll(nodes => nodes.map(node => node.href));
  assert.equal(hrefs.filter(href => href === f.url('pins')).length, 1);
  await f.visit(page, 'pins');
  await f.setPinned(page, false);
  await page.reload();
  await eventually(() => page.locator('#page-pin-toggle').isEnabled(), true);
  assert.equal(await page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'false');
  await f.assertPins(page, []);
  assert.deepEqual(f.errors, []);
});

test('file:// menus: equal narrower links are left/center/right by relationship without overflow', { timeout: 60000 }, async t => {
  const f = fixtureFor(t);
  f.writePage('branch/deep', '長いページ名でも読みやすく折り返して表示する_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  await f.visit(page, 'branch');
  const menu = page.frameLocator('#menu-frame');
  for (const width of [1280, 480, 280]) {
    await page.setViewportSize({ width, height: 800 });
    const rows = await menu.locator('.menu-list > li').evaluateAll(nodes => nodes.map(node => {
      const link = node.querySelector('a');
      const box = link.getBoundingClientRect();
      const list = node.parentElement.getBoundingClientRect();
      return { href: link.href, className: node.className, x: box.x, right: box.right,
        width: box.width, listX: list.x, listRight: list.right, listWidth: list.width,
        scrollWidth: link.scrollWidth, clientWidth: link.clientWidth };
    }));
    const byURL = new Map(rows.map(row => [row.href, row]));
    const parent = byURL.get(f.url());
    const sibling = byURL.get(f.url('second'));
    const child = byURL.get(f.url(deep));
    const hub = byURL.get(f.url('pins'));
    assert.match(parent.className, /menu-relation-parent/);
    assert.match(sibling.className, /menu-relation-sibling/);
    assert.match(child.className, /menu-relation-child/);
    assert.match(hub.className, /menu-relation-parent/);
    assert.ok(Math.abs(parent.x - hub.x) < 1, 'Hub is parent-aligned, even when it is a sibling on disk');
    assert.ok(Math.abs(parent.x - parent.listX) < 1);
    assert.ok(sibling.x > parent.x + 3 && child.x > sibling.x + 3);
    assert.ok(Math.abs((sibling.x - parent.x) - (child.x - sibling.x)) < 1);
    for (const row of rows) {
      assert.ok(Math.abs(row.width - parent.width) < 1, 'All link buttons keep equal widths');
      assert.ok(row.width < row.listWidth && row.width > row.listWidth - 33);
      assert.ok(row.x >= row.listX - 1 && row.right <= row.listRight + 1);
      assert.ok(row.scrollWidth <= row.clientWidth + 1, 'Long labels wrap without clipping');
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await f.visit(page, 'second');
  await f.setPinned(page, true);
  await f.visit(page, 'pins');
  await f.assertPins(page, ['second']);
  const leftEdges = await menu.locator('a').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
  assert.ok(leftEdges.every(x => Math.abs(x - leftEdges[0]) < 1), 'Pinned links align with the parent');
  assert.deepEqual(f.errors, []);
});

test('file:// pins: ROOT can be pinned while the hub renders its parent only once', { timeout: 60000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const page = context.pages()[0];
  await f.visit(page, '');
  await f.setPinned(page, true);
  await f.visit(page, 'pins');
  await f.assertPins(page, []);
  await f.assertParentOnly(page);
  await f.visit(page, '');
  await eventually(() => page.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
  await f.setPinned(page, false);
  await f.visit(page, 'pins');
  await f.assertPins(page, []);
  await f.assertParentOnly(page);
  assert.deepEqual(f.errors, []);
});

test('file:// pins: independent simultaneous tab updates do not lose either pin', { timeout: 120000 }, async t => {
  const f = fixtureFor(t);
  f.generate();
  const context = await f.launch();
  const first = context.pages()[0];
  const second = await context.newPage();
  const hub = await context.newPage();
  await Promise.all([f.visit(first, deep), f.visit(second, 'second'), f.visit(hub, 'pins')]);
  const expected = [f.url(deep), f.url('second')].sort();
  // Repetition increases the chance of exposing read/modify/write races; it is
  // not proof that localStorage offers a cross-tab atomic transaction.
  for (let round = 0; round < 5; round++) {
    await Promise.all([f.setPinned(first, true), f.setPinned(second, true)]);
    await hub.reload();
    await eventually(() => f.pinLinks(hub).evaluateAll(nodes => nodes.map(node => node.href).sort()), expected,
      `Concurrent updates lost a pin in round ${round + 1}`);
    await Promise.all([first.reload(), second.reload()]);
    await eventually(() => first.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
    await eventually(() => second.locator('#page-pin-toggle').getAttribute('aria-pressed'), 'true');
    await Promise.all([f.setPinned(first, false), f.setPinned(second, false)]);
    await hub.reload();
    await f.assertPins(hub, []);
  }
  assert.deepEqual(f.errors, []);
});
