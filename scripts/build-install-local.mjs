#!/usr/bin/env node
/** Build the current checkout, pack it, and install it into the dsh-tui profile. */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const isWindows = process.platform === 'win32'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDshStd = join(repoRoot, 'vendor', 'dsh-std')

function usage() {
  console.log([
    'Usage: pnpm build:install [-- --profile <name>]',
    '',
    'Builds this checkout, creates the release tarball, and installs it with:',
    '  dsh plugin --profile <name> add <local-tarball>',
    '',
    'Default profile: dsh-tui',
  ].join('\n'))
}

function commandText(command, args) {
  return [command, ...args].join(' ')
}

function run(command, args, options = {}) {
  console.log(`$ ${commandText(command, args)}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${commandText(command, args)} exited with ${String(result.status)}`)
  }
}

function output(command, args, options = {}) {
  console.log(`$ ${commandText(command, args)}`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    ...options,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${commandText(command, args)} exited with ${String(result.status)}`)
  }
  return result.stdout
}

function requireCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', shell: isWindows })
  if (result.error || result.status !== 0) throw new Error(`required command not found: ${command}`)
}

/**
 * pnpm resolves the profile's existing file: dependency before replacing it.
 * If an older build tarball was cleaned up, provide a temporary copy so the
 * atomic add can proceed and rewrite package.json/lockfile to the new tarball.
 */
function profileDirectory(profile) {
  const dshHome = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
  return join(dshHome, 'profiles', profile)
}

function ensureReleaseAgeExclusions(profile) {
  const workspacePath = join(profileDirectory(profile), 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) return

  let text = readFileSync(workspacePath, 'utf8')
  const packages = ["'@deepseek-harness-tui/dsh-tui'", 'dsh-working-activity']
  text = text
    .replace(/^([ \t]*-[ \t]*)['"]?@deepseek-harness-tui\/dsh-tui(?:@[^'"\s]+)?['"]?[ \t]*$/gmu, `$1${packages[0]}`)
    .replace(/^([ \t]*-[ \t]*)dsh-working-activity(?:@[^\s]+)?[ \t]*$/gmu, `$1${packages[1]}`)

  if (!/^minimumReleaseAgeExclude:[ \t]*$/mu.test(text)) {
    text = `${text.trimEnd()}\nminimumReleaseAgeExclude:\n`
  }
  for (const packageName of packages) {
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    if (new RegExp(`^[ \\t]*-[ \\t]*${escaped}[ \\t]*$`, 'mu').test(text)) continue
    text = text.replace(
      /^minimumReleaseAgeExclude:[ \t]*$/mu,
      match => `${match}\n  - ${packageName}`,
    )
  }
  writeFileSync(workspacePath, text.endsWith('\n') ? text : `${text}\n`)
}

function provideMissingPreviousTarball(profile, replacementTarball) {
  const manifestPath = join(profileDirectory(profile), 'package.json')
  if (!existsSync(manifestPath)) return undefined

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const specifier = manifest.dependencies?.['@deepseek-harness-tui/dsh-tui']
  if (typeof specifier !== 'string' || !specifier.startsWith('file:')) return undefined

  const previousTarball = resolve(specifier.slice('file:'.length))
  if (existsSync(previousTarball) || previousTarball === replacementTarball) return undefined
  copyFileSync(replacementTarball, previousTarball)
  console.log(`build-install-local: temporarily restored missing dependency ${previousTarball}`)
  return previousTarball
}

function createPnpmShim() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-pnpm-shim-'))
  const shim = join(dir, 'pnpm-shim.mjs')
  writeFileSync(shim, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
let cwd = process.cwd()
let forwarded = args
if (args[0] === '--dir' && args[1] === 'vendor/dsh-std') {
  cwd = ${JSON.stringify(vendorDshStd)}
  forwarded = args.slice(2)
}
const result = spawnSync('corepack', ['pnpm', ...forwarded], {
  cwd,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 0)
`)
  chmodSync(shim, 0o700)

  const unixWrapper = join(dir, 'pnpm')
  writeFileSync(unixWrapper, `#!/usr/bin/env sh
exec node ${JSON.stringify(shim)} "$@"
`)
  chmodSync(unixWrapper, 0o700)

  const winWrapper = join(dir, 'pnpm.cmd')
  writeFileSync(winWrapper, `@echo off\r\nnode "${shim}" %*\r\n`)

  return {
    PATH: `${dir}${isWindows ? ';' : ':'}${process.env.PATH ?? ''}`,
  }
}

let args = process.argv.slice(2)
while (args[0] === '--') args = args.slice(1)
if (args[0] === '--help' || args[0] === '-h') {
  usage()
  process.exit(0)
}

let profile = 'dsh-tui'
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--profile') {
    const value = args[index + 1]
    if (!value) throw new Error('--profile requires a value')
    profile = value
    index += 1
  } else {
    throw new Error(`unknown argument: ${arg}`)
  }
}

try {
  requireCommand('node')
  requireCommand('corepack', ['--version'])
  requireCommand('pnpm')
  requireCommand('npm')
  requireCommand('dsh')

  const env = { ...process.env, ...createPnpmShim() }

  run('git', ['submodule', 'update', '--init', '--recursive'])
  run('pnpm', ['install', '--frozen-lockfile'], { env })
  run('npm', ['run', 'build'], { env })

  const packStdout = output('npm', ['pack', '--pack-destination', repoRoot], { env })
  const tarballName = packStdout
    .trim()
    .split(/\r?\n/u)
    .reverse()
    .find(line => line.endsWith('.tgz'))
  if (!tarballName) throw new Error('npm pack did not report a .tgz filename')
  const tarballPath = resolve(repoRoot, tarballName)
  ensureReleaseAgeExclusions(profile)
  const restoredTarball = provideMissingPreviousTarball(profile, tarballPath)
  try {
    run('dsh', ['plugin', '--profile', profile, 'add', tarballPath], { env })
  } finally {
    if (restoredTarball !== undefined && existsSync(restoredTarball)) unlinkSync(restoredTarball)
  }
  console.log(`build-install-local: installed ${tarballName} into profile ${profile}`)
} catch (error) {
  console.error(`build-install-local: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
