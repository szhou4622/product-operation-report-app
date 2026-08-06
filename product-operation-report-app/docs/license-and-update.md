# 激活与自动更新发布说明

## 固定标识与服务地址

- `app_name`: `ProductOperationReport`
- 激活接口：`POST https://license.dadaozixun.com/api/license/activate`
- 更新接口：`GET https://update.dadaozixun.com/api/update/latest?app_name=ProductOperationReport`
- 当前版本：根目录 `package.json` 的 `version`

客户端不包含服务器密钥、AccessKey、SecretAccessKey 或第三方 API Key。服务器激活码仅按本机机器码加密后保存在本地授权文件中，用于启动时向激活接口重复校验。

## 本地文件

以下路径都以 Electron 的 `app.getPath('userData')` 为根目录：

- 授权：`activation.json`，自动保留 `activation.json.bak`
- 更新包：`updates/ProductOperationReport/<版本号>/<安装包>`

打包后的默认根目录通常是：

- Windows：`%APPDATA%\产品经营报告`
- macOS：`~/Library/Application Support/产品经营报告`

## 授权行为

- 启动时先读本地授权，界面可立即恢复；服务器复核在随后执行。
- 服务器短时不可用时，最近验证成功的授权可离线使用 72 小时。
- 服务器明确返回禁用、过期或机器码不匹配时，本机立即停止继续使用该授权。
- 服务器积分码按返回积分显示；每个新的分析会话仅在完整初稿首次生成成功后扣 1 分，失败、重试和报告修订不重复扣。
- 旧版 100 个 POR 激活码仍按永久授权兼容；服务器登记完成后，客户端会在启动时尝试把旧码迁移为服务器绑定授权。

## 发布新版本

1. 修改 `package.json` 和 `package-lock.json` 顶部的 `version`，两个值必须一致。
2. 运行类型检查、回归和生产构建：

   ```powershell
   npm run typecheck
   npm run test:regression
   npm run build
   ```

3. 通过现有 GitHub Actions 生成 Windows x64、macOS arm64、macOS x64 三个安装包。
4. 把三个安装包上传到用户可直接下载的 HTTPS 地址（可使用 GitHub Release 直链），不要经过业务服务器中转。
5. 分别计算 SHA256：

   ```powershell
   Get-FileHash -Algorithm SHA256 '.\Product-Operation-Report-Windows-版本-x64-Setup.exe'
   Get-FileHash -Algorithm SHA256 '.\Product-Operation-Report-macOS-版本-arm64.dmg'
   Get-FileHash -Algorithm SHA256 '.\Product-Operation-Report-macOS-版本-x64.dmg'
   ```

6. 在授权总后台为 `ProductOperationReport` 发布更新配置。客户端兼容以下结构：

   ```json
   {
     "app_name": "ProductOperationReport",
     "version": "0.3.1",
     "min_supported_version": "0.3.0",
     "download_url": {
       "windows_x64": "https://example.com/Product-Operation-Report-Windows-0.3.1-x64-Setup.exe",
       "mac_arm64": "https://example.com/Product-Operation-Report-macOS-0.3.1-arm64.dmg",
       "mac_x64": "https://example.com/Product-Operation-Report-macOS-0.3.1-x64.dmg"
     },
     "sha256": {
       "windows_x64": "64位小写或大写十六进制摘要",
       "mac_arm64": "64位小写或大写十六进制摘要",
       "mac_x64": "64位小写或大写十六进制摘要"
     },
     "notes": ["更新说明第一条", "更新说明第二条"],
     "force": false
   }
   ```

7. 先保持 `force: false` 做三平台验证。只有旧版本存在无法继续使用的严重问题时才设为 `true`；也可通过提高 `min_supported_version` 触发强制更新。

如果更新接口对该 `app_name` 返回 404，客户端会安静地视为“暂无更新”，不会给用户显示报错。
