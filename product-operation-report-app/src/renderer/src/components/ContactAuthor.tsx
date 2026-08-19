import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContactDisplayState } from '../../../shared/types'
import fallbackContactImage from '../assets/contact-author-fallback.png'

const INITIAL_CONTACT: ContactDisplayState = {
  enabled: true,
  configured: false,
  source: 'bundled',
  message: '联系方式图片暂未配置'
}

export default function ContactAuthor(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const requestedRef = useRef(false)
  const [contact, setContact] = useState<ContactDisplayState>(INITIAL_CONTACT)
  const [loading, setLoading] = useState(false)
  const [pinned, setPinned] = useState(false)

  const applyContact = useCallback((state: ContactDisplayState) => {
    if (!state.imageDataUrl) {
      setContact(state)
      return
    }
    const probe = new Image()
    probe.onload = () => setContact(state)
    probe.onerror = () => setContact({
      ...INITIAL_CONTACT,
      message: '联系方式图片暂时不可用，当前使用内置图片'
    })
    probe.src = state.imageDataUrl
  }, [])

  const ensureContact = useCallback(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    setLoading(true)
    void window.api.getContact()
      .then(applyContact)
      .catch(() => setContact({
        ...INITIAL_CONTACT,
        message: '暂时无法获取最新联系方式，当前使用内置图片'
      }))
      .finally(() => setLoading(false))
  }, [applyContact])

  useEffect(() => window.api.onContactChanged((state) => {
    applyContact(state)
    setLoading(false)
  }), [applyContact])

  useEffect(() => {
    if (!pinned) return
    const closeOutside = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [pinned])

  const imageSource = contact.imageDataUrl || fallbackContactImage
  const statusMessage = loading ? '正在获取最新联系方式…' : contact.message

  return (
    <div
      ref={rootRef}
      className={`contact-entry${pinned ? ' pinned' : ''}`}
      onMouseEnter={ensureContact}
      onFocusCapture={ensureContact}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPinned(false)
          const trigger = event.currentTarget.querySelector('.contact-trigger') as HTMLButtonElement | null
          trigger?.focus()
        }
      }}
    >
      <button
        className="contact-trigger"
        type="button"
        aria-describedby="contact-author-popover"
        aria-expanded={pinned}
        aria-controls="contact-author-popover"
        aria-label="联系作者，悬停、聚焦或点击显示联系方式图片"
        onClick={() => {
          ensureContact()
          setPinned((value) => !value)
        }}
      >
        联系作者
      </button>
      <div className="contact-qr-popover" id="contact-author-popover" role="tooltip">
        <strong>联系作者</strong>
        {contact.enabled ? (
          <img src={imageSource} alt="联系作者图片" />
        ) : (
          <div className="contact-unavailable" role="status">联系方式暂未开放</div>
        )}
        <span role="status">{statusMessage}</span>
      </div>
    </div>
  )
}
