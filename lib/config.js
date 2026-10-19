import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir } from './paths.js'

export const PLUGIN_NAME = '@local/comsol-agent'
export const PLUGIN_VERSION = '1.0.0'

function isComsolHome(candidate) {
  if (!candidate) return false
  try {
    return (
      fs.existsSync(path.join(candidate, 'bin', 'win64', 'comsolbatch.exe')) &&
      fs.existsSync(path.join(candidate, 'plugins'))
    )
  } catch {
    return false
  }
}

function normalizeHome(candidate) {
  if (!candidate) return null
  const resolved = path.resolve(candidate)
  const options = [resolved]
  if (!/multiphysics$/i.test(resolved)) options.push(path.join(resolved, 'Multiphysics'))
  for (const option of options) {
    if (isComsolHome(option)) return option
  }
  return null
}

function versionScore(candidate) {
  const text = path.basename(candidate)
  const match = text.match(/(\d+)(?:[._ ](\d+))?/)
  if (!match) return 0
  return Number(match[1]) * 100 + Number(match[2] ?? 0)
}

function listDirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

// A path is accepted only when both the batch executable and plugins exist.
export function detectComsolHomes() {
  const candidates = []
  const add = (candidate) => {
    const home = normalizeHome(candidate)
    if (home && !candidates.includes(home)) candidates.push(home)
  }

  for (const envName of ['COMSOL_HOME', 'COMSOL_ROOT', 'COMSOL_AGENT_COMSOL_HOME']) {
    const value = process.env[envName]
    if (value) add(value)
  }

  const drives = []
  for (const letter of ['C', 'D', 'E', 'F', 'G']) {
    const root = `${letter}:\\`
    if (fs.existsSync(root)) drives.push(root)
  }

  for (const root of drives) {
    for (const dir of listDirectories(root)) {
      if (/^COMSOL/i.test(path.basename(dir))) {
        add(dir)
        for (const child of listDirectories(dir)) {
          if (/^COMSOL/i.test(path.basename(child)) || /^Multiphysics$/i.test(path.basename(child))) add(child)
        }
      }
    }
  }

  for (const programFiles of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!programFiles) continue
    for (const dir of listDirectories(programFiles)) {
      if (/^COMSOL/i.test(path.basename(dir))) {
        add(dir)
        for (const child of listDirectories(dir)) add(child)
      }
    }
  }

  candidates.sort((a, b) => versionScore(b) - versionScore(a))
  return { home: candidates[0] ?? null, candidates }
}

export function loadConfig(raw = {}) {
  const workspaceRoot = path.resolve(
    raw.workspaceRoot || process.env.COMSOL_AGENT_WORKSPACE || path.join(os.homedir(), 'comsol-agent-workspace'),
  )
  const detection = raw.comsolHome ? { home: normalizeHome(raw.comsolHome), candidates: [] } : detectComsolHomes()
  const comsolHome = detection.home

  const allowedRoots = [
    workspaceRoot,
    ...(Array.isArray(raw.allowedRoots) ? raw.allowedRoots : []),
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .map((value) => path.resolve(value))
  const uniqueRoots = [...new Set(allowedRoots)]

  const jobsDir = path.join(workspaceRoot, 'jobs')
  const config = {
    workspaceRoot,
    jobsDir,
    exportsDir: path.join(workspaceRoot, 'exports'),
    modelsDir: path.join(workspaceRoot, 'models'),
    runsDir: path.join(workspaceRoot, 'runs'),
    sweepsDir: path.join(workspaceRoot, 'sweeps'),
    driverDir: path.join(workspaceRoot, '.driver'),
    comsolHome,
    comsolCandidates: detection.candidates,
    allowedRoots: uniqueRoots,
    javaHeap: typeof raw.javaHeap === 'string' && raw.javaHeap ? raw.javaHeap : '-Xmx2g',
    maxConcurrentJobs: Math.max(1, Number(raw.maxConcurrentJobs ?? 1)),
    defaultTimeoutSec: Math.max(10, Number(raw.defaultTimeoutSec ?? 600)),
    sweepTimeoutSec: Math.max(10, Number(raw.sweepTimeoutSec ?? 900)),
    maxSweepCombinations: Math.max(1, Number(raw.maxSweepCombinations ?? 12)),
    maxOutputBytes: Number(raw.maxOutputBytes ?? 64 * 1024 * 1024),
    killGraceMs: Math.max(1000, Number(raw.killGraceMs ?? 5000)),
  }

  for (const dir of [
    config.workspaceRoot,
    config.jobsDir,
    config.exportsDir,
    config.modelsDir,
    config.runsDir,
    config.sweepsDir,
    config.driverDir,
  ]) {
    ensureDir(dir)
  }

  return config
}

export function describeConfig(config) {
  return {
    plugin: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    workspaceRoot: config.workspaceRoot,
    comsolHome: config.comsolHome,
    comsolCandidates: config.comsolCandidates,
    allowedRoots: config.allowedRoots,
    maxConcurrentJobs: config.maxConcurrentJobs,
    maxSweepCombinations: config.maxSweepCombinations,
    defaultTimeoutSec: config.defaultTimeoutSec,
  }
}
