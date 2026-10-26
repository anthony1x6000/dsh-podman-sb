// ponytail: the smallest check that fails if the naming, TTL, safety, or
// packaging rules break. Run: `node --experimental-strip-types selfcheck.ts`.
import assert from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
  labelNumber,
  name,
  normalizePsName,
  ownsRow,
  parseContainerSpec,
  pruneLedger,
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
// safeMount is realpath-based: fixtures must exist on disk (audit run-1).
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
const home = homedir() // realpath-backed safeMount needs a real root
const cwd = process.cwd()
const fixture = mkdtempSync(join(import.meta.dirname, '.selfcheck-tmp-'))
mkdirSync(join(fixture, 'data'))
  symlinkSync('/etc', join(fixture, 'etc-link'))
  symlinkSync(join(fixture, 'missing'), join(fixture, 'dangling'))
  assert.strictEqual(safeMount(join(fixture, 'data'), home, fixture), join(fixture, 'data'))
  assert.strictEqual(safeMount(join(fixture, 'etc-link'), home, fixture), null, 'symlink escaping the roots is rejected')
  assert.strictEqual(safeMount(join(fixture, 'dangling'), home, fixture), null, 'dangling symlink is rejected')
  assert.strictEqual(safeMount(join(fixture, 'etc-link/passwd'), home, fixture), null)
assert.strictEqual(safeMount('/etc/passwd', home, fixture), null)
assert.strictEqual(safeMount('/var/run/docker.sock', home, fixture), null)
assert.strictEqual(safeMount('/home/other/secret', home, fixture), null)
assert.strictEqual(safeMount(home, home, fixture), null, 'the home root itself is not mountable')
assert.strictEqual(safeMount(join(home, '.ssh'), home, fixture), null, 'credential subtrees are denied')
assert.strictEqual(safeMount(join(home, '.config/gh/hosts.yml'), home, fixture), null)
assert.strictEqual(safeMount(join(home, '.gnupg'), home, fixture), null)
assert.strictEqual(safeMount('/srv/data', home, '/srv'), null, 'cwd root outside $HOME is not allowed')

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
  mounts: [`${join(fixture, 'data')}:/data`],
  ports: [portSpec(5901, 5901)],
}, home, cwd)
assert.ok(base.includes('--name'), 'run args name the container')
assert.ok(base.includes(`--label=${LABEL_MANAGED}=1`), 'run args mark ownership')
assert.ok(base.includes('--cpus=2') && base.includes('--memory=2048m'))
assert.ok(base.includes('--env=FOO=bar'))
assert.ok(base.includes(`--volume=${join(fixture, 'data')}:/data`))
assert.ok(base.includes('--publish=127.0.0.1:5901:5901'))
assert.ok(!base.includes('--privileged'), 'never privileged')
assert.ok(!base.some((a) => a.includes('docker.sock')), 'never the host docker socket')



// mount specs: container side is a plain absolute path; only ':ro' may follow
assert.throws(() => buildRunArgs({ container: 'dsh-sb-box', image: CATALOG.alpine.image, expiresAt: now + 30 * 60_000, createdAt: now, desktop: false, mounts: [`${join(fixture, 'data')}:/data:U`] }, home, cwd))
assert.throws(() => buildRunArgs({ container: 'dsh-sb-box', image: CATALOG.alpine.image, expiresAt: now + 30 * 60_000, createdAt: now, desktop: false, mounts: [`${join(fixture, 'data')}:relative`] }, home, cwd))
const roMount = buildRunArgs({ container: 'dsh-sb-box', image: CATALOG.alpine.image, expiresAt: now + 30 * 60_000, createdAt: now, desktop: false, mounts: [`${join(fixture, 'data')}:/data:ro`] }, home, cwd)
assert.ok(roMount.includes(`--volume=${join(fixture, 'data')}:/data:ro`))

// image refs: never flag-shaped
assert.throws(() => resolveImage('-secret/x:y'))
assert.throws(() => resolveImage('--volume=/etc:/etc'))
assert.ok(resolveImage('ghcr.io/a/b:c1').length > 0)
// the image operand is guarded by '--' in the run argv
const guarded = buildRunArgs({ container: 'dsh-sb-box', image: CATALOG.alpine.image, expiresAt: now + 30 * 60_000, createdAt: now, desktop: false }, home, cwd)
assert.strictEqual(guarded[guarded.indexOf('--') + 1], CATALOG.alpine.image)

// cp specs: the embedded container name is normalized and must match
assert.deepStrictEqual(parseContainerSpec('box:/tmp/x'), { name: 'dsh-sb-box', path: '/tmp/x' })
assert.deepStrictEqual(parseContainerSpec('dsh-sb-box:/tmp/x'), { name: 'dsh-sb-box', path: '/tmp/x' })
// foreign names are prefix-normalized: the rebuilt argv can only ever address the dsh-sb-* namespace
assert.deepStrictEqual(parseContainerSpec('prod-db:/etc/secrets'), { name: 'dsh-sb-prod-db', path: '/etc/secrets' })
assert.strictEqual(parseContainerSpec('box:relative'), null)
assert.strictEqual(parseContainerSpec('-box:/x'), null)
assert.strictEqual(parseContainerSpec('box:'), null)


// ── security: TTL enforcement and ownership (audit run-1) ───────────────────
// podman ps Names shape: podman >=4 emits an array, docker-style emits a string
assert.strictEqual(normalizePsName('dsh-sb-box'), 'dsh-sb-box')
assert.strictEqual(normalizePsName(['dsh-sb-box', 'other']), 'dsh-sb-box')
assert.strictEqual(normalizePsName([]), undefined)
assert.strictEqual(normalizePsName(undefined), undefined)
assert.strictEqual(normalizePsName({ weird: true }), undefined)
// label numbers are finite or fall back to 0 (NaN can no longer sneak past guards)
assert.strictEqual(labelNumber('12345'), 12345)
assert.strictEqual(labelNumber('junk'), 0)
assert.strictEqual(labelNumber(undefined), 0)
// ownership requires the plugin token; forged labels alone are not enough
assert.strictEqual(ownsRow({ 'dsh-podman-sb.managed': '1', 'dsh-podman-sb.token': 'tok' }, 'tok'), true)
assert.strictEqual(ownsRow({ 'dsh-podman-sb.managed': '1', 'dsh-podman-sb.token': 'tok' }, 'other'), false)
assert.strictEqual(ownsRow({ 'dsh-podman-sb.managed': '1' }, 'tok'), false)
assert.strictEqual(ownsRow({}, 'tok'), false)
// ledger GC: entries past creation + cap + grace go, live ones stay
const gcNow = 10_000_000_000_000
const kept = pruneLedger({ containers: {
  live: { createdAt: gcNow - 60_000, expiresAt: gcNow + 60_000 },
  stale: { createdAt: gcNow - MAX_TTL_MINUTES * 60_000 - 7_200_000, expiresAt: gcNow - 60_000 },
} }, gcNow)
assert.deepStrictEqual(Object.keys(kept.containers).sort(), ['live'])
// timer units carry a name hash: deterministic, injective, collision-free
assert.strictEqual(timerUnitBase('dsh-sb-box'), timerUnitBase('dsh-sb-box'))
assert.notStrictEqual(timerUnitBase('dsh-sb-box'), timerUnitBase('dsh-sb-box2'))
assert.ok(/^dsh-sb-kill-[A-Za-z0-9_.:-]+-[0-9a-f]{8}$/.test(timerUnitBase('dsh-sb-box')), timerUnitBase('dsh-sb-box'))

// ── systemd kill-timer unit names stay valid ────────────────────────────────
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


// ── security: resource caps and output bounds (audit run-1) ─────────────────
import { clampResources, truncateIo } from './index.ts'
assert.deepStrictEqual(clampResources({}, 8, 16 * 1024 ** 3), { cpus: 2, memoryMb: 2048 })
assert.deepStrictEqual(clampResources({ cpus: 64, memoryMb: 999999 }, 4, 4 * 1024 ** 3), { cpus: 4, memoryMb: 2048 })
assert.deepStrictEqual(clampResources({ cpus: 1, memoryMb: 1024 }, 8, 64 * 1024 ** 3), { cpus: 1, memoryMb: 1024 })
const small = 'abc'
assert.strictEqual(truncateIo(small), small)
const huge = 'x'.repeat(20_000)
const cut = truncateIo(huge)
assert.ok(cut.length < 6_000 && cut.includes('…truncated'), 'oversized output is head/tail cut with a marker')
assert.ok(cut.startsWith('x'.repeat(4096).slice(0, 100)))

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
  assert.ok(!/[~^]/u.test(manifest.dependencies[dep]), `dependency ${dep} must be exact-pinned (no drift for git installs)`)
  assert.ok((manifest.peerDependencies ?? {})[dep], `peer declaration ${dep} engages the dsh compatibility gate`)
}

// ── the committed build artifact is what profiles load ──────────────────────
const built = await import('./lib/index.js') as typeof import('./index.ts')
assert.strictEqual(built.name, name, 'built artifact must export the plugin name')
assert.strictEqual(typeof built.apply, 'function', 'built artifact must export apply')
assert.strictEqual(built.humanBytes(2048), '2.0 KiB')
assert.strictEqual(built.timerUnitBase('dsh-sb-box'), timerUnitBase('dsh-sb-box'))
assert.strictEqual(built.normalizePsName(['dsh-sb-box']), 'dsh-sb-box')
assert.strictEqual(built.resolveImage('alpine'), CATALOG.alpine.image)
rmSync(fixture, { recursive: true, force: true })
console.log('podman-sb selfcheck: ok')
