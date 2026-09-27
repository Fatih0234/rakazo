#!/usr/bin/env bash
# Offline checks for restrict-computer-egress.sh; stubbed iptables, no daemon or root.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
script="$root/restrict-computer-egress.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

bash -n "$script"

printed="$(bash "$script" --print)"
[[ -n "$printed" ]] || fail "--print produced no rules"

# Same-bridge traffic (supervisor/web peers under br_netfilter, where bridged
# frames traverse FORWARD) is returned to Docker's own chains before any drop.
first_line="$(head -1 <<<"$printed")"
[[ "$first_line" == 'iptables -I DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' ]] ||
  fail "same-bridge RETURN must be the first DOCKER-USER rule"
grep -qxF 'ip6tables -I DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' <<<"$printed" ||
  fail "missing IPv6 same-bridge RETURN"

# Every non-public IPv4 block is dropped on the computer bridges' forwarded path.
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
  172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  grep -qxF "iptables -I DOCKER-USER -i rakazo-c+ -d $cidr -j DROP" <<<"$printed" ||
    fail "missing DOCKER-USER drop for $cidr"
done

# Host input: established replies (host/supervisor-initiated control and screen
# connections) must stay accepted ahead of the catch-all drop for new inbound.
est_line="$(grep -nx 'iptables -I INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' <<<"$printed" | head -1 | cut -d: -f1)"
drop_line="$(grep -nx 'iptables -I INPUT -i rakazo-c+ -j DROP' <<<"$printed" | head -1 | cut -d: -f1)"
[[ -n "$est_line" && -n "$drop_line" && "$est_line" -lt "$drop_line" ]] ||
  fail "INPUT established-accept must precede the drop"

# IPv6 drops ULA (includes AWS metadata fd00:ec2::254), link-local, multicast, loopback.
for cidr in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
  grep -qxF "ip6tables -I DOCKER-USER -i rakazo-c+ -d $cidr -j DROP" <<<"$printed" ||
    fail "missing IPv6 drop for $cidr"
done

# --apply with stubbed firewall commands: installs each rule once, idempotently,
# inserting in reverse so the printed order lands at the top of each chain.
bin="$scratch/bin"
mkdir -p "$bin"
export STUB_DIR="$scratch/state"
mkdir -p "$STUB_DIR"
for tool in iptables ip6tables; do
  cat >"$bin/$tool" <<'STUB'
#!/usr/bin/env bash
state="$STUB_DIR/$(basename "$0").state"
printf '%s\n' "$*" >>"$STUB_DIR/$(basename "$0").calls"
op="$1"; shift || true
case "$op" in
  -L) exit 0 ;;
  -C) grep -qxF -- "$*" "$state" 2>/dev/null ;;
  -I) chain="$1"; shift 2; printf '%s %s\n' "$chain" "$*" >>"$state" ;;
  -D) grep -vxF -- "$*" "$state" >"$state.tmp" 2>/dev/null || true; mv "$state.tmp" "$state" ;;
esac
STUB
  chmod +x "$bin/$tool"
done

RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
v4_state="$STUB_DIR/iptables.state"
v6_state="$STUB_DIR/ip6tables.state"
v4_calls="$STUB_DIR/iptables.calls"

[[ "$(wc -l <"$v4_state")" == 14 ]] || fail "expected 14 IPv4 rules, got $(wc -l <"$v4_state")"
[[ "$(wc -l <"$v6_state")" == 7 ]] || fail "expected 7 IPv6 rules, got $(wc -l <"$v6_state")"
grep -qxF 'INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' "$v4_state" ||
  fail "established accept missing after apply"
grep -qxF 'INPUT -i rakazo-c+ -j DROP' "$v4_state" || fail "INPUT drop missing after apply"
grep -qxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state" ||
  fail "metadata drop missing after apply"
grep -qxF 'DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' "$v4_state" ||
  fail "same-bridge RETURN missing after apply"

# Reverse iteration puts the INPUT drop in first so the accept ends up above it.
drop_i="$(grep -n -- '-I INPUT 1 -i rakazo-c+ -j DROP' "$v4_calls" | head -1 | cut -d: -f1)"
acc_i="$(grep -n -- 'ESTABLISHED,RELATED -j ACCEPT' "$v4_calls" | head -1 | cut -d: -f1)"
[[ -n "$drop_i" && -n "$acc_i" && "$drop_i" -lt "$acc_i" ]] ||
  fail "apply must insert the INPUT drop before the established accept"

# Second apply inserts nothing.
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
[[ "$(grep -c '^-I ' "$v4_calls")" == 14 ]] ||
  fail "rules re-inserted on repeat apply"
[[ "$(grep -c '^-I ' "$STUB_DIR/ip6tables.calls")" == 7 ]] ||
  fail "IPv6 rules re-inserted on repeat apply"

# Without ip6tables on PATH the IPv6 family is skipped silently.
rm -f "$v4_state" "$v6_state" "$v4_calls" "$STUB_DIR/ip6tables.calls"
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/missing-ip6tables" bash "$script" --apply
[[ ! -e "$v6_state" ]] || fail "IPv6 rules applied despite missing ip6tables"
[[ -f "$v4_state" ]] || fail "IPv4 rules missing when ip6tables absent"

# Docs and Compose keep the flag and script wired together.
docs="$root/../../docs/self-host.md"
grep -q 'restrict-computer-egress.sh' "$docs" || fail "self-host.md does not mention the script"
grep -q 'SANDBOX_COMPUTER_EGRESS' "$docs" || fail "self-host.md does not document the flag"
for compose in docker-compose.yml docker-compose.images.yml docker-compose.topology.yml; do
  grep -q 'SANDBOX_COMPUTER_EGRESS' "$root/$compose" ||
    fail "$compose does not pass SANDBOX_COMPUTER_EGRESS"
done
grep -q 'SANDBOX_COMPUTER_EGRESS' "$root/../../.env.example" || fail ".env.example lacks the flag"
grep -q 'SANDBOX_COMPUTER_EGRESS' "$root/.env.images.example" ||
  fail ".env.images.example lacks the flag"

echo "restrict-computer-egress smoke checks passed."
