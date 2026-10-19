export class ToolError extends Error {
  constructor(code, message, details = undefined) {
    const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : ''
    super(`[${code}] ${message}${suffix}`)
    this.name = 'ToolError'
    this.code = code
    this.details = details
  }
}

export function fail(code, message, details) {
  throw new ToolError(code, message, details)
}

export function asErrorPayload(error) {
  if (error instanceof ToolError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details } }
  }
  return { ok: false, error: { code: 'UNEXPECTED_ERROR', message: String(error?.message ?? error) } }
}
