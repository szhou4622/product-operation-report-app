import { createPublicKey, verify } from 'crypto'

// Ed25519 SPKI DER public key. The matching private key stays offline under .secrets/ and never enters Git/installers.
export const UPDATE_SIGNING_PUBLIC_KEY_DER_B64 =
  'MCowBQYDK2VwAyEASQc6Vi5UmONGEUUM09pJgdHsSdj11ykiaNePjSQLGnU='

function canonicalValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== 'signature' && item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`).join(',')}}`
  }
  throw new Error('更新签名内容包含不支持的值。')
}

export function canonicalUpdateManifest(value: Record<string, unknown>): Buffer {
  return Buffer.from(canonicalValue(value), 'utf8')
}

export function verifyUpdateManifestSignature(
  manifest: Record<string, unknown>,
  publicKeyDerBase64 = UPDATE_SIGNING_PUBLIC_KEY_DER_B64
): boolean {
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{80,100}={0,2}$/.test(manifest.signature)) return false
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyDerBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return verify(null, canonicalUpdateManifest(manifest), publicKey, Buffer.from(manifest.signature, 'base64'))
  } catch {
    return false
  }
}

export const updateSignatureInternals = { canonicalValue }
