export interface RemoteContactConfig {
  appName: string
  enabled: boolean
  imageUrl?: string
  updatedAt: string
}

export type ContactImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('联系配置格式无效。')
  }
  return value as Record<string, unknown>
}

export function parseRemoteContactConfig(value: unknown, expectedAppName: string): RemoteContactConfig {
  const input = record(value)
  const appName = typeof input.app_name === 'string' ? input.app_name.trim() : ''
  if (!appName || appName !== expectedAppName) throw new Error('联系配置的软件标识不匹配。')
  if (typeof input.enabled !== 'boolean') throw new Error('联系配置的启用状态无效。')
  const imageUrl = typeof input.qr_image_url === 'string' ? input.qr_image_url.trim() : ''
  if (input.qr_image_url !== undefined && typeof input.qr_image_url !== 'string') {
    throw new Error('联系方式图片地址格式无效。')
  }
  if (imageUrl) {
    let parsed: URL
    try {
      parsed = new URL(imageUrl)
    } catch {
      throw new Error('联系方式图片地址格式无效。')
    }
    if (parsed.protocol !== 'https:') throw new Error('联系方式图片必须使用 HTTPS。')
  }
  const updatedAt = typeof input.updated_at === 'string' ? input.updated_at.trim() : ''
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error('联系配置更新时间无效。')
  return { appName, enabled: input.enabled, ...(imageUrl ? { imageUrl } : {}), updatedAt }
}

export function sniffContactImageMime(bytes: Uint8Array): ContactImageMime | null {
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp'
  return null
}

export function validateContactImage(contentType: string, bytes: Uint8Array): ContactImageMime {
  const declared = contentType.split(';', 1)[0].trim().toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(declared)) {
    throw new Error('联系方式图片类型不受支持。')
  }
  const detected = sniffContactImageMime(bytes)
  if (!detected || detected !== declared) throw new Error('联系方式图片内容校验失败。')
  return detected
}
