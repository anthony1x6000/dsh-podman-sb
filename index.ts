/**
 * Rootless Podman sandboxes for DeepSeek Harness agents.
 *
 * Model-facing `podman_*` tools over the `ctx.tools` registry: create
 * throwaway distro containers from a small go-to catalog (or any image ref —
 * ghcr, quay, whatever), run one-shot commands, keep tmux sessions alive in
 * the container, copy files, and read host resources before provisioning.
 *
 * Lifecycle: every container gets a TTL label + a state record + a transient
 * `systemd --user` kill timer, so expiry survives a DSH crash — sweep() at
 * boot and on mutating tool calls re-arms lost timers and removes overdue
 * containers. Default 30 minutes, hard cap 24 hours from creation.
 *
 * Rootless-safe by construction: no `--privileged`, no host docker socket,
 * published ports loopback-only, host mounts under $HOME or the workspace
 * only. Agents never see an escape hatch because there is none.
 *
 * Premade recipes (KDE Plasma for dsh-cu, Node LTS + pnpm, flatpak/flathub,
 * dev basics, python+uv, rust, go, browsers, sshd, tmux sessions) live in
 * `recipes/` and surface through the `podman_guide` tool, caveman voice.
 *
 * Install: `dsh plugin add "github:anthony1x6000/dsh-podman-sb#main"`.
 *
 * @module dsh-podman-sb
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir, cpus as osCpus, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'podman-sb'

/** The tool registry every `podman_*` tool registers into, plus the prompt seam. */
export const inject = ['tools', 'systemPrompt']

/** Every container this plugin manages carries this name prefix. */
export const PREFIX = 'dsh-sb-'

/** Label namespace stamped on managed containers. */
export const LABEL_MANAGED = 'dsh-podman-sb.managed'
const LABEL = {
  managed: LABEL_MANAGED,
  createdAt: 'dsh-podman-sb.created-at',
  expiresAt: 'dsh-podman-sb.expires-at',
  desktop: 'dsh-podman-sb.desktop',
  vncPort: 'dsh-podman-sb.vnc-port',
  novncPort: 'dsh-podman-sb.novnc-port',
  token: 'dsh-podman-sb.token',
} as const

/** Default container lifetime when the agent sets none. */
export const DEFAULT_TTL_MINUTES = 30

/** Hard lifetime cap from creation, no matter how often the agent extends. */
export const MAX_TTL_MINUTES = 24 * 60

/** First host port tried for a desktop container's VNC publish. */
export const VNC_PORT_BASE = 5901

/** First host port tried for a desktop container's noVNC publish. */
export const NOVNC_PORT_BASE = 6081

/** How many ports past the base the allocator walks before giving up. */
const PORT_SPAN = 60

/** Go-to image catalog. Aliases resolve on create; any full ref also works. */
export interface CatalogEntry {
  /** Fully qualified image reference pulled on demand. */
  image: string
  /** One-line pitch the guide shows. */
  tagline: string
  /** True when the entry is a sane desktop base (KDE, flatpak). */
  desktop: boolean
  /** Warmed at plugin boot when `warmPull` is on. */
  warm: boolean
}

export const CATALOG: Record<string, CatalogEntry> = {
  alpine: {
    image: 'docker.io/library/alpine:3.21',
    tagline: '5 MB cli default. apk. fast pull, tiny everything.',
    desktop: false,
    warm: true,
  },
  debian: {
    image: 'docker.io/library/debian:bookworm-slim',
    tagline: 'apt, desktop default. best base for KDE + flatpak.',
    desktop: true,
    warm: true,
  },
  ubuntu: {
    image: 'docker.io/library/ubuntu:24.04',
    tagline: 'apt, familiar, widest docs.',
    desktop: true,
    warm: false,
  },
  fedora: {
    image: 'docker.io/library/fedora:41',
    tagline: 'dnf, fresh packages, podman-native.',
    desktop: true,
    warm: false,
  },
  arch: {
    image: 'docker.io/library/archlinux:base',
    tagline: 'pacman, rolling, KDE-native.',
    desktop: true,
    warm: false,
  },
  opensuse: {
    image: 'registry.opensuse.org/opensuse/tumbleweed:latest',
    tagline: 'zypper, KDE-friendly alternative.',
    desktop: true,
    warm: false,
  },
}

/** Plugin config, every field optional (patch-row `config:` values). */
export interface Config {
  /** Container CLI binary. Default `podman`. */
  containerCLI?: string
  /** Default TTL minutes for new containers. Default 30. */
  defaultTtlMinutes?: number
  /** Warm-pull the two default catalog images at boot. Default true. */
  warmPull?: boolean
  /** State dir holding the TTL ledger. Default `~/.local/share/dsh-podman-sb`. */
  dataDir?: string
}

/** Resolved options the runtime helpers use. */
export interface Options {
  containerCLI: string
  defaultTtlMinutes: number
  warmPull: boolean
  dataDir: string
}

/** Project config onto fully-defaulted options. */
export function resolveConfig(config: Config = {}): Options {
  const ttl = config.defaultTtlMinutes
  return {
    containerCLI: config.containerCLI ?? 'podman',
    defaultTtlMinutes: typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
      ? Math.min(ttl, MAX_TTL_MINUTES)
      : DEFAULT_TTL_MINUTES,
    warmPull: config.warmPull ?? true,
    dataDir: config.dataDir ?? join(homedir(), '.local/share/dsh-podman-sb'),
  }
}

/** Plugin failure with a machine-routable code. */
export class PodmanSbError extends Error {
  readonly code: string
  constructor(message: string, code = 'PODMAN_SB_ERROR') {
    super(message)
    this.name = 'PodmanSbError'
    this.code = code
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * Resolve an image argument: catalog alias or full reference.
 * @param ref - alias like `alpine`, or `ghcr.io/owner/img:tag`.
 * @returns the fully qualified image reference.
 * @throws PodmanSbError on junk input (empty, spaces, bare word).
 */
export function resolveImage(ref: string): string {
  const trimmed = ref.trim()
  if (trimmed.length === 0) throw new PodmanSbError('image reference is empty')
  if (/\s/u.test(trimmed)) throw new PodmanSbError(`image reference has whitespace: ${trimmed}`)
  // Flag-shaped refs must never reach a podman argv option position (audit run-1).
  if (trimmed.startsWith('-') || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(trimmed)) {
    throw new PodmanSbError(`image reference "${trimmed}" is not a valid reference (flag-shaped or bad charset)`)
  }
  const alias = CATALOG[trimmed.toLowerCase()]
  if (alias !== undefined) return alias.image
  // A usable ref names a registry (`ghcr.io/x/y`) or a library image (`debian:tag`).
  if (trimmed.includes('/') || trimmed.includes(':')) return trimmed
  throw new PodmanSbError(
    `"${trimmed}" is neither a catalog alias (${Object.keys(CATALOG).join(', ')})`
    + ' nor an image reference (needs a registry host or a tag, e.g. ghcr.io/owner/img:tag)',
  )
}

/** /^[a-z0-9][a-z0-9-]{0,40}$/ after the prefix: podman-safe, systemd-safe. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/u

/**
 * Full container name from an agent-supplied name, or a random one.
 * @param container - optional bare name; prefixed by the plugin.
 * @returns `dsh-sb-<name>`, unique-ish auto name when omitted.
 * @throws PodmanSbError on unsafe names.
 */
export function containerName(container?: string): string {
  const bare = container?.trim()
  if (bare === undefined || bare.length === 0) return `${PREFIX}sb-${randomBytes(4).toString('hex')}`
  if (!NAME_PATTERN.test(bare)) {
    throw new PodmanSbError(
      `container name "${bare}" must be lowercase letters, digits, dashes (max 41 chars)`,
    )
  }
  const full = PREFIX + bare
  if (full.length > 63) throw new PodmanSbError(`container name "${full}" exceeds 63 chars`)
  return full
}

/**
 * Normalize an agent-supplied container argument to a full managed name.
 * Accepts `box` and `dsh-sb-box`; rejects anything outside the plugin prefix.
 * @param container - agent-supplied name.
 * @returns the full `dsh-sb-*` name.
 * @throws PodmanSbError when the name is invalid or foreign.
 */
export function normalizeContainer(container: string): string {
  const bare = container.trim()
  if (bare.startsWith(PREFIX)) {
    if (!NAME_PATTERN.test(bare.slice(PREFIX.length))) {
      throw new PodmanSbError(`container name "${bare}" is not plugin-safe`)
    }
    return bare
  }
  return containerName(bare)
}

/**
 * Clamp a TTL: junk or missing becomes the default, the cap holds at 24h,
 * and an extension never pushes total life past creation + 24h.
 * @param now - decision time (epoch ms).
 * @param ttlMinutes - requested lifetime.
 * @param createdAtMs - creation time when extending an existing container.
 * @returns the clamped `{ expiresAt, ttlMinutes }`.
 */
export function clampExpiry(now: number, ttlMinutes: number, createdAtMs?: number): {
  expiresAt: number
  ttlMinutes: number
} {
  const requested = typeof ttlMinutes === 'number' && Number.isFinite(ttlMinutes) && ttlMinutes > 0
    ? ttlMinutes
    : DEFAULT_TTL_MINUTES
  const ttl = Math.min(requested, MAX_TTL_MINUTES)
  let expiresAt = now + ttl * 60_000
  if (typeof createdAtMs === 'number' && Number.isFinite(createdAtMs)) {
    expiresAt = Math.min(expiresAt, createdAtMs + MAX_TTL_MINUTES * 60_000)
  }
  return { expiresAt, ttlMinutes: Math.max(1, Math.round((expiresAt - now) / 60_000)) }
}

/** Milliseconds left on a TTL, floored at zero. */
export function remainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now)
}

/**
 * Compact remaining-life text (`29m`, `23h10m`).
 * @param ms - remaining milliseconds.
 * @returns floor-rounded text.
 */
export function ttlText(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)}s`
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
}

/**
 * podman emits `Names` as an array since v4; docker-style output uses a
 * scalar. Both normalize to one usable name or undefined (audit run-1:
 * a shape mismatch silently disabled the whole sweep layer).
 * @param names - the raw `Names` value of a `podman ps --format json` row.
 * @returns the first name when the shape is usable.
 */
export function normalizePsName(names: unknown): string | undefined {
  if (typeof names === 'string') return names.length > 0 ? names : undefined
  if (Array.isArray(names) && names.length > 0 && typeof names[0] === 'string') return names[0]
  return undefined
}

/**
 * Parse a label number: non-numeric or non-finite values fall back to 0 so
 * NaN can never slip past a comparison guard (audit run-1).
 */
export function labelNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * True when a ps row carries this install's ownership token. The prefix and
 * the managed label are forgeable by any same-user podman process; the token
 * file under the plugin data dir is not on that path (audit run-1).
 */
export function ownsRow(labels: Record<string, string>, token: string): boolean {
  return labels[LABEL.token] === token
}

/** Drop ledger entries whose container cannot exist anymore (audit run-1). */
export function pruneLedger(state: StateLedger, now: number): StateLedger {
  const graceMs = 3_600_000
  const containers: StateLedger['containers'] = {}
  for (const [name, entry] of Object.entries(state.containers)) {
    if (Number.isFinite(entry.createdAt) && entry.createdAt + MAX_TTL_MINUTES * 60_000 + graceMs < now) continue
    containers[name] = entry
  }
  return { containers }
}

/**
 * Systemd unit base for one container's kill timer. `systemd-run --unit`
 * appends `.timer`/`.service`; characters outside systemd's safe set become `-`.
 * @param container - full container name.
 * @returns unit base like `dsh-sb-kill-dsh-sb-box`.
 */
export function timerUnitBase(container: string): string {
  const safe = container.replace(/[^A-Za-z0-9_.:-]/gu, '-')
  // Name hash keeps units injective even for foreign >180-char names (audit run-1).
  const hash = createHash('sha256').update(container).digest('hex').slice(0, 8)
  return `dsh-sb-kill-${safe.length > 0 ? safe.slice(0, 180) : 'x'}-${hash}`
}

/**
 * Approve one host mount for a rootless container: it must resolve under
 * $HOME or the session workspace. `/etc`, `/var`, other users' trees, and
 * the docker socket all return null.
 * @param hostPath - the host side of a `HOST:CTR` mount spec.
 * @param home - the current user's home.
 * @param cwd - the current workspace root.
 * @returns the resolved absolute path, or null when rejected.
 */
/** Credential subtrees never mount into a sandbox the model controls. */
const DENIED_SUBTREES = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/gh', '.config/podman']

export function safeMount(hostPath: string, home: string, cwd: string): string | null {
  const homeRoot = realpathSync(home)
  // The workspace root only widens the allowance while it sits inside $HOME.
  const cwdRoot = resolve(cwd)
  const allowedRoots = [homeRoot]
  if (cwdRoot === homeRoot || cwdRoot.startsWith(homeRoot + '/')) allowedRoots.push(realpathSync(cwdRoot))
  // Lexical resolve first, then the kernel's view: a symlink inside an allowed
  // root must not smuggle a target outside it (audit run-1).
  let real: string
  try {
    real = realpathSync(resolve(hostPath))
  } catch {
    return null
  }
  const underAllowed = allowedRoots.some((root) => real === root || real.startsWith(root + '/'))
  if (!underAllowed) return null
  if (real === homeRoot) return null
  const relative = real.startsWith(homeRoot + '/') ? real.slice(homeRoot.length + 1) : ''
  if (DENIED_SUBTREES.some((denied) => relative === denied || relative.startsWith(denied + '/'))) return null
  return real
}

/**
 * Loopback-only publish spec: desktop containers never expose a LAN port.
 * @param hostPort - host port.
 * @param containerPort - container port.
 * @returns `127.0.0.1:HOST:CTR`.
 */
export function portSpec(hostPort: number, containerPort: number): string {
  return `127.0.0.1:${hostPort}:${containerPort}`
}

/**
 * Normalize an agent-supplied publish spec to a loopback-only one.
 * `2222:22` and `0.0.0.0:2222:22` both become `127.0.0.1:2222:22`.
 * @param spec - 2- or 3-part publish spec.
 * @param fallbackHostPort - host port for a bare `22`-style container-only spec.
 * @returns the loopback publish spec, or null when unparseable.
 */
export function normalizePublish(spec: string, fallbackHostPort: number): string | null {
  const parts = spec.split(':')
  let host: number, ctr: number
  if (parts.length === 3) {
    host = Number(parts[1])
    ctr = Number(parts[2])
  } else if (parts.length === 2) {
    host = Number(parts[0])
    ctr = Number(parts[1])
  } else if (parts.length === 1 && /^\d+$/u.test(parts[0])) {
    host = fallbackHostPort
    ctr = Number(parts[0])
  } else {
    return null
  }
  if (!Number.isInteger(host) || !Number.isInteger(ctr) || host < 1 || host > 65535 || ctr < 1 || ctr > 65535) {
    return null
  }
  return portSpec(host, ctr)
}

/**
 * Parse and confine a CONTAINER:/path spec (podman_cp). The embedded name runs
 * through the same prefix rule as every other tool; foreign containers are
 * rejected (audit run-1).
 * @param spec - `box:/tmp/x` or `dsh-sb-box:/tmp/x`.
 * @returns the normalized `{ name, path }`, or null when the spec is foreign
 * or malformed.
 */
export function parseContainerSpec(spec: string): { name: string; path: string } | null {
  const colon = spec.indexOf(':')
  if (colon === -1) return null
  const rawName = spec.slice(0, colon)
  const path = spec.slice(colon + 1)
  if (path.length === 0 || !path.startsWith('/')) return null
  if (rawName.startsWith('-')) return null
  let name: string
  try {
    name = normalizeContainer(rawName)
  } catch {
    return null
  }
  return { name, path }
}

/** Run arguments the plugin may set — the full, validated shape. */
export interface RunSpec {
  container: string
  image: string
  expiresAt: number
  createdAt: number
  desktop: boolean
  /** Install ownership token; foreign containers without it are ignored. */
  token: string
  cpus?: number
  memoryMb?: number
  env?: Record<string, string>
  mounts?: string[]
  ports?: string[]
  vncHostPort?: number
  novncHostPort?: number
}

/**
 * Build the `podman run` argument vector: name, lifecycle labels, resource
 * limits, env, validated mounts, loopback publishes, then `sleep infinity`.
 * Never emits `--privileged` or a socket mount — rootless-safe by shape.
 * @param spec - validated creation facts.
 * @param home - home root for mount validation.
 * @param cwd - workspace root for mount validation.
 * @returns the execFile argument vector.
 * @throws PodmanSbError when a mount leaves the allowed roots.
 */
export function buildRunArgs(spec: RunSpec, home: string = homedir(), cwd: string = process.cwd()): string[] {
  const args: string[] = ['run', '-d', '--name', spec.container]
  const labels: Array<[string, string]> = [
    [LABEL.managed, '1'],
    [LABEL.createdAt, String(spec.createdAt)],
    [LABEL.expiresAt, String(spec.expiresAt)],
    [LABEL.desktop, spec.desktop ? '1' : '0'],
    [LABEL.token, spec.token],
  ]
  if (spec.vncHostPort !== undefined) labels.push([LABEL.vncPort, String(spec.vncHostPort)])
  if (spec.novncHostPort !== undefined) labels.push([LABEL.novncPort, String(spec.novncHostPort)])
  for (const [key, value] of labels) args.push(`--label=${key}=${value}`)
  if (spec.cpus !== undefined && spec.cpus > 0) args.push(`--cpus=${spec.cpus}`)
  if (spec.memoryMb !== undefined && spec.memoryMb > 0) args.push(`--memory=${spec.memoryMb}m`)
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new PodmanSbError(`env key "${key}" is not a valid identifier`)
    }
    args.push(`--env=${key}=${value}`)
  }
  for (const mount of spec.mounts ?? []) {
    const firstColon = mount.indexOf(':')
    if (firstColon === -1) throw new PodmanSbError(`mount "${mount}" needs HOST:CTR form`)
    const host = mount.slice(0, firstColon)
    let containerSide = mount.slice(firstColon + 1)
    // Only 'ro' may follow a second colon; anything else is a bind option
    // smuggle (:U host chown, :Z relabel — audit run-1).
    const secondColon = containerSide.indexOf(':')
    if (secondColon !== -1) {
      const option = containerSide.slice(secondColon + 1)
      if (option !== 'ro') throw new PodmanSbError(`mount "${mount}" may only add the 'ro' option`)
      containerSide = containerSide.slice(0, secondColon)
    }
    if (!/^\/[A-Za-z0-9._/-]*$/u.test(containerSide)) {
      throw new PodmanSbError(`mount "${mount}" container side must be a plain absolute path`)
    }
    const approved = safeMount(host, home, cwd)
    if (approved === null) {
      throw new PodmanSbError(
        `mount host path "${host}" must live under ${home} or ${cwd}, outside credential subtrees (rootless-safe)`,
      )
    }
    args.push(`--volume=${approved}:${containerSide}${secondColon !== -1 ? ':ro' : ''}`)
  }
  for (const publish of spec.ports ?? []) args.push(`--publish=${publish}`)
  // '--' so the image operand can never be option-parsed (audit run-1).
  args.push('--', spec.image, 'sleep', 'infinity')
  return args
}

/** Host memory facts parsed from `/proc/meminfo` (kB lines to bytes). */
export interface Meminfo {
  readonly [key: string]: JsonValue
  memTotalBytes: number
  memAvailableBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
}

/**
 * Parse the `/proc/meminfo` fields this plugin reports.
 * @param text - the file's contents.
 * @returns bytes for total/available memory and swap.
 */
export function parseMeminfo(text: string): Meminfo {
  const fields = new Map<string, number>()
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB$/u.exec(line)
    if (match !== null) fields.set(match[1], Number(match[2]) * 1024)
  }
  return {
    memTotalBytes: fields.get('MemTotal') ?? 0,
    memAvailableBytes: fields.get('MemAvailable') ?? 0,
    swapTotalBytes: fields.get('SwapTotal') ?? 0,
    swapFreeBytes: fields.get('SwapFree') ?? 0,
  }
}

/**
 * Human-readable byte count (`3.0 GiB`).
 * @param bytes - the count.
 * @returns one-decimal KiB/MiB/GiB/TiB text.
 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value.toFixed(1)} ${units[unit]}`
}

/** One recipe index row. */
export interface RecipeRef {
  /** Recipe id, the `podman_guide` argument. */
  id: string
  /** First `#` heading of the file. */
  title: string
}

/** Recipe directory next to this file (source) or one level up (built lib). */
function recipesDir(): string {
  const here = import.meta.dirname
  for (const candidate of [join(here, 'recipes'), join(here, '..', 'recipes')]) {
    if (existsSync(candidate)) return candidate
  }
  return join(here, '..', 'recipes')
}

/**
 * List shipped recipes for the guide index.
 * @returns sorted `{ id, title }` rows.
 */
export function recipeIndex(): RecipeRef[] {
  let files: string[] = []
  try {
    files = readdirSync(recipesDir()).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return []
  }
  return files.map((file) => {
    const text = readFileSync(join(recipesDir(), file), 'utf8')
    const title = text.split('\n').find((line) => line.startsWith('# '))?.slice(2).trim() ?? file
    return { id: file.replace(/\.md$/u, ''), title }
  })
}

/**
 * Load one recipe's full markdown.
 * @param id - recipe id (`kde-plasma`).
 * @returns the text, or undefined when unknown.
 */
export function loadRecipe(id: string): string | undefined {
  if (!/^[a-z0-9-]+$/u.test(id)) return undefined
  const path = join(recipesDir(), `${id}.md`)
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Guide index text: rules, catalog table, recipe list. */
export function guideText(defaultTtlMinutes: number): string {
  const catalogRows = Object.entries(CATALOG)
    .map(([alias, entry]) => `- ${alias} → ${entry.image} — ${entry.tagline}${entry.desktop ? ' [desktop base]' : ''}`)
    .join('\n')
  const recipeRows = recipeIndex().map((r) => `- ${r.id} — ${r.title}`).join('\n')
  return [
    'Podman sandboxes. Rootless, throwaway, any distro. Default TTL '
      + `${defaultTtlMinutes}m, max 24h from creation, extend with podman_extend.`,
    'Check podman_host_resources before big builds. Call podman_create with an image alias or any ref (ghcr.io/...).',
    'Desktop containers auto-publish loopback VNC + noVNC ports; KDE Plasma is the preferred desktop (dsh-cu).',
    'One-shot command: podman_exec. Long-lived work: podman_session_* (tmux inside the container).',
    `Catalog:\n${catalogRows}`,
    `Recipes (podman_guide {"recipe": "<id>"}):\n${recipeRows}`,
  ].join('\n\n')
}

/** Host snapshot every create call embeds. */
export interface HostSnapshot {
  readonly [key: string]: JsonValue
  cpus: number
  load1: number
  load5: number
  load15: number
  mem: Meminfo
  diskFreeBytes: number
  diskTotalBytes: number
  diskPath: string
  text: string
}

/** Read /proc facts and the container-storage statfs into a snapshot. */
function hostSnapshot(): HostSnapshot {
  const mem = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))
  const [load1, load5, load15] = loadavg()
  const storageRoot = join(homedir(), '.local/share/containers/storage')
  const diskPath = existsSync(storageRoot) ? storageRoot : homedir()
  const stats = statfsSync(diskPath)
  const diskTotalBytes = Number(stats.blocks) * Number(stats.bsize)
  const diskFreeBytes = Number(stats.bavail) * Number(stats.bsize)
  const text = [
    `Host: ${osCpus().length} cpus, load ${load1.toFixed(2)} ${load5.toFixed(2)} ${load15.toFixed(2)}`,
    `Mem:  total ${humanBytes(mem.memTotalBytes)}, available ${humanBytes(mem.memAvailableBytes)}`
      + `, swap ${humanBytes(mem.swapTotalBytes)} (${humanBytes(mem.swapFreeBytes)} free)`,
    `Disk: ${humanBytes(diskFreeBytes)} free of ${humanBytes(diskTotalBytes)} at ${diskPath}`,
  ].join('\n')
  return { cpus: osCpus().length, load1, load5, load15, mem, diskFreeBytes, diskTotalBytes, diskPath, text }
}

// ── runtime helpers ─────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

/** Run the container CLI; collapse failures into one readable line. */
async function podman(
  options: Options,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(options.containerCLI, args, {
      signal,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('ERR_SCRIPT_EXECUTABLE')) {
      throw new PodmanSbError(
        `\`${options.containerCLI}\` failed to run; is Podman installed?`,
        'PODMAN_SB_CLI_MISSING',
      )
    }
    throw new PodmanSbError(
      `\`${options.containerCLI} ${args.slice(0, 3).join(' ')}\` failed: ${cliErrorText(error)}`,
    )
  }
}

/** Shortest decisive stderr/message line of an exec failure. */
function cliErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { stderr, message, code } = error as { stderr?: unknown; message?: unknown; code?: unknown }
    const text = typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr.trim()
      : typeof message === 'string'
        ? message
        : String(error)
    if (typeof code === 'number' && code > 0 && !text.includes(String(code))) {
      return `${text} (exit ${code})`
    }
    return text
  }
  return String(error)
}

/** Abort-aware sleep. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new PodmanSbError('aborted', 'PODMAN_SB_ABORTED'))
    }, { once: true })
  })
}

/** One managed container row from `podman ps`. */
interface ManagedRow {
  name: string
  image: string
  state: string
  status: string
  labels: Record<string, string>
  createdAt: number
  expiresAt: number
  desktop: boolean
  vncPort: number | undefined
  novncPort: number | undefined
}

/**
 * List every container this install owns: managed label, prefix, NAME_PATTERN,
 * and the ownership token must all hold (audit run-1). Foreign look-alikes are
 * invisible to sweep/extend/remove on purpose.
 */
async function listManaged(options: Options, signal?: AbortSignal): Promise<ManagedRow[]> {
  const { stdout } = await podman(
    options,
    ['ps', '-a', '--filter', `label=${LABEL.managed}=1`, '--format', 'json'],
    signal,
  )
  let rows: Array<Record<string, unknown>> = []
  try {
    rows = JSON.parse(stdout) as Array<Record<string, unknown>>
  } catch (parseError) {
    console.warn(`[podman-sb] podman ps emitted unparseable JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    return []
  }
  let token: string
  try {
    token = installToken(options)
  } catch {
    return []
  }
  return rows
    .map((row) => {
      const name = normalizePsName(row.Names)
      if (name === undefined || !name.startsWith(PREFIX) || !NAME_PATTERN.test(name.slice(PREFIX.length))) return null
      const labels = (row.Labels ?? {}) as Record<string, string>
      if (typeof labels !== 'object' || !ownsRow(labels, token)) return null
      return {
        name,
        image: String(row.Image ?? ''),
        state: String(row.State ?? ''),
        status: String(row.Status ?? ''),
        labels,
        createdAt: labelNumber(labels[LABEL.createdAt]),
        expiresAt: labelNumber(labels[LABEL.expiresAt]),
        desktop: labels[LABEL.desktop] === '1',
        vncPort: labelNumber(labels[LABEL.vncPort]) !== 0 ? labelNumber(labels[LABEL.vncPort]) : undefined,
        novncPort: labelNumber(labels[LABEL.novncPort]) !== 0 ? labelNumber(labels[LABEL.novncPort]) : undefined,
      }
    })
    .filter((row): row is ManagedRow => row !== null)
}

/** TTL ledger entries surviving crashes; label is the fallback source. */
interface StateLedger {
  containers: Record<string, { createdAt: number; expiresAt: number }>
}

/** This install's ownership token; stamped on every container we create. */
function installToken(options: Options): string {
  const path = join(options.dataDir, 'token')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{32,}$/u.test(existing)) return existing
  } catch { /* first use */ }
  mkdirSync(options.dataDir, { recursive: true })
  const token = randomBytes(24).toString('hex')
  writeFileSync(path, token + '\n', { mode: 0o600 })
  return token
}

/**
 * Persist the state ledger: prune stale entries, refuse to follow a
 * pre-placed symlink, write via temp+rename at mode 0600 (audit run-1).
 */
function writeState(options: Options, state: StateLedger): void {
  mkdirSync(options.dataDir, { recursive: true })
  const pruned = pruneLedger(state, Date.now())
  const finalPath = join(options.dataDir, 'state.json')
  const tempPath = `${finalPath}.tmp-${randomBytes(4).toString('hex')}`
  const stats = existsSync(finalPath) ? lstatSync(finalPath) : undefined
  if (stats !== undefined && !stats.isFile()) {
    throw new PodmanSbError(`state ledger path ${finalPath} is not a regular file`, 'PODMAN_SB_STATE_UNSAFE')
  }
  writeFileSync(tempPath, JSON.stringify(pruned, null, 2) + '\n', { mode: 0o600 })
  renameSync(tempPath, finalPath)
}

/** Read the state ledger; missing file is an empty ledger. */
function readState(options: Options): StateLedger {
  try {
    const parsed = JSON.parse(readFileSync(join(options.dataDir, 'state.json'), 'utf8')) as StateLedger
    return parsed !== null && typeof parsed === 'object' && parsed.containers !== null && typeof parsed.containers === 'object'
      ? parsed
      : { containers: {} }
  } catch {
    return { containers: {} }
  }
}

/** Stop one container's kill timer; absent timers are fine. */
async function cancelTimer(container: string): Promise<void> {
  const base = timerUnitBase(container)
  try {
    await execFileAsync('systemctl', ['--user', 'stop', `${base}.timer`], { timeout: 10_000 })
  } catch { /* not armed, or systemd absent: sweep still enforces */ }
  try {
    await execFileAsync('systemctl', ['--user', 'reset-failed', `${base}.service`], { timeout: 10_000 })
  } catch { /* same */ }
}

/**
 * Arm the transient kill timer: `systemd-run --user --on-active=<remaining>`
 * runs `podman rm -tf` at the deadline. Survives DSH restarts by design.
 * @param container - full container name.
 * @param expiresAt - epoch ms deadline.
 * @param options - resolved options (CLI to kill with).
 */
async function armTimer(container: string, expiresAt: number, options: Options): Promise<void> {
  const remaining = Math.max(1_000, expiresAt - Date.now())
  const base = timerUnitBase(container)
  // The unit retries its rm: a busy storage lock at fire time must not end
  // enforcement (audit run-1).
  const kill = `i=0; until ${options.containerCLI} rm -tf ${container}; do i=$((i+1)); [ "$i" -ge 5 ] && exit 1; sleep 10; done`
  const argv = ['--user', '--on-active', String(remaining), '--unit', base, '/bin/sh', '-c', kill]
  const arm = async (): Promise<void> => {
    await execFileAsync('systemd-run', argv, { timeout: 10_000 })
  }
  try {
    await arm()
  } catch (error: unknown) {
    const text = String((error as { message?: string }).message ?? '')
    // A stopped-but-loaded unit or a same-name squatter: tear it down and arm ours.
    if (/already (loaded|exists)/iu.test(text)) {
      await cancelTimer(container)
      await arm()
      return
    }
    // No user systemd (bare container host, macOS, WSL): the sweep fallback
    // owns the deadline; surface the failure so callers can warn (audit run-1).
    throw new PodmanSbError(
      `could not arm kill timer for ${container} (systemd --user unavailable?): ${text}`,
      'PODMAN_SB_TIMER_UNAVAILABLE',
    )
  }
}

/**
 * Sweep managed containers: remove overdue ones, re-arm lost timers, and
 * adopt label-only rows (a DSH crash orphaned their state). Called at boot
 * and from mutating tools.
 */
async function sweepOnce(options: Options, signal?: AbortSignal): Promise<void> {
  let rows: ManagedRow[]
  try {
    rows = await listManaged(options, signal)
  } catch (error: unknown) {
    console.warn(`[podman-sb] sweep skipped, podman unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const state = readState(options)
  let dirty = false
  const now = Date.now()
  for (const row of rows) {
    const ledger = state.containers[row.name]
    // Ledger and label disagree: the earlier deadline wins (audit run-1).
    const expiresAt = Math.min(
      ...[ledger?.expiresAt, row.expiresAt].filter((value) => Number.isFinite(value) && value > 0),
    )
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) continue
    if (now >= expiresAt) {
      await cancelTimer(row.name)
      try {
        await podman(options, ['rm', '-tf', row.name], signal)
      } catch (error: unknown) {
        // Keep the ledger entry unless the container is really gone: a failed
        // rm must not end enforcement (audit run-1).
        if (await containerExists(options, row.name, signal)) {
          console.warn(`[podman-sb] overdue ${row.name} survived rm: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      delete state.containers[row.name]
      dirty = true
      continue
    }
    if (ledger === undefined) {
      state.containers[row.name] = { createdAt: row.createdAt, expiresAt }
      dirty = true
      try {
        await armTimer(row.name, expiresAt, options)
      } catch (armError: unknown) {
        console.warn(`[podman-sb] ${armError instanceof Error ? armError.message : String(armError)}; periodic sweep owns the deadline`)
      }
      continue
    }
    // Timer present in the ledger: re-arm only when systemd lost it (reboot).
    try {
      const { stdout } = await execFileAsync(
        'systemctl', ['--user', 'is-active', `${timerUnitBase(row.name)}.timer`],
        { timeout: 5_000 },
      )
      if (stdout.trim() !== 'active') await armTimer(row.name, expiresAt, options)
    } catch {
      try {
        await armTimer(row.name, expiresAt, options)
      } catch { /* systemd absent: periodic sweep owns the deadline */ }
    }
  }
  if (dirty) writeState(options, state)
}

/** Find the first bindable loopback port at or past a base. */
async function allocPort(base: number, used: ReadonlySet<number>): Promise<number> {
  for (let port = base; port < base + PORT_SPAN; port += 1) {
    if (used.has(port)) continue
    const free = await new Promise<boolean>((resolvePort) => {
      const server = createServer()
      server.once('error', () => resolvePort(false))
      server.once('listening', () => server.close(() => resolvePort(true)))
      server.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new PodmanSbError(`no free host port within ${base}..${base + PORT_SPAN}`)
}

/** Ports already claimed by live managed desktop containers. */
async function usedDesktopPorts(options: Options, signal?: AbortSignal): Promise<Set<number>> {
  const used = new Set<number>()
  for (const row of await listManaged(options, signal)) {
    if (row.vncPort !== undefined) used.add(row.vncPort)
    if (row.novncPort !== undefined) used.add(row.novncPort)
  }
  return used
}

/** Ensure an image exists locally; pull when missing. Light by default. */
async function ensureImage(options: Options, image: string, signal?: AbortSignal): Promise<string> {
  try {
    await podman(options, ['image', 'inspect', image], signal, 30_000)
    return 'cached'
  } catch { /* not local yet */ }
  await podman(options, ['pull', image], signal, 600_000)
  return 'pulled'
}

/** True when a managed container with this full name exists. */
async function containerExists(options: Options, container: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await podman(options, ['inspect', container], signal, 30_000)
    return true
  } catch {
    return false
  }
}

/** Canonical output for tools whose value carries a rendered `text` field. */
function jsonTextOutput() {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [text(String((value as { text: string }).text))],
  }
}

/** Text content block. */
function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

// ── tool definitions ────────────────────────────────────────────────────────

/**
 * Register the podman sandbox tools and the prompt section.
 * @param ctx - plugin context with `ctx.tools` and `ctx.systemPrompt`.
 * @param config - optional defaults from the patch row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const options = resolveConfig(config)
  const home = homedir()
  const cwd = process.cwd()

  ctx.systemPrompt?.section({
    name: 'tool:podman-sb',
    order: 1750,
    text: 'podman_* tools manage rootless throwaway Linux sandboxes. Default lifetime '
      + `${options.defaultTtlMinutes} minutes, hard max 24h from creation. Read `
      + 'podman_host_resources before provisioning anything heavy. Call '
      + 'podman_guide for the image catalog and premade recipes (KDE Plasma desktop '
      + 'for dsh-cu, Node LTS + pnpm, flatpak/flathub, and more).',
  })

  const register = (definition: ReturnType<typeof defineTool>): void => {
    ctx.tools.register(definition)
  }

  register(defineTool({
    name: 'podman_host_resources',
    description: 'Read host resources (free memory, cpu count and load, container-storage disk, '
      + 'running sandbox count) before provisioning a container or a big build.',
    parameters: {},
    output: jsonTextOutput(),
    isConcurrencySafe: () => true,
    async execute(): Promise<JsonValue> {
      const snapshot = hostSnapshot()
      let running = 0
      try {
        const rows = await listManaged(options)
        running = rows.filter((row) => row.state === 'running').length
      } catch { /* podman missing: the snapshot still answers */ }
      const warnings: string[] = []
      if (snapshot.mem.memAvailableBytes < 1024 ** 3) {
        warnings.push('under 1 GiB memory available: skip desktop containers, keep builds small')
      }
      if (snapshot.load1 > snapshot.cpus) {
        warnings.push(`load ${snapshot.load1.toFixed(2)} above ${snapshot.cpus} cpus: expect slow builds`)
      }
      return { ...snapshot, runningSandboxes: running, warnings, text: snapshot.text }
    },
  }))

  register(defineTool({
    name: 'podman_create',
    description: 'Create a rootless sandbox container from a catalog alias (alpine, debian, ubuntu, '
      + 'fedora, arch, opensuse) or any image reference (ghcr.io/owner/img:tag). Desktop containers '
      + 'auto-publish loopback VNC + noVNC host ports. Lifetime: default '
      + `${options.defaultTtlMinutes} minutes, max 24h; the container is killed at the deadline.`,
    parameters: {
      name: { type: 'string', description: 'Bare container name (lowercase/dashes); auto-generated when omitted.' },
      image: { type: 'string', description: 'Catalog alias (alpine, debian, ubuntu, fedora, arch, opensuse) or a full image ref. Defaults: alpine (cli), debian (desktop).' },
      desktop: { type: 'boolean', description: 'Desktop base: defaults to debian, auto-publishes loopback VNC (container 5901) and noVNC (container 6081) host ports.' },
      ttl_minutes: { type: 'number', description: `Lifetime in minutes. Default ${options.defaultTtlMinutes}, max ${MAX_TTL_MINUTES} from creation.` },
      cpus: { type: 'number', description: 'CPU limit (podman --cpus), e.g. 2.' },
      memory_mb: { type: 'number', description: 'Memory limit in MB (podman --memory), e.g. 4096.' },
      env: { type: 'json', description: 'Object of environment variables for the container.' },
      mounts: { type: 'json', description: 'Array of HOST:CTR mounts; host paths must be under $HOME or the workspace.' },
      mount_workspace: { type: 'boolean', description: 'Mount the current workspace at /workspace (read-write).' },
      ports: { type: 'json', description: 'Array of extra publish specs like "2222:22"; host side is forced to 127.0.0.1.' },
    },
    timeoutMs: 600_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as {
        name?: string, image?: string, desktop?: boolean, ttl_minutes?: number,
        cpus?: number, memory_mb?: number, env?: Record<string, string>,
        mounts?: string[], mount_workspace?: boolean, ports?: string[]
      }
      await sweepOnce(options, exec.signal)
      const container = containerName(spec.name)
      if (await containerExists(options, container, exec.signal)) {
        throw new PodmanSbError(`container "${container}" already exists`, 'PODMAN_SB_NAME_TAKEN')
      }
      const desktop = spec.desktop === true
      const image = resolveImage(spec.image?.trim() ?? (desktop ? 'debian' : 'alpine'))
      const imageState = await ensureImage(options, image, exec.signal)
      const now = Date.now()
      const { expiresAt, ttlMinutes } = clampExpiry(now, spec.ttl_minutes ?? options.defaultTtlMinutes, now)
      let vncHostPort: number | undefined
      let novncHostPort: number | undefined
      const ports: string[] = []
      if (desktop) {
        const used = await usedDesktopPorts(options, exec.signal)
        vncHostPort = await allocPort(VNC_PORT_BASE, used)
        used.add(vncHostPort)
        novncHostPort = await allocPort(NOVNC_PORT_BASE, used)
        ports.push(portSpec(vncHostPort, 5901), portSpec(novncHostPort, 6081))
      }
      for (const publish of spec.ports ?? []) {
        const normalized = normalizePublish(publish, 9100)
        if (normalized === null) throw new PodmanSbError(`publish spec "${publish}" is unparseable`)
        ports.push(normalized)
      }
      const mounts = [...(spec.mounts ?? [])]
      if (spec.mount_workspace === true) mounts.push(`${cwd}:/workspace`)
      const runArgs = buildRunArgs(
        { container, image, expiresAt, createdAt: now, desktop, token: installToken(options), cpus: spec.cpus, memoryMb: spec.memory_mb, env: spec.env, mounts, ports, vncHostPort, novncHostPort },
        home, cwd,
      )
      await podman(options, runArgs, exec.signal, 120_000)
      const state = readState(options)
      state.containers[container] = { createdAt: now, expiresAt }
      writeState(options, state)
      let timerWarning: string | undefined
      try {
        await armTimer(container, expiresAt, options)
      } catch (armError: unknown) {
        timerWarning = armError instanceof Error ? armError.message : String(armError)
      }
      const snapshot = hostSnapshot()
      const lines = [
        `Container ${container} up. Image ${image} (${imageState}).`,
        `Lifetime: ${ttlText(remainingMs(expiresAt, Date.now()))} (expires ${new Date(expiresAt).toISOString()}).`,
      ]
      if (desktop) {
        lines.push(`VNC: 127.0.0.1:${vncHostPort} (container 5901). noVNC: http://127.0.0.1:${novncHostPort}/vnc.html (container 6081).`)
        lines.push('Desktop next: podman_guide {"recipe": "kde-plasma"} — preferred, dsh-cu drives it.')
      }
      if (timerWarning !== undefined) {
        lines.push(`Warning: kill timer could not be armed (${timerWarning}); the periodic sweep still enforces the ${ttlText(remainingMs(expiresAt, Date.now()))} deadline while DSH runs.`)
      }
      lines.push('Host snapshot before you build:', snapshot.text)
      if (snapshot.mem.memAvailableBytes < 1024 ** 3) {
        lines.push('Warning: under 1 GiB memory available.')
      }
      return {
        container, image, imageState, desktop, expiresAt, ttlMinutes,
        publishedPorts: ports,
        ...(vncHostPort !== undefined ? { vncHostPort } : {}),
        ...(novncHostPort !== undefined ? { novncHostPort } : {}),
        host: snapshot, text: lines.join('\n'),
      }
    },
  }))

  register(defineTool({
    name: 'podman_exec',
    description: 'Run one command inside a sandbox container (`sh -lc`), one-shot. Output and exit '
      + 'code come back in the result. For long-lived or interactive work use podman_session_send.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name (bare or dsh-sb- prefixed).' },
      command: { type: 'string', required: true, description: 'Shell command line; runs under sh -lc inside the container.' },
      workdir: { type: 'string', description: 'Working directory inside the container (-w).' },
      timeout_seconds: { type: 'number', description: 'Per-call timeout in seconds; default 240, max 540 (the tool call deadline still applies).' },
    },
    timeoutMs: 600_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string, command: string, workdir?: string, timeout_seconds?: number }
      const container = normalizeContainer(spec.container)
      const seconds = Math.max(1, Math.min(540, spec.timeout_seconds ?? 240))
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(seconds * 1000)])
      const argv = ['exec', '--env', 'TERM=dumb']
      if (spec.workdir !== undefined && spec.workdir.length > 0) argv.push('-w', spec.workdir)
      argv.push(container, 'sh', '-lc', spec.command)
      let stdout = '', stderr = '', exitCode = 0
      try {
        const done = await execFileAsync(options.containerCLI, argv, { signal, timeout: seconds * 1000, maxBuffer: 16 * 1024 * 1024 })
        stdout = done.stdout
        stderr = done.stderr
      } catch (error: unknown) {
        if (exec.signal.aborted) throw new PodmanSbError('exec aborted', 'PODMAN_SB_ABORTED')
        const failure = error as { code?: number | string, stdout?: string, stderr?: string, killed?: boolean }
        if (failure.killed === true) {
          throw new PodmanSbError(`command exceeded ${seconds}s`, 'PODMAN_SB_TIMEOUT')
        }
        exitCode = typeof failure.code === 'number' ? failure.code : 1
        stdout = failure.stdout ?? ''
        stderr = failure.stderr ?? ''
      }
      const body = [
        stdout.length > 0 ? stdout : '(no stdout)',
        stderr.trim().length > 0 ? `[stderr]\n${stderr.trim()}` : '',
        `[exit code: ${exitCode}]`,
      ].filter((part) => part.length > 0).join('\n')
      return { container, exitCode, stdout, stderr, text: body }
    },
  }))

  register(defineTool({
    name: 'podman_session_send',
    description: 'Feed keys into a tmux session inside a container (auto-created on first send) and '
      + 'return the pane text. Long builds, dev servers, watch loops: send here, peek with '
      + 'podman_session_capture. Sessions live in the container and survive DSH restarts.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
      session: { type: 'string', required: true, description: 'tmux session name; created when missing.' },
      keys: { type: 'string', required: true, description: 'Keys to send (a command line, or single keys like "q").' },
      enter: { type: 'boolean', description: 'Send Enter after the keys (default true; false for interactive keystrokes).' },
      wait_seconds: { type: 'number', description: 'Seconds to let output settle before the pane read (default 2, max 30).' },
      lines: { type: 'number', description: 'Pane lines returned (default 40).' },
    },
    timeoutMs: 120_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string, session: string, keys: string, enter?: boolean, wait_seconds?: number, lines?: number }
      const container = normalizeContainer(spec.container)
      const session = validateSession(spec.session)
      const created = !(await tmux(options, container, ['has-session', '-t', session], exec.signal))
      if (created) {
        await tmux(options, container, ['new-session', '-d', '-s', session], exec.signal)
      }
      await tmux(options, container, ['send-keys', '-t', session, '-l', '--', spec.keys], exec.signal)
      if (spec.enter !== false) {
        await tmux(options, container, ['send-keys', '-t', session, 'Enter'], exec.signal)
      }
      const waitMs = Math.max(0, Math.min(30, spec.wait_seconds ?? 2)) * 1000
      if (waitMs > 0) await sleep(waitMs, exec.signal)
      const pane = await capturePane(options, container, session, spec.lines ?? 40, exec.signal)
      return { container, session, created, pane, text: pane }
    },
  }))

  register(defineTool({
    name: 'podman_session_capture',
    description: 'Re-read a tmux session pane inside a container without sending anything.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
      session: { type: 'string', required: true, description: 'tmux session name.' },
      lines: { type: 'number', description: 'Pane lines returned (default 40).' },
    },
    timeoutMs: 30_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string, session: string, lines?: number }
      const container = normalizeContainer(spec.container)
      const session = validateSession(spec.session)
      const pane = await capturePane(options, container, session, spec.lines ?? 40, exec.signal)
      return { container, session, pane, text: pane }
    },
  }))

  register(defineTool({
    name: 'podman_session_list',
    description: 'List tmux sessions in a container.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
    },
    timeoutMs: 30_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string }
      const container = normalizeContainer(spec.container)
      const { stdout } = await podman(
        options, ['exec', container, 'tmux', 'ls', '--format', '#{session_name}'], exec.signal, 30_000,
      )
      const sessions = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      return { container, sessions, text: sessions.length > 0 ? sessions.join('\n') : '(no sessions)' }
    },
  }))

  register(defineTool({
    name: 'podman_session_kill',
    description: 'Kill one tmux session in a container, or every session when `session` is omitted.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
      session: { type: 'string', description: 'Session to kill; omit to kill the whole tmux server.' },
    },
    timeoutMs: 30_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string, session?: string }
      const container = normalizeContainer(spec.container)
      const argv = spec.session !== undefined
        ? ['kill-session', '-t', validateSession(spec.session)]
        : ['kill-server']
      await podman(options, ['exec', container, 'tmux', ...argv], exec.signal, 30_000)
      return { container, killed: spec.session ?? 'all', text: 'killed' }
    },
  }))

  register(defineTool({
    name: 'podman_cp',
    description: 'Copy a file or directory between host and container. Host paths must stay under '
      + '$HOME or the workspace (rootless-safe).',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
      src: { type: 'string', required: true, description: 'Source: host path (to_container) or container path like box:/tmp/out.' },
      dst: { type: 'string', required: true, description: 'Destination: container path like box:/data (to_container) or host path.' },
      to_container: { type: 'boolean', required: true, description: 'true: host→container; false: container→host.' },
    },
    timeoutMs: 300_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string, src: string, dst: string, to_container: boolean }
      const container = normalizeContainer(spec.container)
      let argv: string[]
      if (spec.to_container) {
        const approved = safeMount(spec.src, home, cwd)
        if (approved === null) {
          throw new PodmanSbError(`host source "${spec.src}" must live under ${home} or ${cwd}, outside credential subtrees`)
        }
        const target = parseContainerSpec(spec.dst)
        if (target === null) throw new PodmanSbError('destination needs a managed CONTAINER:/abs/path form')
        if (target.name !== container) throw new PodmanSbError(`destination names container "${target.name}", not "${container}"`)
        argv = ['cp', approved, `${target.name}:${target.path}`]
      } else {
        const source = parseContainerSpec(spec.src)
        if (source === null) throw new PodmanSbError('source needs a managed CONTAINER:/abs/path form')
        if (source.name !== container) throw new PodmanSbError(`source names container "${source.name}", not "${container}"`)
        const approved = safeMount(spec.dst, home, cwd)
        if (approved === null) {
          throw new PodmanSbError(`host destination "${spec.dst}" must live under ${home} or ${cwd}, outside credential subtrees`)
        }
        argv = ['cp', `${source.name}:${source.path}`, approved]
      }
      const { stdout } = await podman(options, argv, exec.signal, 300_000)
      return { container, copied: `${spec.src} → ${spec.dst}`, output: stdout.trim(), text: 'copied' }
    },
  }))

  register(defineTool({
    name: 'podman_list',
    description: 'List this plugin\'s sandbox containers with image, status, remaining lifetime, and '
      + 'published desktop ports. Runs the expiry sweep first.',
    parameters: {},
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    output: jsonTextOutput(),
    async execute(_args, exec): Promise<JsonValue> {
      await sweepOnce(options, exec.signal)
      const rows = await listManaged(options, exec.signal)
      const state = readState(options)
      const now = Date.now()
      const items = rows.map((row) => {
        const expiresAt = state.containers[row.name]?.expiresAt ?? row.expiresAt
        return {
          name: row.name.slice(PREFIX.length), full: row.name, image: row.image,
          state: row.state, status: row.status,
          expiresAt, remaining: expiresAt > 0 ? ttlText(remainingMs(expiresAt, now)) : 'unknown',
          desktop: row.desktop,
          ...(row.vncPort !== undefined ? { vncPort: row.vncPort } : {}),
          ...(row.novncPort !== undefined ? { novncPort: row.novncPort } : {}),
        }
      })
      const textOut = items.length === 0
        ? 'No sandboxes. Create one with podman_create.'
        : items.map((item) => {
            const bits = [`${item.full}  ${item.image}  [${item.state}]  TTL ${item.remaining}`]
            if (item.desktop && item.vncPort !== undefined && item.novncPort !== undefined) {
              bits.push(`  vnc 127.0.0.1:${item.vncPort} novnc 127.0.0.1:${item.novncPort}`)
            }
            return bits.join('\n')
          }).join('\n')
      return { containers: items, text: textOut }
    },
  }))

  register(defineTool({
    name: 'podman_stop',
    description: 'Stop a sandbox container (keep it and its TTL; the kill timer still removes it at '
      + 'the deadline).',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
    },
    timeoutMs: 60_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string }
      const container = normalizeContainer(spec.container)
      await podman(options, ['stop', '-t', '10', container], exec.signal, 60_000)
      return { container, text: `stopped ${container} (TTL still ticking)` }
    },
  }))

  register(defineTool({
    name: 'podman_remove',
    description: 'Remove a sandbox container now: cancel its kill timer, delete its state, force-remove it.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
    },
    timeoutMs: 60_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string }
      const container = normalizeContainer(spec.container)
      const owned = (await listManaged(options, exec.signal)).some((row) => row.name === container)
      if (!owned) throw new PodmanSbError(`container "${container}" is not a managed sandbox`, 'PODMAN_SB_NOT_MANAGED')
      await cancelTimer(container)
      try {
        await podman(options, ['rm', '-tf', container], exec.signal, 60_000)
      } catch { /* already gone: state cleanup still runs */ }
      const state = readState(options)
      delete state.containers[container]
      writeState(options, state)
      return { container, text: `removed ${container}` }
    },
  }))

  register(defineTool({
    name: 'podman_extend',
    description: 'Extend a sandbox container\'s lifetime. Total life never exceeds 24h from creation; '
      + 'the kill timer is re-armed.',
    parameters: {
      container: { type: 'string', required: true, description: 'Container name.' },
      ttl_minutes: { type: 'number', required: true, description: `Minutes from now. Total caps at ${MAX_TTL_MINUTES} from creation.` },
    },
    timeoutMs: 60_000,
    output: jsonTextOutput(),
    async execute(args, exec): Promise<JsonValue> {
      const spec = args as { container: string, ttl_minutes: number }
      const container = normalizeContainer(spec.container)
      await sweepOnce(options, exec.signal)
      const rows = await listManaged(options, exec.signal)
      const row = rows.find((candidate) => candidate.name === container)
      if (row === undefined) throw new PodmanSbError(`container "${container}" is not a managed sandbox`)
      const state = readState(options)
      const createdAt = state.containers[container]?.createdAt ?? row.createdAt
      const { expiresAt, ttlMinutes } = clampExpiry(Date.now(), spec.ttl_minutes, createdAt)
      state.containers[container] = { createdAt, expiresAt }
      writeState(options, state)
      await cancelTimer(container)
      try {
        await armTimer(container, expiresAt, options)
      } catch (armError: unknown) {
        console.warn(`[podman-sb] extend re-arm failed: ${armError instanceof Error ? armError.message : String(armError)}`)
      }
      const textOut = `${container} now expires in ${ttlText(remainingMs(expiresAt, Date.now()))} `
        + `(${new Date(expiresAt).toISOString()}), total cap ${MAX_TTL_MINUTES}m from creation`
      return { container, expiresAt, ttlMinutes, text: textOut }
    },
  }))

  register(defineTool({
    name: 'podman_images',
    description: 'List cached container images and which catalog images are already local, with sizes. '
      + 'Keeps downloads light: create pulls only what is missing.',
    parameters: {},
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    output: jsonTextOutput(),
    async execute(_args, exec): Promise<JsonValue> {
      const { stdout } = await podman(options, ['images', '--format', 'json'], exec.signal, 60_000)
      let images: Array<{ RepoTags?: string[], Size?: number }> = []
      try {
        images = JSON.parse(stdout) as Array<{ RepoTags?: string[], Size?: number }>
      } catch { /* empty table */ }
      const cached = images.map((image) => ({
        ref: image.RepoTags?.[0] ?? '(untagged)',
        sizeBytes: image.Size ?? 0,
      }))
      const catalogPresence = Object.entries(CATALOG).map(([alias, entry]) => ({
        alias,
        image: entry.image,
        cached: cached.some((row) => row.ref === entry.image || row.ref === `${entry.image}:latest`),
      }))
      const lines = [
        ...cached.map((row) => `${row.ref}  ${humanBytes(row.sizeBytes)}`),
        ...catalogPresence.map((row) => `${row.cached ? '[cached] ' : '[missing] '}${row.alias} → ${row.image}`),
      ]
      return { cached, catalog: catalogPresence, text: lines.length > 0 ? lines.join('\n') : '(no images)' }
    },
  }))

  register(defineTool({
    name: 'podman_guide',
    description: 'The sandbox guide: rules (TTL, rootless safety, loopback ports), the image catalog, '
      + 'and premade recipes. Pass a recipe id (kde-plasma, node-pnpm, flatpak-flathub, dev-basics, '
      + 'python-uv, rust, go, browsers, sshd, tmux-sessions) for its full instructions.',
    parameters: {
      recipe: { type: 'string', description: 'Recipe id for full instructions; omit for the index.' },
    },
    isConcurrencySafe: () => true,
    output: jsonTextOutput(),
    async execute(args): Promise<JsonValue> {
      const spec = args as { recipe?: string }
      if (spec.recipe !== undefined) {
        const content = loadRecipe(spec.recipe.trim())
        if (content === undefined) {
          throw new PodmanSbError(
            `unknown recipe "${spec.recipe}"; index: ${recipeIndex().map((r) => r.id).join(', ')}`,
          )
        }
        return { recipe: spec.recipe, text: content }
      }
      return { text: guideText(options.defaultTtlMinutes) }
    },
  }))

  // Boot-time rediscovery: sweep orphans, re-arm lost timers.
  sweepOnce(options).catch((error: unknown) => {
    console.warn(`[podman-sb] boot sweep: ${error instanceof Error ? error.message : String(error)}`)
  })
  // Periodic sweep so the TTL cap never depends on a mutating tool call or an
  // armed timer alone (audit run-1: silent timer failure + lazy sweep).
  const sweepInterval = setInterval(() => {
    sweepOnce(options).catch(() => { /* warned inside sweepOnce */ })
  }, 60_000)
  sweepInterval.unref?.()
  const dispose = () => clearInterval(sweepInterval)
  const effectful = (ctx as unknown as { effect?: (fn: () => () => void) => unknown }).effect
  if (typeof effectful === 'function') effectful.call(ctx, () => { dispose(); return dispose })
  // Warm pull keeps the two defaults cached; failures surface on first create.
  if (options.warmPull) {
    for (const entry of Object.values(CATALOG).filter((candidate) => candidate.warm)) {
      ensureImage(options, entry.image).catch((error: unknown) => {
        console.warn(`[podman-sb] warm pull ${entry.image}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }
}

/** Run `tmux <args>` inside a container; exit code 0 is the boolean. */
async function tmux(
  options: Options, container: string, args: string[], signal?: AbortSignal,
): Promise<boolean> {
  try {
    await podman(options, ['exec', container, 'tmux', ...args], signal, 60_000)
    return true
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    if (/executable file not found|not found in \$PATH/iu.test(text)) {
      throw new PodmanSbError(
        `tmux is not installed in ${container}; install it first (podman_guide {"recipe": "tmux-sessions"})`,
        'PODMAN_SB_NO_TMUX',
      )
    }
    // has-session failing only means the session does not exist yet.
    if (args[0] === 'has-session') return false
    throw error
  }
}

/** Capture a tmux pane (last `lines` lines) as text. */
async function capturePane(
  options: Options, container: string, session: string, lines: number, signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await podman(
    options,
    ['exec', container, 'tmux', 'capture-pane', '-t', session, '-p', '-S', `-${Math.max(1, Math.min(2000, lines))}`],
    signal, 60_000,
  )
  return stdout.trimEnd()
}

/** tmux session names: alnum, dash, underscore, dot only. */
function validateSession(session: string): string {
  const trimmed = session.trim()
  if (!/^[A-Za-z0-9_.-]{1,40}$/u.test(trimmed)) {
    throw new PodmanSbError(`session name "${session}" must be simple alnum/dash/dot/dot/underscore`)
  }
  return trimmed
}
