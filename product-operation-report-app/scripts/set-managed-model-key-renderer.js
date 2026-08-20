const input = document.getElementById('api-key')
const status = document.getElementById('status')
const save = document.getElementById('save')
const cancel = document.getElementById('cancel')

window.managedKey.getPublicConfig().then((config) => {
  document.getElementById('service').textContent = `${config.name} · ${config.model}`
})

cancel.addEventListener('click', () => window.managedKey.close())
save.addEventListener('click', async () => {
  const apiKey = input.value.trim()
  if (!apiKey) {
    status.className = 'error'
    status.textContent = '请先粘贴完整 API Key。'
    input.focus()
    return
  }
  save.disabled = true
  cancel.disabled = true
  input.disabled = true
  status.className = 'busy'
  status.textContent = '正在测试连接，请稍候…'
  const result = await window.managedKey.save(apiKey).catch(() => ({
    ok: false,
    message: '操作没有完成，旧 Key 未改变。'
  }))
  input.value = ''
  status.className = result.ok ? 'ok' : 'error'
  status.textContent = result.message
  if (result.ok) {
    save.textContent = '已保存'
    cancel.textContent = '完成'
    cancel.disabled = false
  } else {
    save.disabled = false
    cancel.disabled = false
    input.disabled = false
    input.focus()
  }
})
