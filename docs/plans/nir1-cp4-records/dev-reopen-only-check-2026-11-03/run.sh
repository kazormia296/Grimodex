#!/usr/bin/env bash
# dev の確認（CP-4 に数えない）: 開き直しだけで宣言が残るか。引数＝run 名（reopen-only-<n>）。
set -u
RUN=${1:?run name}
W=/home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th
D=/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/s4-5th/reopen-check
M=/home/grimodex/.cache/gdx-nir1/grimodex-product-6x99bC/user-data/models
S=$D/reopen-only-check.mjs
P=$D/progress-$RUN
log() { echo "[$(date -u +%FT%TZ)] $*" >> $P; }
: > $P
cd $W || { log "no worktree"; exit 1; }
eval "$(fnm env --shell bash)"
mkdir -p /tmp/gr5
[ -z "$(git status --porcelain --untracked-files=all)" ] || { log "STOP worktree not clean"; exit 1; }
log "start HEAD=$(git rev-parse --short HEAD) script_sha256=$(sha256sum $S | cut -d' ' -f1) load=$(cut -d' ' -f1-3 /proc/loadavg)"
env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u DBUS_SESSION_BUS_ADDRESS -u WAYLAND_SOCKET \
  -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
  ELECTRON_OZONE_PLATFORM_HINT=x11 TMPDIR=/tmp/gr5 node scripts/local-ci-xvfb.mjs node $S --run $RUN \
  --setup .artifacts/cp4/s45-preview-setup/setup/setup-receipt.json --negative K24-G01-N2 --samples 3 \
  --ja-model $M/ruri-v3-30m/model_int8.onnx --en-model $M/bge-small-en-v15/model_int8.onnx > $D/$RUN.log 2>&1
RC=$?
log "exit=$RC"
log "status: [$(git status --porcelain --untracked-files=all | head -5)]"
tail -n 1 $D/$RUN.log >> $P
