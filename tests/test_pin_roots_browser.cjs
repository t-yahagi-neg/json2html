// Real Chrome file:// regression; no security-bypass flags or sample generation.
// NODE_PATH=/path/to/runtime/node_modules node --test tests/test_pin_roots_browser.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');

async function eventually(read, expected, message) {
  const deadline = Date.now() + 10000;
  while (true) {
    const actual = await read();
    try {
      assert.deepEqual(actual, expected, message);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(50);
  }
}

test('file:// pin state and hints survive config-root → parent → config-root generation',
  { timeout: 90000 }, async t => {
    const fixture = fs.mkdtempSync(path.join(project, '..', '.browser-pin-roots-'));
    let context;
    t.after(async () => {
      try {
        if (context) await context.close();
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });
    const commandRoot = path.join(fixture, 'parent');
    const scope = path.join(commandRoot, 'configured');
    const hub = path.join(scope, 'pins');
    const child = path.join(scope, 'child');
    const url = directory => pathToFileURL(path.join(directory, 'index.html')).href;
    function writePage(directory, title) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'table.json'), JSON.stringify({
        title, columns: ['A'], rows: [{ A: title }],
      }));
    }
    writePage(commandRoot, '設定範囲外の親');
    writePage(hub, 'ピン一覧');
    writePage(child, '保存する子ページ');
    // The config directory intentionally has no table.json of its own.
    fs.writeFileSync(path.join(scope, 'json2html.config.json'), JSON.stringify({
      pin_page: './pins',
      assets: {
        css: path.relative(scope, path.join(project, 'css/style.css')),
        js: path.relative(scope, path.join(project, 'js')),
      },
    }));
    const hintPath = path.join(hub, 'menu.json');
    const hintBytes = Buffer.from(' {\n   "items": [\n' +
      '     {"type":"link", "text":"手動順序", "url":"../child/index.html"}\n' +
      '   ], "note": "このバイト列を保持"\n }\n\n');
    fs.writeFileSync(hintPath, hintBytes);
    const hintMtime = fs.statSync(hintPath).mtimeMs;
    function generate(root) {
      execFileSync(process.env.PYTHON || 'python3', [path.join(project, 'generate.py'), root], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      assert.deepEqual(fs.readFileSync(hintPath), hintBytes, 'Hub hints must be byte-preserved');
      assert.equal(fs.statSync(hintPath).mtimeMs, hintMtime, 'Hub hints must not be rewritten');
    }
    generate(scope);
    context = await chromium.launchPersistentContext(path.join(fixture, 'profile'), {
      executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      viewport: { width: 1280, height: 800 },
    });
    const errors = [];
    const page = context.pages()[0];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    const button = page.locator('#page-pin-toggle');
    const storeURL = pathToFileURL(path.join(hub, 'pin-state.html')).href;
    const storeKey = `json2html:pins:v1:${storeURL}:item:${encodeURIComponent('child/index.html')}`;
    async function storedRecord() {
      const store = page.frames().find(frame => frame.url() === storeURL);
      assert.ok(store, 'All generations must use the same canonical store URL');
      return store.evaluate(key => ({
        keys: Object.keys(localStorage).filter(item => item.startsWith('json2html:pins:v1:')).sort(),
        value: localStorage.getItem(key),
      }), storeKey);
    }
    async function metadata() {
      return JSON.parse(await page.locator('script#json2html-pins').textContent());
    }
    async function assertQuietStatuses() {
      for (const scope of [page, page.frameLocator('#menu-frame')]) {
        const status = scope.locator('#page-pin-status');
        await status.waitFor({ state: 'attached' });
        assert.deepEqual(await status.evaluate(node => ({ text: node.textContent, hidden: node.hidden })),
          { text: '', hidden: true }, 'Regeneration must not restore normal status messages');
        assert.equal(await status.isVisible(), false);
      }
    }
    async function assertToggle(pressed) {
      await button.waitFor({ state: 'visible' });
      assert.equal(await button.count(), 1);
      await eventually(() => button.isEnabled(), true, 'Pin store bridge must be ready');
      await eventually(() => button.getAttribute('aria-pressed'), String(pressed), 'Stored pin state');
      assert.equal(await button.textContent(), pressed ? 'ピン留めを解除' : 'ピン留め');
      await assertQuietStatuses();
    }
    async function assertHubPin() {
      await assertToggle(false);
      const menu = page.frameLocator('#menu-frame');
      const links = menu.locator('#pin-list a');
      await eventually(() => links.evaluateAll(nodes => nodes.map(node => node.href)),
        [url(child)], 'Hub must still list the saved pin');
      assert.deepEqual(await links.allTextContents(), ['保存する子ページ']);
      assert.equal(await links.first().getAttribute('target'), '_top');
      assert.deepEqual(await menu.locator('a').evaluateAll(nodes => nodes
        .filter(node => !node.closest('#pin-list')).map(node => node.href)), [],
      'Missing immediate parent must not promote the command-root page');
      await assertQuietStatuses();
    }

    await page.goto(url(child));
    await assertToggle(false);
    const childMetadata = await metadata();
    assert.equal(childMetadata.current_id, 'child/index.html');
    assert.equal(childMetadata.store_url, '../pins/pin-state.html');
    assert.deepEqual(childMetadata.entries.map(entry => entry.id), ['child/index.html', 'pins/index.html']);
    await button.click();
    await assertToggle(true);
    const saved = await storedRecord();
    assert.deepEqual(saved.keys, [storeKey]);
    assert.equal(JSON.parse(saved.value).pinned, true);
    await page.goto(url(hub));
    await assertHubPin();
    const hubMetadata = await metadata();
    await page.goto(url(child));

    generate(commandRoot);
    await page.reload();
    await assertToggle(true);
    assert.deepEqual(await metadata(), childMetadata, 'Parent invocation must not change pin IDs/catalog');
    assert.deepEqual(await storedRecord(), saved, 'Parent invocation must preserve the exact storage key/value');
    await page.goto(url(hub));
    await assertHubPin();
    assert.deepEqual(await metadata(), hubMetadata);

    generate(scope);
    await page.reload();
    await assertHubPin();
    assert.deepEqual(await metadata(), hubMetadata);
    await page.goto(url(child));
    await assertToggle(true);
    assert.deepEqual(await metadata(), childMetadata, 'Direct invocation must keep the same stored identity');
    assert.deepEqual(await storedRecord(), saved, 'Direct invocation must preserve the exact storage key/value');
    assert.deepEqual(errors, []);
  });
