# End-to-end run

`tests/e2e/run.ts` is the product's acceptance test: it builds the images,
starts the control plane and the web client with the one `invisible-dots server`
command, creates a Dot with a real QEMU VM on a real accelerator, and has it do
real work through OpenRouter, browser included. It drives the product only from
the outside, through the `invisible-dots` command, the HTTP API (docs/architecture.md
section 9.6) and the web server's proxy of it (section 9.7), and reads nothing
but the documented data directory (section 3.2). It imports nothing from the
workspace.

It is not part of `npx vitest run` and not part of CI: it needs a hardware
accelerator, about 15 GB of disk, network access, 30 to 90 minutes the first
time, and an OpenRouter key that it spends a few cents of. Run it on a real
host before a pull request that touches the engine, the guest, the scheduler or
the browser, and put the table of `summary.txt` in the description.

## What CI does instead

Everything the run is made of that needs no VM is in `tests/e2e/lib.ts` and is
tested by `tests/repo/e2e.test.ts` on every push:

- the **contract**: every route, command, flag, tool, permission, event type and
  doctor check the run names still exists in the product, and the run names in
  `run.ts` only what `lib.ts` declares. A product change that the run has not
  followed fails there, not an hour into a manual run;
- the **helpers**: the PNG and JPEG checks, the scans for a secret (across the
  chunks of a multi-gigabyte disk), the journal command (run under bash against
  a made-up journal), the Dot's YAML (parsed by the product's own schema), the
  token read from a real `seed.iso` and the guest proof, the event queries and
  the waiting loop.

`node tests/e2e/run.ts --check` is the dry mode on a real host: step a only
(below), no image, no server, no VM, a minute or two. Run it first.

## What it checks

| step | what |
|---|---|
| a | the host: Node 24, Linux, the CLI built and answering, the key file holds one `sk-or-` key, `guest/dot-agentd/bin/dot-agentd` is a linux/amd64 ELF, nothing already answers on the API and web ports, and `invisible-dots doctor` finds Node, QEMU, qemu-img, the accelerator (kvm, by its probe), the data directory and the web build ok. With `--check` the run ends here |
| b | `invisible-dots image build`: the golden image and the runtime ISO exist and hash to their manifests; doctor agrees |
| c | `invisible-dots server` in the background; the web client answers at `INVISIBLE_DOTS_WEB_LISTEN` (default `127.0.0.2:3000`, no login: its pages, and its proxy reaches the API); the OpenRouter key is stored through `invisible-dots secret openrouter` (stdin) |
| d | a Dot created from YAML (`invisible-dots create`) is READY; its `qemu.json` matches the computer record; `doctor` exits 0; a chat message gets a reply that reports its `spent_usd`; the engine's own state, read through dot-agentd's proxy, is IDLE |
| e | one task: create the browser identity `research`, launch it **explicitly**, open https://example.com, read the page's title with `browser_snapshot`, write it to `/home/dot/workspace/title.txt` and to the memory note `/home/dot/memory/example-title.md`. Proved by the events (`browser.identity.created` and `launched`, launch before navigate, each `tool.called` under the permission of its table row with its `target`, `task.progress` before `task.completed`), the identity list (open, profile under `/home/dot/browsers`), the file's SHA-256 computed in the guest by the Dot's own exec tool and compared with that of `Example Domain`, the same two files read through dot-agentd, and the spend: on `task.completed`, on the task record and in `GET /api/dots/:id/usage`, above zero and in agreement |
| f | `GET .../computer/screenshot` returns a PNG that is not blank; `GET .../browser-identities/:id/frame` returns a JPEG of the open identity, directly and through the web client's proxy |
| g | with `files.write: ask`, a task stops at `approval.requested` (the file does not exist yet, the engine holds the same approval), `invisible-dots approve` releases it, and the file holds exactly what was approved; `invisible-dots reject` keeps another write from running; `invisible-dots approve --always` lets a third run, and the next write runs as allowed without asking |
| h | with four identities and the engine's `max_open` of 3: a page tool on an identity that is not open fails and opens nothing (no implicit launch); the fourth explicit launch closes the least recently used one (`browser.identity.closed`) and the browser servers running in the guest are exactly the open identities; the host's `POST .../close` keeps the profile and the frame then answers `409 not_open`; the host's `DELETE` of an open identity closes it, then deletes it, and its directory is gone; no browser server is left |
| i | with `browser.identity.create` and `browser.identity.delete` on ask: the create approval shows the proxy masked (`***`, with no user, password or host), the host lists the identity as having a proxy and says no more, nothing exists before the approval, the delete approval names the identity and its directory is still there until approved; the password is in no approval, identity record or call event, and not in the guest's journal |
| j | the server restarts and adopts the running VM (same pid, browser still open); `invisible-dots computer stop` reaches STOPPED with QEMU gone, through the guest's own poweroff (`computer.stopped` says `forced: false`, in well under the 60 s after which QEMU is killed); the open browser was closed on the way down (`browser.identity.closed`); `start` reaches READY with no browser server running; the identity is launched again and its `.stealth-identity.json` is unchanged (by SHA-256); `title.txt`, the note, a `grep` that finds it, and the conversation are all still there; the guest's whole system journal, read inside the guest, holds no OpenRouter key |
| k | with `computer.exec: ask`, a task stops at an approval; the **computer is killed** (SIGKILL of QEMU) while it waits; the control plane records `computer.stopped` with `reason: exited` and starts the computer again by itself (the Dot still has a task), a second `agent.started` follows, the engine resumes from its database with the same approval pending and the host re-pushes key and config; approved with a note, the task completes and a counter file proves the command ran exactly once |
| l | a task runs a slow `exec`; while it is in flight the computer is killed the same way; after the restart the Dot's event log has that call once, as a `tool.called` with `interrupted: true`, and once the command's time is over no copy of it is running and its marker file was never written: the command died with its computer and was not run again (architecture 8.7) |
| m | two MCP servers in the config, both `uvx mcp-server-time`: `time`, whose permission asks, and `keyed`, which names the secret `TIME_TOKEN`. `keyed` is `failed` because its secret is not set; a task's call of `mcp_time_get_current_time` stops at an approval for `mcp.time`, approved always, and runs; `GET .../tools` lists `time` connected with its tools offered, and its process runs as `dot`. The secret is set through `invisible-dots secret mcp` (stdin, not echoed), `keyed` connects at the next turn, `invisible-dots mcp` says so, and the secret is in the server's environment and on no command line in the guest |
| n | the key and the MCP secret are in none of the Dot's event and approval rows (read back decompressed through the API) and, once the Dot is stopped, in none of its files: the overlay disk, the seed, the serial log and QEMU's log |
| o | `DELETE /api/dots/:id` removes the Dot, its QEMU process and `vms/<id>` |
| p | the key and the MCP secret are in no event row read back after the delete, and in no file of the run's logs, `logs/` or the embedded database's directory |

Steps k and l end the computer, not the engine alone. The engine runs as
`dotengine`, dot-agentd as `dotagentd` and everything the model runs as `dot`, and no
rule lets one end the other (architecture 4.1): that is the isolation, and it
means no process outside the guest's root can kill just the engine. The
engine's own `kill -9` recovery is proved by the engine smoke
(`guest/image-builder/test/smoke`, in CI); here the stronger event is a power
cut, which also needs the control plane to notice and start the computer.

Steps k and l reach dot-agentd directly (`127.0.0.1:<guest_port>`, the proof
handshake, the Dot's token read from its seed) to do to a guest what the model
is not allowed to do to its own computer: read what it wrote, with no tool and
no permission, and ask the engine for its state through the proxy.

The key checks report only "found" or "not found" and where, never any part
of the key. They look for its first 12 characters; the journal check of step j
looks inside the guest for the `sk-or-` prefix every OpenRouter key has (the run
refuses a key without it), without giving the model any part of the key, and is
only accepted when the guest proves it read the system journal. Large rows are
compressed inside the database's files, which is why step n reads them through
the API as well as step p scanning the files. The guest's journal compresses
large entries too, which is why step j reads it inside the guest besides step n
scanning the disk. The MCP secret of step m is looked for whole: it is made for
the run and never shown to the model.

A file the Dot wrote is checked by having the Dot hash it in the guest
(`printf '%s' "$(cat <file>)" | sha256sum`, so a trailing newline does not
count) and comparing with the hash of the expected text on the host: the
model only relays a value it cannot make up.

The run stops at the first failing step. Everything it writes goes to
`E2E_LOG_DIR` (default `tmp/e2e/<UTC time>/`, ignored by git): `cli.log` (every
command and its output, never the key), `server.log`, `image-build.log`,
`events.txt` (the Dot's event log, rewritten after every step, so it is there
when a step fails), `screenshot.png`, `frame.jpg`, `serial.log` of the Dot, and
`summary.json` / `summary.txt` with each step's result and duration. Dots it
creates are named `e2e-...`; a later run deletes the ones an earlier failed run
left behind.

## On a Linux host

What the host needs is what docs/architecture.md section 3.1 lists, plus Go
to build dot-agentd from source:

```bash
sudo apt-get install -y qemu-system-x86 qemu-utils   # or: invisible-dots setup
sudo usermod -aG kvm "$USER"                          # then log in again
# Node 24 from https://nodejs.org, Go 1.25 or newer from https://go.dev

git clone https://github.com/feder-cr/invisible_dots && cd invisible_dots
npm ci
npm run build --workspace @invisible-dots/cli
npm run build --workspace @invisible-dots/web        # skip with E2E_WEB=0
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go -C guest/dot-agentd build -trimpath -o bin/dot-agentd ./cmd/dot-agentd

# The key goes in a file only you can read; the run never prints it.
install -m 600 /dev/null ~/openrouter.key && $EDITOR ~/openrouter.key

export INVISIBLE_DOTS_HOME=~/.invisible-dots-e2e
export E2E_OPENROUTER_KEY_FILE=~/openrouter.key
node tests/e2e/run.ts --check    # the dry mode: what the run needs, in a minute or two
node tests/e2e/run.ts            # the run
```

A separate `INVISIBLE_DOTS_HOME` keeps the run away from your own Dots. The
run starts `invisible-dots server` itself on the default addresses
(API `127.0.0.1:8787`, web `127.0.0.1:3000`), so stop any server already
running on that home or those ports, or set `INVISIBLE_DOTS_LISTEN` and
`INVISIBLE_DOTS_URL` together (and `INVISIBLE_DOTS_WEB_LISTEN` for the web
client). Optional settings: `E2E_LOG_DIR`, `E2E_MODEL` (default
`z-ai/glm-5.3-flash`; it must be a paid model, because step e requires the spend
it reports to be above zero), `E2E_CLI` (default `apps/cli/dist/invisible-dots.mjs`)
and `E2E_WEB=0` (the server runs with `--no-web` and the steps that need the
web client are skipped).

The images stay in `INVISIBLE_DOTS_HOME/images`, so a second run skips the
image build (`image build` finds images with the same inputs and does
nothing) and takes about 30 minutes.

## In a container, when the host cannot run it directly

`linux-host/Dockerfile` is a stand-in Linux host for machines that have
`/dev/kvm` but cannot install QEMU or use sudo (for example WSL). It is test
harness only, never a way to run the product. Its image has exactly what an
Ubuntu 24.04 user installs: the distribution's QEMU, CA certificates and Node
24 from the official tarball (checked against `SHASUMS256.txt` and a pinned
hash). Nothing else, so the run fails if the product starts to need another
host program. It runs as an ordinary user that reaches `/dev/kvm` through the
device's group, as on a real host; no `--privileged`.

```bash
# dot-agentd needs Go, which the host image deliberately lacks
docker run --rm -v "$PWD/guest/dot-agentd:/src" -w /src \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH=amd64 -e GOFLAGS=-buildvcs=false \
  golang:1.26 go build -trimpath -o bin/dot-agentd ./cmd/dot-agentd

# The container's user takes your uid and gid, so it can read ~/openrouter.key (mode 0600) as you do.
docker build -t idots-linux-host --build-arg HOST_UID="$(id -u)" --build-arg HOST_GID="$(id -g)" tests/e2e/linux-host
docker run -d --init --name idots-e2e \
  --device /dev/kvm --group-add "$(stat -c %g /dev/kvm)" \
  -v "$PWD:/src:ro" \
  -v ~/openrouter.key:/run/secrets/openrouter:ro \
  -v idots-e2e-home:/data -v idots-e2e-work:/work \
  -e INVISIBLE_DOTS_HOME=/data/home \
  idots-linux-host sleep infinity

# Copies the read-only checkout to /work/dots, runs npm ci for Linux and builds the command and the web client.
docker exec idots-e2e bash /src/tests/e2e/linux-host/prepare.sh
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter \
  -e E2E_LOG_DIR=/work/logs/run idots-e2e node tests/e2e/run.ts --check
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter \
  -e E2E_LOG_DIR=/work/logs/run idots-e2e node tests/e2e/run.ts
```

`--init` is required. QEMU is spawned detached, so when the server that
started it exits (step j restarts it), QEMU's parent becomes process 1. On a
real host that is init or a session's subreaper, which reaps QEMU when it
exits; in a container without `--init` it is `sleep`, which never does, so a
powered-off QEMU stays a zombie, `process.kill(pid, 0)` keeps reporting it
alive, and a stop that took seconds takes the full 60 s timeout.

`INVISIBLE_DOTS_HOME` is on a named volume, never on a bind mount from a
Windows drive: qcow2 disks on a 9p or SMB share are too slow for a VM. After a
change to the checkout, run `prepare.sh` again (it starts from a fresh copy)
and the run again; the images on the volume are reused unless their inputs
changed.

On WSL, the VM that runs docker shuts down when no WSL session is attached,
which kills the container and every Dot in it: keep a session open (for
example `wsl.exe -e bash -lc "sleep 21600"` in the background) while the run
lasts. Remove everything afterwards with `docker rm -f idots-e2e` and
`docker volume rm idots-e2e-home idots-e2e-work`. Do remove the home volume:
it holds `config/master.key` next to the database in which the key is stored
encrypted under it, so whoever can read the volume can decrypt the key.

## The scale run

`scale.ts` loads one host with Dots, on real VMs, through the same outside
driver (`driver.ts`). For each level of N Dots (default 1, 2, 4, 8) it creates
the N at once, waits until every one is READY, sends each a chat message,
gives each a task that runs a command in its computer and reads the result
back from the guest, then deletes them all. Meanwhile it samples `/api/health`
and `/api/dots` four times a second, and the host's available memory and the
QEMU processes' memory every two seconds. A level passes when every Dot came
up, answered and did its task, and:

| Budget | Default |
|---|---|
| the API's 95th percentile | under `SCALE_HEALTH_P95_MS` (500 ms) |
| READY, a reply and a task at the 95th percentile | within `SCALE_RATIO` (3) times the same with one Dot, plus 30 s |
| the host's available memory | above `SCALE_MIN_FREE_MB` (1024 MB) |

The budgets are ratios to one Dot, so they measure how the host shares out,
not how fast it is. Each Dot has 1 CPU and `SCALE_MEMORY` (2gb). It needs the
images step b of the end-to-end run built in the same home:

```bash
docker exec -w /work/dots -e E2E_OPENROUTER_KEY_FILE=/run/secrets/openrouter \
  -e E2E_LOG_DIR=/work/logs/scale idots-e2e node tests/e2e/scale.ts --levels 1,2,4,8
```

`summary.txt` has one line per level (READY, reply and task times at p50 and
p95, the API's p95, the lowest available memory and the QEMU processes' total),
`samples.json` every sample.

## Linux only

The run is written for a Linux host (step a refuses another). Step j restarts
the server with SIGTERM, which on Linux runs the server's own shutdown (it
closes the database and releases `server.lock`). On Windows, Node's `kill()` is
TerminateProcess whatever the signal, so the same step would test a hard kill
instead; the server itself handles Ctrl+C, a closed console window and
Ctrl+Break there (docs/architecture.md section 11).

## Status

The run is typechecked and its helpers and contract are tested in CI; it runs
against real VMs through the Linux host above. Its assertions that depend on
the real model, the real browser or a real site (the sentence before each tool
call that makes `task.progress`, the title of example.com, the engine closing a
browser on the way down) name what they expected when they fail; fix the
product or the assertion at its origin, and say which in the commit.
