# 产品经营报告 桌面 App

把「产品经营报告」这套 SOP 能力做成本地桌面软件：手动上传自有/竞品/素材数据，自动完成清洗与分析，在资料整理和报告初稿两个节点由用户确认，生成可讲解、可落地的产品经营报告。

- 形态：Electron + React + TypeScript 桌面应用（Windows + Mac）
- 模型：OpenAI 兼容、可自定义多家（设置里填 base URL / key / 模型名 / 是否读图）
- 数据：手动上传截图 / CSV / XLSX / PDF / Word / PPTX / Markdown / TXT / ZIP
- 交互：对话主体 + SOP 进度侧栏；两次简单确认；支持新建分析和恢复上一份
- 输出：Markdown + Word（飞书推送二期接）

详见 [docs/架构设计文档.md](docs/架构设计文档.md)。

## 开发

```bash
npm install        # 安装依赖（含 Electron 二进制）
npm run dev        # 启动开发模式（electron-vite）
npm run typecheck  # 类型检查
npm run test:regression # 核心异常回归检查
npm run build      # 构建
npm run dist:mac   # 打包 macOS dmg
npm run dist:win   # 打包 Windows nsis
```

## 当前能力

- [x] Electron + Vite + React 工程骨架
- [x] 主进程：设置加密存储（safeStorage）+ OpenAI 兼容模型客户端（流式 + 读图）
- [x] preload 桥接（getSettings / saveSettings / testModel / sendChat）
- [x] 三栏 UI：SOP 进度侧栏 + 对话 + 报告预览
- [x] 设置弹窗：配置模型、测试连通、测试读图
- [x] 文件解析、ZIP 安全检查、图片压缩、异常编码处理
- [x] SOP 编排、两次确认、停止与断网回滚、Word/网页/纯文本导出
- [x] 自动保存、关闭前强制保存、新建分析、恢复上一份完整分析
- [x] 激活记录、设置、项目和导出文件的原子保存/备份保护

发版前请执行 `npm run typecheck`、`npm run test:regression`、`npm run build`，并按 [小白用户发版测试清单](docs/小白用户发版测试清单.md) 完成人工验收。

## 目录结构

```
src/
├── main/        主进程：窗口、IPC、设置存储、模型客户端
├── preload/     contextBridge 安全桥接
├── renderer/    React 界面（三栏 + 设置）
└── shared/      主/渲染共享类型与 SOP 步骤定义
assets/skill/    SKILL.md / SOP.md（提示词与规则来源）
docs/            架构设计文档
```
