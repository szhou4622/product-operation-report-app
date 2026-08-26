import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { sourceKindLabel, type SourceKindV1 } from '../../../shared/types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { derivedSourceCount, evidenceScopeStats, topLevelSourceCount, useStore } from '../store'

export default function ConversationPanel(): JSX.Element {
  const sources = useStore((s) => s.sources)
  const phase = useStore((s) => s.phase)
  const readOnly = useStore((s) => s.readOnly)
  const legacyNotice = useStore((s) => s.legacyNotice)
  const messages = useStore((s) => s.messages)
  const cleaningProgress = useStore((s) => s.cleaningProgress)
  const cleanDetails = useStore((s) => s.cleanDetails)
  const addSources = useStore((s) => s.addSources)
  const removeSource = useStore((s) => s.removeSource)
  const setSourceAttribution = useStore((s) => s.setSourceAttribution)
  const setUnconfirmedAttribution = useStore((s) => s.setUnconfirmedAttribution)
  const setSourcePlatform = useStore((s) => s.setSourcePlatform)
  const setSourceKindV1 = useStore((s) => s.setSourceKindV1)
  const setSourceNote = useStore((s) => s.setSourceNote)
  const startGeneration = useStore((s) => s.startGeneration)
  const confirmCheckpoint = useStore((s) => s.confirmCheckpoint)
  const sendMessage = useStore((s) => s.sendMessage)
  const abort = useStore((s) => s.abort)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [dragover, setDragover] = useState(false)
  const [sourceHeight, setSourceHeight] = useState(280)
  const [confirmHeight, setConfirmHeight] = useState(220)
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('directory', '')
    }
  }, [])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'auto' }))
  }, [messages])

  const running = phase === 'cleaning' || phase === 'analyzing'
  const hasUsable = sources.some((s) => s.dataUrl || s.text)
  const parsedCount = sources.filter((s) => s.dataUrl || s.text).length
  const parsingCount = sources.filter((s) => s.parsing).length
  const processedCount = sources.filter((s) => !s.parsing).length
  const importLocked = readOnly || running || parsingCount > 0
  const unconfirmedCount = sources.filter((s) => (s.dataUrl || s.text) && !s.attribution).length
  const unconfirmedKindCount = sources.filter((s) => (s.dataUrl || s.text) && !s.kindV1).length
  const confirmedAttributionCount = sources.filter(
    (s) => (s.dataUrl || s.text) && Boolean(s.attribution)
  ).length
  const competitorSources = sources.filter((s) => /竞品|竞对|对标|对手/.test(s.attribution ?? ''))
  const uploadedFileCount = topLevelSourceCount(sources)
  const derivedCount = derivedSourceCount(sources)
  const scopeStats = evidenceScopeStats(sources, cleanDetails)
  const parsePercent = sources.length ? Math.round((processedCount / sources.length) * 100) : 0
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
    if (!t.trim() || sending) return
    setSending(true)
    setSendError('')
    try {
      const sent = await sendMessage(t)
      if (sent) setText('')
      else setSendError('没有处理成功，输入内容已保留，请检查上方提示后重试。')
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '发送失败，请重试。')
    } finally {
      setSending(false)
    }
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

  const confirmAllUnassigned = (attribution: '自有数据' | '竞品数据'): void => {
    const rerunNotice = phase === 'idle' ? '' : ' 修改后需要重新生成分析，上一份完整报告仍会保留。'
    if (!window.confirm(`将把 ${unconfirmedCount} 份未确认资料全部设为“${attribution}”。已手动确认的资料不会变化。${rerunNotice}确定继续吗？`)) return
    setUnconfirmedAttribution(attribution)
  }

  return (
    <div
      className={`pane chat ${dragover ? 'dragover' : ''} ${isPrepareEmpty ? 'prepare-empty' : ''}`}
      onDragOver={(e) => {
        if (importLocked) return
        e.preventDefault()
        setDragover(true)
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragover(false)
        if (!importLocked && e.dataTransfer.files.length) void addSources(e.dataTransfer.files)
      }}
    >
      <div className="pane-title">{phaseTitle}</div>
      {readOnly && <div className="src-tip">{legacyNotice || '此报告由旧版本生成，仅支持查看导出'}</div>}

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
          disabled={importLocked}
          style={{ display: 'none' }}
          accept=".png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.avif,.heic,.heif,.xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,.pdf,.doc,.docx,.pptx,.md,.markdown,.txt,.log,.yaml,.yml,.rtf,.json,.jsonl,.ndjson,.html,.htm,.xml,.zip"
          onChange={(e) => {
            if (e.target.files?.length) void addSources(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={folderRef}
          type="file"
          multiple
          disabled={importLocked}
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void addSources(e.target.files)
            e.target.value = ''
          }}
        />
        {sources.length === 0 ? (
          <div className="upload-welcome">
            <div className="welcome-kicker">AI 经营研究室</div>
            <h1>上传资料，系统帮你完成经营分析</h1>
            <p className="welcome-intro">
              请尽量上传自营产品和竞品的以下五类资料。不必一次全部备齐，现有资料直接上传即可；资料越完整，分析越准确。
            </p>
            <div className="welcome-actions">
              <button className="btn primary big" disabled={importLocked} onClick={() => fileRef.current?.click()}>
                上传资料
              </button>
              <button className="btn big" disabled={importLocked} onClick={() => folderRef.current?.click()}>
                上传整个文件夹
              </button>
            </div>
            <div className="welcome-file-note">
              <strong>最多上传 50 份，资料总量不超过 350MB</strong>
              <span>图片：单张不超过 25MB</span>
              <span>Excel/ODS/CSV/TSV、PDF、DOC/DOCX、PPTX、Markdown/TXT/RTF、JSON/YAML、HTML/XML、ZIP：单个不超过 40MB</span>
              <span>TIFF/AVIF/HEIC 会在软件内自动转成图片；扫描 PDF 会自动逐页转图，不用用户手动转换</span>
            </div>
            <section className="source-guide" aria-labelledby="source-guide-title">
              <div className="source-guide-heading">
                <h2 id="source-guide-title">建议上传这五类资料</h2>
                <span>自营和竞品资料尽可能都上传</span>
              </div>
              <div className="source-guide-grid">
                <article className="source-guide-item">
                  <span className="source-guide-index" aria-hidden="true">01</span>
                  <div>
                    <h3>产品与供给资料</h3>
                    <p>产品手卡、规格参数、成本、材质、工艺、资质背书，以及可以合法使用的卖点证明。</p>
                  </div>
                </article>
                <article className="source-guide-item">
                  <span className="source-guide-index" aria-hidden="true">02</span>
                  <div>
                    <h3>经营与交易数据</h3>
                    <p>各平台的销售额、订单量、退款、流量和转化数据，用来判断增长来源与低效环节。</p>
                  </div>
                </article>
                <article className="source-guide-item">
                  <span className="source-guide-index" aria-hidden="true">03</span>
                  <div>
                    <h3>内容素材与表现数据</h3>
                    <p>自营和竞品的图片、视频、文案及素材数据，包括播放、消耗、成交和转化表现。</p>
                  </div>
                </article>
                <article className="source-guide-item">
                  <span className="source-guide-index" aria-hidden="true">04</span>
                  <div>
                    <h3>人群与行为画像</h3>
                    <p>各平台的购买人群、成交画像和消费行为，用来分析谁在什么场景下购买，以及为什么购买。</p>
                  </div>
                </article>
                <article className="source-guide-item source-guide-item-wide">
                  <span className="source-guide-index" aria-hidden="true">05</span>
                  <div>
                    <h3>用户声音与反馈</h3>
                    <p>各平台的商品评价、售后反馈和直播评论，用来提炼核心痛点、购买理由和拒绝购买的原因。</p>
                  </div>
                </article>
              </div>
            </section>
          </div>
        ) : (
          <div className="src-strip-head">
            <span>
              资料源（{uploadedFileCount} 个文件
              {scopeStats.worksheets ? `，${scopeStats.worksheets} 个工作表` : ''}
              {scopeStats.pages ? `，${scopeStats.pages} 页` : ''}
              {scopeStats.images ? `，${scopeStats.images} 张图片` : ''}
              {scopeStats.records ? `，${scopeStats.records} 条记录` : ''}
              {derivedCount ? `，${derivedCount} 项派生证据` : ''}）
            </span>
            <button className="btn xs" disabled={importLocked} onClick={() => fileRef.current?.click()}>
              ＋ 文件
            </button>
            <button className="btn xs" disabled={importLocked} onClick={() => folderRef.current?.click()}>
              ＋ 文件夹
            </button>
          </div>
        )}
        {sources.length > 0 && (
          <>
            <div className="src-tip">归属只能二选一：自有数据 / 竞品数据；平台、信息类型和补充说明都是选填。被忽略或解析失败的文件不会参与分析。</div>
            {unconfirmedCount > 0 && (
              <div className="src-bulk-attribution">
                <span>
                  {parsingCount
                    ? `还有文件正在读取，全部完成后可批量确认（当前 ${unconfirmedCount} 份待确认）`
                    : `还有 ${unconfirmedCount} 份可用资料未确认归属`}
                </span>
                <button
                  className="btn xs"
                  type="button"
                  disabled={importLocked}
                  title={parsingCount ? '请等待全部文件读取完成' : undefined}
                  onClick={() => confirmAllUnassigned('自有数据')}
                >
                  未确认项全部设为自有
                </button>
                <button
                  className="btn xs"
                  type="button"
                  disabled={importLocked}
                  title={parsingCount ? '请等待全部文件读取完成' : undefined}
                  onClick={() => confirmAllUnassigned('竞品数据')}
                >
                  未确认项全部设为竞品
                </button>
              </div>
            )}
            <div className="src-list">
              {sources.map((s) => (
                <div className="src-row" key={s.id}>
                  <div className="src-row-top">
                    {s.kind === 'image' && s.dataUrl ? (
                      <img className="src-thumb" src={s.dataUrl} alt="" />
                    ) : (
                      <span className="src-ico">{s.parsing ? '⏳' : s.error ? '⚠️' : '📄'}</span>
                    )}
                    <span className="src-name" title={s.error || s.name}>
                      {s.name}
                    </span>
                    <button
                      className="x"
                      type="button"
                      disabled={importLocked}
                      aria-label={`删除资料 ${s.name}`}
                      onClick={() => {
                        if (
                          phase !== 'idle' &&
                          !window.confirm('删除这份资料后，需要重新生成分析。上一份完整报告仍会保留。确定删除吗？')
                        ) {
                          return
                        }
                        removeSource(s.id)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="src-meta-row">
                    <div className="src-attr-toggle" aria-label="资料归属">
                      {(['自有数据', '竞品数据'] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          disabled={importLocked}
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
                      placeholder="平台/来源（选填）"
                      value={s.platform ?? ''}
                      disabled={importLocked}
                      onChange={(e) => setSourcePlatform(s.id, e.target.value)}
                    />
                    <select
                      className="src-select"
                      aria-label="业务资料类型"
                      value={s.kindV1 ?? ''}
                      disabled={importLocked}
                      onChange={(e) => setSourceKindV1(s.id, e.target.value as SourceKindV1)}
                    >
                      <option value="">选择资料类型（必选）</option>
                      <option value="product-supply">产品与供给资料</option>
                      <option value="business-data">经营与交易数据</option>
                      <option value="material-data">内容素材与表现数据</option>
                      <option value="audience-data">人群与行为画像</option>
                      <option value="voice-data">用户声音与反馈</option>
                    </select>
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
                    placeholder="补充说明（选填）：如 这是视频号近30天成交人群截图"
                    value={s.note ?? ''}
                    disabled={importLocked}
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
                  已处理 {processedCount}/{sources.length}；可分析 {parsedCount}
                  {sources.length - parsingCount - parsedCount ? `，失败/忽略 ${sources.length - parsingCount - parsedCount}` : ''}
                  {parsingCount ? `，解析中 ${parsingCount}` : ''}
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
                  {cleaningProgress.failed ? `，${cleaningProgress.failed} 份待重试` : ''}
                </span>
              </div>
              <div className="progress-track">
                <div style={{ width: `${cleanPercent}%` }} />
              </div>
              {cleaningProgress.running.length > 0 && (
                <div className="progress-running">
                  {cleaningProgress.failed
                    ? `异常后正在收尾已启动任务：${cleaningProgress.running.join('、')}；完成后会暂停`
                    : `正在清洗：${cleaningProgress.running.join('、')}`}
                </div>
              )}
              {cleaningProgress.plan && (
                <details className="cleaning-plan-summary">
                  <summary>
                    本机处理 {cleaningProgress.plan.localFileCount} 份 · AI理解 {cleaningProgress.plan.modelFileCount} 份 · 预计 {cleaningProgress.plan.expectedModelJobs} 个AI任务
                  </summary>
                  <div className="cleaning-plan-files">
                    {Object.entries(cleaningProgress.files).map(([id, file]) => {
                      const method = file.method === 'local_exact'
                        ? '本机'
                        : file.method === 'model_vision'
                          ? '图片识别'
                          : file.method === 'model_semantic'
                            ? 'AI理解'
                            : '不可用'
                      const status = file.status === 'complete'
                        ? '已完成'
                        : file.status === 'failed'
                          ? '待重试'
                          : file.status === 'running'
                            ? `处理中 ${file.doneJobs}/${file.totalJobs}`
                            : file.status === 'not_started'
                              ? '尚未启动'
                              : '等待中'
                      return <div key={id}><span>{file.name}</span><em>{method} · {status}</em></div>
                    })}
                  </div>
                </details>
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
              <em>{confirmedAttributionCount}/{parsedCount} 归属已确认</em>
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
            {sources.map((s) => {
              const usable = Boolean(s.dataUrl || s.text)
              return (
                <div className="checkpoint-row" key={s.id}>
                  <span title={s.name}>{s.name}</span>
                  <b>{usable ? s.attribution || '待确认' : '无需确认'}</b>
                  <b>{usable ? s.platform || '平台（选填）' : '—'}</b>
                  <b>{usable ? sourceKindLabel(s.kindV1, s.purpose || '') || '资料类型待选择' : '—'}</b>
                  <em>
                    {s.parsing
                      ? '解析中'
                      : s.error
                        ? s.error.startsWith('已忽略')
                          ? '已忽略'
                          : '解析失败'
                        : usable
                          ? '可分析'
                          : '待处理'}
                  </em>
                </div>
              )
            })}
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
      <div
        className="messages"
        ref={messagesRef}
        onScroll={() => {
          const element = messagesRef.current
          if (!element) return
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
        }}
      >
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
            <button
              className="btn primary big"
              disabled={!hasUsable || parsingCount > 0 || unconfirmedCount > 0 || unconfirmedKindCount > 0}
              onClick={() => void startGeneration()}
            >
              {parsingCount > 0
                ? `正在读取资料（还有 ${parsingCount} 份）`
                : unconfirmedCount > 0
                  ? `请先确认 ${unconfirmedCount} 份资料归属`
                  : unconfirmedKindCount > 0
                    ? `请先选择 ${unconfirmedKindCount} 份资料类型`
                  : '开始生成报告'}
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
            disabled={sending}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                e.preventDefault()
                void onSend()
              }
            }}
          />
          <button className="btn" disabled={sending || !text.trim()} onClick={() => void onSend()}>
            {sending ? '处理中…' : '发送'}
          </button>
        </div>
        {sendError && <div className="src-err" role="alert">{sendError}</div>}
      </div>
    </div>
  )
}
