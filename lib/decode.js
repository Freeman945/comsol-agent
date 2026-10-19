const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const utf8 = new TextDecoder('utf-8')
const gbk = new TextDecoder('gbk')

// COMSOL emits GBK on Chinese Windows, while the bridge writes UTF-8.
// Try strict UTF-8 first and fall back to GBK for invalid byte sequences.
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
