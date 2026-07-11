import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../store'

export default function ConversationPanel(): JSX.Element {
  const sources = useStore((s) => s.sources)
  const phase = useStore((s) => s.phase)
  const messages = useStore((s) => s.messages)
  const cleaningProgress = useStore((s) => s.cleaningProgress)
  const addSources = useStore((s) => s.addSources)
  const removeSource = useStore((s) => s.removeSource)
  const setSourceAttribution = useStore((s) => s.setSourceAttribution)
  const setSourcePlatform = useStore((s) => s.setSourcePlatform)
  const setSourcePurpose = useStore((s) => s.setSourcePurpose)
  const setSourceNote = useStore((s) => s.setSourceNote)
  const startGeneration = useStore((s) => s.startGeneration)
  const confirmCheckpoint = useStore((s) => s.confirmCheckpoint)
  const sendMessage = useStore((s) => s.sendMessage)
  const abort = useStore((s) => s.abort)

  const [text, setText] = useState('')
  const [dragover, setDragover] = useState(false)
  const [sourceHeight, setSourceHeight] = useState(280)
  const [confirmHeight, setConfirmHeight] = useState(220)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('directory', '')
    }
  }, [])

  useEffect(() => {
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }, [messages])

  const running = phase === 'cleaning' || phase === 'analyzing'
  const hasUsable = sources.some((s) => s.dataUrl || s.text)
  const parsedCount = sources.filter((s) => s.dataUrl || s.text).length
  const parsingCount = sources.filter((s) => s.parsing).length
  const explainedCount = sources.filter((s) => s.attribution && s.platform && s.purpose && s.note).length
  const competitorSources = sources.filter((s) => /竞品|竞对|对标|对手/.test(s.attribution ?? ''))
  const parsePercent = sources.length ? Math.round((parsedCount / sources.length) * 100) : 0
  const cleanPercent = cleaningProgress.total
    ? Math.round(((cleaningProgress.done + cleaningProgress.failed) / cleaningProgress.total) * 100)
    : 0
  const isPrepareEmpty = phase === 'idle' && sources.length === 0 && messages.length === 0
  const phaseTitle =
    phase === 'idle'
      ? '资料准备'
      : phase === 'cleaning' || phase === 'checkpoint1'
        ? '资料校验'
        : phase === 'analyzing'
          ? '经营分析'
          : '报告助手'

  const onSend = async (): Promise<void> => {
    const t = text
    setText('')
    await sendMessage(t)
  }

  const startVerticalResize = (
    setter: Dispatch<SetStateAction<number>>,
    startValue: number,
    startY: number,
    min: number,
    max: number
  ): void => {
    const onMove = (event: MouseEvent): void => {
      const next = Math.min(max, Math.max(min, startValue + event.clientY - startY))
      setter(next)
    }
    const onUp = (): void => {
      document.body.classList.remove('resizing-vertical')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.classList.add('resizing-vertical')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const placeholder =
    phase === 'checkpoint1'
      ? '确认无误点上方按钮；要纠偏就在这里说，如「把竞品换成 X」'
        : phase === 'checkpoint2' || phase === 'done'
          ? '想改报告哪里就说，如「经营建议再具体些」'
          : running
            ? '运行中…可随时打字纠偏，会用在后续步骤'
          : sources.length === 0
            ? '写清楚本次分析目标：如「帮我判断这个酸菜产品的视频号内容主线和核心人群」'
            : '有补充或要求可以先写在这里'

  return (
    <div
      className={`pane chat ${dragover ? 'dragover' : ''} ${isPrepareEmpty ? 'prepare-empty' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragover(true)
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragover(false)
        if (e.dataTransfer.files.length) void addSources(e.dataTransfer.files)
      }}
    >
      <div className="pane-title">{phaseTitle}</div>

      {/* 数据源条 */}
      <div className="src-strip" style={{ height: sources.length > 0 ? sourceHeight : undefined }}>
        <datalist id="source-platform-options">
          <option value="巨量云图" />
          <option value="抖店罗盘" />
          <option value="视频号" />
          <option value="抖音" />
          <option value="有米云" />
          <option value="蝉妈妈" />
          <option value="淘宝" />
          <option value="天猫" />
          <option value="小红书" />
          <option value="微信小店" />
          <option value="飞书Base" />
          <option value="用户补充" />
        </datalist>
        <datalist id="source-purpose-options">
          <option value="人群画像数据" />
          <option value="平台大盘数据" />
          <option value="内容素材数据" />
          <option value="用户反馈数据" />
          <option value="交易数据" />
          <option value="商品经营数据" />
          <option value="产品手卡" />
          <option value="投放数据" />
          <option value="售后数据" />
          <option value="竞品素材数据" />
          <option value="补充说明" />
        </datalist>
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          accept=".png,.jpg,.jpeg,.webp,.gif,.xlsx,.xls,.csv,.pdf,.docx,.doc,.pptx,.ppt,.md,.markdown,.txt,.zip"
          onChange={(e) => {
            if (e.target.files?.length) void addSources(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void addSources(e.target.files)
            e.target.value = ''
          }}
        />
        {sources.length === 0 ? (
          <div className="upload-welcome">
            <div className="welcome-kicker">AI 指挥中枢</div>
            <h1>让 AI 经营分析中枢接管资料、判断和成稿链路</h1>
            <p>
              上传产品手卡、自有经营数据、用户画像、内容素材和竞品资料。系统会先清洗归类，再在关键节点停下来让你确认。
            </p>
            <div className="welcome-command-grid">
              <div className="agent-card hero-agent">
                <div className="agent-card-head">
                  <span className="agent-icon">AI</span>
                  <div>
                    <b>产品策略代理</b>
                    <span>等待资料接入</span>
                  </div>
                </div>
                <div className="agent-progress">
                  <div style={{ width: '18%' }} />
                </div>
                <div className="agent-metrics">
                  <span>输入</span>
                  <b>0</b>
                  <span>流程</span>
                  <b>就绪</b>
                </div>
              </div>
              <div className="workflow-preview" aria-label="AI 工作流">
                {['输入', '分析', '生成', '复核', '交付'].map((item, index) => (
                  <div key={item} className={`workflow-node ${index === 0 ? 'active' : ''}`}>
                    <span>{index + 1}</span>
                    <b>{item}</b>
                  </div>
                ))}
              </div>
            </div>
            <div className="welcome-actions">
              <button className="btn primary big" onClick={() => fileRef.current?.click()}>
                上传产品资料
              </button>
              <button className="btn big" onClick={() => folderRef.current?.click()}>
                选择资料文件夹
              </button>
            </div>
            <div className="deliverable-outline">
              <div className="outline-title">最终报告将包含</div>
              <div className="outline-grid">
                <span>结论摘要</span>
                <span>数据来源</span>
                <span>产品基础信息</span>
                <span>12维卖点拆解</span>
                <span>竞品卖点判断</span>
                <span>人群画像</span>
                <span>内容主线</span>
                <span>执行选题表</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="src-strip-head">
            <span>资料源（{sources.length}）</span>
            <button className="btn xs" onClick={() => fileRef.current?.click()}>
              ＋ 文件
            </button>
            <button className="btn xs" onClick={() => folderRef.current?.click()}>
              ＋ 文件夹
            </button>
          </div>
        )}
        {sources.length > 0 && (
          <>
            <div className="src-tip">归属只能二选一：自有数据 / 竞品数据；平台、信息类型和补充说明可按实际资料填写。被忽略或解析失败的文件不会参与分析。</div>
            <div className="src-list">
              {sources.map((s) => (
                <div className="src-row" key={s.id}>
                  <div className="src-row-top">
                    {s.kind === 'image' && s.dataUrl ? (
                      <img className="src-thumb" src={s.dataUrl} alt="" />
                    ) : (
                      <span className="src-ico">{s.parsing ? '解析' : s.error ? '异常' : '文档'}</span>
                    )}
                    <span className="src-name" title={s.error || s.name}>
                      {s.name}
                    </span>
                    <span className="x" onClick={() => removeSource(s.id)}>
                      ✕
                    </span>
                  </div>
                  <div className="src-meta-row">
                    <div className="src-attr-toggle" aria-label="资料归属">
                      {(['自有数据', '竞品数据'] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className={s.attribution === value ? 'active' : ''}
                          onClick={() => setSourceAttribution(s.id, value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <input
                      className="src-select"
                      list="source-platform-options"
                      placeholder="平台/来源"
                      value={s.platform ?? ''}
                      onChange={(e) => setSourcePlatform(s.id, e.target.value)}
                    />
                    <input
                      className="src-select"
                      list="source-purpose-options"
                      placeholder="信息类型"
                      value={s.purpose ?? ''}
                      onChange={(e) => setSourcePurpose(s.id, e.target.value)}
                    />
                    <span className={`src-status ${s.parsing ? 'parsing' : s.error ? 'error' : 'ready'}`}>
                      {s.parsing
                        ? '解析中'
                        : s.error
                          ? s.error.startsWith('已忽略')
                            ? '已忽略'
                            : '解析失败'
                          : s.dataUrl || s.text
                            ? '可分析'
                            : '待处理'}
                    </span>
                  </div>
                  <input
                    className="src-note"
                    placeholder="补充信息/说明：如 这是视频号近30天成交人群截图 / 文件里没写但这是自有爆款素材"
                    value={s.note ?? ''}
                    onChange={(e) => setSourceNote(s.id, e.target.value)}
                  />
                  {s.error && <div className="src-err">{s.error.startsWith('已忽略') ? s.error : `解析失败：${s.error}`}</div>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {sources.length > 0 && (
        <div
          className="vertical-resizer"
          role="separator"
          aria-label="调整资料列表高度"
          onMouseDown={(event) => startVerticalResize(setSourceHeight, sourceHeight, event.clientY, 120, 560)}
        />
      )}

      {(sources.length > 0 || phase === 'cleaning') && (
        <div className="progress-panel">
          <div className="progress-row">
            <div className="progress-head">
              <b>本地解析</b>
              <span>
                {parsedCount}/{sources.length} 可分析{parsingCount ? `，${parsingCount} 个解析中` : ''}
              </span>
            </div>
            <div className="progress-track">
              <div style={{ width: `${parsePercent}%` }} />
            </div>
          </div>
          {phase === 'cleaning' && (
            <div className="progress-row">
              <div className="progress-head">
                <b>AI 清洗归类</b>
                <span>
                  {cleaningProgress.done}/{cleaningProgress.total} 完成
                  {cleaningProgress.failed ? `，${cleaningProgress.failed} 个失败` : ''}
                </span>
              </div>
              <div className="progress-track">
                <div style={{ width: `${cleanPercent}%` }} />
              </div>
              {cleaningProgress.running.length > 0 && (
                <div className="progress-running">
                  正在清洗：{cleaningProgress.running.join('、')}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {phase === 'checkpoint1' && (
        <div className="checkpoint-card" style={{ height: confirmHeight }}>
          <div className="checkpoint-head">
            <div>
              <b>资料确认</b>
              <span>确认文件分类、解析状态和竞品状态后，再继续正式分析。</span>
            </div>
            <div className="checkpoint-stats">
              <em>{parsedCount}/{sources.length} 可分析</em>
              <em>{explainedCount}/{sources.length} 已标注完整</em>
            </div>
          </div>
          <div className="checkpoint-branch">
            {competitorSources.length > 0 ? (
              <span className="ok">已检测到 {competitorSources.length} 份竞品资料：确认后会直接进入竞品卖点拆解。</span>
            ) : (
              <span className="warn">暂未检测到竞品资料：确认后会根据模板生成竞品参考方向，并标注未实采待验证。</span>
            )}
          </div>
          <div className="checkpoint-table">
            {sources.map((s) => (
              <div className="checkpoint-row" key={s.id}>
                <span title={s.name}>{s.name}</span>
                <b>{s.attribution || '待确认'}</b>
                <b>{s.platform || '未填平台'}</b>
                <b>{s.purpose || '未填信息类型'}</b>
                <em>
                  {s.parsing
                    ? '解析中'
                    : s.error
                      ? s.error.startsWith('已忽略')
                        ? '已忽略'
                        : '解析失败'
                      : s.dataUrl || s.text
                        ? '可分析'
                        : '待处理'}
                </em>
              </div>
            ))}
          </div>
          {parsingCount > 0 && <div className="checkpoint-warn">仍有文件在本地解析中，建议等解析完成后再继续。</div>}
        </div>
      )}

      {phase === 'checkpoint1' && (
        <div
          className="vertical-resizer"
          role="separator"
          aria-label="调整资料确认高度"
          onMouseDown={(event) => startVerticalResize(setConfirmHeight, confirmHeight, event.clientY, 120, 520)}
        />
      )}

      {/* 对话流 */}
      <div className="messages">
        {messages.length === 0 && !isPrepareEmpty && (
          <div className="empty-hint">
            这里会显示 AI 分析过程、资料校验结果和等待你确认的关键结论。
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.kind ?? ''}`}>
            {m.kind === 'report-block' ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text || '…'}</ReactMarkdown>
              </div>
            ) : (
              m.text
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* 主操作区 */}
      <div className="composer">
        {isPrepareEmpty && <div className="composer-label">分析目标</div>}
        <div className="primary-actions">
          {phase === 'idle' && (
            <button className="btn primary big" disabled={!hasUsable} onClick={() => void startGeneration()}>
              开始生成报告
            </button>
          )}
          {phase === 'checkpoint1' && (
            <button className="btn ok big" onClick={() => void confirmCheckpoint()}>
              确认，继续分析
            </button>
          )}
          {phase === 'checkpoint2' && (
            <button className="btn ok big" onClick={() => void confirmCheckpoint()}>
              确认定稿
            </button>
          )}
          {running && (
            <button className="btn big" onClick={abort}>
              停止
            </button>
          )}
        </div>
        <div className="composer-row">
          <textarea
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void onSend()
              }
            }}
          />
          <button className="btn" onClick={onSend}>
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
