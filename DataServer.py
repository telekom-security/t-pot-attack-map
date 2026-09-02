import argparse
import datetime
import json
import time
import os
import pytz
import redis
from elasticsearch import Elasticsearch
from tzlocal import get_localzone

# Configuration defaults (override via CLI flags, HANDOFF-v2 D21)
DEFAULT_ES_URL = 'http://elasticsearch:9200'
DEFAULT_REDIS_HOST = 'map_redis'
es = Elasticsearch(DEFAULT_ES_URL)
redis_ip = DEFAULT_REDIS_HOST
redis_channel = 'attack-map-production'
version = 'Data Server 4.0.0'
local_tz = get_localzone()
output_text = os.getenv("TPOT_ATTACKMAP_TEXT", "ENABLED").upper()

# Track disconnection state for reconnection messages
was_disconnected_es = False
was_disconnected_redis = False

# Global Redis client for persistent connection
redis_client = None

event_count = 1

# Color Codes for Attack Map
service_rgb = {
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
}

# Port to Protocol Mapping
PORT_MAP = {
    19: "CHARGEN",
    20: "FTP-DATA",
    21: "FTP",
    22: "SSH",
    2222: "SSH",
    23: "TELNET",
    2223: "TELNET",
    25: "SMTP",
    42: "WINS",
    53: "DNS",
    67: "DHCP",
    69: "TFTP",
    80: "HTTP",
    81: "HTTP",
    104: "DICOM",
    110: "POP3",
    123: "NTP",
    135: "RPC",
    143: "IMAP",
    161: "SNMP",
    389: "LDAP",
    443: "HTTPS",
    445: "SMB",
    465: "SMTPS",
    587: "EMAIL",
    623: "IPMI",
    631: "IPP",
    993: "IMAPS",
    995: "POP3S",
    1025: "NFS",
    1080: "SOCKS",
    1433: "SQL",
    1521: "ORACLE",
    1723: "PPTP",
    1883: "MQTT",
    1900: "SSDP",
    2404: "IEC104",
    2575: "HL7",
    3306: "MYSQL",
    3389: "RDP",
    5000: "IPSEC",
    5060: "SIP",
    5061: "SIP",
    5432: "POSTGRESQL",
    5555: "ADB",
    5900: "VNC",
    6379: "REDIS",
    6667: "IRC",
    8080: "HTTP",
    8888: "HTTP",
    8443: "HTTPS",
    9100: "JETDIRECT",
    9200: "ELASTICSEARCH",
    10001: "INDUSTRIAL",
    11112: "DICOM",
    11211: "MEMCACHED",
    27017: "MONGODB",
    50100: "SCADA"
}


def connect_redis(redis_ip):
    global redis_client
    try:
        # Check if existing connection is alive
        if redis_client:
            redis_client.ping()
            return redis_client
    except Exception:
        # Connection lost or invalid, reset
        pass
    
    # Create new connection
    redis_client = redis.StrictRedis(host=redis_ip, port=6379, db=0)
    return redis_client


def push_honeypot_stats(honeypot_stats):
    redis_instance = connect_redis(redis_ip)
    tmp = json.dumps(honeypot_stats)
    # print(tmp)
    redis_instance.publish(redis_channel, tmp)


def get_honeypot_stats(timedelta):
    ES_query_stats = {
        "bool": {
            "must": [],
            "filter": [
                {
                    "terms": {
                        "type.keyword": [
                            "Adbhoney", "Beelzebub", "Ciscoasa", "CitrixHoneypot", "ConPot",
                            "Cowrie", "Ddospot", "Dicompot", "Dionaea", "ElasticPot", 
                            "Endlessh", "Galah", "Glutton", "Go-pot", "H0neytr4p", "Hellpot", "Heralding", 
                            "Honeyaml", "Honeytrap", "Honeypots", "Log4pot", "Ipphoney", "Mailoney", 
                            "Medpot", "Miniprint", "RDPHoneypot", "Redishoneypot", "Sentrypeer", "Tanner",
                            "Wordpot"
                        ]
                    }
                },
                {
                    "range": {
                        "@timestamp": {
                            "format": "strict_date_optional_time",
                            "gte": "now-" + timedelta,
                            "lte": "now"
                        }
                    }
                },
                {
                    "exists": {
                        "field": "geoip.ip"
                    }
                }
            ]
        }
    }
    return ES_query_stats


# Deterministic event polling (security review 2026-09-02). The old query
# used size=100 WITHOUT sort: with >100 hits per window an arbitrary subset
# was forwarded and the watermark advanced anyway — silent, biased loss under
# event floods. Now: sorted by @timestamp ascending, paged via search_after,
# and the watermark only ever moves to the timestamp of the last event that
# was actually processed. The page cap keeps one poll tick bounded; if it is
# reached, the map deliberately samples (Kibana/ES remain the system of
# record) and says so in the log.
EVENT_PAGE_SIZE = 100
MAX_EVENT_PAGES_PER_POLL = 10
MAX_WATERMARK_LAG_S = 60
PIT_KEEP_ALIVE = "10s"


def build_event_query(gt_ts, lte_ts):
    return {
        "bool": {
            "must": [
                {
                    "query_string": {
                        "query": (
                            "type:(Adbhoney OR Beelzebub OR Ciscoasa OR CitrixHoneypot OR ConPot OR Cowrie "
                            "OR Ddospot OR Dicompot OR Dionaea OR ElasticPot OR Endlessh OR Galah OR Glutton OR Go-pot OR H0neytr4p "
                            "OR Hellpot OR Heralding OR Honeyaml OR Honeypots OR Honeytrap OR Ipphoney OR Log4pot OR Mailoney "
                            "OR Medpot OR Miniprint OR RDPHoneypot OR Redishoneypot OR Sentrypeer OR Tanner OR Wordpot)"
                        )
                    }
                }
            ],
            "filter": [
                {
                    "range": {
                        "@timestamp": {
                            "gt": gt_ts,
                            "lte": lte_ts
                        }
                    }
                }
            ]
        }
    }


def fetch_new_events(es_client, gt_ts, lte_ts):
    """Fetch every event in (gt_ts, lte_ts], oldest first, paged via
    search_after and bounded by MAX_EVENT_PAGES_PER_POLL pages per call.
    Runs inside a point in time: PIT searches get the unique _shard_doc
    tiebreaker appended to the sort automatically, so page boundaries that
    fall inside a group of equal @timestamp values lose nothing (the full
    per-hit sort tuple is handed to search_after).
    Returns (hits, last_timestamp_or_None, saturated)."""
    query = build_event_query(gt_ts, lte_ts)
    pit_id = es_client.open_point_in_time(
        index="logstash-*", keep_alive=PIT_KEEP_ALIVE)["id"]
    hits_out = []
    search_after = None
    saturated = False
    try:
        for page in range(MAX_EVENT_PAGES_PER_POLL):
            kwargs = dict(size=EVENT_PAGE_SIZE, query=query,
                          sort=[{"@timestamp": "asc"}],
                          pit={"id": pit_id, "keep_alive": PIT_KEEP_ALIVE})
            if search_after is not None:
                kwargs["search_after"] = search_after
            res = es_client.search(**kwargs)
            pit_id = res.get("pit_id", pit_id)
            page_hits = res["hits"]["hits"]
            hits_out.extend(page_hits)
            if len(page_hits) < EVENT_PAGE_SIZE:
                break
            search_after = page_hits[-1]["sort"]
        else:
            saturated = True
    finally:
        try:
            es_client.close_point_in_time(id=pit_id)
        except Exception:
            pass
    last_ts = hits_out[-1]["_source"]["@timestamp"] if hits_out else None
    return hits_out, last_ts, saturated


def _parse_ts(ts):
    """ES timestamps may be timezone-aware ('...Z'); window bounds are naive
    UTC — normalise everything to naive UTC for arithmetic."""
    dt = datetime.datetime.fromisoformat(ts)
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.UTC).replace(tzinfo=None)
    return dt


def advance_watermark(current, last_ts, window_end, saturated,
                      max_lag_s=MAX_WATERMARK_LAG_S):
    """Watermark policy (maintainer decision 2026-09-02): bursts are caught
    up completely; only under SUSTAINED overload — the watermark falling more
    than max_lag_s behind the window end despite a saturated poll — the live
    map skips ahead (and says so), keeping the view live. Kibana/Elasticsearch
    always remain the complete record.
    Returns (new_watermark, action) with action in
    idle | current | backlog | skipped."""
    if last_ts is None:
        return current, "idle"
    if not saturated:
        return last_ts, "current"
    lag = (_parse_ts(window_end) - _parse_ts(last_ts)).total_seconds()
    if lag > max_lag_s:
        return window_end, "skipped"
    return last_ts, "backlog"


def update_honeypot_data():
    global was_disconnected_es, was_disconnected_redis
    processed_data = []
    last = {"1m", "1h", "24h"}
    mydelta = 10
    # Watermark: ES timestamp string of the last event actually processed;
    # the next window is exclusive (gt) of it. Starts at now - mydelta.
    watermark = (datetime.datetime.now(datetime.UTC)
                 - datetime.timedelta(seconds=mydelta)).replace(tzinfo=None).isoformat()
    last_stats_time = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=10)
    while True:
        now = datetime.datetime.now(datetime.UTC)
        # Get the honeypot stats every 10s (last 1m, 1h, 24h)
        if (now - last_stats_time).total_seconds() >= 10:
            last_stats_time = now
            honeypot_stats = {}
            for i in last:
                try:
                    es_honeypot_stats = es.search(index="logstash-*", aggs={}, size=0, track_total_hits=True, query=get_honeypot_stats(i))
                    honeypot_stats.update({"last_"+i: es_honeypot_stats['hits']['total']['value']})
                except Exception as e:
                    # Connection errors are handled by outer exception handler
                    pass
            honeypot_stats.update({"type": "Stats"})
            push_honeypot_stats(honeypot_stats)

        # Fetch every new honeypot event since the watermark (deterministic,
        # sorted + paged; bounded per tick) up to now - mydelta, which leaves
        # Elasticsearch mydelta seconds of indexing lag.
        window_end = (datetime.datetime.now(datetime.UTC)
                      - datetime.timedelta(seconds=mydelta)).replace(tzinfo=None).isoformat()
        hits, last_ts, saturated = fetch_new_events(es, watermark, window_end)
        watermark, action = advance_watermark(watermark, last_ts, window_end, saturated)
        if action == "backlog":
            behind = (_parse_ts(window_end) - _parse_ts(watermark)).total_seconds()
            print(f"[!] Event burst: the live map is catching up ({behind:.0f}s behind).")
        elif action == "skipped":
            print(f"[!] Sustained overload (> {MAX_WATERMARK_LAG_S}s behind at "
                  f"{EVENT_PAGE_SIZE * MAX_EVENT_PAGES_PER_POLL} events per poll): "
                  "the live map skips ahead to stay live — "
                  "Kibana/Elasticsearch remain complete.")
        if hits:
            for hit in hits:
                try:
                    process_datas = process_data(hit)
                    if process_datas != None:
                        processed_data.append(process_datas)
                except Exception:
                    pass
        if len(processed_data) != 0:
            push(processed_data)
            processed_data = []
        time.sleep(0.5)


def process_data(hit):
    alert = {}
    alert["honeypot"] = hit["_source"]["type"]
    alert["country"] = hit["_source"]["geoip"].get("country_name", "")
    alert["country_code"] = hit["_source"]["geoip"].get("country_code2", "")
    alert["continent_code"] = hit["_source"]["geoip"].get("continent_code", "")
    alert["dst_lat"] = hit["_source"]["geoip_ext"]["latitude"]
    alert["dst_long"] = hit["_source"]["geoip_ext"]["longitude"]
    alert["dst_ip"] = hit["_source"]["geoip_ext"]["ip"]
    alert["dst_iso_code"] = hit["_source"]["geoip_ext"].get("country_code2", "")
    alert["dst_country_name"] = hit["_source"]["geoip_ext"].get("country_name", "")
    alert["tpot_hostname"] = hit["_source"]["t-pot_hostname"]
    try:
        # Parse ISO timestamp (handles 'Z' in Python 3.11+)
        dt = datetime.datetime.fromisoformat(hit["_source"]["@timestamp"])
        alert["event_time"] = dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        # Fallback to original slicing if parsing fails
        alert["event_time"] = str(hit["_source"]["@timestamp"][0:10]) + " " + str(hit["_source"]["@timestamp"][11:19])
    alert["iso_code"] = hit["_source"]["geoip"]["country_code2"]
    alert["latitude"] = hit["_source"]["geoip"]["latitude"]
    alert["longitude"] = hit["_source"]["geoip"]["longitude"]
    alert["dst_port"] = hit["_source"]["dest_port"]
    alert["protocol"] = port_to_type(hit["_source"]["dest_port"])
    alert["src_ip"] = hit["_source"]["src_ip"]
    try:
        alert["src_port"] = hit["_source"]["src_port"]
    except Exception:
        alert["src_port"] = 0
    try:
        alert["ip_rep"] = hit["_source"]["ip_rep"]
    except Exception:
        alert["ip_rep"] = "reputation unknown"
    if not alert["src_ip"] == "":
        try:
            alert["color"] = service_rgb[alert["protocol"].upper()]
        except Exception:
            alert["color"] = service_rgb["OTHER"]
        return alert
    else:
        print("SRC IP EMPTY")
        return None


def port_to_type(port):
    try:
        return PORT_MAP.get(int(port), "OTHER")
    except Exception:
        return "OTHER"


def push(alerts):
    global event_count

    redis_instance = connect_redis(redis_ip)

    for alert in alerts:
        if output_text == "ENABLED":
            # Convert UTC to local time
            my_time = datetime.datetime.strptime(alert["event_time"], "%Y-%m-%d %H:%M:%S")
            my_time = my_time.replace(tzinfo=pytz.UTC)  # Assuming event_time is in UTC
            local_event_time = my_time.astimezone(local_tz)
            local_event_time = local_event_time.strftime("%Y-%m-%d %H:%M:%S")

            # Build the table data
            table_data = [
                [local_event_time, alert["country"], alert["src_ip"], alert["ip_rep"].title(),
                 alert["protocol"], alert["honeypot"], alert["tpot_hostname"]]
            ]

            # Define the minimum width for each column
            min_widths = [19, 20, 15, 18, 10, 14, 14]

            # Format and print each line with aligned columns
            for row in table_data:
                formatted_line = " | ".join(
                    "{:<{width}}".format(str(value), width=min_widths[i]) for i, value in enumerate(row))
                print(formatted_line)

        json_data = {
            "protocol": alert["protocol"],
            "color": alert["color"],
            "iso_code": alert["iso_code"],
            "honeypot": alert["honeypot"],
            "src_port": alert["src_port"],
            "event_time": alert["event_time"],
            "src_lat": alert["latitude"],
            "src_ip": alert["src_ip"],
            "ip_rep": alert["ip_rep"].title(),
            "type": "Traffic",
            "dst_long": alert["dst_long"],
            "continent_code": alert["continent_code"],
            "dst_lat": alert["dst_lat"],
            "event_count": event_count,
            "country": alert["country"],
            "src_long": alert["longitude"],
            "dst_port": alert["dst_port"],
            "dst_ip": alert["dst_ip"],
            "dst_iso_code": alert["dst_iso_code"],
            "dst_country_name": alert["dst_country_name"],
            "tpot_hostname": alert["tpot_hostname"]
        }
        event_count += 1
        tmp = json.dumps(json_data)
        redis_instance.publish(redis_channel, tmp)


def check_connections():
    """Check both Elasticsearch and Redis connections on startup."""
    print("[*] Checking connections...")
    
    es_ready = False
    redis_ready = False
    es_waiting_printed = False
    redis_waiting_printed = False
    
    while not (es_ready and redis_ready):
        # Check Elasticsearch
        if not es_ready:
            try:
                es.info()
                print("[*] Elasticsearch connection established")
                es_ready = True
            except Exception as e:
                if not es_waiting_printed:
                    print(f"[...] Waiting for Elasticsearch... (Error: {type(e).__name__})")
                    es_waiting_printed = True
        
        # Check Redis
        if not redis_ready:
            try:
                r = redis.StrictRedis(host=redis_ip, port=6379, db=0)
                r.ping()
                print("[*] Redis connection established")
                redis_ready = True
            except Exception as e:
                if not redis_waiting_printed:
                    print(f"[...] Waiting for Redis... (Error: {type(e).__name__})")
                    redis_waiting_printed = True
        
        # If both not ready, wait before retrying
        if not (es_ready and redis_ready):
            time.sleep(5)
    
    return True

def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=version)
    parser.add_argument('--redis-host', default=DEFAULT_REDIS_HOST,
                        help=f'Redis host (default: {DEFAULT_REDIS_HOST})')
    parser.add_argument('--es-url', default=DEFAULT_ES_URL,
                        help=f'Elasticsearch URL (default: {DEFAULT_ES_URL})')
    return parser.parse_args(argv)


if __name__ == '__main__':
    cli_args = parse_args()
    redis_ip = cli_args.redis_host
    es = Elasticsearch(cli_args.es_url)
    print(version)

    # Check both connections on startup
    check_connections()
    print("[*] Starting data server...\n")
    
    try:
        while True:
            try:
                update_honeypot_data()
            except Exception as e:
                error_type = type(e).__name__
                error_msg = str(e)
                
                # Check for Redis errors
                if "6379" in error_msg or "Redis" in error_msg or "redis" in error_msg.lower():
                    if not was_disconnected_redis:
                        print(f"[ ] Connection lost to Redis ({error_type}), retrying...")
                        was_disconnected_redis = True
                # Check for Elasticsearch errors
                elif "Connection" in error_type or "urllib3" in error_msg or "elastic" in error_msg.lower():
                    if not was_disconnected_es:
                        print(f"[ ] Connection lost to Elasticsearch ({error_type}), retrying...")
                        was_disconnected_es = True
                else:
                    # DEBUG: Show unmatched errors to improve detection
                    print(f"[ ] Error: {error_type}: {error_msg}")
                    print(f"[DEBUG] Error details - Type: '{error_type}', Message: '{error_msg}'")
                
                # Proactively check connections to ensure we catch all failures
                if not was_disconnected_redis:
                    try:
                        r = connect_redis(redis_ip)
                        r.ping()
                    except:
                        print("[ ] Connection lost to Redis (Check), retrying...")
                        was_disconnected_redis = True
                
                if not was_disconnected_es:
                    try:
                        es.info()
                    except:
                        print("[ ] Connection lost to Elasticsearch (Check), retrying...")
                        was_disconnected_es = True

                time.sleep(5)
                if was_disconnected_es:
                    try:
                        es.info()
                        print("[*] Elasticsearch connection re-established")
                        was_disconnected_es = False
                    except:
                        pass
                
                # Test Redis
                if was_disconnected_redis:
                    try:
                        r = connect_redis(redis_ip)
                        r.ping()
                        print("[*] Redis connection re-established")
                        was_disconnected_redis = False
                    except:
                        pass

    except KeyboardInterrupt:
        print('\nSHUTTING DOWN')
        exit()
