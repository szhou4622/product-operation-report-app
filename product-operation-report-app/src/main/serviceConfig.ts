export const LICENSE_APP_NAME = 'ProductOperationReport'
export const LICENSE_BASE_URL = 'https://license.dadaozixun.com/api/license'
export const LICENSE_ACTIVATE_URL = `${LICENSE_BASE_URL}/activate`

export const UPDATE_BASE_URL = 'https://update.dadaozixun.com'
export const UPDATE_LATEST_URL = `${UPDATE_BASE_URL}/api/update/latest`

// 服务器短时不可用时，已完成服务器验证的设备可继续离线使用 72 小时。
export const LICENSE_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000
export const NETWORK_TIMEOUT_MS = 12_000
