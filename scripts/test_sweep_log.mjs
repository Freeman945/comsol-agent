import { createPlugin } from '../lib/plugin.js'

const plugin = createPlugin(null, {
  workspaceRoot: 'D:/comsol-p/selftest-workspace',
  comsolHome: 'D:/COMSOL62/Multiphysics',
  maxConcurrentJobs: 1,
})
const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]))
const modelPath = 'D:/comsol-p/selftest-workspace/models/selftest_coax.mph'

const sweep = await tools.get('comsol_parameter_sweep').execute(
  {
    modelPath,
    parameters: { freq: ['2.35[GHz]', '2.45[GHz]'] },
    study: 'std1',
    wait: true,
    confirm: true,
    timeoutSec: 300,
  },
  {},
)
console.log('SWEEP', JSON.stringify({
  ok: sweep.ok,
  status: sweep.status,
  jobId: sweep.jobId,
  result: sweep.result ? {
    combinations: sweep.result.combinations,
    succeeded: sweep.result.succeeded,
    failed: sweep.result.failed,
  } : null,
}, null, 2))

const log = await tools.get('comsol_read_log').execute({ jobId: sweep.jobId }, {})
console.log('READ_LOG', JSON.stringify({
  ok: log.ok,
  status: log.analysis.status,
  lineCount: log.analysis.lineCount,
  categories: log.analysis.categories.map((c) => c.id),
  conclusion: log.analysis.conclusion,
}, null, 2))

plugin.dispose()
process.exit(0)
