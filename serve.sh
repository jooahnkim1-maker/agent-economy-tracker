#!/bin/sh
# 로컬 미리보기. file:// 로 열면 fetch가 막히므로 반드시 HTTP로 띄운다.
PORT="${1:-8420}"
echo "→ http://localhost:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
