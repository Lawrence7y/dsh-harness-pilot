#!/bin/bash
# 兼容 dev_build_plugin 的入口：真正逻辑在 build.mjs（Windows 路径友好）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/build.mjs"
