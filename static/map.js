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

// FIX: Leaflet Grid Lines / Tile Gaps
// Override the internal _initTile method to force tiles to be 1px larger
// This creates a 1px overlap that hides the sub-pixel rendering gaps in Chrome/Edge
// We exclude Firefox (Gecko) because it handles rendering differently and this fix causes artifacts there
(function(){
    if (L.Browser.gecko) return; // Skip for Firefox

    var originalInitTile = L.GridLayer.prototype._initTile;
    L.GridLayer.include({
        _initTile: function (tile) {
            originalInitTile.call(this, tile);
            var tileSize = this.getTileSize();
            tile.style.width = tileSize.x + 1 + 'px';
            tile.style.height = tileSize.y + 1 + 'px';
        }
    });
})();

// Map theme support
var mapLayers = {
    dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '<a href="https://www.openstreetmap.org/copyright">&copy OpenStreetMap</a> <a href="https://carto.com/attributions">&copy CARTO</a>',
        detectRetina: true,
        subdomains: 'abcd',
        minZoom: 2,
        maxZoom: 8,
        tileSize: 256
    }),
    light: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '<a href="https://www.openstreetmap.org/copyright">&copy OpenStreetMap</a> <a href="https://carto.com/attributions">&copy CARTO</a>',
        detectRetina: true,
        subdomains: 'abcd',
        minZoom: 2,
        maxZoom: 8,
        tileSize: 256
    })
};

// Get current theme
var currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
var base = mapLayers[currentTheme];

// Check if map container is already initialized
if (window.map) {
    window.map.remove();
}

var map = L.map('map', {
    layers: [base],
    tap: false, // ref https://github.com/Leaflet/Leaflet/issues/7255
    center: new L.LatLng(0, 0),
    trackResize: true,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 8,
    zoom: 3,
    zoomSnap: 0.2, // Allow fractional zoom levels
    zoomDelta: 0.2, // Match zoomSnap
    fullscreenControl: true,
    fullscreenControlOptions: {
        title:"Fullscreen Mode",
        titleCancel:"Exit Fullscreen Mode"
    }
});

// Make map globally accessible
window.map = map;

// Enhanced attack map with modern dashboard integration

// Make map globally accessible
window.map = map;

// Enhanced marker clustering
var circles = new L.LayerGroup();
var markers = new L.LayerGroup();
var attackLines = new L.LayerGroup();

map.addLayer(circles);
map.addLayer(markers);
map.addLayer(attackLines);

// Cache restoration function for map markers
window.processRestoredAttack = function(event) {
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
        honeypot_hostname: event.honeypot_hostname || event.honeypot || 'honeypot',
        honeypot: event.honeypot,
        protocol: event.protocol,
        dst_port: event.destination_port || event.port,

        // Coordinates (if available in cached data)
        src_lat: event.source_lat,
        src_long: event.source_lng || event.source_long,
        dst_lat: event.destination_lat,
        dst_long: event.destination_lng || event.destination_long
    };

    // If we have coordinates in the cached data, use them directly
    if (restoredMsg.src_lat && restoredMsg.src_long && restoredMsg.dst_lat && restoredMsg.dst_long) {
        const srcLatLng = new L.LatLng(restoredMsg.src_lat, restoredMsg.src_long);
        const dstLatLng = new L.LatLng(restoredMsg.dst_lat, restoredMsg.dst_long);

        restoreMarkerData(restoredMsg, srcLatLng, dstLatLng, event);
    } else {
        // Fallback: get coordinates from country/location data
        Promise.all([
            getCoordinates(restoredMsg.country, restoredMsg.iso_code),
            getCoordinates(restoredMsg.dst_country_name, restoredMsg.dst_iso_code)
        ]).then(([srcCoords, dstCoords]) => {
            if (srcCoords && dstCoords) {
                const srcLatLng = new L.LatLng(srcCoords.lat, srcCoords.lng);
                const dstLatLng = new L.LatLng(dstCoords.lat, dstCoords.lng);

                restoreMarkerData(restoredMsg, srcLatLng, dstLatLng, event);
            }
        }).catch(error => {
            console.log('[MAP-RESTORE] Error getting coordinates:', error);
        });
    }
};

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
            hostname: restoredMsg.honeypot_hostname,
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
             restoredMsg.dst_ip, restoredMsg.honeypot_hostname, dstLatLng);
}

// Helper function to get protocol color (matches existing logic)
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

// Use Leaflet's built-in SVG renderer to handle zoom/pan and event bubbling correctly
var svgRenderer = L.svg({ clickable: true }).addTo(map);

// Select the SVG element and append a group for D3 animations
// We use a group to keep our elements separate from Leaflet's internal layers
var svg = d3.select(svgRenderer._container).append("g").attr("class", "d3-overlay");

// Ensure the SVG container doesn't block map interactions
// Leaflet usually handles this, but we enforce it to fix the Firefox panning issue
d3.select(svgRenderer._container).style("pointer-events", "none");

// Clear animations on zoom start to prevent coordinate desync
// D3 elements don't automatically re-project during zoom, so we clear them
map.on("zoomstart", function() {
    svg.selectAll("*").remove();
});

// No need for manual translateSVG or moveend listener as Leaflet handles the SVG renderer

function calcMidpoint(x1, y1, x2, y2, bend) {
    if(y2<y1 && x2<x1) {
        var tmpy = y2;
        var tmpx = x2;
        x2 = x1;
        y2 = y1;
        x1 = tmpx;
        y1 = tmpy;
    }
    else if(y2<y1) {
        y1 = y2 + (y2=y1, 0);
    }
    else if(x2<x1) {
        x1 = x2 + (x2=x1, 0);
    }

    var radian = Math.atan(-((y2-y1)/(x2-x1)));
    var r = Math.sqrt(x2-x1) + Math.sqrt(y2-y1);
    var m1 = (x1+x2)/2;
    var m2 = (y1+y2)/2;

    var min = 2.5, max = 7.5;
    var arcIntensity = parseFloat((Math.random() * (max - min) + min).toFixed(2));

    if (bend === true) {
        var a = Math.floor(m1 - r * arcIntensity * Math.sin(radian));
        var b = Math.floor(m2 - r * arcIntensity * Math.cos(radian));
    } else {
        var a = Math.floor(m1 + r * arcIntensity * Math.sin(radian));
        var b = Math.floor(m2 + r * arcIntensity * Math.cos(radian));
    }

    return {"x":a, "y":b};
}

function translateAlong(path) {
    var l = path.getTotalLength();
    return function(i) {
        return function(t) {
            // Put in try/catch because sometimes floating point is stupid..
            try {
                var p = path.getPointAtLength(t*l);
                return "translate(" + p.x + "," + p.y + ")";
            } catch(err){
                console.log("Caught exception.");
                return "ERROR";
            }
        };
    };
}

function handleParticle(color, srcPoint) {
    // Skip animation if tab is not visible OR if we are in the "waking up" grace period
    // This prevents the explosion of buffered animations when returning to the tab
    if (document.hidden || isWakingUp) return;

    var i = 0;
    var x = srcPoint['x'];
    var y = srcPoint['y'];

    svg.append('circle')
        .attr('cx', x)
        .attr('cy', y)
        .attr('r', 0)
        .style('fill', 'none')
        .style('stroke', color)
        .style('stroke-opacity', 1)
        .style('stroke-width', 3)
        .transition()
        .duration(700)
        .ease(d3.easeCircleIn)
        // Circle radius source animation
        .attr('r', 50)
        .style('stroke-opacity', 0)
        .remove();
}

function handleTraffic(color, srcPoint, hqPoint) {
    // Skip animation if tab is not visible OR if we are in the "waking up" grace period
    // This prevents the explosion of buffered animations when returning to the tab
    if (document.hidden || isWakingUp) return;

    var fromX = srcPoint['x'];
    var fromY = srcPoint['y'];
    var toX = hqPoint['x'];
    var toY = hqPoint['y'];
    var bendArray = [true, false];
    var bend = bendArray[Math.floor(Math.random() * bendArray.length)];

    var lineData = [srcPoint, calcMidpoint(fromX, fromY, toX, toY, bend), hqPoint]
    var lineFunction = d3.line()
        .curve(d3.curveBasis)
        .x(function(d) {return d.x;})
        .y(function(d) {return d.y;});

    var lineGraph = svg.append('path')
            .attr('d', lineFunction(lineData))
            .attr('opacity', 0.8)
            .attr('stroke', color)
            .attr('stroke-width', 2)
            .attr('fill', 'none');

    var circleRadius = 6

    // Circle follows the line
    var dot = svg.append('circle')
        .attr('r', circleRadius)
        .attr('fill', color)
        .transition()
        .duration(700)
        .ease(d3.easeCircleIn)
        .attrTween('transform', translateAlong(lineGraph.node()))
        .on('end', function() {
            d3.select(this)
                .attr('fill', 'none')
                .attr('stroke', color)
                .attr('stroke-width', 3)
                .transition()
                .duration(700)
                .ease(d3.easeCircleIn)
                // Circle radius destination animation
                .attr('r', 50)
                .style('stroke-opacity', 0)
                .remove();
    });

    var length = lineGraph.node().getTotalLength();
    lineGraph.attr('stroke-dasharray', length + ' ' + length)
        .attr('stroke-dashoffset', length)
        .transition()
        .duration(700)
        .ease(d3.easeCircleIn)
        .attr('stroke-dashoffset', 0)
        .on('end', function() {
            d3.select(this)
                .transition()
                .duration(700)
                .style('opacity', 0)
                .remove();
        });
}

var circlesObject = {};
// Store attack data for each circle for enhanced tooltips
var circleAttackData = {};

function addCircle(country, iso_code, src_ip, ip_rep, color, srcLatLng, protocol) {
    circleCount = circles.getLayers().length;
    circleArray = circles.getLayers();

    // Only allow 200 circles to be on the map at a time
    if (circleCount >= 200) {
        // Find the key with the oldest lastSeen time
        let oldestKey = null;
        let oldestTime = new Date(); // Start with current time, anything older will be smaller

        // Only iterate over keys that actually exist on the map to avoid ghost entries
        const validKeys = Object.keys(circlesObject);

        for (const key of validKeys) {
            const data = circleAttackData[key];
            if (data && data.lastSeen < oldestTime) {
                oldestTime = data.lastSeen;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            circles.removeLayer(circlesObject[oldestKey]);
            delete circlesObject[oldestKey];
            delete circleAttackData[oldestKey];
        } else {
            // Fallback if something goes wrong
            const layerToRemove = circleArray[0];
            circles.removeLayer(layerToRemove);

            // Try to find and clean up the key for this layer
            for (const [key, layer] of Object.entries(circlesObject)) {
                if (layer === layerToRemove) {
                    delete circlesObject[key];
                    delete circleAttackData[key];
                    break;
                }
            }
        }
    }

    var key = srcLatLng.lat + "," + srcLatLng.lng;

    // Check if circle exists and needs color update
    if (circlesObject[key]) {
        // Circle exists - check if protocol/color has changed
        const existingCircle = circlesObject[key];
        const currentColor = existingCircle.options.color;

        // If color changed, update the circle
        if (currentColor !== color) {
            console.log(`[CIRCLE-UPDATE] Updating circle color at ${key} from ${currentColor} to ${color} (protocol: ${protocol})`);

            // Update circle style
            existingCircle.setStyle({
                color: color,
                fillColor: color,
                fillOpacity: 0.2
            });

            // Update protocol tracking in attack data
            if (circleAttackData[key]) {
                circleAttackData[key].lastProtocol = protocol;
                circleAttackData[key].lastColor = color;
                circleAttackData[key].lastSeen = new Date();
            }
        }

        // Update IP data if needed
        if (circleAttackData[key] && circleAttackData[key].ips[src_ip]) {
            // Update reputation if new data is provided
            if (ip_rep) {
                circleAttackData[key].ips[src_ip].ip_rep = ip_rep;
            }
        }

        return; // Circle exists and has been updated if needed
    }

    // Create new circle if it doesn't exist
    // Attack data should already be created in Traffic handler
    // If for some reason it doesn't exist, create it (fallback)
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
        // Update protocol tracking for existing data
        circleAttackData[key].lastProtocol = protocol;
        circleAttackData[key].lastColor = color;
        circleAttackData[key].lastSeen = new Date();
    }

    // Ensure IP data exists (fallback)
    if (!circleAttackData[key].ips[src_ip]) {
        circleAttackData[key].ips[src_ip] = {
            src_ip: src_ip,
            ip_rep: ip_rep,
            attacks: [],
            firstSeen: new Date(),
            lastSeen: new Date()
        };
    } else {
        // Update reputation if new data is provided
        if (ip_rep) {
            circleAttackData[key].ips[src_ip].ip_rep = ip_rep;
        }
    }

    var circle = L.circle(srcLatLng, 50000, {
        color: color,
        fillColor: color,
        fillOpacity: 0.2
    });

    // Enhanced popup with modern styling
    var popupContent = createAttackerPopup(circleAttackData[key]);
    circle.bindPopup(popupContent, {
        maxWidth: 350,
        className: 'modern-popup attacker-popup'
    });

    // Add click event for enhanced interaction
    circle.on('click', function(e) {
        // Update popup content with latest data
        var updatedContent = createAttackerPopup(circleAttackData[key]);
        circle.setPopupContent(updatedContent);
    });

    circlesObject[key] = circle.addTo(circles);
}

var markersObject = {};
// Store attack data for each marker for enhanced tooltips
var markerAttackData = {};

function addMarker(dst_country_name, dst_iso_code, dst_ip, honeypot_hostname, dstLatLng) {
    // Validate parameters
    if (!dstLatLng || !dstLatLng.lat || !dstLatLng.lng) {
        return;
    }

    markerCount = markers.getLayers().length;
    markerArray = markers.getLayers();

    // Only allow 200 markers to be on the map at a time
    if (markerCount >= 200) {
        // Find the key with the oldest lastUpdate time
        let oldestKey = null;
        let oldestTime = new Date();

        // Only iterate over keys that actually exist on the map to avoid ghost entries
        const validKeys = Object.keys(markersObject);

        for (const key of validKeys) {
            const data = markerAttackData[key];
            if (data && data.lastUpdate < oldestTime) {
                oldestTime = data.lastUpdate;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            markers.removeLayer(markersObject[oldestKey]);
            delete markersObject[oldestKey];
            delete markerAttackData[oldestKey];
        } else {
            // Fallback
            markers.removeLayer(markerArray[0]);
            // Reset objects if we can't track properly (original behavior fallback)
            markersObject = {};
            markerAttackData = {};
        }
    }

    var key = dstLatLng.lat + "," + dstLatLng.lng;
    // Only draw marker if its coordinates are not already present in markersObject
    if (!markersObject[key]) {
        // Attack data should already be created in Traffic handler
        // If for some reason it doesn't exist, create it (fallback)
        if (!markerAttackData[key]) {
            markerAttackData[key] = {
                country: dst_country_name,
                iso_code: dst_iso_code,
                dst_ip: dst_ip,
                hostname: honeypot_hostname,
                attacks: [],
                totalAttacks: 0,
                uniqueAttackers: new Set(),
                protocolStats: {},
                firstSeen: new Date(),
                lastUpdate: new Date()
            };
        }

        var marker = L.marker(dstLatLng, {
            icon: L.icon({
                iconUrl: 'static/images/honeypot-marker.svg',
                iconSize: [48, 48], // Match original square size
                iconAnchor: [24, 40], // Adjusted anchor to fix hovering (was 48)
                popupAnchor: [0, -48], // Match original popup position
                className: 'honeypot-marker'
            }),
        });

        // Enhanced popup with modern styling
        var popupContent = createHoneypotPopup(markerAttackData[key]);
        marker.bindPopup(popupContent, {
            maxWidth: 400,
            className: 'modern-popup honeypot-popup'
        });

        // Add click event for enhanced interaction
        marker.on('click', function(e) {
            // Update popup content with latest data
            var updatedContent = createHoneypotPopup(markerAttackData[key]);
            marker.setPopupContent(updatedContent);
        });

        markersObject[key] = marker.addTo(markers);
    }
}

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
    console.log('[STATS] Valid stats data received, updating last valid timestamp.');
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
};

// WEBSOCKET STUFF

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
    h4.textContent = 'Honeypot';

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

const messageHandlers = {
  Traffic: (msg) => {
    // Valid data received - update timestamp for connection status
    window.lastValidDataTime = Date.now();

    var srcLatLng = new L.LatLng(msg.src_lat, msg.src_long);
    var dstLatLng = new L.LatLng(msg.dst_lat, msg.dst_long);
    var dstPoint = map.latLngToLayerPoint(dstLatLng);
    var srcPoint = map.latLngToLayerPoint(srcLatLng);

    // Store attack data for tooltips
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
            hostname: msg.honeypot_hostname,
            attacks: [],
            totalAttacks: 0,
            uniqueAttackers: new Set(),
            protocolStats: {},
            firstSeen: new Date(),
            lastUpdate: new Date()
        };
    }

    Promise.all([
        addCircle(msg.country, msg.iso_code, msg.src_ip, msg.ip_rep, msg.color, srcLatLng, msg.protocol),
        addMarker(msg.dst_country_name, msg.dst_iso_code, msg.dst_ip, msg.honeypot_hostname, dstLatLng),
        handleParticle(msg.color, srcPoint),
        handleTraffic(msg.color, srcPoint, dstPoint, srcLatLng)
    ]).then(() => {
        // Add attack data AFTER visual elements are created/updated
        const attackData = {
            protocol: msg.protocol,
            port: msg.dst_port,
            honeypot: msg.honeypot,
            timestamp: new Date(),
            src_ip: msg.src_ip
        };

        // Add to overall location attacks
        circleAttackData[srcKey].attacks.push(attackData);
        circleAttackData[srcKey].lastSeen = new Date();

        // Add to IP-specific attacks
        circleAttackData[srcKey].ips[msg.src_ip].attacks.push(attackData);
        circleAttackData[srcKey].ips[msg.src_ip].lastSeen = new Date();

        // Add attack to honeypot data
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

        // Keep only last 50 attacks per honeypot for performance
        if (markerAttackData[dstKey].attacks.length > 50) {
            markerAttackData[dstKey].attacks = markerAttackData[dstKey].attacks.slice(-50);
        }
    });

    // Send to dashboard for Live Feed processing with correct field mapping
    if (window.attackMapDashboard) {
      const attackData = {
        ip: msg.src_ip,
        source_ip: msg.src_ip,
        src_ip: msg.src_ip,
        ip_rep: msg.ip_rep,
        honeypot_hostname: msg.honeypot_hostname,
        color: msg.color,
        country: msg.country,
        country_code: msg.iso_code,
        iso_code: msg.iso_code,
        protocol: msg.protocol,
        honeypot: msg.honeypot, // Use honeypot field from message, not honeypot_hostname
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
      window.attackMapDashboard.addAttackEvent(attackData);

      // Send to honeypot performance tracking
      window.attackMapDashboard.processAttackForDashboard(attackData);
    }
  },
  Stats: (msg) => {
    handleStats(msg);
  },
};

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
  if (window.attackMapDashboard) {
    window.attackMapDashboard.updateConnectionStatus('connecting');
  }

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

    // Update connection status in dashboard with better retry logic
    function updateStatusWithRetry(attempts = 0) {
      const maxAttempts = 10; // Try for up to 5 seconds

      if (window.attackMapDashboard) {
        window.attackMapDashboard.updateConnectionStatus('connected');
        console.log('[*] WebSocket connection status updated to connected');
      } else if (attempts < maxAttempts) {
        // Dashboard not ready yet, retry with exponential backoff
        const delay = Math.min(100 + (attempts * 100), 1000); // 100ms to 1000ms
        setTimeout(() => updateStatusWithRetry(attempts + 1), delay);
      } else {
        console.log('[WARNING] Dashboard not available after retries, but flag is set');
      }
    }

    updateStatusWithRetry();
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
     if (window.attackMapDashboard) {
       window.attackMapDashboard.updateConnectionStatus('disconnected');
     }

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
    if (window.attackMapDashboard) {
      window.attackMapDashboard.updateConnectionStatus('disconnected');
    }
  };

  webSocket.onmessage = function (e) {
    try {
      // Update last message time for connection health monitoring
      window.lastWebSocketMessageTime = Date.now();

      var msg = JSON.parse(e.data);

      let handler = messageHandlers[msg.type];
      if (handler) {
        handler(msg);
      } else {
        console.warn('[WARNING] No handler found for message type:', msg.type);
      }

      // Let dashboard handle its own processing through messageHandlers
      // Removed duplicate addAttackEvent call to prevent double entries

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

// Enhanced function to check connection health
function checkConnectionHealth() {
  if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
    console.log('[INFO] WebSocket not connected, attempting to reconnect...');
    if (window.attackMapDashboard) {
      window.attackMapDashboard.updateConnectionStatus('disconnected');
    }
    return false;
  }

  // Simple check: Is the socket technically open?
  if (!webSocket || webSocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  return true;
}

// Initialize connection when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  connectWebSocket();
});

// Map theme update function
function updateMapTheme(theme) {
  if (!window.map || !mapLayers[theme]) return;

  // Remove current layer
  window.map.eachLayer(function(layer) {
    if (layer._url && layer._url.includes('basemaps.cartocdn.com')) {
      window.map.removeLayer(layer);
    }
  });

  // Add new theme layer
  mapLayers[theme].addTo(window.map);
}

// Listen for theme changes
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

      // Clean up any stuck D3 animations from background throttling
      if (typeof svg !== 'undefined' && svg) {
          svg.selectAll("*").remove();
      }

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

  // Start connection health monitoring
  // Removed aggressive health check as per new logic:
  // - Connected: Data < 30s
  // - Idle: No Data > 30s (but socket open)
  // - Disconnected: Socket Closed
  /*
  function startConnectionHealthCheck() {
    if (connectionHealthCheck) clearInterval(connectionHealthCheck);

    connectionHealthCheck = setInterval(() => {
       // ... removed ...
    }, 30000);
  }

  startConnectionHealthCheck();
  */
});
