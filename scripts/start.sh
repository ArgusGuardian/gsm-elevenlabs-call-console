#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 scripts/configure.py
docker compose -f asterisk/compose.yaml up -d --build
