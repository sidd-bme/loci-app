// node scripts/qa/showcase-interactions.mjs --base http://127.0.0.1:8000/ [--out /path/to/evidence]
// Requires desktop's Playwright or LOCI_PLAYWRIGHT pointing to a Playwright module.
// Chrome is the default. --browser webkit uses a preinstalled Playwright WebKit.
// --only 'tabs|history' selects named checks for a focused rerun.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://sidd-bme.github.io/loci-app/' },
    browser: { type: 'string', default: 'chrome' },
    only: { type: 'string' },
    out: { type: 'string' },
  },
});
assert.match(values.browser, /^(chrome|webkit)$/);
const base = new URL(values.base);
assert.match(base.protocol, /^https?:$/);
assert.ok(base.pathname.endsWith('/') && !base.search && !base.hash, '--base must be a site directory URL');
const selection = values.only ? new RegExp(values.only, 'i') : null;

const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url));
const { chromium, webkit } = desktopRequire(
  process.env.LOCI_PLAYWRIGHT ? resolve(process.env.LOCI_PLAYWRIGHT) : 'playwright',
);
const browser = await (values.browser === 'webkit'
  ? webkit.launch({ headless: true })
  : chromium.launch({ channel: 'chrome', headless: true }));

const WAIT = 7000;
const PIXEL = 1; // CSS pixels, including fractional layout and scroll rounding.
const MODES = '#mode-tabs .mode-tab';
const PANEL = '.mode-panel:not([hidden])';
const IMAGE = `${PANEL} .workbench-frame img`;
const ANCHORS = ['top', 'modes', 'workflows', 'specimen', 'assistant', 'engineering', 'film', 'download'];
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const NARROW = { width: 320, height: 720 };
const report = { base: base.href, browser: values.browser, version: browser.version(), checks: [] };

async function check(name, contextOptions, run, { expectedResourceFailures = false } = {}) {
  if (selection && !selection.test(name)) return;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT);
  page.setDefaultNavigationTimeout(WAIT * 2);
  const entry = { name, evidence: [], errors: [] };
  report.checks.push(entry);
  page.on('pageerror', error => entry.errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !expectedResourceFailures) entry.errors.push(message.text());
  });
  try {
    await run(page, entry.evidence);
    assert.deepEqual(entry.errors, [], 'browser errors');
    entry.passed = true;
    console.log(`PASS ${name}`);
  } catch (error) {
    entry.passed = false;
    entry.failure = error.stack;
    console.error(`FAIL ${name}\n${error.message}`);
    if (values.out) {
      const file = resolve(values.out, `${values.browser}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
      await page.screenshot({ path: file, timeout: WAIT }).catch(error => entry.errors.push(error.message));
    }
  } finally {
    await context.close();
  }
}

async function visit(page, hash = '', { waitForFonts = true } = {}) {
  const response = await page.goto(new URL(hash, base).href, { waitUntil: 'domcontentloaded' });
  assert.ok(response?.ok(), `could not open ${base.href}${hash}`);
  if (waitForFonts) await page.waitForFunction(() => document.fonts.status === 'loaded');
}

function twoFrames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function geometry(page) {
  return page.evaluate(panel => {
    const selectors = {
      heading: '#hero-heading',
      brand: '.brand',
      tabs: '#mode-tabs',
      stage: `${panel} .workbench-frame`,
      downstream: '#modes + section',
    };
    const boxes = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing layout target ${selector}`);
      const { left, top, width, height } = node.getBoundingClientRect();
      if (!width || !height) throw new Error(`Empty layout target ${selector}`);
      boxes[name] = { x: left + scrollX, y: top + scrollY, width, height };
    }
    return {
      boxes,
      scroll: { x: scrollX, y: scrollY },
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      notesOpen: [...document.querySelectorAll(`${panel} details`)].some(details => details.open),
    };
  }, PANEL);
}

function near(actual, expected, description) {
  assert.ok(Math.abs(actual - expected) <= PIXEL, `${description}: ${expected} → ${actual} CSS px`);
}

function stableLayout(before, after, label) {
  assert.ok(after.overflow <= PIXEL, `${label}: ${after.overflow}px document overflow`);
  assert.equal(after.notesOpen, false, `${label}: expected collapsed details`);
  for (const [name, box] of Object.entries(before.boxes)) {
    for (const field of Object.keys(box)) {
      // The downstream section can have its own responsive height. Its start must stay fixed.
      if (name === 'downstream' && field === 'height') continue;
      near(after.boxes[name][field], box[field], `${label}: ${name}.${field}`);
    }
  }
}

async function measureImage(page) {
  const image = page.locator(IMAGE);
  await image.waitFor({ state: 'visible' });
  await page.waitForFunction(selector => {
    const img = document.querySelector(selector);
    return img?.complete && img.naturalWidth > 0;
  }, IMAGE, { timeout: WAIT });
  await image.evaluate(img => img.decode());
  return image.evaluate(img => {
    const box = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    const number = name => Number.parseFloat(style[name]);
    const width = img.clientWidth - number('paddingLeft') - number('paddingRight');
    const height = img.clientHeight - number('paddingTop') - number('paddingBottom');
    const widthScale = width / img.naturalWidth;
    const heightScale = height / img.naturalHeight;
    const fit = style.objectFit;
    const scale = fit === 'scale-down' ? Math.min(1, widthScale, heightScale) :
      fit === 'contain' ? Math.min(widthScale, heightScale) : fit === 'none' ? 1 :
        fit === 'cover' ? Math.max(widthScale, heightScale) : null;
    const rendered = scale === null ? [width, height] : [img.naturalWidth * scale, img.naturalHeight * scale];
    const offsets = style.objectPosition.split(' ').map((offset, axis) => {
      if (offset.endsWith('%')) return ((axis === 0 ? width : height) - rendered[axis]) * Number.parseFloat(offset) / 100;
      if (offset.endsWith('px')) return Number.parseFloat(offset);
      throw new Error(`Unsupported image object-position: ${style.objectPosition}`);
    });
    const x = box.left + number('borderLeftWidth') + number('paddingLeft') + offsets[0];
    const y = box.top + number('borderTopWidth') + number('paddingTop') + offsets[1];
    const content = { left: x, top: y, right: x + rendered[0], bottom: y + rendered[1] };
    const croppedCorners = (current, bounds) => {
      const radii = [
        current.borderTopLeftRadius, current.borderTopRightRadius,
        current.borderBottomLeftRadius, current.borderBottomRightRadius,
      ];
      const left = content.left - bounds.left;
      const right = bounds.right - content.right;
      const top = content.top - bounds.top;
      const bottom = bounds.bottom - content.bottom;
      const insets = [[left, top], [right, top], [left, bottom], [right, bottom]];
      return radii.flatMap((radius, index) => {
        const [horizontal, vertical = horizontal] = radius.split(' ');
        const pixels = (value, size) => Number.parseFloat(value) * (value.endsWith('%') ? size / 100 : 1);
        const rx = pixels(horizontal, bounds.width);
        const ry = pixels(vertical, bounds.height);
        if (!rx || !ry) return [];
        const [dx, dy] = insets[index];
        // Corners within both axes of a radius must be inside its ellipse.
        const distance = Math.hypot(Math.max(0, rx - dx) / rx, Math.max(0, ry - dy) / ry);
        return distance > 1 ? [index] : [];
      });
    };
    const clips = [];
    const stage = img.closest('.workbench-frame');
    const panel = img.closest('.mode-panel');
    for (let node = img; node; node = node.parentElement) {
      const current = getComputedStyle(node);
      const bounds = node.getBoundingClientRect();
      const clipX = node === img || node === stage || current.overflowX !== 'visible';
      const clipY = node === img || node === stage || current.overflowY !== 'visible';
      const clipsRadii = node === img || (current.overflowX !== 'visible' && current.overflowY !== 'visible');
      if (clipX || clipY) {
        clips.push({
          node: node.tagName + (node.className ? `.${node.className}` : ''),
          x: clipX && Math.min(content.left - bounds.left, bounds.right - content.right),
          y: clipY && Math.min(content.top - bounds.top, bounds.bottom - content.bottom),
          corners: clipsRadii ? croppedCorners(current, bounds) : [],
        });
      }
      if (node === panel) break;
    }
    return { src: img.currentSrc, alt: img.alt, natural: [img.naturalWidth, img.naturalHeight], width, height, fit, rendered, clips };
  });
}

function uncropped(image) {
  assert.ok(image.alt.trim(), 'workbench image has alternative text');
  assert.ok(image.rendered[0] > 0 && image.rendered[1] > 0, 'image occupies a positive area');
  near(image.rendered[1], image.rendered[0] * image.natural[1] / image.natural[0], 'intrinsic aspect ratio');
  for (const clip of image.clips) {
    assert.ok(clip.x >= -PIXEL && clip.y >= -PIXEL, `image clipped by ${clip.node}: ${JSON.stringify(clip)}`);
    assert.ok(clip.corners.length === 0, `${clip.node} border radius clips ${clip.corners.length} screenshot corners`);
  }
}

async function tabVisibility(tab) {
  return tab.evaluate(node => {
    const button = node.getBoundingClientRect();
    const strip = node.closest('#mode-tabs').getBoundingClientRect();
    const header = document.querySelector('#site-header').getBoundingClientRect();
    return {
      focused: node === document.activeElement,
      left: button.left - Math.max(0, strip.left),
      right: Math.min(innerWidth, strip.right) - button.right,
      top: button.top - Math.max(0, header.bottom),
      bottom: innerHeight - button.bottom,
    };
  });
}

async function activeTab(page, tab) {
  const mode = await tab.getAttribute('data-mode');
  assert.ok(mode);
  assert.equal(await tab.getAttribute('aria-selected'), 'true', mode);
  assert.equal(await tab.getAttribute('tabindex'), '0', mode);
  const panelId = await tab.getAttribute('aria-controls');
  assert.ok(panelId);
  const panel = page.locator(PANEL);
  assert.equal(await panel.count(), 1, mode);
  assert.equal(await panel.getAttribute('id'), panelId, mode);
  assert.equal(await panel.getAttribute('role'), 'tabpanel', mode);
  assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'), mode);
  assert.equal(await page.locator(`${MODES}[aria-selected="true"]`).count(), 1, mode);
  assert.equal(await page.locator(`${MODES}[tabindex="0"]`).count(), 1, mode);
  assert.equal(new URL(page.url()).hash, await tab.getAttribute('href'), mode);
  return mode;
}

async function exerciseTabs(page, evidence) {
  const readingLayout = await page.locator('h1, .section-intro h2, .hero-intro > p:first-child').evaluateAll(elements => elements.map(el => {
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      text: el.textContent.trim(),
      fontSize: parseFloat(style.fontSize),
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight)),
    };
  }));
  const lineLimits = { H1: page.viewportSize().width < 740 ? 3 : 2, H2: 2, P: 4 };
  for (const block of readingLayout) {
    assert.ok(block.fontSize >= 16 && block.lines > 0 && block.lines <= lineLimits[block.tag],
      `Unexpected text layout (${block.fontSize}px, ${block.lines} lines): ${block.text}`);
  }
  const tabs = page.getByRole('tablist').getByRole('tab');
  assert.equal(await tabs.count(), 6);
  await tabs.first().scrollIntoViewIfNeeded();
  await twoFrames(page);
  const baseline = await geometry(page);
  const captured = new Set();
  const failures = [];
  const record = async (tab, input, before) => {
    await twoFrames(page);
    const immediately = await geometry(page);
    const image = await measureImage(page);
    await twoFrames(page);
    const decoded = await geometry(page);
    const mode = await tab.getAttribute('data-mode');
    evidence.push({ mode, input, before, immediately, decoded, image });
    try {
      await activeTab(page, tab);
      const { focused, left, right } = await tabVisibility(tab);
      assert.ok(left >= -PIXEL && right >= -PIXEL, `${input} must reveal ${mode} in the strip`);
      if (input !== 'click') assert.ok(focused, `${input} must focus ${mode}`);
      for (const sample of [immediately, decoded]) {
        stableLayout({ boxes: { ...baseline.boxes, brand: before.boxes.brand } }, sample, `${input} ${mode}`);
        for (const axis of ['x', 'y']) near(sample.scroll[axis], before.scroll[axis], `${input} ${mode} page scroll.${axis}`);
      }
      uncropped(image);
    } catch (error) {
      failures.push(error.message);
    }
    captured.add(image.src);
  };
  for (let index = 0; index < 6; index++) {
    const tab = tabs.nth(index);
    // Scroll the target into view before taking the pre-input snapshot.
    await tab.scrollIntoViewIfNeeded();
    await twoFrames(page);
    const before = await geometry(page);
    await tab.click();
    await record(tab, 'click', before);
  }
  await tabs.last().focus();
  const keyboard = [
    ['Home', 0], ['ArrowRight', 1], ['ArrowRight', 2], ['ArrowRight', 3],
    ['ArrowRight', 4], ['ArrowRight', 5], ['ArrowRight', 0], ['ArrowLeft', 5], ['Home', 0], ['End', 5],
  ];
  for (const [key, index] of keyboard) {
    const before = await geometry(page);
    await page.keyboard.press(key);
    await record(tabs.nth(index), key, before);
  }
  assert.ok(failures.length === 0, [...new Set(failures)].join('\n'));
  assert.equal(captured.size, 6, 'each modality displays a distinct source screenshot');
}

async function decodeStability(page, evidence) {
  // Hold only the initially visible screenshot so the first sample proves it is undecoded.
  const sourcePath = await page.locator(IMAGE).getAttribute('src');
  const source = new URL(sourcePath, base).href;
  let releaseImage;
  const gate = new Promise(resolve => { releaseImage = resolve; });
  await page.route(source, async route => {
    await gate;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    const pending = await page.locator(IMAGE).evaluate(img => !img.complete && img.naturalWidth === 0);
    assert.ok(pending, 'initial screenshot is still in flight');
    const before = await geometry(page);
    releaseImage();
    const image = await measureImage(page);
    await twoFrames(page);
    const after = await geometry(page);
    evidence.push({ before, after, image });
    stableLayout(before, after, 'initial screenshot decode');
    near(after.scroll.y, before.scroll.y, 'initial decode page scroll');
    uncropped(image);
  } finally {
    releaseImage();
  }
}

async function exerciseMobileMenu(page) {
  const menu = page.locator('.mobile-menu');
  const summary = menu.locator('summary');
  assert.ok(await summary.isVisible());
  assert.ok((await summary.textContent()).trim() || await summary.getAttribute('aria-label'));
  const nav = menu.getByRole('navigation', { name: /\S/ });
  const links = menu.locator('nav a[href^="#"]');
  assert.equal(await menu.evaluate(node => node.open), false);
  assert.equal(await nav.count(), 0, 'closed navigation hidden from accessibility tree');
  await summary.press('Enter');
  assert.equal(await nav.count(), 1);
  await page.keyboard.press('Tab');
  assert.ok(await links.first().evaluate(node => node === document.activeElement));
  await page.keyboard.press('Escape');
  assert.equal(await menu.evaluate(node => node.open), false);
  assert.ok(await summary.evaluate(node => node === document.activeElement), 'Escape restores menu focus');
  await summary.click();
  await menu.locator('a[href="#specimen"]').click();
  assert.equal(new URL(page.url()).hash, '#specimen');
  assert.equal(await menu.evaluate(node => node.open), false);
}

async function exerciseTheme(page) {
  const toggle = page.getByRole('switch', { name: 'Dark theme', exact: true });
  assert.equal(await toggle.count(), 1);
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.equal(await toggle.getAttribute('title'), 'Switch to light theme');
  const initialBox = await toggle.boundingBox();
  assert.ok(initialBox.width >= 44 && initialBox.height >= 44, 'the icon has a full touch target');
  const headingType = await page.locator('#hero-heading').evaluate(async heading => {
    await document.fonts.ready;
    return {
      loaded: [...document.fonts].some(face => face.family === 'Instrument Sans' && face.status === 'loaded'),
      runs: [heading, ...heading.querySelectorAll('*')].map(node => {
        const style = getComputedStyle(node);
        return { family: style.fontFamily.split(',')[0].replace(/["']/g, ''), style: style.fontStyle };
      }),
    };
  });
  assert.equal(headingType.loaded, true, 'the self-hosted heading font loaded');
  for (const run of headingType.runs) assert.deepEqual(run, { family: 'Instrument Sans', style: 'normal' });
  const colors = () => page.locator('body').evaluate(node => {
    const style = getComputedStyle(node);
    return [style.backgroundColor, style.color];
  });
  const before = await colors();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.getElementById('theme-toggle').getAttribute('aria-checked') === 'false');
  assert.notDeepEqual(await colors(), before, 'the system preference applies before an explicit choice');
  await toggle.press('Space');
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await twoFrames(page);
  assert.deepEqual(await colors(), before, 'Space activates the dark palette');
  assert.deepEqual(await toggle.boundingBox(), initialBox, 'the icon reserves the same space');
  assert.equal(await toggle.locator('.eclipse-shadow').evaluate(node => getComputedStyle(node).transitionDuration), '0s', 'reduced motion is immediate');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('theme-toggle').getAttribute('aria-checked') === 'true');
  assert.deepEqual(await colors(), before, 'the explicit choice survives reload');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await toggle.press('Enter');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await toggle.getAttribute('title'), 'Switch to dark theme');
  const moving = toggle.locator('.eclipse-shadow');
  assert.ok(await moving.evaluate(node => parseFloat(getComputedStyle(node).transitionDuration)) > 0, 'motion-enabled switch animates');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.sun-rays')).opacity === '1');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'system changes respect the saved override');
  const peer = await page.context().newPage();
  try {
    await peer.goto(base.href, { waitUntil: 'domcontentloaded' });
    await peer.getByRole('switch', { name: 'Dark theme', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('theme-toggle').getAttribute('aria-checked') === 'true');
  } finally {
    await peer.close();
  }
}

async function exerciseHistory(page, evidence) {
  const tab = page.getByRole('tab').nth(2);
  await tab.click();
  await activeTab(page, tab);
  const modeHash = new URL(page.url()).hash;
  await page.locator('.site-nav a[href="#film"]').click();
  assert.equal(new URL(page.url()).hash, '#film');
  await page.goBack();
  await page.waitForURL(url => url.hash === modeHash);
  await activeTab(page, tab);
  await page.goForward();
  await page.waitForURL(url => url.hash === '#film');
  await page.goto(new URL(modeHash, base).href);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await activeTab(page, tab);

  // A fresh mobile deep link may scroll vertically to its fragment. The
  // selected tab must be visible there and image decode must leave it there.
  const lastHash = await page.getByRole('tab').last().getAttribute('href');
  await page.setViewportSize(PHONE);
  await page.goto('about:blank');
  await visit(page, lastHash);
  await twoFrames(page);
  const lastTab = page.getByRole('tab').last();
  await activeTab(page, lastTab);
  const position = await geometry(page);
  const visibility = await tabVisibility(lastTab);
  assert.ok(['left', 'right', 'top', 'bottom'].every(edge => visibility[edge] >= -PIXEL),
    `mobile deep link must reveal the selected tab: ${JSON.stringify(visibility)}`);
  await measureImage(page);
  await twoFrames(page);
  const settled = await geometry(page);
  near(settled.scroll.y, position.scroll.y, 'mobile deep link holds its vertical scroll');
  near(settled.scroll.x, position.scroll.x, 'mobile deep link holds its horizontal scroll');
  evidence.push({ hash: lastHash, visibility, position: position.scroll, settled: settled.scroll });
}

function stageGeometry(stage) {
  return stage.evaluate(node => {
    const image = node.querySelector('img');
    const clip = node.getBoundingClientRect();
    const box = image.getBoundingClientRect();
    return {
      natural: { width: image.naturalWidth, height: image.naturalHeight },
      image: { width: box.width, height: box.height },
      overflow: { width: node.scrollWidth - node.clientWidth, height: node.scrollHeight - node.clientHeight },
      extent: { width: node.scrollWidth, height: node.scrollHeight },
      offsets: { x: node.scrollLeft, y: node.scrollTop },
      edges: { left: box.left - clip.left, top: box.top - clip.top, right: clip.right - box.right, bottom: clip.bottom - box.bottom },
      fit: getComputedStyle(image).objectFit,
      page: { x: scrollX, y: scrollY },
    };
  });
}

async function exerciseModal(page) {
  const dialog = page.locator('#image-dialog');
  const opener = page.locator(`${PANEL} .open-image`);
  if (!await dialog.count() && !await opener.count()) return 'modal absent';
  assert.equal(await dialog.count(), 1);
  assert.equal(await opener.count(), 1);
  const url = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const assertHistoryUnchanged = async () => {
    assert.equal(page.url(), url, 'modal leaves the underlying URL unchanged');
    assert.equal(await page.evaluate(() => history.length), historyLength, 'modal creates no history entry');
  };
  await opener.press('Enter');
  await dialog.waitFor({ state: 'visible' });
  await assertHistoryUnchanged();
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.ok(await dialog.evaluate(node => node.contains(document.activeElement)), 'initial focus is inside modal');
  const image = dialog.locator('img');
  await image.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#image-dialog img')?.naturalWidth > 0);
  assert.equal(await image.evaluate(img => img.currentSrc), await page.locator(IMAGE).evaluate(img => img.currentSrc));

  const focus = () => dialog.evaluate(node => ({
    inside: node.contains(document.activeElement),
    documentFocused: document.hasFocus(),
    element: document.activeElement?.tagName,
  }));
  await page.keyboard.press('Tab');
  const afterTab = await focus();
  if (!afterTab.inside) {
    // Native dialogs may pass Tab to browser chrome at the end of the cycle.
    assert.ok(!afterTab.documentFocused && afterTab.element === 'BODY', `Tab reached the underlying page: ${JSON.stringify(afterTab)}`);
    await page.keyboard.press('Tab');
    assert.ok((await focus()).inside, 'Tab from browser chrome returns to the dialog');
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.ok(await opener.evaluate(node => node === document.activeElement), 'Escape restores trigger focus');
  await assertHistoryUnchanged();

  const caption = page.locator(`${PANEL} .expand-control`);
  const close = dialog.locator('button.close-image');
  const zoom = dialog.locator('button.zoom-image');
  const stageId = await zoom.getAttribute('aria-controls');
  assert.ok(stageId, 'zoom identifies its controlled image region');
  const stage = dialog.getByRole('region').and(dialog.locator(`[id="${stageId}"]`));
  await caption.scrollIntoViewIfNeeded();
  const pageOffset = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await caption.click();
  await dialog.waitFor({ state: 'visible' });
  await assertHistoryUnchanged();

  async function assertFit() {
    assert.equal(await zoom.getAttribute('aria-pressed'), 'false');
    const result = await stageGeometry(stage);
    assert.equal(result.fit, 'contain');
    assert.deepEqual(result.offsets, { x: 0, y: 0 });
    assert.deepEqual(result.overflow, { width: 0, height: 0 });
    assert.ok(Object.values(result.edges).every(edge => edge >= -PIXEL), 'fit image stays within the stage');
    return result;
  }

  const fit = await assertFit();
  await zoom.press('Space');
  assert.equal(await zoom.getAttribute('aria-pressed'), 'true');
  assert.equal(await stage.getAttribute('tabindex'), '0', 'scroll region can receive keyboard focus');
  const actual = await stageGeometry(stage);
  for (const axis of ['width', 'height']) {
    near(actual.image[axis], actual.natural[axis], `actual pixels image ${axis}`);
    near(actual.extent[axis], actual.natural[axis], `actual pixels scroll extent ${axis}`);
    assert.ok(actual.overflow[axis] > 0, `actual pixels pannable along ${axis}`);
  }

  const awaitCorner = end => page.waitForFunction(({ stageId, end, tolerance }) => {
    const node = document.getElementById(stageId);
    const x = end ? node.scrollWidth - node.clientWidth : 0;
    const y = end ? node.scrollHeight - node.clientHeight : 0;
    return Math.abs(node.scrollLeft - x) <= tolerance && Math.abs(node.scrollTop - y) <= tolerance;
  }, { stageId, end, tolerance: PIXEL });
  await stage.hover();
  await page.mouse.wheel(-actual.natural.width * 2, -actual.natural.height * 2);
  await awaitCorner(false);
  const topLeft = await stageGeometry(stage);
  near(topLeft.edges.left, 0, 'native left edge is reachable');
  near(topLeft.edges.top, 0, 'native top edge is reachable');
  await page.mouse.wheel(actual.natural.width * 2, actual.natural.height * 2);
  await awaitCorner(true);
  const bottomRight = await stageGeometry(stage);
  near(bottomRight.edges.right, 0, 'native right edge is reachable');
  near(bottomRight.edges.bottom, 0, 'native bottom edge is reachable');
  assert.deepEqual(bottomRight.page, pageOffset, 'native scrolling preserves the underlying page scroll');

  await zoom.click();
  const returned = await assertFit();
  assert.deepEqual(returned.image, fit.image, 'returning to fit restores the initial rendered size');
  await zoom.click();
  assert.equal(await zoom.getAttribute('aria-pressed'), 'true');
  await close.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.ok(await caption.evaluate(node => node === document.activeElement), 'Close restores caption control focus');
  assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY })), pageOffset);
  await assertHistoryUnchanged();

  await opener.press('Enter');
  await assertFit();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.ok(await opener.evaluate(node => node === document.activeElement), 'new opener retains its own focus');
  return { afterTab, fit, actual, topLeft, bottomRight, historyLength };
}

async function exerciseNoScript(page) {
  const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id));
  for (const id of ANCHORS) assert.equal(ids.filter(value => value === id).length, 1, `old anchor #${id}`);
  const tabs = page.locator(MODES);
  assert.equal(await tabs.count(), 6);
  for (let index = 0; index < 6; index++) {
    const link = tabs.nth(index);
    const hash = await link.getAttribute('href');
    await link.click();
    assert.equal(new URL(page.url()).hash, hash);
    assert.ok(await page.locator(hash).isVisible(), `static modality ${hash}`);
  }
  await page.locator('.mobile-menu summary').click();
  await page.locator('.mobile-menu a[href="#specimen"]').click();
  assert.equal(new URL(page.url()).hash, '#specimen');
  assert.ok(await page.locator('#specimen-fallback').isVisible());
  assert.equal(await page.locator('#specimen-z').isDisabled(), true);
  assert.ok(await page.locator('loci-connection').innerText(), 'connection retains static content');
}

async function exerciseFilms(page, evidence) {
  const film = page.locator('#film');
  assert.equal(await film.count(), 1);
  const videos = film.locator('video[data-tour-film]');
  assert.equal(await videos.count(), 2);
  const sections = new Set();
  const sources = new Set();
  for (let index = 0; index < 2; index++) {
    const video = videos.nth(index);
    await video.scrollIntoViewIfNeeded();
    const initial = await video.evaluate(node => {
      const section = node.closest('section');
      return {
        section: [...document.querySelectorAll('section')].indexOf(section),
        name: node.getAttribute('aria-label') || node.getAttribute('aria-labelledby'),
        controls: node.controls,
        autoplay: node.autoplay,
        paused: node.paused,
        time: node.currentTime,
        poster: node.poster,
      };
    });
    assert.ok(initial.section >= 0 && initial.name && initial.controls && initial.poster, JSON.stringify(initial));
    assert.ok(!initial.autoplay && initial.paused && initial.time === 0, JSON.stringify(initial));

    const clip = film.locator('.clip').nth(index);
    await clip.getByRole('button', { name: /^Play film/ }).press('Space');
    await page.waitForFunction(index => {
      const node = document.querySelectorAll('#film video[data-tour-film]')[index];
      return !node.paused && node.currentTime > 0 && node.videoWidth > 0;
    }, index);
    const playing = await video.evaluate(node => ({
      src: node.currentSrc, width: node.videoWidth, height: node.videoHeight, duration: node.duration,
    }));
    assert.ok(Number.isFinite(playing.duration) && playing.duration > 0, JSON.stringify(playing));
    await clip.getByRole('button', { name: /^Pause film/ }).press('Enter');
    await page.waitForFunction(index => document.querySelectorAll('#film video[data-tour-film]')[index].paused, index);
    sections.add(initial.section);
    sources.add(playing.src);
    evidence.push({ initial, playing });
  }
  assert.equal(sections.size, 2, 'microfilms occupy distinct sections');
  assert.equal(sources.size, 2, 'microfilms use distinct, playable sources');
}

async function exerciseDiagram(page, reducedMotion) {
  const diagram = page.locator('loci-connection');
  const steps = diagram.getByRole('group').getByRole('button');
  const play = diagram.getByRole('button', { name: /^(Play|Pause|Replay)\b/ });
  assert.equal(await steps.count(), 6);
  const current = steps.and(page.locator('[aria-current="step"]'));
  const assertStep = async index => {
    await page.waitForFunction(index => {
      const steps = [...document.querySelectorAll('loci-connection [role="group"] button')];
      return steps.findIndex(step => step.getAttribute('aria-current') === 'step') === index;
    }, index);
    assert.equal(await current.count(), 1);
    const captionId = await steps.nth(index).getAttribute('aria-controls');
    assert.ok(captionId);
    const text = await diagram.locator(`[id="${captionId}"]`).innerText();
    assert.ok(text.trim());
    return text;
  };
  const start = await assertStep(0);
  const last = steps.last();
  await steps.first().press('End');
  assert.ok(await last.evaluate(button => button === document.activeElement));
  await page.keyboard.press('Enter');
  assert.notEqual(await assertStep(5), start);
  if (reducedMotion) {
    assert.equal(await play.count(), 0, 'manual steps remain available under reduced motion');
    return;
  }
  await steps.first().click();
  await assertStep(0);
  await play.click();
  await diagram.getByRole('button', { name: /^Pause\b/ }).waitFor();
  await assertStep(1);
  await play.click();
  await diagram.getByRole('button', { name: /^Play\b/ }).waitFor();
  await assertStep(1);
}

const specimenRoute = '**/media/specimen.json';
const displayZ = '#specimen-displayed-z';
const specimenCanvas = '#specimen-canvas';
async function manifestFrom(page) {
  const response = await page.request.get(new URL('media/specimen.json', base).href);
  assert.ok(response.ok());
  const manifest = await response.json();
  assert.equal(manifest.sections.length, 9);
  assert.equal(manifest.channels.length, 3);
  return manifest;
}

async function specimenReady(page, manifest) {
  await visit(page, '#specimen');
  await page.locator('#specimen[data-specimen-state="ready"]').waitFor();
  await page.locator(specimenCanvas).waitFor();
  const slider = page.getByRole('slider');
  assert.equal(await slider.isEnabled(), true);
  assert.equal(await slider.getAttribute('max'), String(manifest.sections.length - 1));
  const initial = manifest.sections[manifest.initialSectionIndex];
  assert.equal((await page.locator(displayZ).innerText()).trim(), `Z${initial.zIndex}`);
  return slider;
}

async function pixels(page) {
  const png = await page.locator(specimenCanvas).evaluate(canvas => canvas.toDataURL());
  return createHash('sha256').update(png).digest('hex');
}

async function exerciseSpecimen(page, evidence) {
  const manifest = await manifestFrom(page);
  const slider = await specimenReady(page, manifest);
  const original = await pixels(page);
  const next = manifest.sections[manifest.initialSectionIndex + 1];
  await slider.press('ArrowRight');
  await page.waitForFunction(z => document.querySelector('#specimen-displayed-z').textContent.trim() === z, `Z${next.zIndex}`);
  const micrometres = Number((await page.locator('#specimen-displayed-um').innerText()).replace('µm', '').trim());
  assert.equal(micrometres, next.zUm);
  const full = await pixels(page);
  assert.notEqual(full, original, 'successfully selected section updates actual pixels');

  const channels = page.locator('#specimen-channels').getByRole('checkbox');
  assert.equal(await channels.count(), manifest.channels.length);
  for (let index = 0; index < manifest.channels.length; index++) {
    const channel = channels.nth(index);
    assert.equal(await channel.isChecked(), true);
    await channel.press('Space');
    assert.equal(await channel.isChecked(), false);
  }
  const allOff = await page.locator(specimenCanvas).evaluate(canvas => {
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return data.every((byte, index) => byte === (index % 4 === 3 ? 255 : 0));
  });
  assert.ok(allOff, 'all channels off yields opaque black');
  await channels.first().press('Space');
  const oneChannel = await pixels(page);
  assert.notEqual(oneChannel, full);
  await page.locator('#specimen-reset').click();
  assert.equal(await channels.and(page.locator(':checked')).count(), manifest.channels.length);
  assert.equal(await pixels(page), full, 'restoring all channels recovers the same pixels');
  assert.equal((await page.locator(displayZ).innerText()).trim(), `Z${next.zIndex}`);
  evidence.push({ z: next.zIndex, micrometres, original, full, oneChannel });
}

async function assertFallback(page, projection = false) {
  await page.locator('#specimen[data-specimen-state="fallback"]').waitFor();
  assert.equal(await page.getByRole('slider').isDisabled(), true);
  for (const channel of await page.locator('#specimen-channels').getByRole('checkbox').all()) {
    assert.equal(await channel.isDisabled(), true);
  }
  assert.equal(await page.locator(specimenCanvas).isVisible(), false);
  const fallback = page.locator('#specimen-fallback');
  await fallback.waitFor();
  await page.waitForFunction(() => document.querySelector('#specimen-fallback').naturalWidth > 0);
  assert.equal((await page.locator(displayZ).innerText()).trim(), projection ? 'Z15–20' : 'Z16');
}

async function exerciseManifestFailure(page) {
  await page.route(specimenRoute, route => route.abort());
  await visit(page, '#specimen');
  await assertFallback(page);
}

async function exerciseProjectionFallback(page) {
  const manifest = await manifestFrom(page);
  const manifestUrl = new URL('media/specimen.json', base);
  const paths = [manifest.fallback, manifest.sections[manifest.initialSectionIndex].src];
  for (const path of paths) await page.route(new URL(path, manifestUrl).href, route => route.abort());
  await visit(page, '#specimen');
  await assertFallback(page, true);
}

async function exerciseTextureFailure(page, evidence) {
  const manifest = await manifestFrom(page);
  const next = manifest.sections[manifest.initialSectionIndex + 1];
  await page.route(new URL(next.src, new URL('media/specimen.json', base)).href, route => route.abort());
  const slider = await specimenReady(page, manifest);
  const original = await pixels(page);
  const from = (await page.locator(displayZ).innerText()).trim();
  await slider.press('ArrowRight');
  await page.waitForFunction(({ from, to }) => {
    const status = document.querySelector('#specimen-pending').textContent;
    return status.includes(from) && status.includes(to);
  }, { from, to: `Z${next.zIndex}` });
  assert.equal((await page.locator(displayZ).innerText()).trim(), from, 'failed request keeps the last displayed section');
  assert.equal(await pixels(page), original, 'failed request keeps the exact last displayed pixels');
  assert.equal(await slider.isEnabled(), true);
  await slider.press('ArrowLeft');
  await page.waitForFunction(() => !document.querySelector('#specimen-pending').textContent.trim());
  assert.equal(await pixels(page), original);
  evidence.push({ displayed: from, failed: next.zIndex, pixels: original });
}

try {
  if (values.out) await mkdir(values.out, { recursive: true });
  for (const viewport of [NARROW, PHONE, TABLET, DESKTOP]) {
    for (const colorScheme of ['dark', 'light']) {
      const reducedMotion = viewport === NARROW || viewport === TABLET ? 'reduce' : 'no-preference';
      await check(`tabs ${viewport.width} ${colorScheme} ${reducedMotion}`, { viewport, colorScheme, reducedMotion },
        async (page, evidence) => {
          await visit(page);
          await exerciseTabs(page, evidence);
        });
    }
  }
  await check('image decode', { viewport: PHONE, reducedMotion: 'reduce' }, async (page, evidence) => {
    await visit(page);
    await decodeStability(page, evidence);
  });
  await check('mobile menu', { viewport: PHONE, reducedMotion: 'reduce' }, async page => {
    await visit(page);
    await exerciseMobileMenu(page);
  });
  await check('theme', { viewport: DESKTOP, colorScheme: 'dark', reducedMotion: 'reduce' }, async page => {
    await visit(page);
    await exerciseTheme(page);
  });
  await check('anchor history', { viewport: DESKTOP, reducedMotion: 'reduce' }, async (page, evidence) => {
    await visit(page);
    await exerciseHistory(page, evidence);
  });
  await check('full-screen image', { viewport: PHONE, reducedMotion: 'reduce' }, async (page, evidence) => {
    await visit(page);
    evidence.push(await exerciseModal(page));
  });
  await check('no JavaScript', { viewport: PHONE, javaScriptEnabled: false, reducedMotion: 'reduce' }, async page => {
    await visit(page, '', { waitForFonts: false });
    await exerciseNoScript(page);
  });
  await check('native microfilms', { viewport: DESKTOP }, async (page, evidence) => {
    await visit(page, '#film');
    await exerciseFilms(page, evidence);
  });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await check(`connection ${reducedMotion}`, { viewport: PHONE, reducedMotion }, async page => {
      await visit(page, '#assistant');
      await exerciseDiagram(page, reducedMotion === 'reduce');
    });
  }
  await check('specimen section and channels', { viewport: DESKTOP }, exerciseSpecimen);
  await check('specimen manifest failure', { viewport: DESKTOP }, exerciseManifestFailure, { expectedResourceFailures: true });
  await check('specimen projection fallback', { viewport: DESKTOP }, exerciseProjectionFallback, { expectedResourceFailures: true });
  await check('specimen texture failure and recovery', { viewport: DESKTOP }, exerciseTextureFailure, { expectedResourceFailures: true });
} finally {
  await browser.close();
  if (values.out) {
    await writeFile(resolve(values.out, `${values.browser}-report.json`), JSON.stringify(report, null, 2) + '\n');
  }
}
const passed = report.checks.filter(check => check.passed).length;
assert.ok(report.checks.length, 'no selected checks matched');
console.log(`${passed}/${report.checks.length} showcase checks passed in ${values.browser} ${report.version}`);
if (passed !== report.checks.length) process.exitCode = 1;
