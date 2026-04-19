#!/bin/bash
# Blocks `git push` operations that target main/master, whether specified
# explicitly or implied by the current branch.
set -eu

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

echo "$CMD" | grep -qE '^\s*git\s+push' || exit 0

# Explicit main/master as argument or refspec
if echo "$CMD" | grep -qE '(^|\s|:)(main|master)(\s|:|$)'; then
  echo "Blocked: push targets main/master: $CMD" >&2
  exit 2
fi

# Bare `git push` or `git push <remote>` — rely on current branch
if echo "$CMD" | grep -qE '^\s*git\s+push(\s+(-[a-zA-Z-]+\s+)*[A-Za-z0-9_.-]+)?\s*$'; then
  CUR=$(git branch --show-current 2>/dev/null || echo "")
  if [ "$CUR" = "main" ] || [ "$CUR" = "master" ]; then
    echo "Blocked: current branch is $CUR; push to main/master not allowed" >&2
    exit 2
  fi
fi

exit 0
