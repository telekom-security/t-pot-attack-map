# GeoIP Attack Map

This is a generalized fork of the GeoIP Attack Map, adapted to support OpenSearch as a backend and designed as a more flexible, honeypot-agnostic solution. It retains the performance improvements and features introduced in prior work (see Credits), while moving away from Elasticsearch-specific dependencies and T-Pot-specific branding in favor of a broader, more portable deployment model.

### Attack Map Visualization
This geoip attack map visualizer displays honeypot events in real time. The data server connects to OpenSearch, parses out source IP, destination IP, source port, destination port, timestamp, honeypot type and honeypot statistics (events per last 1m, 1h, 1d). Protocols are determined via common ports, and the visualizations vary in color based on protocol type while keeping stats regarding top source IPs and countries.<br>


![img.png](docs/img.png)

### Credits
The original attack map was created by [Matthew Clark May](https://github.com/MatthewClarkMay/geoip-attack-map).<br>
The first T-Pot based fork, introducing dynamic destination IPs, aiohttp/asyncio/aioredis performance improvements, and local dependency serving, was released by [Eddie4](https://github.com/eddie4/geoip-attack-map). Further T-Pot integration and refinements were contributed by the [T-Pot project](https://github.com/telekom-security/tpotce).

### Licenses / Copyright
[Bootstrap](https://github.com/twbs/bootstrap/blob/main/LICENSE), [Chart.js](https://github.com/chartjs/Chart.js/blob/master/LICENSE.md), [D3](https://github.com/d3/d3/blob/main/LICENSE), [Flagpack](https://github.com/Yummygum/flagpack-core/blob/main/LICENSE), [Font Awesome](https://github.com/FortAwesome/Font-Awesome/blob/7.x/LICENSE.txt), [Inter](https://github.com/rsms/inter/blob/master/LICENSE.txt), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono/blob/master/OFL.txt), [jQuery](https://github.com/jquery/jquery/blob/main/LICENSE.txt), [Leaflet](https://github.com/Leaflet/Leaflet/blob/main/LICENSE), [Leaflet.fullscreen](https://github.com/brunob/leaflet.fullscreen/blob/master/LICENSE.md), [Luxon](https://github.com/moment/luxon/blob/master/LICENSE.md), [OpenStreetMap](https://www.openstreetmap.org/copyright).
