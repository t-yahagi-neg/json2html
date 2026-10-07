// Integration checks against generated file:// pages. Requires Playwright + Chrome.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(project, '..', '.browser-json2html-'));
const root = path.join(fixture, '00');
fs.mkdirSync(root);

function writePage(name, extra = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const data = {
    title: name || '親ページ',
    columns: ['A', 'B', 'C'],
    rows: [
      { A: '1', B: 'x', C: 'u' },
      { A: '2', B: 'y', C: 'v' },
      { A: '3', B: 'x', C: 'w' },
    ],
    column_options: { A: { visible: false }, B: { label: '分類' }, C: { visible: false } },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'table.json'), JSON.stringify(data));
  return dir;
}
function generate() {
  return execFileSync(process.env.PYTHON || 'python3', [path.join(project, 'generate.py'), root], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}
function url(dir = root) { return pathToFileURL(path.join(dir, 'index.html')).href; }
async function visibleRows(page) {
  return page.locator('#data-table tbody tr:not([hidden])').count();
}
async function filterX(page, index = 1) {
  await page.locator(`.table-filter-toggle[data-col-index="${index}"]`).click();
  await page.locator('#table-filter-panel input[data-filter-value="x"]').uncheck();
  await page.keyboard.press('Escape');
}
async function setColumn(page, index, checked) {
  await page.locator('#table-columns-toggle').click();
  await page.locator(`#table-columns-panel input[data-column-index="${index}"]`).setChecked(checked);
  await page.keyboard.press('Escape');
}

test('generated HTML works directly from disk', async (t) => {
  let passed = false;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function reset(extra = {}) {
    writePage('', extra);
    generate();
    await page.goto(url());
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  try {
    writePage('001');
    writePage('002');
    writePage('002/0021');
    fs.writeFileSync(path.join(root, 'json2html.config.json'), JSON.stringify({
      assets: {
        css: path.relative(root, path.join(project, 'css/style.css')),
        js: path.relative(root, path.join(project, 'js')),
      },
      alignment: { header: 'center', body: 'left' },
    }));

    await t.test('shared assets, menu navigation, alignment, first-column lock and reset', async () => {
      await reset();
      assert.equal(await page.title(), '親ページ');
      assert.equal(await page.locator('tbody td').first().evaluate(el => getComputedStyle(el).textAlign), 'left');
      assert.equal(await page.locator('.th-label').first().evaluate(el => getComputedStyle(el).textAlign), 'center');
      assert.equal(await page.locator('thead th').nth(2).isVisible(), false);
      await page.locator('#table-columns-toggle').click();
      const first = page.locator('#table-columns-panel input').first();
      assert.equal(await first.isChecked(), true);
      assert.equal(await first.isDisabled(), true);
      await page.locator('#table-columns-panel input[data-column-index="2"]').check();
      assert.equal(await page.locator('thead th').nth(2).isVisible(), true);
      await page.locator('.table-columns-reset').click();
      assert.equal(await page.locator('thead th').nth(2).isVisible(), false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#table-columns-toggle').evaluate(el => el === document.activeElement), true);
      await page.frameLocator('#menu-frame').getByRole('link', { name: '002', exact: true }).click();
      await page.waitForURL(url(path.join(root, '002')));
      assert.equal(await page.locator('#table-columns-toggle').isVisible(), true);
      const labels = await page.frameLocator('#menu-frame').locator('a').allTextContents();
      assert.deepEqual(labels, ['親ページ', '001', '002/0021']);
    });

    await t.test('clear-on-hide removes filters; visibility and filters survive reload separately', async () => {
      await reset();
      await filterX(page);
      assert.equal(await visibleRows(page), 1);
      await page.reload();
      assert.equal(await visibleRows(page), 1);
      await setColumn(page, 1, false);
      assert.equal(await visibleRows(page), 3);
      await page.reload();
      assert.equal(await page.locator('thead th').nth(1).isVisible(), false);
      assert.equal(await visibleRows(page), 3);
      await page.locator('#table-filter-clear').click();
      assert.equal(await page.locator('thead th').nth(1).isVisible(), false);
      assert.doesNotMatch(await page.locator('#table-filter-status').textContent(), /非表示列/);
    });

    await t.test('keep-on-hide retains filters and explains hidden filtering', async () => {
      await reset({ hidden_column_filter: 'keep' });
      await filterX(page);
      await setColumn(page, 1, false);
      assert.equal(await visibleRows(page), 1);
      assert.match(await page.locator('#table-filter-status').textContent(), /非表示列/);
      await page.reload();
      assert.equal(await visibleRows(page), 1);
      assert.equal(await page.locator('thead th').nth(1).isVisible(), false);
      await page.locator('#table-filter-clear').click();
      assert.equal(await visibleRows(page), 3);
    });

    await t.test('regeneration and column reordering preserve key-based filters and new values stay visible', async () => {
      await reset();
      await filterX(page);
      writePage('', {
        title: '再生成後', columns: ['A', 'C', 'B'],
        rows: [{ A: '1', B: 'x', C: 'u' }, { A: '2', B: 'y', C: 'v' }, { A: '4', B: 'z', C: 'new' }],
      });
      generate();
      await page.reload();
      assert.equal(await page.title(), '再生成後');
      assert.equal(await visibleRows(page), 2);
      assert.equal(await page.locator('thead th').nth(1).isVisible(), false);
      await page.goto(url(path.join(root, '001')));
      assert.equal(await visibleRows(page), 3);
    });

    await t.test('sidebar still toggles and persists', async () => {
      await reset();
      await page.locator('#sidebar-toggle').click();
      assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('is-collapsed')), true);
      await page.reload();
      assert.equal(await page.locator('#sidebar').evaluate(el => el.classList.contains('is-collapsed')), true);
      await page.locator('#sidebar-toggle').click();
      await page.locator('#table-columns-toggle').click();
      await page.screenshot({ path: path.join(fixture, 'columns.png'), fullPage: true });
      assert.deepEqual(errors, []);
    });
    await t.test('single-column sort, reset, persistence and filter identity', async () => {
      await reset();
      const order = () => page.locator('tbody tr td:first-child').allTextContents();
      async function sort(index, direction) {
        await page.locator(`.table-filter-toggle[data-col-index="${index}"]`).click();
        await page.locator(`[data-sort="${direction}"]`).click();
      }
      await sort(1, 'desc');
      assert.deepEqual(await order(), ['2', '1', '3']);
      await page.reload();
      assert.deepEqual(await order(), ['2', '1', '3']);
      await setColumn(page, 2, true);
      await sort(2, 'desc');
      assert.deepEqual(await order(), ['3', '2', '1']);
      assert.equal(await page.locator('th[aria-sort="descending"]').count(), 1);
      await filterX(page);
      assert.equal(await visibleRows(page), 1);
      await sort(2, 'reset');
      assert.deepEqual(await order(), ['1', '2', '3']);
    });

    await t.test('reverse preserves current row order without sorting and survives reload', async () => {
      await reset({rows: [
        {A: '3', B: 'x', C: 'u'}, {A: '1', B: 'y', C: 'v'},
        {A: '4', B: 'x', C: 'w'}, {A: '2', B: '', C: ''},
      ]});
      const order = () => page.locator('tbody tr td:first-child').allTextContents();
      async function action(direction) {
        await page.locator('.table-filter-toggle[data-col-index="1"]').click();
        await page.locator(`#table-filter-panel [data-sort="${direction}"]`).click();
      }
      await action('reverse');
      assert.deepEqual(await order(), ['2', '4', '1', '3']);
      await page.reload();
      assert.deepEqual(await order(), ['2', '4', '1', '3']);
      await action('reverse');
      assert.deepEqual(await order(), ['3', '1', '4', '2']);
      await action('asc');
      assert.deepEqual(await order(), ['3', '4', '1', '2']);
      await action('reverse');
      assert.deepEqual(await order(), ['2', '1', '4', '3']);
      assert.equal(await page.locator('th[aria-sort="other"]').count(), 1);
      await page.reload();
      assert.deepEqual(await order(), ['2', '1', '4', '3']);
      await filterX(page);
      assert.deepEqual(await page.locator('tbody tr:not([hidden]) td:first-child').allTextContents(), ['2', '1']);
      await page.locator('#table-filter-clear').click();
      assert.deepEqual(await order(), ['2', '1', '4', '3']);
      await page.setViewportSize({width: 390, height: 844});
      await page.locator('.table-filter-toggle[data-col-index="1"]').click();
      const button = page.locator('#table-filter-panel [data-sort="reverse"]');
      assert.equal(await button.textContent(), '逆順');
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      const bounds = await button.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
      await page.screenshot({path: path.join(fixture, 'reverse-mobile.png'), fullPage: true});
      await page.keyboard.press('Escape');
      await page.setViewportSize({width: 1280, height: 800});
      await action('reset');
      assert.deepEqual(await order(), ['3', '1', '4', '2']);
      assert.equal(await page.locator('th[aria-sort="other"]').count(), 0);
    });

    await t.test('frozen third column excludes hidden second column and restores', async () => {
      await reset({columns: ['A', 'B', 'C', 'D'], rows: [
        {A: '1', B: 'x', C: {type: 'color', color: 'black'}, D: 'long scrolling content '.repeat(40)},
        {A: '2', B: 'y', C: 'v', D: 'long scrolling content '.repeat(40)},
      ]});
      await setColumn(page, 2, true);
      await page.locator('#table-columns-toggle').click();
      await page.locator('[data-freeze-index="2"]').check();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('tbody tr').first().locator('td').nth(2).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
      await page.locator('#data-table').evaluate(el => el.style.minWidth = '1500px');
      await page.locator('.table-scroll').evaluate(el => el.scrollLeft = 500);
      await page.waitForFunction(() => {
        const cells = document.querySelectorAll('thead th');
        return Math.abs(cells[2].getBoundingClientRect().x - cells[0].getBoundingClientRect().right) < 2;
      });
      await page.locator('.table-scroll').evaluate(el => el.scrollLeft = 0);
      await setColumn(page, 1, false);
      const offset = await page.locator('thead th').nth(2).evaluate(el => parseFloat(el.style.left));
      const firstWidth = await page.locator('thead th').nth(0).evaluate(el => el.getBoundingClientRect().width);
      assert.ok(Math.abs(offset - firstWidth) < 1);
      await page.reload();
      assert.equal(await page.locator('thead th').nth(2).evaluate(el => el.classList.contains('is-frozen')), true);
      await page.locator('#data-table').evaluate(el => el.style.minWidth = '1500px');
      await page.locator('.table-scroll').evaluate(el => el.scrollLeft = 200);
      await page.waitForTimeout(100);
      const cells = await page.locator('thead th').evaluateAll(els => els.map(el => ({x: el.getBoundingClientRect().x, w: el.getBoundingClientRect().width})));
      assert.ok(Math.abs(cells[2].x - cells[0].x - cells[0].w) < 2);
      await page.screenshot({path: path.join(fixture, 'frozen-desktop.png'), fullPage: true});
      await page.setViewportSize({width: 390, height: 844});
      await page.locator('#table-columns-toggle').click();
      const panel = await page.locator('#table-columns-panel').boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= 391);
      await page.screenshot({path: path.join(fixture, 'frozen-mobile.png'), fullPage: true});
      await page.setViewportSize({width: 1280, height: 800});
    });

    await t.test('breadcrumb links lead to ancestor pages', async () => {
      await page.goto(url(path.join(root, '001')));
      const links = page.locator('.breadcrumbs a');
      assert.equal(await links.count(), 1);
      assert.equal(await page.locator('.breadcrumbs [aria-current="page"]').textContent(), '001');
      await links.first().click();
      assert.equal(page.url(), url());
      assert.deepEqual(errors, []);
    });
    passed = true;
  } finally {
    await browser.close();
    if (passed && !process.env.KEEP_BROWSER_FIXTURE) fs.rmSync(fixture, { recursive: true });
    else console.error('Browser test fixtures retained:', fixture);
  }
});
