# dsh-podman-sb

CI: [actions/workflows/ci.yml](https://github.com/anthony1x6000/dsh-podman-sb/actions/workflows/ci.yml)

Rootless [Podman](https://podman.io/) sandboxes for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents.
A bundle of `podman_*` tools over the `ctx.tools` registry: create throwaway
distro containers from a go-to catalog (or any image ref — ghcr, quay, …),
run one-shot commands, keep tmux sessions alive inside the container, copy
files, and read host resources before provisioning anything heavy.

## Tools

| Tool | Role |
|---|---|
| `podman_host_resources` | Host snapshot (free memory, cpus, load, container-storage disk, running sandboxes) |
| `podman_create` | Container from catalog alias or any image ref; desktop mode auto-publishes loopback VNC + noVNC |
| `podman_exec` | One-shot `sh -lc` command inside a container |
| `podman_session_send` | Feed keys into an auto-created tmux session, read the pane back |
| `podman_session_capture` / `podman_session_list` / `podman_session_kill` | Peek and manage sessions |
| `podman_cp` | Copy files host ⇄ container (host side confined to `$HOME`/workspace) |
| `podman_list` | Sandboxes with remaining TTL and desktop ports (runs the expiry sweep) |
| `podman_stop` / `podman_remove` / `podman_extend` | Lifecycle |
| `podman_images` | Cached images and catalog presence, with sizes |
| `podman_guide` | Rules + image catalog + premade recipes (caveman voice) |

## Lifecycle

Every container gets a TTL label, a state-ledger entry, and a transient
`systemd --user` kill timer (`systemd-run --on-active` → `podman rm -tf`,
retried), so expiry survives a DSH crash — the boot sweep, a 60-second
periodic sweep, and every mutating tool call re-arm lost timers and remove
overdue containers. Default 30 minutes, hard cap 24 hours from creation.
`podman_extend` re-arms the timer but never pushes total life past the cap.
Known clock caveat: the timer is monotonic (immune to clock steps, paused
over host suspend), while the sweep checks wall-clock time — a large backward
clock step delays the sweep's backstop by the same delta. Treat host suspend
as pause-of-life for the cap.

## Safety model

Rootless-safe by construction — there is no escape hatch to find:

- No `--privileged`, no host docker socket, ever (asserted in `selfcheck.ts`).
- Published ports are loopback-only (`127.0.0.1`), even when the agent asks
  otherwise. Loopback is host-wide, not per-user: on multi-user hosts give
  desktop containers a long random VNC password (the recipe does).
- Host mounts must REALPATH under `$HOME` or the session workspace: symlinks
  are followed before approval and any target outside the roots — or inside a
  credential subtree (`~/.ssh`, `~/.gnupg`, `~/.config/gh`, `~/.aws`,
  `~/.kube`, `~/.docker`, `~/.config/podman`) — is refused.
- Only containers named `dsh-sb-*` carrying this install's ownership token
  are touched; prefix look-alikes with forged labels are invisible.
- Provisioning is capped: a container count limit, a host memory budget, and
  always-on per-container cpu/memory limits (see Config). Pulls refuse to
  start under a 5 GiB storage free-space floor.

## Go-to catalog

`alpine` (cli default), `debian` (desktop default), `ubuntu`, `fedora`,
`arch`, `opensuse`. The two defaults are warm-pulled at boot; everything else
pulls on first create, and `podman_images` shows what is already cached.

## Recipes

Premade instructions in `recipes/`, served through `podman_guide`:
`kde-plasma` (preferred desktop — the `dsh-cu` computer-use plugin drives it),
`node-pnpm` (Node LTS + corepack pnpm), `flatpak-flathub`, `dev-basics`
(git/gh/build toolchains), `python-uv`, `rust`, `go`, `browsers`, `sshd`,
`tmux-sessions`.

## Install

System dependency (outside pnpm):

```sh
sudo apt update && sudo apt install -y podman
```

Into your profile (pnpm only — no profile hand-editing):

Pin a tag or commit for anything long-lived — `#main` re-resolves on every
update and nothing checks CI status at install time:

```sh
dsh plugin add "github:anthony1x6000/dsh-podman-sb#v0.1.0"
```

Then restart `dsh web` for the new bundle layer to take effect. Build
artifacts (`lib/`) are committed, so installing from git runs no build; CI
rebuilds `lib/` from source (config-independently) and diffs it on every push
and PR.

Local development: `pnpm install && pnpm build`, then
`dsh plugin add "link:$(pwd)"`.

## Config

Patch-row `config:` values (all optional):

| Field | Default | Meaning |
|---|---|---|
| `defaultTtlMinutes` | `30` | Lifetime for new containers when the agent sets none |
| `warmPull` | `true` | Warm-pull the two default catalog images at boot |
| `containerCLI` | `podman` | Container CLI binary |
| `dataDir` | `~/.local/share/dsh-podman-sb` | TTL state ledger directory |
| `maxContainers` | `8` | Max concurrent managed sandboxes |
| `defaultCpus` | `2` | Per-container CPU limit when the agent sets none |
| `defaultMemoryMb` | `2048` | Per-container memory limit (MB) when the agent sets none |

## Checks

`pnpm selfcheck` asserts the naming, TTL clamping, rootless-safety, recipe,
and packaging rules, and exercises the committed `lib/` artifact. CI runs it
on Node 22 and 24.
