import datetime
import json
import time
import os
import pytz
import valkey
from opensearchpy import OpenSearch
from tzlocal import get_localzone

import config as _config
cfg = _config.load()

_os_cfg = cfg['opensearch']
_os_kwargs = {}
if _os_cfg['username']:
    _os_kwargs['http_auth'] = (_os_cfg['username'], _os_cfg['password'])
if _os_cfg['url'].startswith('https'):
    _os_kwargs['use_ssl'] = True
    _os_kwargs['verify_certs'] = _os_cfg['verify_certs']
    _os_kwargs['ssl_show_warn'] = _os_cfg['verify_certs']
es = OpenSearch(_os_cfg['url'], **_os_kwargs)
valkey_ip = cfg['valkey']['host']
valkey_channel = cfg['valkey']['channel']
_index = cfg['opensearch']['index']
version = 'Data Server 3.0.0'
local_tz = get_localzone()

# GEOIP_ATTACKMAP_TEXT env var takes precedence over config file for compatibility
_env_text = os.getenv("GEOIP_ATTACKMAP_TEXT")
if _env_text is not None:
    output_text = _env_text.upper()
else:
    output_text = "ENABLED" if cfg['ui']['text_output'] else "DISABLED"

# Track disconnection state for reconnection messages
was_disconnected_es = False
was_disconnected_valkey = False

# Global Valkey client for persistent connection
valkey_client = None

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


def connect_valkey(valkey_ip):
    global valkey_client
    try:
        # Check if existing connection is alive
        if valkey_client:
            valkey_client.ping()
            return valkey_client
    except Exception:
        # Connection lost or invalid, reset
        pass

    # Create new connection
    valkey_client = valkey.Valkey(host=valkey_ip, port=6379, db=0)
    return valkey_client


def push_honeypot_stats(honeypot_stats):
    valkey_instance = connect_valkey(valkey_ip)
    tmp = json.dumps(honeypot_stats)
    # print(tmp)
    valkey_instance.publish(valkey_channel, tmp)


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
                            "Medpot", "Miniprint", "Redishoneypot", "Sentrypeer", "Tanner", "Wordpot"
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


def update_honeypot_data():
    global was_disconnected_es, was_disconnected_valkey
    processed_data = []
    last = {"1m", "1h", "24h"}
    mydelta = 10
    # Using timezone-aware UTC datetime (Python 3.14+ requirement)
    time_last_request = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=mydelta)
    last_stats_time = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=10)
    while True:
        now = datetime.datetime.now(datetime.UTC)
        # Get the honeypot stats every 10s (last 1m, 1h, 24h)
        if (now - last_stats_time).total_seconds() >= 10:
            last_stats_time = now
            honeypot_stats = {}
            for i in last:
                try:
                    es_honeypot_stats = es.search(index=_index, body={"aggs": {}, "size": 0, "track_total_hits": True, "query": get_honeypot_stats(i)})
                    honeypot_stats.update({"last_"+i: es_honeypot_stats['hits']['total']['value']})
                except Exception as e:
                    # Connection errors are handled by outer exception handler
                    pass
            honeypot_stats.update({"type": "Stats"})
            push_honeypot_stats(honeypot_stats)

        # Get the last 100 new honeypot events every 0.5s
        # Convert timezone-aware datetime to naive for consistent string formatting with ES
        mylast_dt = time_last_request.replace(tzinfo=None)
        mynow_dt = (datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=mydelta)).replace(tzinfo=None)

        mylast = str(mylast_dt).split(" ")
        mynow = str(mynow_dt).split(" ")

        ES_query = {
            "bool": {
                "must": [
                    {
                        "query_string": {
                            "query": (
                                "type:(Adbhoney OR Beelzebub OR Ciscoasa OR CitrixHoneypot OR ConPot OR Cowrie "
                                "OR Ddospot OR Dicompot OR Dionaea OR ElasticPot OR Endlessh OR Galah OR Glutton OR Go-pot OR H0neytr4p "
                                "OR Hellpot OR Heralding OR Honeyaml OR Honeypots OR Honeytrap OR Ipphoney OR Log4pot OR Mailoney "
                                "OR Medpot OR Miniprint OR Redishoneypot OR Sentrypeer OR Tanner OR Wordpot)"
                            )
                        }
                    }
                ],
                "filter": [
                    {
                        "range": {
                            "@timestamp": {
                                "gte": mylast[0] + "T" + mylast[1],
                                "lte": mynow[0] + "T" + mynow[1]
                            }
                        }
                    }
                ]
            }
        }

        res = es.search(index=_index, body={"size": 100, "query": ES_query})
        hits = res['hits']
        if len(hits['hits']) != 0:
            time_last_request = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=mydelta)
            for hit in hits['hits']:
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
    alert["honeypot_hostname"] = hit["_source"]["honeypot_hostname"]
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

    valkey_instance = connect_valkey(valkey_ip)

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
                 alert["protocol"], alert["honeypot"], alert["honeypot_hostname"]]
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
            "honeypot_hostname": alert["honeypot_hostname"]
        }
        event_count += 1
        tmp = json.dumps(json_data)
        valkey_instance.publish(valkey_channel, tmp)


def check_connections():
    """Check both Elasticsearch and Valkey connections on startup."""
    print("[*] Checking connections...")

    es_ready = False
    valkey_ready = False
    es_waiting_printed = False
    valkey_waiting_printed = False

    while not (es_ready and valkey_ready):
        # Check Elasticsearch
        if not es_ready:
            try:
                es.info()
                print("[*] OpenSearch connection established")
                es_ready = True
            except Exception as e:
                if not es_waiting_printed:
                    print(f"[...] Waiting for OpenSearch... (Error: {type(e).__name__})")
                    es_waiting_printed = True

        # Check Valkey
        if not valkey_ready:
            try:
                r = valkey.Valkey(host=valkey_ip, port=6379, db=0)
                r.ping()
                print("[*] Valkey connection established")
                valkey_ready = True
            except Exception as e:
                if not valkey_waiting_printed:
                    print(f"[...] Waiting for Valkey... (Error: {type(e).__name__})")
                    valkey_waiting_printed = True

        # If both not ready, wait before retrying
        if not (es_ready and valkey_ready):
            time.sleep(5)

    return True

if __name__ == '__main__':
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

                # Check for Valkey errors
                if "6379" in error_msg or "Valkey" in error_msg or "valkey" in error_msg.lower():
                    if not was_disconnected_valkey:
                        print(f"[ ] Connection lost to Valkey ({error_type}), retrying...")
                        was_disconnected_valkey = True
                # Check for Elasticsearch errors
                elif "Connection" in error_type or "urllib3" in error_msg or "elastic" in error_msg.lower() or "opensearch" in error_msg.lower():
                    if not was_disconnected_es:
                        print(f"[ ] Connection lost to OpenSearch ({error_type}), retrying...")
                        was_disconnected_es = True
                else:
                    # DEBUG: Show unmatched errors to improve detection
                    print(f"[ ] Error: {error_type}: {error_msg}")
                    print(f"[DEBUG] Error details - Type: '{error_type}', Message: '{error_msg}'")

                # Proactively check connections to ensure we catch all failures
                if not was_disconnected_valkey:
                    try:
                        r = connect_valkey(valkey_ip)
                        r.ping()
                    except:
                        print("[ ] Connection lost to Valkey (Check), retrying...")
                        was_disconnected_valkey = True

                if not was_disconnected_es:
                    try:
                        es.info()
                    except:
                        print("[ ] Connection lost to OpenSearch (Check), retrying...")
                        was_disconnected_es = True

                time.sleep(5)
                if was_disconnected_es:
                    try:
                        es.info()
                        print("[*] OpenSearch connection re-established")
                        was_disconnected_es = False
                    except:
                        pass

                # Test Valkey
                if was_disconnected_valkey:
                    try:
                        r = connect_valkey(valkey_ip)
                        r.ping()
                        print("[*] Valkey connection re-established")
                        was_disconnected_valkey = False
                    except:
                        pass

    except KeyboardInterrupt:
        print('\nSHUTTING DOWN')
        exit()
