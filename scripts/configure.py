#!/usr/bin/env python3
"""Render Asterisk configuration from a private env file; never print secrets."""

import ipaddress
import os
from pathlib import Path
import re
import secrets
import stat
import sys

ROOT = Path(__file__).resolve().parent.parent
ASTERISK = ROOT / "asterisk"
ENV_FILE = ASTERISK / "secrets.env"


def load_env():
    if not ENV_FILE.exists():
        raise ValueError("Copy asterisk/secrets.env.example to asterisk/secrets.env and fill required values")
    ENV_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)
    values = {}
    for raw in ENV_FILE.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("Invalid secrets.env line (expected NAME=value)")
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Z_]+", key) or key in values:
            raise ValueError("Invalid or duplicate secrets.env key")
        values[key] = value
    return values


def required(values, key, pattern):
    value = values.get(key, "")
    if not re.fullmatch(pattern, value) or value.startswith("REQUIRED_"):
        raise ValueError(f"Set a valid {key} in asterisk/secrets.env")
    return value


def render(source, destination, replacements):
    template = source.read_text()
    for name, value in replacements.items():
        if name not in template:
            raise ValueError(f"Missing template placeholder {name} in {source.name}")
        template = template.replace(name, value)
    destination.write_text(template)
    destination.chmod(stat.S_IRUSR | stat.S_IWUSR)


def main():
    values = load_env()
    for key in ("ASTERISK_PUBLIC_IP", "GATEWAY_PUBLIC_IP"):
        address = required(values, key, r"[0-9.]+")
        if not ipaddress.ip_address(address).version == 4:
            raise ValueError(f"{key} must be IPv4")
    sip_id = required(values, "EL_SIP_ID", r"[a-zA-Z0-9_-]{1,64}")
    sip_user = required(values, "EL_SIP_USER", r"[a-zA-Z0-9_.-]{1,64}")
    sip_pass = required(values, "EL_SIP_PASS", r"[^\s;\r\n]{12,128}")
    required(values, "DIAL_COUNTRY_CODE", r"[1-9][0-9]{0,2}")
    required(values, "DIAL_NATIONAL_PREFIX", r"[0-9]{1,3}")
    length = int(required(values, "DIAL_LOCAL_LENGTH", r"[0-9]{1,2}"))
    if not 5 <= length <= 12:
        raise ValueError("DIAL_LOCAL_LENGTH must be between 5 and 12")

    for key, size in (("AMI_SECRET", 32), ("DASHBOARD_TOKEN", 32)):
        if not values.get(key):
            values[key] = secrets.token_hex(size)
            with ENV_FILE.open("a") as file:
                file.write(f"{key}={values[key]}\n")
        required(values, key, r"[a-zA-Z0-9_.-]{24,128}")
    ENV_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)

    config = ASTERISK / "etc"
    render(config / "pjsip.conf.example", config / "pjsip.conf", {
        "ASTERISK_PUBLIC_IP": values["ASTERISK_PUBLIC_IP"],
        "GATEWAY_PUBLIC_IP": values["GATEWAY_PUBLIC_IP"],
        "CHANGE_ME_EL_SIP_PASS": sip_pass,
        "EL_SIP_USER_PLACEHOLDER": sip_user,
    })
    render(config / "extensions.conf.example", config / "extensions.conf", {
        "EL_SIP_ID_PLACEHOLDER": sip_id,
    })
    render(config / "manager.conf.example", config / "manager.conf", {
        "CHANGE_ME_AMI_SECRET": values["AMI_SECRET"],
    })
    print("Generated private Asterisk configuration in asterisk/etc/")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        sys.exit(1)
