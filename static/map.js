// T-Pot Attack Map 4.0 — MapLibre GL + PMTiles migration (HANDOFF-v2 WP6).
// Two independent startup domains (D29): startDataChannel() (WebSocket, stats,
// dashboard) never depends on initMap() succeeding. Map lifecycle is explicit
// (D34): INITIALIZING -> READY | FAILED, with a bounded startup-only queue.

// Global WebSocket connection state variables
let webSocket = null;
let reconnectAttempts = 0;
let reconnectDelay = 60000; // Fixed 60 second delay
let heartbeatInterval = null;
let isReconnecting = false;
let connectionHealthCheck = null;

// Page visibility and connection health tracking
let isPageVisible = !document.hidden;
let isWakingUp = false; // Flag to suppress animation burst on tab wake
window.lastWebSocketMessageTime = Date.now(); // For connection health (heartbeat)
window.lastValidDataTime = Date.now(); // For "Connected" vs "Idle" state tracking

// Global connection flag for dashboard synchronization
window.webSocketConnected = false;

// ---------------------------------------------------------------------------
// Map lifecycle state (D34/D37) — everything below is renderer-local
// ---------------------------------------------------------------------------
let mapLifecycle = 'INITIALIZING';          // INITIALIZING -> READY | FAILED
const startupTrafficQueue = [];             // startup-only, cap 400, keep-newest
const MAX_STARTUP_TRAFFIC = 400;
const pendingRestored = [];                 // §7.2 cache-restore queue, cap 1000, keep-newest
const MAX_PENDING_RESTORED = 1000;

let map = null;                 // the MapLibre instance (window.map per D37)
let maplibregl = null;          // filled by the awaited dynamic import
let renderer = null;            // AttackRenderer (WP5)
let header = null;              // PMTiles header — the zoom authority (§7.4)
let pmtilesUrl = null;
let themeRevision = 0;          // §7.6 async-reordering guard
let pendingTheme = null;        // D44: theme requested while not READY
let themeTheMapWasBuiltWith = null;
let lastMapErrorLog = 0;

const warnedOnce = {};
function warnOnce(tag, message) {
  if (warnedOnce[tag]) return;
  warnedOnce[tag] = true;
  console.warn(message);
}

// Attacker-circle calibration (D19, §9.5 — zoom-scaled pixel radius instead of
// the old metric 50 km circle; values reviewed against the WP1 screenshots):
const CIRCLE_R1 = 4;   // px radius at zoom 1
const CIRCLE_R7 = 32;  // px radius at zoom 7

// ---------------------------------------------------------------------------
// Safe globals — installed synchronously, before any await (§13.6, D37, D38)
// ---------------------------------------------------------------------------
function installSafeGlobals() {
  window.map = null; // D37: set non-null exactly once, after construction

  // D38: NOT a no-op — Clear Cache must cancel pending startup/restore events
  // in every lifecycle state, so a pre-clear event can never resurface on READY.
  window.clearMapVisuals = function () {
    startupTrafficQueue.length = 0;
    pendingRestored.length = 0;
    choroplethHits.clear();     // D38: all shading state levels reset together
    intensityCache.clear();
    heatHits.clear();
  };

  // Replaced synchronously below by the D39 bridge receiver (WP7).
  window.updateChoropleth = function () {};

  // §7.2: bounded queueing stub (keep-newest); swapped for the real
  // implementation after a successful map init. The contract stays dormant —
  // nothing calls window.restoreAttackToMap in 4.0.
  window.processRestoredAttack = function (event) {
    if (pendingRestored.length >= MAX_PENDING_RESTORED) {
      pendingRestored.shift(); // keep-newest: drop the OLDEST
      warnOnce('restore-queue', '[MAP-RESTORE] queue full, dropping oldest');
    }
    pendingRestored.push(event);
  };
}

installSafeGlobals();

// ---------------------------------------------------------------------------
// Registries — global names/shapes preserved from 3.0.1 (WP6 requirement):
// keys stay the byte-identical "lat,lng" strings.
// ---------------------------------------------------------------------------
var circlesObject = {};        // key -> GeoJSON feature in the 'attackers' source
var circleAttackData = {};     // key -> aggregated attacker data (popups)
var markersObject = {};        // key -> maplibregl.Marker
var markerAttackData = {};     // key -> aggregated honeypot data (popups)

// ---------------------------------------------------------------------------
// Protocol colours (unchanged from 3.0.1)
// ---------------------------------------------------------------------------
function getProtocolColor(protocol) {
    // Use the same color mapping as the dashboard for consistency
    const colors = {
        'CHARGEN': '#4CAF50',
        'FTP-DATA': '#F44336',
        'FTP': '#FF5722',
        'SSH': '#FF9800',
        'TELNET': '#FFC107',
        'SMTP': '#8BC34A',
        'WINS': '#009688',
        'DNS': '#00BCD4',
        'DHCP': '#03A9F4',
        'TFTP': '#2196F3',
        'HTTP': '#3F51B5',
        'DICOM': '#9C27B0',
        'POP3': '#E91E63',
        'NTP': '#795548',
        'RPC': '#607D8B',
        'IMAP': '#9E9E9E',
        'SNMP': '#FF6B35',
        'LDAP': '#FF8E53',
        'HTTPS': '#0080FF',
        'SMB': '#BF00FF',
        'SMTPS': '#80FF00',
        'EMAIL': '#00FF80',
        'IPMI': '#00FFFF',
        'IPP': '#8000FF',
        'IMAPS': '#FF0080',
        'POP3S': '#80FF80',
        'NFS': '#FF8080',
        'SOCKS': '#8080FF',
        'SQL': '#00FF00',
        'ORACLE': '#FFFF00',
        'PPTP': '#FF00FF',
        'MQTT': '#00FF40',
        'SSDP': '#40FF00',
        'IEC104': '#FF4000',
        'HL7': '#4000FF',
        'MYSQL': '#00FF00',
        'RDP': '#FF0060',
        'IPSEC': '#60FF00',
        'SIP': '#FFCCFF',
        'POSTGRESQL': '#00CCFF',
        'ADB': '#FFCCCC',
        'VNC': '#0000FF',
        'REDIS': '#CC00FF',
        'IRC': '#FFCC00',
        'JETDIRECT': '#8000FF',
        'ELASTICSEARCH': '#FF8000',
        'INDUSTRIAL': '#80FF40',
        'MEMCACHED': '#40FF80',
        'MONGODB': '#FF4080',
        'SCADA': '#8040FF',
        'OTHER': '#78909C'
    };

    // Normalize the protocol like the dashboard does
    function normalizeProtocol(protocol) {
        if (!protocol) return 'OTHER';

        // Check if protocol is a numeric string (port number) - convert to OTHER
        if (/^\d+$/.test(protocol.toString())) {
            return 'OTHER';
        }

        // List of known protocols to check against
        const knownProtocols = [
            'CHARGEN', 'FTP-DATA', 'FTP', 'SSH', 'TELNET', 'SMTP', 'WINS', 'DNS', 'DHCP', 'TFTP',
            'HTTP', 'DICOM', 'POP3', 'NTP', 'RPC', 'IMAP', 'SNMP', 'LDAP', 'HTTPS', 'SMB',
            'SMTPS', 'EMAIL', 'IPMI', 'IPP', 'IMAPS', 'POP3S', 'NFS', 'SOCKS', 'SQL', 'ORACLE',
            'PPTP', 'MQTT', 'SSDP', 'IEC104', 'HL7', 'MYSQL', 'RDP', 'IPSEC', 'SIP', 'POSTGRESQL',
            'ADB', 'VNC', 'REDIS', 'IRC', 'JETDIRECT', 'ELASTICSEARCH', 'INDUSTRIAL', 'MEMCACHED',
            'MONGODB', 'SCADA'
        ];

        const protocolUpper = protocol.toUpperCase();

        // If protocol is not in the known list, use "OTHER"
        if (!knownProtocols.includes(protocolUpper)) {
            return 'OTHER';
        }

        return protocolUpper;
    }

    const normalizedProtocol = normalizeProtocol(protocol);

    // Return color for the normalized protocol
    return colors[normalizedProtocol] || colors['OTHER'];
}

// ---------------------------------------------------------------------------
// Attacker circles — native MapLibre source/layer (D14, D19)
// ---------------------------------------------------------------------------
function attackersFeatureCollection() {
    return { type: 'FeatureCollection', features: Object.values(circlesObject) };
}

function attackersSourceSpec() {
    return { type: 'geojson', data: attackersFeatureCollection() };
}

function attackersLayerSpec() {
    return {
        id: 'attackers-layer',
        type: 'circle',
        source: 'attackers',
        paint: {
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.2,
            'circle-stroke-color': ['get', 'color'],
            'circle-stroke-width': 2,
            // D19: visual-marker semantics — zoom-interpolated pixel radius
            'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 1, CIRCLE_R1, 7, CIRCLE_R7]
        }
    };
}

function syncAttackersSource() {
    const src = map && map.getSource('attackers');
    if (src) src.setData(attackersFeatureCollection());
}

function addCircle(country, iso_code, src_ip, ip_rep, color, srcLatLng, protocol) {
    // Only allow 200 circles on the map at a time (LRU by lastSeen, as 3.0.1)
    const keys = Object.keys(circlesObject);
    if (keys.length >= 200 && !circlesObject[srcLatLng.lat + "," + srcLatLng.lng]) {
        let oldestKey = null;
        let oldestTime = new Date();
        for (const k of keys) {
            const data = circleAttackData[k];
            if (data && data.lastSeen < oldestTime) {
                oldestTime = data.lastSeen;
                oldestKey = k;
            }
        }
        if (!oldestKey) oldestKey = keys[0]; // fallback
        delete circlesObject[oldestKey];
        delete circleAttackData[oldestKey];
    }

    var key = srcLatLng.lat + "," + srcLatLng.lng;

    if (circlesObject[key]) {
        // Feature exists — update its colour if the protocol changed
        if (circlesObject[key].properties.color !== color) {
            circlesObject[key].properties.color = color;
            if (circleAttackData[key]) {
                circleAttackData[key].lastProtocol = protocol;
                circleAttackData[key].lastColor = color;
                circleAttackData[key].lastSeen = new Date();
            }
            syncAttackersSource();
        }
        if (circleAttackData[key] && circleAttackData[key].ips[src_ip] && ip_rep) {
            circleAttackData[key].ips[src_ip].ip_rep = ip_rep;
        }
        return;
    }

    // Attack data should already be created in the Traffic handler (fallbacks as 3.0.1)
    if (!circleAttackData[key]) {
        circleAttackData[key] = {
            country: country,
            iso_code: iso_code,
            location_key: key,
            attacks: [],
            firstSeen: new Date(),
            lastSeen: new Date(),
            lastProtocol: protocol,
            lastColor: color,
            ips: {}
        };
    } else {
        circleAttackData[key].lastProtocol = protocol;
        circleAttackData[key].lastColor = color;
        circleAttackData[key].lastSeen = new Date();
    }
    if (!circleAttackData[key].ips[src_ip]) {
        circleAttackData[key].ips[src_ip] = {
            src_ip: src_ip,
            ip_rep: ip_rep,
            attacks: [],
            firstSeen: new Date(),
            lastSeen: new Date()
        };
    } else if (ip_rep) {
        circleAttackData[key].ips[src_ip].ip_rep = ip_rep;
    }

    circlesObject[key] = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [srcLatLng.lng, srcLatLng.lat] },
        properties: { key: key, color: color }
    };
    syncAttackersSource();
}

// ---------------------------------------------------------------------------
// Country activity choropleth (WP7 — D18/D28/D39, §8.5/§8.6).
// State levels: countryTrackingStats (dashboard authority, never read here)
//   -> window.updateChoropleth(iso2, absoluteHits)   the ONLY bridge (D39)
//   -> choroplethHits (renderer-local raw-count mirror)
//   -> intensityCache (derived)  -> MapLibre feature-state {intensity}
// ---------------------------------------------------------------------------
const choroplethHits = new Map();     // iso2 -> absolute hit count (mirror)
const intensityCache = new Map();     // iso2 -> derived intensity [0,1]
let choroplethFlushTimer = null;      // batches to at most one flush per second
let choroplethEnabled = true;         // D28: on by default
try {
    const s = JSON.parse(localStorage.getItem('attack-map-settings') || '{}');
    if (s.choroplethEnabled === false) choroplethEnabled = false;
} catch (e) { /* default stays on */ }
let countryIdSet = null;              // ISO codes present in the geometry
const unmatchedIsoLogged = new Set(); // once-per-session logging (§8.5)

function countriesSourceSpec() {
    return {
        type: 'geojson',
        data: new URL('static/data/countries.geojson', document.baseURI).href,
        promoteId: 'ISO_A2_EH'        // one feature per code (§8.5) -> unique ids
    };
}

function choroplethLayerSpec() {
    return {
        id: 'choropleth',
        type: 'fill',
        source: 'countries',
        layout: { visibility: choroplethEnabled ? 'visible' : 'none' },
        // Fill only, no independent outline: the Protomaps boundary lines stay
        // the visual boundary authority (§8.5). Opacity is driven per country
        // via a match expression (see applyChoroplethIntensities).
        paint: {
            'fill-color': '#e20074',
            'fill-opacity': 0
        }
    };
}

// D39 bridge receiver: absolute counts, never deltas — a missed call degrades
// to a stale value, and renormalisation never needs history replay.
window.updateChoropleth = function (iso2, absoluteHits) {
    if (!iso2 || iso2 === 'XX') return;
    choroplethHits.set(iso2, absoluteHits);
    scheduleChoroplethFlush();
};

function scheduleChoroplethFlush() {
    if (choroplethFlushTimer) return;
    choroplethFlushTimer = setTimeout(flushChoropleth, 1000);
}

function flushChoropleth() {
    choroplethFlushTimer = null;
    if (mapLifecycle !== 'READY' || !map || !map.getLayer('choropleth')) return;
    // maxHits recomputed on each flush; ALL intensities recomputed from the
    // raw-count mirror so a new maximum renormalises everything (§8.6).
    let maxHits = 0;
    for (const hits of choroplethHits.values()) maxHits = Math.max(maxHits, hits);
    const denom = Math.log1p(maxHits);
    intensityCache.clear();
    for (const [iso, hits] of choroplethHits) {
        const intensity = denom > 0 ? Math.min(1, Math.max(0, Math.log1p(hits) / denom)) : 0;
        intensityCache.set(iso, intensity);
        if (countryIdSet && !countryIdSet.has(iso) && !unmatchedIsoLogged.has(iso)) {
            unmatchedIsoLogged.add(iso);
            console.info(`[CHOROPLETH] iso_code ${iso} matches no country polygon (see tools/iso_unsupported.txt)`);
        }
    }
    applyChoroplethIntensities();
}

// Documented deviation from HANDOFF-v2 D18/§8.6 mechanics (semantics intact):
// per-id feature-state on the promoteId GeoJSON source proved unreliable in
// MapLibre 6.6.0 — individual setFeatureState writes are silently and
// persistently lost for one (session-varying) id, reproduced in headless AND
// headed Chromium. Intensities are therefore applied as a deterministic
// style-level match expression on fill-opacity; the D39 state levels
// (countryTrackingStats -> bridge -> choroplethHits -> intensityCache ->
// rendered opacity) are unchanged. promoteId stays on the source for future use.
function applyChoroplethIntensities() {
    if (!map || !map.getLayer('choropleth')) return;
    if (intensityCache.size === 0) {
        map.setPaintProperty('choropleth', 'fill-opacity', 0);
        return;
    }
    const matchExpr = ['match', ['get', 'ISO_A2_EH']];
    for (const [iso, intensity] of intensityCache) {
        matchExpr.push(iso, 0.35 * intensity);   // §8.6 scale: intensity 1 -> opacity 0.35
    }
    matchExpr.push(0);
    // Zoom crossfade to the density heatmap: the country shading is the
    // world-view story and fades out where the heatmap fades in (camera
    // expression outside, data expression at the stops — allowed by MapLibre).
    map.setPaintProperty('choropleth', 'fill-opacity',
        ['interpolate', ['linear'], ['zoom'], HEAT_FADE_START, matchExpr, HEAT_FADE_END, 0]);
}

// ---------------------------------------------------------------------------
// Density heatmap (zoomed-in counterpart of the choropleth). Built from the
// event coordinates the wire format already carries (src_lat/src_long,
// GeoLite2 city/centroid precision) — no new data, no wire change, offline.
// Deliberately a soft density rendering instead of admin-1/city polygons:
// GeoLite2's sub-country accuracy cannot honestly support crisp
// administrative borders (discussed and decided with the maintainer).
// ---------------------------------------------------------------------------
const HEAT_FADE_START = 3.5;   // below: choropleth only
const HEAT_FADE_END = 4.5;     // above: heatmap only
const HEAT_MAX_POINTS = 5000;  // GeoIP coords are city centroids -> bounded set
const heatHits = new Map();    // "lat,lng" -> {lng, lat, hits, lastSeen}
let heatFlushTimer = null;

function heatSourceSpec() {
    return { type: 'geojson', data: heatFeatureCollection() };
}

function heatLayerSpec() {
    return {
        id: 'attack-heat',
        type: 'heatmap',
        source: 'heat',
        layout: { visibility: choroplethEnabled ? 'visible' : 'none' },
        paint: {
            // w = log1p(hits) normalised at flush time; a floor of 0.3 keeps
            // low-volume cities visible next to the busiest coordinate
            // (calibrated in-browser against the seed-42 demo fixture)
            'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0.3, 1, 1],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 7, 1.6],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 16, 7, 40],
            'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], HEAT_FADE_START, 0, HEAT_FADE_END, 0.75]
        }
    };
}

function heatFeatureCollection() {
    let maxHits = 0;
    for (const e of heatHits.values()) maxHits = Math.max(maxHits, e.hits);
    const denom = Math.log1p(maxHits);
    const features = [];
    for (const e of heatHits.values()) {
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
            properties: { w: denom > 0 ? Math.log1p(e.hits) / denom : 0 }
        });
    }
    return { type: 'FeatureCollection', features: features };
}

function recordHeatHit(lat, lng) {
    const key = lat + "," + lng;
    let entry = heatHits.get(key);
    if (!entry) {
        if (heatHits.size >= HEAT_MAX_POINTS) {
            // evict the least recently seen coordinate (O(n) only on overflow)
            let oldestKey = null, oldest = Infinity;
            for (const [k, v] of heatHits) {
                if (v.lastSeen < oldest) { oldest = v.lastSeen; oldestKey = k; }
            }
            if (oldestKey) heatHits.delete(oldestKey);
        }
        entry = { lng: lng, lat: lat, hits: 0, lastSeen: 0 };
        heatHits.set(key, entry);
    }
    entry.hits++;
    entry.lastSeen = Date.now();
    scheduleHeatFlush();
}

function scheduleHeatFlush() {
    if (heatFlushTimer) return;
    heatFlushTimer = setTimeout(flushHeat, 1000);   // batched, <= 1x/s
}

function flushHeat() {
    heatFlushTimer = null;
    if (mapLifecycle !== 'READY' || !map || !map.getSource('heat')) return;
    map.getSource('heat').setData(heatFeatureCollection());
}

window.__choropleth = {
    readd() {   // called from reAddCustomLayers (§7.6) — per-object guards
        if (!map.getSource('countries')) map.addSource('countries', countriesSourceSpec());
        if (!map.getLayer('choropleth')) map.addLayer(choroplethLayerSpec(), firstLabelLayerId());
        if (!map.getSource('heat')) map.addSource('heat', heatSourceSpec());
        if (!map.getLayer('attack-heat')) map.addLayer(heatLayerSpec(), firstLabelLayerId());
    },
    reapplyFeatureState() {   // ALWAYS after a style (re)load (§7.6)
        applyChoroplethIntensities();
        if (map && map.getSource('heat')) map.getSource('heat').setData(heatFeatureCollection());
    },
    clear() {   // Clear Cache (D38): all state levels reset together
        choroplethHits.clear();
        intensityCache.clear();
        heatHits.clear();
        applyChoroplethIntensities();
        if (map && map.getSource('heat')) map.getSource('heat').setData(heatFeatureCollection());
    },
    setEnabled(on) {   // settings toggle (D28); one switch, one narrative:
        choroplethEnabled = !!on;   // governs country shading AND density heatmap
        if (mapLifecycle === 'READY' && map) {
            const vis = choroplethEnabled ? 'visible' : 'none';
            if (map.getLayer('choropleth')) map.setLayoutProperty('choropleth', 'visibility', vis);
            if (map.getLayer('attack-heat')) map.setLayoutProperty('attack-heat', 'visibility', vis);
        }
    },
    debug() {   // test/diagnostic aid
        return {
            mirror: choroplethHits.size,
            cache: intensityCache.size,
            heatPoints: heatHits.size,
            timerPending: !!choroplethFlushTimer,
            heatTimerPending: !!heatFlushTimer,
        };
    },
    intensities() {   // test hook: iso2 -> derived intensity [0,1]
        return Object.fromEntries(intensityCache);
    },
    heat() {   // test hook: "lat,lng" -> hits
        return Object.fromEntries([...heatHits].map(([k, v]) => [k, v.hits]));
    },
    recordHeat(lat, lng) {   // test hook: the same entry point the traffic path uses
        recordHeatHit(lat, lng);
    },
};

// The geometry's ISO id set, for once-per-session unmatched logging. The
// browser already fetched this URL for the GeoJSON source; force-cache reuses
// that response instead of a second download.
function loadCountryIdSet() {
    fetch(new URL('static/data/countries.geojson', document.baseURI).href, { cache: 'force-cache' })
        .then((r) => r.json())
        .then((fc) => { countryIdSet = new Set(fc.features.map((f) => f.properties.ISO_A2_EH)); })
        .catch(() => { /* logging aid only */ });
}

// ---------------------------------------------------------------------------
// Honeypot markers — DOM maplibregl.Markers (survive setStyle, §9.6)
// ---------------------------------------------------------------------------
function addMarker(dst_country_name, dst_iso_code, dst_ip, tpot_hostname, dstLatLng) {
    if (!dstLatLng || !dstLatLng.lat || !dstLatLng.lng) {
        return;
    }

    const keys = Object.keys(markersObject);
    if (keys.length >= 200 && !markersObject[dstLatLng.lat + "," + dstLatLng.lng]) {
        let oldestKey = null;
        let oldestTime = new Date();
        for (const k of keys) {
            const data = markerAttackData[k];
            if (data && data.lastUpdate < oldestTime) {
                oldestTime = data.lastUpdate;
                oldestKey = k;
            }
        }
        if (!oldestKey) oldestKey = keys[0];
        if (markersObject[oldestKey]) markersObject[oldestKey].remove();
        delete markersObject[oldestKey];
        delete markerAttackData[oldestKey];
    }

    var key = dstLatLng.lat + "," + dstLatLng.lng;
    if (markersObject[key]) return;

    if (!markerAttackData[key]) {
        markerAttackData[key] = {
            country: dst_country_name,
            iso_code: dst_iso_code,
            dst_ip: dst_ip,
            hostname: tpot_hostname,
            attacks: [],
            totalAttacks: 0,
            uniqueAttackers: new Set(),
            protocolStats: {},
            firstSeen: new Date(),
            lastUpdate: new Date()
        };
    }

    const img = document.createElement('img');
    img.src = 'static/images/honeypot-marker.svg';
    img.width = 48;
    img.height = 48;
    img.className = 'honeypot-marker';
    img.alt = 'Honeypot';

    // Leaflet used iconAnchor [24,40] on a 48x48 icon: anchor 'bottom' + 8 px up.
    const marker = new maplibregl.Marker({ element: img, anchor: 'bottom', offset: [0, 8] })
        .setLngLat([dstLatLng.lng, dstLatLng.lat])
        .addTo(map);

    const popup = new maplibregl.Popup({
        maxWidth: '400px',
        offset: [0, -48],
        className: 'modern-popup honeypot-popup'
    });
    marker.setPopup(popup);

    // Popup content is (re)built on click, replacing the old refresh-on-click logic
    img.addEventListener('click', function () {
        popup.setDOMContent(createHoneypotPopup(markerAttackData[key]));
    });
    img.style.cursor = 'pointer';

    markersObject[key] = marker;
}

// ---------------------------------------------------------------------------
// Popups (DOM builders unchanged from 3.0.1)
// ---------------------------------------------------------------------------

// Helper function to format reputation with line breaks for multi-word values
function formatReputation(reputation) {
    if (!reputation) return 'Unknown';

    // Add line break if the value contains multiple words (space separated)
    const words = reputation.trim().split(/\s+/);
    if (words.length > 1) {
        return words.join('<br>');
    }

    return reputation;
}

// Modern popup creation functions
function createAttackerPopup(attackerData) {
    // Validate attackerData structure
    if (!attackerData || typeof attackerData !== 'object') {
        console.error('[ERROR] Invalid attackerData:', attackerData);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'popup-content';
        const errorRow = document.createElement('div');
        errorRow.className = 'info-row';
        errorRow.textContent = 'Error: Invalid data';
        errorDiv.appendChild(errorRow);
        return errorDiv;
    }

    // Ensure required fields exist with defaults
    if (!attackerData.firstSeen) attackerData.firstSeen = new Date();
    if (!attackerData.lastSeen) attackerData.lastSeen = new Date();
    if (!attackerData.attacks) attackerData.attacks = [];
    if (!attackerData.ips) attackerData.ips = {};
    if (!attackerData.country) attackerData.country = 'Unknown';
    if (!attackerData.iso_code) attackerData.iso_code = 'XX';

    const now = new Date();
    const firstSeenAgo = formatTimeAgo(attackerData.firstSeen);
    const lastSeenAgo = formatTimeAgo(attackerData.lastSeen);

    // Get list of unique IPs at this location
    const ips = Object.keys(attackerData.ips);
    const totalAttacks = attackerData.attacks.length;

    // Get protocol stats from all attacks
    const protocolCounts = {};
    attackerData.attacks.forEach(attack => {
        protocolCounts[attack.protocol] = (protocolCounts[attack.protocol] || 0) + 1;
    });

    const topProtocol = Object.keys(protocolCounts).reduce((a, b) =>
        protocolCounts[a] > protocolCounts[b] ? a : b, 'N/A');

    const container = document.createElement('div');

    // Header
    const header = document.createElement('div');
    header.className = 'popup-header';

    const flagImg = document.createElement('img');
    flagImg.src = `static/flags/${attackerData.iso_code}.svg`;
    flagImg.width = 64;
    flagImg.height = 44;
    flagImg.className = 'flag-icon';
    header.appendChild(flagImg);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'popup-title';

    const h4 = document.createElement('h4');

    const subtitle = document.createElement('span');
    subtitle.className = 'popup-subtitle';
    subtitle.textContent = attackerData.country;

    titleDiv.appendChild(h4);
    titleDiv.appendChild(subtitle);
    header.appendChild(titleDiv);
    container.appendChild(header);

    const content = document.createElement('div');
    content.className = 'popup-content';
    container.appendChild(content);

    // Helper to create info row
    function createInfoRow(label, value, valueClass = '') {
        const row = document.createElement('div');
        row.className = 'info-row';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'info-label';
        labelSpan.textContent = label;

        const valueSpan = document.createElement('span');
        valueSpan.className = 'info-value ' + valueClass;

        if (value instanceof Node) {
            valueSpan.appendChild(value);
        } else {
            valueSpan.textContent = value;
        }

        row.appendChild(labelSpan);
        row.appendChild(valueSpan);
        return row;
    }

    if (ips.length === 1) {
        // Single IP
        h4.textContent = 'Attacker Source';
        const ipData = attackerData.ips[ips[0]];

        if (!ipData) {
             console.error('[ERROR] IP data is missing for:', ips[0]);
             const err = document.createElement('div');
             err.className = 'info-row';
             err.textContent = 'Error: IP data corrupted';
             content.appendChild(err);
             return container;
        }

        // Defaults
        if (!ipData.src_ip) ipData.src_ip = ips[0] || 'Unknown';
        if (ipData.ip_rep === undefined || ipData.ip_rep === null) ipData.ip_rep = 'Unknown';

        content.appendChild(createInfoRow('Source IP:', ipData.src_ip));

        // Handle reputation with safe line breaks
        const repFragment = document.createDocumentFragment();
        const words = (ipData.ip_rep || 'Unknown').trim().split(/\s+/);
        words.forEach((word, index) => {
            if (index > 0) repFragment.appendChild(document.createElement('br'));
            repFragment.appendChild(document.createTextNode(word));
        });
        content.appendChild(createInfoRow('Reputation:', repFragment, getReputationClass(ipData.ip_rep)));

        content.appendChild(createInfoRow('Total Attacks:', ipData.attacks.length));

        // Protocol Badge
        const protoRow = document.createElement('div');
        protoRow.className = 'info-row';
        const protoLabel = document.createElement('span');
        protoLabel.className = 'info-label';
        protoLabel.textContent = 'Top Protocol:';
        const protoBadge = document.createElement('span');
        protoBadge.className = `protocol-badge protocol-${topProtocol.toLowerCase()}`;
        protoBadge.textContent = topProtocol;
        protoRow.appendChild(protoLabel);
        protoRow.appendChild(protoBadge);
        content.appendChild(protoRow);

        content.appendChild(createInfoRow('First Seen:', formatTimeAgo(ipData.firstSeen || new Date())));
        content.appendChild(createInfoRow('Last Seen:', formatTimeAgo(ipData.lastSeen || new Date())));

    } else {
        // Multiple IPs
        h4.textContent = 'Multiple Attackers';

        const sortedIps = ips.map(ip => {
            const ipData = attackerData.ips[ip];
            if (!ipData || !ipData.attacks) return { ip: ip, attackCount: 0 };
            return { ip: ip, attackCount: ipData.attacks.length };
        }).sort((a, b) => b.attackCount - a.attackCount);

        const topIps = sortedIps.slice(0, 3);

        content.appendChild(createInfoRow('Total IPs:', ips.length));
        content.appendChild(createInfoRow('Total Attacks:', totalAttacks));

        // Protocol Badge
        const protoRow = document.createElement('div');
        protoRow.className = 'info-row';
        const protoLabel = document.createElement('span');
        protoLabel.className = 'info-label';
        protoLabel.textContent = 'Top Protocol:';
        const protoBadge = document.createElement('span');
        protoBadge.className = `protocol-badge protocol-${topProtocol.toLowerCase()}`;
        protoBadge.textContent = topProtocol;
        protoRow.appendChild(protoLabel);
        protoRow.appendChild(protoBadge);
        content.appendChild(protoRow);

        // Top Source IPs Section
        const section = document.createElement('div');
        section.className = 'info-section';
        const sectionLabel = document.createElement('span');
        sectionLabel.className = 'section-label';
        sectionLabel.textContent = 'Top Source IPs:';
        section.appendChild(sectionLabel);

        topIps.forEach(ipInfo => {
            const detail = document.createElement('div');
            detail.className = 'ip-detail';
            const ipAddr = document.createElement('span');
            ipAddr.className = 'ip-address';
            ipAddr.textContent = ipInfo.ip;
            const ipCount = document.createElement('span');
            ipCount.className = 'ip-count';
            ipCount.textContent = `${ipInfo.attackCount} attacks`;
            detail.appendChild(ipAddr);
            detail.appendChild(ipCount);
            section.appendChild(detail);
        });

        if (ips.length > 3) {
            const more = document.createElement('div');
            more.className = 'ip-detail more-ips';
            more.textContent = `... and ${ips.length - 3} more`;
            section.appendChild(more);
        }
        content.appendChild(section);

        content.appendChild(createInfoRow('First Seen:', firstSeenAgo));
        content.appendChild(createInfoRow('Last Seen:', lastSeenAgo));
    }

    return container;
}

function createHoneypotPopup(honeypotData) {
    const now = new Date();
    const lastUpdateAgo = formatTimeAgo(honeypotData.lastUpdate);

    // Get top 3 protocols
    const sortedProtocols = Object.entries(honeypotData.protocolStats)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3);

    const container = document.createElement('div');

    // Header
    const header = document.createElement('div');
    header.className = 'popup-header';

    const flagImg = document.createElement('img');
    flagImg.src = `static/flags/${honeypotData.iso_code}.svg`;
    flagImg.width = 64;
    flagImg.height = 44;
    flagImg.className = 'flag-icon';
    header.appendChild(flagImg);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'popup-title';

    const h4 = document.createElement('h4');
    h4.textContent = 'T-Pot Honeypot';

    const subtitle = document.createElement('span');
    subtitle.className = 'popup-subtitle';
    subtitle.textContent = honeypotData.country;

    titleDiv.appendChild(h4);
    titleDiv.appendChild(subtitle);
    header.appendChild(titleDiv);
    container.appendChild(header);

    const content = document.createElement('div');
    content.className = 'popup-content';
    container.appendChild(content);

    // Helper to create info row
    function createInfoRow(label, value) {
        const row = document.createElement('div');
        row.className = 'info-row';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'info-label';
        labelSpan.textContent = label;

        const valueSpan = document.createElement('span');
        valueSpan.className = 'info-value';
        valueSpan.textContent = value;

        row.appendChild(labelSpan);
        row.appendChild(valueSpan);
        return row;
    }

    content.appendChild(createInfoRow('Hostname:', honeypotData.hostname));
    content.appendChild(createInfoRow('IP Address:', honeypotData.dst_ip));
    content.appendChild(createInfoRow('Total Attacks:', honeypotData.totalAttacks));
    content.appendChild(createInfoRow('Unique Attackers:', honeypotData.uniqueAttackers.size));

    if (sortedProtocols.length > 0) {
        const section = document.createElement('div');
        section.className = 'info-section';
        const sectionLabel = document.createElement('span');
        sectionLabel.className = 'section-label';
        sectionLabel.textContent = 'Top Protocols:';
        section.appendChild(sectionLabel);

        sortedProtocols.forEach(([protocol, count]) => {
            const stat = document.createElement('div');
            stat.className = 'protocol-stat';

            const badge = document.createElement('span');
            badge.className = `protocol-badge protocol-${protocol.toLowerCase()}`;
            badge.textContent = protocol;

            const countSpan = document.createElement('span');
            countSpan.className = 'protocol-count';
            countSpan.textContent = count;

            stat.appendChild(badge);
            stat.appendChild(countSpan);
            section.appendChild(stat);
        });
        content.appendChild(section);
    }

    content.appendChild(createInfoRow('Last Update:', lastUpdateAgo));

    return container;
}

function formatTimeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
}

function getReputationClass(reputation) {
    if (reputation === 'MALICIOUS') return 'reputation-malicious';
    if (reputation === 'SUSPICIOUS') return 'reputation-suspicious';
    return 'reputation-clean';
}

// ---------------------------------------------------------------------------
// Stats (unchanged from 3.0.1)
// ---------------------------------------------------------------------------
function handleStats(msg) {
    const last = ["last_1m", "last_1h", "last_24h"];

    // Check if message contains any stats data
    const hasData = last.some(key => msg[key] !== undefined && msg[key] !== null);

    if (!hasData) {
        // If message is empty (backend failed to fetch stats), just return
        // We don't want to spam the console with warnings every 10 seconds
        console.log('[WARNING] Stats message contains no valid data:', msg);
        return;
    }

    // Valid data received - update timestamp for connection status
    window.lastValidDataTime = Date.now();

    last.forEach(function(i) {
        const element = document.getElementById(i);
        if (element) {
            const oldValue = element.textContent;
            const newValue = msg[i];

            // Check if newValue exists and is not undefined
            if (newValue !== undefined && newValue !== null) {
                // Only animate if value actually changed
                if (oldValue !== newValue.toString()) {
                    element.textContent = newValue;
                    element.setAttribute('data-updated', 'true');

                    // Remove animation class after animation completes
                    setTimeout(() => {
                        element.removeAttribute('data-updated');
                    }, 600);
                }
            } else {
                console.warn('[WARNING] Stats value is undefined for:', i, 'in message:', msg);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Traffic pipeline: dashboard always, map work through the D34 lifecycle
// ---------------------------------------------------------------------------

// Dashboard state updates on EVERY Traffic event, in every lifecycle state (D29).
// Calls are optional-chained as defense in depth (D43) — the dashboard object
// provably exists before the socket connects (synchronous instantiation +
// deferred document order + DOMContentLoaded).
function updateDashboardState(msg) {
    const attackData = {
        ip: msg.src_ip,
        source_ip: msg.src_ip,
        src_ip: msg.src_ip,
        ip_rep: msg.ip_rep,
        tpot_hostname: msg.tpot_hostname,
        color: msg.color,
        country: msg.country,
        country_code: msg.iso_code,
        iso_code: msg.iso_code,
        protocol: msg.protocol,
        honeypot: msg.honeypot, // Use honeypot field from message, not tpot_hostname
        port: msg.dst_port,
        dst_port: msg.dst_port,
        destination_ip: msg.dst_ip,
        destination_port: msg.dst_port,
        // Add honeypot location data for proper flag restoration
        dst_country_name: msg.dst_country_name,
        dst_iso_code: msg.dst_iso_code,
        destination_country: msg.dst_country_name,  // Alternative field name
        destination_country_code: msg.dst_iso_code, // Alternative field name
        // Add coordinate data for map restoration
        source_lat: msg.src_lat,
        source_lng: msg.src_long,
        destination_lat: msg.dst_lat,
        destination_lng: msg.dst_long,
        timestamp: Date.now(),
        event_time: msg.event_time
    };

    // Send to live feed
    window.attackMapDashboard?.addAttackEvent(attackData);

    // Send to honeypot performance tracking
    window.attackMapDashboard?.processAttackForDashboard(attackData);
}

// Canonical AttackEvent (§9.2): geographic endpoints + metadata, no shape data.
function toAttackEvent(msg) {
    return {
        id: msg.event_count,
        src: { lng: msg.src_long, lat: msg.src_lat },
        dst: { lng: msg.dst_long, lat: msg.dst_lat },
        color: msg.color,
        protocol: msg.protocol,
        spawnedAt: Date.now(),
        seed: Number.isFinite(msg.event_count) ? msg.event_count : Math.floor(Math.random() * 2147483647)
    };
}

// renderMapTraffic gates ALL map side effects together (D34): registry
// bookkeeping, attacker circle, honeypot marker and the transient animation.
function renderMapTraffic(msg) {
    var srcLatLng = { lat: msg.src_lat, lng: msg.src_long };
    var dstLatLng = { lat: msg.dst_lat, lng: msg.dst_long };

    // Store attack data for tooltips — keys byte-identical to 3.0.1
    var srcKey = srcLatLng.lat + "," + srcLatLng.lng;
    var dstKey = dstLatLng.lat + "," + dstLatLng.lng;

    // Pre-create attacker data structure if needed
    if (!circleAttackData[srcKey]) {
        circleAttackData[srcKey] = {
            country: msg.country,
            iso_code: msg.iso_code,
            location_key: srcKey,
            attacks: [],
            firstSeen: new Date(),
            lastSeen: new Date(),
            lastProtocol: msg.protocol,
            lastColor: msg.color,
            // Track multiple IPs at the same location
            ips: {}
        };
    } else {
        // Update protocol tracking for existing location
        circleAttackData[srcKey].lastProtocol = msg.protocol;
        circleAttackData[srcKey].lastColor = msg.color;
        circleAttackData[srcKey].lastSeen = new Date();
    }

    // Initialize IP-specific data if this is a new IP at this location
    if (!circleAttackData[srcKey].ips[msg.src_ip]) {
        circleAttackData[srcKey].ips[msg.src_ip] = {
            src_ip: msg.src_ip,
            ip_rep: msg.ip_rep,
            attacks: [],
            firstSeen: new Date(),
            lastSeen: new Date()
        };
    }

    // Pre-create honeypot data structure if needed
    if (!markerAttackData[dstKey]) {
        markerAttackData[dstKey] = {
            country: msg.dst_country_name,
            iso_code: msg.dst_iso_code,
            dst_ip: msg.dst_ip,
            hostname: msg.tpot_hostname,
            attacks: [],
            totalAttacks: 0,
            uniqueAttackers: new Set(),
            protocolStats: {},
            firstSeen: new Date(),
            lastUpdate: new Date()
        };
    }

    addCircle(msg.country, msg.iso_code, msg.src_ip, msg.ip_rep, msg.color, srcLatLng, msg.protocol);
    addMarker(msg.dst_country_name, msg.dst_iso_code, msg.dst_ip, msg.tpot_hostname, dstLatLng);
    recordHeatHit(srcLatLng.lat, srcLatLng.lng);   // density heatmap accumulator

    // Transient animation — the tab-wake suppression of 3.0.1 is preserved
    if (renderer && !document.hidden && !isWakingUp) {
        renderer.spawn(toAttackEvent(msg));
    }

    // Attack bookkeeping (as 3.0.1, without the pointless Promise.all)
    const attackData = {
        protocol: msg.protocol,
        port: msg.dst_port,
        honeypot: msg.honeypot,
        timestamp: new Date(),
        src_ip: msg.src_ip
    };

    circleAttackData[srcKey].attacks.push(attackData);
    circleAttackData[srcKey].lastSeen = new Date();
    circleAttackData[srcKey].ips[msg.src_ip].attacks.push(attackData);
    circleAttackData[srcKey].ips[msg.src_ip].lastSeen = new Date();

    markerAttackData[dstKey].attacks.push({
        src_ip: msg.src_ip,
        protocol: msg.protocol,
        port: msg.dst_port,
        timestamp: new Date()
    });
    markerAttackData[dstKey].totalAttacks++;
    markerAttackData[dstKey].uniqueAttackers.add(msg.src_ip);
    markerAttackData[dstKey].protocolStats[msg.protocol] =
        (markerAttackData[dstKey].protocolStats[msg.protocol] || 0) + 1;
    markerAttackData[dstKey].lastUpdate = new Date();

    // Keep only last 50 attacks per location for performance
    if (markerAttackData[dstKey].attacks.length > 50) {
        markerAttackData[dstKey].attacks = markerAttackData[dstKey].attacks.slice(-50);
    }
    if (circleAttackData[srcKey].attacks.length > 50) {
        circleAttackData[srcKey].attacks = circleAttackData[srcKey].attacks.slice(-50);
    }
}

const messageHandlers = {
  Traffic: (msg) => {
    // Valid data received - update timestamp for connection status
    window.lastValidDataTime = Date.now();

    // Dashboard state ALWAYS updates, in every lifecycle state (D29/D34)
    updateDashboardState(msg);

    if (mapLifecycle === 'READY') {
      renderMapTraffic(msg);
      return;
    }
    if (mapLifecycle === 'INITIALIZING') {
      if (startupTrafficQueue.length >= MAX_STARTUP_TRAFFIC) {
        startupTrafficQueue.shift();           // keep-newest: drop the OLDEST
        warnOnce('startup-queue', '[MAP-STARTUP] queue full, dropping oldest');
      }
      startupTrafficQueue.push(msg);
    }
    // FAILED: no map work; the dashboard path above already ran
  },
  Stats: (msg) => {
    handleStats(msg);
  },
};

// ---------------------------------------------------------------------------
// Cache-restore contract (§7.2, dormant): the real implementation, installed
// only after a successful map init. Nothing calls window.restoreAttackToMap
// in 4.0 — this preserves the contract, it does not activate it.
// ---------------------------------------------------------------------------
function realProcessRestoredAttack(event) {
    console.log('[MAP-RESTORE] Processing restored attack:', event);

    // Skip if event doesn't have required data
    if (!event.source_ip || !event.destination_ip) {
        console.log('[MAP-RESTORE] Skipping event - missing IP data');
        return;
    }

    // Create a simplified message object from cached event
    const restoredMsg = {
        // Source (attacker) data
        country: event.country || 'Unknown',
        iso_code: event.country_code || 'XX',
        src_ip: event.source_ip || event.ip,
        ip_rep: event.ip_rep || event.reputation || event.ip_reputation || 'Unknown',
        color: event.color || getProtocolColor(event.protocol),

        // Destination (honeypot) data - use original WebSocket field names
        dst_country_name: event.dst_country_name || event.destination_country || 'Local',
        dst_iso_code: event.dst_iso_code || event.destination_country_code || 'XX',
        dst_ip: event.destination_ip,
        tpot_hostname: event.tpot_hostname || event.honeypot || 'honeypot',
        honeypot: event.honeypot,
        protocol: event.protocol,
        dst_port: event.destination_port || event.port,

        // Coordinates (if available in cached data)
        src_lat: event.source_lat,
        src_long: event.source_lng || event.source_long,
        dst_lat: event.destination_lat,
        dst_long: event.destination_lng || event.destination_long
    };

    if (restoredMsg.src_lat && restoredMsg.src_long && restoredMsg.dst_lat && restoredMsg.dst_long) {
        const srcLatLng = { lat: restoredMsg.src_lat, lng: restoredMsg.src_long };
        const dstLatLng = { lat: restoredMsg.dst_lat, lng: restoredMsg.dst_long };
        restoreMarkerData(restoredMsg, srcLatLng, dstLatLng, event);
    } else {
        // 3.0.1 had a dead fallback here calling an undefined getCoordinates()
        // (map.js:143-157 at e798fcb) — it could never have worked. 4.0 replaces
        // it with an explicit warning; the "lat,lng" keys are untouched (R12).
        warnOnce('restore-coords',
            '[MAP-RESTORE] Restored event without coordinates skipped (the legacy getCoordinates fallback was dead code)');
    }
}

// Helper function to restore marker data and add visual elements
function restoreMarkerData(restoredMsg, srcLatLng, dstLatLng, originalEvent) {
    const srcKey = srcLatLng.lat + "," + srcLatLng.lng;
    const dstKey = dstLatLng.lat + "," + dstLatLng.lng;

    // Initialize or update circleAttackData for source location
    if (!circleAttackData[srcKey]) {
        circleAttackData[srcKey] = {
            country: restoredMsg.country,
            iso_code: restoredMsg.iso_code,
            attacks: [],
            totalAttacks: 0,
            ips: {},
            firstSeen: new Date(originalEvent.timestamp),
            lastSeen: new Date(originalEvent.timestamp),
            lastProtocol: restoredMsg.protocol,
            lastColor: restoredMsg.color
        };
    } else {
        // Update protocol tracking for restored attacks
        // For restoration, we want to preserve the latest protocol/color from actual restore order
        circleAttackData[srcKey].lastProtocol = restoredMsg.protocol;
        circleAttackData[srcKey].lastColor = restoredMsg.color;
        circleAttackData[srcKey].lastSeen = new Date(originalEvent.timestamp);
    }

    // Initialize IP data if needed
    if (!circleAttackData[srcKey].ips[restoredMsg.src_ip]) {
        circleAttackData[srcKey].ips[restoredMsg.src_ip] = {
            src_ip: restoredMsg.src_ip,
            ip_rep: restoredMsg.ip_rep,
            attacks: [],
            firstSeen: new Date(originalEvent.timestamp),
            lastSeen: new Date(originalEvent.timestamp)
        };
    } else {
        // Update reputation if new data is provided
        if (restoredMsg.ip_rep) {
            circleAttackData[srcKey].ips[restoredMsg.src_ip].ip_rep = restoredMsg.ip_rep;
        }
    }

    // Add attack data to source location
    const attackData = {
        protocol: restoredMsg.protocol,
        port: restoredMsg.dst_port,
        timestamp: new Date(originalEvent.timestamp),
        src_ip: restoredMsg.src_ip
    };

    circleAttackData[srcKey].attacks.push(attackData);
    circleAttackData[srcKey].totalAttacks++;
    circleAttackData[srcKey].lastSeen = new Date(originalEvent.timestamp);
    circleAttackData[srcKey].ips[restoredMsg.src_ip].attacks.push(attackData);
    circleAttackData[srcKey].ips[restoredMsg.src_ip].lastSeen = new Date(originalEvent.timestamp);

    // Initialize or update markerAttackData for destination (honeypot)
    if (!markerAttackData[dstKey]) {
        markerAttackData[dstKey] = {
            country: restoredMsg.dst_country_name,
            iso_code: restoredMsg.dst_iso_code,
            dst_ip: restoredMsg.dst_ip,
            hostname: restoredMsg.tpot_hostname,
            attacks: [],
            totalAttacks: 0,
            uniqueAttackers: new Set(),
            protocolStats: {},
            firstSeen: new Date(originalEvent.timestamp),
            lastUpdate: new Date(originalEvent.timestamp)
        };
    }

    // Add attack to honeypot data
    markerAttackData[dstKey].attacks.push({
        src_ip: restoredMsg.src_ip,
        protocol: restoredMsg.protocol,
        port: restoredMsg.dst_port,
        timestamp: new Date(originalEvent.timestamp)
    });
    markerAttackData[dstKey].totalAttacks++;
    markerAttackData[dstKey].uniqueAttackers.add(restoredMsg.src_ip);
    markerAttackData[dstKey].protocolStats[restoredMsg.protocol] =
        (markerAttackData[dstKey].protocolStats[restoredMsg.protocol] || 0) + 1;
    markerAttackData[dstKey].lastUpdate = new Date(originalEvent.timestamp);

    // Keep only last 50 attacks per location for performance
    if (markerAttackData[dstKey].attacks.length > 50) {
        markerAttackData[dstKey].attacks = markerAttackData[dstKey].attacks.slice(-50);
    }
    if (circleAttackData[srcKey].attacks.length > 50) {
        circleAttackData[srcKey].attacks = circleAttackData[srcKey].attacks.slice(-50);
    }

    // Add visual elements (circle for attacker and marker for honeypot)
    addCircle(restoredMsg.country, restoredMsg.iso_code, restoredMsg.src_ip,
             restoredMsg.ip_rep, restoredMsg.color, srcLatLng, restoredMsg.protocol);
    addMarker(restoredMsg.dst_country_name, restoredMsg.dst_iso_code,
             restoredMsg.dst_ip, restoredMsg.tpot_hostname, dstLatLng);
    recordHeatHit(srcLatLng.lat, srcLatLng.lng);
}

// ---------------------------------------------------------------------------
// Style loading and theme switching (§7.3, §7.6, D44)
// ---------------------------------------------------------------------------
async function loadStyle(theme, hdr, url) {
    const res = await fetch(`static/styles/${theme}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`style ${theme}: HTTP ${res.status}`);
    const style = await res.json();
    // Resolved base + literal template — never new URL() on a '{…}' string (§7.3)
    style.glyphs = new URL('static/basemaps/fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
    style.sprite = new URL(`static/basemaps/sprites/v4/${theme}`, document.baseURI).href;
    style.sources.protomaps.url = `pmtiles://${url}`;
    style.sources.protomaps.maxzoom = hdr.maxZoom;
    return style;
}

async function updateMapTheme(theme) {
    if (mapLifecycle !== 'READY') {   // D44: INITIALIZING -> remember; FAILED -> no map work.
        pendingTheme = theme;         // The dashboard's own theming is pure CSS and
        return;                       // continues regardless.
    }
    const revision = ++themeRevision;
    const style = await loadStyle(theme, header, pmtilesUrl);
    if (revision !== themeRevision) return;   // a newer request superseded this one
    themeTheMapWasBuiltWith = theme;
    map.setStyle(style, { diff: true });
}

// Re-adds custom sources/layers after any style (re)load. Guards are per
// object (a reload can leave partial state); feature-state is ALWAYS
// re-applied (§7.6). The choropleth pieces arrive in WP7 through the
// window.__choropleth hook.
function firstLabelLayerId() {
    const layers = map.getStyle().layers || [];
    const symbol = layers.find(l => l.type === 'symbol');
    return symbol ? symbol.id : undefined;
}

function reAddCustomLayers() {
    if (window.__choropleth) window.__choropleth.readd();   // WP7: countries source + fill layer
    if (!map.getSource('attackers')) map.addSource('attackers', attackersSourceSpec());
    if (!map.getLayer('attackers-layer')) map.addLayer(attackersLayerSpec());
    if (map.getSource('attackers')) map.getSource('attackers').setData(attackersFeatureCollection());
    if (window.__choropleth) window.__choropleth.reapplyFeatureState();  // ALWAYS — never inside a "source was missing" branch
}

// ---------------------------------------------------------------------------
// Failure handling (§13.4-§13.6, D37, D38)
// ---------------------------------------------------------------------------
function showMapFailure(title, hint) {
    console.error(`[MAP-FAILURE] ${title}${hint ? ' — ' + hint : ''}`);
    const panel = document.getElementById('map-failure-panel');
    if (panel) {
        const t = document.getElementById('map-failure-title');
        const h = document.getElementById('map-failure-hint');
        if (t) t.textContent = title;
        if (h) h.textContent = hint || '';
        panel.hidden = false;
    }
    if (window.map) {          // fatal failure AFTER construction (D37)
        try { window.map.remove(); } catch (e) { /* already torn down */ }
        window.map = null;
        map = null;
    }
    mapLifecycle = 'FAILED';
    startupTrafficQueue.length = 0;   // one log line; dashboard and WebSocket continue
    pendingRestored.length = 0;       // §7.2
    console.log('[MAP-FAILURE] Map disabled; data channel and dashboard continue.');
}

function handleMapError(e) {
    const err = e && e.error;
    if (maplibregl && err instanceof maplibregl.GPUInitializationError) {   // §13.4
        showMapFailure('WebGL2 required', err.message);
        return;
    }
    // Tile-level failures after construction: log at most once per minute (§13.5)
    const now = Date.now();
    if (now - lastMapErrorLog > 60000) {
        lastMapErrorLog = now;
        console.warn('[MAP-ERROR]', err ? (err.message || err) : e);
    }
}

function hasWebGL2() {
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) return false;
    const lose = probe.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();   // release the context slot (§13.4)
    return true;
}

// ---------------------------------------------------------------------------
// Startup domain 2: the map (async, may fail; never blocks the data channel)
// ---------------------------------------------------------------------------
async function initMap() {
    let boot, rendererModule;
    try {
        // D2: awaiting the dynamic imports IS the synchronisation — no load-order
        // globals, no polling. Relative specifiers resolve against map.js's own
        // URL, so this works at both / and /map/ (proven in WP4).
        [boot, rendererModule] = await Promise.all([
            import('./map-boot.mjs'),
            import('./attack-renderer.mjs')
        ]);
    } catch (e) {
        showMapFailure('Map engine failed to load', String(e));
        return;
    }
    maplibregl = boot.maplibregl;

    if (!hasWebGL2()) {
        showMapFailure('WebGL2 required',
            'This browser/session has no WebGL2 context. Enable hardware acceleration or use a WebGL2-capable browser.');
        return;
    }

    pmtilesUrl = new URL('static/dist/world.pmtiles', document.baseURI).href;
    try {
        header = await boot.openBasemap(pmtilesUrl);   // §13.5 preflight
    } catch (e) {
        showMapFailure('Basemap missing or unreadable',
            'Run: tools/fetch_basemap.sh --preset dev   (details: ' + String(e && e.message || e) + ')');
        return;
    }

    const startupTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    let style;
    try {
        style = await loadStyle(startupTheme, header, pmtilesUrl);
    } catch (e) {
        showMapFailure('Map style missing or invalid', String(e && e.message || e));
        return;
    }

    try {
        map = new maplibregl.Map({
            container: 'map',
            style: style,
            center: [0, 0],
            zoom: 2,                                    // 512 px tiles: ≙ old Leaflet zoom 3 (§7.4)
            minZoom: Math.max(1, header.minZoom),
            maxZoom: header.maxZoom,                    // the archive is authoritative (§7.4)
            renderWorldCopies: true,
            maxPitch: 0,
            dragRotate: false,
            attributionControl: { compact: true }
        });
    } catch (e) {
        showMapFailure('Map initialisation failed', String(e && e.message || e));
        return;
    }
    window.map = map;   // D37: the ONE successful assignment
    themeTheMapWasBuiltWith = startupTheme;

    map.on('error', handleMapError);
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.FullscreenControl());

    try {
        await new Promise((resolve, reject) => {
            map.once('load', resolve);
            map.once('error', (e) => {
                // GPUInitializationError before first load is fatal (§13.4)
                if (e.error instanceof maplibregl.GPUInitializationError) reject(e.error);
            });
        });
    } catch (e) {
        showMapFailure('WebGL2 required', String(e && e.message || e));
        return;
    }

    // Custom sources/layers now and after every future style (re)load (§7.6)
    reAddCustomLayers();
    map.on('style.load', reAddCustomLayers);

    // Attacker popups: built on click (replaces the refresh-on-click logic)
    map.on('click', 'attackers-layer', (e) => {
        const feature = e.features && e.features[0];
        if (!feature) return;
        const key = feature.properties.key;
        const data = circleAttackData[key];
        if (!data) return;
        new maplibregl.Popup({ maxWidth: '350px', className: 'modern-popup attacker-popup' })
            .setLngLat(feature.geometry.coordinates)
            .setDOMContent(createAttackerPopup(data))
            .addTo(map);
    });
    map.on('mouseenter', 'attackers-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'attackers-layer', () => { map.getCanvas().style.cursor = ''; });

    // Transient animation renderer (WP5)
    renderer = new rendererModule.AttackRenderer();
    renderer.attach(map);
    window.__attackRenderer = renderer;   // test/diagnostic hook (like __choropleth)

    // Full Clear-Cache implementation (D38): queues in every state (the stub
    // already does that) plus renderer queue, attacker source/registry, marker
    // registry and choropleth state when READY.
    window.clearMapVisuals = function () {
        startupTrafficQueue.length = 0;
        pendingRestored.length = 0;
        if (renderer) renderer.clear();
        for (const k of Object.keys(circlesObject)) delete circlesObject[k];
        for (const k of Object.keys(circleAttackData)) delete circleAttackData[k];
        for (const k of Object.keys(markersObject)) {
            try { markersObject[k].remove(); } catch (e) { /* detached */ }
            delete markersObject[k];
        }
        for (const k of Object.keys(markerAttackData)) delete markerAttackData[k];
        syncAttackersSource();
        if (window.__choropleth) window.__choropleth.clear();
    };

    mapLifecycle = 'READY';

    // Choropleth: id set for unmatched-code logging, and a flush for counts
    // mirrored while the map was still INITIALIZING (WP7)
    loadCountryIdSet();
    scheduleChoroplethFlush();
    scheduleHeatFlush();

    // Drain the startup traffic queue in order, then the restore queue (§7.1/§7.2)
    for (const queued of startupTrafficQueue) renderMapTraffic(queued);
    startupTrafficQueue.length = 0;

    window.processRestoredAttack = realProcessRestoredAttack;
    for (const e of pendingRestored) realProcessRestoredAttack(e);
    pendingRestored.length = 0;

    // D44: apply a theme requested during INITIALIZING
    const startTheme = pendingTheme ?? (document.documentElement.getAttribute('data-theme') || 'dark');
    pendingTheme = null;
    if (startTheme !== themeTheMapWasBuiltWith) updateMapTheme(startTheme);

    console.log(`[MAP] READY — MapLibre ${maplibregl.getVersion ? maplibregl.getVersion() : ''}, basemap z${header.minZoom}-${header.maxZoom}`);
}

// ---------------------------------------------------------------------------
// Startup domain 1: the data channel (D29 — independent of the map)
// ---------------------------------------------------------------------------
function startDataChannel() {
    document.addEventListener('DOMContentLoaded', function () {
        connectWebSocket();
    });
}

// Enhanced WebSocket handling with dashboard integration
function connectWebSocket() {
  // Prevent multiple connection attempts
  if (isReconnecting) {
    console.log('[INFO] Connection attempt already in progress');
    return;
  }

  // Close existing connection if it exists to prevent resource leaks
  if (window.webSocket) {
    try {
        console.log('[INFO] Cleaning up existing WebSocket before reconnection');
        window.webSocket.close();
    } catch (e) {
        console.log('[WARN] Error closing existing WebSocket:', e);
    }
  }

  isReconnecting = true;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_HOST = protocol + '//' + window.location.host + '/websocket';

  // Update status to connecting when attempting connection
  window.attackMapDashboard?.updateConnectionStatus('connecting');

  // Make WebSocket globally accessible for dashboard monitoring
  window.webSocket = webSocket = new WebSocket(WS_HOST);

  webSocket.onopen = function () {
    // Reset reconnection tracking
    isReconnecting = false;
    reconnectAttempts = 0;

    // Reset last message time to prevent immediate timeout on reconnection
    window.lastWebSocketMessageTime = Date.now();
    window.lastValidDataTime = Date.now(); // Reset valid data timer

    // Set global connection flag immediately
    window.webSocketConnected = true;

    // Start heartbeat to monitor connection health
    startHeartbeat();

    // D43: the dashboard object provably exists before the socket connects
    // (synchronous instantiation, deferred document order, DOMContentLoaded) —
    // the 3.0.1 updateStatusWithRetry polling loop is deleted.
    window.attackMapDashboard?.updateConnectionStatus('connected');
    console.log('[*] WebSocket connection established.');
  };

  webSocket.onclose = function (event) {
     // Stop heartbeat when connection closes
     stopHeartbeat();

     // Clear the WebSocket connected flag
     window.webSocketConnected = false;

     var reason = "Unknown error reason?";
     if (event.code == 1000)     reason = "[ ] Endpoint terminating connection: Normal closure";
     else if(event.code == 1001) reason = "[ ] Endpoint terminating connection: Endpoint is \"going away\"";
     else if(event.code == 1002) reason = "[ ] Endpoint terminating connection: Protocol error";
     else if(event.code == 1003) reason = "[ ] Endpoint terminating connection: Unknown data";
     else if(event.code == 1004) reason = "[ ] Endpoint terminating connection: Reserved";
     else if(event.code == 1005) reason = "[ ] Endpoint terminating connection: No status code";
     else if(event.code == 1006) reason = "[ ] Endpoint terminating connection: Connection closed abnormally";
     else if(event.code == 1007) reason = "[ ] Endpoint terminating connection: Message was not consistent with the type of the message";
     else if(event.code == 1008) reason = "[ ] Endpoint terminating connection: Message \"violates policy\"";
     else if(event.code == 1009) reason = "[ ] Endpoint terminating connection: Message is too big";
     else if(event.code == 1010) reason = "[ ] Endpoint terminating connection: Client failed to negotiate ("+event.reason+")";
     else if(event.code == 1011) reason = "[ ] Endpoint terminating connection: Server encountered an unexpected condition";
     else if(event.code == 1015) reason = "[ ] Endpoint terminating connection: Connection closed due TLS handshake failure";
     else reason = "[ ] Endpoint terminating connection; Unknown reason";

     // Update dashboard connection status
     window.attackMapDashboard?.updateConnectionStatus('disconnected');

     console.log(reason);

     // Always attempt to reconnect if not a clean closure (or even if it is, depending on requirements, but usually 1000 is manual)
     // User requirement: "Every 60 seconds a reconnection attempt should be made"
     if (event.code !== 1000) {
       const delay = reconnectDelay;
       console.log(`[INFO] Connection lost. Attempting reconnection in ${delay}ms`);

       setTimeout(() => {
         reconnectAttempts++;
         isReconnecting = false; // Reset flag to allow new connection attempt
         connectWebSocket();
       }, delay);
     } else {
       isReconnecting = false;
       console.log('[INFO] Connection closed normally. No auto-reconnect.');
     }
  };

  webSocket.onerror = function (error) {
    console.log('[ERROR] WebSocket error:', error);
    // Stop heartbeat on error
    stopHeartbeat();
    // Update status to disconnected on error
    window.attackMapDashboard?.updateConnectionStatus('disconnected');
  };

  webSocket.onmessage = function (e) {
    try {
      // Update last message time for connection health monitoring
      window.lastWebSocketMessageTime = Date.now();

      var msg = JSON.parse(e.data);

      if (msg.demo) markDemoData();   // D27

      let handler = messageHandlers[msg.type];
      if (handler) {
        handler(msg);
      } else {
        console.warn('[WARNING] No handler found for message type:', msg.type);
      }

    } catch (error) {
      console.error('[ERROR] Failed to parse WebSocket message:', error);
      console.log('[ERROR] Raw message data:', e.data);
    }
  };
}

// Heartbeat functions to monitor connection health
function startHeartbeat() {
  stopHeartbeat(); // Clear any existing heartbeat

  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const timeSinceLastMessage = now - window.lastWebSocketMessageTime;

    // Log warning if no messages for extended time, but do NOT force close
    // This allows for "Idle" state
    if (timeSinceLastMessage > 60000) {
      console.log('[INFO] No messages received for 1 minute. Connection state should be Idle.');
    }
  }, 30000); // Check every 30 seconds
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// DEMO DATA badge (D27): visible while incoming messages carry demo: true;
// hides itself when no demo message has arrived for 15 s.
let demoBadgeTimer = null;
function markDemoData() {
  const badge = document.getElementById('demo-badge');
  if (!badge) return;
  badge.hidden = false;
  if (demoBadgeTimer) clearTimeout(demoBadgeTimer);
  demoBadgeTimer = setTimeout(() => { badge.hidden = true; }, 15000);
}

// Enhanced function to check connection health
function checkConnectionHealth() {
  if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
    console.log('[INFO] WebSocket not connected, attempting to reconnect...');
    window.attackMapDashboard?.updateConnectionStatus('disconnected');
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Theme observer and tab-visibility handling
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function() {
  const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
        const newTheme = document.documentElement.getAttribute('data-theme');
        updateMapTheme(newTheme);
      }
    });
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  });

  // Add page visibility change handler
  document.addEventListener('visibilitychange', function() {
    isPageVisible = !document.hidden;

    if (isPageVisible) {
      // Set waking up flag to suppress animation burst from buffered messages
      isWakingUp = true;
      setTimeout(() => {
          isWakingUp = false;
      }, 2000); // 2 second grace period

      // Clean up any stuck animations from background throttling
      if (renderer) renderer.clear();

      // Check connection health and reconnect if needed
      if (!checkConnectionHealth()) {
          console.log('Connection lost while backgrounded, reconnecting...');
          isReconnecting = false;
          connectWebSocket();
      }
    } else {
      // Page hidden - background operation mode
    }
  });
});

// ---------------------------------------------------------------------------
// Boot: data channel first, then the map — two independent domains (D29)
// ---------------------------------------------------------------------------
startDataChannel();
initMap();
