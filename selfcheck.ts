// ponytail: the smallest check that fails if the naming, TTL, safety, or
// packaging rules break. Run: `node --experimental-strip-types selfcheck.ts`.
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATALOG,
  DEFAULT_TTL_MINUTES,
  LABEL_MANAGED,
  MAX_TTL_MINUTES,
  PREFIX,
  buildRunArgs,
  clampExpiry,
  containerName,
  humanBytes,
  inject,
  loadRecipe,
  name,
  parseMeminfo,
  portSpec,
  recipeIndex,
  remainingMs,
  resolveImage,
  safeMount,
  timerUnitBase,
  ttlText,
} from './index.ts'

// ── plugin identity ─────────────────────────────────────────────────────────
assert.strictEqual(name, 'podman-sb')
assert.deepStrictEqual(inject, ['tools', 'systemPrompt'])

// ── catalog: defaults and full refs ─────────────────────────────────────────
assert.ok(CATALOG.alpine.image.startsWith('docker.io/library/alpine'), 'alpine is the cli default')
assert.strictEqual(CATALOG.debian.image, 'docker.io/library/debian:bookworm-slim')
assert.ok(CATALOG.debian.desktop, 'debian is the desktop default')
assert.ok(!CATALOG.alpine.desktop, 'alpine is not a desktop base')
for (const entry of Object.values(CATALOG)) {
  assert.ok(entry.image.includes('/'), `catalog image must be fully qualified: ${entry.image}`)
  assert.ok(entry.tagline.length > 0, `catalog entry needs a tagline: ${entry.image}`)
}
assert.ok(Object.keys(CATALOG).length >= 5, 'catalog keeps a go-to list')

// any registry passes through, catalog aliases resolve, junk fails
assert.strictEqual(resolveImage('alpine'), CATALOG.alpine.image)
assert.strictEqual(resolveImage('ghcr.io/foo/bar:1.2'), 'ghcr.io/foo/bar:1.2')
assert.throws(() => resolveImage('not a thing!'))
assert.throws(() => resolveImage(''))

// ── naming: every managed container carries the prefix ─────────────────────
assert.ok(containerName('box').startsWith(PREFIX))
assert.throws(() => containerName('Bad Name!'))
assert.throws(() => containerName('../escape'))
assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(containerName('box').slice(PREFIX.length)))
const autoA = containerName(), autoB = containerName()
assert.notStrictEqual(autoA, autoB, 'auto names are unique')
assert.ok(autoA.length <= 63, 'container names stay under podman/systemd limits')

// ── TTL: default 30m, hard cap 24h from creation ────────────────────────────
assert.strictEqual(DEFAULT_TTL_MINUTES, 30)
assert.strictEqual(MAX_TTL_MINUTES, 1440)
const now = 1_000_000_000_000
assert.strictEqual(clampExpiry(now, DEFAULT_TTL_MINUTES).ttlMinutes, 30)
assert.strictEqual(clampExpiry(now, 0).ttlMinutes, 30, 'missing TTL becomes the default')
assert.strictEqual(clampExpiry(now, -5).ttlMinutes, 30)
assert.strictEqual(clampExpiry(now, 99999).ttlMinutes, MAX_TTL_MINUTES, 'TTL caps at 24h')
// extend: total life from creation never exceeds the cap
const created = now - 23 * 60 * 60 * 1000
assert.strictEqual(
  clampExpiry(now, 120, created).expiresAt,
  created + MAX_TTL_MINUTES * 60_000,
  'extend clamps to creation+24h',
)
assert.strictEqual(clampExpiry(now, 30, created).expiresAt, now + 30 * 60_000)

assert.strictEqual(remainingMs(now + 60_000, now), 60_000)
assert.strictEqual(ttlText(90_000), '1m')
assert.ok(ttlText(23 * 60 * 60 * 1000).includes('23h'))

// ── rootless-safe rules ─────────────────────────────────────────────────────
const home = '/home/virt', cwd = '/home/virt/Projects/dsh-podman-sb'
assert.strictEqual(safeMount('/home/virt/data', home, cwd), '/home/virt/data')
assert.strictEqual(safeMount(`${cwd}/tmp`, home, cwd), `${cwd}/tmp`)
assert.strictEqual(safeMount('/etc/passwd', home, cwd), null)
assert.strictEqual(safeMount('/var/run/docker.sock', home, cwd), null)
assert.strictEqual(safeMount('/home/other/secret', home, cwd), null)

assert.strictEqual(portSpec(5901, 5901), '127.0.0.1:5901:5901')

// buildRunArgs: labels, limits, mounts, ports — and never privilege
const base = buildRunArgs({
  container: 'dsh-sb-box',
  image: CATALOG.alpine.image,
  expiresAt: now + 30 * 60_000,
  createdAt: now,
  desktop: false,
  cpus: 2,
  memoryMb: 2048,
  env: { FOO: 'bar' },
  mounts: ['/home/virt/data:/data'],
  ports: [portSpec(5901, 5901)],
}, home, cwd)
assert.ok(base.includes('--name'), 'run args name the container')
assert.ok(base.includes(`--label=${LABEL_MANAGED}=1`), 'run args mark ownership')
assert.ok(base.includes('--cpus=2') && base.includes('--memory=2048m'))
assert.ok(base.includes('--env=FOO=bar'))
assert.ok(base.includes('--volume=/home/virt/data:/data'))
assert.ok(base.includes('--publish=127.0.0.1:5901:5901'))
assert.ok(!base.includes('--privileged'), 'never privileged')
assert.ok(!base.some((a) => a.includes('docker.sock')), 'never the host docker socket')

// ── systemd kill-timer unit names stay valid ────────────────────────────────
assert.strictEqual(timerUnitBase('dsh-sb-box'), 'dsh-sb-kill-dsh-sb-box')
for (const container of ['dsh-sb-box', 'dsh-sb-a b', 'dsh-sb-x'.repeat(80), 'dsh-sb-ümlaut']) {
  assert(
    /^dsh-sb-kill-[A-Za-z0-9_.:-]+$/u.test(timerUnitBase(container)),
    `timer unit must stay valid for ${JSON.stringify(container)}`,
  )
}

// ── host snapshot math ──────────────────────────────────────────────────────
const mem = parseMeminfo([
  'MemTotal:       8000000 kB',
  'MemFree:         100000 kB',
  'MemAvailable:  4000000 kB',
  'SwapTotal:      2000000 kB',
  'SwapFree:       1500000 kB',
].join('\n'))
assert.strictEqual(mem.memTotalBytes, 8000000 * 1024)
assert.strictEqual(mem.memAvailableBytes, 4000000 * 1024)
assert.strictEqual(mem.swapTotalBytes, 2000000 * 1024)
assert.strictEqual(mem.swapFreeBytes, 1500000 * 1024)
assert.strictEqual(humanBytes(1024), '1.0 KiB')
assert.strictEqual(humanBytes(3 * 1024 ** 3), '3.0 GiB')

// ── recipes: shipped, listed, caveman, and safe ─────────────────────────────
const mandated = ['kde-plasma', 'node-pnpm', 'flatpak-flathub', 'dev-basics', 'python-uv', 'rust', 'go', 'browsers', 'sshd', 'tmux-sessions']
const index = recipeIndex()
for (const recipe of mandated) {
  const text = loadRecipe(recipe)
  assert.ok(typeof text === 'string' && text.length > 200, `recipe ${recipe} must exist`)
  assert.ok(index.some((r) => r.id === recipe), `recipe ${recipe} must appear in the index`)
  assert.ok(text.includes('# '), `recipe ${recipe} needs section headers`)
  assert.ok(text.includes('```'), `recipe ${recipe} needs command blocks`)
  assert.ok(!text.includes('--privileged') && !text.includes('docker.sock'), `recipe ${recipe} stays rootless-safe`)
}
const recipeDir = join(import.meta.dirname, 'recipes')
for (const file of readdirSync(recipeDir)) {
  assert.ok(file.endsWith('.md'), `recipes dir holds only markdown: ${file}`)
  assert.ok(index.some((r) => r.id === file.replace(/\.md$/u, '')), `recipe file ${file} is indexed`)
}
assert.ok(typeof loadRecipe('nope') === 'undefined')

// ── packaging: what `dsh plugin add` mounts ─────────────────────────────────
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as {
  name: string
  files: string[]
  dependencies: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
assert.strictEqual(manifest.name, 'dsh-podman-sb', 'package name is the module row reference')
const patchRel = manifest.dsh?.bundle?.patch
assert(typeof patchRel === 'string' && patchRel.length > 0, 'package.json must declare dsh.bundle.patch')
const patch = readFileSync(join(import.meta.dirname, patchRel), 'utf8')
for (const shipped of [patchRel.replace(/^\.\//u, ''), 'lib/index.js', 'recipes', 'README.md', 'LICENSE']) {
  assert((manifest.files as string[]).includes(shipped), `files must ship ${shipped}`)
}
assert(patch.includes(`name: '${manifest.name}'`), 'bundle layer must reference the module by package name')
assert(!patch.includes('./index.ts'), 'bundle layer must not reference source paths')
for (const dep of ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis', '@deepseek-ai/dsh-util-values']) {
  assert.ok(manifest.dependencies[dep], `runtime import ${dep} must be a dependency`)
}

// ── the committed build artifact is what profiles load ──────────────────────
const built = await import('./lib/index.js') as typeof import('./index.ts')
assert.strictEqual(built.name, name, 'built artifact must export the plugin name')
assert.strictEqual(typeof built.apply, 'function', 'built artifact must export apply')
assert.strictEqual(built.timerUnitBase('dsh-sb-box'), 'dsh-sb-kill-dsh-sb-box')
assert.strictEqual(built.humanBytes(2048), '2.0 KiB')
assert.strictEqual(built.resolveImage('alpine'), CATALOG.alpine.image)
console.log('podman-sb selfcheck: ok')
