const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const utf8 = new TextDecoder('utf-8')
const gbk = new TextDecoder('gbk')

/**
 * COMSOL on Chinese Windows emits localised text in GBK while the Java bridge
 * writes UTF-8. Prefer strict UTF-8, fall back to GBK only when the bytes are
 * not valid UTF-8. This keeps English logs and UTF-8 Chinese intact.
 */
export function decodeBuffer(buffer) {
  if (buffer == null) return ''
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (bytes.length === 0) return ''
  try {
    return utf8Fatal.decode(bytes)
  } catch {
    try {
      return gbk.decode(bytes)
    } catch {
      return utf8.decode(bytes)
    }
  }
}

export function decodeChunk(chunk, previous = '') {
  const text = decodeBuffer(chunk)
  return previous + text
}
