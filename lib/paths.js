import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fail } from './errors.js'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function isSubPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function assertInsideRoots(target, roots, label = 'output path') {
  if (!Array.isArray(roots) || roots.length === 0) {
    fail('NO_ALLOWED_ROOTS', `No allowed output roots configured for ${label}`)
  }
  const resolved = path.resolve(target)
  const allowed = roots.some((root) => isSubPath(root, resolved))
  if (!allowed) {
    fail(
      'OUTPUT_OUTSIDE_WORKSPACE',
      `${label} must stay inside the COMSOL agent workspace or a configured allowlist root. Resolved: ${resolved}`,
      { allowedRoots: roots.map((r) => path.resolve(r)) },
    )
  }
  return resolved
}

export function assertMphPath(modelPath, label = 'modelPath') {
  if (typeof modelPath !== 'string' || modelPath.trim() === '') {
    fail('MISSING_MODEL_PATH', `${label} is required`)
  }
  const resolved = path.resolve(modelPath)
  let stat
  try {
    stat = fs.statSync(resolved)
  } catch {
    fail('MODEL_NOT_FOUND', `Model file does not exist: ${resolved}`)
  }
  if (!stat.isFile()) fail('MODEL_NOT_A_FILE', `Model path is not a regular file: ${resolved}`)
  if (path.extname(resolved).toLowerCase() !== '.mph') {
    fail('MODEL_BAD_EXTENSION', `Expected a .mph model file, got: ${path.basename(resolved)}`)
  }
  if (stat.size === 0) fail('MODEL_EMPTY', `Model file is empty: ${resolved}`)
  try {
    fs.accessSync(resolved, fs.constants.R_OK)
  } catch {
    fail('MODEL_NOT_READABLE', `Model file is not readable: ${resolved}`)
  }
  return { path: resolved, sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
}

export function prepareOutputPath(outputPath, roots, fallback) {
  const target = outputPath ? path.resolve(outputPath) : path.resolve(fallback)
  const safe = assertInsideRoots(target, roots)
  ensureDir(path.dirname(safe))
  return safe
}

export function assertNotSamePath(a, b) {
  if (!a || !b) return
  const ra = path.resolve(a)
  const rb = path.resolve(b)
  if (process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb) {
    fail('WOULD_OVERWRITE_INPUT', `Refusing to overwrite the input model: ${ra}`)
  }
}

export function testWritableDir(dir) {
  const resolved = path.resolve(dir)
  try {
    ensureDir(resolved)
    const probe = path.join(resolved, `.comsol-agent-write-test-${process.pid}-${Date.now()}`)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return { path: resolved, writable: true }
  } catch (error) {
    return { path: resolved, writable: false, error: String(error?.message ?? error) }
  }
}

export function timestampCompact(date = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

export function safeFilename(input, fallback = 'model') {
  const base = path.basename(String(input ?? '').trim())
  const stem = base.replace(/\.mph$/i, '') || fallback
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
  return cleaned || fallback
}

export function workspaceInfo(config) {
  return {
    workspaceRoot: config.workspaceRoot,
    jobsDir: config.jobsDir,
    exportsDir: config.exportsDir,
    modelsDir: config.modelsDir,
    runsDir: config.runsDir,
    sweepsDir: config.sweepsDir,
    allowedRoots: config.allowedRoots,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  }
}
