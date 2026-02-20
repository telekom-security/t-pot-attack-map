/**
 * Attack Map Dashboard
 * Enhanced UI and data visualization functionality
 */

/**
 * Attack Cache Manager
 * Handles persistent storage of attack events using IndexedDB with LocalStorage fallback
 */
class AttackCache {
    constructor() {
        this.dbName = 'TPotAttackCache';
        this.storeName = 'attacks';
        this.version = 1;
        this.retentionPeriod = 24 * 60 * 60 * 1000; // 24 hours
        this.maxEvents = 10000; // Performance/memory limit
        this.cleanupInterval = 5 * 60 * 1000; // Cleanup every 5 minutes
        this.storageType = null;
        this.db = null;
        this.localStorageKey = 'tpot_attack_cache';
    }

    async init() {
        console.log('[CACHE] Initializing attack cache...');
        try {
            await this.initIndexedDB();
            this.storageType = 'indexeddb';
            console.log('[CACHE] Using IndexedDB for storage');
        } catch (error) {
            console.warn('[CACHE] IndexedDB failed, falling back to LocalStorage:', error);
            this.initLocalStorage();
            this.storageType = 'localstorage';
            console.log('[CACHE] Using LocalStorage for storage');
        }

        // Start periodic cleanup
        setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);

        console.log(`[CACHE] Cache initialized with ${this.storageType}, retention: 24h`);
    }

    async initIndexedDB() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB not supported'));
                return;
            }

            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create attacks object store if it doesn't exist
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, {
                        keyPath: 'id',
                        autoIncrement: true
                    });

                    // Create index on timestamp for efficient cleanup queries
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                    store.createIndex('source_ip', 'source_ip', { unique: false });
                    store.createIndex('honeypot', 'honeypot', { unique: false });
                }
            };
        });
    }

    initLocalStorage() {
        // LocalStorage is synchronous, just verify it's available
        if (!window.localStorage) {
            throw new Error('LocalStorage not supported');
        }

        // Initialize empty cache if doesn't exist
        if (!localStorage.getItem(this.localStorageKey)) {
            const emptyCache = {
                events: [],
                lastCleanup: Date.now(),
                version: 1
            };
            localStorage.setItem(this.localStorageKey, JSON.stringify(emptyCache));
        }
    }

    async storeEvent(event) {
        // Add timestamp and unique ID if not present
        const eventToStore = {
            ...event,
            timestamp: event.timestamp || Date.now(),
            cached_at: Date.now()
        };

        try {
            if (this.storageType === 'indexeddb') {
                await this.storeEventIndexedDB(eventToStore);
            } else {
                this.storeEventLocalStorage(eventToStore);
            }
        } catch (error) {
            console.warn('[CACHE] Failed to store event:', error);
        }
    }

    async storeEventIndexedDB(event) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.add(event);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    storeEventLocalStorage(event) {
        const cache = JSON.parse(localStorage.getItem(this.localStorageKey) || '{"events":[]}');
        cache.events.push(event);

        // Keep within limits
        if (cache.events.length > this.maxEvents) {
            cache.events = cache.events.slice(-this.maxEvents);
        }

        localStorage.setItem(this.localStorageKey, JSON.stringify(cache));
    }

    async getStoredEvents() {
        try {
            if (this.storageType === 'indexeddb') {
                return await this.getStoredEventsIndexedDB();
            } else {
                return this.getStoredEventsLocalStorage();
            }
        } catch (error) {
            console.warn('[CACHE] Failed to retrieve stored events:', error);
            return [];
        }
    }

    async getStoredEventsIndexedDB() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('timestamp');

            // Get events from last 24 hours
            const cutoff = Date.now() - this.retentionPeriod;
            const range = IDBKeyRange.lowerBound(cutoff);
            const request = index.getAll(range);

            request.onsuccess = () => {
                const events = request.result || [];
                console.log(`[CACHE] Retrieved ${events.length} events from IndexedDB`);
                resolve(events);
            };
            request.onerror = () => reject(request.error);
        });
    }

    getStoredEventsLocalStorage() {
        const cache = JSON.parse(localStorage.getItem(this.localStorageKey) || '{"events":[]}');
        const cutoff = Date.now() - this.retentionPeriod;

        // Filter events within retention period
        const validEvents = cache.events.filter(event =>
            event.timestamp && event.timestamp > cutoff
        );

        console.log(`[CACHE] Retrieved ${validEvents.length} events from LocalStorage`);
        return validEvents;
    }

    async cleanup() {
        try {
            if (this.storageType === 'indexeddb') {
                await this.cleanupIndexedDB();
            } else {
                this.cleanupLocalStorage();
            }
        } catch (error) {
            console.warn('[CACHE] Cleanup failed:', error);
        }
    }

    async cleanupIndexedDB() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const index = store.index('timestamp');

            // Delete events older than retention period
            const cutoff = Date.now() - this.retentionPeriod;
            const range = IDBKeyRange.upperBound(cutoff);
            const request = index.openCursor(range);

            let deletedCount = 0;
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                } else {
                    if (deletedCount > 0) {
                        console.log(`[CACHE] Cleaned up ${deletedCount} old events from IndexedDB`);
                    }
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    cleanupLocalStorage() {
        const cache = JSON.parse(localStorage.getItem(this.localStorageKey) || '{"events":[]}');
        const cutoff = Date.now() - this.retentionPeriod;
        const originalCount = cache.events.length;

        // Keep only events within retention period
        cache.events = cache.events.filter(event =>
            event.timestamp && event.timestamp > cutoff
        );

        // Limit total events for performance
        if (cache.events.length > this.maxEvents) {
            cache.events = cache.events.slice(-this.maxEvents);
        }

        cache.lastCleanup = Date.now();
        localStorage.setItem(this.localStorageKey, JSON.stringify(cache));

        const deletedCount = originalCount - cache.events.length;
        if (deletedCount > 0) {
            console.log(`[CACHE] Cleaned up ${deletedCount} old events from LocalStorage`);
        }
    }

    async getStatistics() {
        const events = await this.getStoredEvents();
        return {
            totalEvents: events.length,
            storageType: this.storageType,
            oldestEvent: events.length > 0 ? Math.min(...events.map(e => e.timestamp)) : null,
            newestEvent: events.length > 0 ? Math.max(...events.map(e => e.timestamp)) : null,
            retentionPeriod: this.retentionPeriod
        };
    }

    async clearCache() {
        console.log('[CACHE] Clearing all cached data...');
        try {
            if (this.storageType === 'indexeddb') {
                await this.clearCacheIndexedDB();
            } else {
                this.clearCacheLocalStorage();
            }
            console.log('[CACHE] Cache cleared successfully');
        } catch (error) {
            console.error('[CACHE] Failed to clear cache:', error);
            throw error;
        }
    }

    async clearCacheIndexedDB() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();

            request.onsuccess = () => {
                console.log('[CACHE] IndexedDB cache cleared');
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    clearCacheLocalStorage() {
        const emptyCache = {
            events: [],
            lastCleanup: Date.now(),
            version: 1
        };
        localStorage.setItem(this.localStorageKey, JSON.stringify(emptyCache));
        console.log('[CACHE] LocalStorage cache cleared');
    }
}

class AttackMapDashboard {
    constructor() {
        this.charts = {};
        this.theme = localStorage.getItem('theme') || 'dark';
        this.panelCollapsed = localStorage.getItem('sidePanelCollapsed') === 'true' || false;
        this.bottomPanelHeight = parseInt(localStorage.getItem('bottomPanelHeight')) || 350;
        this.activeTab = 'live-feed';
        this.searchFilters = {};
        this.settings = this.loadSettings();
        this.attackHistory = [];
        this.protocolStats = {};
        this.countryStats = {};
        this.timelineInterval = '24h'; // Default to 24 hours
        this.timelineData = this.initializeTimelineData(); // Add timeline data structure
        this.lastTimelineUpdate = Date.now(); // Track last update time
        this.connectionStatus = 'connecting'; // Track current connection status

        // Honeypot Performance Tracking
        this.honeypotStats = {
            data: new Map(), // Map to store honeypot stats
            retention: 15 * 60 * 1000, // 15 minutes in milliseconds
            updateInterval: 60000, // Update chart every minute
            lastCleanup: Date.now()
        };

        // Initialize attack cache system
        this.attackCache = new AttackCache();
        this.cacheInitialized = false;
        this.restoringFromCache = false;

        this.init();
    }

    async init() {
        this.initTheme();
        this.initEventListeners();
        this.initCharts();
        this.initThreatHeatmap();
        this.initPanels();
        this.initTabs();
        this.initSearch();
        this.initSettings();
        this.initSoundSystem();
        this.initHoneypotTracking();

        // Initialize cache system
        await this.initializeCache();

        this.hideLoadingScreen();

        // Start background tasks
        this.startPerformanceMonitoring();
        this.startDataAggregation();
        this.startConnectionStatusMonitoring();
    }

    async initializeCache() {
        try {
            await this.attackCache.init();
            this.cacheInitialized = true;

            // Update cache status UI
            this.updateCacheStatus();

            // Try to restore data from cache
            await this.restoreFromCache();

            console.log('[DASHBOARD] Cache system initialized successfully');
        } catch (error) {
            console.error('[DASHBOARD] Failed to initialize cache:', error);
            this.cacheInitialized = false;
            this.updateCacheStatus('error');
        }
    }

    updateCacheStatus(status = null) {
        const cacheStatus = document.getElementById('cache-status');
        const cacheIndicator = document.getElementById('cache-indicator');
        const cacheText = document.getElementById('cache-text');

        if (!cacheStatus || !cacheIndicator || !cacheText) return;

        if (!this.cacheInitialized || status === 'error') {
            cacheStatus.style.display = 'none';
            return;
        }

        // Show cache status
        cacheStatus.style.display = 'flex';

        // Set status based on cache state
        if (status === 'restoring') {
            cacheIndicator.className = 'status-indicator connecting';
            cacheText.textContent = 'Restoring...';
            cacheStatus.title = 'Restoring data from cache';
        } else {
            cacheIndicator.className = 'status-indicator cached';
            cacheText.textContent = 'Cached';

            // Update tooltip with cache info
            this.attackCache.getStatistics().then(stats => {
                const storageType = stats.storageType === 'indexeddb' ? 'IndexedDB' : 'LocalStorage';
                cacheStatus.title = `${stats.totalEvents} events cached (${storageType})`;
            }).catch(() => {
                cacheStatus.title = 'Data cache active';
            });
        }

        // Add click handler to show cache details
        cacheStatus.onclick = () => this.showCacheDetails();
    }

    async showCacheDetails() {
        try {
            const stats = await this.attackCache.getStatistics();
            const storageType = stats.storageType === 'indexeddb' ? 'IndexedDB' : 'LocalStorage';
            const oldestDate = stats.oldestEvent ? new Date(stats.oldestEvent).toLocaleString() : 'None';
            const newestDate = stats.newestEvent ? new Date(stats.newestEvent).toLocaleString() : 'None';

            const message = `
Cache Statistics:
• Storage: ${storageType}
• Events: ${stats.totalEvents}
• Oldest: ${oldestDate}
• Newest: ${newestDate}
• Retention: 24 hours
            `;

            this.showNotification(message.trim(), 'info', 'cache');
        } catch (error) {
            console.error('[CACHE] Failed to get statistics:', error);
            this.showNotification('Failed to get cache statistics', 'error', 'cache');
        }
    }

    async restoreFromCache() {
        console.log('[DASHBOARD] Attempting to restore data from cache...');
        this.restoringFromCache = true;
        this.updateCacheStatus('restoring');

        try {
            const cachedEvents = await this.attackCache.getStoredEvents();
            const stats = await this.attackCache.getStatistics();

            console.log(`[DASHBOARD] Found ${cachedEvents.length} cached events (${stats.storageType})`);

            if (cachedEvents.length > 0) {
                // Sort events by timestamp (oldest first)
                cachedEvents.sort((a, b) => a.timestamp - b.timestamp);

                // Restore all cached events for complete statistics
                this.attackHistory = cachedEvents.map(event => ({
                    ...event,
                    restored: true // Mark as restored for debugging
                }));

                // Process events in chunks to prevent UI blocking
                const BATCH_SIZE = 500;
                let processedCount = 0;

                const processBatch = () => {
                    const end = Math.min(processedCount + BATCH_SIZE, cachedEvents.length);

                    // Process a batch of events
                    for (let i = processedCount; i < end; i++) {
                        const event = cachedEvents[i];

                        // Process for timeline
                        this.addAttackToTimeline(event, false); // false = don't trigger updates

                        // Process for heatmap
                        this.addAttackToHeatmap(event, false);

                        // Process for honeypot tracking
                        if (event.honeypot) {
                            this.trackHoneypotAttack(event.honeypot, event.timestamp, false);
                        }

                        // Update tracking data (needed for top IPs and top countries)
                        this.updateIPTracking(event.ip || event.source_ip, event.country, event);
                        this.updateCountryTracking(event.country, event);
                        this.updateProtocolStats(event.protocol);
                    }

                    processedCount = end;

                    if (processedCount < cachedEvents.length) {
                        // Schedule next batch
                        requestAnimationFrame(processBatch);
                    } else {
                        // All batches complete - finalize restoration
                        this.finalizeRestoration(cachedEvents, stats);
                    }
                };

                // Start processing batches
                processBatch();
            } else {
                console.log('[DASHBOARD] No cached events found');
                this.restoringFromCache = false;
                this.updateCacheStatus();
            }
        } catch (error) {
            console.error('[DASHBOARD] Failed to restore from cache:', error);
            this.showNotification('Failed to restore cached data', 'error', 'cache');
            this.restoringFromCache = false;
            this.updateCacheStatus();
        }
    }

    finalizeRestoration(cachedEvents, stats) {
        try {
            // Restore map markers
            // We need to find the last 200 UNIQUE locations to match the map's visual limit.
            const mapEvents = [];
            const uniqueLocations = new Set();
            const MAX_MAP_CIRCLES = 200;

            // Iterate backwards to find the most recent unique locations
            for (let i = cachedEvents.length - 1; i >= 0; i--) {
                const event = cachedEvents[i];
                // Use coordinates as key if available, otherwise fallback to IP
                const key = (event.source_lat && event.source_lng)
                    ? `${event.source_lat},${event.source_lng}`
                    : (event.source_ip || event.ip);

                if (key) {
                    if (uniqueLocations.size < MAX_MAP_CIRCLES || uniqueLocations.has(key)) {
                        mapEvents.push(event);
                        uniqueLocations.add(key);
                    }
                }
            }

            // Reverse to restore chronological order (oldest to newest)
            mapEvents.reverse();

            console.log(`[DASHBOARD] Restoring ${mapEvents.length} events covering ${uniqueLocations.size} unique locations`);

            for (const event of mapEvents) {
                if (typeof window.processRestoredAttack === 'function') {
                    window.processRestoredAttack(event);
                }
            }

            // Restore live feed (last 100 events, newest first)
            const liveFeedEvents = cachedEvents.slice(-100);
            for (const event of liveFeedEvents) {
                this.addToAttackTable(event, false);
            }

            // Update all visualizations with restored data
            this.aggregateProtocolStats();
            this.aggregateCountryStats();
            this.updateTimelineChart();
            this.updateHoneypotChartData();
            this.updateThreatHeatmap();
            this.updateDashboardMetrics();

            // Update tables with aggregated data
            this.updateTopIPsTable();
            this.updateTopCountriesTable();

            console.log(`[DASHBOARD] Successfully restored ${cachedEvents.length} events from cache`);

            // Show restoration notification
            this.showNotification(
                `Restored ${cachedEvents.length} events from cache (${this.formatTimeAgo(stats.oldestEvent)})`,
                'success',
                'cache'
            );
        } catch (error) {
            console.error('[DASHBOARD] Error during final restoration steps:', error);
        } finally {
            this.restoringFromCache = false;
            this.updateCacheStatus();
        }
    }

    formatTimeAgo(timestamp) {
        if (!timestamp) return 'unknown';

        const now = Date.now();
        const diff = now - timestamp;
        const minutes = Math.floor(diff / (1000 * 60));
        const hours = Math.floor(diff / (1000 * 60 * 60));

        if (hours > 0) {
            return `${hours}h ago`;
        } else if (minutes > 0) {
            return `${minutes}m ago`;
        } else {
            return 'just now';
        }
    }
    getProtocolColor(protocol, port = null) {
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

        const protocolUpper = protocol?.toUpperCase();

        // Return predefined color for known protocols
        if (colors[protocolUpper]) {
            return colors[protocolUpper];
        }

        // Fallback for unknown protocols - should use OTHER color for consistency
        return colors['OTHER'];  // Use OTHER color (#78909C) for unknown protocols
    }

    // Normalize protocol names to known protocols or "OTHER"
    normalizeProtocol(protocol) {
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

    // Initialize timeline data structure for different intervals
    initializeTimelineData() {
        return this.generateTimelineData(this.timelineInterval);
    }

    // Generate timeline data based on interval
    generateTimelineData(interval) {
        const timeline = [];
        const now = new Date();
        let points, duration, unit;

        switch (interval) {
            case '1m':
                points = 60; // 60 seconds
                duration = 1000; // 1 second
                unit = 'second';
                break;
            case '1h':
                points = 60; // 60 minutes
                duration = 60 * 1000; // 1 minute
                unit = 'minute';
                break;
            case '24h':
            default:
                points = 24; // 24 hours
                duration = 60 * 60 * 1000; // 1 hour
                unit = 'hour';
                break;
        }

        // Create data points for the specified interval
        for (let i = points - 1; i >= 0; i--) {
            const time = new Date(now.getTime() - i * duration);
            let label, timestamp;

            switch (interval) {
                case '1m':
                    label = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    timestamp = Math.floor(time.getTime() / 1000) * 1000; // Round to second
                    break;
                case '1h':
                    label = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    timestamp = Math.floor(time.getTime() / (60 * 1000)) * (60 * 1000); // Round to minute
                    break;
                case '24h':
                default:
                    label = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    timestamp = Math.floor(time.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000); // Round to hour
                    break;
            }

            timeline.push({
                timestamp: timestamp,
                label: label,
                count: 0, // Initialize with zero, will be populated with real data
                unit: unit
            });
        }

        return timeline;
    }

    // Populate timeline with real attack data from history
    populateTimelineFromHistory() {
        if (!this.attackHistory.length) {
            console.log(`[DEBUG] No attack history available for timeline population`);
            return;
        }

        console.log(`[DEBUG] Populating timeline (${this.timelineInterval}) from ${this.attackHistory.length} attacks`);

        // Reset counts
        this.timelineData.forEach(point => {
            point.count = 0;
        });

        let attacksInRange = 0;

        // Count attacks in each time bucket
        this.attackHistory.forEach(attack => {
            const attackTime = new Date(attack.timestamp || attack.time || attack.date || Date.now());

            // Find the appropriate timeline bucket
            this.timelineData.forEach(point => {
                const pointTime = new Date(point.timestamp);
                const duration = this.getDurationForInterval();
                const pointEndTime = new Date(pointTime.getTime() + duration);

                // Check if attack falls within this time bucket
                if (attackTime >= pointTime && attackTime < pointEndTime) {
                    point.count++;
                    attacksInRange++;
                }
            });
        });

        console.log(`[DEBUG] Timeline populated: ${attacksInRange} attacks in range, counts:`, this.timelineData.map(p => p.count));
        this.updateTimelineChart();
    }

    // Get duration in milliseconds for current interval
    getDurationForInterval() {
        switch (this.timelineInterval) {
            case '1m': return 1000; // 1 second
            case '1h': return 60 * 1000; // 1 minute
            case '24h':
            default: return 60 * 60 * 1000; // 1 hour
        }
    }

    // Add new attack to timeline data
    addAttackToTimeline(attack, triggerUpdate = true) {
        const attackTime = new Date(attack.timestamp || attack.time || attack.date || Date.now());
        const duration = this.getDurationForInterval();
        let attackAdded = false;

        // Try to find existing time bucket that contains this attack
        for (let i = 0; i < this.timelineData.length; i++) {
            const point = this.timelineData[i];
            const pointTime = new Date(point.timestamp);
            const pointEndTime = new Date(pointTime.getTime() + duration);

            // Check if attack falls within this time bucket
            if (attackTime >= pointTime && attackTime < pointEndTime) {
                point.count++;
                attackAdded = true;
                console.log(`[DEBUG] Added attack to existing bucket ${i}: ${point.label}, new count: ${point.count}`);
                break;
            }
        }

        // If attack doesn't fit in any existing bucket, check if we need to add new buckets
        if (!attackAdded) {
            const lastPoint = this.timelineData[this.timelineData.length - 1];
            const lastPointTime = new Date(lastPoint.timestamp);
            const lastPointEndTime = new Date(lastPointTime.getTime() + duration);

            // If attack is after the last bucket, add new bucket(s)
            if (attackTime >= lastPointEndTime) {
                let currentTime = lastPointEndTime;

                // Add buckets until we reach the attack time
                while (currentTime <= attackTime) {
                    const bucketStartTime = new Date(Math.floor(currentTime.getTime() / duration) * duration);
                    const isAttackBucket = attackTime >= bucketStartTime && attackTime < new Date(bucketStartTime.getTime() + duration);

                    const newPoint = {
                        timestamp: bucketStartTime.getTime(),
                        label: this.formatTimeLabel(bucketStartTime),
                        count: isAttackBucket ? 1 : 0,
                        unit: this.getUnitForInterval()
                    };

                    // Remove oldest point and add new one
                    this.timelineData.shift();
                    this.timelineData.push(newPoint);

                    if (isAttackBucket) {
                        attackAdded = true;
                        console.log(`[DEBUG] Added attack to new bucket: ${newPoint.label}, count: 1`);
                        break;
                    }

                    currentTime = new Date(currentTime.getTime() + duration);
                }
            } else {
                console.log(`[DEBUG] Attack is too old to fit in current timeline window`);
            }
        }

        if (attackAdded && triggerUpdate) {
            this.updateTimelineChart();
        }
    }

    // Helper to format time labels
    formatTimeLabel(time) {
        switch (this.timelineInterval) {
            case '1m':
                return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            case '1h':
            case '24h':
            default:
                return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    }

    // Helper to get unit for interval
    getUnitForInterval() {
        switch (this.timelineInterval) {
            case '1m': return 'second';
            case '1h': return 'minute';
            case '24h':
            default: return 'hour';
        }
    }

    // Update timeline chart with current data
    updateTimelineChart() {
        if (!this.charts.timeline) return;

        const labels = this.timelineData.map(point => point.label);
        const data = this.timelineData.map(point => point.count);

        this.charts.timeline.data.labels = labels;
        this.charts.timeline.data.datasets[0].data = data;
        this.charts.timeline.update('none'); // Use 'none' mode for better performance
    }

    // Convert HSL to RGB
    hslToRgb(h, s, l) {
        let r, g, b;

        if (s === 0) {
            r = g = b = l; // achromatic
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }

        return [r * 255, g * 255, b * 255];
    }

    // Convert hex color to RGB
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    // Theme Management
    initTheme() {
        document.documentElement.setAttribute('data-theme', this.theme);
        this.updateThemeIcon();
    }

    toggleTheme() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', this.theme);
        localStorage.setItem('theme', this.theme);
        this.updateThemeIcon();
        this.updateChartsTheme();

        // Update map theme if the function exists
        if (typeof updateMapTheme === 'function') {
            updateMapTheme(this.theme);
        }
    }

    updateThemeIcon() {
        const icon = document.querySelector('#theme-toggle i');
        if (icon) {
            icon.className = this.theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        }
    }

    // Event Listeners
    initEventListeners() {
        // Theme toggle
        document.getElementById('theme-toggle')?.addEventListener('click', () => {
            this.toggleTheme();
        });

        // Fullscreen toggle
        document.getElementById('fullscreen-toggle')?.addEventListener('click', () => {
            this.toggleFullscreen();
        });

        // Settings modal
        document.getElementById('settings-toggle')?.addEventListener('click', () => {
            this.openSettings();
        });

        document.getElementById('settings-close')?.addEventListener('click', () => {
            this.closeSettings();
        });

        // Panel controls
        document.getElementById('panel-toggle')?.addEventListener('click', () => {
            this.toggleSidePanel();
        });

        // Panel resizing
        this.initPanelResize();

        // Settings
        document.getElementById('save-settings')?.addEventListener('click', () => {
            this.saveSettings();
        });

        document.getElementById('reset-settings')?.addEventListener('click', () => {
            this.resetSettings();
        });

        document.getElementById('clear-cache')?.addEventListener('click', () => {
            this.clearCache();
        });

        // Timeline interval selector
        document.getElementById('timeline-interval')?.addEventListener('change', (e) => {
            this.changeTimelineInterval(e.target.value);
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            this.handleKeyboardShortcuts(e);
        });

        // Window resize
        window.addEventListener('resize', () => {
            this.handleWindowResize();
        });
    }

    // Panel Management
    initPanels() {
        this.updatePanelStates();
        this.initPanelResize();
        this.updateSidePanelHeight(); // Initial side panel height setup

        // Apply saved side panel state
        this.applySidePanelState();
    }

    toggleSidePanel() {
        this.panelCollapsed = !this.panelCollapsed;

        // Save the panel state to localStorage
        localStorage.setItem('sidePanelCollapsed', this.panelCollapsed.toString());

        const panel = document.getElementById('side-panel');
        if (panel) {
            panel.classList.toggle('collapsed', this.panelCollapsed);
        }
        this.updateMapSize();
    }

    applySidePanelState() {
        const panel = document.getElementById('side-panel');
        if (panel && this.panelCollapsed) {
            panel.classList.add('collapsed');
        }
    }

    initPanelResize() {
        const resizeHandle = document.getElementById('panel-resize');
        const bottomPanel = document.getElementById('bottom-panel');

        if (!resizeHandle || !bottomPanel) return;

        let isResizing = false;
        let startY = 0;
        let startHeight = 0;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startY = e.clientY;
            startHeight = this.bottomPanelHeight;
            document.body.style.cursor = 'ns-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const deltaY = startY - e.clientY;
            const newHeight = Math.max(200, Math.min(600, startHeight + deltaY));

            this.bottomPanelHeight = newHeight;
            localStorage.setItem('bottomPanelHeight', newHeight.toString());
            bottomPanel.style.height = `${newHeight}px`;
            this.updateMapSize(); // This will also update side panel height
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
            }
        });
    }

    updatePanelStates() {
        const bottomPanel = document.getElementById('bottom-panel');
        if (bottomPanel) {
            bottomPanel.style.height = `${this.bottomPanelHeight}px`;
        }
        this.updateMapSize();
    }

    updateMapSize() {
        // Update side panel height based on bottom panel position
        this.updateSidePanelHeight();

        // Trigger map resize if needed
        if (window.map) {
            setTimeout(() => {
                window.map.invalidateSize();
            }, 300);
        }
    }

    updateSidePanelHeight() {
        const sidePanel = document.getElementById('side-panel');
        const bottomPanel = document.getElementById('bottom-panel');

        if (sidePanel && bottomPanel) {
            // Calculate available height: viewport height - navbar height - bottom panel height
            const navbarHeight = 70; // Top navbar height
            const bottomPanelHeight = this.bottomPanelHeight || 350;
            const availableHeight = window.innerHeight - navbarHeight - bottomPanelHeight;

            sidePanel.style.height = `${Math.max(200, availableHeight)}px`;
        }
    }

    // Tab Management
    initTabs() {
        const tabButtons = document.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.getAttribute('data-tab');
                this.switchTab(tabName);
            });
        });

        // Activate the default tab (live-feed)
        this.switchTab(this.activeTab);
    }

    switchTab(tabName) {
        // Update active tab
        this.activeTab = tabName;

        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
        });

        // Hide all tab panes first
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.remove('active');
            pane.style.display = 'none';
        });

        // Show the selected tab pane
        const targetTab = document.getElementById(`${tabName}-tab`);
        if (targetTab) {
            targetTab.classList.add('active');
            targetTab.style.display = 'block';
        }

        // Load tab-specific data
        this.loadTabData(tabName);

        // Resize charts if needed
        setTimeout(() => {
            this.resizeCharts();
        }, 100);
    }

    loadTabData(tabName) {
        switch (tabName) {
            case 'overview':
                this.updateOverviewCharts();
                break;
            case 'top-ips':
                this.updateTopIPsTable();
                break;
            case 'countries':
                this.updateTopCountriesTable();
                break;
            case 'live-feed':
                this.updateLiveFeed();
                break;
        }
    }

    // Chart Management
    initCharts() {
        // Initialize charts with a slight delay to ensure containers are properly sized
        setTimeout(() => {
            this.initAttackDistributionChart();
            this.initTimelineChart();
            this.initProtocolChart();
            this.initHoneypotChart();

            // Populate timeline and heatmap with any existing attack history
            setTimeout(() => {
                this.populateTimelineFromHistory();
                this.populateHeatmapFromHistory();
            }, 200);

            // Force a resize after initialization
            setTimeout(() => {
                this.resizeCharts();
            }, 100);
        }, 50);
    }

    // Handle timeline interval change
    changeTimelineInterval(newInterval) {
        console.log(`[DEBUG] Changing timeline interval from ${this.timelineInterval} to ${newInterval}`);

        this.timelineInterval = newInterval;
        this.timelineData = this.generateTimelineData(newInterval);

        // Populate the new timeline with existing attack history
        this.populateTimelineFromHistory();

        // Reinitialize the timeline chart with new data
        this.initTimelineChart();

        // Restart timeline updates with new frequency
        this.startTimelineUpdates();

        console.log(`[DEBUG] Timeline interval changed to ${newInterval}, data points: ${this.timelineData.length}`);
    }

    // Update timeline chart title based on interval
    updateTimelineChartTitle() {
        const titleMap = {
            '1m': 'Attacks per Second (Last Minute)',
            '1h': 'Attacks per Minute (Last Hour)',
            '24h': 'Attacks per Hour (Last 24 Hours)'
        };

        if (this.charts.timeline && this.charts.timeline.options.plugins.legend) {
            this.charts.timeline.data.datasets[0].label = titleMap[this.timelineInterval] || 'Attacks';
            this.charts.timeline.options.scales.x.title.text = this.getTimelineXAxisTitle();
            this.charts.timeline.options.scales.y.title.text = 'Attack Count';
            this.charts.timeline.update();
        }
    }

    // Get X-axis title based on interval
    getTimelineXAxisTitle() {
        const titleMap = {
            '1m': 'Time (Last Minute)',
            '1h': 'Time (Last Hour)',
            '24h': 'Time (Last 24 Hours)'
        };
        return titleMap[this.timelineInterval] || 'Time';
    }

    initAttackDistributionChart() {
        const ctx = document.getElementById('attack-distribution-chart');
        if (!ctx) return;

        const labels = ['SSH', 'HTTP', 'FTP', 'TELNET', 'OTHER'];
        const colors = labels.map(protocol => {
            if (protocol === 'OTHER') {
                return this.getProtocolColor(protocol, 8080); // Default port for initial display
            }
            return this.getProtocolColor(protocol);
        });

        this.charts.attackDistribution = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: [30, 25, 15, 10, 20],
                    backgroundColor: colors,
                    borderWidth: 2,
                    borderColor: colors
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: {
                    padding: {
                        top: 10,
                        bottom: 10,
                        left: 10,
                        right: 10
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: '#b0b0b0',
                            usePointStyle: true,
                            padding: 10,
                            boxWidth: 12,
                            font: {
                                size: 11
                            }
                        }
                    }
                },
                elements: {
                    arc: {
                        borderWidth: 2
                    }
                },
                cutout: '60%'
            }
        });

        // Ensure proper sizing after chart creation
        setTimeout(() => {
            if (this.charts.attackDistribution) {
                this.charts.attackDistribution.resize();
            }
        }, 100);
    }

    initTimelineChart() {
        const ctx = document.getElementById('timeline-chart');
        if (!ctx) return;

        // Destroy existing chart if it exists
        if (this.charts.timeline) {
            this.charts.timeline.destroy();
        }

        // Use the structured timeline data
        const labels = this.timelineData.map(point => point.label);
        const data = this.timelineData.map(point => point.count);

        // Get dynamic titles based on current interval
        const datasetLabel = this.getDatasetLabel();
        const xAxisTitle = this.getTimelineXAxisTitle();

        this.charts.timeline = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: datasetLabel,
                    data: data,
                    borderColor: '#e20074',
                    backgroundColor: 'rgba(226, 0, 116, 0.1)',
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        ticks: {
                            color: '#b0b0b0',
                            maxTicksLimit: this.getMaxTicks()
                        },
                        grid: { color: '#333' },
                        title: {
                            display: false
                        }
                    },
                    y: {
                        ticks: { color: '#b0b0b0' },
                        grid: { color: '#333' },
                        title: {
                            display: false
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        align: 'center',
                        labels: {
                            color: '#b0b0b0',
                            usePointStyle: true,
                            padding: 15,
                            font: {
                                size: 11
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return `Attacks: ${context.parsed.y}`;
                            }
                        }
                    }
                },
                animation: {
                    duration: this.timelineInterval === '1m' ? 0 : 750
                },
                transitions: {
                    active: {
                        animation: {
                            duration: this.timelineInterval === '1m' ? 0 : 400
                        }
                    }
                }
            }
        });
    }

    // Get dataset label based on current interval
    getDatasetLabel() {
        const labelMap = {
            '1m': 'Attacks per Second',
            '1h': 'Attacks per Minute',
            '24h': 'Attacks per Hour'
        };
        return labelMap[this.timelineInterval] || 'Attacks';
    }

    // Get max ticks for X-axis based on interval
    getMaxTicks() {
        const tickMap = {
            '1m': 6,   // Show every 10 seconds (fewer ticks for longer HH:MM:SS labels)
            '1h': 12,  // Show every 5 minutes
            '24h': 12  // Show every 2 hours
        };
        return tickMap[this.timelineInterval] || 12;
    }

    initProtocolChart() {
        const ctx = document.getElementById('protocol-chart');
        if (!ctx) return;

        const labels = ['SSH', 'HTTP', 'FTP', 'TELNET', 'DNS', 'SMTP'];
        const colors = labels.map(protocol => this.getProtocolColor(protocol));
        const initialData = [45, 35, 20, 15, 10, 8];

        this.charts.protocol = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Attacks',
                    data: initialData.map(d => Math.sqrt(d)),
                    originalData: initialData,
                    backgroundColor: colors,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        ticks: { color: '#b0b0b0' },
                        grid: { display: false }
                    },
                    y: {
                        ticks: {
                            color: '#b0b0b0',
                            callback: function(value) {
                                return Math.round(Math.pow(value, 2));
                            }
                        },
                        grid: { color: '#333' }
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const raw = context.dataset.originalData ?
                                          context.dataset.originalData[context.dataIndex] :
                                          Math.round(Math.pow(context.raw, 2));
                                return context.dataset.label + ': ' + raw;
                            }
                        }
                    }
                }
            }
        });
    }

    initHoneypotChart() {
        const ctx = document.getElementById('honeypot-chart');
        if (!ctx) return;

        // Get theme colors - same as timeline chart
        const textColor = this.theme === 'dark' ? '#b0b0b0' : '#495057';
        const gridColor = this.theme === 'dark' ? '#333' : '#dee2e6';
        // Use same transparency as timeline chart
        const backgroundColor = 'rgba(226, 0, 116, 0.1)'; // Match timeline exactly

        this.charts.honeypot = new Chart(ctx, {
            type: 'radar',
            data: {
                labels: ['No Data'],
                datasets: [{
                    label: 'Attacks (Last 15m)',
                    data: [0],
                    borderColor: '#e20074',
                    backgroundColor: backgroundColor, // Match timeline transparency
                    pointBackgroundColor: '#e20074',
                    pointBorderColor: '#e20074',
                    pointRadius: 4,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    r: {
                        beginAtZero: true,
                        ticks: {
                            display: false, // Remove attack count numbers for cleaner look
                            maxTicksLimit: 8 // Limit number of grid rings to prevent performance issues
                        },
                        grid: { color: gridColor },
                        pointLabels: {
                            color: textColor,
                            font: {
                                size: 10, // Slightly smaller to reduce crowding
                                weight: '400' // Normal weight for better readability
                            },
                            padding: 8, // Add padding to prevent overlapping
                            backdropColor: 'transparent' // Remove background
                        },
                        angleLines: {
                            color: gridColor
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        align: 'center',
                        labels: {
                            color: textColor, // Match timeline chart exactly
                            usePointStyle: true,
                            padding: 15,
                            font: {
                                size: 11
                            },
                            generateLabels: function(chart) {
                                const original = Chart.defaults.plugins.legend.labels.generateLabels;
                                const labels = original.call(this, chart);

                                // Customize legend to match timeline chart opacity and stroke
                                labels.forEach(label => {
                                    if (label.fillStyle) {
                                        // Use the same transparency as timeline chart
                                        label.fillStyle = 'rgba(226, 0, 116, 0.1)';
                                        label.strokeStyle = '#e20074';
                                        label.lineWidth = 1; // Match timeline chart default stroke width
                                    }
                                });

                                return labels;
                            }
                        }
                    },
                    tooltip: {
                        backgroundColor: this.theme === 'dark' ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.95)',
                        titleColor: textColor,
                        bodyColor: textColor,
                        borderColor: gridColor,
                        borderWidth: 1,
                        callbacks: {
                            label: function(context) {
                                const raw = context.dataset.originalData ?
                                          context.dataset.originalData[context.dataIndex] :
                                          Math.round(Math.pow(context.raw, 2));
                                return context.dataset.label + ': ' + raw;
                            }
                        }
                    }
                }
            }
        });

        // Don't call updateHoneypotChartData here - let it be called when real data arrives
    }

    // Honeypot Performance Tracking System
    initHoneypotTracking() {
        // Start periodic cleanup of old data
        setInterval(() => {
            this.cleanupOldHoneypotData();
        }, 5 * 60 * 1000); // Clean up every 5 minutes

        // Honeypot chart updates will be synchronized with timeline updates
        // No separate interval needed - updates happen in addAttackEvent and startDataAggregation

        console.log('[DEBUG] Honeypot performance tracking initialized');
    }

    trackHoneypotAttack(honeypot, timestamp = Date.now(), triggerUpdate = true) {
        if (!honeypot || typeof honeypot !== 'string') {
            console.warn('[DEBUG] Invalid honeypot data:', honeypot);
            return;
        }

        // Clean honeypot name (remove any whitespace/special chars)
        honeypot = honeypot.trim();

        // Get or create honeypot entry
        if (!this.honeypotStats.data.has(honeypot)) {
            this.honeypotStats.data.set(honeypot, []);
            console.log(`[DEBUG] New honeypot discovered: ${honeypot}`);
        }

        // Add timestamp to honeypot's attack history
        this.honeypotStats.data.get(honeypot).push(timestamp);

        // Immediately clean old data for this honeypot
        this.cleanupHoneypotData(honeypot);

        const currentStats = this.honeypotStats.data.get(honeypot);
        if (currentStats) {
            console.log(`[DEBUG] Tracked attack for honeypot: ${honeypot} (${currentStats.length} total attacks)`);
        } else {
            console.log(`[DEBUG] Tracked attack for honeypot: ${honeypot} (expired/cleaned up)`);
        }
    }

    cleanupOldHoneypotData() {
        const cutoff = Date.now() - this.honeypotStats.retention;

        for (const [honeypot, timestamps] of this.honeypotStats.data.entries()) {
            this.cleanupHoneypotData(honeypot, cutoff);
        }

        this.honeypotStats.lastCleanup = Date.now();
    }

    cleanupHoneypotData(honeypot, cutoff = null) {
        if (!cutoff) {
            cutoff = Date.now() - this.honeypotStats.retention;
        }

        const timestamps = this.honeypotStats.data.get(honeypot);
        if (!timestamps) return;

        // Filter out old timestamps
        const filtered = timestamps.filter(ts => ts > cutoff);

        if (filtered.length === 0) {
            // Remove honeypot if no recent attacks
            this.honeypotStats.data.delete(honeypot);
        } else {
            this.honeypotStats.data.set(honeypot, filtered);
        }
    }

    getHoneypotStats() {
        const stats = {};

        for (const [honeypot, timestamps] of this.honeypotStats.data.entries()) {
            stats[honeypot] = timestamps.length;
        }

        return stats;
    }

    updateHoneypotChartData() {
        if (!this.charts.honeypot) return;

        const stats = this.getHoneypotStats();
        const honeypots = Object.keys(stats).sort();
        const counts = honeypots.map(hp => stats[hp]);

        // Handle no data case
        if (honeypots.length === 0) {
            this.charts.honeypot.data.labels = ['No Data'];
            this.charts.honeypot.data.datasets[0].data = [0];
            this.charts.honeypot.data.datasets[0].originalData = [0];
        } else {
            // Update chart data with real honeypot data
            this.charts.honeypot.data.labels = honeypots;
            this.charts.honeypot.data.datasets[0].data = counts.map(c => Math.sqrt(c));
            this.charts.honeypot.data.datasets[0].originalData = counts;
        }

        // Update chart
        this.charts.honeypot.update('none'); // No animation for performance

    }

    // Public method to be called from map.js when processing attacks
    processAttackForDashboard(attackData) {
        if (!attackData) return;

        // Track honeypot attack if honeypot field is present
        if (attackData.honeypot) {
            this.trackHoneypotAttack(attackData.honeypot, attackData.timestamp || Date.now());
        }

        // Add to attack history for other dashboard features
        this.attackHistory.push({
            ...attackData,
            timestamp: attackData.timestamp || Date.now()
        });

        // Keep attack history within reasonable bounds (match cache size)
        if (this.attackHistory.length > this.attackCache.maxEvents) {
            this.attackHistory = this.attackHistory.slice(-this.attackCache.maxEvents);
        }
    }

    updateChartsTheme() {
        const textColor = this.theme === 'dark' ? '#b0b0b0' : '#495057';
        const gridColor = this.theme === 'dark' ? '#333' : '#dee2e6';

        Object.values(this.charts).forEach(chart => {
            if (chart && chart.options) {
                // Update text colors
                if (chart.options.scales) {
                    Object.values(chart.options.scales).forEach(scale => {
                        if (scale.ticks) {
                            scale.ticks.color = textColor;
                            scale.ticks.backdropColor = 'transparent'; // Ensure transparent backdrop
                            scale.ticks.showLabelBackdrop = false;
                        }
                        if (scale.grid) scale.grid.color = gridColor;
                        if (scale.pointLabels) {
                            scale.pointLabels.color = textColor;
                            scale.pointLabels.backdropColor = 'transparent'; // Ensure transparent backdrop
                        }
                        if (scale.angleLines) scale.angleLines.color = gridColor;
                    });
                }

                // Update legend colors - all charts follow theme now
                if (chart.options.plugins && chart.options.plugins.legend) {
                    chart.options.plugins.legend.labels.color = textColor;
                }

                // Update tooltip colors for theme
                if (chart.options.plugins && chart.options.plugins.tooltip) {
                    chart.options.plugins.tooltip.backgroundColor = this.theme === 'dark' ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.95)';
                    chart.options.plugins.tooltip.titleColor = textColor;
                    chart.options.plugins.tooltip.bodyColor = textColor;
                    chart.options.plugins.tooltip.borderColor = gridColor;
                }

                // Update honeypot chart dataset colors to match timeline chart exactly
                if (chart === this.charts.honeypot && chart.data.datasets[0]) {
                    // Use same transparency as timeline chart (0.1) regardless of theme
                    const backgroundColor = 'rgba(226, 0, 116, 0.1)';
                    chart.data.datasets[0].backgroundColor = backgroundColor;
                }

                chart.update();
            }
        });
    }

    resizeCharts() {
        Object.values(this.charts).forEach(chart => {
            if (chart && chart.resize) {
                chart.resize();
            }
        });
    }

    // Search and Filtering
    initSearch() {
        const ipSearch = document.getElementById('ip-search');
        const countrySearch = document.getElementById('country-search');

        if (ipSearch) {
            ipSearch.addEventListener('input', (e) => {
                this.filterTable('ip', e.target.value);
            });
        }

        if (countrySearch) {
            countrySearch.addEventListener('input', (e) => {
                this.filterTable('country', e.target.value);
            });
        }
    }

    filterTable(type, query) {
        const tableId = type === 'ip' ? 'ip-tracking' : 'country-tracking';
        const tbody = document.getElementById(tableId);

        if (!tbody) return;

        const rows = tbody.querySelectorAll('tr');
        const searchTerm = query.toLowerCase();

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            let visible = false;

            cells.forEach(cell => {
                if (cell.textContent.toLowerCase().includes(searchTerm)) {
                    visible = true;
                }
            });

            row.style.display = visible ? '' : 'none';
        });
    }

    // Data Management
    updateOverviewCharts() {
        // Update charts with current data
        this.updateAttackDistribution();
        // Timeline is updated by its own interval
        this.updateProtocolBreakdown();

        // Update honeypot performance (now part of overview)
        this.updateHoneypotPerformance();
    }

    updateTopIPs() {
        // Update top IPs display
        console.log('[DEBUG] Updating top IPs display');
        // This could refresh the IP tracking table
    }

    updateCountries() {
        // Update countries display
        console.log('[DEBUG] Updating countries display');
        // This could refresh the country tracking table
    }

    updateLiveFeed() {
        // Update live feed display
        console.log('[DEBUG] Updating live feed display');
        // This could refresh the live attack feed
    }

    updateHoneypotPerformance() {
        // Force update of honeypot performance chart with latest data
        this.updateHoneypotChartData();
    }

    updateAttackDistribution() {
        if (this.charts.attackDistribution && this.protocolStats) {
            const data = Object.values(this.protocolStats);
            const labels = Object.keys(this.protocolStats);
            const colors = labels.map(protocol => {
                if (protocol?.toUpperCase() === 'OTHER') {
                    // Get the most common port for OTHER protocol
                    const port = this.getMostCommonOtherPort();
                    return this.getProtocolColor(protocol, port);
                }
                return this.getProtocolColor(protocol);
            });

            this.charts.attackDistribution.data.labels = labels;
            this.charts.attackDistribution.data.datasets[0].data = data;
            this.charts.attackDistribution.data.datasets[0].backgroundColor = colors;
            this.charts.attackDistribution.data.datasets[0].borderColor = colors;
            this.charts.attackDistribution.update();
        }
    }

    // Get the most common port for OTHER protocol attacks
    getMostCommonOtherPort() {
        const recent = this.attackHistory.filter(attack =>
            Date.now() - attack.timestamp < 300000 &&
            attack.protocol?.toUpperCase() === 'OTHER'
        );

        if (recent.length === 0) return null;

        // Count port frequencies
        const portCounts = recent.reduce((counts, attack) => {
            if (attack.dstPort) {
                counts[attack.dstPort] = (counts[attack.dstPort] || 0) + 1;
            }
            return counts;
        }, {});

        // Return the most frequent port
        const sortedPorts = Object.entries(portCounts)
            .sort(([,a], [,b]) => b - a);

        return sortedPorts.length > 0 ? parseInt(sortedPorts[0][0]) : null;
    }

    updateTimeline() {
        if (!this.charts.timeline) return;

        const now = Date.now();
        let currentUnit, lastDataPoint, shouldAddNewPoint = false;

        // Get the current time unit based on interval
        switch (this.timelineInterval) {
            case '1m':
                currentUnit = Math.floor(now / 1000); // Current second
                lastDataPoint = this.timelineData[this.timelineData.length - 1];
                const lastSecond = Math.floor(lastDataPoint.timestamp / 1000);
                shouldAddNewPoint = currentUnit > lastSecond;
                break;
            case '1h':
                currentUnit = Math.floor(now / (60 * 1000)); // Current minute
                lastDataPoint = this.timelineData[this.timelineData.length - 1];
                const lastMinute = Math.floor(lastDataPoint.timestamp / (60 * 1000));
                shouldAddNewPoint = currentUnit > lastMinute;
                break;
            case '24h':
            default:
                currentUnit = Math.floor(now / (60 * 60 * 1000)); // Current hour
                lastDataPoint = this.timelineData[this.timelineData.length - 1];
                const lastHour = Math.floor(lastDataPoint.timestamp / (60 * 60 * 1000));
                shouldAddNewPoint = currentUnit > lastHour;
                break;
        }

        if (shouldAddNewPoint) {
            // Add new time unit
            const newTime = new Date(now);
            let newTimestamp, newLabel;

            switch (this.timelineInterval) {
                case '1m':
                    newTimestamp = Math.floor(now / 1000) * 1000;
                    newLabel = newTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    break;
                case '1h':
                    newTimestamp = Math.floor(now / (60 * 1000)) * (60 * 1000);
                    newTime.setSeconds(0, 0);
                    newLabel = newTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    break;
                case '24h':
                default:
                    newTimestamp = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
                    newTime.setMinutes(0, 0, 0);
                    newLabel = newTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    break;
            }

            this.timelineData.push({
                timestamp: newTimestamp,
                label: newLabel,
                count: this.getAttackCountForInterval(),
                unit: this.timelineData[0]?.unit || 'hour'
            });

            // Remove oldest data point to maintain window size
            const maxPoints = this.timelineInterval === '1m' ? 60 : this.timelineInterval === '1h' ? 60 : 24;
            if (this.timelineData.length > maxPoints) {
                this.timelineData.shift();
            }

            // Update chart with new data
            const labels = this.timelineData.map(point => point.label);
            const data = this.timelineData.map(point => point.count);

            this.charts.timeline.data.labels = labels;
            this.charts.timeline.data.datasets[0].data = data;

            // Disable animation for 1-minute view to improve readability
            const updateMode = this.timelineInterval === '1m' ? 'none' : 'default';
            this.charts.timeline.update(updateMode);

            console.log(`[DEBUG] Timeline updated for ${this.timelineInterval}, new point added`);
        } else {
            // Update current time unit's count in real-time
            const currentCount = this.getAttackCountForCurrentInterval();
            if (currentCount !== lastDataPoint.count) {
                lastDataPoint.count = currentCount;

                // Update chart without animation for real-time feel
                this.charts.timeline.data.datasets[0].data[this.timelineData.length - 1] = currentCount;
                this.charts.timeline.update('none');
            }
        }
    }

    // Get attack count for the last complete interval
    getAttackCountForInterval() {
        let intervalMs, lookBackMs;

        switch (this.timelineInterval) {
            case '1m':
                intervalMs = 1000; // 1 second
                lookBackMs = 2000; // Look back 2 seconds
                break;
            case '1h':
                intervalMs = 60 * 1000; // 1 minute
                lookBackMs = 2 * 60 * 1000; // Look back 2 minutes
                break;
            case '24h':
            default:
                intervalMs = 60 * 60 * 1000; // 1 hour
                lookBackMs = 2 * 60 * 60 * 1000; // Look back 2 hours
                break;
        }

        const now = Date.now();
        const intervalStart = now - lookBackMs;
        const intervalEnd = now - intervalMs;

        return this.attackHistory.filter(attack =>
            attack.timestamp > intervalStart && attack.timestamp <= intervalEnd
        ).length;
    }

    // Get attack count for the current ongoing interval
    getAttackCountForCurrentInterval() {
        let intervalStart;
        const now = Date.now();

        switch (this.timelineInterval) {
            case '1m':
                intervalStart = Math.floor(now / 1000) * 1000; // Start of current second
                break;
            case '1h':
                intervalStart = Math.floor(now / (60 * 1000)) * (60 * 1000); // Start of current minute
                break;
            case '24h':
            default:
                intervalStart = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000); // Start of current hour
                break;
        }

        return this.attackHistory.filter(attack =>
            attack.timestamp >= intervalStart
        ).length;
    }

    updateProtocolBreakdown() {
        if (this.charts.protocol && this.protocolStats) {
            const data = Object.values(this.protocolStats);
            const labels = Object.keys(this.protocolStats);
            const colors = labels.map(protocol => this.getProtocolColor(protocol));

            this.charts.protocol.data.labels = labels;
            this.charts.protocol.data.datasets[0].data = data.map(d => Math.sqrt(d));
            this.charts.protocol.data.datasets[0].originalData = data;
            this.charts.protocol.data.datasets[0].backgroundColor = colors;
            this.charts.protocol.update();
        }
    }

    getRecentAttackCount() {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;

        return this.attackHistory.filter(attack =>
            attack.timestamp > oneMinuteAgo
        ).length;
    }

    // Settings Management
    initSettings() {
        this.loadSettingsUI();
    }

    loadSettings() {
        const defaultSettings = {
            soundAlerts: false,
            alertSound: 'beep'
        };

        const saved = localStorage.getItem('attack-map-settings');
        return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    }

    loadSettingsUI() {
        Object.keys(this.settings).forEach(key => {
            const element = document.getElementById(key.replace(/([A-Z])/g, '-$1').toLowerCase());
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = this.settings[key];
                } else {
                    element.value = this.settings[key];
                }
            }
        });

        // Apply settings after loading them into UI
        this.applySettings();
    }

    saveSettings() {
        const settings = {};

        // Collect all settings from UI
        ['sound-alerts', 'alert-sound'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                const key = id.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                settings[key] = element.type === 'checkbox' ? element.checked : element.value;
            }
        });

        this.settings = settings;
        localStorage.setItem('attack-map-settings', JSON.stringify(settings));
        this.applySettings();
        this.closeSettings();

        this.showNotification('Settings saved successfully', 'success', 'settings');
    }

    resetSettings() {
        localStorage.removeItem('attack-map-settings');
        localStorage.removeItem('sidePanelCollapsed');
        localStorage.removeItem('bottomPanelHeight');

        this.settings = this.loadSettings();

        // Reset panel states to defaults
        this.panelCollapsed = false;
        this.bottomPanelHeight = 350;

        // Apply the reset panel states
        const sidePanel = document.getElementById('side-panel');
        const bottomPanel = document.getElementById('bottom-panel');

        if (sidePanel) {
            sidePanel.classList.remove('collapsed');
        }

        if (bottomPanel) {
            bottomPanel.style.height = '350px';
        }

        this.loadSettingsUI();
        this.applySettings();
        this.updateMapSize(); // Update layout after reset

        // Show notification after layout updates to prevent position jumping
        setTimeout(() => {
            this.showNotification('Settings and panel states reset to default', 'info', 'settings');
        }, 50);
    }

    applySettings() {
        // Apply sound alert toggle visibility - use actual settings value, not just checkbox state
        const soundOptions = document.getElementById('sound-options');
        const soundAlerts = document.getElementById('sound-alerts');

        if (soundOptions && soundAlerts) {
            // Use the stored setting value to determine visibility
            soundOptions.style.display = this.settings.soundAlerts ? 'block' : 'none';
            // Ensure checkbox matches the setting
            soundAlerts.checked = this.settings.soundAlerts;
        }
    }

    async clearCache() {
        try {
            // Show confirmation dialog
            const confirmed = confirm('Are you sure you want to clear all cached data? This will reset the map markers and live feed. This action cannot be undone.');

            if (!confirmed) {
                return;
            }

            // Clear the attack cache
            if (this.attackCache) {
                await this.attackCache.clearCache();
            }

            // Clear map markers and data
            if (window.map) {
                // Clear Leaflet map layers
                if (window.circles) window.circles.clearLayers();
                if (window.markers) window.markers.clearLayers();
                if (window.attackLines) window.attackLines.clearLayers();

                // Clear map data objects
                if (window.circleAttackData) {
                    Object.keys(window.circleAttackData).forEach(key => {
                        delete window.circleAttackData[key];
                    });
                }
                if (window.markerAttackData) {
                    Object.keys(window.markerAttackData).forEach(key => {
                        delete window.markerAttackData[key];
                    });
                }
                if (window.circlesObject) {
                    Object.keys(window.circlesObject).forEach(key => {
                        delete window.circlesObject[key];
                    });
                }
                if (window.markersObject) {
                    Object.keys(window.markersObject).forEach(key => {
                        delete window.markersObject[key];
                    });
                }
            }

            // Clear dashboard tables and charts
            const liveFeedTable = document.getElementById('attack-tracking');
            if (liveFeedTable) {
                liveFeedTable.innerHTML = '';
            }

            // Clear data structures
            this.ipStats = {};
            this.countryStats = {};
            this.countryTrackingStats = {};
            this.protocolStats = {};
            this.attackHistory = [];

            // Reset Honeypot Stats
            if (this.honeypotStats && this.honeypotStats.data) {
                this.honeypotStats.data.clear();
            }

            // Reset Timeline Data
            this.timelineData = this.initializeTimelineData();

            // Update Tables
            this.updateTopIPsTable();
            this.updateTopCountriesTable();

            // Reset Charts

            // 1. Honeypot Chart
            if (this.charts.honeypot) {
                this.charts.honeypot.data.labels = ['No Data'];
                this.charts.honeypot.data.datasets[0].data = [0];
                if (this.charts.honeypot.data.datasets[0].originalData) {
                    this.charts.honeypot.data.datasets[0].originalData = [0];
                }
                this.charts.honeypot.update();
            }

            // 2. Protocol Chart
            if (this.charts.protocol) {
                this.charts.protocol.data.labels = [];
                this.charts.protocol.data.datasets[0].data = [];
                if (this.charts.protocol.data.datasets[0].originalData) {
                    this.charts.protocol.data.datasets[0].originalData = [];
                }
                this.charts.protocol.update();
            }

            // 3. Timeline Chart
            if (this.charts.timeline) {
                const labels = this.timelineData.map(d => d.label);
                const data = this.timelineData.map(d => d.count);
                this.charts.timeline.data.labels = labels;
                this.charts.timeline.data.datasets[0].data = data;
                this.charts.timeline.update();
            }

            // Reset attack statistics
            this.stats = {
                totalAttacks: 0,
                uniqueAttackers: 0,
                topCountries: [],
                topProtocols: [],
                recentActivity: []
            };

            // Update cache status indicator
            this.updateCacheStatus();

            this.showNotification('Cache cleared successfully', 'success', 'cache');

        } catch (error) {
            console.error('[ERROR] Failed to clear cache:', error);
            this.showNotification('Failed to clear cache', 'error', 'cache');
        }
    }

    initSoundSystem() {
        // Create audio context for sound alerts
        this.audioContext = null;
        this.soundBuffers = {};
        this.audioInitialized = false;

        // Add event listener for sound alerts checkbox
        const soundAlerts = document.getElementById('sound-alerts');
        if (soundAlerts) {
            soundAlerts.addEventListener('change', () => {
                // Update the settings object immediately
                this.settings.soundAlerts = soundAlerts.checked;
                // Save to localStorage
                localStorage.setItem('attack-map-settings', JSON.stringify(this.settings));
                // Apply visual changes
                this.applySettings();
                // Initialize audio when enabling sound
                if (soundAlerts.checked && !this.audioInitialized) {
                    this.initializeAudioContext();
                }
                // Show feedback notification
                this.showNotification(
                    `Sound alerts ${soundAlerts.checked ? 'enabled' : 'disabled'}`,
                    'success',
                    'sound'
                );
            });
        }

        // Add event listener for alert sound dropdown
        const alertSound = document.getElementById('alert-sound');
        if (alertSound) {
            alertSound.addEventListener('change', () => {
                // Update the settings object immediately
                this.settings.alertSound = alertSound.value;
                // Save to localStorage
                localStorage.setItem('attack-map-settings', JSON.stringify(this.settings));
                // Show feedback notification
                this.showNotification(
                    `Alert sound changed to ${alertSound.options[alertSound.selectedIndex].text}`,
                    'success',
                    'sound'
                );
            });
        }

        // Initialize audio context on various user interactions
        const initAudioOnInteraction = (event) => {
            if (!this.audioInitialized) {
                this.initializeAudioContext();
                console.log('[SOUND] Audio initialized on:', event.type);
                // Don't forcefully remove audio prompt - let it expire naturally after 5 seconds
            }
        };

        // Add listeners for user interaction - be more aggressive
        document.addEventListener('click', initAudioOnInteraction, { once: true });
        document.addEventListener('keydown', initAudioOnInteraction, { once: true });
        document.addEventListener('touchstart', initAudioOnInteraction, { once: true });

        // Also initialize on any interaction with main content areas
        const contentAreas = ['#map', '#dashboard', '#side-panel', '#bottom-panel'];
        contentAreas.forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.addEventListener('click', initAudioOnInteraction, { once: true });
                element.addEventListener('mouseover', initAudioOnInteraction, { once: true });
            }
        });

        // Show audio prompt if sound is enabled but not initialized
        this.showAudioPromptIfNeeded();

        this.loadSoundEffects();
    }

    showAudioPromptIfNeeded() {
        // Only show prompt if sound alerts are enabled and audio is not yet initialized
        if (this.settings.soundAlerts && !this.audioInitialized) {
            this.showNotification(
                '🔊 Click anywhere to enable sound alerts',
                'info',
                'audio'
            );
        }
    }

    initializeAudioContext() {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            // Resume audio context if it's suspended (some browsers suspend it by default)
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume().then(() => {
                    console.log('[SOUND] Audio context resumed');
                    this.audioInitialized = true;
                }).catch(error => {
                    console.warn('[SOUND] Could not resume audio context:', error);
                });
            } else {
                console.log('[SOUND] Audio context initialized, state:', this.audioContext.state);
                this.audioInitialized = true;
            }
        } catch (error) {
            console.warn('[SOUND] Could not initialize audio context:', error);
        }
    }

    loadSoundEffects() {
        // Create simple sound effects programmatically
        this.createSoundEffects();
    }

    createSoundEffects() {
        // We'll create simple beep sounds using Web Audio API
        this.soundGenerators = {
            beep: () => this.generateBeep(800, 0.1),
            notification: () => this.generateChime([523, 659, 784], 0.15),
            alert: () => this.generateAlert([400, 800, 400], 0.2),
            retro_videogame: () => this.generateRetroVideogame()
        };
    }

    generateBeep(frequency, duration) {
        if (!this.audioContext) {
            this.initializeAudioContext();
        }

        if (!this.audioContext) {
            console.warn('[SOUND] Audio context not available');
            return;
        }

        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
        oscillator.type = 'sine';

        gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + duration);
    }

    generateChime(frequencies, duration) {
        if (!this.audioContext) {
            this.initializeAudioContext();
        }

        if (!this.audioContext) {
            console.warn('[SOUND] Audio context not available');
            return;
        }

        frequencies.forEach((freq, index) => {
            setTimeout(() => {
                const oscillator = this.audioContext.createOscillator();
                const gainNode = this.audioContext.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(this.audioContext.destination);

                oscillator.frequency.setValueAtTime(freq, this.audioContext.currentTime);
                oscillator.type = 'sine';

                gainNode.gain.setValueAtTime(0.05, this.audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + duration);
            }, index * 50);
        });
    }

    generateAlert(frequencies, duration) {
        if (!this.audioContext) {
            this.initializeAudioContext();
        }

        if (!this.audioContext) {
            console.warn('[SOUND] Audio context not available');
            return;
        }

        frequencies.forEach((freq, index) => {
            setTimeout(() => {
                const oscillator = this.audioContext.createOscillator();
                const gainNode = this.audioContext.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(this.audioContext.destination);

                oscillator.frequency.setValueAtTime(freq, this.audioContext.currentTime);
                oscillator.type = 'square';

                gainNode.gain.setValueAtTime(0.08, this.audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration/3);

                oscillator.start(this.audioContext.currentTime);
                oscillator.stop(this.audioContext.currentTime + duration/3);
            }, index * 100);
        });
    }

    generateRetroVideogame() {
        if (!this.audioContext) {
            this.initializeAudioContext();
        }

        if (!this.audioContext) {
            console.warn('[SOUND] Audio context not available');
            return;
        }

        // Classic retro videogame style sound with descending frequency sweep
        const startFreq = 220;  // Starting frequency (A3)
        const endFreq = 55;     // Ending frequency (A1) - two octaves down
        const duration = 0.3;   // Total duration

        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(this.audioContext.destination);

        // Use square wave for that classic 8-bit sound
        oscillator.type = 'square';

        // Create the characteristic descending frequency sweep
        oscillator.frequency.setValueAtTime(startFreq, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(endFreq, this.audioContext.currentTime + duration);

        // Volume envelope: quick attack, then fade out
        gainNode.gain.setValueAtTime(0.12, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + duration);

        // Add a second harmonic for richness (classic arcade sound technique)
        setTimeout(() => {
            const oscillator2 = this.audioContext.createOscillator();
            const gainNode2 = this.audioContext.createGain();

            oscillator2.connect(gainNode2);
            gainNode2.connect(this.audioContext.destination);

            oscillator2.type = 'square';

            // Second oscillator at a higher frequency for harmonic content
            oscillator2.frequency.setValueAtTime(startFreq * 1.5, this.audioContext.currentTime);
            oscillator2.frequency.exponentialRampToValueAtTime(endFreq * 1.5, this.audioContext.currentTime + duration * 0.6);

            // Lower volume for the harmonic
            gainNode2.gain.setValueAtTime(0.06, this.audioContext.currentTime);
            gainNode2.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration * 0.6);

            oscillator2.start(this.audioContext.currentTime);
            oscillator2.stop(this.audioContext.currentTime + duration * 0.6);
        }, 20); // Slight delay for phasing effect
    }

    playAlertSound() {
        if (!this.settings.soundAlerts) {
            return;
        }

        // Try to initialize audio context if not done yet
        if (!this.audioInitialized) {
            this.initializeAudioContext();
        }

        if (!this.soundGenerators) {
            console.warn('[SOUND] Sound generators not available');
            return;
        }

        const soundType = this.settings.alertSound || 'beep';
        const generator = this.soundGenerators[soundType];

        if (generator) {
            try {
                generator();
                console.log('[SOUND] Played sound:', soundType);
            } catch (error) {
                console.warn('[SOUND] Could not play sound:', error);
                // Try to reinitialize audio context on error
                if (!this.audioInitialized) {
                    this.initializeAudioContext();
                }
            }
        } else {
            console.warn('[SOUND] Sound generator not found for:', soundType);
        }
    }

    openSettings() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.classList.add('active');
        }
    }

    closeSettings() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }

    // Utility Functions
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.log(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen();
        }
    }

    handleKeyboardShortcuts(e) {
        // Ctrl/Cmd + key combinations
        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 'f':
                    e.preventDefault();
                    this.toggleFullscreen();
                    break;
                case 't':
                    e.preventDefault();
                    this.toggleTheme();
                    break;
                case ',':
                    e.preventDefault();
                    this.openSettings();
                    break;
            }
        }

        // Escape key
        if (e.key === 'Escape') {
            this.closeSettings();
        }

        // Tab navigation
        if (e.key >= '1' && e.key <= '4' && e.altKey) {
            e.preventDefault();
            const tabs = ['live-feed', 'top-ips', 'countries', 'overview'];
            const index = parseInt(e.key) - 1;
            if (tabs[index]) {
                this.switchTab(tabs[index]);
            }
        }
    }

    handleWindowResize() {
        this.resizeCharts();
        this.updateMapSize();
    }

    startPerformanceMonitoring() {
        setInterval(() => {
            // Monitor performance and adjust if needed
            // performance.memory is a non-standard API (Chrome only)
            if (window.performance && window.performance.memory) {
                const memInfo = window.performance.memory;
                if (memInfo.usedJSHeapSize > 100 * 1024 * 1024) { // 100MB
                    this.optimizeMemoryUsage();
                }
            }
        }, 30000); // Check every 30 seconds
    }

    startConnectionStatusMonitoring() {
        // Check if WebSocket was already connected before dashboard loaded
        if (window.webSocketConnected === true) {
            console.log('[*] Dashboard initialized - WebSocket already connected, setting status to connected');
            this.updateConnectionStatus('connected');
        } else {
            console.log('[*] Dashboard initialized - WebSocket not yet connected, setting status to connecting');
            // Set initial status to connecting
            this.updateConnectionStatus('connecting');
        }

        // Periodically check and sync connection status
        setInterval(() => {
            this.syncConnectionStatus();
        }, 2000); // Check every 2 seconds
    }

    syncConnectionStatus() {
        const now = Date.now();
        const IDLE_THRESHOLD = 30000; // 30 seconds

        // 1. Check WebSocket State
        if (!window.webSocket) {
            this.updateConnectionStatus('disconnected');
            return;
        }

        const state = window.webSocket.readyState;

        if (state === WebSocket.CONNECTING) {
            this.updateConnectionStatus('connecting');
            return;
        }

        if (state === WebSocket.CLOSING || state === WebSocket.CLOSED) {
            this.updateConnectionStatus('disconnected');
            return;
        }

        // 2. Socket is OPEN. Check Data Recency.
        // Use window.lastValidDataTime which tracks actual data events
        const lastMsgTime = window.lastValidDataTime || 0;
        const timeSinceLastMsg = now - lastMsgTime;

        if (timeSinceLastMsg < IDLE_THRESHOLD) {
            this.updateConnectionStatus('connected');
        } else {
            this.updateConnectionStatus('idle');
        }
    }

    optimizeMemoryUsage() {
        // Limit attack history to match cache size
        if (this.attackHistory.length > this.attackCache.maxEvents) {
            this.attackHistory = this.attackHistory.slice(-this.attackCache.maxEvents);
        }

        // Limit table rows
        const tables = ['ip-tracking', 'country-tracking', 'attack-tracking'];
        tables.forEach(tableId => {
            const tbody = document.getElementById(tableId);
            if (tbody && tbody.children.length > 100) {
                while (tbody.children.length > 50) {
                    tbody.removeChild(tbody.lastChild);
                }
            }
        });
    }

    startDataAggregation() {
        // Update timeline with different frequencies based on interval
        this.startTimelineUpdates();

        // Update other stats every 5 seconds (synchronized updates)
        setInterval(() => {
            this.aggregateProtocolStats();
            this.aggregateCountryStats();
            this.updateDashboardMetrics();
            this.updateHoneypotChartData(); // Synchronized with other card updates
        }, 5000); // Every 5 seconds
    }

    // Start timeline updates with appropriate frequency
    startTimelineUpdates() {
        if (this.timelineUpdateInterval) {
            clearInterval(this.timelineUpdateInterval);
        }

        let updateFrequency;
        switch (this.timelineInterval) {
            case '1m':
                updateFrequency = 1000; // Update every second
                break;
            case '1h':
                updateFrequency = 5000; // Update every 5 seconds
                break;
            case '24h':
            default:
                updateFrequency = 30000; // Update every 30 seconds
                break;
        }

        this.timelineUpdateInterval = setInterval(() => {
            this.updateTimeline();
        }, updateFrequency);

        console.log(`[DEBUG] Timeline updates started with ${updateFrequency}ms interval for ${this.timelineInterval} mode`);
    }

    aggregateProtocolStats() {
        // Use consistent time window for protocol stats
        const retentionMinutes = 15;
        const retentionTime = retentionMinutes * 60 * 1000; // 15 minutes
        const recent = this.attackHistory.filter(attack =>
            Date.now() - attack.timestamp < retentionTime
        );

        this.protocolStats = recent.reduce((stats, attack) => {
            const normalizedProtocol = this.normalizeProtocol(attack.protocol);
            stats[normalizedProtocol] = (stats[normalizedProtocol] || 0) + 1;
            return stats;
        }, {});

        // Update data retention display
        this.updateDataRetentionInfo('attack-distribution', retentionMinutes);
        this.updateDataRetentionInfo('protocol-breakdown', retentionMinutes);
    }

    aggregateCountryStats() {
        // Use consistent time window for country stats
        const retentionMinutes = 15;
        const retentionTime = retentionMinutes * 60 * 1000; // 15 minutes
        const recent = this.attackHistory.filter(attack =>
            Date.now() - attack.timestamp < retentionTime
        );

        this.countryStats = recent.reduce((stats, attack) => {
            stats[attack.country] = (stats[attack.country] || 0) + 1;
            return stats;
        }, {});
    }

    // Add method to update data retention information display
    updateDataRetentionInfo(cardType, retentionMinutes) {
        const cards = document.querySelectorAll('.dashboard-card');
        cards.forEach(card => {
            const header = card.querySelector('.card-header h4');
            if (header) {
                const text = header.textContent;
                if ((cardType === 'attack-distribution' && text.includes('Attack Distribution')) ||
                    (cardType === 'protocol-breakdown' && text.includes('Protocol Breakdown'))) {

                    // Remove existing retention info
                    let retentionSpan = card.querySelector('.data-retention-info');
                    if (retentionSpan) {
                        retentionSpan.remove();
                    }

                    // Add new retention info
                    retentionSpan = document.createElement('span');
                    retentionSpan.className = 'data-retention-info';
                    retentionSpan.textContent = ` (Last ${retentionMinutes}m)`;
                    retentionSpan.style.fontSize = '0.8em';
                    retentionSpan.style.color = 'var(--text-secondary)';
                    retentionSpan.style.fontWeight = 'normal';
                    header.appendChild(retentionSpan);
                }
            }
        });
    }

    updateDashboardMetrics() {
        // Update various dashboard metrics
        if (this.activeTab === 'overview') {
            this.updateOverviewCharts();
        }

        // Note: Header stats are updated by WebSocket Stats messages (handleStats in map.js)
        // which contain correct historical data from Elasticsearch
    }

    hideLoadingScreen() {
        setTimeout(() => {
            const loadingScreen = document.getElementById('loading-screen');
            if (loadingScreen) {
                loadingScreen.classList.add('hidden');
            }
        }, 1500);
    }

    showNotification(message, type = 'info', context = 'general') {
        // Ensure notification container exists and is properly configured
        let container = document.getElementById('notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'notification-container';
            document.body.appendChild(container);
        }

        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;

        // Add context-specific class if needed
        if (context !== 'general') {
            notification.classList.add(`notification-${context}`);
        }

        // Create notification structure using DOM API
        const header = document.createElement('div');
        header.className = 'notification-header';

        const title = document.createElement('div');
        title.className = 'notification-title';
        title.textContent = this.getNotificationTitle(type);
        header.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'notification-close';
        closeBtn.innerHTML = '&times;'; // Safe entity
        header.appendChild(closeBtn);

        notification.appendChild(header);

        const msgDiv = document.createElement('div');
        msgDiv.className = 'notification-message';
        msgDiv.textContent = message;
        notification.appendChild(msgDiv);

        const timeDiv = document.createElement('div');
        timeDiv.className = 'notification-timestamp';
        timeDiv.textContent = new Date().toLocaleTimeString();
        notification.appendChild(timeDiv);

        // Add close button event listener
        const closeButton = notification.querySelector('.notification-close');
        closeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (notification.parentNode) {
                notification.classList.add('fade-out');
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.remove();
                    }
                }, 300);
            }
        });

        // Add to container at the top (newest first)
        container.insertBefore(notification, container.firstChild);

        // Force reflow to ensure proper positioning
        notification.offsetHeight;

        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.classList.add('fade-out');
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.remove();
                    }
                }, 300);
            }
        }, 5000);
    }

    getNotificationTitle(type) {
        const titles = {
            'success': 'Success',
            'info': 'Information',
            'warning': 'Warning',
            'error': 'Error'
        };
        return titles[type] || 'Notification';
    }

    // Public API for external components
    addAttackEvent(event) {
        console.log('[DEBUG] Dashboard received attack event:', event);

        event.timestamp = Date.now();
        this.attackHistory.push(event);

        // Store in cache if initialized and not currently restoring
        if (this.cacheInitialized && !this.restoringFromCache) {
            this.attackCache.storeEvent(event).catch(error => {
                console.warn('[CACHE] Failed to store event:', error);
            });
        }

        // Process attack for honeypot tracking if honeypot field is present
        if (event.honeypot) {
            this.trackHoneypotAttack(event.honeypot, event.timestamp);
        }

        // Try to initialize audio context if not already done (aggressive approach)
        if (!this.audioInitialized) {
            console.log('[SOUND] Attempting audio initialization on attack event');
            this.initializeAudioContext();
        }

        // Play sound alert for new attack
        this.playAlertSound();

        // Add to timeline data in real-time
        this.addAttackToTimeline(event);

        // Add to heatmap data in real-time
        this.addAttackToHeatmap(event);

        // Limit history size
        if (this.attackHistory.length > 1000) {
            this.attackHistory.shift();
        }

        // Update relevant displays (synchronized updates)
        this.updateLiveAttackDisplay(event);
        this.updateHoneypotChartData(); // Update honeypot chart in sync with other cards
        console.log('[DEBUG] Attack event processed, history length:', this.attackHistory.length);
    }

    updateConnectionStatus(status) {
        // Prevent unnecessary updates
        if (this.connectionStatus === status) {
            return;
        }

        const indicator = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        console.log(`[DEBUG] Connection status update: ${this.connectionStatus} -> ${status}`);

        if (indicator && text) {
            const oldStatus = indicator.className;
            indicator.className = `status-indicator ${status}`;

            switch (status) {
                case 'connected':
                    text.textContent = 'Connected';
                    console.log('[*] Status indicator set to Connected');
                    break;
                case 'idle':
                    text.textContent = 'Idle';
                    console.log('[*] Status indicator set to Idle');
                    break;
                case 'connecting':
                    text.textContent = 'Connecting...';
                    console.log('[*] Status indicator set to Connecting...');
                    break;
                case 'disconnected':
                default:
                    text.textContent = 'Disconnected';
                    break;
            }

            this.connectionStatus = status;
            console.log(`[DEBUG] Connection status UI updated from '${oldStatus}' to '${indicator.className}'`);
        } else {
            console.warn('[WARNING] Connection status elements not found');
        }
    }

    // Helper method to update IP tracking data for restored events
    updateIPTracking(ip, country, event) {
        if (!ip) return;

        if (!this.ipStats.has(ip)) {
            this.ipStats.set(ip, { count: 0, country: country || 'Unknown', firstSeen: event.timestamp });
        }
        const stats = this.ipStats.get(ip);
        stats.count++;
        stats.lastSeen = event.timestamp;
    }

    // Helper method to update country tracking data for restored events
    updateCountryTracking(country, event) {
        if (!country || country === 'Unknown') return;

        if (!this.countryStats.has(country)) {
            this.countryStats.set(country, { count: 0, firstSeen: event.timestamp });
        }
        const stats = this.countryStats.get(country);
        stats.count++;
        stats.lastSeen = event.timestamp;
    }

    // Helper method to update protocol stats for restored events
    updateProtocolStats(protocol) {
        if (!protocol) return;

        this.protocolStats[protocol] = (this.protocolStats[protocol] || 0) + 1;
    }

    addToLiveFeed(event) {
        // Add event to live feed table without highlighting (for cache restoration)
        this.addToAttackTable(event, false); // false = no highlighting for restored events

        // Update IP tracking (needed for top IPs table)
        this.updateIPTracking(event.ip || event.source_ip, event.country, event);

        // Update country tracking (needed for top countries table)
        this.updateCountryTracking(event.country, event);

        // Update protocol statistics (needed for protocol breakdown)
        this.updateProtocolStats(event.protocol);
    }

    updateLiveAttackDisplay(event) {
        // Update live attack feed table
        this.addToAttackTable(event);

        // Update IP tracking
        this.updateIPTracking(event.ip, event.country, event);

        // Update country tracking
        this.updateCountryTracking(event.country, event);

        // Update protocol statistics
        this.updateProtocolStats(event.protocol);

        // Update real-time charts if on overview tab
        if (this.activeTab === 'overview') {
            this.updateOverviewCharts();
        }
    }

    addToAttackTable(event, highlight = true) {
        const tbody = document.getElementById('attack-tracking');
        if (!tbody) {
            console.warn('[WARNING] attack-tracking table not found');
            return;
        }

        const row = document.createElement('tr');

        // Add the new row highlight class only for real-time events
        if (highlight) {
            row.classList.add('new-attack-row');

            // Remove the highlight class after animation completes
            setTimeout(() => {
                row.classList.remove('new-attack-row');
            }, 2000);
        }

        // Use the event timestamp if available, otherwise current time
        const eventTime = event.timestamp ? new Date(event.timestamp) : new Date();

        // Format timestamp as YYYY-MM-DD HH:MM:SS
        const year = eventTime.getFullYear();
        const month = String(eventTime.getMonth() + 1).padStart(2, '0');
        const day = String(eventTime.getDate()).padStart(2, '0');
        const hours = String(eventTime.getHours()).padStart(2, '0');
        const minutes = String(eventTime.getMinutes()).padStart(2, '0');
        const seconds = String(eventTime.getSeconds()).padStart(2, '0');

        const timeDisplay = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

        // Use ISO code for flag path (should be 2-letter uppercase code)
        const flagCode = event.iso_code || event.country_code || 'XX';

        // Determine protocol - use "OTHER" if not specified or unknown
        const protocolName = this.normalizeProtocol(event.protocol);

        const protocol = protocolName.toLowerCase();
        const protocolClass = `protocol-${protocol}`;

        // Create cells using DOM API to prevent XSS
        const addCell = (className, text) => {
            const td = document.createElement('td');
            td.className = className;
            td.textContent = text;
            row.appendChild(td);
            return td;
        };

        addCell('time-cell', timeDisplay);
        addCell('ip-cell', event.ip || event.src_ip || 'Unknown');
        addCell('ip-rep-cell', event.ip_rep || 'Unknown');

        const flagCell = document.createElement('td');
        flagCell.className = 'flag-cell';
        const flagImg = document.createElement('img');
        flagImg.src = `static/flags/${flagCode}.svg`;
        flagImg.alt = event.country || 'Unknown';
        flagImg.className = 'flag-icon';
        flagImg.onerror = function() { this.src = 'static/flags/XX.svg'; };
        flagCell.appendChild(flagImg);
        row.appendChild(flagCell);

        addCell('country-cell', event.country || 'Unknown');
        addCell('honeypot-cell', event.honeypot || 'Unknown');

        const protocolCell = document.createElement('td');
        protocolCell.className = 'protocol-cell';
        const badge = document.createElement('span');
        badge.className = `protocol-badge ${protocolClass}`;
        badge.textContent = protocolName;
        protocolCell.appendChild(badge);
        row.appendChild(protocolCell);

        addCell('port-cell', event.port || event.dst_port || 'N/A');
        addCell('tpot-hostname-cell', event.honeypot_hostname || 'Unknown');

        // Add to top of table
        tbody.insertBefore(row, tbody.firstChild);

        // Limit table size
        while (tbody.children.length > 100) {
            tbody.removeChild(tbody.lastChild);
        }

        console.log('[DEBUG] Added row to attack table for IP:', event.ip || event.src_ip);
    }

    updateIPTracking(ip, country, event = null) {
        // Update IP statistics
        if (!this.ipStats) this.ipStats = {};

        // Determine timestamp to use
        const timestamp = (event && event.timestamp) ? new Date(event.timestamp) : new Date();

        if (!this.ipStats[ip]) {
            this.ipStats[ip] = {
                hits: 0,
                country: country,
                lastSeen: timestamp,
                ip: ip,
                reputation: 'Unknown',
                lastProtocol: 'Unknown',
                countryCode: 'XX'  // Store ISO code
            };
        }
        this.ipStats[ip].hits++;

        // Update lastSeen if the event is newer than what we have
        if (timestamp >= this.ipStats[ip].lastSeen) {
            this.ipStats[ip].lastSeen = timestamp;
        }

        this.ipStats[ip].country = country; // Update country in case it changes

        // Update reputation, protocol and country code if event data is available
        if (event) {
            if (event.ip_rep) {
                this.ipStats[ip].reputation = event.ip_rep;
            }
            if (event.protocol) {
                this.ipStats[ip].lastProtocol = this.normalizeProtocol(event.protocol);
            }
            // Store the actual ISO code from Elasticsearch
            if (event.iso_code || event.country_code) {
                this.ipStats[ip].countryCode = event.iso_code || event.country_code;
            }
        }

        // Update IP table if it's the active tab
        if (this.activeTab === 'top-ips') {
            this.updateTopIPsTable();
        }
    }

    updateCountryTracking(country, event = null) {
        // Update country statistics
        if (!this.countryTrackingStats) this.countryTrackingStats = {};

        // Determine timestamp to use
        const timestamp = (event && event.timestamp) ? new Date(event.timestamp) : new Date();

        if (!this.countryTrackingStats[country]) {
            this.countryTrackingStats[country] = {
                hits: 0,
                country: country,
                lastSeen: timestamp,
                topProtocol: 'Unknown',
                protocolCounts: {},
                uniqueIPs: new Set(),
                lastSeenIP: 'Unknown',
                countryCode: 'XX'  // Store ISO code
            };
        }
        this.countryTrackingStats[country].hits++;

        // Update lastSeen if the event is newer than what we have
        if (timestamp >= this.countryTrackingStats[country].lastSeen) {
            this.countryTrackingStats[country].lastSeen = timestamp;
        }

        // Update additional fields if event data is available
        if (event) {
            // Store the actual ISO code from Elasticsearch
            if (event.iso_code || event.country_code) {
                this.countryTrackingStats[country].countryCode = event.iso_code || event.country_code;
            }

            // Track unique IPs for this country
            if (event.ip) {
                this.countryTrackingStats[country].uniqueIPs.add(event.ip);
                this.countryTrackingStats[country].lastSeenIP = event.ip;
            }

            // Track protocol counts to determine top protocol
            if (event.protocol) {
                const normalizedProtocol = this.normalizeProtocol(event.protocol);
                if (!this.countryTrackingStats[country].protocolCounts[normalizedProtocol]) {
                    this.countryTrackingStats[country].protocolCounts[normalizedProtocol] = 0;
                }
                this.countryTrackingStats[country].protocolCounts[normalizedProtocol]++;

                // Update top protocol (most frequent)
                let maxCount = 0;
                let topProtocol = 'Unknown';
                for (const [protocol, count] of Object.entries(this.countryTrackingStats[country].protocolCounts)) {
                    if (count > maxCount) {
                        maxCount = count;
                        topProtocol = protocol;
                    }
                }
                this.countryTrackingStats[country].topProtocol = topProtocol;
            }
        }

        // Update country table if it's the active tab
        if (this.activeTab === 'countries') {
            this.updateTopCountriesTable();
        }
    }

    updateTopIPsTable() {
        const tbody = document.getElementById('ip-tracking');
        if (!tbody || !this.ipStats) return;

        // Sort IPs by hits (descending)
        const sortedIPs = Object.values(this.ipStats)
            .sort((a, b) => b.hits - a.hits)
            .slice(0, 100); // Top 100

        tbody.innerHTML = '';

        sortedIPs.forEach((ipData, index) => {
            const row = document.createElement('tr');

            // Format timestamp as YYYY-MM-DD HH:MM:SS
            const eventTime = ipData.lastSeen;
            const year = eventTime.getFullYear();
            const month = String(eventTime.getMonth() + 1).padStart(2, '0');
            const day = String(eventTime.getDate()).padStart(2, '0');
            const hours = String(eventTime.getHours()).padStart(2, '0');
            const minutes = String(eventTime.getMinutes()).padStart(2, '0');
            const seconds = String(eventTime.getSeconds()).padStart(2, '0');

            const timeDisplay = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

            // Use stored ISO code instead of converting country name
            const flagCode = ipData.countryCode || 'XX';

            // Protocol badge styling
            const protocol = ipData.lastProtocol.toLowerCase();
            const protocolClass = `protocol-${protocol}`;

            // Create cells using DOM API to prevent XSS
            const addCell = (className, text) => {
                const td = document.createElement('td');
                td.className = className;
                td.textContent = text;
                row.appendChild(td);
                return td;
            };

            addCell('rank-cell', index + 1);
            addCell('hits-cell', ipData.hits);
            addCell('ip-cell', ipData.ip);
            addCell('ip-rep-cell', ipData.reputation);

            const flagCell = document.createElement('td');
            flagCell.className = 'flag-cell';
            const flagImg = document.createElement('img');
            flagImg.src = `static/flags/${flagCode}.svg`;
            flagImg.alt = ipData.country || 'Unknown';
            flagImg.className = 'flag-icon';
            flagImg.onerror = function() { this.src = 'static/flags/XX.svg'; };
            flagCell.appendChild(flagImg);
            row.appendChild(flagCell);

            addCell('country-cell', ipData.country || 'Unknown');

            const protocolCell = document.createElement('td');
            protocolCell.className = 'protocol-cell';
            const badge = document.createElement('span');
            badge.className = `protocol-badge ${protocolClass}`;
            badge.textContent = ipData.lastProtocol;
            protocolCell.appendChild(badge);
            row.appendChild(protocolCell);

            addCell('time-cell', timeDisplay);

            tbody.appendChild(row);
        });
    }

    updateTopCountriesTable() {
        const tbody = document.getElementById('country-tracking');
        if (!tbody || !this.countryTrackingStats) return;

        // Sort countries by hits (descending)
        const sortedCountries = Object.values(this.countryTrackingStats)
            .sort((a, b) => b.hits - a.hits)
            .slice(0, 100); // Top 100

        tbody.innerHTML = '';

        sortedCountries.forEach((countryData, index) => {
            const row = document.createElement('tr');

            // Format timestamp as YYYY-MM-DD HH:MM:SS
            const eventTime = countryData.lastSeen;
            const year = eventTime.getFullYear();
            const month = String(eventTime.getMonth() + 1).padStart(2, '0');
            const day = String(eventTime.getDate()).padStart(2, '0');
            const hours = String(eventTime.getHours()).padStart(2, '0');
            const minutes = String(eventTime.getMinutes()).padStart(2, '0');
            const seconds = String(eventTime.getSeconds()).padStart(2, '0');

            const timeDisplay = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

            // Use stored ISO code instead of converting country name
            const flagCode = countryData.countryCode || 'XX';

            // Protocol badge styling
            const protocol = countryData.topProtocol.toLowerCase();
            const protocolClass = `protocol-${protocol}`;

            // Get unique IP count
            const uniqueIPCount = countryData.uniqueIPs ? countryData.uniqueIPs.size : 0;

            // Create cells using DOM API to prevent XSS
            const addCell = (className, text) => {
                const td = document.createElement('td');
                td.className = className;
                td.textContent = text;
                row.appendChild(td);
                return td;
            };

            addCell('rank-cell', index + 1);
            addCell('hits-cell', countryData.hits);

            const flagCell = document.createElement('td');
            flagCell.className = 'flag-cell';
            const flagImg = document.createElement('img');
            flagImg.src = `static/flags/${flagCode}.svg`;
            flagImg.alt = countryData.country || 'Unknown';
            flagImg.className = 'flag-icon';
            flagImg.onerror = function() { this.src = 'static/flags/XX.svg'; };
            flagCell.appendChild(flagImg);
            row.appendChild(flagCell);

            addCell('country-cell', countryData.country || 'Unknown');

            const protocolCell = document.createElement('td');
            protocolCell.className = 'protocol-cell';
            const badge = document.createElement('span');
            badge.className = `protocol-badge ${protocolClass}`;
            badge.textContent = countryData.topProtocol;
            protocolCell.appendChild(badge);
            row.appendChild(protocolCell);

            addCell('unique-ips-cell', uniqueIPCount);
            addCell('last-ip-cell', countryData.lastSeenIP);
            addCell('time-cell', timeDisplay);

            tbody.appendChild(row);
        });
    }

    updateProtocolStats(protocol) {
        if (!protocol) return;

        // Normalize protocol to known protocols or "OTHER"
        const normalizedProtocol = this.normalizeProtocol(protocol);

        this.protocolStats[normalizedProtocol] = (this.protocolStats[normalizedProtocol] || 0) + 1;

        // Update protocol chart if it exists
        if (this.charts.protocol) {
            const labels = Object.keys(this.protocolStats);
            const data = Object.values(this.protocolStats);

            this.charts.protocol.data.labels = labels;
            this.charts.protocol.data.datasets[0].data = data.map(d => Math.sqrt(d));
            this.charts.protocol.data.datasets[0].originalData = data;
            this.charts.protocol.update('none'); // Update without animation for performance
        }
    }

    initThreatHeatmap() {
        const container = document.getElementById('threat-heatmap');
        if (!container) return;

        // Create heatmap grid
        container.innerHTML = `
            <div class="heatmap-grid">
                <div class="heatmap-content">
                    <div class="heatmap-timeline">
                        <div class="timeline-grid"></div>
                        <div class="timeline-labels"></div>
                    </div>
                </div>
                <div class="heatmap-legend">
                    <span class="legend-label">Low</span>
                    <div class="legend-gradient"></div>
                    <span class="legend-label">High</span>
                </div>
            </div>
        `;

        this.setupHeatmapData();
        this.updateThreatHeatmap();
    }

    setupHeatmapData() {
        // Initialize 24 hours of heatmap data with real data
        this.heatmapData = Array.from({ length: 24 }, (_, hour) => ({
            hour: hour,
            intensity: 0, // Will be calculated from real attack data
            attacks: 0    // Will be calculated from real attack data
        }));

        // Populate with real attack data
        this.populateHeatmapFromHistory();
    }

    // Populate heatmap with real attack data from history
    populateHeatmapFromHistory() {
        if (!this.attackHistory.length) {
            console.log(`[DEBUG] No attack history available for heatmap population`);
            return;
        }

        console.log(`[DEBUG] Populating heatmap from ${this.attackHistory.length} attacks`);

        // Reset counts
        this.heatmapData.forEach(hourData => {
            hourData.attacks = 0;
            hourData.intensity = 0;
        });

        const now = Date.now();
        const last24Hours = now - (24 * 60 * 60 * 1000); // 24 hours ago

        // Filter attacks from last 24 hours
        const recentAttacks = this.attackHistory.filter(attack =>
            attack.timestamp >= last24Hours
        );

        console.log(`[DEBUG] Found ${recentAttacks.length} attacks in last 24 hours for heatmap`);

        // Count attacks per hour
        recentAttacks.forEach(attack => {
            const attackTime = new Date(attack.timestamp);
            const hour = attackTime.getHours();

            if (hour >= 0 && hour <= 23) {
                this.heatmapData[hour].attacks++;
            }
        });

        // Calculate intensity based on attack counts
        const maxAttacks = Math.max(...this.heatmapData.map(h => h.attacks), 1);
        this.heatmapData.forEach(hourData => {
            hourData.intensity = maxAttacks > 0 ? (hourData.attacks / maxAttacks) * 100 : 0;
        });

        console.log(`[DEBUG] Heatmap populated - attacks per hour:`, this.heatmapData.map(h => h.attacks));
    }

    // Add attack to heatmap data
    addAttackToHeatmap(attack, triggerUpdate = true) {
        const attackTime = new Date(attack.timestamp || Date.now());
        const hour = attackTime.getHours();

        if (hour >= 0 && hour <= 23) {
            this.heatmapData[hour].attacks++;

            // Recalculate intensity
            const maxAttacks = Math.max(...this.heatmapData.map(h => h.attacks), 1);
            this.heatmapData.forEach(hourData => {
                hourData.intensity = maxAttacks > 0 ? (hourData.attacks / maxAttacks) * 100 : 0;
            });

            // Update heatmap display only if not restoring
            if (triggerUpdate) {
                this.updateThreatHeatmap();
            }
        }
    }

    updateThreatHeatmap() {
        const timelineGrid = document.querySelector('.timeline-grid');
        const timelineLabels = document.querySelector('.timeline-labels');

        if (!timelineGrid || !timelineLabels) return;

        // Create hour labels
        timelineLabels.innerHTML = '';
        for (let i = 0; i < 24; i += 3) {
            const label = document.createElement('div');
            label.className = 'timeline-label';
            label.textContent = `${i.toString().padStart(2, '0')}:00`;
            timelineLabels.appendChild(label);
        }

        // Create heatmap cells
        timelineGrid.innerHTML = '';
        this.heatmapData.forEach((data, index) => {
            const cell = document.createElement('div');
            cell.className = 'heatmap-cell';
            cell.title = `${data.hour}:00 - ${data.attacks} attacks`;
            cell.style.backgroundColor = this.getHeatmapColor(data.intensity);
            cell.addEventListener('click', () => {
                this.showHeatmapDetails(data);
            });
            timelineGrid.appendChild(cell);
        });
    }

    getHeatmapColor(intensity) {
        // Greyish/blue tone color gradient: Light Grey (safe) to Dark Blue (danger)
        const ratio = intensity / 100;

        if (ratio <= 0.25) {
            // Light Grey to Light Blue (0-25%) - Safe/Low threat
            const localRatio = ratio / 0.25;
            const r = Math.floor(240 - localRatio * 65); // 240 -> 175
            const g = Math.floor(240 - localRatio * 25); // 240 -> 215
            const b = Math.floor(240 - localRatio * 15); // 240 -> 225
            return `rgba(${r}, ${g}, ${b}, 0.85)`;
        } else if (ratio <= 0.5) {
            // Light Blue to Medium Blue (25-50%) - Moderate threat
            const localRatio = (ratio - 0.25) / 0.25;
            const r = Math.floor(175 - localRatio * 75); // 175 -> 100
            const g = Math.floor(215 - localRatio * 65); // 215 -> 150
            const b = Math.floor(225 - localRatio * 25); // 225 -> 200
            return `rgba(${r}, ${g}, ${b}, 0.85)`;
        } else if (ratio <= 0.75) {
            // Medium Blue to Dark Blue (50-75%) - High threat
            const localRatio = (ratio - 0.5) / 0.25;
            const r = Math.floor(100 - localRatio * 50); // 100 -> 50
            const g = Math.floor(150 - localRatio * 70); // 150 -> 80
            const b = Math.floor(200 - localRatio * 40); // 200 -> 160
            return `rgba(${r}, ${g}, ${b}, 0.85)`;
        } else {
            // Dark Blue to Navy Blue (75-100%) - Critical threat
            const localRatio = (ratio - 0.75) / 0.25;
            const r = Math.floor(50 - localRatio * 30); // 50 -> 20
            const g = Math.floor(80 - localRatio * 50); // 80 -> 30
            const b = Math.floor(160 - localRatio * 60); // 160 -> 100
            return `rgba(${r}, ${g}, ${b}, 0.9)`;
        }
    }

    showHeatmapDetails(data) {
        // Create and show tooltip near the heatmap
        const heatmapContainer = document.getElementById('threat-heatmap');
        if (!heatmapContainer) return;

        // Remove existing tooltip
        const existingTooltip = document.querySelector('.heatmap-tooltip');
        if (existingTooltip) {
            existingTooltip.remove();
        }

        // Create new tooltip
        const tooltip = document.createElement('div');
        tooltip.className = 'heatmap-tooltip';

        const strong = document.createElement('strong');
        strong.textContent = `Hour ${data.hour}:00`;
        tooltip.appendChild(strong);

        tooltip.appendChild(document.createElement('br'));
        tooltip.appendChild(document.createTextNode(`${data.attacks} attacks`));

        tooltip.appendChild(document.createElement('br'));
        tooltip.appendChild(document.createTextNode(`${Math.round(data.intensity)}% intensity`));

        // Position tooltip near the heatmap
        const rect = heatmapContainer.getBoundingClientRect();
        tooltip.style.cssText = `
            position: fixed;
            left: ${rect.left + 10}px;
            top: ${rect.bottom - 80}px;
            background: var(--bg-modal);
            color: var(--text-primary);
            padding: var(--spacing-sm);
            border-radius: var(--radius-md);
            border: 1px solid var(--border-primary);
            box-shadow: 0 4px 16px var(--shadow-medium);
            z-index: 10001;
            font-size: var(--font-xs);
            pointer-events: none;
        `;

        document.body.appendChild(tooltip);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            if (tooltip && tooltip.parentNode) {
                tooltip.remove();
            }
        }, 3000);
    }
}

// Initialize dashboard when DOM is loaded
// Initialize dashboard when DOM and scripts are loaded
window.addEventListener('load', () => {
    // Wait for Chart.js to be available
    function initWhenReady() {
        if (typeof Chart !== 'undefined') {
            console.log('[DEBUG] Chart.js available, initializing Attack Map Dashboard...');
            window.attackMapDashboard = new AttackMapDashboard();
            console.log('[DEBUG] Dashboard initialized:', window.attackMapDashboard);
        } else {
            console.log('[DEBUG] Chart.js not yet available, waiting...');
            setTimeout(initWhenReady, 100);
        }
    }

    initWhenReady();
});

// Export for use in other modules
window.AttackMapDashboard = AttackMapDashboard;
