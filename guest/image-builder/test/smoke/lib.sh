#!/usr/bin/env bash
# What the two smokes (smoke.sh and browser/smoke.sh) share: the Dot's guest laid out the way the
# runtime disk's install.sh lays it out, dot-agentd as dotagentd (starting the model's commands as
# dot), the engine as dotengine and restarted when it dies as systemd would, the stand-in for OpenRouter, the fake host that reads the event
# stream and pushes the key and the config, and the helpers that read events and drive a chat turn.
# Sourced, never run. The caller starts the guest in this order (each step is one function here):
#
#   lay_out_guest; write_host_token; start_fake_openrouter; [MCP_COMMAND=...] start_guest_daemons
#
# Nothing in this file is a check: the checks of each smoke sit between the steps they judge.
SMOKE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PASS=0; FAIL=0; SKIP=0
ok() { echo "PASS: $*"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $*"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

ENGINE_PY=/opt/invisible-dots-engine/bin/python
# The key has this one owner; the stand-in gets it on its command line (not its environment: a check
# asserts that no process environment holds it) and refuses to start without it.
KEY=sk-or-v1-smoke-0123456789abcdef
# What the units give the engine and the desktop: the display and uv's bin dir (invisible-dots-agent.service).
GUEST_PATH=/home/dot/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# What the unit gives dot-agentd, read from the unit itself so the smoke starts the daemon with the PATH the
# image has: system directories only, none of them dot's (a program the daemon starts as itself, the poweroff,
# is found through it).
DAEMON_PATH=$(sed -n 's/^Environment=PATH=//p' "$SMOKE_DIR/../../units/dot-agentd.service")
# Every request the stand-in for OpenRouter receives is appended, whole, to this file.
FULL="${FULL:-/tmp/fake-full.jsonl}"

# Whether a text is in the environment of some process. A process's environment is read by its own user only
# (the container's root has no CAP_SYS_PTRACE: a sweep as root silently skips the processes of the others), so
# the sweep is made once as each user that runs one.
environ_holds() { # text
  local user
  for user in root dot dotagentd dotengine nobody; do
    if su -s /bin/bash "$user" -c "grep -a -l -F -e '$1' /proc/[0-9]*/environ 2>/dev/null" | grep -q .; then return 0; fi
  done
  return 1
}

# Whether a text is on the command line of some process. A command line is readable by every user of the
# machine, so one sweep as the least privileged user shows what any of them can read. The text goes in the
# environment and not in an argument: an argument would put it on the sweep's own command line.
cmdline_holds() { # text
  CMDLINE_TEXT="$1" su -p -s /bin/bash nobody -c '
    for f in /proc/[0-9]*/cmdline; do
      line=$(tr "\0" " " < "$f" 2>/dev/null) || continue
      [[ $line == *"$CMDLINE_TEXT"* ]] && exit 0
    done
    exit 1'
}

# --- the runtime disk's directories (install.sh's directory and socket steps; the systemd parts do not run here) ---
# The users (dot, dotagentd, dotengine) are the golden image's: prepare-engine.sh made them.
lay_out_guest() {
  mkdir -p /opt/invisible-dots/bin /etc/invisible-dots /run
  cp "$AGENTD_BIN" /opt/invisible-dots/bin/dot-agentd; chmod 0755 /opt/invisible-dots/bin/dot-agentd
  install -d -o dotagentd -g dotengine -m 2750 /run/invisible-dots
  install -d -o dotengine -g dotagentd -m 2750 /run/invisible-dots-agent
  install -d -o dot -g dot -m 2775 /home/dot/workspace
  install -d -o root -g root -m 0755 /var/lib/invisible-dots
  install -d -o dot -g dot -m 0700 /var/lib/invisible-dots/mcp
  install -d -o dotengine -g dotengine -m 0700 /home/dotengine /home/dotengine/state
}

# The host's token for dot-agentd, in the file dot-agentd reads: its own user's, and no one else's.
write_host_token() {
  TOKEN="smoke-token-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '{"dotId":"dot_smoke","token":"%s"}' "$TOKEN" > /etc/invisible-dots/config.json
  chown dotagentd:dotagentd /etc/invisible-dots/config.json; chmod 0600 /etc/invisible-dots/config.json
}

# The stand-in for OpenRouter. Copied out of the tree under test, where the unprivileged user may not
# reach it, and out of the directories the key sweeps read: the stand-in holds the key in its memory.
start_fake_openrouter() {
  install -D -m 0644 "$SMOKE_DIR/fake_openrouter.py" /usr/local/lib/smoke-fake/fake_openrouter.py
  su -s /bin/bash nobody -c "python3 /usr/local/lib/smoke-fake/fake_openrouter.py 9999 $KEY" > /tmp/fake.log 2>&1 &
}

# dot-agentd as dotagentd, the way its unit starts it: with the capabilities of the unit's AmbientCapabilities
# (setuid, setgid, kill) and no others, and the environment systemd gives that user plus the unit's (DAEMON_PATH); and the
# engine as dotengine, restarted by
# start_engine when it dies as systemd would (KillMode=control-group: every process of the engine goes
# with it). The engine's environment is its unit's, plus the program it runs for a browser when
# MCP_COMMAND names one (without it the engine finds invisible-playwright-mcp on its PATH).
start_guest_daemons() {
  setpriv --reuid=dotagentd --regid=dotagentd --init-groups \
    --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill \
    env HOME=/nonexistent USER=dotagentd LOGNAME=dotagentd SHELL=/usr/sbin/nologin DISPLAY=:0 PATH=$DAEMON_PATH \
    /opt/invisible-dots/bin/dot-agentd --listen 127.0.0.1:1024 > /tmp/agentd.log 2>&1 &
  cat > /tmp/engine.sh <<EOF
export HOME=/home/dotengine
export PATH=$GUEST_PATH
export DISPLAY=:0
export TIKTOKEN_CACHE_DIR=/opt/invisible-dots-engine/share/tiktoken
export INVISIBLE_DOTS_ENGINE_STATE=/home/dotengine/state
export INVISIBLE_DOTS_AGENT_SOCKET=/run/invisible-dots-agent/agent.sock INVISIBLE_DOTS_AGENTD_SOCKET=/run/invisible-dots/agentd.sock
export INVISIBLE_DOTS_AGENTD_BIN=/opt/invisible-dots/bin/dot-agentd INVISIBLE_DOTS_WORKSPACE=/home/dot/workspace
export INVISIBLE_DOTS_OPENROUTER_URL=http://127.0.0.1:9999/api/v1 INVISIBLE_DOTS_NETWORK_CHECK=127.0.0.1:9999
${MCP_COMMAND:+export INVISIBLE_DOTS_MCP_COMMAND=$MCP_COMMAND}
umask 0002
cd /home/dotengine
exec /opt/invisible-dots-engine/bin/python -I -B -m nanobot
EOF
  chmod 0755 /tmp/engine.sh
  start_engine
}
start_engine() { su -s /bin/bash dotengine -c "bash /tmp/engine.sh" >> /tmp/engine.log 2>&1 & }

# --- the host's side: dot-agentd's TCP port with the Dot's token ---
api() { curl "${H[@]}" "$@"; }
# The host's file routes, as the TCP port serves them (limited to /home/dot, every symbolic link followed): the answer
# and, on a last line, its status.
files_get() { api -w '\n%{http_code}' --get --data-urlencode "path=$1" http://127.0.0.1:1024/v1/files; }
files_list() { api -w '\n%{http_code}' --get --data-urlencode "path=$1" http://127.0.0.1:1024/v1/files/list; }
refuses_outside_home() { # paths: each is answered 403 outside_home
  local p out
  for p in "$@"; do
    out=$(files_get "$p")
    [ "$(printf '%s\n' "$out" | tail -n 1)" = 403 ] || { echo "no 403 for $p: $out"; return 1; }
    printf '%s\n' "$out" | grep -q '"error":"outside_home"' || { echo "not outside_home for $p: $out"; return 1; }
  done
}
init_host_side() {
  H=(-sS -H "Authorization: Bearer $TOKEN")
  A=http://127.0.0.1:1024/v1/agent
}
wait_health() {
  for _ in $(seq 1 180); do
    if api "$A/health" 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    sleep 1
  done
  return 1
}

# The decision for every permission, as the host's toRuntimeConfig sends it; a smoke changes these files
# and calls push.
reset_config() {
  echo '{"computer.exec":"allow"}' > /tmp/perms.json; chmod 0644 /tmp/perms.json
  echo '{}' > /tmp/models.json; chmod 0644 /tmp/models.json     # the config's models (the summary role)
  echo openai/gpt-4o-mini > /tmp/model.txt; chmod 0644 /tmp/model.txt # the config's model: its limits are the stand-in's
  echo '{}' > /tmp/mcp.json; chmod 0644 /tmp/mcp.json             # the config's MCP servers
  echo '{}' > /tmp/mcp-secrets.json; chmod 0600 /tmp/mcp-secrets.json # their secrets, pushed with the key
}
push() {
  api -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"openrouter_api_key\":\"$KEY\",\"mcp_secrets\":$(cat /tmp/mcp-secrets.json)}" "$A/secrets"
  echo -n " "
  api -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{"name":"smoke","model":{"provider":"openrouter","id":"'"$(cat /tmp/model.txt)"'"},"permissions":'"$(cat /tmp/perms.json)"',"models":'"$(cat /tmp/models.json)"',"limits":{"max_steps_per_task":60,"max_cost_per_task_usd":1},"mcp_servers":'"$(cat /tmp/mcp.json)"'}' "$A/config"
}
# What the fake host runs on every agent.started: the same push, as a script.
write_push_script() { { declare -f api push; echo "H=(-sS -H 'Authorization: Bearer $TOKEN'); A=$A; KEY=$KEY; push"; } > /tmp/push.sh; }

# The event stream, read the way the host reads it: from its last seq, reconnecting after a drop, pushing
# the key and the config on agent.started.
STREAM=/tmp/host-stream.txt
start_host_stream() {
  bash "$SMOKE_DIR/host-stream.sh" "$TOKEN" "$STREAM" "bash /tmp/push.sh" &
  SPID=$!
}
stop_host_stream() { pkill -f host-stream.sh; kill $SPID 2>/dev/null; wait $SPID 2>/dev/null; }

ev() { local id=$1 type=$2 data=$3; api -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\"id\":\"$id\",\"type\":\"$type\",\"ts\":\"2026-10-04T10:00:00Z\",\"data\":$data}" "$A/events"; }
# wait_event <file> <jq filter>: an event of the file matches, within WAIT_EVENT_S seconds (default 120).
wait_event() {
  for _ in $(seq 1 "${WAIT_EVENT_S:-120}"); do
    # -s and any(): jq -e alone judges only the LAST event read, not whether one matched.
    if grep '^data: ' "$1" | sed 's/^data: //' | jq -s -e "any(.[]; $2)" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
wait_key() { for _ in $(seq 1 60); do api "$A/health" | grep -q '"openrouter_configured":true' && return 0; sleep 1; done; return 1; }
st() { api "$A/state"; }
gone_within() { # seconds, pattern: no process of dot matches it
  for _ in $(seq 1 $(($1*5))); do pgrep -u dot -f "$2" >/dev/null || return 0; sleep 0.2; done
  return 1
}

# --- a chat turn and the browser identities, as the model and the host use them ---
say() { [ "$(ev "$1" user.message "$(jq -nc --arg t "$2" '{text:$t}')")" = 202 ]; } # id, text
tool_turn() { # n, tool, arguments json: a chat turn whose model calls the tool, waited for until it answered
  say "msg-bt-$1" "RUN-TOOL $2 $3" && wait_event $STREAM ".type==\"message.assistant\" and .data.in_reply_to==\"msg-bt-$1\""
}
health_is() { api "$A/health" | jq -e ".browser.identities==$1 and .browser.open==$2" >/dev/null; } # identities, open
new_identity() { api -X POST -H 'content-type: application/json' -d "$(jq -nc --arg n "$1" '{name:$n}')" "$A/browser-identities" | jq -r .id; }
identity_named() { api "$A/browser-identities" | jq -r --arg n "$1" '[.identities[] | select(.name == $n)][0].id'; }
launched() { wait_event $STREAM ".type==\"browser.identity.launched\" and .data.identity_id==\"$1\""; }
closed() { wait_event $STREAM ".type==\"browser.identity.closed\" and .data.identity_id==\"$1\""; }
# The seqs of an event file, one per line.
seqs() { grep '^id: ' "$1" | sed 's/^id: //'; }
