async function designSidebarAudit(mainPage) {
  const origin = new URL(mainPage.url()).origin;
  const root = __PROJECT_ROOT__;
  const context = await mainPage.context().browser().newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const results = [];
  const accessibility = {};
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const close = (actual, expected, label) => assert(Math.abs(Number(actual) - expected) < .01, `${label}: ${actual} != ${expected}`);
  const input = (name) => page.getByRole('spinbutton', { name, exact: true });
  const valueIs = async (name, expected, label) => {
    await page.waitForFunction(({ name, expected }) => {
      const element = document.querySelector(`input[aria-label="${name}"]`);
      return element && Math.abs(Number(element.value) - expected) < .01;
    }, { name, expected }, { timeout: 5000 });
    close(await input(name).inputValue(), expected, label);
  };
  const button = (name) => page.getByRole('button', { name, exact: true });
  const edit = async (name, value, key = 'Enter') => { await input(name).fill(String(value)); await input(name).press(key); };
  const check = async (name, callback) => { await callback(); results.push({ name, status: 'passed' }); };
  const axe = async (name) => {
    await page.addScriptTag({ path: `${root}/node_modules/axe-core/axe.min.js` });
    accessibility[name] = await page.evaluate(async () => {
      const report = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return report.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary })) }));
    });
    assert(accessibility[name].length === 0, `${name} accessibility: ${JSON.stringify(accessibility[name])}`);
  };
  const stacked = async () => {
    const layers = await page.getByRole('region', { name: 'Document layers' }).boundingBox();
    const design = await page.getByRole('complementary', { name: 'Design inspector' }).boundingBox();
    assert(layers && design && layers.y + layers.height <= design.y + 1 && design.height > 200, 'Layers must remain above a useful Design panel');
    assert(await page.locator('.reference-design').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'Inspector must not overflow horizontally');
  };
  try {
    await page.goto(origin);
    await page.getByRole('region', { name: 'Frame', exact: true }).waitFor();
    await check('Empty document keeps the original palette with Layers above a compact Design panel', async () => {
      await stacked();
      assert(await page.locator('.reference-design').evaluate((element) => getComputedStyle(element).backgroundColor) === 'rgb(31, 32, 35)', 'Existing app palette is preserved');
      await axe('empty-frame');
    });
    await page.getByRole('button', { name: /^Open a sample/ }).click();
    await page.getByRole('treeitem', { name: 'Triangle, object', exact: true }).click();
    await input('Object X position').waitFor();
    await check('Position fields commit numbers, negative coordinates and expressions; Escape cancels', async () => {
      await edit('Object X position', '3.5');
      await valueIs('Object X position', 3.5, 'X position');
      await edit('Object X position', '99', 'Escape');
      await valueIs('Object X position', 3.5, 'Escape restores X');
      await edit('Object X position', '3+2');
      await valueIs('Object X position', 5, 'Expression');
      await edit('Object X position', '-4');
      await valueIs('Object X position', -4, 'Absolute negative');
      await edit('Object X position', '*2');
      await valueIs('Object X position', -8, 'Relative expression');
      await button('Undo').click();
      await valueIs('Object X position', -4, 'Undo position');
    });
    await check('Single-object alignment now aligns to the frame and supports Undo', async () => {
      await button('Align left').click();
      await valueIs('Object X position', 0, 'Left alignment');
      await button('Undo').click();
      await valueIs('Object X position', -4, 'Undo alignment');
    });
    await check('Aspect-ratio lock resizes both dimensions without moving the object', async () => {
      const width = Number(await input('Object width').inputValue());
      const height = Number(await input('Object height').inputValue());
      const x = Number(await input('Object X position').inputValue());
      await button('Lock aspect ratio').click();
      await edit('Object width', width * 2);
      await valueIs('Object width', width * 2, 'Width');
      await valueIs('Object height', height * 2, 'Locked height');
      await valueIs('Object X position', x, 'Anchored X');
      await button('Undo').click();
      await valueIs('Object height', height, 'Undo both dimensions');
      await button('Lock aspect ratio').click();
    });
    await check('Rotation and flip icon buttons make undoable edits', async () => {
      await button('Rotate 90 degrees').click();
      await valueIs('Object rotation', 90, 'Rotate');
      await button('Undo').click();
      await valueIs('Object rotation', 0, 'Undo rotate');
      await button('Flip vertical').click();
      await button('Undo').click();
      await valueIs('Object rotation', 0, 'Flip preserves rotation');
    });
    await check('Appearance opacity commits and rolls back invalid input', async () => {
      await edit('Object opacity', 75);
      await valueIs('Object opacity', 75, 'Opacity');
      await edit('Object opacity', 150);
      await valueIs('Object opacity', 75, 'Invalid opacity rejected');
      await button('Undo').click();
      await valueIs('Object opacity', 100, 'Undo opacity');
    });
    await check('Fill swatch, hex, percentage, visibility and removal retain real operations', async () => {
      await button('Add fill').click();
      const hex = page.getByRole('textbox', { name: 'Fill hex', exact: true });
      await hex.fill('1A1A1A'); await hex.press('Enter');
      assert(await page.getByRole('textbox', { name: 'Fill colour', exact: true }).inputValue() === '#1a1a1a', 'Hex updates swatch');
      const opacity = page.getByRole('textbox', { name: 'Fill opacity', exact: true });
      await opacity.fill('65'); await opacity.press('Enter');
      assert(await opacity.inputValue() === '65', 'Fill percentage');
      await button('Hide Fill').click(); await button('Show Fill').click();
      await button('Remove Fill').click();
      assert(await hex.count() === 0, 'Fill removed');
      await button('Add fill').click();
    });
    await check('Corner radius and independent-corner controls remain available', async () => {
      await edit('Corner radius', .5);
      await valueIs('Corner radius', .5, 'Radius');
      await button('Independent corners').click();
      await page.locator('.di-corner-grid input').first().waitFor();
      assert(await page.locator('.di-corner-grid input').count() >= 2, 'Per-corner fields for the non-junction corners');
      await button('Independent corners').click();
      await button('Undo').click();
      await valueIs('Corner radius', 0, 'Undo radius');
    });
    await check('Locked layers show read-only Design controls', async () => {
      const triangle = page.getByRole('treeitem', { name: 'Triangle, object', exact: true });
      await triangle.getByRole('button', { name: 'Lock layer', exact: true }).click();
      assert(await input('Object width').isDisabled(), 'Locked width must be read-only');
      await triangle.getByRole('button', { name: 'Unlock layer', exact: true }).click();
      assert(await input('Object width').isEnabled(), 'Unlocked width must be editable');
    });
    await page.locator('.reference-design').evaluate((element) => element.scrollTop = 0);
    await check('Object selection passes automated accessibility checks', () => axe('object'));
    await page.screenshot({ path: `${root}/audit/design-sidebar-object.png`, fullPage: true });
    await check('Layers and Design divider supports keyboard, pointer drag and persistence', async () => {
      const separator = page.getByRole('separator', { name: 'Resize Layers and Design', exact: true });
      const initial = Number(await separator.getAttribute('aria-valuenow'));
      await separator.focus(); await separator.press('ArrowUp');
      close(await separator.getAttribute('aria-valuenow'), initial - 12, 'Keyboard split');
      const bounds = await separator.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 37, { steps: 5 }); await page.mouse.up();
      const height = Number(await separator.getAttribute('aria-valuenow'));
      assert(height > initial, 'Pointer increases Layers height');
      await page.waitForFunction(() => document.querySelector('.topbar-save')?.textContent === 'Saved');
      await page.reload(); await separator.waitFor();
      await page.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor();
      close(await separator.getAttribute('aria-valuenow'), height, 'Persisted split');
      await stacked();
    });
    await check('Collapsing and reopening restores both panels', async () => {
      await button('Collapse panels').click();
      await button('Open panels').waitFor();
      assert(await page.getByRole('region', { name: 'Document layers' }).count() === 0, 'Collapsed contents removed');
      await button('Open panels').click();
      await page.getByRole('region', { name: 'Document layers' }).waitFor();
      await stacked();
    });
    await check('Frame resizing keeps live Enter/Escape transactions and linked proportions', async () => {
      await page.getByRole('treeitem', { name: 'Icon 24, frame', exact: true }).click();
      await edit('Artboard width', 32, 'Escape');
      await valueIs('Artboard width', 24, 'Escape frame width');
      await edit('Artboard width', 32);
      await valueIs('Artboard width', 32, 'Commit frame width');
      await button('Undo').click();
      await valueIs('Artboard width', 24, 'Undo frame width');
      await button('Lock aspect ratio').click();
      await edit('Artboard width', 48);
      await valueIs('Artboard height', 48, 'Linked frame height');
      await button('Undo').click();
      await valueIs('Artboard width', 24, 'Undo linked frame width');
      await valueIs('Artboard height', 24, 'Undo linked frame height');
      await button('Lock aspect ratio').click();
    });
    await check('Frame background color, opacity and visibility are editable', async () => {
      await edit('Frame background opacity', 50);
      await valueIs('Frame background opacity', 50, 'Frame opacity');
      await button('Hide frame background').click();
      await valueIs('Frame background opacity', 0, 'Hide background');
      await button('Show frame background').click();
      await valueIs('Frame background opacity', 50, 'Restore background opacity');
      const hex = page.getByRole('textbox', { name: 'Frame fill hex', exact: true });
      await hex.fill('FAFAFA'); await hex.press('Enter');
      assert(await hex.inputValue() === 'FAFAFA', 'Frame fill hex');
      // Unsupported model/renderer settings are explicitly disabled.
      assert(await page.getByRole('checkbox', { name: 'Clip content', exact: true }).isDisabled(), 'Unsupported clipping is read-only');
    });
    await page.locator('.reference-design').evaluate((element) => element.scrollTop = 0);
    await check('Frame selection passes automated accessibility checks', () => axe('frame'));
    await page.screenshot({ path: `${root}/audit/design-sidebar-frame.png`, fullPage: true });
    await check('Multiple selection uses compact alignment and real arrange actions', async () => {
      await page.getByRole('treeitem', { name: 'Triangle, object', exact: true }).click();
      await page.keyboard.down('Control');
      await page.getByRole('treeitem', { name: 'Ring, object', exact: true }).click();
      await page.keyboard.up('Control');
      await page.getByText('Multiple objects', { exact: true }).waitFor();
      await button('Arrange horizontally').click();
      await button('Undo').click();
      await button('Align top').click();
      await button('Undo').click();
      await axe('multiple-objects');
      await stacked();
    });
    await check('Minimum-width sidebar and shorter viewport have independent scrolling and no field overflow', async () => {
      await page.getByRole('treeitem', { name: 'Triangle, object', exact: true }).click();
      const resizer = page.getByRole('separator', { name: 'Resize inspector sidebar', exact: true });
      await resizer.focus();
      for (let i = 0; i < 4; i++) await resizer.press('ArrowRight');
      close(await resizer.getAttribute('aria-valuenow'), 240, 'Minimum sidebar width');
      await page.setViewportSize({ width: 980, height: 720 });
      await stacked();
      const fieldWidths = await page.locator('.di-number-field').evaluateAll((elements) => elements.map((element) => ({ width: element.clientWidth, scroll: element.scrollWidth })));
      assert(fieldWidths.every(({ width, scroll }) => width >= 60 && scroll <= width + 1), 'Compact fields fit');
      await page.locator('.reference-design').evaluate((element) => element.scrollTop = element.scrollHeight);
      assert(await page.getByRole('heading', { name: 'Stroke', exact: true }).isVisible(), 'Lower inspector remains reachable');
      await page.locator('.reference-design').evaluate((element) => element.scrollTop = 0);
      await axe('compact-sidebar');
      await page.screenshot({ path: `${root}/audit/design-sidebar-compact.png`, fullPage: true });
    });
    assert(errors.length === 0, `Browser runtime errors: ${JSON.stringify(errors)}`);
  } catch (error) {
    await page.screenshot({ path: `${root}/audit/design-sidebar-failure.png`, fullPage: true });
    results.push({ status: 'failed', message: error.message, stack: error.stack, page: page.url(), layers: await page.getByRole('treeitem').allTextContents() });
  } finally {
    await context.close();
  }
  return { results, accessibility, runtimeErrors: errors, passed: results.filter((test) => test.status === 'passed').length, failed: results.filter((test) => test.status === 'failed').length };
}
