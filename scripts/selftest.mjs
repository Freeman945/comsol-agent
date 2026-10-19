import fs from 'node:fs'
import path from 'node:path'
import { createPlugin } from '../lib/plugin.js'

const workspaceRoot = process.env.COMSOL_AGENT_TEST_WORKSPACE ?? 'D:/comsol-p/selftest-workspace'
const comsolHome = process.env.COMSOL_HOME ?? 'D:/COMSOL62/Multiphysics'

const plugin = createPlugin(null, {
  workspaceRoot,
  comsolHome,
  maxConcurrentJobs: 1,
  maxSweepCombinations: 6,
  defaultTimeoutSec: 600,
})

const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]))
const results = []

function record(name, status, detail, durationMs) {
  results.push({ name, status, detail, durationMs })
  const icon = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP'
  console.log(`[${icon}] ${name} (${Math.round(durationMs)} ms)`)
  if (detail && status !== 'PASS') console.log(`       ${String(detail).replace(/\n/g, '\n       ').slice(0, 1200)}`)
}

async function call(name, args) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`Tool not registered: ${name}`)
  return tool.execute(args, {})
}

async function step(name, fn) {
  const start = Date.now()
  try {
    const value = await fn()
    record(name, value?.ok === false ? 'FAIL' : 'PASS', value?.ok === false ? JSON.stringify(value).slice(0, 1200) : '', Date.now() - start)
    return value
  } catch (error) {
    record(name, 'FAIL', String(error?.stack ?? error), Date.now() - start)
    return null
  }
}

async function main() {
  console.log(`workspace=${workspaceRoot}`)
  console.log(`comsolHome=${comsolHome}`)
  console.log(`tools=${[...tools.keys()].join(', ')}`)

  await step('comsol_check_environment', () => call('comsol_check_environment', {}))
  await step('comsol_check_environment(deep)', () => call('comsol_check_environment', { deep: true }))

  const created = await step('comsol_create_model(rf_coax_air, solve)', () =>
    call('comsol_create_model', {
      template: 'rf_coax_air',
      name: 'selftest_coax',
      solve: true,
      meshSize: 5,
      overwrite: true,
      timeoutSec: 600,
    }),
  )
  const modelPath = created?.outputPath
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.log('Cannot continue without a model.')
    finish()
  }

  await step('comsol_validate_model', () => call('comsol_validate_model', { modelPath }))

  await step('comsol_evaluate_results(global S11)', () =>
    call('comsol_evaluate_results', {
      modelPath,
      expressions: ['ewfd.S11'],
      kind: 'global',
    }),
  )

  await step('comsol_evaluate_results(volume integral)', () =>
    call('comsol_evaluate_results', {
      modelPath,
      expressions: ['ewfd.normE'],
      kind: 'volume_integral',
      selection: [1],
    }),
  )

  await step('comsol_evaluate_results(line)', () =>
    call('comsol_evaluate_results', {
      modelPath,
      expressions: ['ewfd.normE'],
      kind: 'line',
      start: [4.5, 10],
      end: [9.0, 10],
      points: 11,
    }),
  )

  const modified = await step('comsol_set_parameters', () =>
    call('comsol_set_parameters', {
      modelPath,
      params: { freq: '2.40[GHz]', z_feed: '18' },
      timeoutSec: 300,
    }),
  )

  if (modified?.outputPath) {
    await step('comsol_run_model(java, wait)', () =>
      call('comsol_run_model', {
        modelPath: modified.outputPath,
        solve: true,
        study: 'std1',
        wait: true,
        timeoutSec: 300,
      }),
    )
  }

  await step('comsol_export_results', () =>
    call('comsol_export_results', {
      modelPath,
      sParameters: true,
      tableExpressions: ['ewfd.S11'],
      fieldImages: [{ expr: 'ewfd.normE', filename: 'selftest_field.png' }],
      lines: [{ exprs: ['ewfd.normE'], start: [4.5, 10], end: [9, 10], points: 12, filename: 'selftest_line.csv' }],
      integrals: [{ exprs: ['ewfd.normE'], evalKind: 'volume_integral', selection: [1], filename: 'selftest_integral.csv' }],
      timeoutSec: 300,
    }),
  )

  const sweep = await step('comsol_parameter_sweep(2 combos, wait)', () =>
    call('comsol_parameter_sweep', {
      modelPath,
      parameters: { freq: ['2.40[GHz]', '2.50[GHz]'] },
      study: 'std1',
      wait: true,
      confirm: true,
      stopOnError: true,
      timeoutSec: 300,
    }),
  )

  const jobId = sweep?.jobId ?? created?.jobId
  if (jobId) {
    await step('comsol_get_job_status', () => call('comsol_get_job_status', { jobId }))
    await step('comsol_read_log', () => call('comsol_read_log', { jobId }))
  }

  console.log('\n==== SUMMARY ====')
  finish()
}

function finish() {
  const passed = results.filter((r) => r.status === 'PASS').length
  const failed = results.filter((r) => r.status === 'FAIL').length
  console.log(JSON.stringify({ passed, failed, results }, null, 2))
  plugin.dispose()
  process.exit(failed > 0 || passed === 0 ? 1 : 0)
}

await main()
