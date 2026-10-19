import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, timestampCompact } from './paths.js'

function nowIso() {
  return new Date().toISOString()
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

export class JobManager {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.jobs = new Map()
    this.queue = []
    this.running = 0
    this.closed = false
    this.seq = 0
    ensureDir(config.jobsDir)
    this._markStaleJobs()
  }

  _markStaleJobs() {
    let entries = []
    try {
      entries = fs.readdirSync(this.config.jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      return
    }
    for (const entry of entries) {
      const file = path.join(this.config.jobsDir, entry.name, 'job.json')
      if (!fs.existsSync(file)) continue
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (record.status === 'running' || record.status === 'queued') {
          record.status = 'interrupted'
          record.finishedAt = record.finishedAt ?? nowIso()
          record.error = {
            code: 'JOB_INTERRUPTED',
            message: 'The Harness process restarted before this job finished; its result is unknown.',
          }
          fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
        }
      } catch {
        // ignore malformed records
      }
    }
  }

  create({ kind, title, input = {}, meta = {} }) {
    const id = `job-${timestampCompact()}-${String(++this.seq).padStart(3, '0')}-${randomSuffix()}`
    const dir = path.join(this.config.jobsDir, id)
    ensureDir(dir)
    const record = {
      id,
      kind,
      title,
      status: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      input,
      meta,
      progress: { phase: 'queued', message: 'Waiting in the COMSOL job queue', updatedAt: nowIso() },
      result: null,
      error: null,
      jobDir: dir,
      logPath: path.join(dir, 'log.txt'),
      resultPath: path.join(dir, 'result.json'),
      pid: null,
      _waiters: [],
      _abort: null,
    }
    this.jobs.set(id, record)
    this._persist(record)
    return record
  }

  _persist(record) {
    const clean = this._publicRecord(record)
    try {
      fs.writeFileSync(path.join(record.jobDir, 'job.json'), JSON.stringify(clean, null, 2), 'utf8')
    } catch (error) {
      this.logger?.warn?.(`Failed to persist job ${record.id}: ${String(error?.message ?? error)}`)
    }
  }

  _publicRecord(record) {
    const out = {}
    for (const [key, value] of Object.entries(record ?? {})) {
      if (key.startsWith('\_')) continue
      out[key] = value
    }
    return out
  }

  setProgress(record, phase, message) {
    record.progress = { phase, message, updatedAt: nowIso() }
    this._persist(record)
  }

  enqueue(record, runner) {
    record._promise = new Promise((resolve) => {
      record._waiters.push(resolve)
    })
    this.queue.push({ record, runner })
    this._pump()
    return record
  }

  async runSync(record, runner) {
    record._promise = new Promise((resolve) => {
      record._waiters.push(resolve)
    })
    this.queue.push({ record, runner })
    this._pump()
    return record._promise
  }

  _pump() {
    if (this.closed) return
    while (this.running < this.config.maxConcurrentJobs && this.queue.length > 0) {
      const item = this.queue.shift()
      this._execute(item)
    }
  }

  async _execute({ record, runner }) {
    if (record.status === 'cancelled') {
      this._settle(record)
      return
    }
    this.running += 1
    record.status = 'running'
    record.startedAt = nowIso()
    record._abort = new AbortController()
    this.setProgress(record, 'starting', 'Starting the COMSOL Java bridge')
    try {
      const outcome = await runner({
        record,
        signal: record._abort.signal,
        setProgress: (phase, message) => this.setProgress(record, phase, message),
      })
      const status = record.cancelRequested
        ? 'cancelled'
        : outcome?.status ?? (outcome?.ok === false ? 'failed' : 'succeeded')
      record.status = status
      record.result = outcome?.result ?? null
      record.error = status === 'succeeded' ? null : outcome?.error ?? record.error
    } catch (error) {
      record.status = record.cancelRequested ? 'cancelled' : 'failed'
      record.error = {
        code: error?.code ?? 'JOB_FAILED',
        message: String(error?.message ?? error),
        details: error?.details,
      }
    } finally {
      record.finishedAt = nowIso()
      record.durationMs = record.startedAt ? Date.parse(record.finishedAt) - Date.parse(record.startedAt) : null
      record.progress = {
        phase: record.status,
        message:
          record.status === 'succeeded'
            ? 'Finished'
            : record.error?.message ?? `Finished with status ${record.status}`,
        updatedAt: nowIso(),
      }
      this._persist(record)
      this.running -= 1
      this._settle(record)
      this._pump()
    }
  }

  _settle(record) {
    const waiters = record._waiters ?? []
    record._waiters = []
    for (const waiter of waiters) {
      try {
        waiter(this._publicRecord(record))
      } catch {
        // ignore waiter errors
      }
    }
  }

  cancel(id) {
    const record = this.get(id)
    if (!record) return { ok: false, error: { code: 'JOB_NOT_FOUND', message: `Unknown job: ${id}` } }
    if (record.status === 'queued') {
      const index = this.queue.findIndex((item) => item.record.id === id)
      if (index >= 0) this.queue.splice(index, 1)
      record.cancelRequested = true
      record.status = 'cancelled'
      record.finishedAt = nowIso()
      record.error = { code: 'JOB_CANCELLED', message: 'Cancelled before execution started.' }
      this._persist(record)
      this._settle(record)
      return { ok: true, job: this.summarize(record) }
    }
    if (record.status === 'running') {
      record.cancelRequested = true
      try {
        record._abort?.abort()
      } catch {
        // ignore
      }
      return { ok: true, job: this.summarize(record), note: 'Cancellation requested; the COMSOL process is being terminated.' }
    }
    return { ok: false, error: { code: 'JOB_NOT_CANCELLABLE', message: `Job ${id} is ${record.status}.` } }
  }

  get(id) {
    if (this.jobs.has(id)) return this.jobs.get(id)
    const dir = path.join(this.config.jobsDir, id)
    const file = path.join(dir, 'job.json')
    if (!fs.existsSync(file)) return null
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'))
      record._waiters = []
      this.jobs.set(id, record)
      return record
    } catch {
      return null
    }
  }

  list(limit = 20) {
    const byId = new Map()
    try {
      const entries = fs.readdirSync(this.config.jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
      for (const entry of entries) {
        const file = path.join(this.config.jobsDir, entry.name, 'job.json')
        if (!fs.existsSync(file)) continue
        try {
          byId.set(entry.name, JSON.parse(fs.readFileSync(file, 'utf8')))
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    for (const [id, record] of this.jobs) byId.set(id, this._publicRecord(record))
    return [...byId.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
  }

  async waitFor(id, timeoutMs = 0) {
    const record = this.get(id)
    if (!record) return null
    if (record.status !== 'queued' && record.status !== 'running') return this._publicRecord(record)
    if (!record._promise) {
      // loaded from disk; poll
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline || timeoutMs === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const fresh = this.get(id)
        if (fresh && fresh.status !== 'queued' && fresh.status !== 'running') return this._publicRecord(fresh)
        if (timeoutMs === 0) return null
        if (Date.now() > deadline) return null
      }
      return null
    }
    if (timeoutMs <= 0) return record._promise
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(this._publicRecord(record))
      }, timeoutMs)
      record._promise.then((result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      })
    })
  }

  summarize(record) {
    if (!record) return null
    return {
      jobId: record.id,
      kind: record.kind,
      title: record.title,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      progress: record.progress,
      result: record.result,
      error: record.error,
      logPath: record.logPath,
      jobDir: record.jobDir,
    }
  }

  dispose() {
    this.closed = true
    for (const item of this.queue) {
      item.record.cancelRequested = true
      item.record.status = 'cancelled'
      item.record.error = { code: 'JOB_CANCELLED', message: 'Plugin unloaded before the job started.' }
      this._persist(item.record)
      this._settle(item.record)
    }
    this.queue = []
    for (const record of this.jobs.values()) {
      if (record.status === 'running') {
        record.cancelRequested = true
        try {
          record._abort?.abort()
        } catch {
          // ignore
        }
      }
    }
  }
}
