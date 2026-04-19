#!/bin/bash
# Blocks Bash-mediated reads of sensitive files that the glob-based
# `Read(...)` deny list does not cover (e.g. head/od/xxd/python -c).
set -eu

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

SENSITIVE='(\.env(\.[A-Za-z0-9_-]*)?|\.pem\b|\.key\b|id_rsa|id_ed25519|credentials\.json|\.netrc|\.npmrc|secrets\.)'
READERS='\b(cat|head|tail|less|more|od|xxd|strings|base64|hexdump|awk|sed|grep|diff|tee|cp|mv|scp|rsync|python|python3|node|ruby|perl|tar|zip|gzip)\b'

if echo "$CMD" | grep -qE "$SENSITIVE" && echo "$CMD" | grep -qE "$READERS"; then
  echo "Blocked: sensitive file access via Bash: $CMD" >&2
  exit 2
fi

exit 0
