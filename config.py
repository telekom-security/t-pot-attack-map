"""Shared configuration loader for DataServer and AttackMapServer.

Loads config.toml from the project root if present, merging with built-in
defaults (which match the Docker environment). When config.toml is
absent the defaults apply unchanged, so existing Docker deployments need no
changes.
"""

import tomllib
from pathlib import Path

_DEFAULTS = {
    "ui": {
        "title": "Attack Map",
        "text_output": True,
    },
    "opensearch": {
        "url": "http://elasticsearch:9200",
        "index": "logstash-*",
        "username": "",
        "password": "",
        "verify_certs": True,
    },
    "valkey": {
        "host": "map_redis",
        "port": 6379,
        "channel": "attack-map-production",
    },
    "server": {
        "web_port": 64299,
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def load() -> dict:
    """Return merged config: defaults + any values from config.toml."""
    config_path = Path(__file__).parent / "config.toml"
    if not config_path.exists():
        return _DEFAULTS
    with open(config_path, "rb") as f:
        user_config = tomllib.load(f)
    return _deep_merge(_DEFAULTS, user_config)
