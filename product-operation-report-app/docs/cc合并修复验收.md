# 《cc合并》修复验收记录

更新时间：2026-08-19  
当前分支：`codex/license-protocol-v2-client`  
当前提交：`fadb014998a20ccb07ff2797cc31ca408b30188e`

## 验收原则

- 本文逐项对应 `cc合并.txt` 的 23 个条目，不以“构建成功”替代功能证据。
- 自动化结果只能证明测试覆盖到的范围。需要真实模型费用、人工断网或手工破坏文件的项目单独列出。
- 本次手动触发的 GitHub Actions 只验证三平台构建，不发布 Release，也不修改自动更新配置。

## 自动化总结果

| 检查 | 结果 | 证据 |
|---|---|---|
| TypeScript 类型检查 | 通过 | `pnpm run typecheck` |
| ESLint | 通过 | `pnpm run lint` |
| Vitest | 2 个文件、5 个测试通过 | `pnpm run test:unit` |
| Electron 核心回归 | 通过 | `pnpm run test:regression`，CI 无界面模式也通过 |
| 服务端代理测试 | 37 项通过 | `python -m unittest -v test_proxy.py` |
| 生产构建 | 通过 | `pnpm run build` |
| 安装包秘密扫描 | 三平台通过 | GitHub Actions run `32237242646` |
| Windows x64 运行时检查 | 通过 | GitHub Actions job `96019850388` |
| macOS Apple Silicon 运行时检查 | 通过 | GitHub Actions job `96019850140` |
| macOS Intel 运行时检查 | 通过 | GitHub Actions job `96019850312` |
| 服务端健康检查 | 通过 | `/api/product-operation-report/v1/health` 返回 `ok: true` |

## 23 项逐条证据

| # | 状态 | 当前实现与权威证据 |
|---:|:---:|---|
| 1 | 完成 | `sourceCleanBatches.ts` 对 `table_rows` 输出按 CSV 解析，要求首列 `__证据ID`、每个 ID 恰好出现一次且位于有效数据行；提示词不再额外列出答案纸。`sourceCleanBatches.test.ts` 和核心回归覆盖合法行、末尾抄 ID、缺行三类情况。清洗版本已升级为 `source-clean-v8-row-anchored-evidence`。 |
| 2 | 完成 | `activation.ts` 使用 `RuntimeValidationState` 区分服务器明确拒绝与临时不可达。临时不可达保留 72 小时内最近一次成功验证，`unauthorized`、`unbound`、协议错误会立即清除验证状态。 |
| 3 | 完成 | `index.ts` 的授权刷新由主进程 gate 和 60 秒节流保护；聊天完成后只刷新代理钱包，不再为每次模型调用写授权文件。 |
| 4 | 完成 | `aiProxy.ts` 已接入真实 `/wallet`；正式余额、流水、报告扣费均来自代理钱包。401 会刷新代理会话后重试，网络失败只回退带 `stale` 标记的内存快照。积分面板显示最近流水。服务端流水使用中文任务说明。 |
| 5 | 完成 | `sourceCleanBatches.ts` 返回 `quotes`、`too_few_rows`、`too_wide` 降级原因；资料卡保留并显示用户可理解的核对提示。 |
| 6 | 完成 | `project.ts` 遇到单个 blob 缺失时返回占位内容和 `missingBlobs`，其余项目继续恢复；渲染层提示需要重新上传的资料。 |
| 7 | 完成 | `sanitizeSource()` 已保留 `warning`，保存与恢复往返测试覆盖该字段。 |
| 8 | 完成 | `tokenUsage.ts` 在 48MB 轮转当前日志；读取超限文件不再抛出不可恢复异常；去重 ID 集随轮转重置。 |
| 9 | 完成 | 分批清洗跳过 `compactSourceText`；批次和来源文本阈值使用共享约束并有回归断言。 |
| 10 | 完成 | `.github/workflows/build-desktop.yml` 在三平台矩阵中运行类型检查、Lint、Vitest、核心回归、更新流程检查、HTML 视觉检查和安装包秘密扫描。run `32237242646` 三平台全部成功。 |
| 11 | 完成 | 清洗批次检查点改为 500ms 防抖保存，同一时间窗内的并发完成事件合并写盘。 |
| 12 | 完成 | 大表格只做一次结构化解析，批次生成复用解析结果。 |
| 13 | 完成 | 分析证据分组不再在步骤循环内重复计算。 |
| 14 | 完成 | 孤儿 blob 在启动后延迟 30 秒回收；只有当前项目和上一项目两个清单都可读取时才删除差集。 |
| 15 | 完成 | 已删除 `sourceForModel`、`buildCleanMessages`、无调用方 license IPC/preload 以及内置激活码哈希死路径。 |
| 16 | 完成 | 完整报告缓存容量提高到 100MB，条目数仍限制为 20。 |
| 17 | 完成 | `store/analysis.ts` 在 8 步分析前构造一次通用 evidence digest，写入 task journal；8 步统一复用并保留证据锚点。 |
| 18 | 完成 | `model.ts` 支持 OpenAI 兼容 `prompt_cache_key` 和 Anthropic `cache_control`，400/422 时只在无输出情况下去掉扩展重试。代理透传受控缓存键，计费继续读取供应商真实 `cached_tokens`。 |
| 19 | 完成 | 渲染层解析并发为 2；`parseService.ts` 使用两个受控 utility process worker，并保留任务数和字节数背压。 |
| 20 | 完成 | `pointsWallet.ts` 已删除；正式积分和价格只由服务端代理负责，客户端没有第二套本地价格表和扣费账本。 |
| 21 | 完成 | 状态逻辑已拆出 `store/errors.ts`、`store/persistence.ts`、`store/analysis.ts`；联系入口与钱包样式拆到 `styles/contact-wallet.css`。 |
| 22 | 完成 | 已加入 `eslint.config.mjs`、`.editorconfig`、Vitest 测试及 CI 门禁。依赖锁文件固定版本，运行时依赖审计无已知高危漏洞。 |
| 23 | 完成 | 清洗和分析阶段显示进度及预计剩余时间；离线宽限使用黄色可继续提示，授权失效使用红色阻断提示。 |

## 真实成本对比状态

此项尚未执行，不能以纯函数测试或构建结果代替。

已找到同一产品的一组真实资料候选：IQGD 鞋垫的商品列表、成交画像、商品评论、三份店铺数据、自营和竞品素材数据、产品 PPT。正式对比需要：

1. 在 `v0.3.9` 基线与 `v0.4.0` 当前版本中使用完全相同的资料和标注。
2. 两次都清空 `source-clean-cache`，避免本地命中造成失真。
3. 记录请求次数、`inputTokens`、`outputTokens`、`cachedInputTokens`、总积分和真实人民币成本。
4. 两次完整报告都会调用真实模型并产生费用。执行前必须得到费用授权，并确认测试钱包积分足够。

在该对比完成前，只能确认代码路径、真实缓存协议和三平台构建已通过，不能宣称完整报告的最终成本目标已经实测达成。

## 发布状态

- 当前分支已推送到 GitHub。
- 本次 CI 仅生成临时构建产物，没有创建 Release，没有上传更新服务器，没有向用户推送自动更新。
- 正式发布前仍需完成上面的真实成本对比，并按 `docs/小白用户发版测试清单.md` 做人工验收。
