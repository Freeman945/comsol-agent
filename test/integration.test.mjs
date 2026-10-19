import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createPlugin } from '../lib/plugin.js'

const enabled = process.env.COMSOL_AGENT_INTEGRATION === '1'
const comsolHome = process.env.COMSOL_HOME ?? 'D:/COMSOL62/Multiphysics'

test(
  'real COMSOL: create, validate, evaluate, modify, run, export and sweep',
  { skip: !enabled, timeout: 15 * 60 * 1000 },
  async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comsol-agent-integration-'))
    const plugin = createPlugin(null, {
      workspaceRoot,
      comsolHome,
      maxConcurrentJobs: 1,
      maxSweepCombinations: 6,
      defaultTimeoutSec: 600,
    })
    const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]))
    const call = (name, args) => tools.get(name).execute(args, {})

    try {
      const environment = await call('comsol_check_environment', {})
      assert.equal(environment.ok, true)
      assert.equal(environment.comsol.found, true)
      assert.ok(environment.comsol.version)

      const created = await call('comsol_create_model', {
        template: 'rf_coax_air',
        name: 'integration_coax',
        solve: true,
        meshSize: 5,
        timeoutSec: 600,
      })
      assert.equal(created.ok, true)
      assert.ok(fs.existsSync(created.outputPath))
      const modelPath = created.outputPath

      const validated = await call('comsol_validate_model', { modelPath })
      assert.equal(validated.ok, true)
      assert.equal(validated.modelOpen.ok, true)
      assert.ok(validated.modelOpen.model.physics.length > 0)

      const s11 = await call('comsol_evaluate_results', {
        modelPath,
        expressions: ['ewfd.S11'],
        kind: 'global',
      })
      assert.equal(s11.ok, true)
      const s11Value = s11.evaluations[0].values[0].real[0][0]
      assert.ok(Number.isFinite(s11Value))

      const modified = await call('comsol_set_parameters', {
        modelPath,
        params: { freq: '2.40[GHz]' },
        timeoutSec: 300,
      })
      assert.equal(modified.ok, true)
      assert.equal(modified.allVerified, true)
      assert.ok(fs.existsSync(modified.outputPath))

      const run = await call('comsol_run_model', {
        modelPath: modified.outputPath,
        study: 'std1',
        solve: true,
        wait: true,
        timeoutSec: 300,
      })
      assert.equal(run.ok, true)
      assert.equal(run.status, 'succeeded')
      assert.ok(fs.existsSync(run.outputPath))

      const exported = await call('comsol_export_results', {
        modelPath,
        sParameters: true,
        tableExpressions: ['ewfd.S11'],
        fieldImages: [{ expr: 'ewfd.normE', filename: 'integration_field.png' }],
        lines: [{ exprs: ['ewfd.normE'], start: [4.5, 10], end: [9, 10], points: 10, filename: 'integration_line.csv' }],
        integrals: [{ exprs: ['ewfd.normE'], evalKind: 'volume_integral', selection: [1], filename: 'integration_integral.csv' }],
        timeoutSec: 300,
      })
      assert.equal(exported.ok, true)
      for (const item of exported.fileChecks) {
        assert.equal(item.ok, true, `${item.kind} export failed: ${JSON.stringify(item.error)}`)
        assert.ok(fs.existsSync(item.path))
        assert.ok(fs.statSync(item.path).size > 0)
      }

      const sweep = await call('comsol_parameter_sweep', {
        modelPath,
        parameters: { freq: ['2.40[GHz]', '2.50[GHz]'] },
        study: 'std1',
        confirm: true,
        wait: true,
        timeoutSec: 300,
      })
      assert.equal(sweep.ok, true)
      assert.equal(sweep.status, 'succeeded')
      assert.equal(sweep.result.succeeded, 2)
      assert.equal(sweep.result.failed, 0)
      for (const item of sweep.result.results) {
        assert.equal(item.status, 'succeeded')
        assert.ok(fs.existsSync(item.outputPath))
      }

      const log = await call('comsol_read_log', { jobId: sweep.jobId })
      assert.equal(log.ok, true)
      assert.equal(typeof log.analysis.conclusion, 'string')
      assert.ok(log.analysis.lineCount > 0)

      console.log(`integration evidence: model=${modelPath}`)
      console.log(`integration evidence: S11(2.45GHz)=${s11Value}`)
      console.log(`integration evidence: sweep=${sweep.result.succeeded}/${sweep.result.combinations}`)
    } finally {
      plugin.dispose()
    }
  },
)
