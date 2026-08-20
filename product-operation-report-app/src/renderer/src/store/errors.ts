export function friendlyError(value: unknown): string {
  const raw = (value instanceof Error ? value.message : String(value || '')).replace(/\s+/g, ' ').trim()
  if (!raw) return '操作没有完成，请重试。'
  if (/已停止|aborted|aborterror/i.test(raw)) return '已停止。'
  if (/enospc|no space left|磁盘空间不足|磁盘已满/i.test(raw)) {
    return '磁盘空间不足，无法保存文件。请清理空间或改存到其他磁盘后重试。'
  }
  if (/ebusy|resource busy|being used|另一个程序正在使用|文件.*占用/i.test(raw)) {
    return '文件正在被其他程序占用。请关闭同名的 Word 或浏览器文件后重试。'
  }
  if (/eperm|eacces|permission denied|access denied|operation not permitted|拒绝访问/i.test(raw)) {
    return '文件可能正在被占用，或保存位置没有权限。请关闭同名文件，或改存到桌面后重试。'
  }
  if (/enoent|path not found|找不到.*路径/i.test(raw)) {
    return '保存位置已不存在。请重新选择桌面或其他文件夹后重试。'
  }
  if (/enametoolong|filename.*too long|path.*too long|文件名.*过长|路径.*过长/i.test(raw)) {
    return '文件名或保存路径太长。请缩短文件名，或直接保存到桌面。'
  }
  if (/timeout|timed out|超时/i.test(raw)) return '请求超时，请检查网络后重试。'
  if (/401|unauthorized|invalid api key|authentication/i.test(raw)) return '模型服务授权失败，请联系软件管理员。'
  if (/404|model.*not found|not found.*model/i.test(raw)) return '模型地址或模型名称不正确，请到设置中检查。'
  if (/429|rate limit|quota|insufficient_quota/i.test(raw)) {
    const wait = raw.match(/等待\s*(\d+)\s*秒/)
    return wait ? `模型服务繁忙或额度受限，建议等待 ${wait[1]} 秒后重试。` : '模型服务繁忙或额度受限，请稍后重试。'
  }
  if (/fetch failed|econnreset|enotfound|terminated|network/i.test(raw)) {
    return '网络连接失败，请检查网络和模型地址后重试。'
  }
  return raw.slice(0, 280)
}
