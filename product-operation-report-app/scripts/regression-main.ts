import { strict as assert } from 'node:assert'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, safeStorage } from 'electron'
import JSZip from 'jszip'
import Papa from 'papaparse'
import iconv from 'iconv-lite'
import * as XLSX from 'xlsx'
import type { SavedProject } from '../src/shared/types'
import { parseArchive, parseFile } from '../src/main/ingest'
import { chatStream, listModels, normalizeProviderUsage, testModel } from '../src/main/model'
import { archiveProject, loadLastProject, preflightProjectStorage, pruneOrphanBlobs, saveLastProject } from '../src/main/project'
import {
  activateWithCode,
  activationInternals,
  canStartLicensedAnalysis,
  deactivateCurrentDevice,
  getActivationStatus,
  getActivationStatusWithServerCheck,
  getDeviceId,
  revalidateSavedActivationCode,
  restoreAuthorizationOnStartup,
  revealCurrentActivationCode,
  redeemPointsWithCode
} from '../src/main/activation'
import { inspectLicenseVault, writeLicenseVault } from '../src/main/licenseVault'
import { buildActivationDiagnostic } from '../src/main/activationDiagnostics'
import { clearAiProxySession, clearProxyWalletSnapshot, fetchProxyWallet } from '../src/main/aiProxy'
import { ExclusiveOperationGate } from '../src/main/exclusiveOperationGate'
import {
  getActiveProfile,
  getActiveProfiles,
  loadRendererSettings,
  loadSettings,
  saveRendererSettings,
  saveSettings
} from '../src/main/settings'
import { getManagedModelState, managedModelInternals } from '../src/main/managedModel'
import { profilesForTask, runModelFallbackSequence, shouldTryModelFallback } from '../src/main/modelFallback'
import {
  ChatRequestRegistry,
  validateChatStartPayload
} from '../src/main/chatAdmission'
import { readBundledSopRules } from '../src/main/sopRules'
import { checkForUpdates, compareVersions, downloadUpdate } from '../src/main/updater'
import { canonicalUpdateManifest, verifyUpdateManifestSignature } from '../src/main/updateSignature'
import {
  contactInternals,
  getCachedContactState,
  refreshContactConfig
} from '../src/main/contact'
import {
  appendTokenUsageRecord,
  buildTokenUsageDashboard,
  classifyModelFailure,
  estimateRequestTokens,
  readTokenUsageRecords,
  sanitizeModelTaskContext,
  tokenUsageInternals,
  tokenUsageLogPath
} from '../src/main/tokenUsage'
import {
  clearSourceCleanCache,
  getSourceCleanCacheStats,
  lookupSourceCleanCache,
  sourceCleanCacheInternals,
  sourceCleanCacheKey,
  storeSourceCleanCache
} from '../src/main/sourceCleanCache'
import {
  clearReportResultCache,
  getReportResultCacheStats,
  lookupReportResultCache,
  reportResultCacheInternals,
  reportResultCacheKey,
  storeReportResultCache
} from '../src/main/reportResultCache'
import {
  appendCostOptimizationEvent,
  costOptimizationInternals,
  costOptimizationLogPath,
  getTokenOptimizationMetrics
} from '../src/main/costOptimization'
import {
  buildHtmlReportPresentation,
  markdownToHtmlDocument,
  parseHtmlReportModel,
  sanitizeHtmlFragment,
  stripProductVisualBrief
} from '../src/main/htmlReport'

import {
  buildProjectSnapshot,
  friendlyError,
  inspectImageHeader,
  MAX_CLEANING_CONCURRENCY,
  mergeRevisionParts,
  priorOutputsForStep,
  selectRevisionParts,
  useStore
} from '../src/renderer/src/store'
import {
  buildExtractMessages,
  buildEvidenceDigestMessages,
  buildFinalReportPartMessages,
  buildSummaryGroupMessages,
  buildSummaryMergeMessages,
  buildStepMessages,
  buildSummaryMessages,
  COMPACT_RUNTIME_RULES,
  planAnalysisEvidenceGroups,
  planSummaryDetailGroups
} from '../src/renderer/src/sop'
import { FINAL_REPORT_PARTS } from '../src/renderer/src/reportTemplate'
import { buildLocalTableCleanDetail, preprocessTableForModel } from '../src/renderer/src/tablePreprocess'
import {
  buildSourceCleanBatchPlan,
  combineSourceCleanBatchOutputs,
  sourceCleanBatchInternals
} from '../src/renderer/src/sourceCleanBatches'
import { REPORT_MODULES_V2 } from '../src/shared/types'
import type { ChatStreamEvent, ModelProfile, TokenUsageRecord } from '../src/shared/types'

function encryptV032StoredCode(code: string, deviceId: string): string {
  const key = createHash('sha256')
    .update(`product-operation-report:server-code:v1:${deviceId}`, 'utf8')
    .digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

function deviceSessionForTest(codeId: string, machineCode: string, expiresAtSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({
    app_name: 'ProductOperationReport',
    code_id: codeId,
    machine_code: machineCode,
    exp: expiresAtSeconds
  }), 'utf8').toString('base64url')
  return `DVS1.${payload}.test-signature`
}

const tempUserData = mkdtempSync(join(tmpdir(), 'por-regression-'))
app.disableHardwareAcceleration()
app.setPath('userData', tempUserData)
let topbarAuditWindow: BrowserWindow | null = null

function snapshot(revision: number, reportMarkdown: string): SavedProject {
  return {
    revision,
    sources: [],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown,
    reportStale: false,
    phase: reportMarkdown ? 'done' : 'idle',
    steering: '',
    updatedAt: new Date().toISOString()
  }
}

async function testProjectRevisionAndBackup(): Promise<void> {
  await saveLastProject(snapshot(1, '旧报告'))
  await saveLastProject(snapshot(2, ''))
  await saveLastProject(snapshot(1, '迟到的旧快照'))
  assert.equal((await loadLastProject())?.revision, 2)
  assert.equal((await loadLastProject())?.reportMarkdown, '')

  writeFileSync(join(tempUserData, 'last-project.json'), '{broken', 'utf8')
  assert.equal((await loadLastProject())?.revision, 2)
  assert.equal((await loadLastProject())?.reportMarkdown, '')

  writeFileSync(join(tempUserData, 'last-project.json'), '{}', 'utf8')
  assert.equal((await loadLastProject())?.revision, 2)

  writeFileSync(join(tempUserData, 'last-project.json'), JSON.stringify(snapshot(3, '主文件')), 'utf8')
  writeFileSync(join(tempUserData, 'last-project.json.bak'), JSON.stringify(snapshot(5, '更新备份')), 'utf8')
  assert.equal((await loadLastProject())?.revision, 5)
  assert.equal((await loadLastProject())?.reportMarkdown, '更新备份')
  const billingSnapshot = { ...snapshot(6, 'billing-id'), analysisSessionId: 'stable-billing-session' }
  await saveLastProject(billingSnapshot)
  assert.equal((await loadLastProject())?.analysisSessionId, 'stable-billing-session', 'crash recovery preserves stable billing ids')
  const migratedSnapshot: SavedProject = {
    ...snapshot(7, '# 产品与内容经营报告'),
    engineVersion: 'v2',
    legacyEngineVersion: 'v1',
    legacyArtifacts: { 4: '旧版对标', 5: '旧版卖点', 7: '旧版排序' },
    legacyReportMarkdown: '# 旧版八模块报告',
    legacyBenchmarkAppendix: '旧版对标'
  }
  await saveLastProject(migratedSnapshot)
  const restoredMigration = await loadLastProject()
  assert.equal(restoredMigration?.engineVersion, 'v2')
  assert.equal(restoredMigration?.legacyEngineVersion, 'v1')
  assert.equal(restoredMigration?.legacyArtifacts?.[7], '旧版排序')
  assert.equal(restoredMigration?.legacyBenchmarkAppendix, '旧版对标')

  const largeText = `中段唯一证据-${'资料'.repeat(50_000)}-最后唯一证据`
  const chunkedSnapshot: SavedProject = {
    ...snapshot(8, ''),
    sources: [{
      id: 'large-source',
      name: '大项目资料.md',
      kind: 'doc',
      text: largeText,
      warning: '表格分隔结构不规则，请重点核对。',
      topLevelId: 'large-source'
    }],
    taskJournal: {
      'session:source_clean:large-source:1': {
        kind: 'source_clean',
        status: 'complete',
        output: `POR-T-12345678-000001\n${largeText}`,
        updatedAt: new Date().toISOString()
      }
    }
  }
  const preflight = preflightProjectStorage(chunkedSnapshot)
  assert.equal(preflight.ok, true, preflight.message)
  await saveLastProject(chunkedSnapshot)
  const manifest = readFileSync(join(tempUserData, 'last-project.json'), 'utf8')
  assert.match(manifest, /"storageVersion": 2/u)
  assert.doesNotMatch(manifest, /中段唯一证据/u, 'large project content is externalized from the small manifest')
  const restoredChunked = await loadLastProject()
  assert.equal(restoredChunked?.sources[0]?.text, largeText)
  assert.equal(restoredChunked?.sources[0]?.warning, '表格分隔结构不规则，请重点核对。')
  assert.equal(restoredChunked?.taskJournal?.['session:source_clean:large-source:1']?.output?.endsWith(largeText), true)
  const parsedManifest = JSON.parse(manifest) as { project: { sources: { text: { $blob: string } }[] } }
  const missingBlobPath = join(tempUserData, 'project-data', 'blobs', `${parsedManifest.project.sources[0].text.$blob}.txt`)
  rmSync(missingBlobPath, { force: true })
  const partiallyRestored = await loadLastProject()
  assert.ok(partiallyRestored, 'one missing blob must not erase the whole project')
  assert.match(partiallyRestored?.sources[0]?.text || '', /资料块丢失/u)
  assert.deepEqual(partiallyRestored?.missingBlobs, ['大项目资料.md'])
  await saveLastProject({ ...chunkedSnapshot, revision: 9, updatedAt: new Date().toISOString() })
  await archiveProject(snapshot(9, '上一份项目'))
  const orphanBlob = join(tempUserData, 'project-data', 'blobs', `${'f'.repeat(64)}.txt`)
  writeFileSync(orphanBlob, 'orphan', 'utf8')
  const pruned = await pruneOrphanBlobs()
  assert.deepEqual(pruned, { skipped: false, deleted: 1 })
  assert.equal(existsSync(orphanBlob), false)
}

async function testDeviceIdentityPersistsAcrossAuthorizationReset(): Promise<void> {
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const deviceVault = join(tempUserData, 'device-vault.bin')
  const deviceVaultBackup = `${deviceVault}.bak`
  const files = [
    activationFile,
    activationBackup,
    licenseVault,
    licenseVaultBackup,
    deviceVault,
    deviceVaultBackup
  ]
  try {
    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetDeviceIdentityForTests()
    const compatible = activationInternals.compatibleDeviceIdsForTests()
    const canonical = compatible[0]
    const historical = compatible.find((deviceId) => deviceId !== canonical)
    assert.ok(historical, 'the migration test requires a historical compatible machine code')

    const historicalRecord = {
      version: 3,
      appName: 'ProductOperationReport',
      source: 'server',
      codeHash: createHash('sha256').update('historical-device-code').digest('hex'),
      deviceId: historical,
      activatedAt: new Date().toISOString(),
      licenseId: 'historical-device-license',
      licenseType: 'credits',
      unlimited: false,
      creditsRemaining: 100,
      bindingStatus: 'active'
    }
    writeFileSync(activationFile, JSON.stringify(historicalRecord), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(historicalRecord), 'utf8')

    activationInternals.resetDeviceIdentityForTests()
    assert.equal(getDeviceId(), historical, 'an existing server binding keeps its historical machine code')
    assert.equal(existsSync(deviceVault), true, 'the selected machine code is persisted separately from authorization')

    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
    rmSync(licenseVault, { force: true })
    rmSync(licenseVaultBackup, { force: true })
    activationInternals.resetDeviceIdentityForTests()
    assert.equal(
      getDeviceId(),
      historical,
      'clearing or unbinding authorization must not change the physical device identity'
    )
    activationInternals.setSystemMachineIdForTests('temporarily-different-system-id')
    assert.equal(
      getDeviceId(),
      historical,
      'the encrypted device vault wins over a transiently different hardware query'
    )
    activationInternals.resetDeviceIdentityForTests()
    assert.equal(getDeviceId(), historical, 'a simulated application restart keeps the same machine code')
  } finally {
    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetDeviceIdentityForTests()
  }
}

async function testHistoricalCredentialRefreshRetry(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const files = [activationFile, activationBackup, licenseVault, licenseVaultBackup]
  const enteredCode = 'HISTORICAL-CREDENTIAL-REFRESH-CODE'
  const requestBodies: Record<string, unknown>[] = []
  try {
    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    const deviceId = getDeviceId()
    const staleRecord = {
      version: 3,
      appName: 'ProductOperationReport',
      source: 'server',
      codeHash: createHash('sha256').update('different-stale-local-code').digest('hex'),
      deviceId,
      activatedAt: new Date().toISOString(),
      licenseId: 'stale-local-license',
      licenseType: 'credits',
      unlimited: false,
      creditsRemaining: 20,
      bindingStatus: 'active',
      requiresRevalidation: true,
      revokedReason: '设备凭证已失效，请重新输入原激活码验证。',
      serverMessage: '设备凭证已失效，请重新输入原激活码验证。'
    }
    writeFileSync(activationFile, JSON.stringify(staleRecord), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(staleRecord), 'utf8')

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      requestBodies.push(body)
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          ok: false,
          error_code: 'credential_refresh_required',
          error: '旧授权首次升级设备凭证时必须设置 credential_refresh=true。'
        }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'recovered-historical-license',
        license_type: 'credits',
        remaining_credits: 100,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: deviceId,
        device_credential: 'recovered-device-credential',
        device_session: 'recovered-device-session',
        message: '历史授权凭证升级成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const recovered = await activateWithCode(enteredCode)
    assert.equal(recovered.ok, true, 'an explicit server credential-upgrade requirement is retried once')
    assert.equal(requestBodies.length, 2)
    assert.equal(requestBodies[0].credential_refresh, undefined)
    assert.equal(requestBodies[1].credential_refresh, true)
    assert.equal(requestBodies[1].confirm_merge, undefined, 'credential recovery must never opt into points merging')
    assert.equal(requestBodies[1].current_code_id, undefined, 'a mismatched stale local id must not be asserted as authority')
    assert.equal(recovered.status.licenseId, 'recovered-historical-license')
    assert.equal(revealCurrentActivationCode().activationCode, enteredCode)

    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    let genericFailureCalls = 0
    globalThis.fetch = (async () => {
      genericFailureCalls += 1
      return new Response(JSON.stringify({ ok: false, error: '激活码无效' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof fetch
    const rejected = await activateWithCode('INVALID-NON-HISTORICAL-CODE')
    assert.equal(rejected.ok, false)
    assert.equal(genericFailureCalls, 1, 'ordinary activation failures must not be retried as credential upgrades')

    let technicalFailureCalls = 0
    globalThis.fetch = (async () => {
      technicalFailureCalls += 1
      return new Response(JSON.stringify({
        ok: false,
        error_code: 'credential_refresh_required',
        error: '旧授权首次升级设备凭证时必须设置 credential_refresh=true。'
      }), { status: 400, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const friendlyFailure = await activateWithCode('TECHNICAL-ERROR-REDACTION-CODE')
    assert.equal(friendlyFailure.ok, false)
    assert.equal(technicalFailureCalls, 2, 'the controlled credential refresh is attempted only once')
    assert.doesNotMatch(friendlyFailure.message, /credential_refresh|\/api\/license/i)
    assert.match(friendlyFailure.message, /旧版授权|设备码/)
  } finally {
    globalThis.fetch = originalFetch
    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

async function testLegacyUpgradeRestoresOnStartup(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const code = 'V026-UPGRADE-PRIMARY-CODE'
  let requestBody: Record<string, unknown> = {}
  try {
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    const deviceId = getDeviceId()
    const oldRecord = {
      version: 2,
      appName: 'ProductOperationReport',
      source: 'server',
      codeHash: createHash('sha256')
        .update(`product-operation-report:activation:v1:${code.replace(/[^A-Z0-9]/g, '')}`, 'utf8')
        .digest('hex'),
      encryptedCode: encryptV032StoredCode(code, deviceId),
      deviceId,
      activatedAt: new Date().toISOString(),
      licenseId: 'v026-upgrade-primary',
      licenseType: 'credits',
      unlimited: false,
      creditsRemaining: 100,
      bindingStatus: 'active'
    }
    writeFileSync(activationFile, JSON.stringify(oldRecord), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(oldRecord), 'utf8')
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'v026-upgrade-primary',
        license_type: 'credits',
        remaining_credits: 100,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: deviceId,
        device_credential: 'v026-upgrade-credential',
        device_session: deviceSessionForTest('v026-upgrade-primary', deviceId, Math.floor(Date.now() / 1_000) + 30 * 86400),
        action: 'already_bound',
        grant_score: 0
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const restored = await restoreAuthorizationOnStartup()
    assert.equal(restored.activated, true, 'a v0.2.6-style encrypted record upgrades without retyping its code')
    assert.equal(requestBody.credential_refresh, true)
    assert.equal(requestBody.current_code_id, 'v026-upgrade-primary')
    assert.equal(requestBody.confirm_merge, undefined)
    assert.equal(restored.authorizationState, 'active')
  } finally {
    globalThis.fetch = originalFetch
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

async function testSavedActivationRecovery(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const files = [activationFile, activationBackup, licenseVault, licenseVaultBackup]
  const savedCode = 'SAVED-PRIMARY-RECOVERY-CODE'
  try {
    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    writeLicenseVault({ activationCode: savedCode })
    const waiting = getActivationStatus()
    assert.equal(waiting.activated, false)
    assert.equal(waiting.activationCodeAvailable, true, 'an orphaned secure code must remain recoverable')
    assert.equal(waiting.requiresRevalidation, true)
    assert.equal(waiting.maskedActivationCode?.includes('SAVE'), true)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      app_name: 'ProductOperationReport',
      code_id: 'saved-recovery-primary',
      license_type: 'credits',
      remaining_credits: 80,
      unlimited: false,
      binding_status: 'active',
      transfer_count: 0,
      machine_code: getDeviceId(),
      device_credential: 'saved-recovery-credential',
      device_session: 'saved-recovery-session',
      message: '重新验证成功'
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    const recovered = await revalidateSavedActivationCode()
    assert.equal(recovered.ok, true)
    assert.equal(recovered.status.activated, true)
    assert.equal(recovered.status.creditsRemaining, 80)
    assert.equal('activationCode' in recovered, false, 'the saved code must not be returned to the renderer')

    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    writeLicenseVault({
      activationCode: savedCode,
      deviceCredential: 'existing-recovery-credential',
      deviceSession: 'existing-recovery-session'
    })
    let recoveryBody: Record<string, unknown> = {}
    let recoveryHeaders = new Headers()
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      recoveryBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      recoveryHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'saved-recovery-primary',
        license_type: 'credits',
        remaining_credits: 80,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: getDeviceId(),
        device_credential: 'rotated-recovery-credential',
        device_session: 'rotated-recovery-session',
        message: '已有凭证重新验证成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const credentialRecovered = await revalidateSavedActivationCode()
    assert.equal(credentialRecovered.ok, true)
    assert.equal(recoveryBody.credential_refresh, true)
    assert.equal(recoveryBody.current_code_id, undefined, 'missing public summary must not invent a code id')
    assert.equal(recoveryBody.confirm_merge, undefined)
    assert.equal(recoveryHeaders.get('authorization'), 'Bearer existing-recovery-session')
    assert.equal(recoveryHeaders.get('x-device-credential'), 'existing-recovery-credential')
    assert.equal(revealCurrentActivationCode().activationCode, savedCode)
  } finally {
    globalThis.fetch = originalFetch
    for (const file of files) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

function testSecureVaultBackupAndCorruptionGuard(): void {
  const vaultFile = join(tempUserData, 'license-vault.bin')
  const vaultBackup = `${vaultFile}.bak`
  try {
    for (const file of [vaultFile, vaultBackup]) rmSync(file, { force: true })
    writeLicenseVault({
      version: 2,
      appName: 'ProductOperationReport',
      licenseId: 'vault-backup-primary',
      machineCode: getDeviceId(),
      activationCode: 'VAULT-BACKUP-CODE',
      deviceCredential: 'vault-backup-credential',
      deviceSession: 'vault-backup-session'
    })
    const backupBytes = readFileSync(vaultBackup)
    writeFileSync(vaultFile, 'broken-primary-vault', 'utf8')
    const recovered = inspectLicenseVault()
    assert.equal(recovered.status, 'ready')
    assert.equal(recovered.source, 'backup')
    assert.equal(recovered.value?.activationCode, 'VAULT-BACKUP-CODE')
    assert.deepEqual(readFileSync(vaultFile), backupBytes, 'a readable backup self-heals the primary vault')

    const corruptPrimary = safeStorage.encryptString('broken-primary-vault')
    const corruptBackup = safeStorage.encryptString('broken-backup-vault')
    writeFileSync(vaultFile, corruptPrimary)
    writeFileSync(vaultBackup, corruptBackup)
    const corrupt = inspectLicenseVault()
    assert.equal(corrupt.status, 'corrupt')
    assert.throws(
      () => writeLicenseVault({ activationCode: 'MUST-NOT-OVERWRITE' }),
      /corrupt/i,
      'a corrupt encrypted vault is preserved instead of overwritten'
    )
    assert.deepEqual(readFileSync(vaultFile), corruptPrimary)
    assert.deepEqual(readFileSync(vaultBackup), corruptBackup)
  } finally {
    for (const file of [vaultFile, vaultBackup]) rmSync(file, { force: true })
  }
}

async function testSessionRotationAndExpiredRecovery(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const code = 'SESSION-LIFECYCLE-PRIMARY-CODE'
  const codeId = 'session-lifecycle-primary'
  let mode: 'initial' | 'rotate' | 'expired' | 'recover' = 'initial'
  let lastActivationBody: Record<string, unknown> = {}
  let lastActivationHeaders = new Headers()
  try {
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    const machineCode = getDeviceId()
    const expiringSession = deviceSessionForTest(codeId, machineCode, Math.floor(Date.now() / 1_000) + 3 * 86400)
    const renewedSession = deviceSessionForTest(codeId, machineCode, Math.floor(Date.now() / 1_000) + 30 * 86400)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/device/status')) {
        if (mode === 'expired') {
          return new Response(JSON.stringify({ ok: false, error: '设备会话已过期。' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          code_id: codeId,
          license_type: 'credits',
          remaining_credits: 88,
          unlimited: false,
          binding_status: 'active',
          transfer_count: 0,
          machine_code: machineCode,
          message: 'status active'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      lastActivationBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      lastActivationHeaders = new Headers(init?.headers)
      const session = mode === 'initial' ? expiringSession : renewedSession
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: codeId,
        license_type: 'credits',
        remaining_credits: 88,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: machineCode,
        device_credential: 'session-lifecycle-credential',
        device_session: session,
        action: 'already_bound',
        grant_score: 0,
        message: 'session ready'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const activated = await activateWithCode(code)
    assert.equal(activated.ok, true)
    assert.equal(activated.status.authorizationState, 'session_expiring')

    mode = 'rotate'
    const rotated = await getActivationStatusWithServerCheck()
    assert.equal(rotated.activated, true)
    assert.equal(rotated.authorizationState, 'active')
    assert.equal(lastActivationBody.credential_refresh, true)
    assert.equal(lastActivationBody.confirm_merge, undefined)
    assert.equal(lastActivationBody.current_code_id, codeId)
    assert.equal(lastActivationHeaders.get('authorization'), `Bearer ${expiringSession}`)

    mode = 'expired'
    const expired = await getActivationStatusWithServerCheck()
    assert.equal(expired.activated, false)
    assert.equal(expired.authorizationState, 'session_expired')
    assert.equal(expired.recoveryAction, 'confirm_saved_code')

    mode = 'recover'
    const recovered = await revalidateSavedActivationCode()
    assert.equal(recovered.ok, true)
    assert.equal(lastActivationBody.device_credential, 'session-lifecycle-credential')
    assert.equal(lastActivationBody.credential_refresh, undefined)
    assert.equal(lastActivationBody.confirm_merge, undefined)
    assert.equal(lastActivationHeaders.get('authorization'), null, 'expired sessions are never reused')
    assert.equal(recovered.status.creditsRemaining, 88)
  } finally {
    globalThis.fetch = originalFetch
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

async function testUnboundNeverAutoRebinds(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const code = 'NO-AUTO-REBIND-PRIMARY-CODE'
  let activationCalls = 0
  let unbound = false
  try {
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    const machineCode = getDeviceId()
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/device/status')) {
        if (unbound) {
          return new Response(JSON.stringify({ ok: false, error: '授权当前未绑定设备。' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          code_id: 'no-auto-rebind-primary',
          license_type: 'credits',
          remaining_credits: 66,
          unlimited: false,
          binding_status: 'active',
          transfer_count: 0,
          machine_code: machineCode
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      activationCalls += 1
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'no-auto-rebind-primary',
        license_type: 'credits',
        remaining_credits: 66,
        unlimited: false,
        binding_status: 'active',
        transfer_count: unbound ? 1 : 0,
        machine_code: machineCode,
        device_credential: 'no-auto-rebind-credential',
        device_session: deviceSessionForTest('no-auto-rebind-primary', machineCode, Math.floor(Date.now() / 1_000) + 30 * 86400),
        action: unbound ? 'rebound' : 'activated',
        grant_score: 0
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    assert.equal((await activateWithCode(code)).ok, true)
    unbound = true
    const detected = await getActivationStatusWithServerCheck()
    assert.equal(detected.authorizationState, 'unbound')
    assert.equal(detected.activated, false)
    const beforeStartup = activationCalls
    const afterRestart = await restoreAuthorizationOnStartup()
    assert.equal(afterRestart.authorizationState, 'unbound')
    assert.equal(activationCalls, beforeStartup, 'startup must not call /activate after an administrator unbind')

    const explicit = await revalidateSavedActivationCode()
    assert.equal(explicit.ok, true, 'an explicit user action may rebind the saved primary code')
    assert.equal(activationCalls, beforeStartup + 1)
  } finally {
    globalThis.fetch = originalFetch
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

async function testActivationAdmissionAndSafeDiagnostics(): Promise<void> {
  const gate = new ExclusiveOperationGate()
  let releaseFirst: (() => void) | undefined
  const first = gate.run(
    () => new Promise<string>((resolve) => { releaseFirst = () => resolve('first') }),
    () => 'unexpected-busy'
  )
  const duplicate = await gate.run(async () => 'duplicate-ran', () => 'busy')
  assert.equal(duplicate, 'busy', 'a second activation operation must be rejected before it can run')
  releaseFirst?.()
  assert.equal(await first, 'first')
  assert.equal(await gate.run(async () => 'next', () => 'busy'), 'next', 'the gate releases after completion')

  const diagnostic = buildActivationDiagnostic({
    activated: false,
    deviceId: 'b38301cafa771234567890abcdef1234',
    activationCodeAvailable: true,
    maskedActivationCode: 'PRO-••••-SECRET',
    authorizationState: 'manual_activation_required',
    canAutoRecover: false,
    recoveryAction: 'contact_admin',
    vaultStatus: 'ready',
    codeCount: 1,
    appName: 'ProductOperationReport',
    unlimited: false,
    offline: false,
    requiresRevalidation: true,
    licenseId: 'private-license-id',
    message: 'server echoed PRO-REAL-ACTIVATION-CODE'
  }, '0.3.6', 'win32-x64', '2026-08-17T00:00:00.000Z')
  assert.match(diagnostic, /B38301CAFA77/)
  assert.doesNotMatch(diagnostic, /SECRET|private-license|REAL-ACTIVATION|PRO-/i)
}

async function testActivationAndSettingsBackup(): Promise<void> {
  const deviceId = getActivationStatus().deviceId
  const activationRecord = {
    version: 1,
    codeHash: '0'.repeat(64),
    deviceId,
    activatedAt: new Date().toISOString()
  }
  writeFileSync(join(tempUserData, 'activation.json'), '{broken', 'utf8')
  writeFileSync(join(tempUserData, 'activation.json.bak'), JSON.stringify(activationRecord), 'utf8')
  const activationStatus = getActivationStatus()
  assert.equal(activationStatus.activated, false)
  assert.equal(activationStatus.appName, 'ProductOperationReport')
  assert.equal(activationStatus.source, 'legacy')
  assert.equal(activationStatus.licenseType, 'credits')
  assert.equal(activationStatus.unlimited, false)
  assert.equal(activationStatus.creditsRemaining, undefined)
  assert.equal(activationStatus.offline, false)
  const refreshedLegacyStatus = await getActivationStatusWithServerCheck()
  assert.equal(refreshedLegacyStatus.activated, false, 'local hash lists no longer grant model access')
  assert.equal(refreshedLegacyStatus.source, 'legacy')
  assert.equal(refreshedLegacyStatus.unlimited, false)
  assert.equal(refreshedLegacyStatus.creditsRemaining, undefined)

  const previouslyStoredUnlimited = {
    version: 2,
    appName: 'ProductOperationReport',
    source: 'server',
    codeHash: '0'.repeat(64),
    encryptedCode: '',
    deviceId,
    activatedAt: new Date().toISOString(),
    licenseId: 'old-server-unlimited-id',
    licenseType: 'unlimited',
    unlimited: true,
    usedOperationIds: [],
    lastValidatedAt: new Date().toISOString(),
    offlineUntil: new Date(Date.now() + 72 * 60 * 60 * 1_000).toISOString()
  }
  writeFileSync(join(tempUserData, 'activation.json'), JSON.stringify(previouslyStoredUnlimited), 'utf8')
  const migratedUnlimited = getActivationStatus()
  assert.equal(migratedUnlimited.licenseType, 'unlimited')
  assert.equal(migratedUnlimited.unlimited, true)
  assert.equal(migratedUnlimited.requiresRevalidation, false, 'a recent server validation remains usable during offline grace')
  assert.equal(migratedUnlimited.licenseId, 'old-server-unlimited-id')

  const recoveryCode = 'PRO-LEGACY-RECOVERY-TEST'
  const malformedLegacyRecord = {
    version: 2,
    appName: 'ProductOperationReport',
    source: 'server',
    codeHash: createHash('sha256')
      .update(`product-operation-report:activation:v1:${recoveryCode.replace(/[^A-Z0-9]/g, '')}`, 'utf8')
      .digest('hex'),
    encryptedCode: encryptV032StoredCode(recoveryCode, deviceId),
    deviceId,
    activatedAt: new Date().toISOString(),
    licenseId: 'malformed-v2-recovery-id',
    licenseType: 'credits',
    unlimited: false,
    creditsRemaining: 100,
    bindingStatus: 'active'
  }
  rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
  rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
  const malformedText = JSON.stringify(malformedLegacyRecord, null, 2).replace(
    /\n}$/, ',\n  "serverMessage": "truncated legacy text\n}'
  )
  writeFileSync(join(tempUserData, 'activation.json'), malformedText, 'utf8')
  writeFileSync(join(tempUserData, 'activation.json.bak'), malformedText, 'utf8')
  const recoveredMalformedRecord = getActivationStatus()
  assert.equal(recoveredMalformedRecord.activated, false, 'a recovered v2 summary waits for server confirmation')
  assert.equal(recoveredMalformedRecord.activationCodeAvailable, true, 'the migrated original code remains recoverable')
  assert.equal(recoveredMalformedRecord.licenseId, 'malformed-v2-recovery-id')
  assert.equal(revealCurrentActivationCode().activationCode, recoveryCode)
  const recoveredJson = JSON.parse(readFileSync(join(tempUserData, 'activation.json'), 'utf8')) as Record<string, unknown>
  assert.equal(recoveredJson.version, 3, 'recovered v2 records are rewritten in the non-secret v3 format')
  assert.equal(recoveredJson.encryptedCode, undefined)

  rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
  rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
  writeFileSync(join(tempUserData, 'activation.json'), JSON.stringify(activationRecord), 'utf8')
  const firstSettings = {
    profiles: [{ ...profile, name: '第一配置', apiKey: ' key-one ' }],
    activeProfileId: profile.id,
    projectsDir: '',
    privacyAccepted: true,
    privacyEndpoint: profile.baseURL
  }
  saveSettings(firstSettings)
  saveSettings({
    ...firstSettings,
    profiles: [{ ...profile, name: '第二配置', apiKey: 'key-two' }]
  })
  writeFileSync(join(tempUserData, 'settings.json'), '{broken', 'utf8')
  const recovered = loadSettings()
  assert.equal(recovered.profiles[0]?.name, '第一配置')
  assert.equal(recovered.profiles[0]?.apiKey, 'key-one')

  assert.throws(
    () =>
      saveSettings({
        ...firstSettings,
        profiles: [{ ...profile, baseURL: 'http://remote.example/v1' }]
      }),
    /https/
  )
}

async function testServerActivationAndCredits(): Promise<void> {
  const liveActivationEnvelope = activationInternals.parseServerLicense({
    ok: true,
    action: 'activated',
    grant_score: 100,
    data: {
      app_name: 'ProductOperationReport'
    },
    license: {
      app_name: 'ProductOperationReport',
      code_id: 'live-envelope-primary',
      primary_code_id: 'live-envelope-primary',
      license_type: 'standard',
      remaining_credits: 100,
      unlimited: false,
      binding_status: 'active',
      transfer_count: 0,
      machine_code: 'ABCDEF123456',
      device_credential: 'live-device-credential',
      device_session: 'live-device-session',
      action: 'activated'
    }
  }, 200, 'abcdef123456')
  assert.equal(liveActivationEnvelope.ok, true, 'the production activation envelope must be accepted')
  assert.equal(liveActivationEnvelope.licenseId, 'live-envelope-primary')
  assert.equal(liveActivationEnvelope.creditsRemaining, 100)

  const liveMergedEnvelope = activationInternals.parseServerLicense({
    ok: true,
    action: 'balance_merged',
    grant_score: 0,
    primary_code_id: 'live-envelope-primary',
    merged_code_id: 'live-envelope-recharge',
    data: { app_name: 'ProductOperationReport' },
    license: {
      app_name: 'ProductOperationReport',
      code_id: 'live-envelope-recharge',
      primary_code_id: 'live-envelope-primary',
      merged_code_id: 'live-envelope-recharge',
      action: 'balance_merged',
      grant_score: 100,
      license_type: 'standard',
      remaining_credits: 110,
      unlimited: false,
      binding_status: 'active',
      transfer_count: 0,
      machine_code: 'ABCDEF123456'
    }
  }, 200, 'abcdef123456')
  assert.equal(liveMergedEnvelope.ok, true, 'a completed production merge must not be reported as failed')
  assert.equal(liveMergedEnvelope.grantScore, 0, 'the top-level transaction grant is authoritative')
  assert.equal(liveMergedEnvelope.primaryLicenseId, 'live-envelope-primary')
  assert.equal(liveMergedEnvelope.creditsRemaining, 110)

  const conflictingEnvelope = activationInternals.parseServerLicense({
    ok: true,
    app_name: 'AnotherApp',
    license: {
      app_name: 'ProductOperationReport',
      code_id: 'conflicting-envelope',
      remaining_credits: 100,
      unlimited: false,
      binding_status: 'active',
      transfer_count: 0,
      machine_code: 'ABCDEF123456'
    }
  }, 200, 'abcdef123456')
  assert.equal(conflictingEnvelope.ok, false, 'conflicting top-level and license identities must fail closed')
  assert.equal(conflictingEnvelope.contractInvalid, true)

  const requestEchoOnly = activationInternals.parseServerLicense({
    ok: true,
    data: {
      app_name: 'ProductOperationReport',
      code_id: 'request-echo-must-not-be-trusted',
      remaining_credits: 100,
      unlimited: false,
      binding_status: 'active',
      transfer_count: 0,
      machine_code: 'ABCDEF123456'
    }
  }, 200, 'abcdef123456')
  assert.equal(requestEchoOnly.ok, false, 'request echo data must never become an authorization result')
  assert.equal(requestEchoOnly.contractInvalid, true)

  const originalFetch = globalThis.fetch
  const code = 'SERVER-POINTS-TEST-CODE'
  let requestBody: Record<string, unknown> = {}
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/device/status')) {
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          code_id: 'license-test-points',
          license_type: 'credits',
          remaining_credits: 150,
          unlimited: false,
          binding_status: 'active',
          transfer_count: 0,
          machine_code: getActivationStatus().deviceId.toUpperCase(),
          message: '后台补发积分后余额已刷新'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'license-test-points',
        license_type: 'credits',
        remaining_credits: 100,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: getActivationStatus().deviceId,
        device_credential: 'points-device-credential',
        device_session: 'points-device-session',
        message: '激活成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const activated = await activateWithCode(code)
    assert.equal(activated.ok, true)
    assert.equal(activated.status.licenseType, 'credits')
    assert.equal(activated.status.creditsRemaining, 100)
    assert.equal(requestBody.app_name, 'ProductOperationReport')
    assert.equal(requestBody.license_protocol_version, 2)
    assert.equal(requestBody.activation_code, code)
    assert.equal(requestBody.machine_code, activated.status.deviceId)
    assert.equal(typeof requestBody.client_version, 'string')
    assert.equal(requestBody.software_version, undefined)
    assert.equal(requestBody.platform, undefined)
    assert.doesNotMatch(readFileSync(join(tempUserData, 'activation.json'), 'utf8'), new RegExp(code))

    const firstUse = canStartLicensedAnalysis()
    assert.equal(firstUse.ok, true)
    assert.equal(firstUse.status.creditsRemaining, 100, 'the client never subtracts authoritative server credits')
    const repeatedUse = canStartLicensedAnalysis()
    assert.equal(repeatedUse.status.creditsRemaining, 100)

    const refreshed = await getActivationStatusWithServerCheck()
    assert.equal(refreshed.activated, true)
    assert.equal(refreshed.creditsRemaining, 150)
    assert.equal(refreshed.offline, false)

    globalThis.fetch = (async () => { throw new TypeError('network unavailable') }) as typeof fetch
    const offline = await getActivationStatusWithServerCheck()
    assert.equal(offline.activated, true)
    assert.equal(offline.offline, true)
    assert.equal(offline.requiresRevalidation, false, 'temporary network failure keeps the last successful validation')
    assert.equal(canStartLicensedAnalysis().ok, true, 'offline grace must not interrupt an in-progress report')

    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: false,
      error: '激活码已禁用'
    }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const disabled = await getActivationStatusWithServerCheck()
    assert.equal(disabled.activated, false)
    assert.match(disabled.message || '', /禁用/)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      app_name: 'ProductOperationReport',
      code_id: 'license-test-unlimited',
      license_type: 'unlimited',
      remaining_credits: 0,
      unlimited: true,
      binding_status: 'active',
      transfer_count: 0,
      machine_code: getActivationStatus().deviceId,
      device_credential: 'unlimited-device-credential',
      device_session: 'unlimited-device-session',
      message: '激活成功'
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const unlimited = await activateWithCode('SERVER-UNLIMITED-TEST-CODE')
    assert.equal(unlimited.ok, true)
    assert.equal(unlimited.status.licenseType, 'unlimited')
    assert.equal(unlimited.status.unlimited, true)
    const unlimitedUse = canStartLicensedAnalysis()
    assert.equal(unlimitedUse.ok, true)
    assert.equal(unlimitedUse.status.unlimited, true)

    const wrongDeviceRecord = JSON.parse(readFileSync(join(tempUserData, 'activation.json'), 'utf8')) as Record<string, unknown>
    wrongDeviceRecord.deviceId = 'another-machine'
    writeFileSync(join(tempUserData, 'activation.json'), JSON.stringify(wrongDeviceRecord), 'utf8')
    writeFileSync(join(tempUserData, 'activation.json.bak'), JSON.stringify(wrongDeviceRecord), 'utf8')
    assert.equal(getActivationStatus().activated, false)
  } finally {
    globalThis.fetch = originalFetch
    const deviceId = getActivationStatus().deviceId
    writeFileSync(join(tempUserData, 'activation.json'), JSON.stringify({
      version: 1,
      codeHash: '0'.repeat(64),
      deviceId,
      activatedAt: new Date().toISOString()
    }), 'utf8')
  }
}

async function testProxyWalletBridge(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  const code = 'PROXY-WALLET-BRIDGE-CODE'
  let sessionCount = 0
  try {
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    clearAiProxySession()
    clearProxyWalletSnapshot()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/activate')) {
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          code_id: 'wallet-primary',
          license_type: 'credits',
          remaining_credits: 201,
          unlimited: false,
          binding_status: 'active',
          transfer_count: 0,
          machine_code: getDeviceId(),
          device_credential: 'wallet-device-credential',
          device_session: 'wallet-device-session',
          message: '激活成功'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/session')) {
        sessionCount += 1
        return new Response(JSON.stringify({ ok: true, access_token: `proxy-token-${sessionCount}`, expires_in: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (url.endsWith('/wallet')) {
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer proxy-token-${sessionCount}`)
        return new Response(JSON.stringify({
          ok: true,
          wallet: {
            balancePoints: 201,
            unlimited: false,
            totalTopupPoints: 250,
            totalCostPoints: 49,
            totalChargedPoints: 49,
            unbilledUsageCount: 0,
            pricing: {
              model: 'gpt-5.5', currency: 'USD', inputUsdPerMillion: 1.25,
              outputUsdPerMillion: 7.5, cachedInputUsdPerMillion: 0.125,
              cacheCreationUsdPerMillion: 0.8, usdCnyRate: 7.2, pointsPerCny: 100,
              cnyPerCostPoint: 0.01, costRate: 0.5, chargeMultiplier: 2
            },
            ledger: [{
              id: 'ledger-1', createdAt: '2026-08-19T00:00:00Z', kind: 'usage',
              description: '资料清洗', pointsDelta: -3.25, balanceAfter: 201,
              reportSessionId: 'report-ledger', taskType: 'source_clean'
            }]
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    assert.equal((await activateWithCode(code)).ok, true)
    const wallet = await fetchProxyWallet()
    assert.equal(wallet.balancePoints, 201)
    assert.equal(wallet.ledger[0]?.description, '资料清洗')
    assert.equal(wallet.ledger[0]?.reportSessionId, 'report-ledger')

    globalThis.fetch = (async () => { throw new TypeError('network unavailable') }) as typeof fetch
    const stale = await fetchProxyWallet()
    assert.equal(stale.balancePoints, 201)
    assert.equal(stale.stale, true)
    assert.match(stale.warning || '', /network unavailable/u)
  } finally {
    globalThis.fetch = originalFetch
    clearAiProxySession()
    clearProxyWalletSnapshot()
  }
}

async function testExplicitZeroServerBalanceDoesNotReissueGrantedCredits(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  let activationCalls = 0
  try {
    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
    rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
    rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
    globalThis.fetch = (async () => {
      activationCalls += 1
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'standard-code-with-points',
        license_type: 'standard',
        remaining_credits: 0,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: getActivationStatus().deviceId,
        ...(activationCalls === 1
          ? {
              device_credential: 'standard-points-credential',
              device_session: 'standard-points-session'
            }
          : {}),
        message: activationCalls === 1 ? '激活成功' : '该激活码已绑定本机，授权仍然有效。'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const activated = await activateWithCode('STANDARD-CODE-WITH-100-POINTS')
    assert.equal(activated.ok, true)
    assert.equal(activated.status.licenseType, 'credits')
    assert.equal(activated.status.creditsRemaining, 0)

    const repeated = await activateWithCode('STANDARD-CODE-WITH-100-POINTS')
    assert.equal(repeated.ok, true, 'same-device activation may reuse locally encrypted device credentials')
    assert.equal(repeated.status.creditsRemaining, 0)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
  }
}

async function testDeviceUnbindAndRebind(): Promise<void> {
  const originalFetch = globalThis.fetch
  const code = 'SERVER-DEVICE-REBIND-CODE'
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  let mode: 'initial' | 'server-error' | 'wrong-machine' | 'cooldown' | 'limit' | 'unbind' | 'rebind' = 'initial'
  let unbindBody: Record<string, unknown> = {}
  let unbindHeaders = new Headers()
  let activationCalls = 0
  let statusMethod = ''
  let statusHeaders = new Headers()
  try {
    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/device/status')) {
        statusMethod = init?.method || 'GET'
        statusHeaders = new Headers(init?.headers)
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          binding_status: 'active',
          code_id: 'license-device-rebind',
          license_type: 'credits',
          remaining_credits: 2_000,
          unlimited: false,
          transfer_count: 0,
          machine_code: getActivationStatus().deviceId,
          message: '设备授权有效'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/device/unbind')) {
        unbindBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        unbindHeaders = new Headers(init?.headers)
        if (mode === 'server-error') {
          return new Response(JSON.stringify({ ok: false, error: '服务暂时不可用' }), {
            status: 503,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (mode === 'wrong-machine') {
          return new Response(JSON.stringify({ ok: false, error: '机器码不匹配，未解除绑定' }), {
            status: 409,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (mode === 'cooldown') {
          return new Response(JSON.stringify({ ok: false, error: '成功换机后24小时内不能再次解绑' }), {
            status: 429,
            headers: { 'content-type': 'application/json' }
          })
        }
        if (mode === 'limit') {
          return new Response(JSON.stringify({ ok: false, error: '每个激活码30天内最多自助换机3次' }), {
            status: 429,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          ok: true,
          binding_status: 'unbound',
          unbind_id: 'unbind-test-001',
          message: '本机已解除绑定'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      activationCalls += 1
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'license-device-rebind',
        license_type: 'credits',
        remaining_credits: mode === 'rebind' ? 1_234.5 : 2_000,
        unlimited: false,
        binding_status: 'active',
        transfer_count: mode === 'rebind' ? 1 : 0,
        machine_code: getActivationStatus().deviceId,
        device_credential: 'fake-device-credential',
        device_session: 'fake-device-session',
        ...(mode === 'rebind' ? { action: 'rebound', grant_score: 0 } : {}),
        message: '激活成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const activated = await activateWithCode(code)
    assert.equal(activated.ok, true)
    const storedText = readFileSync(activationFile, 'utf8')
    assert.equal(storedText.includes('fake-device-credential'), false, 'device credential must be encrypted at rest')
    assert.equal(storedText.includes('fake-device-session'), false, 'device session must be encrypted at rest')
    const storedJson = JSON.parse(storedText) as Record<string, unknown>
    assert.equal(storedJson.encryptedCode, undefined, 'activation.json must not contain the activation code ciphertext')
    assert.equal(storedJson.encryptedDeviceCredential, undefined)
    assert.equal(storedJson.encryptedDeviceSession, undefined)
    const vaultBytes = readFileSync(join(tempUserData, 'license-vault.bin'))
    assert.equal(vaultBytes.includes(Buffer.from(code)), false, 'the secure vault must not contain plaintext activation codes')
    assert.equal((await getActivationStatusWithServerCheck()).activated, true)
    assert.equal(statusMethod, 'GET')
    assert.equal(statusHeaders.get('authorization'), 'Bearer fake-device-session')
    assert.equal(activationCalls, 1, 'startup validation must use device/status instead of activating again')

    const oldClientRecord = JSON.parse(readFileSync(activationFile, 'utf8')) as Record<string, unknown>
    oldClientRecord.encryptedCode = encryptV032StoredCode(code, activated.status.deviceId)
    delete oldClientRecord.encryptedDeviceCredential
    delete oldClientRecord.encryptedDeviceSession
    rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
    rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
    writeFileSync(activationFile, JSON.stringify(oldClientRecord), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(oldClientRecord), 'utf8')

    mode = 'server-error'
    const unavailable = await deactivateCurrentDevice()
    assert.equal(unavailable.ok, false)
    assert.equal(activationCalls, 2, 'a v0.3.2 activation must refresh device credentials before unbinding')
    assert.equal(existsSync(activationFile), true, 'server failure must keep the local activation')

    mode = 'wrong-machine'
    const mismatch = await deactivateCurrentDevice()
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.message, /机器码不匹配/)
    assert.equal(existsSync(activationFile), true, 'machine mismatch must keep the local activation')

    mode = 'cooldown'
    const cooldown = await deactivateCurrentDevice()
    assert.equal(cooldown.ok, false)
    assert.match(cooldown.message, /24小时/)
    assert.equal(existsSync(activationFile), true, 'cooldown rejection must keep the local activation')

    mode = 'limit'
    const limited = await deactivateCurrentDevice()
    assert.equal(limited.ok, false)
    assert.match(limited.message, /30天内最多自助换机3次/)
    assert.equal(existsSync(activationFile), true, '30-day limit rejection must keep the local activation')

    mode = 'unbind'
    const unbound = await deactivateCurrentDevice()
    assert.equal(unbound.ok, true)
    assert.equal(unbound.unbindId, 'unbind-test-001')
    assert.equal(unbindBody.app_name, 'ProductOperationReport')
    assert.equal(unbindBody.machine_code, activated.status.deviceId)
    assert.equal(unbindBody.device_credential, undefined, 'credentials belong in authenticated headers, not the JSON body')
    assert.equal(unbindBody.current_code_id, 'license-device-rebind')
    assert.equal(unbindBody.license_protocol_version, 2)
    assert.equal(unbindHeaders.get('authorization'), 'Bearer fake-device-session')
    assert.equal(unbindBody.activation_code, undefined, 'unbind must not submit the activation code')
    assert.equal(unbindBody.points_balance, undefined, 'server keeps the authoritative points balance')
    assert.equal(unbindBody.transfer_code, undefined, 'unbind does not use a transfer code')
    assert.equal(existsSync(activationFile), false)
    assert.equal(existsSync(activationBackup), false)
    assert.equal(getActivationStatus().activated, false)

    assert.equal((await deactivateCurrentDevice()).ok, false, 'repeated unbind is rejected safely')

    mode = 'rebind'
    const reactivated = await activateWithCode(code)
    assert.equal(reactivated.ok, true)
    assert.equal(reactivated.status.bindingStatus, 'active')
    assert.equal(reactivated.status.transferCount, 1)
    assert.equal(reactivated.status.creditsRemaining, 1_234.5)

    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
    rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
    rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
    const deviceId = getActivationStatus().deviceId
    const v1Record = {
      version: 1,
      codeHash: '0'.repeat(64),
      deviceId,
      activatedAt: new Date().toISOString()
    }
    writeFileSync(activationFile, JSON.stringify(v1Record), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(v1Record), 'utf8')
    const activationCallsBeforeLegacyUnbind = activationCalls
    const legacyDirectUnbind = await deactivateCurrentDevice()
    assert.equal(legacyDirectUnbind.ok, true, 'v1 local-only authorization can be removed without entering the code')
    assert.equal(
      activationCalls,
      activationCallsBeforeLegacyUnbind,
      'a v1 local-only record has no server binding and must not call activate during local removal'
    )
    assert.equal(existsSync(activationFile), false)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
  }
}

async function testRemoteAdminUnbindReturnsToActivation(): Promise<void> {
  const originalFetch = globalThis.fetch
  const code = 'REMOTE-ADMIN-UNBIND-CODE'
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const licenseVault = join(tempUserData, 'license-vault.bin')
  const licenseVaultBackup = `${licenseVault}.bak`
  let statusMode: 'active' | 'unbound' | 'unauthorized' = 'active'
  try {
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) {
      rmSync(file, { force: true })
    }
    activationInternals.resetRuntimeValidationForTests()
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      const machineCode = getActivationStatus().deviceId
      if (url.includes('/device/status')) {
        if (statusMode === 'unauthorized') {
          return new Response(JSON.stringify({ ok: false, error: '设备凭证已撤销' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          binding_status: statusMode === 'unbound' ? 'unbound' : 'active',
          code_id: 'remote-admin-unbind-license',
          license_type: 'credits',
          remaining_credits: 130,
          unlimited: false,
          transfer_count: statusMode === 'unbound' ? 1 : 0,
          machine_code: machineCode,
          message: statusMode === 'unbound'
            ? '当前设备已在服务器解除绑定，请重新输入激活码。'
            : '设备授权有效'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'remote-admin-unbind-license',
        license_type: 'credits',
        remaining_credits: 130,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 1,
        machine_code: machineCode,
        device_credential: 'remote-admin-device-credential',
        device_session: 'remote-admin-device-session',
        action: 'rebound',
        grant_score: 0,
        message: '重新绑定成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const activated = await activateWithCode(code)
    assert.equal(activated.ok, true)
    assert.equal(activated.status.activated, true)

    statusMode = 'unbound'
    const unbound = await getActivationStatusWithServerCheck()
    assert.equal(unbound.activated, false, 'a server-side unbind must leave the active application state')
    assert.equal(unbound.bindingStatus, 'unbound')
    assert.equal(unbound.activationCodeAvailable, true, 'the original code remains recoverable from secure storage')
    assert.match(unbound.message || '', /解除绑定/)
    assert.equal(revealCurrentActivationCode().activationCode, code)
    const unboundVault = inspectLicenseVault().value
    assert.equal(unboundVault?.deviceCredential, undefined, 'administrator unbind revokes the cached device credential')
    assert.equal(unboundVault?.deviceSession, undefined, 'administrator unbind revokes the cached device session')

    statusMode = 'active'
    const rebound = await activateWithCode(code)
    assert.equal(rebound.ok, true, 'the original code can explicitly bind the machine again')
    assert.equal(rebound.status.activated, true)

    statusMode = 'unauthorized'
    const revokedCredential = await getActivationStatusWithServerCheck()
    assert.equal(revokedCredential.activated, false, 'a revoked device credential must return to activation')
    assert.equal(revokedCredential.requiresRevalidation, true)
    assert.equal(revokedCredential.activationCodeAvailable, true)
    assert.equal(revokedCredential.authorizationState, 'credential_revoked')
    assert.match(revokedCredential.message || '', /撤销|管理员/)
    const revokedVault = inspectLicenseVault().value
    assert.equal(revokedVault?.deviceCredential, undefined, 'credential revocation clears the cached credential')
    assert.equal(revokedVault?.deviceSession, undefined, 'credential revocation clears the cached session')

    statusMode = 'active'
    const revalidated = await activateWithCode(code)
    assert.equal(revalidated.ok, false, 'revoked credentials require administrator handling')
    assert.equal(revalidated.status.activated, false)
  } finally {
    globalThis.fetch = originalFetch
    for (const file of [activationFile, activationBackup, licenseVault, licenseVaultBackup]) {
      rmSync(file, { force: true })
    }
    activationInternals.resetRuntimeValidationForTests()
  }
}

async function testPrimaryActivationAndRechargeCodeSeparation(): Promise<void> {
  const originalFetch = globalThis.fetch
  const primaryCode = 'PRIMARY-A-CODE'
  const rechargeCode = 'RECHARGE-B-CODE'
  const mergedWithoutLocalPrimaryCode = 'MERGED-WITHOUT-LOCAL-PRIMARY'
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  let rechargeCalls = 0
  try {
    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
    rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
    rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      const code = String(body.activation_code || '')
      const isRecharge = code === rechargeCode
      const isMergedWithoutLocalPrimary = code === mergedWithoutLocalPrimaryCode
      if (isRecharge) rechargeCalls += 1
      if ((isRecharge && rechargeCalls === 1) || isMergedWithoutLocalPrimary) {
        return new Response(JSON.stringify({
          ok: true,
          action: 'balance_merged',
          primary_code_id: 'license-a-primary',
          merged_code_id: 'license-b-recharge',
          message: 'balance merged',
          data: { app_name: 'ProductOperationReport' },
          license: {
            app_name: 'ProductOperationReport',
            code_id: 'license-b-recharge',
            primary_code_id: 'license-a-primary',
            merged_code_id: 'license-b-recharge',
            action: 'balance_merged',
            license_type: 'credits',
            remaining_credits: 120,
            unlimited: false,
            binding_status: 'active',
            transfer_count: 0,
            machine_code: getActivationStatus().deviceId
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (isRecharge && rechargeCalls > 1) {
        return new Response(JSON.stringify({ ok: false, error: '这个积分码已经合并过' }), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'license-a-primary',
        license_type: 'credits',
        remaining_credits: isRecharge ? 120 : 20,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: getActivationStatus().deviceId,
        ...(!isRecharge ? { device_credential: 'credential-a', device_session: 'session-a' } : {}),
        message: '激活成功'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const missingPrimaryRecovery = await activateWithCode(mergedWithoutLocalPrimaryCode)
    assert.equal(missingPrimaryRecovery.ok, false)
    assert.match(missingPrimaryRecovery.message, /主激活码/)
    assert.equal(existsSync(activationFile), false, 'a merged recharge code must never replace the missing primary')

    const primary = await activateWithCode(primaryCode)
    assert.equal(primary.ok, true)
    assert.equal(primary.status.activationCodeAvailable, true)
    assert.equal(primary.status.creditsRemaining, 20)
    assert.equal(revealCurrentActivationCode().activationCode, primaryCode)

    const grant = await redeemPointsWithCode(rechargeCode)
    assert.equal(grant.ok, true)
    assert.equal(grant.grantId, 'license-a-primary')
    assert.equal(grant.points, 100)
    assert.equal(grant.status.creditsRemaining, 120)
    assert.equal(getActivationStatus().licenseId, 'license-a-primary')
    assert.equal(revealCurrentActivationCode().activationCode, primaryCode, 'B code must not replace the primary code')

    const repeatedGrant = await redeemPointsWithCode(rechargeCode)
    assert.equal(repeatedGrant.ok, false)
    assert.equal(getActivationStatus().creditsRemaining, 120)
    const primaryAsRecharge = await redeemPointsWithCode(primaryCode)
    assert.equal(primaryAsRecharge.ok, false)
    assert.match(primaryAsRecharge.message, /主激活码/)
    const stored = readFileSync(activationFile, 'utf8')
    assert.equal(stored.includes(primaryCode), false, 'primary code must be encrypted at rest')
    assert.equal(stored.includes(rechargeCode), false, 'recharge code must never be stored in activation state')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(activationFile, { force: true })
    rmSync(activationBackup, { force: true })
    rmSync(join(tempUserData, 'license-vault.bin'), { force: true })
    rmSync(join(tempUserData, 'license-vault.bin.bak'), { force: true })
  }
}

async function testEncryptedMultiLicenseHistoryRecovery(): Promise<void> {
  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const vaultFile = join(tempUserData, 'license-vault.bin')
  const vaultBackup = `${vaultFile}.bak`
  const currentCode = 'CURRENT-MERGED-MAIN-CODE'
  const historicalCode = 'HISTORICAL-VALID-PRIMARY-CODE'
  const currentLicenseId = 'current-merged-license'
  const historicalLicenseId = 'historical-valid-license'
  let activationCalls = 0
  try {
    for (const file of [activationFile, activationBackup, vaultFile, vaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    const deviceId = getActivationStatus().deviceId
    const now = new Date().toISOString()
    writeLicenseVault({
      version: 3,
      appName: 'ProductOperationReport',
      activeLicenseId: currentLicenseId,
      entries: [
        {
          licenseId: currentLicenseId,
          machineCode: deviceId,
          activationCode: currentCode,
          deviceCredential: 'current-merged-credential',
          deviceSession: 'current-merged-session',
          state: 'active',
          lastValidatedAt: now,
          updatedAt: now
        },
        {
          licenseId: historicalLicenseId,
          machineCode: deviceId,
          activationCode: historicalCode,
          deviceCredential: 'historical-valid-credential',
          deviceSession: 'historical-valid-session',
          state: 'unknown',
          lastValidatedAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString()
        }
      ]
    })
    const currentRecord = {
      version: 3,
      appName: 'ProductOperationReport',
      source: 'server',
      codeHash: createHash('sha256')
        .update(`product-operation-report:activation:v1:${currentCode.replace(/[^A-Z0-9]/g, '')}`, 'utf8')
        .digest('hex'),
      deviceId,
      activatedAt: now,
      licenseId: currentLicenseId,
      licenseType: 'credits',
      unlimited: false,
      creditsRemaining: 1_000,
      lastValidatedAt: now,
      offlineUntil: new Date(Date.now() + 60_000).toISOString(),
      bindingStatus: 'active',
      transferCount: 0,
      activationCodeStored: true,
      maskedActivationCode: 'CURR••••CODE',
      requiresRevalidation: false,
      authorizationState: 'active'
    }
    writeFileSync(activationFile, JSON.stringify(currentRecord), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(currentRecord), 'utf8')

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (!url.pathname.includes('/device/status')) {
        activationCalls += 1
        throw new Error('historical recovery must never call /activate')
      }
      const codeId = url.searchParams.get('code_id')
      if (codeId === currentLicenseId) {
        return new Response(JSON.stringify({ ok: false, error: '合并码不能作为设备主授权。' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      }
      assert.equal(codeId, historicalLicenseId)
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: historicalLicenseId,
        license_type: 'credits',
        remaining_credits: 88,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: deviceId,
        message: '历史主授权仍然有效'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const recovered = await getActivationStatusWithServerCheck()
    assert.equal(recovered.activated, true)
    assert.equal(recovered.licenseId, historicalLicenseId)
    assert.equal(recovered.creditsRemaining, 88)
    assert.equal(revealCurrentActivationCode().activationCode, historicalCode)
    assert.equal(activationCalls, 0, 'history recovery uses status checks only')
    const recoveredVault = inspectLicenseVault().value
    assert.equal(recoveredVault?.version, 3)
    assert.equal(recoveredVault?.activeLicenseId, historicalLicenseId)
    assert.equal(recoveredVault?.entries?.find((entry) => entry.licenseId === currentLicenseId)?.state, 'merged')
    assert.equal(recoveredVault?.entries?.find((entry) => entry.licenseId === historicalLicenseId)?.state, 'active')
    const publicSummary = readFileSync(activationFile, 'utf8')
    for (const secret of [currentCode, historicalCode, 'current-merged-credential', 'historical-valid-credential']) {
      assert.equal(publicSummary.includes(secret), false, 'multi-license secrets stay out of activation.json')
    }

    writeLicenseVault({
      version: 3,
      appName: 'ProductOperationReport',
      activeLicenseId: currentLicenseId,
      entries: [{
        licenseId: currentLicenseId,
        machineCode: deviceId,
        activationCode: currentCode,
        deviceCredential: 'current-merged-credential',
        deviceSession: 'current-merged-session',
        state: 'active',
        lastValidatedAt: now,
        updatedAt: now
      }]
    })
    writeFileSync(activationFile, JSON.stringify(currentRecord), 'utf8')
    writeFileSync(activationBackup, JSON.stringify(currentRecord), 'utf8')
    const blocked = await getActivationStatusWithServerCheck()
    assert.equal(blocked.activated, false)
    assert.equal(blocked.authorizationState, 'merged_main_conflict')
    assert.match(blocked.message || '', /管理员补发的主码/)
    assert.equal(activationCalls, 0, 'a missing historical primary must fail closed without activation')
  } finally {
    globalThis.fetch = originalFetch
    for (const file of [activationFile, activationBackup, vaultFile, vaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

async function testLicenseProtocolV2StrictContract(): Promise<void> {
  const successfulStatusWithoutMessage = activationInternals.parseServerLicense({
    ok: true,
    app_name: 'ProductOperationReport',
    code_id: 'status-without-message',
    remaining_credits: 100,
    unlimited: false,
    binding_status: 'active',
    transfer_count: 0,
    machine_code: 'ABCDEF123456'
  }, 200, 'abcdef123456')
  assert.equal(successfulStatusWithoutMessage.ok, true)
  assert.equal(successfulStatusWithoutMessage.message, '授权验证成功。')

  const originalFetch = globalThis.fetch
  const activationFile = join(tempUserData, 'activation.json')
  const activationBackup = `${activationFile}.bak`
  const vaultFile = join(tempUserData, 'license-vault.bin')
  const vaultBackup = `${vaultFile}.bak`
  const code = 'STRICT-V2-PRIMARY-CODE'
  let mode: 'active' | 'unauthorized' | 'conflict' = 'active'
  let balance = 100
  let activationBody: Record<string, unknown> = {}
  let activationHeaders = new Headers()
  try {
    for (const file of [activationFile, activationBackup, vaultFile, vaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/device/status')) {
        if (mode === 'unauthorized') {
          return new Response(JSON.stringify({ ok: false, error: 'device credential expired' }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({
          ok: true,
          app_name: 'ProductOperationReport',
          code_id: 'strict-v2-primary',
          license_type: 'credits',
          remaining_credits: balance,
          ...(mode === 'conflict' ? { remaining_points: balance + 1 } : {}),
          unlimited: false,
          binding_status: 'active',
          transfer_count: 0,
          machine_code: getActivationStatus().deviceId,
          message: 'status refreshed'
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      activationBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      activationHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({
        ok: true,
        app_name: 'ProductOperationReport',
        code_id: 'strict-v2-primary',
        license_type: 'credits',
        remaining_credits: balance,
        unlimited: false,
        binding_status: 'active',
        transfer_count: 0,
        machine_code: getActivationStatus().deviceId,
        device_credential: 'strict-device-credential-rotated',
        device_session: 'strict-device-session-rotated',
        grant_score: 9_999,
        message: 'activated'
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const activated = await activateWithCode(code)
    assert.equal(activated.ok, true)
    assert.equal(activated.status.creditsRemaining, 100, 'grant_score must never replace the authoritative balance')
    assert.equal('activationCode' in activated.status, false, 'normal status must never expose the full activation code')
    assert.equal(revealCurrentActivationCode().activationCode, code)
    assert.deepEqual(
      Object.keys(activationBody).sort(),
      ['activation_code', 'app_name', 'client_version', 'license_protocol_version', 'machine_code'].sort(),
      'first activation sends only the canonical v2 fields'
    )

    balance = 42
    const reduced = await getActivationStatusWithServerCheck()
    assert.equal(reduced.creditsRemaining, 42, 'administrator deductions overwrite the local display immediately')
    assert.equal(reduced.requiresRevalidation, false)

    mode = 'unauthorized'
    const unauthorized = await getActivationStatusWithServerCheck()
    assert.equal(unauthorized.activated, false, '401 returns the UI to activation while project files remain untouched')
    assert.equal(unauthorized.requiresRevalidation, true)
    assert.equal(canStartLicensedAnalysis().ok, false, '401 blocks new cloud work')
    assert.equal(revealCurrentActivationCode().activationCode, code, '401 must not delete the original activation code')

    mode = 'active'
    const refreshed = await activateWithCode(code)
    assert.equal(refreshed.ok, false, 'an unknown 401 must fail closed instead of guessing a recovery path')
    assert.equal(activationHeaders.get('authorization'), null, 'a revoked device session must not be reused during revalidation')
    assert.equal(refreshed.status.creditsRemaining, 42, 'a rejected recovery must not alter credits')

    mode = 'conflict'
    const conflicted = await getActivationStatusWithServerCheck()
    assert.equal(conflicted.activated, false, 'a conflicting server contract fails closed')
    assert.equal(conflicted.creditsRemaining, 42, 'conflicting aliases must not overwrite the last trusted balance')
    assert.equal(conflicted.requiresRevalidation, true)
    assert.match(conflicted.message || '', /冲突/)

    const json = readFileSync(activationFile, 'utf8')
    const storedSummary = JSON.parse(json) as Record<string, unknown>
    assert.equal(storedSummary.activationCodeStored, true, 'the non-secret summary records vault availability')
    assert.equal(typeof storedSummary.maskedActivationCode, 'string', 'the default UI uses a non-secret masked summary')
    for (const secret of [code, 'strict-device-credential-rotated', 'strict-device-session-rotated']) {
      assert.equal(json.includes(secret), false, 'activation.json must never contain full secrets')
    }
    assert.equal(json.includes('encryptedCode'), false, 'legacy embedded secret fields are removed after migration')
  } finally {
    globalThis.fetch = originalFetch
    for (const file of [activationFile, activationBackup, vaultFile, vaultBackup]) rmSync(file, { force: true })
    activationInternals.resetRuntimeValidationForTests()
  }
}

function testUpdateVersionComparison(): void {
  assert.equal(compareVersions('0.3.0', '0.2.5'), 1)
  assert.equal(compareVersions('v1.0.0', '1.0'), 0)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1)
}

function testUpdateManifestSignature(): void {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const manifest: Record<string, unknown> = {
    app_name: 'ProductOperationReport',
    version: '9.9.9',
    download_url: { windows_x64: 'https://update.dadaozixun.com/test.exe' },
    sha256: { windows_x64: 'a'.repeat(64) },
    notes: ['安全更新'],
    force: false
  }
  manifest.signature = sign(null, canonicalUpdateManifest(manifest), keys.privateKey).toString('base64')
  assert.equal(verifyUpdateManifestSignature(manifest, publicKey), true)
  assert.equal(verifyUpdateManifestSignature({ ...manifest, version: '9.9.10' }, publicKey), false)
  assert.equal(verifyUpdateManifestSignature({ ...manifest, signature: '' }, publicKey), false)
}

async function testUpdateConfigAndChecksum(): Promise<void> {
  const originalFetch = globalThis.fetch
  const payload = Buffer.from('verified-update-payload', 'utf8')
  const correctChecksum = createHash('sha256').update(payload).digest('hex')
  const assetKey = process.platform === 'win32' ? 'windows_x64' : process.arch === 'arm64' ? 'mac_arm64' : 'mac_x64'
  const assetUrl = process.platform === 'win32'
    ? 'https://update.dadaozixun.com/POR-test-update.exe'
    : `https://update.dadaozixun.com/POR-test-update-${process.arch}.dmg`
  const expectedExtension = process.platform === 'win32' ? /\.exe/u : /\.dmg/u
  let requestedUrl = ''
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        app_name: 'ProductOperationReport',
        version: '999.0.0',
        min_supported_version: '998.0.0',
        download_url: { [assetKey]: assetUrl },
        sha256: { [assetKey]: '0'.repeat(64) },
        notes: ['测试更新'],
        force: false
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const forced = await checkForUpdates()
    assert.equal(new URL(requestedUrl).searchParams.get('app_name'), 'ProductOperationReport')
    assert.equal(forced.available, true)
    assert.equal(forced.force, true)
    assert.equal(forced.latestVersion, '999.0.0')

    globalThis.fetch = (async () => {
      const response = new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) }
      })
      Object.defineProperty(response, 'url', { value: assetUrl })
      return response
    }) as typeof fetch
    const rejected = await downloadUpdate()
    assert.equal(rejected.ok, false)
    assert.match(rejected.message, /校验失败/)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      app_name: 'ProductOperationReport',
      version: '999.0.1',
      download_url: { [assetKey]: assetUrl },
      sha256: { [assetKey]: correctChecksum },
      notes: '通过校验',
      force: false
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const offered = await checkForUpdates()
    assert.equal(offered.available, true)
    assert.equal(offered.force, false)

    globalThis.fetch = (async () => {
      const response = new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) }
      })
      Object.defineProperty(response, 'url', { value: assetUrl })
      return response
    }) as typeof fetch
    const accepted = await downloadUpdate()
    assert.equal(accepted.ok, true)
    assert.equal(existsSync(accepted.info?.downloadPath || ''), true)

    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch
    const noConfig = await checkForUpdates()
    assert.equal(noConfig.available, false)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      app_name: 'ProductOperationReport',
      version: '999.0.2',
      download_url: { [assetKey]: 'https://update.dadaozixun.com/not-an-installer.html' },
      sha256: { [assetKey]: correctChecksum },
      notes: [],
      force: false
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await assert.rejects(checkForUpdates(), expectedExtension)

    globalThis.fetch = (async () => new Response(JSON.stringify({
      app_name: 'AnotherProduct',
      version: '999.0.3',
      download_url: { [assetKey]: assetUrl },
      sha256: { [assetKey]: correctChecksum },
      notes: [],
      force: false
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await assert.rejects(checkForUpdates(), /软件标识不匹配/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function testManagedModelIsolation(): void {
  const secret = 'managed-secret-never-rendered'
  const validConfig = {
    version: 1,
    enabled: true,
    name: '内置 AI 服务',
    baseURL: 'https://managed.example.com/v1/',
    apiKey: secret,
    model: 'managed-model',
    supportsVision: true,
    temperature: 0.3,
    fallbackModels: ['claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6']
  }
  const parsed = managedModelInternals.parseConfig(validConfig)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.profile?.apiKey, secret)
  assert.equal(parsed.profile?.baseURL, 'https://managed.example.com/v1')
  assert.deepEqual(parsed.profiles.map((item) => item.model), [
    'managed-model', 'claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6'
  ])
  assert.equal(parsed.profiles[0].temperature, 0.3)
  assert.equal(parsed.profiles[1].temperature, undefined)
  assert.equal(parsed.profiles.every((item) => item.apiKey === secret), true)
  assert.equal(JSON.stringify(parsed.info).includes(secret), false)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, apiKey: '' }).profile, null)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, baseURL: 'http://remote.example.com/v1' }).profile, null)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, enabled: false }).enabled, false)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, fallbackModels: ['managed-model'] }).profile, null)
  assert.equal(managedModelInternals.parseConfig({ ...validConfig, fallbackModels: ['a', 'b', 'c', 'd'] }).profile, null)
  assert.deepEqual(
    managedModelInternals.parseConfig({ ...validConfig, model: 'gpt-5.5', fallbackModels: undefined }).profiles.map((item) => item.model),
    ['gpt-5.5', 'claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6']
  )

  process.env.PRODUCT_REPORT_MANAGED_MODEL_CONFIG_JSON = JSON.stringify(validConfig)
  assert.equal(getManagedModelState().mode, 'proxy', 'normal development startup must exercise the production proxy path')
  assert.notEqual(getActiveProfile()?.apiKey, secret, '开发开关未启用时必须忽略模型环境变量')
  const proxyRendererSettings = loadRendererSettings()
  assert.equal(proxyRendererSettings.profiles.length, 0)
  const proxyStoredSettings = JSON.parse(readFileSync(join(tempUserData, 'settings.json'), 'utf8')) as Record<string, unknown>
  const proxyBackupSettings = JSON.parse(readFileSync(join(tempUserData, 'settings.json.bak'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(proxyStoredSettings.profiles, [], '代理模式必须清除主设置中的历史本地模型密钥')
  assert.deepEqual(proxyBackupSettings.profiles, [], '代理模式必须清除备份设置中的历史本地模型密钥')
  process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES = '1'
  try {
    const rendererSettings = loadRendererSettings()
    assert.equal(rendererSettings.profiles.length, 0)
    assert.equal(rendererSettings.managedModel?.configured, true)
    assert.equal(JSON.stringify(rendererSettings).includes(secret), false)
    assert.equal(getActiveProfile()?.apiKey, secret)
    assert.deepEqual(getActiveProfiles().map((item) => item.model), [
      'managed-model', 'claude-sonnet-4-6', 'gemini-3-flash', 'kimi-k2.6'
    ])

    process.env.PRODUCT_REPORT_DEV_FORCE_PROXY = '1'
    assert.equal(getManagedModelState().mode, 'proxy', 'isolated staging must be able to force the server proxy path')
    assert.notEqual(getActiveProfile()?.apiKey, secret, 'forced proxy mode must never reuse a local provider key')
    delete process.env.PRODUCT_REPORT_DEV_FORCE_PROXY

    const saved = saveRendererSettings({
      ...rendererSettings,
      profiles: [
        {
          id: 'injected',
          name: '恶意替换',
          baseURL: 'https://attacker.example.com/v1',
          apiKey: 'attacker-key',
          model: 'attacker-model',
          supportsVision: false
        }
      ],
      activeProfileId: 'injected',
      privacyAccepted: true,
      privacyEndpoint: 'https://attacker.example.com/v1'
    })
    assert.equal(saved.profiles.length, 0)
    assert.equal(saved.privacyEndpoint, 'https://managed.example.com/v1')
    assert.equal(getActiveProfile()?.id, 'managed-model')
  } finally {
    delete process.env.PRODUCT_REPORT_MANAGED_MODEL_CONFIG_JSON
    delete process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES
    delete process.env.PRODUCT_REPORT_DEV_FORCE_PROXY
  }
}

function testModelFallbackSafety(): void {
  assert.equal(classifyModelFailure('HTTP 429 Too Many Requests', 'error'), 'rate_limited')
  assert.equal(classifyModelFailure('HTTP 401 Unauthorized', 'error'), 'authentication')
  assert.equal(classifyModelFailure('模型因内容安全限制提前停止', 'error'), 'safety')
  assert.equal(
    classifyModelFailure('HTTP 503 {"message":"provider_route_unavailable"}', 'error'),
    'provider_route_unavailable'
  )
  assert.equal(shouldTryModelFallback({ failureKind: 'rate_limited', outputChars: 0, aborted: false, hasNext: true }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'network', outputChars: 1, aborted: false, hasNext: true }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'authentication', outputChars: 0, aborted: false, hasNext: true }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'safety', outputChars: 0, aborted: false, hasNext: true }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'provider_error', outputChars: 0, aborted: true, hasNext: true }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'provider_error', outputChars: 0, aborted: false, hasNext: false }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'provider_error', outputChars: 0, aborted: false, hasNext: true }), false)
  assert.equal(shouldTryModelFallback({ failureKind: 'model_unavailable', outputChars: 0, aborted: false, hasNext: true }), true)
  assert.equal(shouldTryModelFallback({ failureKind: 'provider_route_unavailable', outputChars: 0, aborted: false, hasNext: true }), true)
}

function testChatAdmissionSecurity(): void {
  const id = 'b4f81b86-1a5b-4e39-830e-1271165bb8ee'
  const context = {
    reportSessionId: 'report-security-test',
    taskType: 'summary' as const,
    taskKey: 'summary:1',
    attempt: 1,
    isVision: false,
    sourceCount: 1,
    imageCount: 0
  }
  const valid = validateChatStartPayload({
    id,
    messages: [{ role: 'user', content: '请总结资料。' }],
    context
  })
  assert.equal(valid.id, id)
  assert.throws(
    () => validateChatStartPayload({ id, messages: [{ role: 'user', content: 'x'.repeat(2_000_001) }], context }),
    /过大/
  )
  assert.throws(
    () => validateChatStartPayload({
      id,
      messages: [{ role: 'user', content: [{ type: 'image', dataUrl: 'https://127.0.0.1/private.png' }] }],
      context: { ...context, isVision: true, imageCount: 1 }
    }),
    /图片/
  )

  const registry = new ChatRequestRegistry(4)
  const first = new AbortController()
  registry.claim(id, 101, first)
  assert.equal(registry.hasOwner(101), true)
  assert.equal(registry.hasOwner(202), false)
  assert.throws(() => registry.claim(id, 101, new AbortController()), /重复/)
  assert.equal(registry.abort(id, 202), false)
  assert.equal(first.signal.aborted, false)
  assert.equal(registry.abort(id, 101), true)
  assert.equal(first.signal.aborted, true)
  registry.release(id, 101, first)
  assert.equal(registry.size, 0)
  assert.equal(registry.hasOwner(101), false)

  const second = new AbortController()
  const third = new AbortController()
  registry.claim('5f26ccac-8b0d-49eb-a49e-53d044098a52', 101, second)
  registry.claim('30c33d60-7d4a-4676-b48b-d81febc34ac1', 202, third)
  registry.abortAll()
  assert.equal(second.signal.aborted, true)
  assert.equal(third.signal.aborted, true)
  assert.equal(registry.size, 0)
}

function testCloseDuringActiveWorkContract(): void {
  const mainSource = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
  const preloadSource = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
  const rendererSource = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.match(mainSource, /hasParsingForOwner\(ownerId\)/)
  assert.match(mainSource, /chatRequests\.hasOwner\(ownerId\)/)
  assert.match(mainSource, /停止任务并退出/)
  assert.match(mainSource, /cancelParsingForOwner\(ownerId, '软件正在关闭/)
  assert.match(mainSource, /chatRequests\.abortOwner\(ownerId\)/)
  assert.match(mainSource, /setTimeout\(\(\) => app\.exit\(0\), 4_000\)/)
  assert.match(mainSource, /chatRequests\.abortAll\(\)/)
  assert.match(mainSource, /app\.on\('before-quit'/)
  const parseServiceSource = readFileSync(join(process.cwd(), 'src', 'main', 'parseService.ts'), 'utf8')
  assert.match(parseServiceSource, /process\.kill\(pid, 'SIGKILL'\)/)
  assert.match(parseServiceSource, /for \(const item of waiting\) settleItem\(item, serviceBlockedError\)\s+finish\(\)/)
  assert.doesNotMatch(mainSource, /app:before-close/)
  assert.doesNotMatch(preloadSource, /app:close-ready|app:close-guard-state|app:before-close/)
  assert.doesNotMatch(rendererSource, /onBeforeClose/)
}

function testRepairPlanStaticContracts(): void {
  const main = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
  const preload = readFileSync(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8')
  const store = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'store.ts'), 'utf8')
  const table = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'tablePreprocess.ts'), 'utf8')
  const sop = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'sop.ts'), 'utf8')
  const contact = readFileSync(join(process.cwd(), 'src', 'main', 'contact.ts'), 'utf8')
  const builder = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')
  const packageScan = readFileSync(join(process.cwd(), 'scripts', 'verify-package-secrets.cjs'), 'utf8')
  const workflow = readFileSync(join(process.cwd(), '..', '.github', 'workflows', 'build-desktop.yml'), 'utf8')
  assert.doesNotMatch(main, /function authorizationWallet/u)
  assert.match(main, /fetchProxyWallet/u)
  assert.equal((main.match(/getActivationStatusWithServerCheck\(/gu) || []).length, 1, 'only throttled refresh calls device status')
  assert.match(main, /restoreAuthorizationOnStartup/u)
  assert.doesNotMatch(main, /automaticSavedCodeRecoveryKey|getActivationStatusWithSavedCodeRecovery/u)
  assert.match(main, /ipcMain\.handle\('activation:status', \(\) => activationOperationGate\.run/u)
  assert.doesNotMatch(preload, /license:canStartAnalysis|license:consumeAnalysisCredit/u)
  assert.equal(existsSync(join(process.cwd(), 'src', 'main', 'pointsWallet.ts')), false)
  assert.doesNotMatch(table, /sourceForModel/u)
  assert.doesNotMatch(sop, /buildCleanMessages/u)
  assert.match(store, /scheduleCleaningCheckpointSave\(get\)/u)
  assert.doesNotMatch(store, /fetch\(item\.dataUrl\)/u, 'Office images must not be re-fetched under connect-src none')
  assert.match(store, /attachments: groupedAttachments/u, 'Office images remain grouped under the uploaded parent file')
  assert.match(store, /sourceHasContent/u)
  assert.deepEqual(REPORT_MODULES_V2.map((module) => module.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
  assert.equal(REPORT_MODULES_V2.some((module) => module.key === 'benchmark-brands'), false)
  assert.equal(REPORT_MODULES_V2.some((module) => module.key === 'selling-point-ranking'), false)
  assert.match(store, /:module:v2:/u)
  assert.doesNotMatch(store, /taskType:\s*'module_benchmark'/u, 'v2 client must not invoke the retired benchmark search task')
  assert.doesNotMatch(store, /for \(const step of SOP_STEPS\)/u, 'retired nine-step analysis cannot run after the six-module engine')
  assert.doesNotMatch(store, /:evidence_digest:v2:/u, 'retired evidence pipeline cannot cause duplicate analysis billing')
  assert.match(workflow, /npm run test:regression/u)
  assert.match(workflow, /npm run test:update-release/u)
  assert.match(workflow, /npm run test:html-visual/u)
  assert.match(main, /ipcMain\.handle\('contact:get'/u)
  assert.match(preload, /getContact|onContactChanged/u)
  assert.match(contact, /CONTACT_CONFIG_URL|contact-config\.json|contact-image\.bin/u)
  assert.match(builder, /files:[\s\S]*- out\/\*\*\/\*[\s\S]*- assets\/\*\*\/\*/u)
  assert.doesNotMatch(builder, /win:[\s\S]*files:|mac:[\s\S]*files:/u)
  assert.match(packageScan, /legacyContactPattern/u)
  assert.equal(reportResultCacheInternals.MAX_CACHE_BYTES, 100 * 1024 * 1024)
}

async function testModelFallbackSequence(): Promise<void> {
  const profiles = ['gpt-5.5', 'claude-sonnet-4-6', 'gemini-3-flash'].map((model, index) => ({
    id: `fallback-test-${index}`,
    name: model,
    baseURL: 'https://example.invalid/v1',
    apiKey: 'secret',
    model,
    supportsVision: true
  }))
  const attempts: string[] = []
  assert.deepEqual(
    profilesForTask(profiles, 'module_benchmark').map((item) => item.model),
    ['gpt-5.6-sol', 'gpt-5.5'],
    'only M4 receives the dedicated sol to gpt-5.5 sequence'
  )
  assert.deepEqual(
    profilesForTask(profiles, 'module_product_info').map((item) => item.model),
    profiles.map((item) => item.model),
    'other report modules retain their existing gpt-5.5 fallback sequence'
  )
  const usageModels: string[] = []
  const recovered = await runModelFallbackSequence(profiles, async (current, index) => {
    attempts.push(current.model)
    usageModels.push(current.model)
    if (index === 0) {
      return {
        terminal: { type: 'error' as const, message: 'HTTP 429', usage: { source: 'missing' as const, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, model: current.model } },
        failureKind: 'model_unavailable',
        outputChars: 0,
        hasVisibleOutput: false,
        aborted: false
      }
    }
    return {
      terminal: { type: 'done' as const, full: '完整报告', usage: { source: 'provider' as const, inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 12, model: current.model } },
      outputChars: 4,
      hasVisibleOutput: true,
      aborted: false
    }
  })
  assert.deepEqual(attempts, ['gpt-5.5', 'claude-sonnet-4-6'])
  assert.deepEqual(usageModels, attempts)
  assert.equal(recovered.profile.model, 'claude-sonnet-4-6')
  assert.equal(recovered.outcome.terminal.type, 'done')

  const partialAttempts: string[] = []
  const partial = await runModelFallbackSequence(profiles, async (current) => {
    partialAttempts.push(current.model)
    return {
      terminal: { type: 'error' as const, message: '网络中断', usage: { source: 'missing' as const, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0, model: current.model } },
      failureKind: 'network',
      outputChars: 2,
      hasVisibleOutput: true,
      aborted: false
    }
  })
  assert.deepEqual(partialAttempts, ['gpt-5.5'])
  assert.equal(partial.outcome.terminal.type, 'error')
}

async function testSourceInvalidation(): Promise<void> {
  useStore.setState({
    phase: 'checkpoint1',
    sources: [{ id: 'source-1', name: '旧资料.csv', kind: 'table', text: 'a,b' }],
    cleanDetails: [{ id: 'source-1', name: '旧资料.csv', text: '旧清洗结果' }],
    cleanedData: '旧汇总',
    artifacts: { 1: '旧分析' },
    reportMarkdown: '旧报告'
  })
  useStore.getState().removeSource('source-1')
  const state = useStore.getState()
  assert.equal(state.phase, 'idle')
  assert.equal(state.sources.length, 0)
  assert.equal(state.cleanDetails.length, 0)
  assert.equal(state.cleanedData, '')
  assert.equal(state.reportMarkdown, '旧报告')
  assert.equal(state.artifacts[9], '旧报告')
  assert.equal(state.reportStale, true)
}

async function testResetRollbackOnSaveFailure(): Promise<void> {
  let saves = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => project,
      saveLastProject: async (project: SavedProject) => {
        saves++
        if (saves === 1) throw new Error('simulated save failure')
        return project
      }
    }
  }
  useStore.setState({
    projectRevision: 10,
    persistencePaused: false,
    phase: 'idle',
    sources: [{ id: 'pending', name: 'pending.csv', kind: 'table', parsing: true }],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: { 9: '已完成报告' },
    reportMarkdown: '已完成报告',
    reportStale: false,
    steering: ''
  })
  await assert.rejects(useStore.getState().resetAnalysis(), /simulated save failure/)
  const state = useStore.getState()
  assert.equal(state.sources.length, 1)
  assert.equal(state.sources[0].parsing, false)
  assert.match(state.sources[0].error || '', /中断/)
  assert.equal(state.reportMarkdown, '已完成报告')
  assert.equal(state.projectRevision, 12)
  assert.equal(state.persistencePaused, false)
  assert.equal(saves, 2)
}

async function testZipCannotReturnAfterReset(): Promise<void> {
  let finishArchive!: (items: Array<{ name: string; kind: 'doc'; text: string; ok: true }>) => void
  const archiveResult = new Promise<Array<{ name: string; kind: 'doc'; text: string; ok: true }>>((resolve) => {
    finishArchive = resolve
  })
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseArchive: () => archiveResult,
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => project,
      saveLastProject: async (project: SavedProject) => project
    }
  }

  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    analysisSessionId: crypto.randomUUID()
  })

  const fakeZip = {
    name: 'slow.zip',
    size: 32,
    arrayBuffer: async () => new ArrayBuffer(8)
  }
  const adding = useStore.getState().addSources([fakeZip as File])
  await Promise.resolve()
  await useStore.getState().resetAnalysis()
  finishArchive([{ name: 'old.txt', kind: 'doc', text: '旧内容', ok: true }])
  await adding
  assert.equal(useStore.getState().sources.length, 0)
}

async function testNewAndRestorePreviousAnalysis(): Promise<void> {
  let archived: SavedProject | null = null
  let previous = snapshot(20, '上一份完整报告')
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => {
        archived = project
        previous = project
        return project
      },
      loadPreviousProject: async () => previous,
      saveLastProject: async (project: SavedProject) => project
    }
  }

  useStore.setState({
    projectRevision: 20,
    persistencePaused: false,
    previousProjectAvailable: false,
    phase: 'done',
    sources: [{ id: 'old', name: '旧资料.csv', kind: 'table', text: 'a,b' }],
    messages: [],
    cleanedData: '旧清洗结果',
    cleanDetails: [],
    artifacts: { 9: '上一份完整报告' },
    reportMarkdown: '上一份完整报告',
    reportStale: false,
    steering: '旧目标',
    analysisSessionId: crypto.randomUUID()
  })

  await useStore.getState().resetAnalysis()
  assert.equal(archived?.reportMarkdown, '上一份完整报告')
  assert.equal(useStore.getState().sources.length, 0)
  assert.equal(useStore.getState().reportMarkdown, '')
  assert.equal(useStore.getState().previousProjectAvailable, true)

  await useStore.getState().restorePreviousAnalysis()
  assert.equal(useStore.getState().sources[0]?.name, '旧资料.csv')
  assert.equal(useStore.getState().reportMarkdown, '上一份完整报告')
  assert.equal(useStore.getState().phase, 'done')
  assert.equal(useStore.getState().previousProjectAvailable, false)

  previous = {
    ...snapshot(21, '# 旧版八模块报告'),
    engineVersion: 'v1',
    sources: [{ id: 'legacy-source', name: '旧版资料.csv', kind: 'table', text: 'a,b' }],
    artifacts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, `旧M${index + 1}`])),
    moduleStates: {}
  }
  await useStore.getState().restorePreviousAnalysis()
  assert.equal(useStore.getState().engineVersion, 'v2')
  assert.equal(useStore.getState().artifacts[4].includes('旧M5'), true)
  assert.equal(useStore.getState().artifacts[4].includes('旧M7'), true)
  assert.equal(useStore.getState().artifacts[5], '旧M6')
  assert.equal(useStore.getState().artifacts[6], '旧M8')
  assert.equal(useStore.getState().legacyArtifacts?.[4], '旧M4')
  assert.match(useStore.getState().reportMarkdown, /旧版对标附录/u)
}

async function testIdleGoalAndLateSessionIsolation(): Promise<void> {
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {}
  }
  useStore.setState({
    phase: 'idle',
    messages: [],
    steering: '',
    sources: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false,
    abortFn: null
  })
  await useStore.getState().sendMessage('重点分析年轻用户')
  assert.equal(useStore.getState().steering, '重点分析年轻用户')
  assert.match(useStore.getState().messages.at(-1)?.text || '', /已保存/)

  let abortCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: (
        _messages: unknown,
        _context: unknown,
        handlers: { onError?: (message: string) => void }
      ) => ({
        abort: () => {
          abortCalls++
          handlers.onError?.('已停止')
        }
      }),
      cancelFileParsing: async () => undefined,
      archiveProject: async (project: SavedProject) => project,
      saveLastProject: async (project: SavedProject) => project
    }
  }
  useStore.setState({
    phase: 'checkpoint2',
    messages: [],
    cleanedData: '清洗内容',
    artifacts: { 1: '第一步', 9: '旧报告' },
    reportMarkdown: '旧报告',
    steering: '修订',
    abortFn: null,
    analysisSessionId: crypto.randomUUID()
  })
  const rerun = useStore.getState()._rerunReport()
  await Promise.resolve()
  await useStore.getState().resetAnalysis()
  await rerun
  assert.equal(abortCalls, 1)
  assert.equal(useStore.getState().phase, 'idle')
  assert.equal(useStore.getState().reportMarkdown, '')
  assert.equal(useStore.getState().messages.length, 0)
}

async function testReportRollbackAndExportGuard(): Promise<void> {
  let exportCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: (_messages: unknown, _context: unknown, handlers: { onChunk?: (value: string) => void; onError?: (value: string) => void }) => {
        queueMicrotask(() => {
          handlers.onChunk?.('不完整的新报告')
          handlers.onError?.('模拟中断')
        })
        return { abort: () => undefined }
      },
      exportHtml: async () => {
        exportCalls++
        return { ok: true, path: 'test.html' }
      }
    }
  }

  useStore.setState({
    phase: 'checkpoint2',
    cleanedData: '清洗数据',
    artifacts: { 1: '步骤一', 9: '完整旧报告' },
    reportMarkdown: '完整旧报告',
    steering: '修订要求',
    abortFn: null
  })
  await useStore.getState()._rerunReport()
  assert.equal(useStore.getState().phase, 'checkpoint2')
  assert.equal(useStore.getState().reportMarkdown, '完整旧报告')

  useStore.setState({ phase: 'analyzing', reportMarkdown: '生成中的半成品' })
  await useStore.getState().exportReport('html')
  assert.equal(exportCalls, 0)

  const duringGeneration = buildProjectSnapshot({
    projectRevision: 4,
    sources: [],
    messages: [],
    cleanedData: '清洗数据',
    cleanDetails: [],
    artifacts: { 9: '上一次完整报告' },
    reportMarkdown: '本次只生成了一半',
    reportStale: true,
    phase: 'analyzing',
    steering: ''
  })
  assert.equal(duringGeneration.reportMarkdown, '上一次完整报告')
}

async function testDoubleExportGuard(): Promise<void> {
  let exportCalls = 0
  let finishExport!: () => void
  const pending = new Promise<void>((resolve) => {
    finishExport = resolve
  })
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      exportDocx: async () => {
        exportCalls++
        await pending
        return { ok: true, path: 'report.docx' }
      }
    }
  }
  useStore.setState({
    phase: 'done',
    artifacts: { 9: HTML_REPORT_FIXTURE },
    reportMarkdown: HTML_REPORT_FIXTURE,
    reportStale: false,
    exportStatus: ''
  })
  const first = useStore.getState().exportReport('docx')
  const second = useStore.getState().exportReport('docx')
  await second
  assert.equal(exportCalls, 1)
  finishExport()
  await first
  assert.match(useStore.getState().exportStatus, /已导出/)
}

async function testFeedbackArrivingDuringRevision(): Promise<void> {
  let calls = 0
  const taskContexts: Array<Record<string, unknown>> = []
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: (
        _messages: unknown,
        context: Record<string, unknown>,
        handlers: { onChunk?: (value: string) => void; onDone?: (value: string) => void }
      ) => {
        taskContexts.push(context)
        const call = ++calls
        const part = FINAL_REPORT_PARTS.find((candidate) => candidate.id === context.partId)
        assert.ok(part)
        const fixtureLines = HTML_REPORT_FIXTURE.split(/\r?\n/u)
        const selected: string[] = []
        if (part.includeTitle) {
          const firstSection = fixtureLines.findIndex((line) => /^##\s+0[.、：:\s]/u.test(line.trim()))
          selected.push(...fixtureLines.slice(0, firstSection))
        }
        for (const section of part.sections) {
          const start = fixtureLines.findIndex((line) => new RegExp(`^##\\s+${section}(?:[.、：:\\s]|$)`, 'u').test(line.trim()))
          assert.ok(start >= 0)
          const relativeEnd = fixtureLines.slice(start + 1).findIndex((line) => /^##\s+(?:10|11|[0-9])(?:[.、：:\s]|$)/u.test(line.trim()))
          const end = relativeEnd >= 0 ? start + 1 + relativeEnd : fixtureLines.length
          selected.push(...fixtureLines.slice(start, end))
        }
        if (part.includeFooter && !selected.some((line) => line.includes('内容由 AI 生成'))) {
          const footer = fixtureLines.find((line) => line.includes('内容由 AI 生成'))
          if (footer) selected.push(footer)
        }
        const output = `${selected.join('\n').trim()}\n\n修订批次${call}`
        queueMicrotask(() => {
          handlers.onChunk?.(output)
          if (call === 1) useStore.setState({ steering: '第一条要求\n修订期间的新要求' })
          handlers.onDone?.(output)
        })
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    phase: 'checkpoint2',
    messages: [],
    cleanedData: '清洗内容',
    artifacts: { 1: '第一步', 9: '旧完整报告' },
    reportMarkdown: '旧完整报告',
    reportStale: false,
    steering: '第一条要求',
    abortFn: null,
    analysisSessionId: crypto.randomUUID()
  })
  await useStore.getState()._rerunReport()
  assert.equal(calls, 8)
  assert.equal(taskContexts.every((context) => context.taskType === 'revision_part'), true)
  assert.deepEqual([...new Set(taskContexts.slice(0, 4).map((context) => context.partId))].sort(), [
    'part-0-4',
    'part-10-11',
    'part-5-8',
    'part-9'
  ])
  assert.equal(taskContexts.every((context) => context.attempt === 1), true)
  assert.equal(new Set(taskContexts.slice(0, 4).map((context) => String(context.taskKey).split(':').slice(0, -1).join(':'))).size, 1)
  assert.equal(new Set(taskContexts.slice(4).map((context) => String(context.taskKey).split(':').slice(0, -1).join(':'))).size, 1)
  assert.notEqual(
    String(taskContexts[0].taskKey).split(':').slice(0, -1).join(':'),
    String(taskContexts[4].taskKey).split(':').slice(0, -1).join(':')
  )
  assert.equal(useStore.getState().phase, 'checkpoint2')
  assert.match(useStore.getState().reportMarkdown, /修订批次5/u)
  assert.equal(useStore.getState().artifacts[9], useStore.getState().reportMarkdown)
}

const profile: ModelProfile = {
  id: 'test',
  name: '测试模型',
  baseURL: 'https://example.invalid/v1',
  apiKey: 'secret',
  model: 'test-model',
  supportsVision: false
}

function responseStream(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { headers: { 'content-type': contentType } }
  )
}

async function testStrictModelCompletion(): Promise<void> {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }), {
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    const empty = await testModel({ profile })
    assert.equal(empty.ok, false)
    assert.match(empty.message, /没有返回文字/)

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '半截' }, finish_reason: 'length' }] }), {
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    const truncated = await testModel({ profile })
    assert.equal(truncated.ok, false)
    assert.match(truncated.message, /不完整/)

    const normalEvents: ChatStreamEvent[] = []
    let streamingRequestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      streamingRequestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      return responseStream([
        'data: {"choices":[{"delta":{"content":"完"}}]}\n',
        '\ndata: {"choices":[{"delta":{"content":"整"},"finish_reason":"stop"}]}\n\n',
        'data: {"model":"gpt-5.5","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150,"prompt_tokens_details":{"cached_tokens":40,"cache_creation_tokens":10},"completion_tokens_details":{"reasoning_tokens":12}}}\n\n',
        'data: [DONE]\n\n'
      ])
    }) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => normalEvents.push(event))
    assert.deepEqual(streamingRequestBody?.stream_options, { include_usage: true })
    assert.equal('temperature' in (streamingRequestBody || {}), false)
    const usageEvent = normalEvents.find((event) => event.type === 'usage')
    assert.equal(usageEvent?.type === 'usage' ? usageEvent.usage.inputTokens : 0, 120)
    assert.equal(usageEvent?.type === 'usage' ? usageEvent.usage.cachedInputTokens : 0, 40)
    assert.equal(usageEvent?.type === 'usage' ? usageEvent.usage.cacheCreationInputTokens : 0, 10)
    assert.equal(usageEvent?.type === 'usage' ? usageEvent.usage.reasoningTokens : 0, 12)
    assert.equal(normalEvents.at(-1)?.type, 'done')
    assert.equal(normalEvents.at(-1)?.type === 'done' ? normalEvents.at(-1)?.full : '', '完整')
    assert.equal(normalEvents.at(-1)?.type === 'done' ? normalEvents.at(-1)?.usage.totalTokens : 0, 150)

    const searchEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () => responseStream([
      'data: {"choices":[{"delta":{"content":"对标结果"},"finish_reason":"stop"}]}\n\n',
      'data: {"type":"por.search_status","status":"verified","search_calls":1,"evidence_count":2}\n\n',
      'data: {"type":"por.search_evidence","evidence":{"callId":"search-1","query":"品牌 天猫","title":"旗舰店","url":"https://brand.tmall.com/store","platform":"天猫","retrievedAt":"2026-08-25T00:00:00Z"}}\n\n',
      'data: {"type":"por.search_evidence","evidence":{"callId":"search-1","title":"私网","url":"http://127.0.0.1/private","platform":"其他","retrievedAt":"2026-08-25T00:00:00Z"}}\n\n',
      'data: [DONE]\n\n'
    ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试搜索证据' }], (event) => searchEvents.push(event))
    const searchStatus = searchEvents.find((event) => event.type === 'search_status')
    const evidenceEvents = searchEvents.filter((event) => event.type === 'search_evidence')
    assert.equal(searchStatus?.type === 'search_status' ? searchStatus.status : '', 'verified')
    assert.equal(evidenceEvents.length, 1, 'private or dangerous search URLs are discarded in the client')
    assert.equal(evidenceEvents[0]?.type === 'search_evidence' ? evidenceEvents[0].evidence.platform : '', '天猫')
    assert.equal(searchEvents.at(-1)?.type, 'done')

    const jsonEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        model: 'gpt-5.5-json',
        choices: [{ message: { content: '普通响应' }, finish_reason: 'stop' }],
        usage: { input_tokens: 90, output_tokens: 15, total_tokens: 105, input_tokens_details: { cached_tokens: 20 } }
      }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => jsonEvents.push(event))
    assert.equal(jsonEvents.at(-1)?.type === 'done' ? jsonEvents.at(-1)?.usage.totalTokens : 0, 105)
    assert.equal(jsonEvents.at(-1)?.type === 'done' ? jsonEvents.at(-1)?.usage.model : '', 'gpt-5.5-json')

    const earlyEofEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream(['data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => earlyEofEvents.push(event))
    assert.equal(earlyEofEvents.at(-1)?.type, 'error')
    assert.match(earlyEofEvents.at(-1)?.type === 'error' ? earlyEofEvents.at(-1)?.message || '' : '', /提前结束/)
    assert.equal(earlyEofEvents.at(-1)?.type === 'error' ? earlyEofEvents.at(-1)?.usage.source : '', 'missing')

    const stopWithoutSentinelEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream([
        'data: {"choices":[{"delta":{"content":"兼容完成"},"finish_reason":"stop"}]}\n\n',
        'data: {"model":"gpt-5.5","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}\n\n'
      ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试无DONE兼容' }], (event) => stopWithoutSentinelEvents.push(event))
    assert.equal(stopWithoutSentinelEvents.at(-1)?.type, 'done', 'finish_reason=stop is a valid terminal state without [DONE]')
    assert.equal(
      stopWithoutSentinelEvents.at(-1)?.type === 'done' ? stopWithoutSentinelEvents.at(-1)?.full : '',
      '兼容完成'
    )
    assert.equal(
      stopWithoutSentinelEvents.at(-1)?.type === 'done' ? stopWithoutSentinelEvents.at(-1)?.usage.totalTokens : 0,
      24
    )

    const normalized = normalizeProviderUsage(
      { prompt_tokens: 12.9, completion_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
      'fallback'
    )
    assert.deepEqual(normalized, {
      source: 'provider',
      inputTokens: 12,
      outputTokens: 3,
      reasoningTokens: 0,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 7,
      totalTokens: 15,
      model: 'fallback'
    })

    const reasoningFallbackBodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      reasoningFallbackBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
      if (reasoningFallbackBodies.length === 1) return new Response('{"error":"unsupported reasoning_effort"}', { status: 400 })
      return responseStream([
        'data: {"choices":[{"delta":{"content":"兼容"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
        'data: [DONE]\n\n'
      ])
    }) as typeof fetch
    const fallbackEvents: ChatStreamEvent[] = []
    await chatStream(profile, [{ role: 'user', content: '测试低推理兼容' }], (event) => fallbackEvents.push(event), undefined, { reasoningEffort: 'low' })
    assert.equal(reasoningFallbackBodies.length, 2)
    assert.equal(reasoningFallbackBodies[0].reasoning_effort, 'low')
    assert.equal(reasoningFallbackBodies[1].reasoning_effort, undefined)
    assert.equal(fallbackEvents.at(-1)?.type, 'done')

    const cacheBodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      cacheBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
      if (cacheBodies.length === 1) return new Response('{"error":"cache_control unsupported"}', { status: 400 })
      return responseStream([
        'data: {"choices":[{"delta":{"content":"缓存兼容"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}\n\n',
        'data: [DONE]\n\n'
      ])
    }) as typeof fetch
    const cacheEvents: ChatStreamEvent[] = []
    await chatStream(
      { ...profile, model: 'claude-sonnet-4-6' },
      [{ role: 'system', content: '稳定公共前缀' }, { role: 'user', content: '当前任务' }],
      (event) => cacheEvents.push(event),
      undefined,
      { promptCacheKey: 'analysis:test-report:evidence-digest-v1' }
    )
    assert.equal(cacheBodies[0].prompt_cache_key, 'analysis:test-report:evidence-digest-v1')
    assert.match(JSON.stringify(cacheBodies[0].messages), /cache_control/u)
    assert.equal(cacheBodies[1].prompt_cache_key, undefined, 'unsupported cache extensions retry once without caching')
    assert.doesNotMatch(JSON.stringify(cacheBodies[1].messages), /cache_control/u)
    assert.equal(cacheEvents.at(-1)?.type, 'done')

    const lengthEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream([
        'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
        'data: {"choices":[{"finish_reason":"length"}]}\n\n'
      ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => lengthEvents.push(event))
    assert.equal(lengthEvents.at(-1)?.type, 'error')
    assert.match(lengthEvents.at(-1)?.type === 'error' ? lengthEvents.at(-1)?.message || '' : '', /长度上限/)

    const malformedEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      responseStream([
        'data: {"choices":[{"delta":{"content":"半截"}}]}\n\n',
        'data: {broken-json}\n\n',
        'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n'
      ])) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => malformedEvents.push(event))
    assert.equal(malformedEvents.at(-1)?.type, 'error')
    assert.match(malformedEvents.at(-1)?.type === 'error' ? malformedEvents.at(-1)?.message || '' : '', /损坏/)

    const rateLimitEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      new Response('{"error":"busy"}', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '2' }
      })) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试' }], (event) => rateLimitEvents.push(event))
    assert.equal(rateLimitEvents.at(-1)?.type, 'error')
    assert.match(rateLimitEvents.at(-1)?.type === 'error' ? rateLimitEvents.at(-1)?.message || '' : '', /等待 2 秒/)

    const insufficientPointsEvents: ChatStreamEvent[] = []
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        ok: false,
        message: '积分不足：当前可用 100 积分，本批最多需要暂时预留 117.074 积分。系统尚未扣费。'
      }), {
        status: 402,
        statusText: 'Payment Required',
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
    await chatStream(profile, [{ role: 'user', content: '测试积分提示' }], (event) => insufficientPointsEvents.push(event))
    assert.equal(insufficientPointsEvents.at(-1)?.type, 'error')
    const pointsMessage = insufficientPointsEvents.at(-1)?.type === 'error'
      ? insufficientPointsEvents.at(-1)?.message || ''
      : ''
    assert.match(pointsMessage, /当前可用 100 积分/)
    assert.doesNotMatch(pointsMessage, /\{"ok"/)

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ data: Array.from({ length: 650 }, (_, index) => ({ id: `model-${index}` })) }),
        { headers: { 'content-type': 'application/json' } }
      )) as typeof fetch
    const models = await listModels(profile)
    assert.equal(models.ok, true)
    assert.equal(models.models?.length, 500)
  } finally {
    globalThis.fetch = originalFetch
  }
}

function makeTokenRecord(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  const totalTokens = overrides.totalTokens ?? 100
  const inputTokens = overrides.inputTokens ?? Math.max(0, totalTokens - 20)
  const outputTokens = overrides.outputTokens ?? Math.max(0, totalTokens - inputTokens)
  return {
    schemaVersion: 1,
    eventType: 'final',
    requestId: crypto.randomUUID(),
    reportSessionId: 'report-default',
    taskType: 'analysis_step',
    taskKey: 'report-default:analysis_step:1',
    attempt: 1,
    isVision: false,
    sourceCount: 7,
    imageCount: 1,
    stepId: '1',
    model: 'gpt-5.5',
    status: 'success',
    startedAt: '2026-08-09T01:00:00.000Z',
    endedAt: '2026-08-09T01:00:01.000Z',
    durationMs: 1_000,
    outputChars: 60,
    usageSource: 'provider',
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens,
    ...overrides
  }
}

async function testTokenUsageMeasurement(): Promise<void> {
  const estimate = estimateRequestTokens([
    { role: 'system', content: '短提示' },
    { role: 'user', content: [{ type: 'text', text: '文本资料' }, { type: 'image', dataUrl: 'data:image/png;base64,SECRET_IMAGE' }] }
  ], 30)
  assert.equal(estimate.inputTokens >= 2_000, true)
  assert.equal(estimate.outputTokens, 10)
  const stableContext = sanitizeModelTaskContext({
    reportSessionId: 'report-1',
    taskType: 'source_clean',
    taskKey: 'report-1:source_clean:file-1',
    billingRequestId: 'report-1:source_clean:file-1',
    attempt: 1,
    isVision: true,
    sourceCount: 3,
    imageCount: 1,
    sourceId: 'file-1'
  })
  assert.equal(stableContext?.isVision, true)
  assert.equal(stableContext?.billingRequestId, 'report-1:source_clean:file-1')
  assert.equal(sanitizeModelTaskContext({
    reportSessionId: 'bad id with spaces',
    taskType: 'summary',
    taskKey: 'bad',
    attempt: 1,
    isVision: false,
    sourceCount: 1,
    imageCount: 0
  }), undefined)

  const records: TokenUsageRecord[] = []
  const reportTotals = [1_000, 2_000, 3_000, 4_000]
  const sourceCounts = [3, 7, 15, 25]
  const parts = ['part-0-4', 'part-5-8', 'part-9', 'part-10-11']
  reportTotals.forEach((reportTotal, reportIndex) => {
    parts.forEach((partId, partIndex) => {
      const partTotal = reportTotal / parts.length
      records.push(makeTokenRecord({
        requestId: `report-${reportIndex + 1}-part-${partIndex + 1}`,
        reportSessionId: `report-${reportIndex + 1}`,
        taskType: 'final_part',
        taskKey: `report-${reportIndex + 1}:final_part:${partId}`,
        partId,
        sourceCount: sourceCounts[reportIndex],
        imageCount: reportIndex,
        totalTokens: partTotal,
        inputTokens: partTotal - 50,
        outputTokens: 50
      }))
    })
  })
  records.push(makeTokenRecord({
    requestId: 'missing-retry',
    reportSessionId: 'report-missing',
    taskType: 'source_clean',
    taskKey: 'report-missing:source_clean:file-1',
    sourceId: 'file-1',
    attempt: 2,
    status: 'error',
    failureKind: 'network',
    usageSource: 'missing',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedInputTokens: 500,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 500
  }))
  const dashboard = buildTokenUsageDashboard(records, true, 'test-token-usage.jsonl')
  assert.deepEqual(dashboard.percentiles, { sampleSize: 4, p50: 2_000, p75: 3_000, p95: 4_000 })
  assert.equal(dashboard.buckets.every((bucket) => bucket.exactCompletedCount === 1), true)
  assert.equal(dashboard.missingUsageRecordCount, 1)
  for (const report of dashboard.reports.filter((item) => item.completed)) {
    assert.equal(report.totalTokens, report.stages.reduce((sum, stage) => sum + stage.totalTokens, 0))
    assert.equal(report.totalTokens, report.successfulTokens + report.failedTokens + report.abortedTokens)
  }

  const path = tokenUsageLogPath()
  rmSync(path, { force: true })
  tokenUsageInternals.resetForTests()
  const started = makeTokenRecord({
    eventType: 'started',
    requestId: 'local-request-1',
    reportSessionId: 'local-report',
    taskKey: 'local-report:summary',
    taskType: 'summary',
    status: 'started',
    usageSource: 'missing',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedInputTokens: 123,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 123
  })
  const final = makeTokenRecord({
    requestId: 'local-request-1',
    reportSessionId: 'local-report',
    taskKey: 'local-report:summary',
    taskType: 'summary',
    totalTokens: 222,
    inputTokens: 200,
    outputTokens: 22
  })
  assert.equal(await appendTokenUsageRecord(started), true)
  assert.equal(await appendTokenUsageRecord(final), true)
  assert.equal(await appendTokenUsageRecord(final), false)
  const crashStart = makeTokenRecord({
    eventType: 'started',
    requestId: 'crashed-request',
    reportSessionId: 'crashed-report',
    taskKey: 'crashed-report:source_clean:file-1',
    taskType: 'source_clean',
    sourceId: 'file-1',
    status: 'started',
    usageSource: 'missing',
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedTotalTokens: 321
  })
  await appendTokenUsageRecord(crashStart)
  appendFileSync(path, '{"truncated":', 'utf8')
  const reloaded = await readTokenUsageRecords(path)
  assert.equal(reloaded.length, 3)
  const recovered = buildTokenUsageDashboard(reloaded)
  const crashed = recovered.reports.find((report) => report.reportSessionId === 'crashed-report')
  assert.equal(crashed?.abortedAttempts, 1)
  assert.equal(crashed?.missingUsageAttempts, 1)
  const rawLog = readFileSync(path, 'utf8')
  assert.doesNotMatch(rawLog, /SECRET_IMAGE|prompt|activation_code|apiKey|sk-/i)
  rmSync(path, { force: true })
  for (const file of readdirSync(tempUserData).filter((name) => /^token-usage-.*\.archive$/u.test(name))) {
    rmSync(join(tempUserData, file), { force: true })
  }
  writeFileSync(path, Buffer.alloc(tokenUsageInternals.ROTATE_LOG_BYTES + 1, 0x20))
  await tokenUsageInternals.rotateTokenLogIfNeeded(path, 1)
  assert.equal(existsSync(path), false, 'oversized current log is rotated before the next append')
  assert.equal(readdirSync(tempUserData).some((name) => /^token-usage-.*\.archive$/u.test(name)), true)
  tokenUsageInternals.resetForTests()
  const afterRotation = makeTokenRecord({ requestId: 'after-log-rotation', reportSessionId: 'rotation-report' })
  assert.equal(await appendTokenUsageRecord(afterRotation), true)
  assert.equal((await readTokenUsageRecords(path)).some((record) => record.requestId === 'after-log-rotation'), true)
}

async function testCostOptimizationPrimitives(): Promise<void> {
  await clearSourceCleanCache()
  await sourceCleanCacheInternals.resetForTests()
  const source = {
    name: '画像.csv',
    kind: 'table' as const,
    text: '标签类型,标签,占比\n年龄,30-39,45%',
    attribution: '自有数据',
    platform: '视频号',
    purpose: '人群画像数据',
    note: '近30天'
  }
  const key = sourceCleanCacheKey(source, 'gpt-5.5')
  assert.equal(key.length, 64)
  assert.notEqual(sourceCleanCacheKey({ ...source, note: '近7天' }, 'gpt-5.5'), key)
  assert.notEqual(sourceCleanCacheKey({ ...source, text: `${source.text}\n年龄,40-49,20%` }, 'gpt-5.5'), key)
  assert.notEqual(sourceCleanCacheKey({
    ...source,
    attachments: [{ name: '第1页/image1.png', dataUrl: 'data:image/png;base64,AAAA' }]
  }, 'gpt-5.5'), key, 'embedded image content participates in the parent file cache key')
  const stored = await storeSourceCleanCache(source, 'gpt-5.5', '清洗结果')
  assert.equal(stored.stored, true, 'cache store')
  const hit = await lookupSourceCleanCache(source, 'gpt-5.5')
  assert.equal(hit.hit, true, 'cache hit')
  assert.equal(hit.text, '清洗结果')
  assert.equal(hit.stats.totalHits, 1)
  assert.equal((await lookupSourceCleanCache({ ...source, platform: '抖音' }, 'gpt-5.5')).hit, false)
  assert.notEqual(sourceCleanCacheKey(source, 'gpt-5.4'), key)
  const warmSources = Array.from({ length: 7 }, (_, index) => ({
    ...source,
    name: `复用资料-${index + 1}.csv`,
    text: `${source.text}\n序号,${index + 1},${index + 1}%`
  }))
  for (const [index, item] of warmSources.entries()) {
    assert.equal((await storeSourceCleanCache(item, 'gpt-5.5', `清洗结果-${index + 1}`)).stored, true)
  }
  const warmHits = await Promise.all(warmSources.map((item) => lookupSourceCleanCache(item, 'gpt-5.5')))
  assert.equal(warmHits.filter((item) => item.hit).length, 7)

  const now = new Date('2026-08-09T00:00:00.000Z')
  const entries = Array.from({ length: 205 }, (_, index) => ({
    key: index.toString(16).padStart(64, '0'),
    createdAt: '2026-08-01T00:00:00.000Z',
    lastUsedAt: new Date(now.getTime() - index * 1_000).toISOString(),
    expiresAt: index === 204 ? '2026-08-08T00:00:00.000Z' : '2026-09-01T00:00:00.000Z',
    model: 'gpt-5.5',
    bytes: 6
  }))
  const pruned = sourceCleanCacheInternals.pruneCache({ version: 2, totalHits: 3, entries }, now)
  assert.equal(pruned.entries.length, 200)
  assert.equal(pruned.entries.some((entry) => entry.expiresAt < now.toISOString()), false)

  const oversized = sourceCleanCacheInternals.pruneCache({
    version: 2,
    totalHits: 0,
    entries: Array.from({ length: 30 }, (_, index) => ({
      key: (index + 1).toString(16).padStart(64, '0'),
      createdAt: '2026-08-09T00:00:00.000Z',
      lastUsedAt: new Date(now.getTime() - index * 1_000).toISOString(),
      expiresAt: '2026-09-01T00:00:00.000Z',
      model: 'gpt-5.5',
      bytes: 2_000_000
    }))
  }, now)
  assert.ok(oversized.entries.length < 30, 'cache byte-cap evicts LRU entries')
  assert.ok(
    Buffer.byteLength(JSON.stringify(oversized), 'utf8') + oversized.entries.reduce((sum, entry) => sum + entry.bytes, 0) <=
      sourceCleanCacheInternals.MAX_CACHE_BYTES
  )

  const profileText = [
    '标签类型,标签,占比',
    ...Array.from({ length: 80 }, (_, index) => `${index < 40 ? '年龄' : '地区'},标签${index}${'说明'.repeat(100)},${80 - index}%`)
  ].join('\n')
  const profile = preprocessTableForModel(profileText)
  assert.equal(
    profile.applied,
    true,
    `profile preprocessing: applied=${profile.applied} mode=${profile.mode} rows=${profile.originalRows}`
  )
  assert.equal(profile.mode, 'profile')
  assert.equal(profile.retainedRows, 80, 'structured preprocessing must preserve every profile row')
  assert.equal(profile.canSkipModel, true, 'reliable profile tables are completed locally')
  assert.match(profile.text, /标签79/u)

  const materialText = [
    '原视频,完整文案,前三秒文案,素材类型,视角分析,内容形式,场景标签,卖点排序,豆包,豆包.思考过程,豆包.输出结果',
    ...Array.from({ length: 200 }, (_, index) => {
      const wrapper = `旧AI包装${index}-${'冗余'.repeat(20)}`
      return `video-${index}.mp4,${`内容${index}`.repeat(20)},开头${index},3.2,用户视角,产品展示型,家庭,卖点${index},${wrapper},秘密推理${index},${wrapper}`
    })
  ].join('\n')
  const material = preprocessTableForModel(materialText)
  assert.equal(material.applied, true, `material preprocessing: ${JSON.stringify(material)}`)
  assert.equal(material.mode, 'material')
  assert.equal(material.canSkipModel, true)
  assert.equal(material.retainedRows, 200, 'material preprocessing must never rank or sample rows')
  assert.doesNotMatch(material.text, /秘密推理|旧AI包装|思考过程|输出结果/u)
  assert.match(material.text, /视角分析/u)
  assert.ok(material.text.indexOf('video-0.mp4') < material.text.indexOf('video-199.mp4'))
  assert.match(material.text, /开头199/u)

  for (const recordCount of [2, 59, 121, 437]) {
    const rows = [
      ['原视频', '3秒开头原文', '完整文案', '素材类型', '产品'],
      ...Array.from({ length: recordCount }, (_, index) => [
        `video-${index + 1}.mp4`,
        `开头${index + 1}`,
        `第${index + 1}条完整文案\n${'长文案'.repeat(90)}`,
        index % 2 ? '口播' : '场景展示',
        index % 3 ? '产品A' : '产品B'
      ])
    ]
    const source = {
      name: `浮动条数-${recordCount}.xlsx`,
      kind: 'table' as const,
      text: `### 工作表：素材\n${Papa.unparse(rows, { newline: '\n' })}`,
      attribution: '竞品数据'
    }
    const plan = buildSourceCleanBatchPlan(source)
    assert.equal(plan.mode, 'table_rows')
    assert.equal(plan.originalRecordCount, recordCount)
    assert.equal(plan.scheduledRecordCount, recordCount)
    assert.equal(plan.isMaterialTable, true)
    const sentText = plan.batches.map((batch) => batch.source.text || '').join('\n')
    for (let index = 0; index < recordCount; index++) {
      assert.equal(
        sentText.split(`video-${index + 1}.mp4`).length - 1,
        1,
        `record ${index + 1}/${recordCount} must enter exactly one cleaning batch`
      )
    }
    assert.ok(
      plan.batches.every((batch) => (batch.source.text || '').length <= sourceCleanBatchInternals.CLEAN_BATCH_CHAR_LIMIT),
      `normal table batches stay within the model-safe limit for ${recordCount} rows`
    )
    const combined = combineSourceCleanBatchOutputs(
      plan,
      plan.batches.map((batch, index) =>
        `分类：竞品数据 | 抖音 | 素材数据 | 需补充 | 表格 | 第${index + 1}批\n\n` +
          (batch.source.text || '')
      )
    )
    assert.match(combined, new RegExp(`已覆盖素材数量：${recordCount} 条`, 'u'))
    assert.match(combined, /全部有效记录均已送入清洗|未做抽样/u)
    const answerSheet = plan.batches.map((batch, index) =>
      `分类：竞品数据 | 抖音 | 素材数据 | 第${index + 1}批\n${'摘要内容'.repeat(900)}\n` +
        batch.context.evidenceIds.join('\n')
    )
    assert.throws(
      () => combineSourceCleanBatchOutputs(plan, answerSheet),
      /未覆盖/u,
      'copying the answer sheet at the end cannot pass row coverage'
    )
    const shortRows = plan.batches.map((batch, index) => {
      const rows = Papa.parse<string[]>(batch.source.text || '', { skipEmptyLines: 'greedy' }).data
      return `分类：竞品数据 | 抖音 | 素材数据 | 第${index + 1}批\n${Papa.unparse(rows.slice(0, -1))}`
    })
    assert.throws(
      () => combineSourceCleanBatchOutputs(plan, shortRows),
      /未覆盖/u,
      'fewer output rows than evidence IDs cannot pass coverage'
    )
    const extractionPrompt = String(buildExtractMessages(plan.batches[0].source, plan.batches[0].context)[1].content)
    for (const id of plan.batches[0].context.evidenceIds) {
      assert.equal(extractionPrompt.split(id).length - 1, 1, 'table prompt must not repeat the evidence answer sheet')
    }
  }

  assert.ok(
    sourceCleanBatchInternals.CLEAN_BATCH_CHAR_LIMIT < sourceCleanBatchInternals.SOURCE_TEXT_COMPATIBILITY_LIMIT,
    'cleaning batches must remain below the source compaction threshold'
  )
  const tooWideTable = Papa.unparse([
    Array.from({ length: 201 }, (_, index) => `列${index + 1}`),
    Array.from({ length: 201 }, (_, index) => `值${index + 1}`)
  ])
  const degraded = buildSourceCleanBatchPlan({ name: '超宽表格.csv', kind: 'table', text: tooWideTable })
  assert.equal(degraded.mode, 'single')
  assert.equal(degraded.degradedReason, 'too_wide')

  const longDocument = `文档开头-${'A'.repeat(70_000)}-文档中段-${'B'.repeat(70_000)}-文档结尾`
  const documentPlan = buildSourceCleanBatchPlan({ name: '长文档.md', kind: 'doc', text: longDocument })
  assert.ok(documentPlan.batches.length > 1)
  assert.equal(
    documentPlan.batches
      .map((batch) => (batch.source.text || '').replace(/^【证据片段ID】POR-T-[A-F0-9]{8}-\d{6}\n/u, ''))
      .join(''),
    longDocument
  )
  assert.match(documentPlan.batches[0].source.text || '', /文档开头/u)
  assert.match(documentPlan.batches[documentPlan.batches.length - 1].source.text || '', /文档结尾/u)
  assert.throws(
    () => combineSourceCleanBatchOutputs(documentPlan, ['只完成一批']),
    /清洗批次不完整/u,
    'partial batch output must never be marked complete'
  )

  const flexiblePrompt = buildExtractMessages(
    { name: '不规则资料.json', kind: 'doc', text: '{"未知字段":"必须保留"}' },
    documentPlan.batches[0].context
  )
  assert.match(String(flexiblePrompt[1].content), /不要硬套同一种模板|保留原有层级和字段|不得.*抽样/u)
  assert.match(String(flexiblePrompt[1].content), /未知字段/u)

  const summarySource = [
    '分类：竞品数据 | 抖音 | 素材数据 | 需补充 | 表格 | 多批资料',
    '## 系统完整性核对\n- 动态清洗批次：4 批',
    ...Array.from({ length: 4 }, (_, index) =>
      `### 清洗批次 ${index + 1}/4\n批次标记-${index + 1}\n${String(index + 1).repeat(5_000)}`
    )
  ].join('\n\n')
  const summaryMessages = buildSummaryMessages([{ name: '多批素材.csv', text: summarySource }])
  const summaryPayload = String(summaryMessages[1].content)
  assert.match(summaryPayload, /批次标记-1/u)
  assert.match(summaryPayload, /批次标记-4/u)
  assert.match(summaryPayload, /完整结果仍保存在来源清洗明细/u)
  assert.doesNotMatch(summaryPayload, /本文件清洗结果过长，已截断/u)

  const allCoverageText = [
    `超大资料开头-${'甲'.repeat(90_000)}`,
    `超大资料中段-${'乙'.repeat(90_000)}`,
    `超大资料结尾-${'丙'.repeat(90_000)}`
  ].join('\n')
  const summaryGroups = planSummaryDetailGroups([
    { name: '超大经营资料.txt', text: allCoverageText },
    { name: '小型补充资料.md', text: '补充证据-必须进入汇总' }
  ])
  assert.ok(summaryGroups.length > 1, 'oversized clean details use hierarchical summary groups')
  const reconstructed = summaryGroups
    .flatMap((group) => group.parts)
    .filter((part) => part.sourceName === '超大经营资料.txt')
    .map((part) => part.text)
    .join('')
  assert.equal(reconstructed, allCoverageText, 'every character enters exactly one hierarchical summary group')
  const groupPayloads = summaryGroups.map((group, index) =>
    String(buildSummaryGroupMessages(group, index + 1, summaryGroups.length)[1].content)
  )
  assert.match(groupPayloads.join('\n'), /超大资料开头/u)
  assert.match(groupPayloads.join('\n'), /超大资料中段/u)
  assert.match(groupPayloads.join('\n'), /超大资料结尾/u)
  assert.match(groupPayloads.join('\n'), /补充证据-必须进入汇总/u)
  const mergedSummaryPrompt = String(buildSummaryMergeMessages(['中间汇总A', '中间汇总B'])[1].content)
  assert.match(mergedSummaryPrompt, /中间汇总A[\s\S]*中间汇总B/u)

  const unknownText = ['甲列,乙列', ...Array.from({ length: 800 }, (_, index) => `${index},${'未知'.repeat(20)}`)].join('\n')
  const unknown = preprocessTableForModel(unknownText)
  assert.equal(unknown.applied, false)
  assert.equal(unknown.text, unknownText)

  const productText = [
    '统计周期,商品名称,商品编码,成交金额,成交订单数,投放消耗（店铺被投）,完全无关字段',
    ...Array.from({ length: 160 }, (_, index) => `2026-08,商品${index},SKU-${index},${index * 10},${index},${index * 2},${'冗余'.repeat(60)}`)
  ].join('\n')
  const product = preprocessTableForModel(productText)
  assert.equal(product.applied, true)
  assert.equal(product.mode, 'product')
  assert.match(product.text, /商品名称|成交金额|成交订单数/u)
  assert.match(product.text, /完全无关字段/u, 'unknown business columns are preserved instead of guessed away')
  const unrankableProductText = [
    '商品名称,商品编码,完全未知字段',
    ...Array.from({ length: 200 }, (_, index) => `商品${index},SKU-${index},${'未知'.repeat(80)}`)
  ].join('\n')
  const unrankableProduct = preprocessTableForModel(unrankableProductText)
  assert.equal(unrankableProduct.canSkipModel, true, 'reliable structured product rows do not require a ranking metric')
  assert.equal(unrankableProduct.retainedRows, 200)
  assert.match(unrankableProduct.text, /商品199/u)

  const localTableSource = {
    name: '可靠成交数据.csv',
    kind: 'table' as const,
    text: '商品名称,成交金额,成交订单数\n产品A,1200,12\n产品B,800,8\n产品B,800,8\n,,',
    attribution: '自有数据',
    platform: '视频号',
    purpose: '商品成交数据',
    note: '近30天'
  }
  const localTable = preprocessTableForModel(localTableSource.text)
  assert.equal(localTable.confidence, 'high')
  assert.equal(localTable.canSkipModel, true)
  assert.equal(localTable.retainedRows, 3, 'identical rows are preserved because they may represent separate records')
  const localDetail = buildLocalTableCleanDetail(localTableSource, localTable)
  assert.ok(localDetail)
  assert.match(localDetail!, /未调用模型|以下内容只来自原表格|产品A/u)
  assert.equal((localDetail!.match(/产品B,800,8/gu) || []).length, 2)
  const semanticTable = preprocessTableForModel('标题,脚本文案,成交金额\n测试,这是一段内容,100')
  assert.equal(semanticTable.canSkipModel, true, 'reliable semantic rows are passed intact to later analysis without a cleaning rewrite')
  assert.ok(buildLocalTableCleanDetail({ ...localTableSource, text: '标题,脚本文案,成交金额\n测试,内容,100' }, semanticTable))
  assert.equal(preprocessTableForModel('not a reliable table').canSkipModel, false)

  const sharedData = '固定资料'.repeat(1_000)
  const digestMessages = buildEvidenceDigestMessages({
    evidenceGroup: '事实A POR-R-ABCDEF12-000001',
    groupIndex: 1,
    groupCount: 2
  })
  assert.match(String(digestMessages[1].content), /POR-R-ABCDEF12-000001/u)
  assert.match(String(digestMessages[1].content), /全部分析步骤|证据ID/u)
  const evidenceGroups = planAnalysisEvidenceGroups('证据'.repeat(120_000))
  assert.ok(evidenceGroups.length >= 3, 'large ledgers are split into responsive provider batches')
  assert.ok(evidenceGroups.every((group) => group.length <= 45_000))
  const step1 = buildStepMessages({ stepId: 1, stepTitle: '确定产品', sopRules: '', cleanedData: sharedData, priorOutputs: [] })
  const step2 = buildStepMessages({ stepId: 2, stepTitle: '卖点拆解', sopRules: '', cleanedData: sharedData, priorOutputs: [] })
  assert.deepEqual(step1[0], step2[0])
  assert.equal(String(step1[1].content).indexOf(sharedData) < String(step1[1].content).indexOf('当前任务'), true, 'step prompt prefix')
  const fullSkillSentinel = 'THIS_FULL_SKILL_MUST_NOT_BE_SENT'
  const compactStep = buildStepMessages({ stepId: 8, stepTitle: '执行选题', sopRules: fullSkillSentinel.repeat(1_000), cleanedData: sharedData, priorOutputs: [] })
  assert.doesNotMatch(String(compactStep[0].content), /THIS_FULL_SKILL_MUST_NOT_BE_SENT/u)
  assert.ok(COMPACT_RUNTIME_RULES.length < 5_000, 'compact runtime rules stay materially smaller than the full skill')
  assert.match(COMPACT_RUNTIME_RULES, /12维|3\.1=|0—11章|不同平台/u)
  const allArtifacts = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, `产出${index + 1}`]))
  assert.deepEqual(priorOutputsForStep(2, allArtifacts).map((item) => item.id), [1])
  assert.deepEqual(priorOutputsForStep(5, allArtifacts).map((item) => item.id), [1, 4])
  assert.deepEqual(priorOutputsForStep(8, allArtifacts).map((item) => item.id), [5, 6, 7])
  const finalA = buildFinalReportPartMessages({ part: FINAL_REPORT_PARTS[0], cleanedData: sharedData, priorOutputs: [] })
  const finalB = buildFinalReportPartMessages({ part: FINAL_REPORT_PARTS[1], cleanedData: sharedData, priorOutputs: [] })
  assert.deepEqual(finalA[0], finalB[0])
  assert.equal(String(finalA[1].content).indexOf(sharedData) < String(finalA[1].content).indexOf('本次只生成'), true, 'final prompt prefix')

  const previous = [
    '# 测试产品经营报告',
    '生成日期：2026-08-09',
    ...Array.from({ length: 12 }, (_, index) => `## ${index}. 章节${index}\n旧内容${index}`),
    '> (注：内容由 AI 生成，请谨慎参考）'
  ].join('\n\n')
  const selectedNine = selectRevisionParts('请修改第9章脚本选题')
  assert.deepEqual(selectedNine.map((part) => part.id), ['part-9'])
  const merged = mergeRevisionParts(previous, '## 9. 章节9\n新内容9', selectedNine)
  assert.ok(merged)
  assert.match(merged!, /## 9\. 章节9\n新内容9/u)
  assert.match(merged!, /## 8\. 章节8\n旧内容8/u)
  assert.match(merged!, /## 10\. 章节10\n旧内容10/u)
  assert.equal(mergeRevisionParts(previous, '缺少章节标题', selectedNine), null)
  assert.deepEqual(selectRevisionParts('把人群和风险建议一起调整').map((part) => part.id), ['part-5-8', 'part-10-11'])
  assert.equal(selectRevisionParts('整体再专业一点').length, FINAL_REPORT_PARTS.length)

  await clearReportResultCache()
  await reportResultCacheInternals.resetForTests()
  const reportInput = {
    sources: [localTableSource, { ...source, name: '画像.csv' }],
    userRequirements: '经营建议更具体',
    engineVersion: 'v2' as const
  }
  const completeReport = [
    '# 测试产品经营报告',
    ...Array.from({ length: 12 }, (_, index) => `## ${index}. 章节${index}\n内容${index}`)
  ].join('\n\n')
  const reportSnapshot = {
    cleanedData: '归一数据',
    cleanDetails: reportInput.sources.map((item) => ({ name: item.name, text: `清洗：${item.name}` })),
    artifacts: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 1, index === 8 ? completeReport : `步骤${index + 1}`])),
    reportMarkdown: completeReport
  }
  const reportKey = reportResultCacheKey(reportInput, 'gpt-5.5')
  assert.equal(reportKey.length, 64)
  assert.notEqual(reportResultCacheKey({ ...reportInput, sources: [...reportInput.sources].reverse() }, 'gpt-5.5'), reportKey)
  assert.notEqual(reportResultCacheKey({ ...reportInput, userRequirements: '换一个要求' }, 'gpt-5.5'), reportKey)
  assert.notEqual(reportResultCacheKey({ ...reportInput, engineVersion: 'v1' }, 'gpt-5.5'), reportKey)
  assert.equal((await storeReportResultCache(reportInput, 'gpt-5.5', reportSnapshot)).stored, true)
  const reportHit = await lookupReportResultCache(reportInput, 'gpt-5.5')
  assert.equal(reportHit.hit, true)
  assert.equal(reportHit.snapshot?.reportMarkdown, completeReport)
  assert.equal(reportHit.stats.totalHits, 1)
  for (let index = 0; index < 24; index++) {
    await storeReportResultCache(
      { ...reportInput, userRequirements: `要求-${index}` },
      'gpt-5.5',
      reportSnapshot
    )
  }
  assert.equal((await getReportResultCacheStats()).entryCount, 20, 'report cache uses the 20-entry LRU cap')
  const oversizedReportCache = reportResultCacheInternals.pruneCache({
    version: 2,
    totalHits: 0,
    entries: Array.from({ length: 4 }, (_, index) => ({
      key: (index + 100).toString(16).padStart(64, '0'),
      createdAt: '2026-08-09T00:00:00.000Z',
      lastUsedAt: new Date(now.getTime() - index * 1_000).toISOString(),
      expiresAt: '2026-09-01T00:00:00.000Z',
      model: 'gpt-5.5',
      bytes: 6_000_000
    }))
  }, now)
  assert.ok(
    Buffer.byteLength(JSON.stringify(oversizedReportCache), 'utf8') +
      oversizedReportCache.entries.reduce((sum, entry) => sum + entry.bytes, 0) <=
      reportResultCacheInternals.MAX_CACHE_BYTES
  )

  await costOptimizationInternals.resetForTests()
  await appendCostOptimizationEvent({
    schemaVersion: 1,
    id: 'local-clean:test-session:source-1',
    reportSessionId: 'test-session',
    type: 'local_source_clean',
    createdAt: new Date().toISOString(),
    localCompletedFiles: 1,
    sourceCacheHits: 0,
    skippedModelRequests: 1,
    reusedReports: 0
  })
  await appendCostOptimizationEvent({
    schemaVersion: 1,
    id: 'report-reuse:test-cache-key',
    reportSessionId: 'test-session',
    type: 'report_cache_reuse',
    createdAt: new Date().toISOString(),
    localCompletedFiles: 0,
    sourceCacheHits: 0,
    skippedModelRequests: 15,
    reusedReports: 1
  })
  const optimization = await getTokenOptimizationMetrics()
  assert.deepEqual(optimization, {
    localCompletedFiles: 1,
    sourceCacheHits: 0,
    skippedModelRequests: 16,
    reusedReports: 1
  })
  assert.doesNotMatch(readFileSync(costOptimizationLogPath(), 'utf8'), /API Key|activation_code|提示词|产品A/u)

  let modelOrBillingCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      preflightProjectStorage: async () => ({
        ok: true,
        estimatedBytes: 1,
        freeBytes: 1024 * 1024 * 1024,
        requiredBytes: 2,
        message: '可安全保存'
      }),
      lookupReportResultCache: async () => reportHit,
      canStartPointsReport: async () => {
        modelOrBillingCalls++
        throw new Error('points check must not run for a cache offer')
      },
      recordCostOptimization: async () => true,
      sendChat: () => {
        modelOrBillingCalls++
        return { abort: () => undefined }
      },
      getReportPointsCharge: async () => {
        modelOrBillingCalls++
        return { chargedPoints: 1 }
      }
    }
  }
  useStore.setState({
    reportReuseOffer: null,
    analysisSessionId: 'reuse-session',
    sources: reportInput.sources.map((item, index) => ({
      ...item,
      id: `source-${index}`,
      kindV1: index === 0 ? 'product-supply' as const : 'material-data' as const
    })),
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false,
    phase: 'idle'
  })
  await useStore.getState().startGeneration()
  assert.equal(modelOrBillingCalls, 0, 'cache lookup happens before model and points checks')
  assert.equal(useStore.getState().reportReuseOffer?.cacheKey, reportHit.cacheKey)
  await useStore.getState().acceptReportReuse()
  assert.equal(modelOrBillingCalls, 0, 'full report reuse does not call model or points billing')
  assert.equal(useStore.getState().phase, 'done')
  assert.equal(useStore.getState().reportMarkdown, completeReport)
  assert.match(useStore.getState().messages.at(-1)?.text || '', /已恢复上次的完整报告/u)
  assert.doesNotMatch(useStore.getState().messages.at(-1)?.text || '', /Token|扣除|计费|毛利/u)

  const reuseModalSource = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', 'ReportReuseModal.tsx'), 'utf8')
  assert.match(reuseModalSource, /直接使用上次报告/u)
  assert.match(reuseModalSource, /重新生成一份/u)
  assert.doesNotMatch(reuseModalSource, /Token|扣积分|毛利|每百万/u)

  await clearReportResultCache()
  writeFileSync(join(tempUserData, 'report-result-cache.json'), '{broken', 'utf8')
  writeFileSync(join(tempUserData, 'report-result-cache.json.bak'), 'also broken', 'utf8')
  assert.equal((await getReportResultCacheStats()).entryCount, 0, 'corrupt report cache is ignored')

  await clearSourceCleanCache()
  assert.equal((await getSourceCleanCacheStats()).entryCount, 0)
  writeFileSync(join(tempUserData, 'source-clean-cache.json'), '{broken', 'utf8')
  writeFileSync(join(tempUserData, 'source-clean-cache.json.bak'), 'also broken', 'utf8')
  assert.equal((await getSourceCleanCacheStats()).entryCount, 0, 'corrupt cache is ignored')
  await clearSourceCleanCache()
  await clearReportResultCache()
  await costOptimizationInternals.resetForTests()
}

async function testCsvAndArchiveGuards(): Promise<void> {
  assert.equal(MAX_CLEANING_CONCURRENCY, 4)
  const csv = 'name,comment\nA,"foo,bar"\n'
  const csvBuffer = Buffer.from(csv)
  const parsed = await parseFile(
    'quoted.csv',
    csvBuffer.buffer.slice(csvBuffer.byteOffset, csvBuffer.byteOffset + csvBuffer.byteLength) as ArrayBuffer
  )
  assert.equal(parsed.ok, true)
  const reparsed = Papa.parse<string[]>(parsed.text).data as string[][]
  assert.deepEqual(reparsed[1], ['A', 'foo,bar'])

  const gb18030 = iconv.encode('姓名,备注\n张三,"你好,世界"\n一,业务和丝\n', 'gb18030')
  const gbParsed = await parseFile(
    'gb18030.csv',
    gb18030.buffer.slice(gb18030.byteOffset, gb18030.byteOffset + gb18030.byteLength) as ArrayBuffer
  )
  assert.equal(gbParsed.ok, true)
  assert.match(gbParsed.text, /张三/)
  assert.match(gbParsed.text, /你好,世界/)
  assert.match(gbParsed.text, /一,"?业务和丝"?/)

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('标题\t内容\n一\t你好', 'utf16le')])
  const utf16Parsed = await parseFile(
    'utf16.txt',
    utf16le.buffer.slice(utf16le.byteOffset, utf16le.byteOffset + utf16le.byteLength) as ArrayBuffer
  )
  assert.equal(utf16Parsed.ok, true)
  assert.match(utf16Parsed.text, /你好/)

  const utf16WithoutBom = Buffer.from('name,内容\nA,你好\n', 'utf16le')
  const utf16WithoutBomParsed = await parseFile(
    'utf16-no-bom.csv',
    utf16WithoutBom.buffer.slice(
      utf16WithoutBom.byteOffset,
      utf16WithoutBom.byteOffset + utf16WithoutBom.byteLength
    ) as ArrayBuffer
  )
  assert.equal(utf16WithoutBomParsed.ok, true)
  assert.match(utf16WithoutBomParsed.text, /你好/)

  const utf8Markdown = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# 产品手卡\n\n- 核心卖点：中文 Markdown 可解析\n', 'utf8')
  ])
  const utf8MarkdownParsed = await parseFile(
    '产品手卡.MD',
    utf8Markdown.buffer.slice(
      utf8Markdown.byteOffset,
      utf8Markdown.byteOffset + utf8Markdown.byteLength
    ) as ArrayBuffer
  )
  assert.equal(utf8MarkdownParsed.ok, true)
  assert.match(utf8MarkdownParsed.text, /中文 Markdown 可解析/)

  const gbMarkdown = iconv.encode('# 竞品说明\n\n价格带：100-199元\n', 'gb18030')
  const gbMarkdownParsed = await parseFile(
    '竞品说明.markdown',
    gbMarkdown.buffer.slice(gbMarkdown.byteOffset, gbMarkdown.byteOffset + gbMarkdown.byteLength) as ArrayBuffer
  )
  assert.equal(gbMarkdownParsed.ok, true)
  assert.match(gbMarkdownParsed.text, /竞品说明/)
  assert.match(gbMarkdownParsed.text, /价格带/)

  const utf16Markdown = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('# 用户画像\n\n已育女性为核心人群', 'utf16le')
  ])
  const utf16MarkdownParsed = await parseFile(
    '用户画像.md',
    utf16Markdown.buffer.slice(
      utf16Markdown.byteOffset,
      utf16Markdown.byteOffset + utf16Markdown.byteLength
    ) as ArrayBuffer
  )
  assert.equal(utf16MarkdownParsed.ok, true)
  assert.match(utf16MarkdownParsed.text, /已育女性为核心人群/)

  const tsv = Buffer.from('字段\t数值\n成交金额\t1234\n素材数\t59\n', 'utf8')
  const tsvParsed = await parseFile(
    '经营数据.tsv',
    tsv.buffer.slice(tsv.byteOffset, tsv.byteOffset + tsv.byteLength) as ArrayBuffer
  )
  assert.equal(tsvParsed.ok, true)
  assert.equal(tsvParsed.kind, 'table')
  assert.match(tsvParsed.text, /成交金额,1234/u)

  const yaml = Buffer.from('产品: 酸菜\n经营指标:\n  成交金额: 1234\n', 'utf8')
  const yamlParsed = await parseFile(
    '经营资料.yaml',
    yaml.buffer.slice(yaml.byteOffset, yaml.byteOffset + yaml.byteLength) as ArrayBuffer
  )
  assert.equal(yamlParsed.ok, true)
  assert.match(yamlParsed.text, /成交金额: 1234/u)

  const log = Buffer.from('[2026-08-18] 直播成交金额=1234，退款=12\n', 'utf8')
  const logParsed = await parseFile(
    '经营记录.log',
    log.buffer.slice(log.byteOffset, log.byteOffset + log.byteLength) as ArrayBuffer
  )
  assert.equal(logParsed.ok, true)
  assert.match(logParsed.text, /退款=12/u)

  const rtf = Buffer.from('{\\rtf1\\ansi\\ansicpg936 Product benefit: \\u37240?\\u40092?\\par GMV 1234}', 'latin1')
  const rtfParsed = await parseFile(
    '产品说明.rtf',
    rtf.buffer.slice(rtf.byteOffset, rtf.byteOffset + rtf.byteLength) as ArrayBuffer
  )
  assert.equal(rtfParsed.ok, true)
  assert.doesNotMatch(rtfParsed.text, /\\rtf1|\\par/u)
  assert.match(rtfParsed.text, /Product benefit:[\s\S]*GMV 1234/u)

  const json = Buffer.from(JSON.stringify({ 产品: '酸菜', 指标: { 成交金额: 1234 }, 素材: [1, 2, 3] }), 'utf8')
  const jsonParsed = await parseFile(
    '经营资料.json',
    json.buffer.slice(json.byteOffset, json.byteOffset + json.byteLength) as ArrayBuffer
  )
  assert.equal(jsonParsed.ok, true)
  assert.match(jsonParsed.text, /"成交金额": 1234/u)

  const malformedJson = Buffer.from('{"产品":"酸菜", trailing-data', 'utf8')
  const malformedJsonParsed = await parseFile(
    '不规则导出.json',
    malformedJson.buffer.slice(
      malformedJson.byteOffset,
      malformedJson.byteOffset + malformedJson.byteLength
    ) as ArrayBuffer
  )
  assert.equal(malformedJsonParsed.ok, true)
  assert.match(malformedJsonParsed.warning || '', /完整原文继续清洗/u)
  assert.match(malformedJsonParsed.text, /trailing-data/u)

  const html = Buffer.from(
    '<html><body><h1>商品经营数据</h1><table><tr><th>成交金额</th><th>订单</th></tr><tr><td>1234</td><td>12</td></tr></table><script>steal-secret()</script></body></html>',
    'utf8'
  )
  const htmlParsed = await parseFile(
    '平台网页导出.html',
    html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength) as ArrayBuffer
  )
  assert.equal(htmlParsed.ok, true)
  assert.match(htmlParsed.text, /商品经营数据|成交金额|1234/u)
  assert.doesNotMatch(htmlParsed.text, /steal-secret/u)
  assert.match(htmlParsed.warning || '', /不会执行/u)

  const xml = Buffer.from('<report><product>酸菜</product><gmv>1234</gmv></report>', 'utf8')
  const xmlParsed = await parseFile(
    '平台数据.xml',
    xml.buffer.slice(xml.byteOffset, xml.byteOffset + xml.byteLength) as ArrayBuffer
  )
  assert.equal(xmlParsed.ok, true)
  assert.match(xmlParsed.text, /<gmv>1234<\/gmv>/u)

  const sparseWorkbook = XLSX.utils.book_new()
  const sparseSheet = XLSX.utils.aoa_to_sheet([['商品', '成交金额'], ['酸菜', 1234]])
  sparseSheet.B2.f = 'SUM(1200,34)'
  sparseSheet.B2.l = { Target: 'https://example.com/source-row' }
  sparseSheet.B2.c = [{ a: '运营', t: '这是退款后成交金额' }]
  XLSX.utils.book_append_sheet(sparseWorkbook, sparseSheet, '格式刷过大的工作表')
  const sparseBase = XLSX.write(sparseWorkbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  const sparseZip = await JSZip.loadAsync(sparseBase)
  const sparseXmlPath = 'xl/worksheets/sheet1.xml'
  const sparseXml = await sparseZip.file(sparseXmlPath)!.async('string')
  sparseZip.file(sparseXmlPath, sparseXml.replace(/<dimension ref="[^"]+"\/>/u, '<dimension ref="A1:XFD1048576"/>'))
  sparseZip.file('xl/media/image1.png', makePng(12, 12))
  const sparseBytes = await sparseZip.generateAsync({ type: 'nodebuffer' })
  const sparseParsed = await parseFile(
    '平台格式刷.xlsx',
    sparseBytes.buffer.slice(sparseBytes.byteOffset, sparseBytes.byteOffset + sparseBytes.byteLength) as ArrayBuffer
  )
  assert.equal(sparseParsed.ok, true, sparseParsed.error)
  assert.match(sparseParsed.text, /酸菜,1234/u)
  assert.match(sparseParsed.text, /SUM\(1200,34\)/u)
  assert.match(sparseParsed.text, /https:\/\/example\.com\/source-row/u)
  assert.match(sparseParsed.text, /这是退款后成交金额/u)
  assert.equal(sparseParsed.attachments?.length, 1)
  assert.match(sparseParsed.warning || '', /内嵌图片/u)

  for (const bookType of ['xlsm', 'xlsb', 'ods'] as const) {
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['商品', '成交金额'], ['酸菜', 1234]]), '经营数据')
    const workbookBytes = XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer
    const parsedWorkbook = await parseFile(
      `经营数据.${bookType}`,
      workbookBytes.buffer.slice(
        workbookBytes.byteOffset,
        workbookBytes.byteOffset + workbookBytes.byteLength
      ) as ArrayBuffer
    )
    assert.equal(parsedWorkbook.ok, true, `${bookType}: ${parsedWorkbook.error || ''}`)
    assert.match(parsedWorkbook.text, /酸菜,1234/u)
  }

  const sharp = (await import('sharp')).default
  const tiffBytes = await sharp({
    create: { width: 24, height: 18, channels: 3, background: { r: 20, g: 120, b: 220 } }
  }).tiff().toBuffer()
  const tiffParsed = await parseFile(
    '扫描图片.tiff',
    tiffBytes.buffer.slice(tiffBytes.byteOffset, tiffBytes.byteOffset + tiffBytes.byteLength) as ArrayBuffer
  )
  assert.equal(tiffParsed.ok, true, tiffParsed.error)
  assert.equal(tiffParsed.attachments?.length, 1)
  assert.match(tiffParsed.attachments?.[0]?.dataUrl || '', /^data:image\/png;base64,/u)
  assert.match(tiffParsed.warning || '', /自动/u)

  const gifBytes = await sharp({
    create: { width: 18, height: 18, channels: 4, background: { r: 240, g: 120, b: 20, alpha: 1 } }
  }).gif().toBuffer()
  const gifParsed = await parseFile(
    '素材动图.gif',
    gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength) as ArrayBuffer
  )
  assert.equal(gifParsed.ok, true, gifParsed.error)
  assert.equal(gifParsed.attachments?.length, 1)
  assert.match(gifParsed.attachments?.[0]?.dataUrl || '', /^data:image\/png;base64,/u)

  const pptx = new JSZip()
  pptx.file('[Content_Types].xml', '<Types/>')
  pptx.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="p" xmlns:a="a"><a:t xml:space="preserve">保留空格的产品卖点</a:t></p:sld>'
  )
  pptx.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="p" xmlns:a="a"></p:sld>')
  pptx.file('ppt/media/image1.png', makePng(10, 10))
  const pptxBytes = await pptx.generateAsync({ type: 'arraybuffer' })
  const pptxParsed = await parseFile('产品手卡.pptx', pptxBytes)
  assert.equal(pptxParsed.ok, true, pptxParsed.error)
  assert.match(pptxParsed.text, /保留空格的产品卖点/u)
  assert.match(pptxParsed.warning || '', /第 2 页没有可提取文字/u)
  assert.match(pptxParsed.warning || '', /1 张内嵌图片/u)
  assert.equal(pptxParsed.attachments?.length, 1)
  assert.match(pptxParsed.attachments?.[0]?.dataUrl || '', /^data:image\/png;base64,/u)

  const imageOnlyPptx = new JSZip()
  imageOnlyPptx.file('[Content_Types].xml', '<Types/>')
  imageOnlyPptx.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"></p:sld>')
  imageOnlyPptx.file('ppt/media/only.png', makePng(20, 20))
  const imageOnlyBytes = await imageOnlyPptx.generateAsync({ type: 'arraybuffer' })
  const imageOnlyParsed = await parseFile('纯图产品手卡.pptx', imageOnlyBytes)
  assert.equal(imageOnlyParsed.ok, true, imageOnlyParsed.error)
  assert.equal(imageOnlyParsed.text, '')
  assert.equal(imageOnlyParsed.attachments?.length, 1)

  const malformed = Buffer.from('name,comment\nA,"没有结束\n', 'utf8')
  const malformedParsed = await parseFile(
    'malformed.csv',
    malformed.buffer.slice(malformed.byteOffset, malformed.byteOffset + malformed.byteLength) as ArrayBuffer
  )
  assert.equal(malformedParsed.ok, true, 'malformed CSV falls back to complete raw text instead of failing the file')
  assert.match(malformedParsed.warning || '', /完整原文继续清洗/u)
  assert.equal(malformedParsed.text, malformed.toString('utf8').trim())

  const wrongColumns = Buffer.from('a,b\n1,2,3\n', 'utf8')
  const wrongColumnsParsed = await parseFile(
    'wrong-columns.csv',
    wrongColumns.buffer.slice(wrongColumns.byteOffset, wrongColumns.byteOffset + wrongColumns.byteLength) as ArrayBuffer
  )
  assert.equal(wrongColumnsParsed.ok, true)
  assert.match(wrongColumnsParsed.warning || '', /自动兼容/)
  const preservedWrongColumns = Papa.parse<string[]>(wrongColumnsParsed.text).data as string[][]
  assert.deepEqual(preservedWrongColumns[1], ['1', '2', '3'])

  const oversizedExtract = Buffer.from(`name,content\nA,${'x'.repeat(1_000_100)}`, 'utf8')
  const oversizedExtractParsed = await parseFile(
    'oversized-extract.csv',
    oversizedExtract.buffer.slice(
      oversizedExtract.byteOffset,
      oversizedExtract.byteOffset + oversizedExtract.byteLength
    ) as ArrayBuffer
  )
  assert.equal(oversizedExtractParsed.ok, true, 'dynamic cleaning accepts content above the former one-million-character cap')
  assert.equal(oversizedExtractParsed.text.length, oversizedExtract.toString('utf8').trim().length)
  const oversizedPlan = buildSourceCleanBatchPlan({
    name: oversizedExtractParsed.name,
    kind: 'table',
    text: oversizedExtractParsed.text
  })
  assert.ok(oversizedPlan.batches.length > 1)
  const oversizedSentText = oversizedPlan.batches.map((batch) => batch.source.text || '').join('\n')
  assert.equal(
    (oversizedSentText.match(/x/gu) || []).length,
    1_000_100,
    'every character from an oversized table cell enters exactly one cleaning batch'
  )
  const beyondSafetyLimit = Buffer.from('z'.repeat(4_000_100), 'utf8')
  const beyondSafetyParsed = await parseFile(
    '超过稳定性上限.txt',
    beyondSafetyLimit.buffer.slice(
      beyondSafetyLimit.byteOffset,
      beyondSafetyLimit.byteOffset + beyondSafetyLimit.byteLength
    ) as ArrayBuffer
  )
  assert.equal(beyondSafetyParsed.ok, false)
  assert.equal(beyondSafetyParsed.text, '')
  assert.match(beyondSafetyParsed.error || '', /4,000,000|未做截断/u)

  const line678Rows = ['a,b']
  for (let index = 2; index <= 677; index++) line678Rows.push(`${index},正常`)
  line678Rows.push('678,备注里多出的内容,仍需保留')
  const line678 = Buffer.from(line678Rows.join('\n'), 'utf8')
  const line678Parsed = await parseFile(
    '第678行错列.csv',
    line678.buffer.slice(line678.byteOffset, line678.byteOffset + line678.byteLength) as ArrayBuffer
  )
  assert.equal(line678Parsed.ok, true)
  assert.match(line678Parsed.warning || '', /第 678 行/)
  assert.match(line678Parsed.text, /仍需保留/)

  const missingTail = Buffer.from('a,b,c\n1,2\n', 'utf8')
  const missingTailParsed = await parseFile(
    '缺少尾列.csv',
    missingTail.buffer.slice(missingTail.byteOffset, missingTail.byteOffset + missingTail.byteLength) as ArrayBuffer
  )
  assert.equal(missingTailParsed.ok, true)
  const paddedRows = Papa.parse<string[]>(missingTailParsed.text).data as string[][]
  assert.deepEqual(paddedRows[1], ['1', '2', ''])

  const zip = new JSZip()
  zip.file('high-ratio.txt', '0'.repeat(2 * 1024 * 1024))
  const zipped = await zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })
  const archive = await parseArchive('high-ratio.zip', zipped)
  assert.equal(archive[0]?.ok, false)
  assert.match(archive[0]?.error || '', /压缩比异常/)

  const duplicateNames = new JSZip()
  duplicateNames.file('文件夹A/同名.txt', 'A')
  duplicateNames.file('文件夹B/同名.txt', 'B')
  const duplicateBytes = await duplicateNames.generateAsync({ type: 'arraybuffer' })
  const duplicateArchive = await parseArchive('同名.zip', duplicateBytes)
  assert.deepEqual(
    duplicateArchive.map((item) => item.name).sort(),
    ['文件夹A/同名.txt', '文件夹B/同名.txt']
  )

  const mixedArchive = new JSZip()
  mixedArchive.file('数据/成交.tsv', '字段\t数值\nGMV\t1234')
  mixedArchive.file('数据/画像.json', JSON.stringify({ 人群: '家庭用户' }))
  mixedArchive.file('说明/网页.html', '<p>用户反馈：包装方便</p>')
  const mixedBytes = await mixedArchive.generateAsync({ type: 'arraybuffer' })
  const mixedItems = await parseArchive('混合资料.zip', mixedBytes)
  assert.equal(mixedItems.length, 3)
  assert.ok(mixedItems.every((item) => item.ok), JSON.stringify(mixedItems))
  assert.match(mixedItems.find((item) => item.name.endsWith('成交.tsv'))?.text || '', /GMV,1234/u)
  assert.match(mixedItems.find((item) => item.name.endsWith('画像.json'))?.text || '', /家庭用户/u)
  assert.match(mixedItems.find((item) => item.name.endsWith('网页.html'))?.text || '', /包装方便/u)

  const officeArchive = new JSZip()
  officeArchive.file('手卡/产品手卡.pptx', pptxBytes)
  const officeArchiveBytes = await officeArchive.generateAsync({ type: 'arraybuffer' })
  const officeArchiveItems = await parseArchive('Office资料.zip', officeArchiveBytes)
  assert.match(officeArchiveItems.find((item) => item.name.endsWith('产品手卡.pptx'))?.text || '', /保留空格的产品卖点/u)
  assert.ok(
    officeArchiveItems.some((item) => item.kind === 'image' && item.name.includes('产品手卡.pptx/内嵌图片')),
    JSON.stringify(officeArchiveItems)
  )

  const crowdedArchive = new JSZip()
  for (let index = 0; index < 121; index++) crowdedArchive.file(`无关视频-${index}.mp4`, 'x')
  crowdedArchive.file('zzz-关键产品资料.txt', '这份有效资料必须优先解析')
  const crowdedBytes = await crowdedArchive.generateAsync({ type: 'arraybuffer' })
  const crowdedItems = await parseArchive('条目较多.zip', crowdedBytes)
  assert.match(crowdedItems.find((item) => item.name === 'zzz-关键产品资料.txt')?.text || '', /必须优先解析/u)
  assert.ok(crowdedItems.some((item) => /数量提示/u.test(item.name)))

  const officeBomb = new JSZip()
  officeBomb.file('xl/worksheets/sheet1.xml', '0'.repeat(2 * 1024 * 1024))
  const officeBytes = await officeBomb.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  })
  const officeParsed = await parseFile(
    'unsafe.xlsx',
    officeBytes.buffer.slice(officeBytes.byteOffset, officeBytes.byteOffset + officeBytes.byteLength) as ArrayBuffer
  )
  assert.equal(officeParsed.ok, false)
  assert.match(officeParsed.error || '', /压缩比例异常/)
}

async function testFileCountGuard(): Promise<void> {
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseFile: async (name: string) => ({ name, kind: 'doc', text: 'ok', ok: true })
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    artifacts: {},
    reportMarkdown: '',
    cleanedData: '',
    cleanDetails: [],
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })
  const files = Array.from({ length: 51 }, (_, index) => ({
    name: `资料-${index}.txt`,
    size: 2,
    arrayBuffer: async () => new TextEncoder().encode('ok').buffer
  })) as unknown as File[]
  await useStore.getState().addSources(files)
  assert.equal(useStore.getState().sources.length, 50)
  assert.match(useStore.getState().messages[0]?.text || '', /最多保留 50/)

  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    artifacts: {},
    reportMarkdown: '',
    cleanedData: '',
    cleanDetails: [],
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })
  const mixedFiles = [
    ...Array.from({ length: 10 }, (_, index) => ({
      name: `系统附件-${index}.mp4`,
      size: 2,
      arrayBuffer: async () => new ArrayBuffer(2)
    })),
    ...Array.from({ length: 50 }, (_, index) => ({
      name: `有效资料-${index}.txt`,
      size: 2,
      arrayBuffer: async () => new TextEncoder().encode('ok').buffer
    }))
  ] as unknown as File[]
  await useStore.getState().addSources(mixedFiles)
  assert.equal(useStore.getState().sources.length, 50)
  assert.ok(useStore.getState().sources.every((source) => source.name.startsWith('有效资料-')))
  assert.ok(useStore.getState().sources.every((source) => source.text === 'ok'))
}

async function testZipExpansionGlobalCountGuard(): Promise<void> {
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseArchive: async (name: string) =>
        Array.from({ length: 120 }, (_, index) => ({
          name: `${name}/资料-${index}.txt`,
          kind: 'doc' as const,
          size: 2,
          text: 'ok',
          ok: true
        }))
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    artifacts: {},
    reportMarkdown: '',
    cleanedData: '',
    cleanDetails: [],
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })
  const zips = ['一.zip', '二.zip'].map((name) => ({
    name,
    size: 10,
    arrayBuffer: async () => new ArrayBuffer(8)
  })) as unknown as File[]
  await useStore.getState().addSources(zips)
  assert.equal(useStore.getState().sources.length, 240)
  assert.equal(new Set(useStore.getState().sources.map((source) => source.topLevelId)).size, 2)
  assert.equal(useStore.getState().sources.every((source) => source.derivedKind === 'archive-entry'), true)
  assert.equal(useStore.getState().sources.filter((source) => /数量提示/.test(source.name)).length, 0)

  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      parseArchive: async () => [
        ...Array.from({ length: 49 }, (_, index) => ({
          name: `不支持-${index}.mp4`,
          kind: 'other' as const,
          size: 100_000,
          ok: false,
          error: '暂不支持'
        })),
        { name: '关键经营数据.tsv', kind: 'table' as const, size: 20, text: '字段,数值\nGMV,1234', ok: true },
        { name: '关键产品手卡.json', kind: 'doc' as const, size: 20, text: '{"产品":"酸菜"}', ok: true }
      ]
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [],
    messages: [],
    artifacts: {},
    reportMarkdown: '',
    cleanedData: '',
    cleanDetails: [],
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })
  await useStore.getState().addSources([
    { name: '混合资料.zip', size: 10, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as File
  ])
  assert.ok(useStore.getState().sources.some((source) => source.name === '关键经营数据.tsv'))
  assert.ok(useStore.getState().sources.some((source) => source.name === '关键产品手卡.json'))
}

async function testSourceCleaningFailureIsolation(): Promise<void> {
  const startedSourceIds: string[] = []
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      lookupSourceCleanCache: async () => {
        throw new Error('模拟缓存不可用')
      },
      storeSourceCleanCache: async () => {
        throw new Error('模拟缓存写入失败')
      },
      saveLastProject: async (project: SavedProject) => project,
      recordCostOptimization: async () => true,
      sendChat: (
        messages: unknown,
        context: { sourceId?: string },
        handlers: { onDone?: (value: string) => void; onError?: (value: string) => void }
      ) => {
        startedSourceIds.push(context.sourceId || '')
        if (context.sourceId === 'broken-source') {
          queueMicrotask(() => handlers.onError?.('模拟上游连接失败'))
        } else {
          globalThis.setTimeout(() => {
            const evidenceIds = [...new Set(JSON.stringify(messages).match(/POR-[RTI]-[A-F0-9]{8}-\d{6}/gu) || [])]
            handlers.onDone?.(`成功资料的完整清洗结果\n${evidenceIds.join('\n')}`)
          }, 10)
        }
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [
      {
        id: 'broken-source',
        name: '暂时失败的资料.md',
        kind: 'doc',
        text: '# 暂时失败',
        attribution: '自有数据'
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `good-source-${index + 1}`,
        name: `可正常处理的资料-${index + 1}.json`,
        kind: 'doc' as const,
        text: `{"产品":"酸菜${index + 1}"}`,
        attribution: '自有数据'
      }))
    ],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false,
    abortFn: null,
    analysisSessionId: crypto.randomUUID()
  })

  await useStore.getState()._runCleaning(false)

  assert.deepEqual(
    useStore.getState().cleanDetails.map((detail) => detail.id),
    ['good-source-1', 'good-source-2', 'good-source-3']
  )
  assert.deepEqual(startedSourceIds, ['broken-source', 'good-source-1', 'good-source-2', 'good-source-3'])
  assert.equal(useStore.getState().cleaningProgress.done, 3)
  assert.equal(useStore.getState().cleaningProgress.failed, 1)
  assert.equal(useStore.getState().phase, 'idle')
  assert.match(useStore.getState().messages.at(-1)?.text || '', /没有再启动新的资料/u)
}

async function testCleaningCheckpointPrecedesSummary(): Promise<void> {
  let modelCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      lookupSourceCleanCache: async () => ({ hit: false }),
      storeSourceCleanCache: async () => ({ stored: true }),
      saveLastProject: async (project: SavedProject) => project,
      recordCostOptimization: async () => true,
      sendChat: () => {
        modelCalls += 1
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [{
      id: 'local-profile',
      name: '画像.csv',
      kind: 'table',
      text: '标签类型,标签,占比\n年龄,31-40,60%\n地区,广东,40%',
      attribution: '自有数据'
    }],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false,
    abortFn: null,
    analysisSessionId: crypto.randomUUID()
  })
  await useStore.getState()._runCleaning(false)
  assert.equal(modelCalls, 0, 'local structured cleaning reaches confirmation without a summary model call')
  assert.equal(useStore.getState().phase, 'checkpoint1')
  assert.match(useStore.getState().cleanedData, /^## 各来源清洗明细/mu)
  assert.doesNotMatch(useStore.getState().cleanedData, /① 资料分类总览/u)
  assert.equal(useStore.getState().cleanDetails[0]?.coverage?.mode, 'local_exact')
}

async function testParseFailureBlocksGeneration(): Promise<void> {
  let chatCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: () => {
        chatCalls++
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    phase: 'idle',
    sources: [
      { id: 'good', name: '已解析.txt', kind: 'doc', text: '有效资料', attribution: '自有数据' },
      { id: 'bad', name: '扫描件.pdf', kind: 'doc', error: 'PDF 没有可提取的文本层' }
    ],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false,
    analysisSessionId: crypto.randomUUID()
  })

  await useStore.getState().startGeneration()

  assert.equal(chatCalls, 0)
  assert.equal(useStore.getState().phase, 'idle')
  assert.match(useStore.getState().messages.at(-1)?.text || '', /为避免报告漏掉资料，本次没有开始分析/u)
}

async function testPrivacyMustMatchEndpoint(): Promise<void> {
  let chatCalls = 0
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      sendChat: () => {
        chatCalls++
        return { abort: () => undefined }
      }
    }
  }
  useStore.setState({
    settings: {
      profiles: [profile],
      activeProfileId: profile.id,
      projectsDir: '',
      privacyAccepted: true,
      privacyEndpoint: 'https://old.example/v1'
    },
    phase: 'idle',
    sources: [
      {
        id: 'safe',
        name: '自有资料.txt',
        kind: 'doc',
        kindV1: 'product-supply',
        text: '内容',
        attribution: '自有数据'
      }
    ],
    messages: [],
    cleanedData: '',
    cleanDetails: [],
    artifacts: {},
    reportMarkdown: '',
    reportStale: false
  })
  await useStore.getState().startGeneration()
  assert.equal(chatCalls, 0)
  assert.equal(useStore.getState().phase, 'idle')
  assert.match(useStore.getState().messages.at(-1)?.text || '', /隐私确认/)
}

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function makeWebp(type: 'VP8 ' | 'VP8L' | 'VP8X', payload: Uint8Array): Uint8Array {
  const padded = payload.length + (payload.length & 1)
  const bytes = new Uint8Array(20 + padded)
  bytes.set([0x52, 0x49, 0x46, 0x46])
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8)
  bytes.set(Array.from(type).map((char) => char.charCodeAt(0)), 12)
  new DataView(bytes.buffer).setUint32(16, payload.length, true)
  bytes.set(payload, 20)
  return bytes
}

function makeGif(twoFrames = false): Uint8Array {
  const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]
  const frame = [
    0x2c,
    0x00,
    0x00,
    0x00,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x00,
    0x02,
    0x02,
    0x44,
    0x01,
    0x00
  ]
  return Uint8Array.from([...header, ...frame, ...(twoFrames ? frame : []), 0x3b])
}

async function testImageHeaderGuards(): Promise<void> {
  assert.deepEqual(inspectImageHeader(makePng(1600, 900)), {
    format: 'png',
    width: 1600,
    height: 900,
    frames: 1
  })
  assert.throws(() => inspectImageHeader(makePng(10_001, 1)), /像素尺寸过大/)
  const apng = new Uint8Array(53)
  apng.set(makePng(100, 100))
  const apngView = new DataView(apng.buffer)
  apngView.setUint32(33, 8)
  apng.set([0x61, 0x63, 0x54, 0x4c], 37)
  apngView.setUint32(41, 2)
  apngView.setUint32(45, 0)
  assert.throws(() => inspectImageHeader(apng), /动态 PNG/)

  const vp8 = new Uint8Array(10)
  vp8.set([0x9d, 0x01, 0x2a], 3)
  new DataView(vp8.buffer).setUint16(6, 640, true)
  new DataView(vp8.buffer).setUint16(8, 360, true)
  assert.equal(inspectImageHeader(makeWebp('VP8 ', vp8)).width, 640)
  assert.equal(inspectImageHeader(makeWebp('VP8 ', vp8)).height, 360)

  const vp8l = new Uint8Array(5)
  vp8l[0] = 0x2f
  const packed = (319 | (239 << 14)) >>> 0
  new DataView(vp8l.buffer).setUint32(1, packed, true)
  assert.equal(inspectImageHeader(makeWebp('VP8L', vp8l)).width, 320)
  assert.equal(inspectImageHeader(makeWebp('VP8L', vp8l)).height, 240)

  const truncatedWebp = makeWebp('VP8L', vp8l)
  new DataView(truncatedWebp.buffer).setUint32(4, truncatedWebp.length + 20, true)
  assert.throws(() => inspectImageHeader(truncatedWebp), /结构不完整/)

  const animated = new Uint8Array(10)
  animated[0] = 0x02
  assert.throws(() => inspectImageHeader(makeWebp('VP8X', animated)), /动态 WebP/)
  assert.throws(() => inspectImageHeader(makeWebp('VP8X', new Uint8Array(10))), /没有可读取的静态画面/)

  const mismatchedWebp = new Uint8Array(48)
  mismatchedWebp.set([0x52, 0x49, 0x46, 0x46])
  const mismatchView = new DataView(mismatchedWebp.buffer)
  mismatchView.setUint32(4, mismatchedWebp.length - 8, true)
  mismatchedWebp.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8)
  mismatchView.setUint32(16, 10, true)
  mismatchedWebp.set([0x56, 0x50, 0x38, 0x20], 30)
  mismatchView.setUint32(34, 10, true)
  mismatchedWebp.set([0x9d, 0x01, 0x2a], 41)
  mismatchView.setUint16(44, 2, true)
  mismatchView.setUint16(46, 3, true)
  assert.throws(() => inspectImageHeader(mismatchedWebp), /画布尺寸与实际画面不一致/)

  assert.equal(inspectImageHeader(makeGif()).frames, 1)
  assert.throws(() => inspectImageHeader(makeGif(true)), /动态 GIF/)
  const oversizedGifFrame = makeGif()
  new DataView(oversizedGifFrame.buffer).setUint16(18, 10_001, true)
  assert.throws(() => inspectImageHeader(oversizedGifFrame), /像素尺寸过大/)

  const jpeg = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    0x01,
    0x2c,
    0x02,
    0x58,
    0xff,
    0xd9
  ])
  assert.deepEqual(inspectImageHeader(jpeg), {
    format: 'jpeg',
    width: 600,
    height: 300,
    frames: 1
  })
}

async function testBulkAttributionAndExportOpen(): Promise<void> {
  useStore.setState({
    phase: 'idle',
    sources: [
      { id: 'blank', name: '资料一.csv', kind: 'table', text: 'a,b' },
      {
        id: 'chosen',
        name: '竞品.csv',
        kind: 'table',
        text: 'a,b',
        attribution: '竞品数据'
      },
      { id: 'failed', name: '坏文件.pdf', kind: 'doc', error: '文件损坏' }
    ],
    cleanDetails: [{ id: 'blank', name: '资料一.csv', text: '旧清洗' }],
    cleanedData: '旧清洗',
    artifacts: { 9: HTML_REPORT_FIXTURE },
    reportMarkdown: HTML_REPORT_FIXTURE,
    reportStale: false
  })
  useStore.getState().setUnconfirmedAttribution('自有数据')
  const afterBulk = useStore.getState()
  assert.equal(afterBulk.sources.find((source) => source.id === 'blank')?.attribution, '自有数据')
  assert.equal(afterBulk.sources.find((source) => source.id === 'chosen')?.attribution, '竞品数据')
  assert.equal(afterBulk.sources.find((source) => source.id === 'failed')?.attribution, undefined)
  assert.equal(afterBulk.cleanDetails.length, 0)
  assert.equal(afterBulk.reportMarkdown, HTML_REPORT_FIXTURE)
  assert.equal(afterBulk.reportStale, true)

  let opened = ''
  let shown = ''
  ;(globalThis as typeof globalThis & { window: unknown }).window = {
    api: {
      exportDocx: async () => ({ ok: true, path: 'D:\\报告\\产品经营报告.docx' }),
      openPath: async (path: string) => {
        opened = path
      },
      showItemInFolder: async (path: string) => {
        shown = path
      }
    }
  }
  useStore.setState({
    phase: 'done',
    artifacts: { 9: HTML_REPORT_FIXTURE },
    reportMarkdown: HTML_REPORT_FIXTURE,
    reportStale: false,
    exportStatus: '',
    lastExportPath: ''
  })
  await useStore.getState().exportReport('docx')
  assert.equal(useStore.getState().lastExportPath, 'D:\\报告\\产品经营报告.docx')
  await useStore.getState().openLastExport()
  await useStore.getState().showLastExportInFolder()
  assert.equal(opened, 'D:\\报告\\产品经营报告.docx')
  assert.equal(shown, 'D:\\报告\\产品经营报告.docx')
}

function testExportButtonContract(): void {
  const component = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'ReportPreview.tsx'),
    'utf8'
  )
  const htmlIndex = component.indexOf('导出 HTML')
  const mdIndex = component.indexOf('导出 MD')
  const wordIndex = component.indexOf('导出 Word')
  assert.ok(htmlIndex >= 0 && htmlIndex < mdIndex && mdIndex < wordIndex)
  assert.equal(component.includes('export-more'), false)
  assert.equal(component.includes('其他格式'), false)
}

function testOptionalOneClickUpdateContract(): void {
  const appComponent = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'),
    'utf8'
  )
  assert.match(appComponent, /const handleApplyUpdate = async/u)
  assert.ok(appComponent.includes('立即更新'))
  assert.ok(appComponent.includes('稍后更新'))
  assert.match(appComponent, /downloadUpdate\(\)[\s\S]{0,800}installUpdate\(\)/u)
  assert.doesNotMatch(appComponent, /handleDownloadUpdate|handleInstallUpdate/u)

  const workflow = readFileSync(join(process.cwd(), '..', '.github', 'workflows', 'build-desktop.yml'), 'utf8')
  assert.doesNotMatch(workflow, /FORCE_PRODUCT_OPERATION_REPORT_UPDATE|PRODUCT_OPERATION_REPORT_MIN_SUPPORTED_VERSION/u)
  assert.match(workflow, /body\.force !== false/u)
}

async function testWorkbenchTopbarContract(): Promise<void> {
  const appComponent = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'),
    'utf8'
  )
  const expectedGuideUrl =
    'https://my.feishu.cn/docx/BTSjddkiXo2IGKxiDCJcTM1qnCe?from=from_copylink'
  assert.ok(appComponent.includes(expectedGuideUrl))
  assert.ok(appComponent.includes('产品与内容经营报告系统'))
  assert.ok(appComponent.includes('专业的产品经营与内容分析报告系统'))
  assert.equal(appComponent.includes('FU5FdRkHFoNH7JxUp6wciLksnEe'), false)
  assert.equal(appComponent.includes('Token 统计'), false, 'Token statistics are not exposed in the customer UI')
  assert.equal(appComponent.includes('增加 10000 测试积分'), false, 'development credit controls are hidden')
  assert.doesNotMatch(appComponent, /毛利|每百万|真实成本|points-pricing-summary/u)
  assert.match(appComponent, /points-ledger-preview/u, 'the points dialog exposes the real server ledger')
  assert.equal(appComponent.includes('更换电脑'), false, 'device transfer is not placed in the points dialog')
  assert.match(appComponent, /AUTHORIZATION_REFRESH_INTERVAL_MS = 60_000/u)
  assert.match(appComponent, /setInterval\(handleFocus, AUTHORIZATION_REFRESH_INTERVAL_MS\)/u)
  assert.match(appComponent, /addEventListener\('focus', handleFocus\)/u)
  assert.match(appComponent, /addEventListener\('visibilitychange', handleVisibilityChange\)/u)
  assert.match(
    appComponent,
    /autosaveAttempt\.current \+= 1[\s\S]{0,100}setAutosaveError\(''\)[\s\S]{0,120}\[activationStatus\?\.activated, activationStatus\?\.licenseId\]/u,
    'an authorization change invalidates stale autosave failures from the previous license'
  )
  const contactComponent = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'ContactAuthor.tsx'),
    'utf8'
  )
  assert.match(appComponent, /<ContactAuthor\s*\/>/u)
  assert.match(contactComponent, />\s*联系作者\s*<\/button>/u)
  assert.match(contactComponent, /getContact\(\)|onContactChanged/u)
  assert.doesNotMatch(`${appComponent}\n${contactComponent}`, /azssph2|微信号|扫码添加微信|wechat-contact/iu)
  assert.equal(
    existsSync(join(process.cwd(), 'src', 'renderer', 'src', 'assets', 'contact-author-fallback.png')),
    true,
    'generic fallback contact image is bundled with the renderer'
  )
  assert.match(
    appComponent,
    /if \(!activationStatus\?\.activated \|\| !initialized \|\| !settings \|\| persistencePaused\) return/u,
    'autosave does not run while the software is unbound or awaiting reactivation'
  )
  assert.match(
    appComponent,
    /onChange=\{\(event\) => \{[\s\S]{0,180}setActivationCode\([\s\S]{0,100}setActivationError\(''\)/u,
    'changing the activation code clears an error that belongs to the previous code'
  )
  assert.match(
    appComponent,
    /placeholder="POR-XXXX-XXXX-XXXX-XXXX"[\s\S]{0,300}disabled=\{activationBusy \|\|/u,
    'the activation code cannot change while its request is in flight'
  )
  const settingsComponent = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'SettingsModal.tsx'),
    'utf8'
  )
  assert.match(settingsComponent, /typeof cacheApi\.getReportResultCacheStats === 'function'/u)
  assert.match(settingsComponent, /本机缓存管理（一般不用）/u)
  assert.match(settingsComponent, /设备授权/u)
  assert.match(settingsComponent, /更换电脑/u)
  assert.match(settingsComponent, /deactivateCurrentDevice/u)
  assert.equal(settingsComponent.includes('刷新余额'), false, 'service status does not expose a manual balance refresh button')
  assert.equal(settingsComponent.includes('refreshAuthorization'), false, 'manual balance refresh handler is removed with its button')
  assert.doesNotMatch(settingsComponent, /毛利|每百万|真实成本|按真实 Token/u)
  assert.equal(/if \(!open\) return null[\s\S]{0,500}getReportResultCacheStats\(/u.test(settingsComponent), false)
  const phaseTrackerComponent = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'src', 'components', 'PhaseTracker.tsx'),
    'utf8'
  )
  assert.ok(phaseTrackerComponent.includes('最多上传 50 份资料'))

  const styles = [
    readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'styles.css'), 'utf8'),
    readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'styles', 'contact-wallet.css'), 'utf8')
  ].join('\n').replace(/<\/style/gi, '<\\/style')
  assert.match(styles, /\.contact-entry:focus-within \.contact-qr-popover/u)
  assert.match(styles, /\.contact-entry\.pinned \.contact-qr-popover/u)
  assert.match(styles, /@media \(max-width: 46rem\)[\s\S]*?\.contact-entry\s*\{[\s\S]*?display: none/u)
  if (process.env.CI) return
  const htmlPath = join(tempUserData, 'topbar-layout.html')
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
      <div class="app">
        <div class="topbar">
          <div class="brand">
            <span class="brand-mark"></span>
            <span class="brand-copy">
              <span class="brand-main">产品与内容经营报告系统</span>
              <span class="sub">专业的产品经营与内容分析报告系统</span>
            </span>
          </div>
          <div class="contact-entry">
            <button class="contact-trigger" aria-describedby="contact-author-popover">联系作者</button>
            <div class="contact-qr-popover" id="contact-author-popover" role="tooltip">
              <strong>联系作者</strong><img alt="联系作者图片"><span>联系方式图片暂未配置</span>
            </div>
          </div>
          <a class="tutorial-link" href="${expectedGuideUrl}">
            <span class="tutorial-icon"></span>
            <span class="tutorial-copy">
              <span class="tutorial-title">使用教程</span>
              <span class="tutorial-subtitle">新手操作指南</span>
            </span>
            <span class="tutorial-external"></span>
          </a>
          <div class="right">
            <span class="model-pill">模型：ai英雄会（gpt-5.5）</span>
            <button class="btn new-analysis-button"><span class="new-analysis-icon">＋</span><span>新建分析</span></button>
            <button class="btn restore-analysis-button">恢复上一份</button>
            <button class="license-pill">剩余 8,999,699 积分</button>
            <span class="app-version">v0.2.3</span>
            <button class="btn">设置</button>
          </div>
        </div>
      </div>
    </body></html>`,
    'utf8'
  )

  const width = 1280
  const window = new BrowserWindow({
    show: false,
    width,
    height: 180,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'topbar-layout-audit'
    }
  })
  topbarAuditWindow = window
  try {
    await Promise.race([
      window.loadFile(htmlPath),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('topbar audit window load timed out')), 10_000))
    ])
    await new Promise((resolveWait) => setTimeout(resolveWait, 60))
    const layout = (await window.webContents.executeJavaScript(
        `(() => {
          const rect = (selector) => {
            const element = document.querySelector(selector)
            if (!(element instanceof HTMLElement)) return null
            const box = element.getBoundingClientRect()
            return { left: box.left, right: box.right, width: box.width }
          }
          const model = document.querySelector('.model-pill')
          return {
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            brand: rect('.brand'),
            contact: rect('.contact-entry'),
            contactPopover: rect('.contact-qr-popover'),
            tutorial: rect('.tutorial-link'),
            actions: rect('.topbar .right'),
            contactDisplay: getComputedStyle(document.querySelector('.contact-entry')).display,
            topbarZIndex: getComputedStyle(document.querySelector('.topbar')).zIndex,
            modelDisplay: model instanceof HTMLElement ? getComputedStyle(model).display : ''
          }
        })()`
    )) as {
      innerWidth: number
      scrollWidth: number
      brand: { left: number; right: number; width: number } | null
      contact: { left: number; right: number; width: number } | null
      contactPopover: { left: number; right: number; width: number } | null
      tutorial: { left: number; right: number; width: number } | null
      actions: { left: number; right: number; width: number } | null
      contactDisplay: string
      topbarZIndex: string
      modelDisplay: string
    }
    assert.equal(layout.innerWidth, width)
    assert.ok(layout.scrollWidth <= layout.innerWidth, `${width}px 顶栏出现横向滚动`)
    assert.ok(layout.brand && layout.contact && layout.tutorial && layout.actions)
    assert.ok(layout.brand!.right + 8 <= layout.contact!.left, `${width}px 品牌区与联系方式重叠`)
    assert.ok(layout.contact!.right + 8 <= layout.tutorial!.left, `${width}px 联系方式与教程入口重叠`)
    assert.ok(layout.contactPopover && layout.contactPopover.left >= 0, `${width}px 二维码浮层超出左侧窗口`)
    assert.ok(layout.contactPopover!.right <= layout.innerWidth, `${width}px 二维码浮层超出右侧窗口`)
    assert.ok(layout.contactPopover!.width >= 400, '二维码浮层宽度不足，扫码区域会过小')
    assert.equal(layout.topbarZIndex, '500', '顶栏层级必须高于内容区')
    assert.ok(layout.tutorial!.right + 8 <= layout.actions!.left, `${width}px 教程入口与操作区重叠`)
    assert.equal(layout.modelDisplay, 'none')
  } finally {
    if (!window.isDestroyed()) window.destroy()
    topbarAuditWindow = null
  }
}

const HTML_REPORT_FIXTURE = `# 盐中甜酸菜 产品经营报告
生成日期：2026-07-27
<!-- Product visual brief
role: 家庭日常快速配餐
audience: 需要直接、可信表达的家庭主理人
scene: 工作日晚餐和早餐配餐
value-signal: practicality
trust-model: visible-use
design-direction: household-field-guide
evidence-confidence: confirmed
-->

## 0. 结论先行
这是一个面向家庭日常快速配餐的产品，经营上应优先讲清方便、真实吃法和复购理由。

| 优先级 | 核心人群 | 关键判断 |
|---|---|---|
| P0 | 31-45 岁家庭主理人 | 晚餐配菜和早餐配餐需求明确 |
| P1 | 50 岁以上家庭用户 | 更重视口味熟悉和使用方便 |

## 1. 数据来源与使用范围
| 数据类型 | 来源 | 本次用途 |
|---|---|---|
| 成交人群 | 视频号截图 | 判断家庭人群 |
| 购买画像 | 巨量云图 | 判断年龄结构 |

## 2. 产品基础信息
| 模块 | 当前判断 |
|---|---|
| 产品名称 / 类目 | 盐中甜酸菜 / 佐餐食品 |
| 核心成交规模 | GMV 128.6万元 |
| 当前客单 | 79元 |
| 主要使用场景 | 早餐、晚餐、家庭囤货 |

## 3. 一方数据核心判断
### 3.1 视频号成交人群
| 维度 | 关键数据 | 经营含义 |
|---|---|---|
| 女性 | 67.4% | 家庭主理人是重点 |
| 31-45 岁 | 48.2% | 处于家庭餐食决策阶段 |

### 3.2 云图购买画像
| 维度 | 关键数据 | 经营含义 |
|---|---|---|
| 小镇中年 | 32.1% | 关注熟悉口味 |
| 都市银发 | 21.6% | 关注方便与可信 |

### 重复标题
同名标题第一次。
### 重复标题
同名标题第二次。

## 4. 竞品与素材打法判断
### 4.1 自有爆款素材结构
| 指标 | 结果 |
|---|---|
| 场景开头 | 45% |
| 口味展示 | 35% |
| 机制收口 | 20% |

### 4.2 竞品素材结构
| 竞品开头 | 打法本质 | 我方可迁移方向 |
|---|---|---|
| 今天晚饭不知道吃什么 | 场景切入 | 家庭快餐场景 |

## 5. 产品全量卖点拆解
| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |
|---|---|---|
| 产品包装 | 小袋分装 | 开袋方便 |
| 价格 | 需补充 | 需补充 |
| 场景 | 家庭佐餐 | 不用临时准备复杂配菜 |

## 6. 卖点用户视角排序
| 排序 | 用户视角卖点 | 对应产品事实 | 打动的人群/场景 | 作用 |
|---|---|---|---|---|
| 1 | 开袋就能配饭 | 小袋分装 | 工作日晚餐 | 转化钩子 |
| 2 | 熟悉口味更安心 | 原料和口味资料 | 家庭复购 | 信任支撑 |

## 7. 核心成交人群画像与卖点场景匹配
一句话总判断：家庭餐食决策者是当前主力。

| 优先级 | 成交人群 | 数据依据/特征 | 核心卖点 | 核心场景 | 内容语言 |
|---|---|---|---|---|---|
| 第一主力 | 31-45 岁已育女性/家庭主理人 | 视频号女性 67.4% | 开袋方便 | 工作日晚餐 | 直接展示吃法 |
| 第二承接 | 50+ 家庭用户 | 银发 21.6% | 熟悉口味 | 早餐佐餐 | 真实、易懂 |

## 8. 视频号内容主线设计
| 内容主线 | 数据/分析依据 | 对应人群 | 对应卖点 | 核心场景 | 内容表达 | 作用 |
|---|---|---|---|---|---|---|
| 家庭快餐 | 视频号画像 | 家庭主理人 | 方便 | 晚餐 | 实拍吃法 | 主转化 |
| 熟悉口味 | 银发画像 | 50+ 家庭用户 | 口味 | 早餐 | 用户体验 | 信任 |
| 囤货机制 | 复购场景 | 家庭用户 | 规格 | 囤货 | 机制解释 | 收口 |

建议内容体量：

| 内容主线 | 建议占比 | 原因 |
|---|---|---|
| 家庭快餐 | 50% | 主需求 |
| 熟悉口味 | 30% | 信任 |
| 囤货机制 | 20% | 转化 |

## 9. 内容执行方向
### 9.1 第一轮建议选题
| 脚本编号 | 内容主线 | 选题 | 视频分类 | 视角 | 人群 | 场景 | 开头类型 | 3 秒开头来源 | 参考视频结构 | 优先级 |
|---|---|---|---|---|---|---|---|---|---|---|
| S01 | 家庭快餐 | 下班十分钟开饭 | 3.1 | 用户 | 家庭主理人 | 晚餐 | 场景 | 自有素材A | 场景-吃法-产品 | P0 |
| S02 | 熟悉口味 | 爸妈早餐怎么配 | 3.2 | 专业 | 50+ 家庭用户 | 早餐 | 痛点 | 自有素材B | 痛点-展示-证据 | P0 |
| S03 | 囤货机制 | 家庭一周怎么备 | 3.99 | 商家 | 家庭用户 | 囤货 | 机制 | 自有素材C | 规格-场景-机制 | P1 |

### 9.2 3 秒开头库
| 开头类型 | 可直接复用的原始开头 |
|---|---|
| 场景 | 今天晚饭不知道吃什么 |

## 10. 经营建议
1. 优先制作家庭晚餐场景素材。
2. 用真实吃法补足信任证据。
3. 补齐价格与规格机制。

## 11. 本次报告的限制
- 价格机制仍需品牌确认。
- 部分素材缺少完整成交字段。
- 超长字段测试：这是一段用于验证小屏幕自动换行且不会把页面撑出横向滚动的中文长文本这是一段用于验证小屏幕自动换行且不会把页面撑出横向滚动的中文长文本。

<script>alert("bad")</script>
<img src="https://example.com/tracker.png" onerror="alert(1)">
> (注：内容由 AI 生成，请谨慎参考）`

async function testHtmlReportRenderer(): Promise<void> {
  const model = parseHtmlReportModel(HTML_REPORT_FIXTURE)
  assert.equal(model.sections.length, 12)
  assert.deepEqual(model.sections.map((section) => section.number), [
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    '10',
    '11'
  ])
  assert.equal(model.brief.designDirection, 'household-field-guide')
  assert.equal(model.brief.evidenceConfidence, 'confirmed')
  const presentation = buildHtmlReportPresentation(model)
  assert.ok(presentation.mainMetric)
  assert.match(presentation.mainMetric?.label || '', /女性占比/)
  for (const metric of [presentation.mainMetric, ...presentation.supportingSignals]) {
    if (!metric) continue
    const source = metric.source
    assert.notEqual(source.tableIndex, null)
    assert.notEqual(source.rowIndex, null)
    assert.notEqual(source.columnIndex, null)
    assert.equal(
      model.sections
        .find((section) => section.number === source.sectionNumber)
        ?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
      source.rawValue
    )
  }
  for (const sectionPlan of presentation.sections) {
    const section = model.sections.find((candidate) => candidate.number === sectionPlan.sectionNumber)
    assert.ok(section)
    for (const source of sectionPlan.visualSources) {
      const expected =
        source.tableIndex === null
          ? section?.listItems[source.rowIndex!]
          : section?.tables[source.tableIndex]?.rows[source.rowIndex!]?.[source.columnIndex!]
      assert.equal(expected, source.rawValue)
    }
  }
  assert.equal(presentation.sections.find((section) => section.sectionNumber === '0')?.tables[0]?.mode, 'visible')
  assert.equal(presentation.sections.find((section) => section.sectionNumber === '9')?.tables[0]?.mode, 'collapsed')
  const executionPlan = presentation.sections.find((section) => section.sectionNumber === '9')
  assert.equal(executionPlan?.executionDistributions.length, 2)
  for (const distribution of executionPlan?.executionDistributions || []) {
    assert.equal(
      distribution.items.reduce((sum, item) => sum + item.value, 0),
      distribution.total
    )
    for (const item of distribution.items) {
      for (const source of item.sources) {
        assert.equal(
          model.sections
            .find((section) => section.number === source.sectionNumber)
            ?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
          source.rawValue
        )
      }
    }
  }

  const html = await markdownToHtmlDocument(HTML_REPORT_FIXTURE)
  const repeated = await markdownToHtmlDocument(HTML_REPORT_FIXTURE)
  assert.equal(html, repeated)
  assert.match(html, /data-report-direction="household-field-guide"/)
  assert.match(html, /先做什么，再验证什么/)
  assert.match(html, /class="story-stat-hero"/)
  assert.match(html, /class="signal-strip"/)
  assert.match(html, /class="decision-dashboard"/)
  assert.match(html, /class="chapter-index"/)
  assert.match(html, /data-source-value=/)
  assert.match(html, /data-source-cell-count=/)
  assert.match(html, /分口径数据对比/)
  assert.match(html, /证据如何进入经营判断/)
  assert.match(html, /真实卖点表达顺序|用户决策顺序/)
  assert.match(html, /人群、场景与卖点匹配/)
  assert.match(html, /建议内容结构/)
  assert.match(html, /class="content-mix-dashboard"/)
  assert.match(html, /class="donut-chart"/)
  assert.match(html, /第一轮脚本组合/)
  assert.match(html, /class="donut-pair"/)
  assert.match(html, /class="execution-matrix"/)
  assert.match(html, /发布前风险护栏/)
  assert.match(html, /data-label="脚本编号"/)
  assert.match(html, /scope="col"/)
  assert.match(html, /@media \(max-width: 414px\)/)
  assert.match(html, /@media \(min-width: 769px\) and \(max-width: 1080px\)/)
  assert.match(html, /@media print/)
  assert.match(html, /@page wide/)
  assert.match(html, /class="skip-link"/)
  assert.equal(html.includes('class="mobile-toc"'), false)
  assert.match(html, /@media \(min-width: 769px\)[\s\S]*?\.chapter-index \{ display: none; \}/)
  assert.match(html, /class="evidence-disclosure"/)
  assert.match(html, /查看完整数据/)
  assert.match(html, /class="print-table-copy"/)
  assert.match(html, /\.print-table-copy \{ display: block !important; \}/)
  assert.match(html, /overflow-wrap: anywhere/)
  assert.match(html, /重复标题-2/)
  assert.equal((html.match(/class="report-section"/g) || []).length, 12)
  assert.ok(html.indexOf('0. 结论先行') < html.indexOf('11. 本次报告的限制'))
  assert.ok(html.includes('GMV 128.6万元'))
  assert.ok(html.includes('价格机制仍需品牌确认'))
  assert.equal(html.includes('<script>alert("bad")</script>'), false)
  assert.equal(html.includes('tracker.png'), false)
  assert.equal(html.includes('onerror='), false)
  assert.equal(html.includes('Product visual brief'), false)
  assert.equal(html.includes('@import'), false)
  assert.equal(html.includes('<link'), false)

  const stripped = stripProductVisualBrief(HTML_REPORT_FIXTURE)
  assert.equal(stripped.includes('Product visual brief'), false)
  assert.ok(stripped.startsWith('# 盐中甜酸菜 产品经营报告'))

  const legacy = HTML_REPORT_FIXTURE.replace(/<!-- Product visual brief[\s\S]*?-->\n?/, '')
  const legacyModel = parseHtmlReportModel(legacy)
  assert.equal(legacyModel.brief.evidenceConfidence, 'insufficient')
  assert.equal(legacyModel.brief.designDirection, 'neutral-evidence')
  const legacyHtml = await markdownToHtmlDocument(legacy)
  assert.match(legacyHtml, /data-report-direction="neutral-evidence"/)

  const invalidMix = HTML_REPORT_FIXTURE.replace('| 囤货机制 | 20% | 转化 |', '| 囤货机制 | 10% | 转化 |')
  const invalidMixHtml = await markdownToHtmlDocument(invalidMix)
  assert.equal(invalidMixHtml.includes('建议内容结构'), false)
  assert.equal(invalidMixHtml.includes('class="content-mix-dashboard"'), false)
  assert.ok(invalidMixHtml.includes('内容主线'))

  const missingMix = HTML_REPORT_FIXTURE.replace('| 囤货机制 | 20% | 转化 |', '| 囤货机制 | 需补充 | 转化 |')
  const missingMixHtml = await markdownToHtmlDocument(missingMix)
  assert.equal(missingMixHtml.includes('建议内容结构'), false)
  assert.equal(missingMixHtml.includes('class="content-mix-dashboard"'), false)

  const rangedMix = HTML_REPORT_FIXTURE
    .replace('| 家庭快餐 | 50% | 主需求 |', '| 家庭快餐 | 50%-60% | 主需求 |')
    .replace('| 囤货机制 | 20% | 转化 |', '| 囤货机制 | 20% | 转化 |')
  const rangedMixHtml = await markdownToHtmlDocument(rangedMix)
  assert.equal(rangedMixHtml.includes('建议内容结构'), false)
  assert.equal(rangedMixHtml.includes('class="content-mix-dashboard"'), false)

  const misleadingClass = HTML_REPORT_FIXTURE.replace(
    '| S01 | 家庭快餐 | 下班十分钟开饭 | 3.1 | 用户 |',
    '| S01 | 家庭快餐 | 下班十分钟开饭 | 3.10 | 用户 |'
  )
  const misleadingClassHtml = await markdownToHtmlDocument(misleadingClass)
  const classCounts = misleadingClassHtml.match(
    /<section class="donut-card">\s*<h3>视频分类<\/h3>([\s\S]*?)<\/section>/
  )?.[1]
  assert.ok(classCounts)
  assert.match(classCounts || '', /<span>3\.1<\/span>[\s\S]*?<strong>0条<\/strong>/)
  assert.match(classCounts || '', /<span>其他分类<\/span>[\s\S]*?<strong>1条<\/strong>/)

  const keywordMarkdown = `# 卖点词频测试

## 5. 产品全量卖点拆解
| 卖点维度 | 我方产品卖点 | 用户能感知的好处 |
|---|---|---|
| 原料 | 免清洗、免切、鲜脆、不咸纯酸；来源：项目数据.csv | 家庭做菜更方便 |
| 使用 | 免清洗、免切、鲜脆、不咸纯酸；来源：项目数据.csv | 家庭晚餐更快速 |
| 工艺 | 植物基益生菌直投式发酵、小叶芥菜、酸香；来源：产品手卡.pptx | 项目资料记载 |
| 口感 | 植物基益生菌直投式发酵、小叶芥菜、酸香；来源：产品手卡.pptx | 用户购买更放心 |`
  const keywordModel = parseHtmlReportModel(keywordMarkdown)
  const keywordPlan = buildHtmlReportPresentation(keywordModel).sections.find(
    (section) => section.sectionNumber === '5'
  )
  assert.ok(keywordPlan?.keywordCloud)
  assert.ok((keywordPlan?.keywordCloud?.items.length || 0) >= 6)
  assert.ok(keywordPlan?.keywordCloud?.items.some((item) => /免清洗|免切|鲜脆|发酵|芥菜|酸香/u.test(item.label)))
  assert.doesNotMatch(
    (keywordPlan?.keywordCloud?.items || []).map((item) => item.label).join('、'),
    /项目|数据|csv|pptx|来源|购买|家庭/u
  )
  const keywordSection = keywordModel.sections.find((section) => section.number === '5')
  for (const item of keywordPlan?.keywordCloud?.items || []) {
    assert.ok(item.count >= 2)
    for (const source of item.sources) {
      assert.equal(source.columnIndex, 1, 'keyword provenance must stay in the selling-point column')
      assert.equal(
        keywordSection?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
        source.rawValue
      )
    }
  }
  const keywordHtml = await markdownToHtmlDocument(keywordMarkdown)
  assert.match(keywordHtml, /class="word-cloud"/)
  assert.match(keywordHtml, /卖点关键词频次/)
  assert.match(keywordHtml, /data-count="\d+"/)

  const sparseKeywordPlan = buildHtmlReportPresentation(
    parseHtmlReportModel(
      '# 稀疏词测试\n\n## 5. 产品全量卖点拆解\n| 卖点维度 | 我方产品卖点 |\n|---|---|\n| A | 清爽脆嫩 |\n| B | 独立小袋 |'
    )
  ).sections.find((section) => section.sectionNumber === '5')
  assert.equal(sparseKeywordPlan?.keywordCloud, null)

  const incompleteBrief = HTML_REPORT_FIXTURE.replace(
    /role: 家庭日常快速配餐/,
    'role: 需补充'
  )
  const incompleteBriefModel = parseHtmlReportModel(incompleteBrief)
  assert.equal(incompleteBriefModel.brief.evidenceConfidence, 'insufficient')
  assert.equal(incompleteBriefModel.brief.designDirection, 'neutral-evidence')

  const invalidControlledBrief = HTML_REPORT_FIXTURE
    .replace('value-signal: practicality', 'value-signal: invented')
    .replace('trust-model: visible-use', 'trust-model: invented')
  const invalidControlledBriefModel = parseHtmlReportModel(invalidControlledBrief)
  assert.equal(invalidControlledBriefModel.brief.evidenceConfidence, 'insufficient')
  assert.equal(invalidControlledBriefModel.brief.designDirection, 'neutral-evidence')

  const malformedAudience = HTML_REPORT_FIXTURE.replace(
    '| 优先级 | 成交人群 | 数据依据/特征 | 核心卖点 | 核心场景 | 内容语言 |',
    '| 优先级 | 人群备注 | 数据依据/特征 | 卖点备注 | 场景备注 | 内容语言 |'
  )
  const malformedAudienceHtml = await markdownToHtmlDocument(malformedAudience)
  assert.equal(malformedAudienceHtml.includes('人群、场景与卖点匹配'), false)

  for (const range of ['31-45 岁', '31 - 45 岁', '31—45 岁', '31~45 岁', '31～45 岁', '31至45 岁']) {
    const ageRange = await markdownToHtmlDocument(
      `# 年龄测试\n\n## 2. 产品基础信息\n| 模块 | 当前判断 |\n|---|---|\n| 核心年龄 | ${range} |`
    )
    assert.doesNotMatch(ageRange, /<strong>-?45岁<\/strong>/)
    assert.doesNotMatch(ageRange, /<strong>3145岁<\/strong>/)
  }

  const genericMaterialList = await markdownToHtmlDocument(
    '# 素材清单测试\n\n## 4. 竞品与素材打法判断\n| 素材链接 | 备注 |\n|---|---|\n| A | 示例一 |\n| B | 示例二 |'
  )
  assert.equal(genericMaterialList.includes('素材打法提炼'), false)

  const dualMaterialPlaybook = await markdownToHtmlDocument(
    '# 双来源素材测试\n\n## 4. 竞品与素材打法判断\n### 4.1 自有素材\n| 类型 | 原始 3 秒开头 | 可复用方向 |\n|---|---|---|\n| 场景钩子 | 今晚不知道吃什么 | 下饭菜场景 |\n\n### 4.2 竞品素材\n| 竞品开头 | 打法本质 | 我方可迁移方向 |\n|---|---|---|\n| 会吃的人跟时令走 | 生活方式起势 | 家庭餐桌表达 |'
  )
  assert.match(dualMaterialPlaybook, /素材打法迁移链/)
  assert.match(dualMaterialPlaybook, /data-source-tables="0,1"/)
  assert.match(dualMaterialPlaybook, /自有素材/)
  assert.match(dualMaterialPlaybook, /竞品借鉴/)

  const invalidEntity = await markdownToHtmlDocument(
    '# 极端实体 &#9999999999;\n\n## 0. 结论先行\n仍可正常导出。'
  )
  assert.ok(invalidEntity.includes('极端实体'))
  assert.ok(invalidEntity.includes('�'))

  const longUrl = `https://example.com/${'very-long-path-'.repeat(30)}`
  const longUrlHtml = await markdownToHtmlDocument(
    `# 长链接测试\n\n## 0. 结论先行\n[完整长链接](${longUrl})`
  )
  assert.ok(longUrlHtml.includes(longUrl))
  assert.match(longUrlHtml, /word-break: break-word/)

  const platformFacets = await markdownToHtmlDocument(
    '# 分平台测试\n\n## 3. 一方数据核心判断\n### 同口径人群占比\n| 平台 | 维度 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |\n| 云图 | 女性 | 55% |\n| 云图 | 男性 | 45% |'
  )
  assert.match(platformFacets, /同口径人群占比 · 视频号 · 关键数据/)
  assert.match(platformFacets, /同口径人群占比 · 云图 · 关键数据/)

  const sourceFacets = await markdownToHtmlDocument(
    '# 分来源测试\n\n## 3. 一方数据核心判断\n### 同口径人群占比\n| 来源 | 维度 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |\n| 云图 | 女性 | 55% |\n| 云图 | 男性 | 45% |'
  )
  assert.match(sourceFacets, /同口径人群占比 · 视频号 · 关键数据/)
  assert.match(sourceFacets, /同口径人群占比 · 云图 · 关键数据/)

  const groupedDimensions = await markdownToHtmlDocument(
    '# 分维度测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 维度 | 类别 | 关键数据 |\n|---|---|---|---|\n| 视频号 | 性别 | 女性 | 60% |\n| 视频号 | 性别 | 男性 | 40% |\n| 视频号 | 年龄 | 31-40岁 | 45% |\n| 视频号 | 年龄 | 41-50岁 | 30% |'
  )
  assert.match(groupedDimensions, /视频号成交人群 · 视频号 · 性别 · 关键数据/)
  assert.match(groupedDimensions, /视频号成交人群 · 视频号 · 年龄 · 关键数据/)
  assert.match(groupedDimensions, />女性<\/span><strong>60%<\/strong>/)
  assert.match(groupedDimensions, />31-40岁<\/span><strong>45%<\/strong>/)

  const inlineProfileMarkdown =
    '# 复合人群数据测试\n\n## 3. 一方数据核心判断\n### 3.1 抖店成交人群\n| 维度 | 关键数据 | 经营含义 |\n|---|---|---|\n| 性别 | 女性占比 78.14% | 女性决策者为主 |\n| 年龄 | 31-35岁 30.11%，36-40岁 17.02%，41-45岁 9.88% | 主力年龄 |\n| 婚育 | 已育 72.96% | 家庭场景 |\n| 人群标签 | 精致妈妈 24.95%、资深中产 23.07% | 重点标签 |\n| 地域 | 江苏 19.09%，浙江 9.68%，上海 5.87% | 华东突出 |'
  const inlineProfileModel = parseHtmlReportModel(inlineProfileMarkdown)
  const inlineProfilePlan = buildHtmlReportPresentation(inlineProfileModel).sections.find(
    (section) => section.sectionNumber === '3'
  )
  assert.equal(inlineProfilePlan?.percentFacets.length, 5)
  assert.equal(inlineProfilePlan?.percentFacets.filter((facet) => facet.mode === 'stat').length, 2)
  assert.equal(inlineProfilePlan?.percentFacets.filter((facet) => facet.mode === 'bars').length, 3)
  assert.deepEqual(inlineProfilePlan?.visualSourceTableIndexes, [0])
  const inlineProfileSection = inlineProfileModel.sections.find((section) => section.number === '3')
  for (const source of inlineProfilePlan?.visualSources || []) {
    assert.equal(
      inlineProfileSection?.tables[source.tableIndex!]?.rows[source.rowIndex!]?.[source.columnIndex!],
      source.rawValue
    )
  }
  const inlineProfileHtml = await markdownToHtmlDocument(inlineProfileMarkdown)
  assert.match(inlineProfileHtml, /class="profile-board"/)
  assert.match(inlineProfileHtml, /class="profile-kpi"/)
  assert.match(inlineProfileHtml, />31-35岁<\/span><strong>30\.11%<\/strong>/)
  assert.match(inlineProfileHtml, /单项占比用数字卡呈现/)

  const unsafeInlineProfile = await markdownToHtmlDocument(
    '# 不确定复合数据测试\n\n## 3. 一方数据核心判断\n### 3.1 抖店成交人群\n| 维度 | 关键数据 |\n|---|---|\n| 年龄 | 31-35岁约30.11%，36-40岁17.02% |\n| 地域 | 江苏 119%，浙江 9.68% |'
  )
  assert.equal(unsafeInlineProfile.includes('一方数据分口径对比'), false)

  const emptyCategories = await markdownToHtmlDocument(
    '# 空类别测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 维度 | 类别 | 关键数据 |\n|---|---|---|---|\n| 视频号 | 性别 |  | 60% |\n| 视频号 | 性别 |  | 40% |'
  )
  assert.equal(emptyCategories.includes('一方数据分口径对比'), false)

  const aliasedDimensions = await markdownToHtmlDocument(
    '# 维度别名测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 属性 | 选项 | 关键数据 |\n|---|---|---|---|\n| 视频号 | 性别 | 女性 | 60% |\n| 视频号 | 性别 | 男性 | 40% |\n| 视频号 | 年龄 | 31-40岁 | 45% |\n| 视频号 | 年龄 | 41-50岁 | 30% |'
  )
  assert.match(aliasedDimensions, /视频号成交人群 · 视频号 · 性别 · 关键数据/)
  assert.match(aliasedDimensions, /视频号成交人群 · 视频号 · 年龄 · 关键数据/)

  const compactMixedDimensions = await markdownToHtmlDocument(
    '# 紧凑混合维度测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 类别 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |\n| 视频号 | 31-40岁 | 45% |\n| 视频号 | 41-50岁 | 30% |'
  )
  assert.equal(compactMixedDimensions.includes('一方数据分口径对比'), false)

  const compactSingleDimension = await markdownToHtmlDocument(
    '# 紧凑单维度测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 平台 | 类别 | 关键数据 |\n|---|---|---|\n| 视频号 | 女性 | 60% |\n| 视频号 | 男性 | 40% |'
  )
  assert.match(compactSingleDimension, /视频号成交人群 · 视频号 · 关键数据/)

  const implicitMixedPlatform = await markdownToHtmlDocument(
    '# 隐式跨平台测试\n\n## 3. 一方数据核心判断\n### 综合数据\n| 维度 | 关键数据 |\n|---|---|\n| 视频号女性 | 60% |\n| 视频号男性 | 40% |\n| 云图女性 | 55% |\n| 云图男性 | 45% |'
  )
  assert.equal(implicitMixedPlatform.includes('一方数据分口径对比'), false)

  const mixedDenominator = await markdownToHtmlDocument(
    '# 混合分母测试\n\n## 3. 一方数据核心判断\n### 视频号综合指标\n| 维度 | 关键数据 |\n|---|---|\n| 女性占全部用户 | 60% |\n| 复购用户占已购用户 | 20% |'
  )
  assert.equal(mixedDenominator.includes('一方数据分口径对比'), false)

  const mixedMetricRates = await markdownToHtmlDocument(
    '# 混合指标测试\n\n## 3. 一方数据核心判断\n### 视频号综合指标\n| 维度 | 数据 |\n|---|---|\n| 女性比例 | 60% |\n| 复购率 | 20% |'
  )
  assert.equal(mixedMetricRates.includes('一方数据分口径对比'), false)

  const implicitSinglePlatform = await markdownToHtmlDocument(
    '# 单平台测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 60% |\n| 男性 | 40% |'
  )
  assert.match(implicitSinglePlatform, /视频号成交人群 · 关键数据/)

  const sourceDriftModel = parseHtmlReportModel(
    '# 来源绑定测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群已确认\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 60% |\n| 男性 | 40% |\n\n### 视频号成交人群约数\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 约55% |\n| 男性 | 约45% |'
  )
  const sourceDriftPlan = buildHtmlReportPresentation(sourceDriftModel).sections.find(
    (section) => section.sectionNumber === '3'
  )
  assert.deepEqual(sourceDriftPlan?.visualSourceTableIndexes, [0])
  assert.equal(sourceDriftPlan?.percentFacets.length, 1)
  const sourceDriftHtml = await markdownToHtmlDocument(
    '# 来源绑定测试\n\n## 3. 一方数据核心判断\n### 视频号成交人群已确认\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 60% |\n| 男性 | 40% |\n\n### 视频号成交人群约数\n| 维度 | 关键数据 |\n|---|---|\n| 女性 | 约55% |\n| 男性 | 约45% |'
  )
  assert.match(sourceDriftHtml, /data-source-tables="0"/)
  assert.equal(sourceDriftHtml.includes('约55%</strong>'), false)

  const fallbackMixModel = parseHtmlReportModel(
    '# 内容回退测试\n\n## 8. 视频号内容主线设计\n| 方向 | 建议占比 |\n|---|---|\n| A | 60% |\n| B | 30% |\n\n| 内容主线 | 对应人群 | 选题方向 |\n|---|---|---|\n| 家庭快餐 | 家庭用户 | 十分钟开饭 |'
  )
  const fallbackMixPlan = buildHtmlReportPresentation(fallbackMixModel).sections.find(
    (section) => section.sectionNumber === '8'
  )
  assert.equal(fallbackMixPlan?.contentMix?.mode, 'mainline')
  assert.deepEqual(fallbackMixPlan?.visualSourceTableIndexes, [1])
  const fallbackMixHtml = await markdownToHtmlDocument(
    '# 内容回退测试\n\n## 8. 视频号内容主线设计\n| 方向 | 建议占比 |\n|---|---|\n| A | 60% |\n| B | 30% |\n\n| 内容主线 | 对应人群 | 选题方向 |\n|---|---|---|\n| 家庭快餐 | 家庭用户 | 十分钟开饭 |'
  )
  assert.match(fallbackMixHtml, /data-source-tables="1"/)

  const incomplete = await markdownToHtmlDocument('# 空报告\n生成日期：2026-07-27\n\n## 0. 结论先行\n需补充')
  assert.match(incomplete, /data-report-direction="neutral-evidence"/)
  assert.ok(incomplete.includes('需补充'))
  assert.equal(
    buildHtmlReportPresentation(
      parseHtmlReportModel('# 低信号报告\n\n## 2. 产品基础信息\n| 模块 | 当前判断 |\n|---|---|\n| 规格 | 3袋 |')
    ).mainMetric,
    null
  )
  assert.equal(
    buildHtmlReportPresentation(
      parseHtmlReportModel(
        '# 规格与价格测试\n\n## 2. 产品基础信息\n| 模块 | 关键数据 |\n|---|---|\n| 规格 | 10个 |\n| 价格 | 79元 |'
      )
    ).mainMetric,
    null
  )
  for (const range of ['19.9~25.9元', '19.9～25.9元', '10~20个']) {
    const rangePresentation = buildHtmlReportPresentation(
      parseHtmlReportModel(
        `# 区间测试\n\n## 3. 一方数据核心判断\n| 指标 | 关键数据 |\n|---|---|\n| 价格区间 | ${range} |`
      )
    )
    assert.equal(rangePresentation.mainMetric, null)
    assert.equal(rangePresentation.supportingSignals.length, 0)
  }

  const sanitized = sanitizeHtmlFragment(
    '<p class="ok" onclick="bad()">安全</p><iframe src="x">坏</iframe><a href="javascript:bad()">链接</a>'
  )
  assert.equal(sanitized.includes('onclick'), false)
  assert.equal(sanitized.includes('iframe'), false)
  assert.equal(sanitized.includes('javascript:'), false)
  assert.ok(sanitized.includes('安全'))

  assert.equal(
    friendlyError(new Error('EPERM: operation not permitted, rename report.html')),
    '文件可能正在被占用，或保存位置没有权限。请关闭同名文件，或改存到桌面后重试。'
  )
  assert.equal(
    friendlyError(new Error('ENOSPC: no space left on device')),
    '磁盘空间不足，无法保存文件。请清理空间或改存到其他磁盘后重试。'
  )
  assert.equal(
    friendlyError(new Error('EBUSY: resource busy or locked')),
    '文件正在被其他程序占用。请关闭同名的 Word 或浏览器文件后重试。'
  )

  const bundledRules = readBundledSopRules([join(process.cwd(), 'assets', 'skill', 'SKILL.md')])
  assert.match(bundledRules, /内置 HTML 视觉规范/)
  assert.match(bundledRules, /Product visual brief/)
}

async function testContactConfigurationAndCache(): Promise<void> {
  const originalFetch = globalThis.fetch
  const png = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ))
  const config = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    app_name: 'ProductOperationReport',
    enabled: true,
    qr_image_url: 'https://cdn.example.com/contact.png',
    updated_at: '2026-08-19T10:00:00Z',
    ...overrides
  })
  const reset = (): void => {
    contactInternals.resetInFlight()
    rmSync(contactInternals.cacheDirectory(), { recursive: true, force: true })
  }
  try {
    reset()
    let calls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls += 1
      const url = String(input)
      if (url.includes('/api/contact')) {
        return new Response(JSON.stringify(config()), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch
    const [remote, sameRemote] = await Promise.all([refreshContactConfig(), refreshContactConfig()])
    assert.equal(calls, 2, 'concurrent first interactions share one config and image request')
    assert.equal(remote.source, 'remote')
    assert.equal(remote.enabled, true)
    assert.match(remote.imageDataUrl || '', /^data:image\/png;base64,/u)
    assert.equal(sameRemote.imageDataUrl, remote.imageDataUrl)
    const cached = getCachedContactState()
    assert.equal(cached.source, 'cache')
    assert.equal(cached.imageDataUrl, remote.imageDataUrl)

    contactInternals.resetInFlight()
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    const offline = await refreshContactConfig()
    assert.equal(offline.source, 'cache')
    assert.equal(offline.imageDataUrl, remote.imageDataUrl)

    contactInternals.resetInFlight()
    globalThis.fetch = (async () => new Response(JSON.stringify(config({ enabled: false, qr_image_url: '' })), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const disabled = await refreshContactConfig()
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.imageDataUrl, undefined)
    assert.equal(getCachedContactState().enabled, false, 'disabled tombstone prevents an old image from returning')

    contactInternals.resetInFlight()
    globalThis.fetch = (async () => new Response(JSON.stringify(config({ qr_image_url: '' })), {
      status: 200, headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const missingImage = await refreshContactConfig()
    assert.equal(missingImage.enabled, true)
    assert.equal(missingImage.configured, true)
    assert.equal(missingImage.imageDataUrl, undefined)
    assert.match(missingImage.message, /暂未配置/u)

    reset()
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      return url.includes('/api/contact')
        ? new Response(JSON.stringify(config()), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    }) as typeof fetch
    const valid = await refreshContactConfig()
    for (const invalidConfig of [
      config({ app_name: 'OtherApp' }),
      config({ qr_image_url: 'http://cdn.example.com/contact.png' })
    ]) {
      contactInternals.resetInFlight()
      globalThis.fetch = (async () => new Response(JSON.stringify(invalidConfig), {
        status: 200, headers: { 'content-type': 'application/json' }
      })) as typeof fetch
      const rejected = await refreshContactConfig()
      assert.equal(rejected.source, 'cache')
      assert.equal(rejected.imageDataUrl, valid.imageDataUrl, 'invalid remote config cannot overwrite a valid cache')
    }

    contactInternals.resetInFlight()
    globalThis.fetch = (async () => new Response(JSON.stringify(config()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
    const wrongContentType = await refreshContactConfig()
    assert.equal(wrongContentType.source, 'cache', 'a non-image response keeps the valid cache')

    contactInternals.resetInFlight()
    globalThis.fetch = (async () => new Response('not configured', { status: 404 })) as typeof fetch
    const notConfigured = await refreshContactConfig()
    assert.equal(notConfigured.configured, false)
    assert.equal(notConfigured.imageDataUrl, undefined)
    assert.equal(getCachedContactState().imageDataUrl, undefined, '404 clears the active remote image state')

    reset()
    contactInternals.resetInFlight()
    globalThis.fetch = (async (input: string | URL | Request) => String(input).includes('/api/contact')
      ? new Response(JSON.stringify(config()), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response(png, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(contactInternals.MAX_IMAGE_BYTES + 1) }
        })) as typeof fetch
    const oversized = await refreshContactConfig()
    assert.equal(oversized.source, 'bundled')
    assert.equal(oversized.imageDataUrl, undefined)
  } finally {
    globalThis.fetch = originalFetch
    contactInternals.resetInFlight()
    rmSync(contactInternals.cacheDirectory(), { recursive: true, force: true })
  }
}

async function run(): Promise<void> {
  console.log('Regression: project persistence')
  await testProjectRevisionAndBackup()
  console.log('Regression: device identity survives restart and authorization reset')
  await testDeviceIdentityPersistsAcrossAuthorizationReset()
  console.log('Regression: historical authorization credential-upgrade retry')
  await testHistoricalCredentialRefreshRetry()
  console.log('Regression: v0.2.6-style authorization restores automatically on startup')
  await testLegacyUpgradeRestoresOnStartup()
  console.log('Regression: securely saved activation recovery')
  await testSavedActivationRecovery()
  console.log('Regression: secure vault backup recovery and corruption guard')
  testSecureVaultBackupAndCorruptionGuard()
  console.log('Regression: proactive session rotation and explicit expired-session recovery')
  await testSessionRotationAndExpiredRecovery()
  console.log('Regression: administrator unbind never auto-rebinds on restart')
  await testUnboundNeverAutoRebinds()
  console.log('Regression: activation single-flight and safe diagnostics')
  await testActivationAdmissionAndSafeDiagnostics()
  console.log('Regression: activation and settings backup')
  await testActivationAndSettingsBackup()
  console.log('Regression: server activation, offline grace and idempotent credits')
  await testServerActivationAndCredits()
  console.log('Regression: proxy wallet ledger and stale snapshot fallback')
  await testProxyWalletBridge()
  console.log('Regression: explicit zero server balance never reissues granted credits')
  await testExplicitZeroServerBalanceDoesNotReissueGrantedCredits()
  console.log('Regression: safe device unbind and original-code rebind')
  await testDeviceUnbindAndRebind()
  console.log('Regression: remote administrator unbind returns to activation')
  await testRemoteAdminUnbindReturnsToActivation()
  console.log('Regression: primary activation code remains unchanged after points recharge')
  await testPrimaryActivationAndRechargeCodeSeparation()
  console.log('Regression: encrypted multi-license history recovers only a server-valid primary')
  await testEncryptedMultiLicenseHistoryRecovery()
  console.log('Regression: strict License Protocol v2 contract and secure credential vault')
  await testLicenseProtocolV2StrictContract()
  console.log('Regression: update version comparison')
  testUpdateVersionComparison()
  console.log('Regression: signed update manifest')
  testUpdateManifestSignature()
  console.log('Regression: update config and SHA256 guard')
  await testUpdateConfigAndChecksum()
  console.log('Regression: lazy contact configuration and cache safety')
  await testContactConfigurationAndCache()
  console.log('Regression: managed model secret isolation')
  testManagedModelIsolation()
  console.log('Regression: fallback model safety boundaries')
  testModelFallbackSafety()
  await testModelFallbackSequence()
  console.log('Regression: main-process chat admission and request ownership')
  testChatAdmissionSecurity()
  console.log('Regression: closing during upload or analysis never waits on a renderer snapshot')
  testCloseDuringActiveWorkContract()
  console.log('Regression: repair-plan static safety and CI contracts')
  testRepairPlanStaticContracts()
  console.log('Regression: source invalidation')
  await testSourceInvalidation()
  console.log('Regression: reset save rollback')
  await testResetRollbackOnSaveFailure()
  console.log('Regression: new and restore previous analysis')
  await testNewAndRestorePreviousAnalysis()
  console.log('Regression: ZIP reset isolation')
  await testZipCannotReturnAfterReset()
  console.log('Regression: idle goal and late session isolation')
  await testIdleGoalAndLateSessionIsolation()
  console.log('Regression: report rollback')
  await testReportRollbackAndExportGuard()
  console.log('Regression: double export guard')
  await testDoubleExportGuard()
  console.log('Regression: feedback arriving during revision')
  await testFeedbackArrivingDuringRevision()
  console.log('Regression: strict model completion')
  await testStrictModelCompletion()
  console.log('Regression: real token usage measurement and privacy')
  await testTokenUsageMeasurement()
  console.log('Regression: cost optimization cache, preprocessing, prompt prefix and targeted revision')
  await testCostOptimizationPrimitives()
  console.log('Regression: CSV and ZIP guards')
  await testCsvAndArchiveGuards()
  console.log('Regression: file count guard')
  await testFileCountGuard()
  console.log('Regression: ZIP expansion global count guard')
  await testZipExpansionGlobalCountGuard()
  console.log('Regression: one source failure preserves in-flight work and pauses new files')
  await testSourceCleaningFailureIsolation()
  console.log('Regression: source cleaning reaches confirmation before paid summary work')
  await testCleaningCheckpointPrecedesSummary()
  console.log('Regression: parse failures cannot be silently omitted from a report')
  await testParseFailureBlocksGeneration()
  console.log('Regression: privacy endpoint guard')
  await testPrivacyMustMatchEndpoint()
  console.log('Regression: image header guards')
  await testImageHeaderGuards()
  console.log('Regression: bulk attribution and export open')
  await testBulkAttributionAndExportOpen()
  console.log('Regression: original export button contract')
  testExportButtonContract()
  console.log('Regression: optional one-click update contract')
  testOptionalOneClickUpdateContract()
  console.log('Regression: adaptive workbench topbar')
  await testWorkbenchTopbarContract()
  console.log('Regression: adaptive HTML report renderer')
  await testHtmlReportRenderer()
  console.log('Regression checks passed: persistence, restore, reset/session isolation, export guard, strict model completion, real token usage measurement and points billing, cost optimization cache/prompt/revision guards, CSV/TXT encoding, ZIP, image and file limits, adaptive offline HTML rendering.')
}

void app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await run()
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    if (topbarAuditWindow && !topbarAuditWindow.isDestroyed()) {
      topbarAuditWindow.destroy()
    }
    topbarAuditWindow = null
    for (let attempt = 0; attempt < 12 && existsSync(tempUserData); attempt++) {
      try {
        rmSync(tempUserData, { recursive: true, force: true })
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            /(?:EBUSY|EPERM|resource busy|operation not permitted)/i.test(error.message)
          )
        ) {
          console.error(error)
          exitCode = 1
          break
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100))
      }
    }
    if (existsSync(tempUserData)) {
      console.error(`Regression cleanup failed: ${tempUserData}`)
      exitCode = 1
    }
  }
  app.exit(exitCode)
})
