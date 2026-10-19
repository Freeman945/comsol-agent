import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, detectComsolHomes, PLUGIN_NAME } from '../lib/config.js'
import { analyzeLog } from '../lib/logs.js'
import { decodeBuffer } from '../lib/decode.js'
import { normalizeParams } from '../lib/schema.js'
import { safeFilename, isSubPath, assertInsideRoots } from '../lib/paths.js'

test('loadConfig creates an isolated workspace and honours explicit roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comsol-agent-unit-'))
  const config = loadConfig({
    workspaceRoot: root,
    comsolHome: 'D:/definitely/not/a/comsol/install',
    allowedRoots: [path.join(root, 'extra')],
    maxConcurrentJobs: 1,
  })
  assert.equal(config.workspaceRoot, path.resolve(root))
  assert.equal(config.comsolHome, null, 'a non-COMSOL home must not be accepted')
  assert.ok(config.allowedRoots.includes(path.resolve(root)))
  assert.ok(fs.existsSync(config.jobsDir))
  assert.ok(fs.existsSync(config.exportsDir))
  assert.equal(PLUGIN_NAME, '@local/comsol-agent')
  fs.rmSync(root, { recursive: true, force: true })
})

test('detectComsolHomes returns a structured candidate list', () => {
  const result = detectComsolHomes()
  assert.ok(Array.isArray(result.candidates))
  assert.ok(result.home === null || typeof result.home === 'string')
})

test('path containment rejects writes outside the workspace', () => {
  const root = path.resolve(os.tmpdir(), 'comsol-agent-root')
  const inside = path.join(root, 'a', 'b.mph')
  const outside = path.resolve(os.tmpdir(), 'elsewhere', 'b.mph')
  assert.equal(isSubPath(root, inside), true)
  assert.equal(isSubPath(root, outside), false)
  assert.equal(assertInsideRoots(inside, [root]), inside)
  assert.throws(() => assertInsideRoots(outside, [root]), /OUTPUT_OUTSIDE_WORKSPACE/)
})

test('safeFilename keeps useful characters and strips unit brackets', () => {
  assert.equal(safeFilename('2.40[GHz]'), '2.40_GHz_')
  assert.equal(safeFilename('model.mph'), 'model')
  assert.equal(safeFilename('', 'fallback'), 'fallback')
})

test('normalizeParams converts finite numbers and rejects non-scalars', () => {
  const out = normalizeParams({ a: 1, b: '2[mm]', c: { nested: true }, d: Number.NaN })
  assert.deepEqual(out, { a: '1', b: '2[mm]' })
  assert.equal(normalizeParams(null), undefined)
})

test('decodeBuffer handles UTF-8 and GBK without corrupting ASCII', () => {
  const utf8 = Buffer.from('COMSOL 中文测试', 'utf8')
  assert.equal(decodeBuffer(utf8), 'COMSOL 中文测试')
  const gbk = Buffer.from([0x43, 0x4f, 0x4d, 0x53, 0x4f, 0x4c, 0x20, 0xd6, 0xd0, 0xce, 0xc4])
  assert.equal(decodeBuffer(gbk), 'COMSOL 中文')
})

test('analyzeLog classifies preview files as fatal', () => {
  const text = [
    'COMSOL_BRIDGE_ERROR MODEL_LOAD_FAILED',
    'Exception: This is a COMSOL Application Libraries preview file.',
  ].join('\n')
  const analysis = analyzeLog(text, { id: 'j1', status: 'failed', error: { code: 'PREVIEW', message: 'preview' } })
  assert.ok(analysis.categories.some((c) => c.id === 'preview_model'))
  assert.match(analysis.conclusion, /failed|preview/i)
  assert.equal(analysis.markers.bridge_error, true)
})

test('analyzeLog reports mesh and license evidence without overclaiming', () => {
  const text = [
    'COMSOL 6.2',
    'License checkout failed for COMSOL Multiphysics',
    'Failed to set mesh size automatically',
  ].join('\n')
  const analysis = analyzeLog(text, { id: 'j2', status: 'failed' })
  assert.ok(analysis.categories.some((c) => c.id === 'license'))
  assert.ok(analysis.categories.some((c) => c.id === 'mesh'))
  assert.match(analysis.conclusion, /fatal|license/i)
  assert.match(analysis.uncertainty, /heuristic/i)
})

test('analyzeLog says nothing was proven when no signature is present', () => {
  const analysis = analyzeLog('MODEL_LOADED=x\nBRIDGE_RESULT=result.json\n', { id: 'j3', status: 'succeeded' })
  assert.equal(analysis.categories.length, 0)
  assert.match(analysis.conclusion, /not a physics validation/i)
})
