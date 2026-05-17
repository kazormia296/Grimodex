#!/bin/bash
# Blocks Bash-mediated writes to protected paths that the glob-based
# `Write(...)` / `Edit(...)` deny list does not cover (git apply,
# redirects, sed -i, cp/mv, editors, etc.).
set -eu

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

PROTECTED='(\.github/workflows/|\.claude/settings\.json|\.claude/hooks/|/\.env(\.[A-Za-z0-9_-]+)?\b)'

# 1. git apply / git am: 外部 patch ファイルから任意パスへ書ける。常に禁止。
if echo "$CMD" | grep -qE '\bgit\s+(apply|am)\b'; then
  echo "Blocked: 'git apply' / 'git am' is disabled (use Edit/Write tools or ask user). cmd: $CMD" >&2
  exit 2
fi

# 2. git checkout/restore/reset/clean: 保護パスを指すなら禁止。
if echo "$CMD" | grep -qE '\bgit\s+(checkout\s+--|restore|reset\s+--hard|clean\s+-[fdx]+)' \
   && echo "$CMD" | grep -qE "$PROTECTED"; then
  echo "Blocked: git op targets protected path: $CMD" >&2
  exit 2
fi

# 3. 保護パスへの書き込み手段 (redirect, in-place editor, copy, etc.)
WRITERS='((^|[[:space:]0-9&])>>?|\btee\b|\bsed\s+-i\b|\bperl\s+-i\b|\bcp\b|\bmv\b|\bdd\s+of=|\btruncate\b|\bpatch\b|\bpython3?\s+-c\b|\bnode\s+-e\b)'

if echo "$CMD" | grep -qE "$PROTECTED" && echo "$CMD" | grep -qE "$WRITERS"; then
  echo "Blocked: write to protected path via Bash: $CMD" >&2
  exit 2
fi

# 4. エディタ起動 (vim/nano/emacs/ed) で保護パスを開く
if echo "$CMD" | grep -qE '\b(vi|vim|nvim|nano|emacs|ed|ex)\s' && echo "$CMD" | grep -qE "$PROTECTED"; then
  echo "Blocked: editor invocation on protected path: $CMD" >&2
  exit 2
fi

exit 0
