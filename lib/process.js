import { spawn } from 'node:child_process'
import { decodeBuffer } from './decode.js'

const IS_WINDOWS = process.platform === 'win32'

export function killProcessTree(pid) {
  if (!pid) return
  if (IS_WINDOWS) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => {})
    } catch {
      // fall through to the direct kill below
    }
  }
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
}

// Spawn with a hard timeout and cancellation. Arguments stay an array.
export function startProcess(file, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 60_000,
    onStdout = () => {},
    onStderr = () => {},
    maxCaptureBytes = 8 * 1024 * 1024,
  } = options

  const startedAt = Date.now()
  const stdout = []
  const stderr = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let timedOut = false
  let cancelled = false
  let settled = false
  let timer = null
  let child

  try {
    child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return {
      pid: null,
      kill: () => {},
      promise: Promise.resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: String(error?.message ?? error),
        timedOut: false,
        cancelled: false,
        durationMs: 0,
        spawnError: true,
      }),
    }
  }

  const append = (collection, chunk, kind) => {
    if (kind === 'stdout') {
      if (stdoutBytes >= maxCaptureBytes) return
      stdoutBytes += chunk.length
      collection.push(chunk)
      onStdout(decodeBuffer(chunk))
    } else {
      if (stderrBytes >= maxCaptureBytes) return
      stderrBytes += chunk.length
      collection.push(chunk)
      onStderr(decodeBuffer(chunk))
    }
  }

  child.stdout?.on('data', (chunk) => append(stdout, chunk, 'stdout'))
  child.stderr?.on('data', (chunk) => append(stderr, chunk, 'stderr'))

  const finish = (extra = {}) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve({
      code: extra.code ?? null,
      signal: extra.signal ?? null,
      stdout: decodeBuffer(Buffer.concat(stdout)),
      stderr: decodeBuffer(Buffer.concat(stderr)),
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
      spawnError: false,
      ...extra,
    })
  }

  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })

  timer = setTimeout(() => {
    if (settled) return
    timedOut = true
    killProcessTree(child.pid)
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
    // Wait briefly for taskkill, then settle.
    setTimeout(() => finish({ code: null, signal: 'TIMEOUT' }), 1500)
  }, Math.max(1000, timeoutMs))

  child.on('error', (error) => {
    finish({ code: null, signal: 'SPAWN_ERROR', error: String(error?.message ?? error), spawnError: true })
  })
  child.on('close', (code, signal) => {
    finish({ code, signal })
  })

  return {
    pid: child.pid,
    promise,
    kill: (reason = 'cancelled') => {
      if (settled) return
      cancelled = true
      killProcessTree(child.pid)
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish({ code: null, signal: reason, cancelled: true })
    },
    get settled() {
      return settled
    },
  }
}

export async function runProcess(file, args, options = {}) {
  const handle = startProcess(file, args, options)
  return handle.promise
}
