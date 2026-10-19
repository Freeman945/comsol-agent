export const stringSchema = (description, extra = {}) => ({ type: 'string', description, ...extra })

export const booleanSchema = (description, defaultValue) => ({
  type: 'boolean',
  description,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
})

export const numberSchema = (description, extra = {}) => ({ type: 'number', description, ...extra })

export const stringArraySchema = (description) => ({
  type: 'array',
  description,
  items: { type: 'string' },
})

export const selectionSchema = {
  description:
    'Optional geometric selection: an array of entity indices (domains for volume evaluations, boundaries for surface evaluations) or a named selection string from the model.',
  oneOf: [
    { type: 'array', items: { type: 'integer' } },
    { type: 'string' },
  ],
}

export const paramsSchema = {
  type: 'object',
  description:
    'Map of global parameter names to COMSOL expressions, for example {"gap": "2[mm]", "freq": "2.45[GHz]"}. Values may be strings or numbers; numbers are converted to strings.',
  additionalProperties: {
    oneOf: [{ type: 'string' }, { type: 'number' }],
  },
}

export const coordinatesSchema = {
  type: 'array',
  description:
    'Evaluation points. Each point is an array of coordinates in the model geometry: [r,z] for 2D axisymmetric, [x,y] for 2D, [x,y,z] for 3D.',
  items: { type: 'array', items: { type: 'number' } },
}

export const outputSchema = {
  type: 'object',
  description: 'Structured result object. See the tool description and README for fields.',
  additionalProperties: true,
}

export const baseProperties = {
  modelPath: stringSchema('Absolute path to an existing COMSOL .mph model file.'),
}

export function normalizeParams(value) {
  if (value == null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim() === '') continue
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = String(raw)
  }
  return out
}

export function renderValue(value) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  const limit = 60_000
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n… [truncated ${text.length - limit} characters; read the job log or result file for the full payload]`
  }
  return [{ type: 'text', text }]
}
