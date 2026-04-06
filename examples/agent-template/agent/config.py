"""Configuration loading and validation for the OpenEAGO agent template."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("pip install PyYAML", file=sys.stderr)
    sys.exit(1)

DEFAULTS: dict = {
    "server": {"host": "127.0.0.1", "port": 9000, "transport": "streamable-http"},
    "metadata": {
        "name": "open-eago-mcp-agent",
        "version": "0.1.0",
        "eago_phases": [],
        "capabilities": [],
        "tags": [],
    },
    "agent": {
        "capability_codes": [],
        "version": "0.1.0",
        "health_status": "healthy",
        "reliability": 0.99,
        "endpoints": {},
        "compliance": [],
        "tags": {},
    },
    "mcp": {"protocol_version": "2024-11-05", "eago_envelope": False},
    "spire": {
        "enabled": True,
        "cert_path": os.environ.get("SPIRE_CERT_PATH", "/tmp/svid.0.pem"),
        "key_path": os.environ.get("SPIRE_KEY_PATH", "/tmp/svid.0.key"),
        "bundle_path": os.environ.get("SPIRE_BUNDLE_PATH", "/tmp/bundle.0.pem"),
    },
    "bootstrap": {"urls": [], "sync_interval": 30, "status_interval": 10},
}

CANONICAL_PHASES: frozenset[str] = frozenset({
    "contract_management",
    "planning_negotiation",
    "validation_compliance",
    "execution_resilience",
    "context_state_management",
    "communication_delivery",
})


def deep_merge(target: dict, source: dict | None) -> dict:
    if source is None:
        return target
    out = dict(target)
    for k, v in source.items():
        if isinstance(v, dict) and not isinstance(v.get("_"), type):
            out[k] = deep_merge(out.get(k) or {}, v)
        else:
            out[k] = v
    return out


def validate_config(config: dict) -> None:
    """Validate config fields at startup and exit with a clear error on failure."""
    errors: list[str] = []

    meta = config.get("metadata") or {}
    if not meta.get("name"):
        errors.append("metadata.name is required")
    if not meta.get("version"):
        errors.append("metadata.version is required")
    for phase in meta.get("eago_phases") or []:
        if phase not in CANONICAL_PHASES:
            errors.append(
                f"metadata.eago_phases: '{phase}' is not a canonical OpenEAGO phase. "
                f"Valid values: {sorted(CANONICAL_PHASES)}"
            )

    agent = config.get("agent") or {}
    reliability = agent.get("reliability")
    if reliability is not None and not (0.0 <= float(reliability) <= 1.0):
        errors.append(f"agent.reliability must be in 0.0..1.0, got {reliability}")
    uptime = agent.get("uptime_percentage")
    if uptime is not None and not (0.0 <= float(uptime) <= 100.0):
        errors.append(f"agent.uptime_percentage must be in 0.0..100.0, got {uptime}")

    bootstrap = config.get("bootstrap") or {}
    if (bootstrap.get("sync_interval") or 30) <= 0:
        errors.append("bootstrap.sync_interval must be > 0")
    if (bootstrap.get("status_interval") or 10) <= 0:
        errors.append("bootstrap.status_interval must be > 0")

    spire = config.get("spire") or {}
    if spire.get("enabled") and not config.get("_allow_insecure"):
        for key in ("cert_path", "key_path", "bundle_path"):
            if not spire.get(key):
                errors.append(f"spire.{key} must be set when spire.enabled is true")

    if errors:
        for e in errors:
            print(f"[demo-agent] Config error: {e}", file=sys.stderr)
        sys.exit(1)


def load_config(args: argparse.Namespace, base_dir: Path) -> dict:
    config_path = args.config or (base_dir / "config.yaml")
    if not config_path.exists():
        config_path = base_dir / "config.example.yaml"
    if not config_path.exists():
        print("No config.yaml or config.example.yaml found", file=sys.stderr)
        sys.exit(1)
    with open(config_path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    config = deep_merge(DEFAULTS, data)
    if args.port is not None:
        config["server"]["port"] = args.port
    config["_do_register"] = not args.no_register
    config["_allow_insecure"] = getattr(args, "allow_insecure", False)
    validate_config(config)
    return config
