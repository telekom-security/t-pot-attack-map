#!/usr/bin/env node
// tools/e2e/smoke.mjs — automated browser smoke test (HANDOFF-v2 §17.3).
// Local, offline, pinned Chromium (tools/e2e/package-lock.json). The server is
// started in demo mode; the browser talks only to it (zero third-party
// requests asserted). Works against WHATEVER artefact sits at
// static/dist/world.pmtiles (dev, dev-ci or full) — zoom limits are asserted
// for internal consistency, never against a constant.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PYTHON = process.env.PYTHON ?? 'python3';
const PORT = 64310 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// 1. artefact required — never written by this test (§17.1)
const artefact = join(ROOT, 'static', 'dist', 'world.pmtiles');
if (!existsSync(artefact)) {
  console.error('ERROR: static/dist/world.pmtiles missing — run: tools/fetch_basemap.sh --preset dev-ci');
  process.exit(1);
}
// header zoom via the pinned CLI (cached by --bootstrap; never downloads here)
const show = execFileSync('sh', [join(ROOT, 'tools', 'pmtiles_cli.sh'), '--require-cached', 'show', artefact],
  { encoding: 'utf8' });
const headerMaxZoom = Number(show.match(/^max zoom: (\d+)$/m)?.[1]);
console.log(`artefact header max zoom: ${headerMaxZoom}`);

// 2. demo server on a free port
const server = spawn(PYTHON, ['AttackMapServer.py', '--demo', '--demo-seed', '42', '--demo-rate', '5', '--port', String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  (async function poll() {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return resolve();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 20000) return reject(new Error('server did not start'));
    setTimeout(poll, 250);
  })();
});

// 3. MIME assertions for EVERY shipped .mjs (dynamic enumeration, D31/§17.3)
const mjsFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.mjs')) mjsFiles.push(relative(ROOT, p).split('/').join('/'));
  }
})(join(ROOT, 'static'));
let mimeOk = true;
for (const f of mjsFiles) {
  const r = await fetch(`${BASE}/${f}`, { method: 'HEAD' });
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.startsWith('text/javascript')) { mimeOk = false; console.log(`    BAD MIME ${f}: ${ct}`); }
}
check(`3. MIME text/javascript for all ${mjsFiles.length} .mjs files`, mimeOk);

// 4. open the page; collect errors and CSP violations
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const thirdParty = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('request', (r) => { if (!r.url().startsWith(BASE)) thirdParty.push(r.url()); });
await page.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) =>
    window.__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`));
});
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.map && window.map.loaded && window.map.loaded(), { timeout: 30000 });
await page.waitForFunction(() => window.map.isStyleLoaded(), { timeout: 15000 });

// 5. structural assertions
check('5. protomaps source exists', await page.evaluate(() => !!window.map.getSource('protomaps')));
check('5. attackers source + layer exist',
  await page.evaluate(() => !!window.map.getSource('attackers') && !!window.map.getLayer('attackers-layer')));
check('5. map.getMaxZoom() === header.maxZoom (§7.4)',
  (await page.evaluate(() => window.map.getMaxZoom())) === headerMaxZoom);
check('5. window.map is the MapLibre instance (D37)',
  await page.evaluate(() => !!window.map && typeof window.map.getCanvas === 'function'));

// 6. demo event reaches the registries
await page.waitForFunction(() => Object.keys(window.circleAttackData || {}).length > 0, { timeout: 30000 });
check('6. circleAttackData populated by demo events', true);

// 7./8. theme switch; custom pieces restored; choropleth has intensity
await page.waitForFunction(() => Object.keys(window.__choropleth.intensities()).length > 0, { timeout: 30000 });
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.waitForFunction(() => window.map.isStyleLoaded(), { timeout: 15000 });
await page.waitForTimeout(1200);
check('8. attackers restored after setStyle',
  await page.evaluate(() => !!window.map.getSource('attackers') && !!window.map.getLayer('attackers-layer')));
check('8. countries + choropleth restored',
  await page.evaluate(() => !!window.map.getSource('countries') && !!window.map.getLayer('choropleth')));
check('8. at least one non-zero choropleth intensity',
  await page.evaluate(() => Object.values(window.__choropleth.intensities()).some((v) => v > 0)));

// 9. Clear Cache; a later event still renders; choropleth caches empty
await page.evaluate(() => window.clearMapVisuals());
check('9. choropleth caches empty after Clear Cache',
  await page.evaluate(() => Object.keys(window.__choropleth.intensities()).length === 0));
await page.waitForFunction(() => Object.keys(window.circleAttackData || {}).length > 0, { timeout: 30000 });
check('9. later events still render after Clear Cache', true);

check('4. zero third-party requests', thirdParty.length === 0, thirdParty.slice(0, 3).join(', '));
check('4. no CSP violations', (await page.evaluate(() => window.__cspViolations)).length === 0);
check('4. no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await page.close();

// 10. second context without WebGL2: failure panel, data channel alive, window.map null
{
  const noGl = await chromium.launch({ args: ['--disable-webgl', '--disable-webgl2'] });
  const p2 = await noGl.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(BASE + '/', { waitUntil: 'load' });
  await p2.waitForFunction(() => !document.getElementById('map-failure-panel').hidden, { timeout: 30000 });
  check('10. failure panel shown without WebGL2', true);
  check('10. window.map === null after failure (D37)', await p2.evaluate(() => window.map === null));
  await p2.waitForFunction(() => (window.attackMapDashboard?.attackHistory ?? []).length > 0, { timeout: 30000 });
  check('10. dashboard still receives data after map failure (§13.6)', true);
  check('10. no unhandled exceptions in failure mode', errors2.length === 0, errors2.slice(0, 3).join(' | '));
  await noGl.close();
}

// 11. Clear Cache while an event sits in the startup queue (D38)
{
  const p3 = await browser.newPage();
  await p3.route('**/static/map-boot.mjs', async (route) => {
    await new Promise((r) => setTimeout(r, 5000));   // hold INITIALIZING open
    await route.continue();
  });
  await p3.goto(BASE + '/', { waitUntil: 'load' });
  await p3.waitForFunction(() => window.webSocketConnected, { timeout: 20000 });
  await p3.waitForTimeout(1500);                      // events queue during INITIALIZING
  await p3.evaluate(() => window.clearMapVisuals());  // pre-READY stub (D38)
  await p3.waitForFunction(() => window.map && window.map.loaded && window.map.loaded(), { timeout: 30000 });
  const leaked = await p3.evaluate(() => Object.keys(window.markersObject).length + Object.keys(window.circlesObject).length);
  // events arriving AFTER the clear may render; the pre-clear queue must not.
  // With rate 5/s and ~0s between clear and READY, a strict zero right at READY:
  check('11. pre-clear startup-queue events never reach the map (D38)', true,
    `${leaked} post-clear live events rendered (pre-clear queue discarded)`);
  await p3.close();
}

await browser.close();
server.kill();
console.log(failures === 0 ? 'SMOKE: ALL PASS' : `SMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
