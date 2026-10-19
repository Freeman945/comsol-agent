import { createPlugin } from '../lib/plugin.js'

const plugin = createPlugin(null, {
  workspaceRoot: 'D:/comsol-p/selftest-workspace',
  comsolHome: 'D:/COMSOL62/Multiphysics',
  maxConcurrentJobs: 1,
})
const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]))
const call = (name, args) => tools.get(name).execute(args, {})
const modelPath = 'D:/comsol-p/selftest-workspace/models/selftest_coax.mph'

const started = await call('comsol_run_model', { modelPath, solve: true, wait: false, timeoutSec: 300 })
console.log('ASYNC_START', JSON.stringify(started, null, 2).slice(0, 800))
const cancelled = await call('comsol_cancel_job', { jobId: started.jobId, reason: 'self-test cancellation' })
console.log('CANCEL', JSON.stringify(cancelled, null, 2).slice(0, 800))
await new Promise((resolve) => setTimeout(resolve, 3000))
const afterCancel = await call('comsol_get_job_status', { jobId: started.jobId })
console.log('AFTER_CANCEL_STATUS', afterCancel.job.status, afterCancel.job.error?.code)

const badStudy = await call('comsol_run_model', { modelPath, study: 'does_not_exist', wait: true, timeoutSec: 120 })
console.log('BAD_STUDY', JSON.stringify({ ok: badStudy.ok, status: badStudy.status, error: badStudy.error }, null, 2).slice(0, 1200))
if (badStudy.jobId) {
  const log = await call('comsol_read_log', { jobId: badStudy.jobId })
  console.log('BAD_STUDY_LOG', JSON.stringify({
    status: log.analysis.status,
    categories: log.analysis.categories.map((c) => ({ id: c.id, count: c.count, confidence: c.confidence })),
    conclusion: log.analysis.conclusion,
  }, null, 2))
}

const timeoutRun = await call('comsol_create_model', {
  template: 'rf_coax_air',
  name: 'timeout_probe',
  solve: true,
  timeoutSec: 10,
  overwrite: true,
})
console.log('TIMEOUT_PROBE', JSON.stringify({ ok: timeoutRun.ok, status: timeoutRun.status, error: timeoutRun.error }, null, 2).slice(0, 1200))

plugin.dispose()
process.exit(0)
