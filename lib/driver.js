import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startProcess } from './process.js'
import { ensureDir } from './paths.js'
import { fail } from './errors.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tail(text, lines = 40) {
  const all = String(text ?? '').split(/\r?\n/)
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

export class ComsolDriver {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.compiled = false
    this.compileResult = null
    this.sourcePath = path.join(PLUGIN_ROOT, 'java', 'ComsolBridge.java')
    this.classesDir = path.join(config.driverDir, 'classes')
    this.classFile = path.join(this.classesDir, 'ComsolBridge.class')
  }

  resolve() {
    const home = this.config.comsolHome
    if (!home) {
      fail(
        'COMSOL_NOT_FOUND',
        'COMSOL Multiphysics was not detected. Set config.comsolHome to the Multiphysics directory (for example D:\\\\COMSOL62\\\\Multiphysics) or define COMSOL_HOME.',
        { candidates: this.config.comsolCandidates ?? [] },
      )
    }
    const java = path.join(home, 'java', 'win64', 'jre', 'bin', 'java.exe')
    const javac = path.join(home, 'java', 'win64', 'jre', 'bin', 'javac.exe')
    const plugins = path.join(home, 'plugins')
    if (!fs.existsSync(java)) fail('COMSOL_JAVA_MISSING', `COMSOL Java runtime not found: ${java}`)
    if (!fs.existsSync(javac)) fail('COMSOL_JAVAC_MISSING', `COMSOL javac not found: ${javac}`)
    if (!fs.existsSync(plugins)) fail('COMSOL_PLUGINS_MISSING', `COMSOL plugins directory not found: ${plugins}`)
    return {
      home,
      java,
      javac,
      plugins,
      bin: path.join(home, 'bin', 'win64'),
      libraries: path.join(home, 'bin', 'win64'),
      classpath: `${this.classesDir};${path.join(plugins, '*')}`,
    }
  }

  async ensureCompiled() {
    if (!fs.existsSync(this.sourcePath)) {
      fail('DRIVER_SOURCE_MISSING', `Java bridge source is missing: ${this.sourcePath}`)
    }
    const resolved = this.resolve()
    ensureDir(this.classesDir)
    const needsCompile =
      !fs.existsSync(this.classFile) ||
      fs.statSync(this.sourcePath).mtimeMs > fs.statSync(this.classFile).mtimeMs
    if (!needsCompile) {
      this.compiled = true
      this.compileResult = { compiled: false, upToDate: true, classFile: this.classFile }
      return this.compileResult
    }
    const logPath = path.join(this.config.driverDir, 'compile.log')
    const args = ['-encoding', 'UTF-8', '-cp', path.join(resolved.plugins, '*'), '-d', this.classesDir, this.sourcePath]
    const handle = startProcess(resolved.javac, args, { timeoutMs: 180_000 })
    const result = await handle.promise
    const text = `# javac ${resolved.javac}\n# source ${this.sourcePath}\n# exit ${result.code} timedOut=${result.timedOut}\n${result.stdout}\n${result.stderr}\n`
    fs.writeFileSync(logPath, text, 'utf8')
    if (result.code !== 0 || !fs.existsSync(this.classFile)) {
      fail('DRIVER_COMPILE_FAILED', 'Failed to compile the COMSOL Java bridge.', {
        exitCode: result.code,
        timedOut: result.timedOut,
        logPath,
        tail: tail(text, 60),
      })
    }
    this.compiled = true
    this.compileResult = { compiled: true, classFile: this.classFile, logPath, durationMs: result.durationMs }
    return this.compileResult
  }

  async ensureReady() {
    const resolved = this.resolve()
    const compile = await this.ensureCompiled()
    return { ...resolved, compile }
  }

  /**
   * Execute one bridge action. The caller owns the job directory and the job log.
   * Returns the parsed JSON result written by the Java driver.
   */
  async runAction({ action, payload = {}, jobDir, jobId = 'adhoc', timeoutMs, onLog, signal }) {
    const resolved = await this.ensureReady()
    ensureDir(jobDir)
    const jobPath = path.join(jobDir, 'job.json')
    const resultPath = path.join(jobDir, 'result.json')
    const logPath = path.join(jobDir, 'log.txt')
    if (fs.existsSync(resultPath)) {
      try {
        fs.unlinkSync(resultPath)
      } catch {
        // ignore stale result removal failure; the driver overwrites it
      }
    }
    const job = { action, ...payload }
    fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), 'utf8')
    const args = [
      `-Dcs.root=${resolved.home}`,
      `-Dinstall.dir=${resolved.home}`,
      `-Djava.library.path=${resolved.libraries}`,
      this.config.javaHeap,
      '-cp',
      resolved.classpath,
      'ComsolBridge',
      jobPath,
      resultPath,
    ]

    const startedAt = new Date().toISOString()
    const header = [
      `# comsol-agent job ${jobId}`,
      `# action ${action}`,
      `# started ${startedAt}`,
      `# executable ${resolved.java}`,
      `# args ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
      '',
    ].join('\n')
    fs.writeFileSync(logPath, header, 'utf8')

    const appendLog = (text) => {
      if (!text) return
      fs.appendFileSync(logPath, text, 'utf8')
      onLog?.(text)
    }

    const effectiveTimeout = Math.max(5000, Number(timeoutMs ?? this.config.defaultTimeoutSec * 1000))
    const handle = startProcess(resolved.java, args, {
      cwd: jobDir,
      timeoutMs: effectiveTimeout,
      onStdout: appendLog,
      onStderr: appendLog,
    })
    this.active = handle
    if (signal) {
      if (signal.aborted) handle.kill('cancelled')
      else signal.addEventListener('abort', () => handle.kill('cancelled'), { once: true })
    }
    const processResult = await handle.promise
    this.active = null
    appendLog(
      `\n# finished ${new Date().toISOString()} exit=${processResult.code} timedOut=${processResult.timedOut} cancelled=${processResult.cancelled} durationMs=${processResult.durationMs}\n`,
    )

    let bridgeResult = null
    let parseError = null
    if (fs.existsSync(resultPath)) {
      try {
        bridgeResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
      } catch (error) {
        parseError = String(error?.message ?? error)
      }
    } else {
      parseError = 'The Java bridge did not write result.json.'
    }

    const logText = fs.readFileSync(logPath, 'utf8')
    if (processResult.timedOut) {
      return {
        ok: false,
        status: 'timeout',
        timedOut: true,
        cancelled: false,
        exitCode: processResult.code,
        durationMs: processResult.durationMs,
        jobPath,
        resultPath,
        logPath,
        result: bridgeResult,
        error: {
          code: 'COMSOL_TIMEOUT',
          message: `COMSOL bridge exceeded the ${Math.round(effectiveTimeout / 1000)} s timeout.`,
        },
        logTail: tail(logText, 60),
      }
    }
    if (processResult.cancelled) {
      return {
        ok: false,
        status: 'cancelled',
        timedOut: false,
        cancelled: true,
        exitCode: processResult.code,
        durationMs: processResult.durationMs,
        jobPath,
        resultPath,
        logPath,
        result: bridgeResult,
        error: { code: 'JOB_CANCELLED', message: 'The COMSOL bridge process was cancelled.' },
        logTail: tail(logText, 60),
      }
    }
    if (!bridgeResult) {
      return {
        ok: false,
        status: 'failed',
        timedOut: false,
        cancelled: false,
        exitCode: processResult.code,
        durationMs: processResult.durationMs,
        jobPath,
        resultPath,
        logPath,
        result: null,
        error: {
          code: 'BRIDGE_NO_RESULT',
          message: parseError ?? 'The Java bridge produced no parseable result.',
          exitCode: processResult.code,
          stderrTail: tail(processResult.stderr, 40),
        },
        logTail: tail(logText, 60),
      }
    }
    return {
      ok: bridgeResult.ok === true,
      status: bridgeResult.ok === true ? 'succeeded' : 'failed',
      timedOut: false,
      cancelled: false,
      exitCode: processResult.code,
      durationMs: processResult.durationMs,
      jobPath,
      resultPath,
      logPath,
      result: bridgeResult,
      error: bridgeResult.ok === true ? null : bridgeResult.error ?? { code: 'COMSOL_ERROR', message: 'Unknown COMSOL failure' },
      logTail: tail(logText, 60),
    }
  }

  async probe({ timeoutMs = 180_000, jobKind = 'environment-probe' } = {}) {
    const dir = path.join(this.config.driverDir, `${jobKind}-${Date.now()}`)
    const run = await this.runAction({ action: 'probe', jobDir: dir, jobId: jobKind, timeoutMs })
    return {
      attempted: true,
      ok: run.ok,
      result: run.result,
      error: run.error,
      logPath: run.logPath,
      durationMs: run.durationMs,
    }
  }

  cancelActive() {
    this.active?.kill('cancelled')
  }
}
