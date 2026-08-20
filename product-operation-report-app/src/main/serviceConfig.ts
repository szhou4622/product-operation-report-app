import { app } from 'electron'

export const LICENSE_APP_NAME = 'ProductOperationReport'
const allowDevelopmentOverrides = !app.isPackaged && process.env.PRODUCT_REPORT_ALLOW_DEV_OVERRIDES === '1'
const developmentLicenseBaseUrl =
  allowDevelopmentOverrides
    ? process.env.PRODUCT_REPORT_DEV_LICENSE_BASE_URL?.trim().replace(/\/+$/, '')
    : ''
export const LICENSE_BASE_URL = developmentLicenseBaseUrl || 'https://license.dadaozixun.com/api/license'
export const LICENSE_ACTIVATE_URL = `${LICENSE_BASE_URL}/activate`
export const LICENSE_DEVICE_UNBIND_URL = `${LICENSE_BASE_URL}/device/unbind`
export const LICENSE_DEVICE_STATUS_URL = `${LICENSE_BASE_URL}/device/status`

export const UPDATE_BASE_URL = 'https://update.dadaozixun.com'
export const UPDATE_LATEST_URL = `${UPDATE_BASE_URL}/api/update/latest`
export const CONTACT_CONFIG_URL = `${UPDATE_BASE_URL}/api/contact`

const developmentAiProxyBaseUrl =
  allowDevelopmentOverrides
    ? process.env.PRODUCT_REPORT_DEV_AI_PROXY_BASE_URL?.trim().replace(/\/+$/, '')
    : ''
export const AI_PROXY_BASE_URL = developmentAiProxyBaseUrl || 'https://api.dadaozixun.com/api/product-operation-report/v1'
export const AI_PROXY_SESSION_URL = `${AI_PROXY_BASE_URL}/session`
export const AI_PROXY_HEALTH_URL = `${AI_PROXY_BASE_URL}/health`

// 仅用于保留本地授权摘要和界面提示；离线状态不允许发起新的云端分析。
export const LICENSE_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000
export const NETWORK_TIMEOUT_MS = 12_000
