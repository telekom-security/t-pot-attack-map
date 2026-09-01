// TEMPORARY — WP4 PoC gate driver (classic deferred script, like map.js in 4.0).
// Results are collected in window.__POC and rendered into #results; the
// Playwright driver asserts on window.__POC.

'use strict';

const __pocScriptSrc = document.currentScript && document.currentScript.src;

window.__POC = {
  checks: {},          // name -> {pass, detail}
  errors: [],          // page errors collected by the driver too
  cspViolations: [],
  done: false,
  header: null,
  importResolvedUrl: null,
  rangeRequests: [],   // filled by the driver from network events
};

document.addEventListener('securitypolicyviolation', (e) => {
  window.__POC.cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
});

function record(name, pass, detail) {
  window.__POC.checks[name] = { pass: !!pass, detail: String(detail ?? '') };
  render();
}

function render() {
  const el = document.getElementById('results');
  const rows = Object.entries(window.__POC.checks).map(
    ([k, v]) => `<span class="${v.pass ? 'pass' : 'fail'}">${v.pass ? 'PASS' : 'FAIL'} ${k}${v.detail ? ' — ' + v.detail : ''}</span>`
  );
  el.innerHTML = rows.join('\n') + (window.__POC.done ? '\n<span id="poc-done">DONE</span>' : '');
}

async function loadStyle(theme, header, pmtilesUrl) {
  const res = await fetch(`static/styles/${theme}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`style ${theme}: HTTP ${res.status}`);
  const style = await res.json();
  style.glyphs = new URL('static/basemaps/fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  style.sprite = new URL(`static/basemaps/sprites/v4/${theme}`, document.baseURI).href;
  style.sources.protomaps.url = `pmtiles://${pmtilesUrl}`;
  style.sources.protomaps.maxzoom = header.maxZoom;
  return style;
}

(async () => {
  const P = window.__POC;
  try {
    // check 14 — dynamic-import resolution from a classic script
    P.importResolvedUrl = new URL('./map-boot.mjs', __pocScriptSrc).href;
    const t0 = performance.now();
    const boot = await import('./map-boot.mjs');
    record('14 dynamic import', true, P.importResolvedUrl);

    // WebGL2 probe (§13.4)
    const probe = document.createElement('canvas').getContext('webgl2');
    record('webgl2', !!probe, probe ? 'available' : 'MISSING');
    if (probe) probe.getExtension('WEBGL_lose_context')?.loseContext();

    // check 5 — preflight failure modes FIRST (missing + truncated), then the real archive
    let missingRejected = false;
    try { await boot.openBasemap(new URL('static/dist/does-not-exist.pmtiles', document.baseURI).href); }
    catch (e) { missingRejected = true; }
    let truncatedRejected = false;
    try { await boot.openBasemap(new URL('static/dist/poc-truncated.pmtiles', document.baseURI).href); }
    catch (e) { truncatedRejected = true; }
    record('5 preflight failure modes', missingRejected && truncatedRejected,
      `missing rejected=${missingRejected}, truncated rejected=${truncatedRejected}, no map constructed`);

    // check 5 — real preflight
    const pmtilesUrl = new URL('static/dist/world.pmtiles', document.baseURI).href;
    const header = await boot.openBasemap(pmtilesUrl);
    P.header = {
      tileType: header.tileType, minZoom: header.minZoom, maxZoom: header.maxZoom,
      jsonMetadataOffset: Number(header.jsonMetadataOffset),
      jsonMetadataLength: Number(header.jsonMetadataLength),
    };
    record('5 preflight', true, `tileType=${header.tileType} z${header.minZoom}-${header.maxZoom}`);

    // check 8 — URL assertions (§7.3)
    const style = await loadStyle('dark', header, pmtilesUrl);
    const urlOk =
      style.glyphs.includes('{fontstack}') && style.glyphs.includes('{range}') &&
      !/%7B/i.test(style.glyphs) &&
      style.sprite.startsWith(location.origin) &&
      style.sources.protomaps.url.startsWith('pmtiles://' + location.origin);
    record('8 URL assertions', urlOk, `glyphs=${style.glyphs} sprite=${style.sprite}`);

    // construct the map (D16 view parameters)
    const map = new boot.maplibregl.Map({
      container: 'map',
      style,
      center: [0, 0],
      zoom: 2,
      minZoom: Math.max(1, header.minZoom),
      maxZoom: header.maxZoom,
      renderWorldCopies: true,
      maxPitch: 0,
      dragRotate: false,
      attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    window.__pocMap = map;
    map.on('error', (e) => P.errors.push('map error: ' + (e.error?.message ?? e.error)));

    await new Promise((resolve) => map.once('idle', resolve));
    P.firstIdleMs = Math.round(performance.now() - t0);
    record('6 map renders', true, `first idle after ${P.firstIdleMs} ms`);
    record('13 zoom semantics', map.getMaxZoom() === header.maxZoom,
      `map.getMaxZoom()=${map.getMaxZoom()} header.maxZoom=${header.maxZoom}`);

    // check 12a — 20x setStyle({diff:true}); start with 'light' so every call
    // actually changes the style, and race styledata against a timeout so a
    // diff that produces no event cannot hang the gate.
    const styles = { dark: style, light: await loadStyle('light', header, pmtilesUrl) };
    for (let i = 0; i < 20; i++) {
      const evt = new Promise((r) => map.once('styledata', r));
      map.setStyle(styles[i % 2 ? 'dark' : 'light'], { diff: true });
      await Promise.race([evt, new Promise((r) => setTimeout(r, 1000))]);
    }
    await new Promise((resolve) => map.once('idle', resolve));
    record('12a setStyle x20', true, 'no exception');

    // check 12b — rapid non-awaited toggling with a revision counter (§7.6)
    let themeRevision = 0;
    async function updateMapTheme(theme) {
      const revision = ++themeRevision;
      const s = await loadStyle(theme, header, pmtilesUrl);
      if (revision !== themeRevision) return;
      map.setStyle(s, { diff: true });
      window.__pocAppliedTheme = theme;
    }
    updateMapTheme('dark'); updateMapTheme('light'); updateMapTheme('dark');
    const final = updateMapTheme('light');
    await final;
    await new Promise((resolve) => map.once('idle', resolve));
    record('12b rapid toggle', window.__pocAppliedTheme === 'light',
      `applied=${window.__pocAppliedTheme} requested=light`);

    P.done = true;
    render();
  } catch (e) {
    window.__POC.errors.push(String(e && e.stack || e));
    record('fatal', false, String(e));
    window.__POC.done = true;
    render();
  }
})();
