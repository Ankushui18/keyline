// Run using the preinstalled Arena browser session:
// npm run test:browser (the runner injects this project's absolute directory)
async function browserAudit(mainPage) {
  const origin = mainPage.url().match(/^https?:\/\/[^/]+/)[0];
  const assert = {
    equal(a, b, message = 'Expected equal values') { if (a !== b) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); },
    notEqual(a, b) { if (a === b) throw new Error('Expected different values'); },
    deepEqual(a, b, message = 'Expected matching values') { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); },
    ok(value) { if (!value) throw new Error('Expected a truthy value'); },
    match(value, pattern) { if (!pattern.test(value)) throw new Error(`Value did not match ${pattern}: ${value}`); },
  };
  const browser = mainPage.context().browser();
  const contexts = [];
  const results = [];
  const accessibility = {};
  const errors = [];
  const projectRoot = __PROJECT_ROOT__;
  const directory = `${projectRoot}/audit`;
  async function context(options = {}) {
    const value = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    contexts.push(value);
    return value;
  }
  async function check(name, callback) {
    await callback(); results.push({ name, status: 'passed' });
  }
  async function axe(page, name) {
    await page.addScriptTag({ path: `${projectRoot}/node_modules/axe-core/axe.min.js` });
    const violations = await page.evaluate(async () => {
      const report = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return report.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary })) }));
    });
    accessibility[name] = violations;
    assert.equal(violations.length, 0, `${name} accessibility: ${JSON.stringify(violations)}`);
  }
  try {
    const firstContext = await context();
    const first = await firstContext.newPage();
    first.on('pageerror', (error) => errors.push(error.message));
    const sockets = [];
    first.on('websocket', (socket) => sockets.push(socket.url()));
    await check('First visit, sample creation, undo and redo', async () => {
      await first.goto(origin);
      await first.getByRole('heading', { name: 'What are you drawing?' }).waitFor();
      await first.getByRole('button', { name: /^Open a sample/ }).click();
      await first.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor();
      await first.getByRole('button', { name: 'Undo', exact: true }).click();
      await first.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor({ state: 'detached' });
      await first.getByRole('button', { name: 'Redo', exact: true }).click();
      await first.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor();
      await first.keyboard.press('Escape');
    });
    await check('Autosave and reload preserve geometry and name', async () => {
      await first.locator('.topbar-name').click();
      await first.getByRole('textbox', { name: 'File name', exact: true }).fill('Audit sample');
      await first.getByRole('textbox', { name: 'File name', exact: true }).press('Enter');
      await first.waitForFunction(() => document.querySelector('.topbar-save')?.textContent === 'Saved');
      await first.reload();
      await first.getByRole('button', { name: 'Audit sample', exact: true }).waitFor();
      await first.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor();
    });
    await check('Editor passes automated WCAG A/AA checks', () => axe(first, 'editor'));
    await first.screenshot({ path: `${directory}/editor-final.png`, fullPage: true });

    await check('Export previews, downloads and denied clipboard are safe', async () => {
      await first.getByRole('button', { name: 'Export', exact: true }).click();
      const dialog = first.getByRole('dialog'); await dialog.waitFor();
      await axe(first, 'export');
      const preview = await first.getByRole('textbox', { name: 'Exported code preview' }).inputValue();
      assert.match(preview, /viewBox="0 0 24 24"/);
      const downloading = first.waitForEvent('download');
      await first.getByRole('button', { name: 'Download SVG', exact: true }).click();
      const download = await downloading;
      assert.match(download.suggestedFilename(), /\.svg$/);
      await download.saveAs(`${directory}/sample-export.svg`);
      await first.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); } },
      }));
      await first.getByRole('button', { name: 'Copy code', exact: true }).click();
      await first.getByText('Could not copy. Download the file instead, or allow clipboard access in your browser.', { exact: true }).waitFor();
      await first.getByRole('button', { name: 'React', exact: true }).click();
      assert.match(await first.getByRole('textbox', { name: 'Exported code preview' }).inputValue(), /escapeAttribute/);
      await first.getByRole('button', { name: 'Close export dialog' }).click();
    });

    let link;
    await check('Share focus is trapped and clipboard failure is not reported as success', async () => {
      await first.locator('.topbar-share').click();
      const dialog = first.getByRole('dialog'); await dialog.waitFor();
      assert.equal(await first.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close');
      await dialog.getByRole('button', { name: 'Done', exact: true }).focus();
      await first.keyboard.press('Tab');
      assert.equal(await first.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close');
      await first.keyboard.press('Shift+Tab');
      assert.equal(await first.evaluate(() => document.activeElement?.textContent), 'Done');
      await dialog.getByRole('switch', { name: 'Share a live link' }).click();
      await first.locator('.kd-status.is-synced').waitFor();
      await dialog.getByRole('button', { name: 'Copy link', exact: true }).waitFor();
      link = await dialog.locator('.kd-copy code').textContent();
      assert.equal(/[?&]doc=/.test(link), false);
      await axe(first, 'share');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      assert.equal(await first.evaluate(() => document.activeElement?.classList.contains('topbar-share')), true);
      assert.ok(sockets.some((url) => url.startsWith(`${origin.replace(/^http/, 'ws')}/collaboration/`)));
    });

    const secondContext = await context();
    const second = await secondContext.newPage();
    second.on('pageerror', (error) => errors.push(error.message));
    await check('Two independent browsers join through the same-origin proxy with distinct local file IDs', async () => {
      await second.goto(link);
      await second.locator('.topbar-share.status-synced').waitFor();
      await second.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor();
      assert.notEqual(first.url().match(/[?&]doc=([^&]+)/)?.[1], second.url().match(/[?&]doc=([^&]+)/)?.[1]);
      await first.locator('.topbar-people').waitFor();
      await first.locator('.topbar-share').click();
      await first.getByRole('dialog').waitFor();
      await axe(first, 'share-with-peer');
      await first.getByRole('button', { name: 'Done', exact: true }).click();
    });
    const frameCount = (page) => page.getByRole('treeitem', { name: /, frame$/ }).count();
    const createFrame = async (page, size) => {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: new RegExp(`New ${size}×${size} frame`) }).click();
    };
    await check('Live semantic edits appear on the other device', async () => {
      await createFrame(second, 32);
      await first.getByRole('treeitem', { name: 'Icon 32, frame', exact: true }).waitFor();
      assert.equal(await frameCount(first), await frameCount(second));
    });
    await check('Concurrent online/offline edits converge on reconnect', async () => {
      const before = await frameCount(first);
      await secondContext.setOffline(true);
      await createFrame(second, 48);
      await createFrame(first, 32);
      await secondContext.setOffline(false);
      await second.locator('.topbar-share.status-synced').waitFor();
      await first.waitForFunction((count) => document.querySelectorAll('.lp-frame[role="treeitem"]').length === count, before + 2);
      await second.waitForFunction((count) => document.querySelectorAll('.lp-frame[role="treeitem"]').length === count, before + 2);
      const labels = async (page) => (await page.getByRole('treeitem', { name: /, frame$/ }).allTextContents()).sort();
      assert.deepEqual(await labels(first), await labels(second));
    });
    await secondContext.close(); contexts.splice(contexts.indexOf(secondContext), 1);

    await check('Settings and command search keep modal focus and pass accessibility checks', async () => {
      await first.getByRole('button', { name: 'More', exact: true }).click();
      await first.getByRole('menuitem', { name: /^Settings/ }).click();
      await first.getByRole('dialog').waitFor();
      await axe(first, 'settings');
      await first.keyboard.press('Escape');
      await first.keyboard.press('Control+k');
      await first.getByRole('combobox', { name: 'Search actions or describe an edit' }).waitFor();
      await axe(first, 'commands');
      await first.keyboard.press('Escape');
    });

    await check('Motion workspace keeps background inert and passes accessibility checks', async () => {
      await first.getByRole('button', { name: 'More', exact: true }).click();
      await first.getByRole('menuitem', { name: /^Motion/ }).click();
      await first.getByRole('dialog').waitFor();
      await axe(first, 'motion');
      await first.keyboard.press('Escape');
    });

    await check('Files dashboard remains usable and passes accessibility checks', async () => {
      await first.getByRole('button', { name: 'Back to all files', exact: true }).click();
      await first.getByRole('button', { name: 'Open Audit sample', exact: true }).waitFor();
      await axe(first, 'dashboard');
    });

    await check('Editor still works when localStorage is blocked', async () => {
      const blockedContext = await context();
      await blockedContext.addInitScript(() => Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Blocked by browser policy', 'SecurityError'); },
      }));
      const blocked = await blockedContext.newPage();
      blocked.on('pageerror', (error) => errors.push(error.message));
      await blocked.goto(origin);
      await blocked.getByRole('button', { name: /^Open a sample/ }).click();
      await blocked.getByRole('treeitem', { name: 'Triangle, object', exact: true }).waitFor();
      await blocked.locator('.topbar-share').click();
      await blocked.getByRole('dialog').waitFor();
      await blocked.getByRole('button', { name: 'Done', exact: true }).click();
      await blockedContext.close(); contexts.splice(contexts.indexOf(blockedContext), 1);
    });
    assert.deepEqual(errors, [], 'Unhandled browser runtime errors');
  } catch (error) {
    results.push({ status: 'failed', message: error.message, stack: error.stack });
  } finally {
    for (const value of contexts) await value.close();
  }
  const report = { results, accessibility, runtimeErrors: errors, passed: results.filter((test) => test.status === 'passed').length, failed: results.filter((test) => test.status === 'failed').length };
  return report;
}
