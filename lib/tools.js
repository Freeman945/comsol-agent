import fs from 'node:fs'
import path from 'node:path'
import { fail } from './errors.js'
import {
  assertMphPath,
  assertInsideRoots,
  assertNotSamePath,
  prepareOutputPath,
  ensureDir,
  timestampCompact,
  safeFilename,
  testWritableDir,
} from './paths.js'
import { checkEnvironment } from './environment.js'
import { analyzeLog } from './logs.js'
import { startProcess } from './process.js'
import { decodeBuffer } from './decode.js'
import {
  outputSchema,
  renderValue,
  stringSchema,
  booleanSchema,
  numberSchema,
  stringArraySchema,
  selectionSchema,
  paramsSchema,
  coordinatesSchema,
  normalizeParams,
} from './schema.js'

function makeTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => renderValue(value),
    },
    execute,
  }
}

function safeExportFilename(name, fallback) {
  if (name === undefined || name === null || name === '') return fallback
  const raw = String(name)
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    fail('INVALID_FILENAME', `Export filename must be a plain file name without path components: ${raw}`)
  }
  return raw
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function writeCsvFile(file, header, rows) {
  ensureDir(path.dirname(file))
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

function combosOf(parameters) {
  const names = Object.keys(parameters)
  if (names.length === 0) return []
  let combos = [{ }]
  for (const name of names) {
    const values = parameters[name]
    const next = []
    for (const base of combos) {
      for (const value of values) {
        next.push({ ...base, [name]: value })
      }
    }
    combos = next
  }
  return combos
}

function comboLabel(combo) {
  return Object.entries(combo)
    .map(([key, value]) => `${safeFilename(key)}-${safeFilename(value, 'v')}`)
    .join('__')
}

function ensureFiniteNumber(value, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    fail('INVALID_NUMBER', `${name} must be a finite number between ${min} and ${max}`, { value })
  }
  return number
}

export function createTools({ config, driver, jobs, logger }) {
  async function runDriverSync({ kind, title, input, action, payload, timeoutMs }) {
    const record = jobs.create({ kind, title, input })
    return jobs.runSync(record, async ({ setProgress, signal }) => {
      setProgress('running', `Running COMSOL bridge action: ${action}`)
      const run = await driver.runAction({
        action,
        payload,
        jobDir: record.jobDir,
        jobId: record.id,
        timeoutMs,
        signal,
      })
      return {
        ok: run.ok,
        status: run.status,
        result: run.result
          ? { ...run.result, _job: { jobId: record.id, logPath: run.logPath, resultPath: run.resultPath, durationMs: run.durationMs } }
          : { _job: { jobId: record.id, logPath: run.logPath, resultPath: run.resultPath, durationMs: run.durationMs } },
        error: run.error,
      }
    })
  }

  function startAsyncJob({ kind, title, input, runner }) {
    const record = jobs.create({ kind, title, input })
    jobs.enqueue(record, runner(record))
    return record
  }

  async function maybeWait(record, wait, timeoutMs) {
    if (!wait) return jobs.summarize(record)
    const settled = await jobs.waitFor(record.id, Math.max(30_000, timeoutMs + 30_000))
    return jobs.summarize(settled ?? record)
  }

  const tools = []

  // ---------------------------------------------------------------- environment
  tools.push(
    makeTool(
      'comsol_check_environment',
      '检测 COMSOL 安装、版本、Java API、许可线索以及 MATLAB/LiveLink。deep=true 会创建一个小模型，实际检出一次许可。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          deep: booleanSchema(
            'If true, create a small model to verify a real COMSOL Java API license checkout. This briefly consumes a license seat.',
            false,
          ),
        },
      },
      async (args = {}) => {
        const report = await checkEnvironment({
          config,
          driver,
          deep: Boolean(args.deep),
          logger,
        })
        return {
          ...report,
          workspace: {
            root: config.workspaceRoot,
            writable: testWritableDir(config.workspaceRoot),
            allowedRoots: config.allowedRoots,
          },
          nextSteps: report.comsol.found
            ? [
                'Use comsol_validate_model to check a specific .mph file before running it.',
                'Use deep=true for a license checkout probe.',
              ]
            : [
                'Set plugin config comsolHome to the COMSOL Multiphysics directory, for example D:\\\\COMSOL62\\\\Multiphysics, or set COMSOL_HOME.',
              ],
        }
      },
    ),
  )

  // ----------------------------------------------------------------- validate
  tools.push(
    makeTool(
      'comsol_validate_model',
      '检查 .mph 文件并让 COMSOL 实际加载；文件检查和模型加载分别返回。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['modelPath'],
        properties: {
          modelPath: stringSchema('Absolute path to the .mph model to validate.'),
          workingDir: stringSchema('Optional directory used for the write test. Defaults to the agent workspace.'),
          openCheck: booleanSchema('If true, load the model through COMSOL and return its structure.', true),
          timeoutSec: numberSchema('Timeout for the COMSOL load check, in seconds.', { default: 180, minimum: 10, maximum: 3600 }),
        },
      },
      async (args = {}) => {
        const info = assertMphPath(args.modelPath)
        const workingDir = args.workingDir ? path.resolve(args.workingDir) : config.workspaceRoot
        const writable = testWritableDir(workingDir)
        const warnings = []
        let modelOpen = { attempted: false }
        let previewDetected = false
        let record = null

        if (args.openCheck !== false) {
          const timeoutMs = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 3600, fallback: 180 }) * 1000
          try {
            record = await runDriverSync({
              kind: 'validate_model',
              title: `Validate ${path.basename(info.path)}`,
              input: { modelPath: info.path },
              action: 'inspect',
              payload: { modelPath: info.path },
              timeoutMs,
            })
            const summary = record.result?.model ?? null
            modelOpen = {
              attempted: true,
              ok: record.status === 'succeeded',
              status: record.status,
              jobId: record.id,
              logPath: record.logPath,
              model: summary,
              error: record.error,
            }
            previewDetected = record.error?.code === 'MODEL_IS_APPLICATION_LIBRARY_PREVIEW'
            if (previewDetected) {
              warnings.push('This .mph is an Application Library preview placeholder, not a complete model.')
            }
            if (record.status === 'succeeded' && summary) {
              if (!summary.physics || summary.physics.length === 0) warnings.push('The model opened but contains no physics interface.')
              if (!summary.meshes || summary.meshes.every((mesh) => !mesh.numElements)) warnings.push('The model has no built mesh elements.')
              if (!summary.solutions || summary.solutions.length === 0) warnings.push('The model has no solution data. It can be opened but results are not available yet.')
            }
          } catch (error) {
            modelOpen = {
              attempted: true,
              ok: false,
              status: 'failed',
              error: { code: error?.code ?? 'MODEL_OPEN_FAILED', message: String(error?.message ?? error) },
            }
            warnings.push('The COMSOL load check could not be executed; the file was only checked at the filesystem level.')
          }
        }

        const fileOk = info.sizeBytes > 0
        const ok = fileOk && writable.writable && (args.openCheck === false || modelOpen.ok === true)
        return {
          ok,
          checkedAt: new Date().toISOString(),
          fileChecks: {
            path: info.path,
            exists: true,
            readable: true,
            extension: path.extname(info.path).toLowerCase(),
            sizeBytes: info.sizeBytes,
            modifiedAt: new Date(info.mtimeMs).toISOString(),
            fileLevelVerdict: fileOk ? 'file looks readable and non-empty' : 'file is empty',
          },
          outputDirectory: writable,
          modelOpen,
          previewDetected,
          jobId: record?.id ?? null,
          logPath: record?.logPath ?? null,
          warnings,
          interpretation:
            'File checks and model-open checks are separate. Only modelOpen.ok=true means COMSOL actually loaded this model in this run.',
        }
      },
    ),
  )

  // ---------------------------------------------------------------- create model
  tools.push(
    makeTool(
      'comsol_create_model',
      '创建参数化 COMSOL 模型并保存。支持 2D 轴对称同轴模板（coaxial_conical_gap、rf_coax_air）和 3D 矩形波导开槽模板（rectangular_slot_launcher）；均为冷态电磁模型，不含等离子体、气流或传热。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: {
            type: 'string',
            description: 'Model template to build.',
            enum: ['coaxial_conical_gap', 'rf_coax_air', 'rectangular_slot_launcher'],
            default: 'coaxial_conical_gap',
          },
          name: stringSchema('Base name for the output model file (without extension).'),
          outputPath: stringSchema('Absolute output .mph path inside the agent workspace. Overrides name-based path generation.'),
          templateParams: {
            type: 'object',
            description:
              'Template parameters in mm. Coaxial keys: r_in, r_out, z_feed, z_tip, r_tip_in, r_tip_out. Rectangular slot keys: a, b, L, slot_l, slot_w, slot_offset, t_m, t_q, quartz_w, quartz_l, quartz_er, outer_h, outer_x, margin, ridge_h, ridge_w, ridge_l. Common: freq, P_in.',
            additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
          meshSize: numberSchema('COMSOL mesh size parameter hauto (1=extremely fine, 9=extremely coarse). Default 4 for 2D, 5 for 3D.', {
            minimum: 1,
            maximum: 9,
            default: 4,
          }),
          solve: booleanSchema('If true, build the mesh and solve the frequency-domain study immediately.', false),
          overwrite: booleanSchema('Allow replacing an existing output file.', false),
          timeoutSec: numberSchema('Timeout for model creation (and solve when requested) in seconds.', {
            minimum: 10,
            maximum: 7200,
            default: 900,
          }),
        },
      },
      async (args = {}) => {
        const template = args.template ?? 'coaxial_conical_gap'
        const stamp = timestampCompact()
        const baseName = args.name ? safeFilename(args.name, 'model') : `${template}_${stamp}`
        const outputPath = prepareOutputPath(
          args.outputPath,
          config.allowedRoots,
          path.join(config.modelsDir, `${baseName}.mph`),
        )
        if (fs.existsSync(outputPath) && !args.overwrite) {
          fail('OUTPUT_EXISTS', `Output model already exists: ${outputPath}. Pass overwrite=true to replace it.`)
        }
        const templateParams = normalizeParams(args.templateParams) ?? {}
        const timeoutMs = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 7200, fallback: 900 }) * 1000
        const record = await runDriverSync({
          kind: 'create_model',
          title: `Create ${template}`,
          input: { template, outputPath, templateParams, solve: Boolean(args.solve) },
          action: 'create_model',
          payload: {
            template,
            outputPath,
            overwrite: Boolean(args.overwrite),
            solve: Boolean(args.solve),
            meshSize: args.meshSize ?? 4,
            templateParams,
          },
          timeoutMs,
        })
        const result = record.result ?? {}
        const fileCheck = fs.existsSync(outputPath)
          ? { exists: true, sizeBytes: fs.statSync(outputPath).size }
          : { exists: false }
        return {
          ok: record.status === 'succeeded' && fileCheck.exists && fileCheck.sizeBytes > 0,
          status: record.status,
          jobId: record.id,
          logPath: record.logPath,
          template,
          outputPath,
          fileCheck,
          solved: Boolean(result.solved),
          s11: result.s11 ?? null,
          s21: result.s21 ?? null,
          slotField: result.slotField ?? null,
          model: result.model ?? null,
          modelingAssumptions: result.modelingAssumptions ?? [],
          warnings: result.geometryWarning ? [result.geometryWarning] : [],
          error: record.error,
        }
      },
    ),
  )

  // ---------------------------------------------------------------- set params
  tools.push(
    makeTool(
      'comsol_set_parameters',
      '修改模型全局参数并另存，随后重新加载核对。支持 40[mm]、2.45[GHz] 等表达式。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['modelPath', 'params'],
        properties: {
          modelPath: stringSchema('Absolute path to the source .mph model. It is never modified.'),
          params: paramsSchema,
          outputPath: stringSchema('Absolute output .mph path inside the workspace. Defaults to runs/<name>__params_<timestamp>.mph.'),
          overwrite: booleanSchema('Allow replacing an existing output file. Default false.', false),
          allowNewParams: booleanSchema('If true, allow creating parameters that do not already exist.', false),
          timeoutSec: numberSchema('Timeout in seconds.', { minimum: 10, maximum: 3600, default: 300 }),
        },
      },
      async (args = {}) => {
        const info = assertMphPath(args.modelPath)
        const params = normalizeParams(args.params)
        if (!params || Object.keys(params).length === 0) {
          fail('MISSING_PARAMS', 'params must contain at least one parameter name/value pair')
        }
        const outputPath = prepareOutputPath(
          args.outputPath,
          config.allowedRoots,
          path.join(config.runsDir, `${safeFilename(info.path)}__params_${timestampCompact()}.mph`),
        )
        assertNotSamePath(info.path, outputPath)
        if (fs.existsSync(outputPath) && !args.overwrite) {
          fail('OUTPUT_EXISTS', `Output model already exists: ${outputPath}. Pass overwrite=true to replace it.`)
        }
        const timeoutMs = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 3600, fallback: 300 }) * 1000
        const record = await runDriverSync({
          kind: 'set_parameters',
          title: `Set parameters on ${path.basename(info.path)}`,
          input: { modelPath: info.path, outputPath, params },
          action: 'set_params',
          payload: { modelPath: info.path, outputPath, params, allowNewParams: Boolean(args.allowNewParams) },
          timeoutMs,
        })
        const result = record.result ?? {}
        const verification = Array.isArray(result.verification) ? result.verification : []
        const allVerified = verification.length > 0 && verification.every((item) => item.ok === true)
        return {
          ok: record.status === 'succeeded' && allVerified && fs.existsSync(outputPath),
          status: allVerified ? record.status : record.status === 'succeeded' ? 'verification_failed' : record.status,
          jobId: record.id,
          logPath: record.logPath,
          sourceModel: info.path,
          outputPath,
          paramsApplied: result.paramsApplied ?? null,
          verification,
          allVerified,
          error: record.error,
        }
      },
    ),
  )

  // ---------------------------------------------------------------- run model
  tools.push(
    makeTool(
      'comsol_run_model',
      '运行已有 .mph：可改参数、选择研究、求解并另存。默认异步；engine="batch" 使用 comsolbatch。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['modelPath'],
        properties: {
          modelPath: stringSchema('Absolute path to the source .mph model.'),
          outputPath: stringSchema('Absolute output .mph path inside the workspace. Defaults to runs/<name>__run_<timestamp>.mph.'),
          overwrite: booleanSchema('Allow replacing an existing output file. Default false.', false),
          study: stringSchema('Optional study tag (for example std1). When omitted, all study steps are run in order.'),
          params: paramsSchema,
          solve: booleanSchema('If false, only load/apply parameters/save without running a study.', true),
          engine: {
            type: 'string',
            description: 'Execution engine. "java" uses the standalone COMSOL Java API; "batch" uses comsolbatch.exe.',
            enum: ['java', 'batch'],
            default: 'java',
          },
          timeoutSec: numberSchema('Per-run timeout in seconds.', { minimum: 10, maximum: 86400, default: 900 }),
          wait: booleanSchema('Wait for completion and return the final job summary instead of only a job id.', false),
        },
      },
      async (args = {}) => {
        const info = assertMphPath(args.modelPath)
        const outputPath = prepareOutputPath(
          args.outputPath,
          config.allowedRoots,
          path.join(config.runsDir, `${safeFilename(info.path)}__run_${timestampCompact()}.mph`),
        )
        assertNotSamePath(info.path, outputPath)
        if (fs.existsSync(outputPath) && !args.overwrite) {
          fail('OUTPUT_EXISTS', `Output model already exists: ${outputPath}. Pass overwrite=true to replace it.`)
        }
        const params = normalizeParams(args.params)
        const solve = args.solve !== false
        const engine = args.engine === 'batch' ? 'batch' : 'java'
        const timeoutSec = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 86400, fallback: 900 })
        const timeoutMs = timeoutSec * 1000

        if (engine === 'batch') {
          const record = startAsyncJob({
            kind: 'run_model_batch',
            title: `Run (batch) ${path.basename(info.path)}`,
            input: { modelPath: info.path, outputPath, study: args.study, params, solve },
            runner: (jobRecord) => async ({ setProgress, signal }) => {
              const result = await runComsolBatch({
                jobRecord,
                modelPath: info.path,
                outputPath,
                study: args.study,
                params,
                solve,
                timeoutMs,
                signal,
                setProgress,
              })
              return result
            },
          })
          const batchSummary = args.wait ? await maybeWait(record, true, timeoutMs) : jobs.summarize(record)
          return {
            ok: args.wait ? batchSummary.status === 'succeeded' : true,
            accepted: true,
            jobId: record.id,
            status: batchSummary.status ?? record.status,
            engine,
            outputPath,
            ...batchSummary,
          }
        }

        const record = startAsyncJob({
          kind: 'run_model',
          title: `Run ${path.basename(info.path)}`,
          input: { modelPath: info.path, outputPath, study: args.study, params, solve },
          runner: (jobRecord) => async ({ setProgress, signal }) => {
            setProgress('running', 'Loading model in COMSOL')
            const run = await driver.runAction({
              action: 'run',
              payload: { modelPath: info.path, outputPath, study: args.study, params, solve },
              jobDir: jobRecord.jobDir,
              jobId: jobRecord.id,
              timeoutMs,
              signal,
            })
            const outputExists = fs.existsSync(outputPath)
            const outputSize = outputExists ? fs.statSync(outputPath).size : 0
            const ok = run.ok && outputExists && outputSize > 0
            let logText = ''
            try {
              logText = fs.existsSync(run.logPath) ? fs.readFileSync(run.logPath, 'utf8') : ''
            } catch {
              logText = ''
            }
            const studiesRun = run.result?.studiesRun ?? []
            const solutions = run.result?.solutions ?? []
            const executionEvidence = {
              processStarted: run.exitCode !== null || Boolean(run.result),
              modelLoaded: /MODEL_LOADED=/.test(logText),
              solveRequested: solve,
              studiesRun,
              solutionsFound: solutions.length,
              solveCompleted: ok && solve && studiesRun.length > 0 && solutions.length > 0,
              outputWritten: outputExists && outputSize > 0,
              bridgeExitCode: run.exitCode,
              timedOut: run.timedOut,
              cancelled: run.cancelled,
            }
            return {
              ok,
              status: ok ? 'succeeded' : run.status,
              result: {
                ...(run.result ?? {}),
                outputPath,
                outputExists,
                outputSizeBytes: outputSize,
                jobId: jobRecord.id,
                logPath: run.logPath,
                executionEvidence,
              },
              error: ok
                ? null
                : run.error ?? {
                    code: 'OUTPUT_MISSING',
                    message: 'COMSOL reported success but the expected output .mph was not produced.',
                  },
            }
          },
        })
        const summary = args.wait ? await maybeWait(record, true, timeoutMs) : jobs.summarize(record)
        return {
          ok: args.wait ? summary.status === 'succeeded' : true,
          accepted: true,
          jobId: record.id,
          status: summary.status ?? record.status,
          engine,
          outputPath,
          ...summary,
        }
      },
    ),
  )

  // ---------------------------------------------------------------- sweep
  tools.push(
    makeTool(
      'comsol_parameter_sweep',
      '对参数做笛卡尔积扫描，每组独立加载、求解和保存。串行执行，记录每组状态、耗时、日志和输出；超过阈值需 confirm=true。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['modelPath', 'parameters'],
        properties: {
          modelPath: stringSchema('Absolute path to the source .mph model.'),
          parameters: {
            type: 'object',
            description: 'Map of parameter name to an array of values, for example {"r_tip_out": ["5.5", "6"], "freq": ["2.4[GHz]", "2.45[GHz]"]}.',
            additionalProperties: {
              type: 'array',
              items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            },
          },
          study: stringSchema('Optional study tag to solve for each combination.'),
          outputDir: stringSchema('Absolute output directory inside the workspace. Defaults to sweeps/<name>__<timestamp>.'),
          overwrite: booleanSchema('Allow replacing existing per-combination output models. Default false.', false),
          confirm: booleanSchema('Explicitly confirm runs whose combination count exceeds maxSweepCombinations.', false),
          stopOnError: booleanSchema('Stop the sweep at the first failed combination.', true),
          timeoutSec: numberSchema('Timeout per combination in seconds.', { minimum: 10, maximum: 86400, default: 900 }),
          maxCombinations: numberSchema('Safety threshold for the number of combinations.', {
            minimum: 1,
            maximum: 100000,
          }),
          resumeJobId: stringSchema('Optional earlier sweep job id whose completed combinations should be skipped.'),
          wait: booleanSchema('Wait for completion and return the final sweep summary.', false),
        },
      },
      async (args = {}) => {
        const info = assertMphPath(args.modelPath)
        if (!args.parameters || typeof args.parameters !== 'object' || Array.isArray(args.parameters)) {
          fail('MISSING_PARAMETERS', 'parameters must be an object mapping names to value arrays')
        }
        const normalized = {}
        for (const [name, values] of Object.entries(args.parameters)) {
          if (!Array.isArray(values) || values.length === 0) {
            fail('INVALID_SWEEP_VALUES', `Parameter ${name} must have a non-empty array of values`)
          }
          normalized[name] = values.map((value) => String(value))
        }
        const combos = combosOf(normalized)
        const limit = Math.max(
          1,
          Number(args.maxCombinations ?? config.maxSweepCombinations),
        )
        if (combos.length > limit && !args.confirm) {
          return {
            ok: false,
            status: 'confirmation_required',
            combinations: combos.length,
            threshold: limit,
            estimate: {
              runs: combos.length,
              timeoutSecPerRun: args.timeoutSec ?? 900,
              worstCaseWallClockSec: combos.length * (Number(args.timeoutSec ?? 900)),
              note: 'Each combination runs as a separate COMSOL process and can occupy a license seat for its duration.',
            },
            message:
              'The sweep exceeds the configured safety threshold. Re-run with confirm=true after checking the estimated cost.',
          }
        }

        const outputDir = assertInsideRoots(
          args.outputDir ? path.resolve(args.outputDir) : path.join(config.sweepsDir, `${safeFilename(info.path)}__${timestampCompact()}`),
          config.allowedRoots,
          'sweep outputDir',
        )
        ensureDir(outputDir)
        const timeoutMs = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 86400, fallback: 900 }) * 1000

        let previous = null
        if (args.resumeJobId) {
          const stateFile = path.join(config.jobsDir, args.resumeJobId, 'sweep.json')
          if (fs.existsSync(stateFile)) {
            try {
              previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
            } catch {
              previous = null
            }
          }
        }
        const previousCompleted = new Set(
          (previous?.results ?? []).filter((item) => item.status === 'succeeded').map((item) => item.index),
        )

        const record = startAsyncJob({
          kind: 'parameter_sweep',
          title: `Sweep ${path.basename(info.path)} (${combos.length} combinations)`,
          input: { modelPath: info.path, parameters: normalized, study: args.study, outputDir },
          runner: (jobRecord) => async ({ setProgress, signal }) => {
            const state = {
              jobId: jobRecord.id,
              modelPath: info.path,
              parameters: normalized,
              study: args.study ?? null,
              outputDir,
              combos,
              results: previous?.results ?? [],
              startedAt: new Date().toISOString(),
            }
            const stateFile = path.join(jobRecord.jobDir, 'sweep.json')
            const persist = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
            fs.writeFileSync(
              jobRecord.logPath,
              `# COMSOL parameter sweep ${jobRecord.id}\n# model ${info.path}\n# combinations ${combos.length}\n# started ${new Date().toISOString()}\n\n`,
              'utf8',
            )
            const logLine = (line) => fs.appendFileSync(jobRecord.logPath, `${new Date().toISOString()} ${line}\n`, 'utf8')
            persist()

            const paramNames = Object.keys(normalized)
            const writeSummary = () => {
              const header = [
                'index',
                ...paramNames,
                'status',
                'outputPath',
                'outputExists',
                'outputSizeBytes',
                'durationMs',
                'errorCode',
                'errorMessage',
                'logPath',
              ]
              const rows = state.results
                .slice()
                .sort((a, b) => a.index - b.index)
                .map((item) => [
                  item.index,
                  ...paramNames.map((name) => item.params?.[name] ?? ''),
                  item.status,
                  item.outputPath ?? '',
                  item.outputExists ?? false,
                  item.outputSizeBytes ?? '',
                  item.durationMs ?? '',
                  item.error?.code ?? '',
                  item.error?.message ?? '',
                  item.logPath ?? '',
                ])
              writeCsvFile(path.join(jobRecord.jobDir, 'sweep_summary.csv'), header, rows)
              writeCsvFile(path.join(outputDir, `sweep_summary_${jobRecord.id}.csv`), header, rows)
              const stable = path.join(outputDir, 'sweep_summary.csv')
              if (args.overwrite || !fs.existsSync(stable)) {
                writeCsvFile(stable, header, rows)
                return stable
              }
              return path.join(jobRecord.jobDir, 'sweep_summary.csv')
            }

            const base = safeFilename(info.path)
            for (let index = 0; index < combos.length; index += 1) {
              if (signal.aborted) break
              if (previousCompleted.has(index)) continue
              const combo = combos[index]
              const comboOutput = path.join(outputDir, `${base}__${comboLabel(combo)}.mph`)
              if (!args.overwrite && fs.existsSync(comboOutput)) {
                const existsEntry = {
                  index,
                  params: combo,
                  status: 'failed',
                  outputPath: comboOutput,
                  outputExists: true,
                  outputSizeBytes: fs.statSync(comboOutput).size,
                  durationMs: 0,
                  logPath: null,
                  error: {
                    code: 'OUTPUT_EXISTS',
                    message: `Combination output already exists: ${comboOutput}. Pass overwrite=true to replace it.`,
                  },
                }
                state.results = state.results.filter((item) => item.index !== index).concat(existsEntry).sort((a, b) => a.index - b.index)
                persist()
                logLine(`combination ${index + 1}/${combos.length} OUTPUT_EXISTS ${JSON.stringify(combo)} ${comboOutput}`)
                if (args.stopOnError !== false) {
                  const summaryCsv = writeSummary()
                  return {
                    ok: false,
                    status: 'failed',
                    result: {
                      modelPath: info.path,
                      outputDir,
                      combinations: combos.length,
                      completed: state.results.filter((item) => item.status === 'succeeded').length,
                      failed: state.results.filter((item) => item.status !== 'succeeded').length,
                      stoppedAt: index,
                      results: state.results,
                      stateFile,
                      summaryCsv,
                    },
                    error: existsEntry.error,
                  }
                }
                continue
              }
              setProgress('sweep', `Combination ${index + 1}/${combos.length}: ${JSON.stringify(combo)}`)
              const run = await driver.runAction({
                action: 'run',
                payload: {
                  modelPath: info.path,
                  outputPath: comboOutput,
                  study: args.study,
                  params: combo,
                  solve: true,
                },
                jobDir: path.join(jobRecord.jobDir, 'runs', String(index + 1).padStart(4, '0')),
                jobId: `${jobRecord.id}-${index + 1}`,
                timeoutMs,
                signal,
              })
              const entry = {
                index,
                params: combo,
                status: run.ok ? 'succeeded' : run.status,
                outputPath: comboOutput,
                outputExists: fs.existsSync(comboOutput),
                outputSizeBytes: fs.existsSync(comboOutput) ? fs.statSync(comboOutput).size : 0,
                durationMs: run.durationMs,
                logPath: run.logPath,
                error: run.ok ? null : run.error,
              }
              state.results = state.results.filter((item) => item.index !== index).concat(entry).sort((a, b) => a.index - b.index)
              persist()
              logLine(`combination ${index + 1}/${combos.length} ${entry.status} ${JSON.stringify(combo)} ${entry.durationMs}ms output=${entry.outputPath}`)
              if (!run.ok && args.stopOnError !== false) {
                const summaryCsv = writeSummary()
                return {
                  ok: false,
                  status: 'failed',
                  result: {
                    modelPath: info.path,
                    outputDir,
                    combinations: combos.length,
                    completed: state.results.filter((item) => item.status === 'succeeded').length,
                    failed: state.results.filter((item) => item.status !== 'succeeded').length,
                    stoppedAt: index,
                    results: state.results,
                    stateFile,
                    summaryCsv,
                  },
                  error: run.error ?? { code: 'SWEEP_COMBINATION_FAILED', message: `Combination ${index + 1} failed` },
                }
              }
            }

            const succeeded = state.results.filter((item) => item.status === 'succeeded').length
            const failed = state.results.filter((item) => item.status !== 'succeeded').length
            logLine(`sweep finished: succeeded=${succeeded} failed=${failed} total=${combos.length}`)
            const summaryCsv = writeSummary()
            return {
              ok: failed === 0 && succeeded === combos.length,
              status: failed === 0 && succeeded === combos.length ? 'succeeded' : 'failed',
              result: {
                modelPath: info.path,
                outputDir,
                combinations: combos.length,
                succeeded,
                failed,
                results: state.results,
                stateFile,
                summaryCsv,
              },
              error:
                failed === 0 && succeeded === combos.length
                  ? null
                  : { code: 'SWEEP_INCOMPLETE', message: `${failed} of ${combos.length} combinations did not succeed` },
            }
          },
        })
        const summary = args.wait ? await maybeWait(record, true, timeoutMs * Math.max(1, combos.length)) : jobs.summarize(record)
        return {
          ok: args.wait ? summary.status === 'succeeded' : true,
          accepted: true,
          jobId: record.id,
          status: summary.status ?? record.status,
          outputDir,
          combinations: combos.length,
          summaryCsv: summary.result?.summaryCsv ?? null,
          ...summary,
        }
      },
    ),
  )

  // ---------------------------------------------------------------- job status
  tools.push(
    makeTool(
      'comsol_get_job_status',
      '查询任务状态、进度、耗时和日志路径；省略 jobId 时列出最近任务。',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: stringSchema('Job id returned by a run/sweep/create tool.'),
          limit: numberSchema('Maximum number of recent jobs when jobId is omitted.', { minimum: 1, maximum: 100, default: 20 }),
        },
      },
      async (args = {}) => {
        if (args.jobId) {
          const record = jobs.get(args.jobId)
          if (!record) fail('JOB_NOT_FOUND', `Unknown job: ${args.jobId}`)
          let logTail = null
          try {
            if (fs.existsSync(record.logPath)) {
              const text = fs.readFileSync(record.logPath, 'utf8')
              logTail = text.split(/\r?\n/).slice(-25).join('\n')
            }
          } catch {
            // ignore
          }
          return { ok: true, job: jobs.summarize(record), logTail }
        }
        return {
          ok: true,
          jobs: jobs.list(args.limit ?? 20).map((record) => jobs.summarize(record)),
        }
      },
    ),
  )

  // ---------------------------------------------------------------- read log
  tools.push(
    makeTool(
      'comsol_read_log',
      '读取任务日志，按许可、网格、收敛、几何、材料、文件等类别给出诊断和置信度。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['jobId'],
        properties: {
          jobId: stringSchema('Job id whose log should be analysed.'),
          maxBytes: numberSchema('Maximum log bytes to read from the end of the file.', {
            minimum: 1024,
            maximum: 20 * 1024 * 1024,
            default: 2 * 1024 * 1024,
          }),
        },
      },
      async (args = {}) => {
        const record = jobs.get(args.jobId)
        if (!record) fail('JOB_NOT_FOUND', `Unknown job: ${args.jobId}`)
        if (!fs.existsSync(record.logPath)) fail('LOG_NOT_FOUND', `No log file for job ${args.jobId}: ${record.logPath}`)
        const maxBytes = ensureFiniteNumber(args.maxBytes, 'maxBytes', { min: 1024, max: 20 * 1024 * 1024, fallback: 2 * 1024 * 1024 })
        const stat = fs.statSync(record.logPath)
        const start = Math.max(0, stat.size - maxBytes)
        const buffer = Buffer.alloc(stat.size - start)
        const fd = fs.openSync(record.logPath, 'r')
        try {
          fs.readSync(fd, buffer, 0, buffer.length, start)
        } finally {
          fs.closeSync(fd)
        }
        const analysis = analyzeLog(decodeBuffer(buffer), record)
        return {
          ok: true,
          job: jobs.summarize(record),
          logPath: record.logPath,
          readBytes: buffer.length,
          totalBytes: stat.size,
          analysis,
        }
      },
    ),
  )

  // ---------------------------------------------------------------- export
  tools.push(
    makeTool(
      'comsol_export_results',
      '从已求解模型导出 S 参数、表格、点/线数据、积分和 PNG。变量或端口不存在时会报错，不会假设它们存在。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['modelPath'],
        properties: {
          modelPath: stringSchema('Absolute path to a solved .mph model.'),
          outputDir: stringSchema('Absolute output directory inside the workspace. Defaults to exports/<name>__<timestamp>.'),
          overwrite: booleanSchema('Allow replacing existing export files. Default false.', false),
          sParameters: booleanSchema('Export all port S-parameters found in the model to CSV.', false),
          tableExpressions: stringArraySchema('Global expressions to export as a numeric CSV table, for example ["ewfd.S11", "ewfd.normE"].'),
          fieldImages: {
            type: 'array',
            description: 'Field images to render as PNG.',
            items: {
              type: 'object',
              required: ['expr'],
              additionalProperties: false,
              properties: {
                expr: stringSchema('Field expression, for example ewfd.normE.'),
                filename: stringSchema('Output PNG filename.'),
                title: stringSchema('Optional plot title.'),
              },
            },
          },
          lines: {
            type: 'array',
            description: 'Sample field values along a straight line.',
            items: {
              type: 'object',
              required: ['exprs', 'start', 'end'],
              additionalProperties: false,
              properties: {
                exprs: stringArraySchema('Expressions to sample.'),
                start: { type: 'array', items: { type: 'number' }, description: 'Start coordinates, e.g. [r,z] or [x,y,z].' },
                end: { type: 'array', items: { type: 'number' }, description: 'End coordinates.' },
                points: numberSchema('Number of sample points.', { minimum: 2, maximum: 10000, default: 100 }),
                filename: stringSchema('Output CSV filename.'),
              },
            },
          },
          samples: {
            type: 'array',
            description: 'Sample field values at explicit coordinates.',
            items: {
              type: 'object',
              required: ['exprs', 'coordinates'],
              additionalProperties: false,
              properties: {
                exprs: stringArraySchema('Expressions to sample.'),
                coordinates: coordinatesSchema,
                filename: stringSchema('Output CSV filename.'),
              },
            },
          },
          integrals: {
            type: 'array',
            description: 'Integral/max/min/average evaluations exported as CSV.',
            items: {
              type: 'object',
              required: ['exprs'],
              additionalProperties: false,
              properties: {
                exprs: stringArraySchema('Expressions to evaluate.'),
                evalKind: {
                  type: 'string',
                  enum: ['volume_integral', 'surface_integral', 'maximum', 'minimum', 'average'],
                  default: 'volume_integral',
                },
                selection: selectionSchema,
                dataset: stringSchema('Optional dataset tag.'),
                filename: stringSchema('Output CSV filename.'),
              },
            },
          },
          timeoutSec: numberSchema('Timeout in seconds.', { minimum: 10, maximum: 3600, default: 600 }),
        },
      },
      async (args = {}) => {
        const info = assertMphPath(args.modelPath)
        const outputDir = assertInsideRoots(
          args.outputDir ? path.resolve(args.outputDir) : path.join(config.exportsDir, `${safeFilename(info.path)}__${timestampCompact()}`),
          config.allowedRoots,
          'export outputDir',
        )
        ensureDir(outputDir)
        const items = []
        if (args.sParameters) items.push({ kind: 'sparameters', outputDir, filename: 's_parameters.csv' })
        if (Array.isArray(args.tableExpressions) && args.tableExpressions.length > 0) {
          items.push({ kind: 'table', outputDir, filename: 'table.csv', exprs: args.tableExpressions })
        }
        for (const [index, image] of (args.fieldImages ?? []).entries()) {
          if (!image?.expr) fail('INVALID_EXPORT_ITEM', `fieldImages[${index}] needs an expr`)
          items.push({
            kind: 'image',
            outputDir,
            expr: image.expr,
            filename: safeExportFilename(image.filename, `field_${index + 1}.png`),
            title: image.title,
          })
        }
        for (const [index, line] of (args.lines ?? []).entries()) {
          if (!Array.isArray(line?.exprs) || !line.exprs.length) fail('INVALID_EXPORT_ITEM', `lines[${index}] needs exprs`)
          items.push({
            kind: 'line',
            outputDir,
            exprs: line.exprs,
            start: line.start,
            end: line.end,
            points: line.points ?? 100,
            filename: safeExportFilename(line.filename, `line_${index + 1}.csv`),
          })
        }
        for (const [index, sample] of (args.samples ?? []).entries()) {
          if (!Array.isArray(sample?.exprs) || !sample.exprs.length) fail('INVALID_EXPORT_ITEM', `samples[${index}] needs exprs`)
          items.push({
            kind: 'samples',
            outputDir,
            exprs: sample.exprs,
            coordinates: sample.coordinates,
            filename: safeExportFilename(sample.filename, `samples_${index + 1}.csv`),
          })
        }
        for (const [index, integral] of (args.integrals ?? []).entries()) {
          if (!Array.isArray(integral?.exprs) || !integral.exprs.length) fail('INVALID_EXPORT_ITEM', `integrals[${index}] needs exprs`)
          items.push({
            kind: 'integral',
            outputDir,
            exprs: integral.exprs,
            evalKind: integral.evalKind ?? 'volume_integral',
            selection: integral.selection,
            dataset: integral.dataset,
            filename: safeExportFilename(integral.filename, `integral_${index + 1}.csv`),
          })
        }
        if (items.length === 0) fail('NO_EXPORT_ITEMS', 'At least one export item is required.')
        const duplicates = items
          .map((item) => item.filename)
          .filter((filename, index, all) => all.indexOf(filename) !== index)
        if (duplicates.length > 0) {
          fail('DUPLICATE_FILENAME', `Duplicate export filenames: ${[...new Set(duplicates)].join(', ')}`)
        }
        if (!args.overwrite) {
          const collisions = items
            .map((item) => path.join(outputDir, item.filename))
            .filter((target) => fs.existsSync(target))
          if (collisions.length > 0) {
            fail('OUTPUT_EXISTS', `Export target(s) already exist: ${collisions.join(', ')}. Pass overwrite=true to replace them.`, {
              collisions,
            })
          }
        }

        const timeoutMs = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 3600, fallback: 600 }) * 1000
        const record = await runDriverSync({
          kind: 'export_results',
          title: `Export results from ${path.basename(info.path)}`,
          input: { modelPath: info.path, outputDir, items },
          action: 'export',
          payload: { modelPath: info.path, items },
          timeoutMs,
        })
        const result = record.result ?? {}
        const exported = Array.isArray(result.items) ? result.items : []
        const fileChecks = exported.map((item) => {
          const exists = item.path ? fs.existsSync(item.path) : false
          return {
            index: item.index,
            kind: item.kind,
            path: item.path ?? null,
            exists,
            sizeBytes: exists ? fs.statSync(item.path).size : 0,
            rows: item.rows ?? null,
            ok: Boolean(item.ok && exists),
            error: item.error ?? null,
          }
        })
        const ok = record.status === 'succeeded' && fileChecks.every((item) => item.ok)
        return {
          ok,
          status: record.status,
          jobId: record.id,
          logPath: record.logPath,
          modelPath: info.path,
          outputDir,
          items: exported,
          fileChecks,
          error: record.error,
        }
      },
    ),
  )

  // ---------------------------------------------------------------- evaluate
  tools.push(
    makeTool(
      'comsol_evaluate_results',
      '评估全局量、体积/面积分、最大/最小/平均、点/线插值，返回数值和单位。uniformity=true 时按 U=1-(max-min)/(max+min) 计算并标注公式。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['modelPath', 'expressions'],
        properties: {
          modelPath: stringSchema('Absolute path to a solved .mph model.'),
          expressions: stringArraySchema('Expressions to evaluate, for example ["ewfd.normE", "ewfd.S11"].'),
          kind: {
            type: 'string',
            description:
              'Evaluation kind: global (no selection), volume_integral / average / maximum / minimum on domains, surface_integral on boundaries, point or line via interpolation.',
            enum: [
              'global',
              'volume_integral',
              'surface_integral',
              'average',
              'maximum',
              'minimum',
              'point',
              'line',
            ],
            default: 'global',
          },
          selection: selectionSchema,
          dataset: stringSchema('Optional dataset tag. Defaults to the first solution dataset.'),
          coordinates: coordinatesSchema,
          start: { type: 'array', items: { type: 'number' }, description: 'Line start coordinates.' },
          end: { type: 'array', items: { type: 'number' }, description: 'Line end coordinates.' },
          points: numberSchema('Number of points for line evaluation.', { minimum: 2, maximum: 10000, default: 100 }),
          uniformity: booleanSchema(
            'If true, also evaluate max/min/average and compute U = 1 - (max-min)/(max+min). The formula is returned explicitly.',
            false,
          ),
          timeoutSec: numberSchema('Timeout in seconds.', { minimum: 10, maximum: 3600, default: 600 }),
        },
      },
      async (args = {}) => {
        const info = assertMphPath(args.modelPath)
        if (!Array.isArray(args.expressions) || args.expressions.length === 0) {
          fail('MISSING_EXPRESSIONS', 'expressions must be a non-empty string array')
        }
        const kind = args.kind ?? 'global'
        const base = { exprs: args.expressions, dataset: args.dataset }
        if (kind === 'point' || kind === 'line') {
          if (kind === 'point' && (!Array.isArray(args.coordinates) || args.coordinates.length === 0)) {
            fail('MISSING_COORDINATES', 'point evaluation requires coordinates')
          }
          if (kind === 'line' && (!Array.isArray(args.start) || !Array.isArray(args.end))) {
            fail('MISSING_LINE', 'line evaluation requires start and end coordinate arrays')
          }
        }
        const requests = []
        if (args.uniformity) {
          const selection = args.selection
          requests.push(
            { ...base, kind: 'maximum', selection },
            { ...base, kind: 'minimum', selection },
            { ...base, kind: 'average', selection },
          )
        } else {
          requests.push({
            ...base,
            kind,
            selection: args.selection,
            coordinates: kind === 'point' ? args.coordinates : undefined,
            start: kind === 'line' ? args.start : undefined,
            end: kind === 'line' ? args.end : undefined,
            points: kind === 'line' ? args.points ?? 100 : undefined,
          })
        }
        const timeoutMs = ensureFiniteNumber(args.timeoutSec, 'timeoutSec', { min: 10, max: 3600, fallback: 600 }) * 1000
        const record = await runDriverSync({
          kind: 'evaluate_results',
          title: `Evaluate ${args.expressions.join(', ')}`,
          input: { modelPath: info.path, kind, expressions: args.expressions },
          action: 'evaluate',
          payload: { modelPath: info.path, requests },
          timeoutMs,
        })
        const result = record.result ?? {}
        const evaluations = Array.isArray(result.results) ? result.results : []
        let uniformity = null
        if (args.uniformity) {
          const byKind = Object.fromEntries(evaluations.map((item) => [item.kind, item]))
          uniformity = args.expressions.map((expr, index) => {
            const max = byKind.maximum?.values?.[index]?.real?.[0]?.[0]
            const min = byKind.minimum?.values?.[index]?.real?.[0]?.[0]
            const avg = byKind.average?.values?.[index]?.real?.[0]?.[0]
            let value = null
            if (Number.isFinite(max) && Number.isFinite(min) && Math.abs(max + min) > 0) {
              value = 1 - (max - min) / (max + min)
            }
            return {
              expr,
              maximum: max,
              minimum: min,
              average: avg,
              uniformity: value,
              formula: 'U = 1 - (max - min) / (max + min)',
              applicability:
                'Only meaningful for a non-negative field on the selected domain/boundary and when max+min is non-zero. The formula is user-requested, not a COMSOL standard quantity.',
            }
          })
        }
        const ok = record.status === 'succeeded' && evaluations.every((item) => item.ok !== false)
        return {
          ok,
          status: record.status,
          jobId: record.id,
          logPath: record.logPath,
          modelPath: info.path,
          dataset: args.dataset ?? null,
          dataSource: 'COMSOL numerical evaluation on the model solution dataset',
          evaluations,
          uniformity,
          error: record.error,
          uncertainty:
            'Expressions must exist in the model. Units come from COMSOL; a successful evaluation does not validate the physics.',
        }
      },
    ),
  )

  // ---------------------------------------------------------------- cancel
  tools.push(
    makeTool(
      'comsol_cancel_job',
      '取消排队或运行中的任务，运行中的 COMSOL 进程会被终止。',
      {
        type: 'object',
        additionalProperties: false,
        required: ['jobId'],
        properties: {
          jobId: stringSchema('Job id to cancel.'),
          reason: stringSchema('Optional cancellation reason recorded in the job record.'),
        },
      },
      async (args = {}) => {
        const result = jobs.cancel(args.jobId)
        if (result.ok && args.reason) {
          const record = jobs.get(args.jobId)
          if (record) {
            record.cancelReason = args.reason
            jobs._persist(record)
          }
        }
        return result
      },
    ),
  )

  // ---------------------------------------------------------------- batch helper
  async function runComsolBatch({
    jobRecord,
    modelPath,
    outputPath,
    study,
    params,
    solve,
    timeoutMs,
    signal,
    setProgress,
  }) {
    if (!config.comsolHome) fail('COMSOL_NOT_FOUND', 'COMSOL home is not resolved.')
    const exe = path.join(config.comsolHome, 'bin', 'win64', 'comsolbatch.exe')
    if (!fs.existsSync(exe)) fail('COMSOL_BATCH_MISSING', `comsolbatch.exe not found: ${exe}`)
    ensureDir(path.dirname(outputPath))
    const batchLog = path.join(jobRecord.jobDir, 'comsolbatch.log')
    const args = ['-inputfile', modelPath, '-outputfile', outputPath, '-batchlog', batchLog, '-batchlogout']
    if (study) args.push('-study', study)
    if (solve === false) args.push('-norun')
    if (params && Object.keys(params).length > 0) {
      const names = Object.keys(params)
      const values = names.map((name) => params[name])
      if (values.some((value) => String(value).includes(','))) {
        fail('INVALID_BATCH_PARAMETER', 'comsolbatch -plist cannot represent values containing commas; use engine="java".')
      }
      args.push('-pname', names.join(','), '-plist', values.join(','))
    }
    const seconds = Math.max(10, Math.ceil(timeoutMs / 1000))
    args.push('-stoptime', String(seconds))
    setProgress('running', 'Running comsolbatch')
    const startedAt = Date.now()
    const handle = startProcess(exe, args, {
      cwd: jobRecord.jobDir,
      timeoutMs: timeoutMs + 60_000,
      onStdout: (text) => fs.appendFileSync(jobRecord.logPath, text, 'utf8'),
      onStderr: (text) => fs.appendFileSync(jobRecord.logPath, text, 'utf8'),
    })
    if (signal) {
      if (signal.aborted) handle.kill('cancelled')
      else signal.addEventListener('abort', () => handle.kill('cancelled'), { once: true })
    }
    const processResult = await handle.promise
    if (fs.existsSync(batchLog)) {
      try {
        fs.appendFileSync(jobRecord.logPath, `\n# comsolbatch log\n${fs.readFileSync(batchLog, 'utf8')}\n`, 'utf8')
      } catch {
        // ignore
      }
    }
    const candidates = []
    if (fs.existsSync(outputPath)) candidates.push(outputPath)
    try {
      const dir = path.dirname(outputPath)
      const stem = path.basename(outputPath).replace(/\.mph$/i, '')
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.mph$/i.test(entry.name)) continue
        if (!entry.name.startsWith(stem)) continue
        const full = path.join(dir, entry.name)
        const stat = fs.statSync(full)
        if (stat.mtimeMs >= startedAt - 5000) candidates.push(full)
      }
    } catch {
      // ignore
    }
    const unique = [...new Set(candidates)]
    const actualOutput = unique.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
    const logText = fs.existsSync(jobRecord.logPath) ? fs.readFileSync(jobRecord.logPath, 'utf8') : ''
    const analysis = analyzeLog(logText, jobRecord)
    const fatal = analysis.categories.find((category) => ['preview_model', 'license', 'memory', 'file_access'].includes(category.id))
    const ok = Boolean(actualOutput) && fs.statSync(actualOutput).size > 0 && !fatal && !processResult.timedOut
    return {
      ok,
      status: processResult.timedOut ? 'timeout' : ok ? 'succeeded' : 'failed',
      result: {
        engine: 'batch',
        outputPath,
        actualOutputPath: actualOutput,
        outputExists: Boolean(actualOutput),
        outputSizeBytes: actualOutput ? fs.statSync(actualOutput).size : 0,
        exitCode: processResult.code,
        durationMs: processResult.durationMs,
        command: { executable: exe, args },
        logAnalysis: analysis,
        executionEvidence: {
          processStarted: processResult.code !== null || processResult.timedOut || processResult.cancelled,
          modelLoaded: null,
          solveRequested: solve !== false,
          solveCompleted: ok && solve !== false,
          outputWritten: Boolean(actualOutput) && actualOutput ? fs.statSync(actualOutput).size > 0 : false,
          exitCode: processResult.code,
          timedOut: processResult.timedOut,
          cancelled: processResult.cancelled,
          note: 'comsolbatch writes model loading and solving into a combined log; modelLoaded is not separately observable for this engine.',
        },
      },
      error: ok
        ? null
        : fatal
          ? { code: 'BATCH_FATAL_LOG', message: `comsolbatch log contains a likely fatal issue: ${fatal.label}` }
          : { code: 'BATCH_INCOMPLETE', message: 'comsolbatch did not produce a verifiable output .mph file.' },
    }
  }

  return {
    tools,
    dispose: () => jobs.dispose(),
  }
}
