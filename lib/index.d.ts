import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "podman-sb";
/** The tool registry every `podman_*` tool registers into, plus the prompt seam. */
export declare const inject: string[];
/** Every container this plugin manages carries this name prefix. */
export declare const PREFIX = "dsh-sb-";
/** Label namespace stamped on managed containers. */
export declare const LABEL_MANAGED = "dsh-podman-sb.managed";
/** Default container lifetime when the agent sets none. */
export declare const DEFAULT_TTL_MINUTES = 30;
/** Hard lifetime cap from creation, no matter how often the agent extends. */
export declare const MAX_TTL_MINUTES: number;
/** First host port tried for a desktop container's VNC publish. */
export declare const VNC_PORT_BASE = 5901;
/** First host port tried for a desktop container's noVNC publish. */
export declare const NOVNC_PORT_BASE = 6081;
/** Go-to image catalog. Aliases resolve on create; any full ref also works. */
export interface CatalogEntry {
    /** Fully qualified image reference pulled on demand. */
    image: string;
    /** One-line pitch the guide shows. */
    tagline: string;
    /** True when the entry is a sane desktop base (KDE, flatpak). */
    desktop: boolean;
    /** Warmed at plugin boot when `warmPull` is on. */
    warm: boolean;
}
export declare const CATALOG: Record<string, CatalogEntry>;
/** Plugin config, every field optional (patch-row `config:` values). */
export interface Config {
    /** Container CLI binary. Default `podman`. */
    containerCLI?: string;
    /** Default TTL minutes for new containers. Default 30. */
    defaultTtlMinutes?: number;
    /** Warm-pull the two default catalog images at boot. Default true. */
    warmPull?: boolean;
    /** State dir holding the TTL ledger. Default `~/.local/share/dsh-podman-sb`. */
    dataDir?: string;
}
/** Resolved options the runtime helpers use. */
export interface Options {
    containerCLI: string;
    defaultTtlMinutes: number;
    warmPull: boolean;
    dataDir: string;
}
/** Project config onto fully-defaulted options. */
export declare function resolveConfig(config?: Config): Options;
/** Plugin failure with a machine-routable code. */
export declare class PodmanSbError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
/**
 * Resolve an image argument: catalog alias or full reference.
 * @param ref - alias like `alpine`, or `ghcr.io/owner/img:tag`.
 * @returns the fully qualified image reference.
 * @throws PodmanSbError on junk input (empty, spaces, bare word).
 */
export declare function resolveImage(ref: string): string;
/**
 * Full container name from an agent-supplied name, or a random one.
 * @param container - optional bare name; prefixed by the plugin.
 * @returns `dsh-sb-<name>`, unique-ish auto name when omitted.
 * @throws PodmanSbError on unsafe names.
 */
export declare function containerName(container?: string): string;
/**
 * Normalize an agent-supplied container argument to a full managed name.
 * Accepts `box` and `dsh-sb-box`; rejects anything outside the plugin prefix.
 * @param container - agent-supplied name.
 * @returns the full `dsh-sb-*` name.
 * @throws PodmanSbError when the name is invalid or foreign.
 */
export declare function normalizeContainer(container: string): string;
/**
 * Clamp a TTL: junk or missing becomes the default, the cap holds at 24h,
 * and an extension never pushes total life past creation + 24h.
 * @param now - decision time (epoch ms).
 * @param ttlMinutes - requested lifetime.
 * @param createdAtMs - creation time when extending an existing container.
 * @returns the clamped `{ expiresAt, ttlMinutes }`.
 */
export declare function clampExpiry(now: number, ttlMinutes: number, createdAtMs?: number): {
    expiresAt: number;
    ttlMinutes: number;
};
/** Milliseconds left on a TTL, floored at zero. */
export declare function remainingMs(expiresAt: number, now: number): number;
/**
 * Compact remaining-life text (`29m`, `23h10m`).
 * @param ms - remaining milliseconds.
 * @returns floor-rounded text.
 */
export declare function ttlText(ms: number): string;
/**
 * Systemd unit base for one container's kill timer. `systemd-run --unit`
 * appends `.timer`/`.service`; characters outside systemd's safe set become `-`.
 * @param container - full container name.
 * @returns unit base like `dsh-sb-kill-dsh-sb-box`.
 */
export declare function timerUnitBase(container: string): string;
export declare function safeMount(hostPath: string, home: string, cwd: string): string | null;
/**
 * Loopback-only publish spec: desktop containers never expose a LAN port.
 * @param hostPort - host port.
 * @param containerPort - container port.
 * @returns `127.0.0.1:HOST:CTR`.
 */
export declare function portSpec(hostPort: number, containerPort: number): string;
/**
 * Normalize an agent-supplied publish spec to a loopback-only one.
 * `2222:22` and `0.0.0.0:2222:22` both become `127.0.0.1:2222:22`.
 * @param spec - 2- or 3-part publish spec.
 * @param fallbackHostPort - host port for a bare `22`-style container-only spec.
 * @returns the loopback publish spec, or null when unparseable.
 */
export declare function normalizePublish(spec: string, fallbackHostPort: number): string | null;
/**
 * Parse and confine a CONTAINER:/path spec (podman_cp). The embedded name runs
 * through the same prefix rule as every other tool; foreign containers are
 * rejected (audit run-1).
 * @param spec - `box:/tmp/x` or `dsh-sb-box:/tmp/x`.
 * @returns the normalized `{ name, path }`, or null when the spec is foreign
 * or malformed.
 */
export declare function parseContainerSpec(spec: string): {
    name: string;
    path: string;
} | null;
/** Run arguments the plugin may set — the full, validated shape. */
export interface RunSpec {
    container: string;
    image: string;
    expiresAt: number;
    createdAt: number;
    desktop: boolean;
    cpus?: number;
    memoryMb?: number;
    env?: Record<string, string>;
    mounts?: string[];
    ports?: string[];
    vncHostPort?: number;
    novncHostPort?: number;
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
export declare function buildRunArgs(spec: RunSpec, home?: string, cwd?: string): string[];
/** Host memory facts parsed from `/proc/meminfo` (kB lines to bytes). */
export interface Meminfo {
    readonly [key: string]: JsonValue;
    memTotalBytes: number;
    memAvailableBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
}
/**
 * Parse the `/proc/meminfo` fields this plugin reports.
 * @param text - the file's contents.
 * @returns bytes for total/available memory and swap.
 */
export declare function parseMeminfo(text: string): Meminfo;
/**
 * Human-readable byte count (`3.0 GiB`).
 * @param bytes - the count.
 * @returns one-decimal KiB/MiB/GiB/TiB text.
 */
export declare function humanBytes(bytes: number): string;
/** One recipe index row. */
export interface RecipeRef {
    /** Recipe id, the `podman_guide` argument. */
    id: string;
    /** First `#` heading of the file. */
    title: string;
}
/**
 * List shipped recipes for the guide index.
 * @returns sorted `{ id, title }` rows.
 */
export declare function recipeIndex(): RecipeRef[];
/**
 * Load one recipe's full markdown.
 * @param id - recipe id (`kde-plasma`).
 * @returns the text, or undefined when unknown.
 */
export declare function loadRecipe(id: string): string | undefined;
/** Guide index text: rules, catalog table, recipe list. */
export declare function guideText(defaultTtlMinutes: number): string;
/** Host snapshot every create call embeds. */
export interface HostSnapshot {
    readonly [key: string]: JsonValue;
    cpus: number;
    load1: number;
    load5: number;
    load15: number;
    mem: Meminfo;
    diskFreeBytes: number;
    diskTotalBytes: number;
    diskPath: string;
    text: string;
}
/**
 * Register the podman sandbox tools and the prompt section.
 * @param ctx - plugin context with `ctx.tools` and `ctx.systemPrompt`.
 * @param config - optional defaults from the patch row.
 */
export declare function apply(ctx: Context, config?: Config): void;
