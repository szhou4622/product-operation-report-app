import type { ActivationStatus } from '../shared/types'

function diagnosticState(status: ActivationStatus): string {
  if (status.activated && !status.requiresRevalidation) return status.unlimited ? '已激活（无限授权）' : '已激活'
  if (status.bindingStatus === 'unbound') return '已解绑，等待重新激活'
  if (status.offline) return '授权服务器暂时无法连接'
  if (status.activationCodeAvailable) return '原激活码已安全保存，等待重新验证'
  if (status.requiresRevalidation) return '需要重新验证'
  return '未激活'
}

/** Safe support text: deliberately excludes codes, ids, sessions and credentials. */
export function buildActivationDiagnostic(
  status: ActivationStatus,
  version: string,
  platformLabel: string,
  capturedAt = new Date().toISOString()
): string {
  return [
    '产品与内容经营报告系统 - 授权诊断',
    `软件版本：v${version}`,
    `运行平台：${platformLabel}`,
    `设备码：${status.deviceId.slice(0, 12).toUpperCase()}`,
    `授权状态：${diagnosticState(status)}`,
    `授权状态码：${status.authorizationState}`,
    `安全存储：${status.vaultStatus}`,
    `采集时间：${capturedAt}`
  ].join('\n')
}
