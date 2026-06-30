#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

open_firewall() {
  echo "Opening firewall (OUTPUT ACCEPT, allowlist disabled)..."
  echo "Re-enable: sudo /usr/local/bin/init-firewall.sh"

  local docker_dns_rules
  docker_dns_rules=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

  iptables -P INPUT ACCEPT
  iptables -P FORWARD ACCEPT
  iptables -P OUTPUT ACCEPT

  iptables -F
  iptables -X
  iptables -t nat -F
  iptables -t nat -X
  iptables -t mangle -F
  iptables -t mangle -X
  ipset destroy allowed-domains 2>/dev/null || true

  if [ -n "$docker_dns_rules" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$docker_dns_rules" | xargs -L 1 iptables -t nat
  fi

  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A INPUT -p udp --sport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
  iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
  iptables -A INPUT -i lo -j ACCEPT
  iptables -A OUTPUT -o lo -j ACCEPT

  local host_ip host_network
  host_ip=$(ip route | grep default | cut -d" " -f3 || true)
  if [ -n "$host_ip" ]; then
    host_network=$(echo "$host_ip" | sed "s/\.[0-9]*$/.0\/24/")
    echo "Host network detected as: $host_network"
    iptables -A INPUT -s "$host_network" -j ACCEPT
    iptables -A OUTPUT -d "$host_network" -j ACCEPT
  fi

  iptables -P INPUT ACCEPT
  iptables -P FORWARD ACCEPT
  iptables -P OUTPUT ACCEPT

  echo "Firewall paused — all outbound traffic allowed"
}

# SECURITY NOTE (accepted trade-off):
# This script is exposed to the unprivileged `node` user via a passwordless sudoers
# entry (Dockerfile: `node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh`),
# which accepts ANY argument. That means the in-container agent can run
# `sudo init-firewall.sh open` (or set GRIMODEX_FIREWALL_OPEN=1) to disable the
# egress allowlist. This is INTENTIONAL: the dev container's threat model treats the
# in-container agent as trusted, and the allowlist is a guardrail against accidental
# exfiltration / typo'd installs, not a hard boundary against a hostile in-container
# actor. `open` mode is OFF by default (no arg, no env var). If this firewall must
# ever become a boundary the agent cannot cross, move `open_firewall` into a separate
# script that is NOT in the NOPASSWD allowlist (require a real password) or enforce it
# host-side; do not rely on this gate alone.
if [[ "${1:-}" == "open" || "${GRIMODEX_FIREWALL_OPEN:-}" == "1" ]]; then
  open_firewall
  exit 0
fi

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Reset default policies to ACCEPT before flushing
# (prevents lockout when re-running: previous DROP policy survives flush)
iptables -P INPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -P OUTPUT ACCEPT

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# First allow DNS and localhost before any restrictions
# Allow outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT
# Allow outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Allow inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Create ipset with CIDR support
ipset create allowed-domains hash:net -exist

# Fetch GitHub meta information and aggregate + add their IP ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: GitHub API response missing required fields"
    exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
        exit 1
    fi
    echo "Adding GitHub range $cidr"
    ipset add allowed-domains "$cidr" -exist
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# Resolve and add other allowed domains
# lindera.dev / *.pyke.io: Grimodex の Rust ビルド依存。lindera-unidic の build.rs が
# lindera.dev から UniDic 辞書を、ort-sys が cdn.pyke.io から ONNX Runtime prebuilt を取得する。
# huggingface.co / cdn-lfs.huggingface.co: セマンティック検索用 ONNX モデル
# (ruri-v3-30m / bge-small-en-v1.5) の取得・export スクリプト用。
# api.platform.preferredai.jp / platform.preferredai.jp / docs.plamo.preferredai.jp:
# PLaMo API（OpenAI 互換 Chat Completions）と API コンソール・リファレンス。
# generativelanguage.googleapis.com / aiplatform.googleapis.com / oauth2.googleapis.com / ai.google.dev:
# Google Gemini API（Google AI Studio API key）、Vertex AI、OAuth2 トークン取得、API リファレンス。
# *.polar.sh: ライセンス認証 (Phase 3)。docs = API 仕様の突き合わせ、
# api = customer-portal 系エンドポイントの応答形実測（認証不要）。
for domain in \
    "registry.npmjs.org" \
    "auth.openai.com" \
    "api.openai.com" \
    "chatgpt.com" \
    "platform.openai.com" \
    "api.anthropic.com" \
    "openrouter.ai" \
    "console.sakana.ai" \
    "api.sakana.ai" \
    "api.platform.preferredai.jp" \
    "platform.preferredai.jp" \
    "docs.plamo.preferredai.jp" \
    "generativelanguage.googleapis.com" \
    "aiplatform.googleapis.com" \
    "oauth2.googleapis.com" \
    "ai.google.dev" \
    "sentry.io" \
    "statsig.anthropic.com" \
    "statsig.com" \
    "marketplace.visualstudio.com" \
    "vscode.blob.core.windows.net" \
    "update.code.visualstudio.com" \
    "crates.io" \
    "index.crates.io" \
    "static.crates.io" \
    "static.rust-lang.org" \
    "sh.rustup.rs" \
    "lindera.dev" \
    "cdn.pyke.io" \
    "cdn-lfs.huggingface.co" \
    "hf.co" \
    "huggingface.co" \
    "parcel.pyke.io" \
    "polar.sh" \
    "docs.polar.sh" \
    "api.polar.sh" \
    "support.apple.com" \
    "developer.apple.com"; do
    echo "Resolving $domain..."
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        echo "WARNING: Failed to resolve $domain (may use CNAME chain), trying with +short..."
        ips=$(dig +short A "$domain" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
    fi
    if [ -z "$ips" ]; then
        echo "WARNING: Could not resolve $domain, skipping"
        continue
    fi

    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "ERROR: Invalid IP from DNS for $domain: $ip"
            exit 1
        fi
        echo "Adding $ip for $domain"
        ipset add allowed-domains "$ip" -exist
    done < <(echo "$ips")
done

# Add CloudFront CIDR ranges (used by crates.io / static.crates.io)
echo "Fetching CloudFront IP ranges for crates.io..."
cf_ranges=$(curl -s https://ip-ranges.amazonaws.com/ip-ranges.json)
if [ -n "$cf_ranges" ]; then
    while read -r cidr; do
        if [[ "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
            ipset add allowed-domains "$cidr" -exist
        fi
    done < <(echo "$cf_ranges" | jq -r '.prefixes[] | select(.service == "CLOUDFRONT") | .ip_prefix')
    echo "Added CloudFront ranges"
else
    echo "WARNING: Failed to fetch CloudFront ranges"
fi

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3 || true)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# Set up remaining iptables rules
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Then allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

# Verify GitHub API access
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
