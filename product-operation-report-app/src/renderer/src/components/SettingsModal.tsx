import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, ModelProfile, TestModelResult } from '../../../shared/types'
import { useStore } from '../store'

const DEFAULT_PROFILE_NAME = 'ai英雄会'
const LEGACY_DEFAULT_PROFILE_NAME = '中转API（ai英雄会）'
const CONFIG_GUIDE_URL = 'https://my.feishu.cn/docx/DrvrdxXguorTW0xrEA8cMK93nCg?from=from_copylink'

function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    privacyAccepted: Boolean(settings.privacyAccepted),
    profiles: settings.profiles.map((profile) =>
      profile.name === LEGACY_DEFAULT_PROFILE_NAME ? { ...profile, name: DEFAULT_PROFILE_NAME } : profile
    )
  }
}

function createProfile(name = DEFAULT_PROFILE_NAME): ModelProfile {
  return {
    id: crypto.randomUUID(),
    name,
    baseURL: 'https://cool.ai123321.com/v1',
    apiKey: '',
    model: 'gpt-5.5',
    supportsVision: true,
    temperature: 0.3
  }
}

export default function SettingsModal(): JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const saveSettings = useStore((s) => s.saveSettings)

  // 本地草稿，确认后再写回
  const [draft, setDraft] = useState<AppSettings>(() =>
    settings && settings.profiles.length
      ? normalizeSettings(structuredClone(settings))
      : {
          profiles: [createProfile()],
          activeProfileId: null,
          projectsDir: settings?.projectsDir || '',
          privacyAccepted: Boolean(settings?.privacyAccepted)
        }
  )
  const [selectedId, setSelectedId] = useState<string>(() => draft.profiles[0]?.id ?? '')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestModelResult | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [modelsMsg, setModelsMsg] = useState('')
  const imgRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(
    () => draft.profiles.find((p) => p.id === selectedId) ?? draft.profiles[0],
    [draft, selectedId]
  )
  const hasApiKey = Boolean(selected?.apiKey.trim())
  const hasConnectionResult = Boolean(result)
  const canTestVision = hasApiKey && Boolean(selected?.supportsVision)

  // Esc 关闭弹窗
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setSettingsOpen])

  if (!open) return null

  const patch = (p: Partial<ModelProfile>): void => {
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.map((x) => (x.id === selected.id ? { ...x, ...p } : x))
    }))
  }

  const addProfile = (): void => {
    const np = createProfile('新模型配置')
    setDraft((d) => ({ ...d, profiles: [...d.profiles, np] }))
    setSelectedId(np.id)
    setResult(null)
  }

  const removeProfile = (): void => {
    setDraft((d) => {
      const profiles = d.profiles.filter((x) => x.id !== selected.id)
      return {
        ...d,
        profiles,
        activeProfileId: d.activeProfileId === selected.id ? null : d.activeProfileId
      }
    })
    const remain = draft.profiles.filter((x) => x.id !== selected.id)
    setSelectedId(remain[0]?.id ?? '')
  }

  const runTest = async (withImageDataUrl?: string): Promise<void> => {
    setTesting(true)
    setResult(null)
    const r = await window.api.testModel({ profile: selected, withImageDataUrl })
    setResult(r)
    setTesting(false)
  }

  const fetchModels = async (): Promise<void> => {
    setModelsMsg('拉取中…')
    setModels([])
    const r = await window.api.listModels(selected)
    if (r.ok) {
      setModels(r.models ?? [])
      setModelsMsg(r.models?.length ? `共 ${r.models.length} 个，点一个填入` : '该端点没有返回模型列表')
    } else {
      setModelsMsg(`拉取失败：${r.error}`)
    }
  }

  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => void runTest(reader.result as string)
    reader.readAsDataURL(f)
  }

  const onSave = async (): Promise<void> => {
    const active = draft.activeProfileId ?? selected?.id ?? draft.profiles[0]?.id ?? null
    await saveSettings({ ...draft, activeProfileId: active })
    setSettingsOpen(false)
  }

  return (
    <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>设置 · 模型配置</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!settings?.profiles.length && (
              <span style={{ fontSize: 12, color: 'var(--text-weak)' }}>API Key 可稍后再填</span>
            )}
            <button className="btn" onClick={() => setSettingsOpen(false)}>
              关闭
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className="settings-guide">
            <div className="settings-guide-main">
              <span className="settings-guide-kicker">推荐默认配置</span>
              <b>ai英雄会</b>
              <span>填入 API Key 后即可开始分析；连通测试和读图测试只是可选排障步骤。</span>
            </div>
            <a
              href={CONFIG_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault()
                void window.api.openExternal(CONFIG_GUIDE_URL)
              }}
            >
              打开配置教程
            </a>
          </div>

          <div className="settings-steps" aria-label="模型配置步骤">
            <div className={`settings-step ${hasApiKey ? 'done' : 'active'}`}>
              <span>1</span>
              <div>
                <b>填 API Key</b>
                <em>{hasApiKey ? '已填写' : '先粘贴服务商给你的 Key'}</em>
              </div>
            </div>
            <div className={`settings-step ${hasConnectionResult ? 'done' : hasApiKey ? 'active' : ''}`}>
              <span>2</span>
              <div>
                <b>测试连通（可选）</b>
                <em>{hasApiKey ? '不影响直接使用，可用于排查 Key 是否正确' : '填写 Key 后可测试'}</em>
              </div>
            </div>
            <div className={`settings-step ${selected?.supportsVision && hasConnectionResult ? 'active' : ''}`}>
              <span>3</span>
              <div>
                <b>测试读图（可选）</b>
                <em>{selected?.supportsVision ? '不影响直接使用，可用于排查图片识别' : '当前模型未开启读图'}</em>
              </div>
            </div>
          </div>

          <div className="profiles-bar">
            {draft.profiles.map((p) => (
              <button
                key={p.id}
                className={`profile-tab ${p.id === selected?.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedId(p.id)
                  setResult(null)
                }}
              >
                {p.name || '(未命名)'}
                {draft.activeProfileId === p.id ? ' ·当前' : ''}
              </button>
            ))}
            <button className="profile-tab" onClick={addProfile}>
              ＋ 新增模型
            </button>
          </div>

          {selected && (
            <>
              <div className="active-profile-card">
                <div>
                  <span>当前正在配置</span>
                  <strong>{selected.name || DEFAULT_PROFILE_NAME}</strong>
                </div>
                <button
                  className="btn"
                  onClick={() => setDraft((d) => ({ ...d, activeProfileId: selected.id }))}
                >
                  设为当前
                </button>
              </div>

              <div className="field">
                <label>名称</label>
                <input
                  type="text"
                  value={selected.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="ai英雄会"
                />
              </div>
              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={selected.apiKey}
                  onChange={(e) => patch({ apiKey: e.target.value })}
                  placeholder="粘贴 API Key，例如 sk-..."
                />
                <div className="hint">仅保存在本机，并由系统加密存储（safeStorage）。</div>
              </div>

              <div className="settings-test-panel">
                <div>
                  <b>可选测试</b>
                  <span>填好 API Key 就能使用；如果运行失败，再用这里检查连通或图片识别。</span>
                </div>
                <div className="settings-test-actions">
                  <button className="btn primary" disabled={testing || !hasApiKey} onClick={() => runTest()}>
                    {testing ? '测试中…' : '测试连通'}
                  </button>
                  <button
                    className="btn"
                    disabled={testing || !canTestVision}
                    onClick={() => imgRef.current?.click()}
                    title={selected.supportsVision ? '' : '请先勾选支持读图'}
                  >
                    测试读图
                  </button>
                  <input
                    ref={imgRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={onPickImage}
                  />
                </div>
              </div>

              {result && (
                <div className={`test-result ${result.ok ? 'ok' : 'err'}`}>
                  {result.ok ? '✓ 连通成功' : '✗ 失败'}
                  {typeof result.latencyMs === 'number' ? `（${result.latencyMs}ms）` : ''}
                  {'\n'}
                  {result.message}
                </div>
              )}

              <div className="advanced-settings">
                <div className="advanced-settings-title">高级配置</div>
                <div className="advanced-settings-desc">一般保持默认即可；需要接入其他服务时再修改。</div>
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  type="text"
                  value={selected.baseURL}
                  onChange={(e) => patch({ baseURL: e.target.value })}
                  placeholder="https://cool.ai123321.com/v1"
                />
                <div className="hint">OpenAI 兼容端点，末尾到 /v1 即可（会自动补 /chat/completions）。</div>
              </div>
              <div className="field">
                <label>模型名</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={selected.model}
                    onChange={(e) => patch({ model: e.target.value })}
                    placeholder="gpt-5.5"
                  />
                  <button
                    className="btn"
                    style={{ flex: '0 0 auto' }}
                    disabled={!hasApiKey}
                    onClick={() => void fetchModels()}
                    title={selected.apiKey ? '从端点拉取可用模型' : '请先填 API Key'}
                  >
                    拉取模型
                  </button>
                </div>
                {modelsMsg && <div className="hint">{modelsMsg}</div>}
                {models.length > 0 && (
                  <div className="model-chips">
                    {models.map((m) => (
                      <button
                        key={m}
                        className={`model-chip ${m === selected.model ? 'active' : ''}`}
                        onClick={() => patch({ model: m })}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="field">
                <div className="checkbox-row">
                  <input
                    id="vision"
                    type="checkbox"
                    checked={selected.supportsVision}
                    onChange={(e) => patch({ supportsVision: e.target.checked })}
                  />
                  <label htmlFor="vision" style={{ margin: 0 }}>
                    该模型支持读图（多模态）—— 上传的截图会直接发给模型
                  </label>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <div>
            {selected && draft.profiles.length > 1 && (
              <button className="btn" onClick={removeProfile}>
                删除此配置
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={onSave}>
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
