const CATEGORIES = [
  {
    id: 'preview_model',
    label: 'Application Library preview file',
    patterns: [/Application Libraries preview/i, /preview file/i, /预览文件/i],
    diagnosis:
      'The .mph file is a COMSOL Application Library preview placeholder, not a complete model. It cannot be solved as-is.',
    confidence: 'high',
  },
  {
    id: 'license',
    label: 'License checkout',
    patterns: [/license/i, /licensing/i, /LMCOMSOL/i, /checkout/i, /许可/i, /授权/i],
    diagnosis:
      'A licensing-related message appeared. Verify the COMSOL license file/server, that a seat is free, and that the required module is licensed. This diagnosis is based on log text only.',
    confidence: 'medium',
  },
  {
    id: 'memory',
    label: 'Memory',
    patterns: [/out of memory/i, /OutOfMemoryError/i, /heap space/i, /Cannot allocate/i, /内存不足/i, /Out of memory/i],
    diagnosis:
      'The JVM or the solver reports insufficient memory. Reduce the mesh size or model size, close other COMSOL sessions, or raise javaHeap in the plugin config.',
    confidence: 'high',
  },
  {
    id: 'mesh',
    label: 'Mesh generation',
    patterns: [/Failed to set mesh/i, /mesh.*(failed|error)/i, /(failed|error).*mesh/i, /网格.*(失败|错误)/i, /FreeTri/i, /FreeTet/i],
    diagnosis:
      'Mesh generation or mesh sizing reported a problem. Check geometry validity, very thin gaps, and the requested element size.',
    confidence: 'medium',
  },
  {
    id: 'convergence',
    label: 'Solver convergence',
    patterns: [/not converge/i, /did not converge/i, /convergence/i, /不收敛/i, /Nonlinear.*fail/i],
    diagnosis:
      'The solver reported a convergence problem. Inspect the study/solver settings, mesh resolution and whether the physics setup is complete. Do not treat this as a successful solve.',
    confidence: 'medium',
  },
  {
    id: 'geometry',
    label: 'Geometry',
    patterns: [/Self-intersect/i, /Invalid geometry/i, /geometry.*(failed|error)/i, /几何.*(失败|错误|无效)/i],
    diagnosis:
      'Geometry construction or validation reported a problem. Check overlapping objects, zero-thickness regions and parameter values.',
    confidence: 'medium',
  },
  {
    id: 'material_or_physics',
    label: 'Material / physics',
    patterns: [/Undefined variable/i, /Unknown variable/i, /Material.*(missing|error)/i, /材料.*(缺失|错误)/i, /physics.*(failed|error)/i, /Physical.*undefined/i],
    diagnosis:
      'A material or physics-field definition is missing or invalid. Verify that every modelled domain has a material and that expressions/variables exist.',
    confidence: 'medium',
  },
  {
    id: 'file_access',
    label: 'File access',
    patterns: [/AccessControlException/i, /FileNotFoundException/i, /No such file/i, /Permission denied/i, /cannot open/i, /找不到文件/i, /无法打开/i],
    diagnosis:
      'A file could not be opened or written. Verify the path exists, the process has permission, and the file is not locked by another COMSOL session.',
    confidence: 'high',
  },
  {
    id: 'bridge_error',
    label: 'COMSOL bridge error',
    patterns: [/COMSOL_BRIDGE_ERROR/i, /FlException/i, /Exception:/i, /error/i, /错误/i],
    diagnosis:
      'The COMSOL Java bridge reported an error. Read the evidence lines and the result JSON error code; some generic "error" matches may be harmless progress text.',
    confidence: 'low',
  },
]

const MARKERS = [
  ['model_loaded', /MODEL_LOADED=/],
  ['model_saving', /SAVING_MODEL=/],
  ['bridge_result', /BRIDGE_RESULT=/],
  ['bridge_error', /COMSOL_BRIDGE_ERROR/],
  ['solve_started', /COMSOL_BRIDGE action=(run|create_model)/],
  ['exception', /Exception|FlException/],
]

function safeLine(line) {
  return line.length > 360 ? `${line.slice(0, 360)}…` : line
}

export function analyzeLog(text, job = null) {
  const lines = String(text ?? '').split(/\r?\n/)
  const markers = {}
  for (const [id, pattern] of MARKERS) {
    markers[id] = lines.some((line) => pattern.test(line))
  }

  const categories = []
  for (const category of CATEGORIES) {
    const matches = []
    for (const line of lines) {
      if (!line.trim()) continue
      if (category.patterns.some((pattern) => pattern.test(line))) {
        matches.push(safeLine(line.trim()))
        if (matches.length >= 8) break
      }
    }
    if (matches.length > 0) {
      categories.push({
        id: category.id,
        label: category.label,
        count: matches.length,
        evidence: matches.slice(0, 5),
        diagnosis: category.diagnosis,
        confidence: category.confidence,
      })
    }
  }

  const fatal = categories.filter((c) => ['preview_model', 'license', 'memory', 'file_access'].includes(c.id))
  const suspicious = categories.filter((c) => ['mesh', 'convergence', 'geometry', 'material_or_physics'].includes(c.id))

  let conclusion
  if (job?.status === 'failed') {
    const detected = categories.map((category) => category.label).join(', ')
    conclusion = `The job failed${job?.error?.code ? ` (${job.error.code})` : ''}. ${
      job?.error?.message ? `Reported error: ${job.error.message}. ` : ''
    }${detected ? `Detected log categories: ${detected}. ` : ''}The bridge result and log tail below are the authoritative evidence; do not treat this run as successful.`
  } else if (markers.bridge_error) {
    conclusion = 'The COMSOL bridge reported an error even though the job record is not marked failed. Inspect the bridge error lines and result JSON.'
  } else if (job?.status === 'timeout') {
    conclusion = 'The job exceeded its timeout. The log shows how far COMSOL progressed, but the result is incomplete and must not be treated as a successful solve.'
  } else if (job?.status === 'cancelled') {
    conclusion = 'The job was cancelled. Any output file may be incomplete.'
  } else if (fatal.length > 0) {
    conclusion = `A likely fatal problem was found: ${fatal.map((c) => c.label).join(', ')}. The job should not be treated as successful without resolving it.`
  } else if (suspicious.length > 0) {
    conclusion = `Potential physics/mesh/solver problems were found: ${suspicious.map((c) => c.label).join(', ')}. Review the evidence; some matches may be benign.`
  } else if (job?.status === 'succeeded' || markers.bridge_result) {
    conclusion = 'No recognised error signature was found. This is log-level evidence only; it does not by itself prove that the physics is correct.'
  } else {
    conclusion = 'No decisive error signature was recognized. Inspect the tail of the log and the job status.'
  }

  return {
    jobId: job?.id ?? null,
    jobError: job?.error ?? null,
    status: job?.status ?? 'unknown',
    analyzedAt: new Date().toISOString(),
    lineCount: lines.length,
    byteCount: Buffer.byteLength(String(text ?? ''), 'utf8'),
    markers,
    categories,
    conclusion,
    uncertainty:
      'Log diagnosis is heuristic. COMSOL messages may be localized and the same words can appear in harmless progress output. Confirm against the bridge result JSON and expected output files.',
    tail: lines.slice(Math.max(0, lines.length - 30)).join('\n'),
  }
}
