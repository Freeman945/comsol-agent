import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from './process.js'
import { detectComsolHomes } from './config.js'
import { testWritableDir } from './paths.js'
import { PLUGIN_VERSION } from './config.js'

function fileInfo(target) {
  try {
    const stat = fs.statSync(target)
    return { path: target, exists: true, isFile: stat.isFile(), sizeBytes: stat.size }
  } catch {
    return { path: target, exists: false }
  }
}

function exists(target) {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

export async function batchVersion(comsolHome) {
  if (!comsolHome) return { ok: false, error: 'COMSOL home is not resolved' }
  const exe = path.join(comsolHome, 'bin', 'win64', 'comsolbatch.exe')
  if (!exists(exe)) return { ok: false, error: `comsolbatch.exe not found: ${exe}` }
  const result = await runProcess(exe, ['-version'], { timeoutMs: 45_000 })
  const text = `${result.stdout}\n${result.stderr}`.trim()
  const match = text.match(/COMSOL Multiphysics\s+([\d.]+)/i)
  return {
    ok: result.code === 0 && Boolean(match),
    version: match ? match[1] : null,
    output: text.slice(0, 2000),
    exitCode: result.code,
    timedOut: result.timedOut,
  }
}

export async function findOnPath(executable) {
  const result = await runProcess('where.exe', [executable], { timeoutMs: 10_000 })
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function detectMatlab() {
  const paths = []
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!root) continue
    const matlabRoot = path.join(root, 'MATLAB')
    if (!exists(matlabRoot)) continue
    try {
      for (const entry of fs.readdirSync(matlabRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const exe = path.join(matlabRoot, entry.name, 'bin', 'matlab.exe')
        if (exists(exe)) paths.push(exe)
      }
    } catch {
      // ignore unreadable directories
    }
  }
  return paths
}

function readLicenseHints(comsolHome) {
  const licenseFile = path.join(comsolHome, 'license', 'license.dat')
  const infoFile = path.join(comsolHome, 'licenseinfo.ini')
  const envVars = ['LMCOMSOL_LICENSE_FILE', 'COMSOL_LICENSE_FILE', 'LM_LICENSE_FILE']
    .filter((name) => Boolean(process.env[name]))
    .map((name) => ({ name, present: true }))
  const hints = {
    envVars,
    licenseFile: { path: licenseFile, exists: exists(licenseFile) },
    licenseInfoFile: { path: infoFile, exists: exists(infoFile) },
    licenseNumberPresent: false,
    companyFieldEmpty: null,
    status: 'unknown',
    evidence: [],
  }
  if (exists(infoFile)) {
    try {
      const text = fs.readFileSync(infoFile, 'utf8')
      const licenseMatch = text.match(/^LicenseNumber=(.*)$/m)
      const companyMatch = text.match(/^Company=(.*)$/m)
      hints.licenseNumberPresent = Boolean(licenseMatch && licenseMatch[1].trim())
      hints.companyFieldEmpty = companyMatch ? companyMatch[1].trim() === '' : null
      hints.evidence.push('licenseinfo.ini exists and was parsed')
    } catch (error) {
      hints.evidence.push(`licenseinfo.ini could not be parsed: ${String(error?.message ?? error)}`)
    }
  }
  if (envVars.length > 0) hints.evidence.push('license-related environment variables are set')
  if (exists(licenseFile)) hints.evidence.push('a license.dat file exists')
  hints.status = hints.evidence.length > 0 ? 'configured-but-unverified' : 'unknown'
  return hints
}

function detectLiveLink(comsolHome) {
  const mliDir = path.join(comsolHome, 'mli')
  const pluginsDir = path.join(comsolHome, 'plugins')
  let mliJar = null
  try {
    mliJar = fs.readdirSync(pluginsDir).find((name) => /^com\.comsol\.mli_.*\.jar$/i.test(name)) ?? null
  } catch {
    // ignore
  }
  return {
    matlabInterfaceDirectory: fileInfo(mliDir),
    matlabInterfaceJar: mliJar ? fileInfo(path.join(pluginsDir, mliJar)) : null,
    status: exists(mliDir) ? 'installed-unverified' : 'not-found',
  }
}

/**
 * Structured environment report. Every field states whether it was observed
 * from the filesystem, from a process probe, or is simply unknown.
 */
export async function checkEnvironment({ config, driver, deep = false, logger }) {
  const warnings = []
  const unknowns = []
  const detection = config.comsolHome
    ? { home: config.comsolHome, candidates: config.comsolCandidates ?? [] }
    : detectComsolHomes()
  const comsolHome = detection.home

  const platform = {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    hostname: os.hostname(),
    node: process.version,
    pluginVersion: PLUGIN_VERSION,
    workspaceRoot: config.workspaceRoot,
    workspaceWritable: testWritableDir(config.workspaceRoot),
  }

  const comsol = {
    found: Boolean(comsolHome),
    home: comsolHome,
    candidates: detection.candidates,
    executables: {},
    java: {},
    license: null,
    version: null,
    versionSource: null,
  }

  if (comsolHome) {
    const bin = path.join(comsolHome, 'bin', 'win64')
    for (const [key, name] of [
      ['desktop', 'comsol.exe'],
      ['batch', 'comsolbatch.exe'],
      ['compiler', 'comsolcompile.exe'],
      ['server', 'comsolmphserver.exe'],
    ]) {
      comsol.executables[key] = fileInfo(path.join(bin, name))
    }
    const javaHome = path.join(comsolHome, 'java', 'win64', 'jre')
    comsol.java = {
      home: javaHome,
      java: fileInfo(path.join(javaHome, 'bin', 'java.exe')),
      javac: fileInfo(path.join(javaHome, 'bin', 'javac.exe')),
      release: null,
    }
    try {
      comsol.java.release = fs.readFileSync(path.join(javaHome, 'release'), 'utf8').split(/\r?\n/)[0] ?? null
    } catch {
      // ignore
    }
    const plugins = path.join(comsolHome, 'plugins')
    comsol.pluginsDirectory = fileInfo(plugins)
    const apiJar = fs.existsSync(plugins)
      ? fs.readdirSync(plugins).find((name) => /^com\.comsol\.api_.*\.jar$/i.test(name)) ?? null
      : null
    comsol.apiJar = apiJar ? fileInfo(path.join(plugins, apiJar)) : null
    comsol.license = readLicenseHints(comsolHome)

    const version = await batchVersion(comsolHome)
    comsol.version = version.version
    comsol.versionSource = version.ok ? 'comsolbatch -version' : 'unavailable'
    comsol.versionProbe = version
    if (!version.ok) {
      warnings.push('comsolbatch -version did not return a parseable version; check the installation.')
    }
    if (!comsol.executables.batch.exists) {
      warnings.push('comsolbatch.exe is missing; batch-mode execution is unavailable.')
    }
    if (!comsol.java.java.exists || !comsol.java.javac.exists) {
      warnings.push('COMSOL bundled Java runtime/compiler is missing; the Java API bridge cannot run.')
    }
    if (!comsol.apiJar) {
      warnings.push('The COMSOL API jar was not found in the plugins directory.')
    }
  } else {
    warnings.push(
      'No COMSOL installation was detected. Set config.comsolHome (for example D:\\COMSOL62\\Multiphysics) or the COMSOL_HOME environment variable.',
    )
    unknowns.push('COMSOL installation path, version, license and available modules are unknown.')
  }

  const matlabPaths = detectMatlab()
  const matlabOnPath = await findOnPath('matlab.exe')
  const matlab = {
    found: matlabPaths.length > 0 || matlabOnPath.length > 0,
    candidateExecutables: [...new Set([...matlabPaths, ...matlabOnPath])],
    note: 'Presence does not prove a MATLAB license or a licensed LiveLink for MATLAB connection.',
  }
  const livelink = comsolHome ? detectLiveLink(comsolHome) : { status: 'unknown' }
  if (!matlab.found) unknowns.push('MATLAB was not found; LiveLink for MATLAB is not asserted to be available.')
  unknowns.push(
    'COMSOL license availability and licensed module coverage are not proven by file checks. Use deep=true for a real license checkout probe.',
  )

  let deepProbe = null
  if (deep && driver) {
    if (!comsolHome) {
      deepProbe = { attempted: false, error: 'COMSOL home is not resolved' }
    } else {
      try {
        deepProbe = await driver.probe({ timeoutMs: 180_000, jobKind: 'environment-probe' })
      } catch (error) {
        deepProbe = { attempted: true, ok: false, error: String(error?.message ?? error) }
      }
    }
  }

  if (deepProbe?.result?.licenseCheckout === 'ok') {
    const note = 'COMSOL license availability and licensed module coverage are not proven by file checks. Use deep=true for a real license checkout probe.'
    const index = unknowns.indexOf(note)
    if (index >= 0) unknowns.splice(index, 1)
    comsol.license.status = 'checkout-verified-in-probe'
    comsol.license.evidence.push('a real COMSOL Java API model creation and 3D geometry build succeeded in the deep probe')
  }

  return {
    ok: Boolean(comsolHome),
    checkedAt: new Date().toISOString(),
    platform,
    comsol,
    matlab,
    livelink,
    deepProbe,
    warnings,
    unknowns,
    interpretation: {
      installation: comsolHome ? 'detected from filesystem and version probe' : 'not detected',
      license: deepProbe?.result?.licenseCheckout === 'ok'
        ? 'a real COMSOL Java API license checkout succeeded during this check'
        : 'unknown or unverified; no license claim is made',
      modules: 'not enumerated; module availability follows the local license and is only proven by actually building the physics interface',
    },
  }
}
