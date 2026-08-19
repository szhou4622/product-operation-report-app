import { describe, expect, it } from 'vitest'
import { parseRemoteContactConfig, sniffContactImageMime, validateContactImage } from './contactConfig'

describe('contact configuration validation', () => {
  it('accepts a matching HTTPS configuration', () => {
    expect(parseRemoteContactConfig({
      app_name: 'ProductOperationReport',
      enabled: true,
      qr_image_url: 'https://cdn.example.com/contact.png',
      updated_at: '2026-08-19T10:00:00Z'
    }, 'ProductOperationReport')).toEqual({
      appName: 'ProductOperationReport',
      enabled: true,
      imageUrl: 'https://cdn.example.com/contact.png',
      updatedAt: '2026-08-19T10:00:00Z'
    })
  })

  it('rejects mismatched apps and non-HTTPS images', () => {
    expect(() => parseRemoteContactConfig({
      app_name: 'OtherApp', enabled: true, qr_image_url: '', updated_at: '2026-08-19T10:00:00Z'
    }, 'ProductOperationReport')).toThrow(/软件标识/u)
    expect(() => parseRemoteContactConfig({
      app_name: 'ProductOperationReport', enabled: true,
      qr_image_url: 'http://cdn.example.com/contact.png', updated_at: '2026-08-19T10:00:00Z'
    }, 'ProductOperationReport')).toThrow(/HTTPS/u)
  })

  it('validates PNG, JPEG and WebP magic instead of trusting the header alone', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    expect(sniffContactImageMime(png)).toBe('image/png')
    expect(sniffContactImageMime(jpeg)).toBe('image/jpeg')
    expect(sniffContactImageMime(webp)).toBe('image/webp')
    expect(validateContactImage('image/png', png)).toBe('image/png')
    expect(() => validateContactImage('text/html', png)).toThrow(/类型/u)
    expect(() => validateContactImage('image/png', jpeg)).toThrow(/校验失败/u)
  })
})
