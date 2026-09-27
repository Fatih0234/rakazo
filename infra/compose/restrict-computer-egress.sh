#!/usr/bin/env bash
# Restricted egress for Rakazo bot computers (SANDBOX_COMPUTER_EGRESS=restricted).
#
# Computers keep full public-internet egress (browsing, DNS, apt, git over SSH)
# but can no longer reach:
#   - the Docker host itself (INPUT drop; replies to host-initiated connections
#     stay open so supervisor control and published screen ports keep working),
#   - RFC1918 / CGNAT / link-local destinations, including cloud metadata at
#     169.254.169.254 (and AWS's IPv6 fd00:ec2::254),
#   - multicast and reserved space.
#
# Rules key on the deterministic bridge names the supervisor assigns in
# restricted mode (rakazo-c<hash>), never on Docker's dynamic subnets — so
# computer churn, network recreate, and subnet reuse need no firewall changes.
#
# Same-bridge peers stay reachable: the supervisor and web screen proxy join the
# computer's bridge. Docker loads br_netfilter with bridge-nf-call-iptables, so
# same-bridge frames DO traverse FORWARD/DOCKER-USER — the first rule below
# returns traffic whose in- and out-interface are the same bridge family before
# any drop applies. On hosts where bridged frames skip iptables entirely, that
# rule is simply never matched.
#
# Requires Linux Docker Engine with the iptables firewall backend (the
# DOCKER-USER chain). Docker Desktop, rootless Docker, and the nftables
# backend are not supported.
#
#   sudo bash restrict-computer-egress.sh          # apply now + persist via systemd
#   bash restrict-computer-egress.sh --print       # show the rules, change nothing
#   sudo bash restrict-computer-egress.sh --remove # uninstall

set -Eeuo pipefail

IPTABLES="${RAKAZO_IPTABLES:-iptables}"
IP6TABLES="${RAKAZO_IP6TABLES:-ip6tables}"
SYSTEMCTL="${RAKAZO_SYSTEMCTL:-systemctl}"
BRIDGE_PREFIX="rakazo-c"
INSTALLED_PATH=/usr/local/sbin/rakazo-computer-egress
UNIT_PATH=/etc/systemd/system/rakazo-computer-egress.service

usage() {
  cat <<'EOF'
Usage: restrict-computer-egress.sh [--install|--apply|--remove|--print]
  (default)   apply the rules now and persist them across reboots via systemd
  --apply     apply the rules now only (used by the systemd unit)
  --remove    delete the rules and the systemd unit
  --print     show the iptables commands without changing anything
EOF
}

# Forwarded destinations a computer may never reach: every non-public IPv4 block.
blocked_destinations_v4() {
  cat <<'EOF'
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.168.0.0/16
198.18.0.0/15
224.0.0.0/4
240.0.0.0/4
EOF
}

blocked_destinations_v6() {
  cat <<'EOF'
::1/128
fc00::/7
fe80::/10
ff00::/8
EOF
}

# One rule per line: "<chain> <args>". Order matters: same-bridge traffic
# (-i and -o both rakazo-c*) must be returned to Docker's own chains before the
# destination drops, and in INPUT the established accept must precede the
# catch-all drop so host- and supervisor-initiated connections to the computer
# (control endpoint, published screen port) keep working while the computer can
# no longer open connections to the host.
egress_rules_v4() {
  local cidr
  printf 'DOCKER-USER -i %s+ -o %s+ -j RETURN\n' "$BRIDGE_PREFIX" "$BRIDGE_PREFIX"
  while IFS= read -r cidr; do
    printf 'DOCKER-USER -i %s+ -d %s -j DROP\n' "$BRIDGE_PREFIX" "$cidr"
  done < <(blocked_destinations_v4)
  printf 'INPUT -i %s+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "$BRIDGE_PREFIX"
  printf 'INPUT -i %s+ -j DROP\n' "$BRIDGE_PREFIX"
}

egress_rules_v6() {
  local cidr
  printf 'DOCKER-USER -i %s+ -o %s+ -j RETURN\n' "$BRIDGE_PREFIX" "$BRIDGE_PREFIX"
  while IFS= read -r cidr; do
    printf 'DOCKER-USER -i %s+ -d %s -j DROP\n' "$BRIDGE_PREFIX" "$cidr"
  done < <(blocked_destinations_v6)
  printf 'INPUT -i %s+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "$BRIDGE_PREFIX"
  printf 'INPUT -i %s+ -j DROP\n' "$BRIDGE_PREFIX"
}

wait_for_docker_user() {
  local cmd="$1" deadline=$((SECONDS + 30))
  until "$cmd" -L DOCKER-USER -n >/dev/null 2>&1; do
    if ((SECONDS > deadline)); then
      echo "DOCKER-USER chain not present — is Docker running with the iptables backend?" >&2
      return 1
    fi
    sleep 1
  done
}

# Insert each missing rule at the top of its chain so a broader operator rule
# cannot shadow the block. Iterating in reverse preserves the documented order
# (INPUT: ESTABLISHED accept ahead of the drop). Existing rules are left in
# place wherever they already sit, so repeat runs are idempotent.
apply_family() {
  local cmd="$1" rules=() line chain i
  command -v "$cmd" >/dev/null 2>&1 || return 0
  wait_for_docker_user "$cmd"
  mapfile -t rules < <("$2")
  for ((i = ${#rules[@]} - 1; i >= 0; i--)); do
    line="${rules[i]}"
    chain="${line%% *}"
    local -a args
    read -ra args <<<"${line#* }"
    "$cmd" -C "$chain" "${args[@]}" 2>/dev/null || "$cmd" -I "$chain" 1 "${args[@]}"
  done
}

remove_family() {
  local cmd="$1" line
  command -v "$cmd" >/dev/null 2>&1 || return 0
  while IFS= read -r line; do
    local -a args
    read -ra args <<<"$line"
    while "$cmd" -C "${args[@]}" 2>/dev/null; do
      "$cmd" -D "${args[@]}"
    done
  done < <("$2")
}

apply_rules() {
  apply_family "$IPTABLES" egress_rules_v4
  if command -v "$IP6TABLES" >/dev/null 2>&1 &&
    "$IP6TABLES" -L DOCKER-USER -n >/dev/null 2>&1; then
    apply_family "$IP6TABLES" egress_rules_v6
  fi
}

require_root() {
  if ((EUID == 0)); then return 0; fi
  if [[ "${RAKAZO_EGRESS_SUDOED:-}" == "1" ]]; then
    echo "root privileges required" >&2
    exit 1
  fi
  export RAKAZO_EGRESS_SUDOED=1
  exec sudo --preserve-env=RAKAZO_EGRESS_SUDOED bash "$0" "$@"
}

install_persistence() {
  if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
    echo "systemd not found; rules apply until reboot — re-run this script after one." >&2
    return 0
  fi
  if [[ "$0" == "bash" || "$0" == "-bash" || ! -f "$0" ]]; then
    echo "Run from a saved file to enable reboot persistence; rules were applied anyway." >&2
    return 0
  fi
  if [[ "$(readlink -f "$0")" != "$INSTALLED_PATH" ]]; then
    install -m 0755 "$0" "$INSTALLED_PATH"
  fi
  cat >"$UNIT_PATH" <<EOF
[Unit]
Description=Restrict Rakazo bot-computer egress (rakazo-c* bridges)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$INSTALLED_PATH --apply

[Install]
WantedBy=multi-user.target
EOF
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" enable rakazo-computer-egress.service
}

remove_persistence() {
  if command -v "$SYSTEMCTL" >/dev/null 2>&1 && [[ -f "$UNIT_PATH" ]]; then
    "$SYSTEMCTL" disable --now rakazo-computer-egress.service || true
    rm -f "$UNIT_PATH"
    "$SYSTEMCTL" daemon-reload
  fi
  rm -f "$INSTALLED_PATH"
}

mode="${1:---install}"
case "$mode" in
  --install)
    require_root "$@"
    apply_rules
    install_persistence
    echo "Computer egress restricted: rakazo-c* bridges drop non-public and host-bound traffic."
    ;;
  --apply)
    apply_rules
    ;;
  --remove)
    require_root "$@"
    remove_family "$IPTABLES" egress_rules_v4
    remove_family "$IP6TABLES" egress_rules_v6
    remove_persistence
    echo "Computer egress rules and persistence removed."
    ;;
  --print)
    while IFS= read -r line; do
      printf '%s -I %s %s\n' "$IPTABLES" "${line%% *}" "${line#* }"
    done < <(egress_rules_v4)
    while IFS= read -r line; do
      printf '%s -I %s %s\n' "$IP6TABLES" "${line%% *}" "${line#* }"
    done < <(egress_rules_v6)
    ;;
  -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
