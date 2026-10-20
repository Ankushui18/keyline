// Focused regressions for the user's palette, history icons, cursor and extra-artboard report.
async function reviewAudit(mainPage) {
  const origin = new URL(mainPage.url()).origin;
  const root = __PROJECT_ROOT__;
  const browser = mainPage.context().browser();
  const contexts = [];
  const results = [];
  const accessibility = {};
  const errors = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const check = async (name, callback) => { await callback(); results.push({ name, status: 'passed' }); };
  const makePage = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('heading', { name: 'What are you drawing?' }).waitFor();
    await page.locator('.di-number-field').first().waitFor();
    return page;
  };
  const button = (page, name) => page.getByRole('button', { name, exact: true });
  const frames = (page) => page.getByRole('treeitem', { name: /, frame$/ });
  const oneFrame = async (page, name) => {
    await page.getByRole('treeitem', { name: `${name}, frame`, exact: true }).waitFor();
    assert(await frames(page).count() === 1, 'Only the chosen frame should be listed');
  };
  const saved = async (page) => {
    await page.waitForFunction(() => document.querySelector('.topbar-save')?.textContent === 'Saved');
    return page.evaluate(async () => {
      const id = new URL(location.href).searchParams.get('doc');
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('vector-studio');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('documents').objectStore('documents').get(id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    });
  };
  const axe = async (page, name) => {
    await page.addScriptTag({ path: `${root}/node_modules/axe-core/axe.min.js` });
    accessibility[name] = await page.evaluate(async () => {
      const report = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return report.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary })) }));
    });
    assert(accessibility[name].length === 0, `${name}: ${JSON.stringify(accessibility[name])}`);
  };
  let page;
  try {
    page = await makePage();
    await check('Existing app surface, fields and blue accent are preserved', async () => {
      const colors = await page.evaluate(() => ({
        surface: getComputedStyle(document.querySelector('.reference-sidebar')).backgroundColor,
        field: getComputedStyle(document.querySelector('.di-number-field')).backgroundColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--blue').trim(),
      }));
      assert(colors.surface === 'rgb(31, 32, 35)', `Original sidebar surface: ${JSON.stringify(colors)}`);
      assert(colors.field === 'rgb(23, 24, 26)', `Original field surface: ${JSON.stringify(colors)}`);
      assert(colors.accent === '#0d99ff', 'The existing blue accent must not be replaced');
    });
    await check('Undo/Redo are 16px filled glyphs inside unchanged 32px click targets', async () => {
      for (const name of ['Undo', 'Redo']) {
        const target = button(page, name);
        const box = await target.boundingBox();
        const glyph = await target.locator('svg').evaluate((element) => ({
          width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
          fill: getComputedStyle(element).fill, stroke: getComputedStyle(element).stroke,
        }));
        assert(box.width === 32 && box.height === 32, `${name}: preserve click target size`);
        assert(glyph.width === 16 && glyph.height === 16 && glyph.fill !== 'none' && glyph.stroke === 'none', `${name}: ${JSON.stringify(glyph)}`);
      }
    });
    let iconRow;
    await check('Choosing 24px creates exactly one actual artboard, not just one visible row', async () => {
      await page.getByRole('group', { name: 'Icon frame size' }).getByRole('button', { name: '24', exact: true }).click();
      await oneFrame(page, 'Icon 24');
      iconRow = await saved(page);
      assert(iconRow.snapshot.artboards.length === 1, 'The saved document must not contain the default oversized board');
      const frame = iconRow.snapshot.artboards[0][1].frame;
      assert(frame.x === 0 && frame.y === 0 && frame.width === 24 && frame.height === 24, `Chosen frame: ${JSON.stringify(frame)}`);
      await page.screenshot({ path: `${root}/audit/review-icon-start.png`, fullPage: true });
      await axe(page, 'icon-start');
    });
    await check('Move has no extra SVG stroke; custom line-tool icons retain their strokes', async () => {
      const cursor = await button(page, 'Select (V)').locator('svg').evaluate((element) => ({
        width: element.getBoundingClientRect().width, fill: getComputedStyle(element).fill, stroke: getComputedStyle(element).stroke,
      }));
      assert(cursor.width === 18 && cursor.fill !== 'none' && cursor.stroke === 'none', `Cursor: ${JSON.stringify(cursor)}`);
      for (const name of ['Pen (P)', 'Rectangle (R)', 'Bend (D)', 'Shape Builder (B)']) {
        const glyph = await button(page, name).locator('svg').evaluate((element) => ({ fill: getComputedStyle(element).fill, stroke: getComputedStyle(element).stroke }));
        assert(glyph.fill === 'none' && glyph.stroke !== 'none', `${name}: do not erase line-tool icons`);
      }
    });
    await check('Initial frame choice supports Undo/Redo without a second artboard', async () => {
      await button(page, 'Undo').click();
      await oneFrame(page, 'Artboard 1');
      assert(await button(page, 'Redo').isEnabled(), 'Redo must be available');
      await button(page, 'Redo').click();
      await oneFrame(page, 'Icon 24');
      assert((await saved(page)).snapshot.artboards.length === 1, 'Redo must not add a duplicate');
    });
    await check('Reloading an empty chosen icon frame does not reopen onboarding or restore the default', async () => {
      await page.reload();
      await oneFrame(page, 'Icon 24');
      assert(await page.getByRole('heading', { name: 'What are you drawing?' }).count() === 0, 'An explicitly started blank file is not a first visit');
      assert((await saved(page)).snapshot.artboards.length === 1, 'Reload must preserve the single frame');
    });
    await check('Deliberately adding a second blank frame keeps both frames, including after reload', async () => {
      await button(page, 'New frame').click();
      await page.getByRole('treeitem', { name: 'Artboard 2, frame', exact: true }).waitFor();
      assert(await frames(page).count() === 2, 'Do not filter away intentionally blank frames');
      assert((await saved(page)).snapshot.artboards.length === 2, 'Keep both actual frames');
      await page.reload();
      await page.getByRole('treeitem', { name: 'Artboard 2, frame', exact: true }).waitFor();
      assert(await frames(page).count() === 2, 'Keep both blank frames after reload');
      await axe(page, 'two-blank-frames');
    });
    await check('Dashboard Icon set start also creates only its chosen frame', async () => {
      await button(page, 'Back to all files').click();
      await page.getByRole('button', { name: /Icon set.*24 px frame/ }).click();
      await oneFrame(page, 'Icon 24');
      assert((await saved(page)).snapshot.artboards.length === 1, 'Dashboard path must also replace the unused starter');
    });
    for (const [label, size] of [['32', 32], ['48', 48], ['Custom', 64]]) {
      await check(`${label} icon onboarding starts with exactly one ${size}px artboard`, async () => {
        const next = await makePage();
        await next.getByRole('group', { name: 'Icon frame size' }).getByRole('button', { name: label, exact: true }).click();
        await oneFrame(next, `Icon ${size}`);
        const row = await saved(next);
        assert(row.snapshot.artboards.length === 1 && row.snapshot.artboards[0][1].frame.width === size, 'Only the selected preset must be saved');
      });
    }
    await check('An old two-frame icon-only file is repaired in the actual model and remains undoable', async () => {
      const legacy = await makePage();
      const legacyId = await legacy.evaluate(async (row) => {
        const snapshot = row.snapshot;
        const starter = snapshot.artboards[0][1];
        starter.name = 'Artboard 1';
        starter.frame = { x: -512, y: -384, width: 1024, height: 768 };
        const artboardId = crypto.randomUUID();
        const networkId = crypto.randomUUID();
        const appearanceId = crypto.randomUUID();
        const objectId = crypto.randomUUID();
        const layerId = crypto.randomUUID();
        snapshot.artboards.push([artboardId, { id: artboardId, pageId: starter.pageId, name: 'Icon 24', frame: { x: 552, y: -384, width: 24, height: 24 }, layerIds: [layerId], background: '#ffffff', clipContent: false }]);
        snapshot.pages[0].artboardIds.push(artboardId);
        snapshot.networks.push({ id: networkId, nodeIds: [], pathIds: [] });
        snapshot.appearances.push([appearanceId, { ...snapshot.appearances[0][1], id: appearanceId }]);
        snapshot.objects.push([objectId, { id: objectId, name: 'Vector Network 1', networkId, appearanceId, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } }]);
        snapshot.layers.push([layerId, { id: layerId, kind: 'object', name: 'Vector Network 1', artboardId, childIds: [], objectId, visible: true, locked: false, expanded: true }]);
        snapshot.activeArtboardId = artboardId;
        row.artboardCount = 2;
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('vector-studio');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise((resolve, reject) => {
            const transaction = db.transaction('documents', 'readwrite');
            transaction.objectStore('documents').put(row);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
          });
        } finally { db.close(); }
        return row.id;
      }, iconRow);
      await legacy.goto(`${origin}/?doc=${encodeURIComponent(legacyId)}`);
      await oneFrame(legacy, 'Icon 24');
      assert((await saved(legacy)).snapshot.artboards.length === 1, 'Delete only the exact untouched leftover template, not just its row');
      await button(legacy, 'Undo').click();
      await legacy.getByRole('treeitem', { name: 'Artboard 1, frame', exact: true }).waitFor();
      assert(await frames(legacy).count() === 2, 'Legacy cleanup must be undoable');
      await button(legacy, 'Redo').click();
      await oneFrame(legacy, 'Icon 24');
      await axe(legacy, 'legacy-icon-repair');
    });
    await check('No browser runtime errors', async () => assert(errors.length === 0, JSON.stringify(errors)));
  } catch (error) {
    results.push({ status: 'failed', message: error.message, stack: error.stack });
    if (page) await page.screenshot({ path: `${root}/audit/review-failure.png`, fullPage: true }).catch(() => undefined);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
  return { results, accessibility, runtimeErrors: errors, passed: results.filter((test) => test.status === 'passed').length, failed: results.filter((test) => test.status === 'failed').length };
}
