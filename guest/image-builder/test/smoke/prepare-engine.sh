#!/usr/bin/env bash
# Inside the ubuntu:24.04 smoke container, as root: what the golden image and
# the runtime disk provide, built the way they are built for real, then the
# smoke. Started by run.sh, which passes the two paths it owns:
#   TREE         the repository as committed (a checkout, or a git archive of the
#                commit under test), mounted read-only or extracted by run.sh
#   AGENTD_BIN   dot-agentd for linux/amd64, built from that tree
#   SMOKE_SUITE  engine (smoke.sh, the default) or browser (browser/smoke.sh)
# What this builds:
#   users:       dot, dotagentd and dotengine, as builder/user-data.yaml makes them
#   golden image: guest/image-builder/builder/build-engine-env.sh on the hashed
#                 engine lock (the script provision.sh runs), after the same
#                 packages and the same uv the builder VM has
#   runtime disk: the engine's source at /opt/invisible-dots/engine, the files
#                 runtime.ts stages (every .py and .json, the .md templates, the lock,
#                 LICENSE, UPSTREAM.md), world-readable as on the ISO
# The browser suite builds one more thing, as the golden image does it: the apt packages of
# pins.json (the desktop, Firefox's libraries, ImageMagick) and the Dot's browser
# (builder/build-browser-env.sh on the hashed mcp-requirements.lock: the MCP server's
# environment and the engine of the browser).
set -euo pipefail
: "${TREE:?run.sh sets TREE}" "${AGENTD_BIN:?run.sh sets AGENTD_BIN}"
suite=${SMOKE_SUITE:-engine}
case "$suite" in
  engine) checks=$TREE/guest/image-builder/test/smoke/smoke.sh ;;
  browser) checks=$TREE/guest/image-builder/test/smoke/browser/smoke.sh ;;
  *) echo "prepare-engine: unknown suite $suite" >&2; exit 2 ;;
esac
export AGENTD_BIN
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
# nftables and iproute2: the check of the VM proxy's firewall runs install.sh's own generator and nft on its output.
apt-get install -y -qq sudo procps jq curl ca-certificates python3 nftables iproute2 >/dev/null

builder=$TREE/guest/image-builder/builder
engine_src=$TREE/invisible_engine_dots

# The golden image's users (builder/user-data.yaml): dot runs the model's commands and the browser, dotagentd
# the computer daemon that starts them (no home, no group but its own), dotengine the engine. All three exist
# before anything is installed, as in the builder VM.
useradd -m -s /bin/bash dot
useradd -M -d /nonexistent -s /usr/sbin/nologin dotagentd
useradd -m -s /usr/sbin/nologin -G dot dotengine
chmod 0750 /home/dot

# uv, as pins.json pins it (sha256 checked), installed as provision.sh does.
uv_dir=$(mktemp -d)
read -r UV_URL UV_SHA < <(jq -r '.uv | "\(.url) \(.sha256)"' "$TREE/guest/image-builder/pins.json")
curl -fsSL "$UV_URL" -o "$uv_dir/uv.tar.gz"
echo "$UV_SHA  $uv_dir/uv.tar.gz" | sha256sum -c - >/dev/null
tar -xzf "$uv_dir/uv.tar.gz" -C "$uv_dir"
install -m 0755 "$uv_dir"/uv-x86_64-unknown-linux-gnu/uv "$uv_dir"/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/
uv --version

# The golden image's step: the venv from the lock, with the real build script.
bash "$builder/build-engine-env.sh" "$builder/engine-requirements.lock" /opt/invisible-dots-engine /opt/invisible-dots/engine

# The runtime disk's files, at the paths the ISO has them (it carries no __pycache__, no tests).
mkdir -p /opt/invisible-dots/engine
(cd "$engine_src" && find nanobot \( -name '*.py' -o -name '*.json' -o -path 'nanobot/templates/*.md' \) -type f -exec cp --parents {} /opt/invisible-dots/engine/ \;)
cp "$builder/engine-requirements.lock" /opt/invisible-dots/engine/requirements.lock
cp "$engine_src/LICENSE" "$engine_src/UPSTREAM.md" /opt/invisible-dots/engine/
chmod -R a+rX,go-w /opt/invisible-dots

/opt/invisible-dots-engine/bin/python -I -B -m nanobot --version
# Every module of the engine imports with what the lock installed, and nothing else.
/opt/invisible-dots-engine/bin/python -I -B -c "
import importlib, pkgutil, nanobot
names = [m.name for m in pkgutil.walk_packages(nanobot.__path__, 'nanobot.') if not m.name.endswith('__main__')]
for name in names:
    importlib.import_module(name)
print('imported', len(names), 'modules from', nanobot.__file__)
"

if [ "$suite" = browser ]; then
  # The packages of the golden image (pins.json), as provision.sh installs them.
  apt-get install -y -qq --no-install-recommends $(jq -r '.apt_packages[]' "$TREE/guest/image-builder/pins.json") >/dev/null
  # The Dot's browser, with the script provision.sh runs on the same lock. dot reaches its home, not the tree.
  bash "$builder/build-browser-env.sh" "$builder/mcp-requirements.lock" /home/dot/.local/share/invisible-dots/mcp
fi

exec bash "$checks"
