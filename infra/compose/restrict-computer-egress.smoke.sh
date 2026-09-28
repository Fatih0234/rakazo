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

# --print emits execution order (each rule inserts at the top of its chain), so
# the same-bridge RETURN — which must END UP first in DOCKER-USER — prints last
# among the IPv4 DOCKER-USER rules. Same-bridge traffic (supervisor/web peers
# under br_netfilter, where bridged frames traverse FORWARD) is returned to
# Docker's own chains before any drop.
last_v4_user="$(grep '^iptables -I DOCKER-USER' <<<"$printed" | tail -1)"
[[ "$last_v4_user" == 'iptables -I DOCKER-USER 1 -i rakazo-c+ -o rakazo-c+ -j RETURN' ]] ||
  fail "same-bridge RETURN must print last among IPv4 DOCKER-USER rules"
grep -qxF 'ip6tables -I DOCKER-USER 1 -i rakazo-c+ -o rakazo-c+ -j RETURN' <<<"$printed" ||
  fail "missing IPv6 same-bridge RETURN"

# Every non-public IPv4 block is dropped on the computer bridges' forwarded path.
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
  172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  grep -qxF "iptables -I DOCKER-USER 1 -i rakazo-c+ -d $cidr -j DROP" <<<"$printed" ||
    fail "missing DOCKER-USER drop for $cidr"
done

# Host input: the catch-all drop executes before the established-accept so the
# accept ends up above it (host/supervisor-initiated control and screen
# connections keep working while the computer cannot open connections out).
drop_i="$(grep -nx 'iptables -I INPUT 1 -i rakazo-c+ -j DROP' <<<"$printed" | head -1 | cut -d: -f1)"
est_i="$(grep -nx 'iptables -I INPUT 1 -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' <<<"$printed" | head -1 | cut -d: -f1)"
[[ -n "$drop_i" && -n "$est_i" && "$drop_i" -lt "$est_i" ]] ||
  fail "--print must emit the INPUT drop before the established accept"

# IPv6 drops ULA (includes AWS metadata fd00:ec2::254), link-local, multicast, loopback.
for cidr in ::1/128 fc00::/7 fe80::/10 ff00::/8; do
  grep -qxF "ip6tables -I DOCKER-USER 1 -i rakazo-c+ -d $cidr -j DROP" <<<"$printed" ||
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
  -S)
    chain="$1"
    printf '%s\n' "-N $chain"
    if [[ -f $state ]]; then
      while IFS= read -r row; do
        [[ "$row" == "$chain "* ]] || continue
        printf '%s\n' "-A $row"
      done <"$state"
    fi
    ;;
  -C) grep -qxF -- "$*" "$state" 2>/dev/null ;;
  # -I CHAIN 1 inserts at the top: model it as a prepend so the state file
  # mirrors real chain order (top to bottom).
  -I) chain="$1"; shift 2 || true
      { printf '%s %s\n' "$chain" "$*"; cat "$state" 2>/dev/null; } >"$state.tmp"
      mv "$state.tmp" "$state" ;;
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

# The established accept must end up above the INPUT drop. Call order is not
# the chain: a prefix check may probe the accept before the drop is inserted.
acc_at="$(grep -nxF 'INPUT -i rakazo-c+ -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' "$v4_state" | head -1 | cut -d: -f1)"
drop_at="$(grep -nxF 'INPUT -i rakazo-c+ -j DROP' "$v4_state" | head -1 | cut -d: -f1)"
[[ -n "$acc_at" && -n "$drop_at" && "$acc_at" -lt "$drop_at" ]] ||
  fail "established accept must sit above the INPUT drop"

# Second apply inserts nothing when the managed rules are already the prefix.
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
[[ "$(grep -c '^-I ' "$v4_calls")" == 14 ]] ||
  fail "rules re-inserted on repeat apply"
[[ "$(grep -c '^-I ' "$STUB_DIR/ip6tables.calls")" == 7 ]] ||
  fail "IPv6 rules re-inserted on repeat apply"

# --print output replays verbatim: feeding the printed commands through the
# stubbed firewall must reproduce the exact chains --apply built.
replay_dir="$scratch/replay"
mkdir -p "$replay_dir"
for tool in iptables ip6tables; do
  cat >"$replay_dir/$tool" <<'STUB'
#!/usr/bin/env bash
name="$(basename "$0")"
state="$REPLAY_DIR/$name.state"
if [[ "$1" == "-I" ]]; then
  chain="$2"; shift 3 || true
  { printf '%s %s\n' "$chain" "$*"; cat "$state" 2>/dev/null; } >"$state.tmp"
  mv "$state.tmp" "$state"
fi
STUB
  chmod +x "$replay_dir/$tool"
done
REPLAY_DIR="$replay_dir" PATH="$replay_dir:$PATH" bash -c \
  'while IFS= read -r l; do $l; done' <<<"$printed"
diff "$v4_state" "$replay_dir/iptables.state" >/dev/null ||
  fail "--print replay does not reproduce the applied IPv4 chain"
diff "$v6_state" "$replay_dir/ip6tables.state" >/dev/null ||
  fail "--print replay does not reproduce the applied IPv6 chain"

# An ACCEPT inserted above the drops must not survive --apply. The managed
# rules return to the head of DOCKER-USER and the foreign accept falls below.
{ printf '%s\n' 'DOCKER-USER -j ACCEPT'; cat "$v4_state"; } >"$v4_state.tmp"
mv "$v4_state.tmp" "$v4_state"
RAKAZO_IPTABLES="$bin/iptables" RAKAZO_IP6TABLES="$bin/ip6tables" bash "$script" --apply
first="$(head -1 "$v4_state")"
[[ "$first" == 'DOCKER-USER -i rakazo-c+ -o rakazo-c+ -j RETURN' ]] ||
  fail "same-bridge RETURN was not restored to the head, got: $first"
accept_at="$(grep -nxF 'DOCKER-USER -j ACCEPT' "$v4_state" | head -1 | cut -d: -f1)"
meta_at="$(grep -nxF 'DOCKER-USER -i rakazo-c+ -d 169.254.0.0/16 -j DROP' "$v4_state" | head -1 | cut -d: -f1)"
[[ -n "$accept_at" && -n "$meta_at" && "$meta_at" -lt "$accept_at" ]] ||
  fail "metadata drop is not above the foreign ACCEPT"

# Without ip6tables on PATH the IPv6 family is skipped only when the host has
# no global IPv6 (loopback scope 10). On a dual-stack host (scope 00) the same
# missing chain must fail loudly instead of announcing success.
inet6_local="$scratch/if_inet6.local"
inet6_global="$scratch/if_inet6.global"
printf '%s\n' "00000000000000000000000000000001 01 80 10 80 lo" >"$inet6_local"
printf '%s\n' "20010db800000000000000000000000001 02 40 00 00 eth0" >"$inet6_global"
rm -f "$v4_state" "$v6_state" "$v4_calls" "$STUB_DIR/ip6tables.calls"
RAKAZO_IF_INET6="$inet6_local" RAKAZO_IPTABLES="$bin/iptables" \
  RAKAZO_IP6TABLES="$bin/missing-ip6tables" bash "$script" --apply
[[ ! -e "$v6_state" ]] || fail "IPv6 rules applied despite missing ip6tables"
[[ -f "$v4_state" ]] || fail "IPv4 rules missing when ip6tables absent"
RAKAZO_IF_INET6="$inet6_global" RAKAZO_IPTABLES="$bin/iptables" \
  RAKAZO_IP6TABLES="$bin/missing-ip6tables" bash "$script" --apply &&
  fail "--apply succeeded on dual-stack host without programmable IPv6" || true

# Missing IPv4 iptables must fail loudly — a silent no-op would claim
# restricted egress while installing nothing.
RAKAZO_IPTABLES="$bin/missing-iptables" RAKAZO_IP6TABLES="$bin/missing-ip6tables" \
  bash "$script" --apply && fail "--apply succeeded with no iptables binary" || true

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
