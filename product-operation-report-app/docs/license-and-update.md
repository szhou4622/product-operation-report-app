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

## 用户收到更新的方式

- 软件在授权恢复、界面初始化和隐私确认完成后自动检查一次更新。
- 有新版本时显示当前版本、最新版本、更新说明和“立即下载”。
- 非强制更新可以选择“稍后更新”；顶部版本按钮会继续显示“新版本”，点击即可重新打开。
- 用户也可以点击顶部的“v版本号 · 检查更新”手动检查。
- 强制更新没有“稍后更新”按钮，只有完成更新后才能继续使用。
- 下载失败、网络中断或 SHA256 不一致时不会启动安装程序，旧版本仍可继续使用。

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
   npm run test:update-release
   npm run build
   ```

3. 修改 `release-notes.txt`，每行填写一条给用户看的更新说明。
4. 通过现有 GitHub Actions 生成 Windows x64、macOS arm64、macOS x64 三个安装包。
5. 发布工具会自动计算三个文件的 SHA256，不需要手工填写。如果需要人工复核，可执行：

   ```powershell
   Get-FileHash -Algorithm SHA256 '.\Product-Operation-Report-Windows-版本-x64-Setup.exe'
   Get-FileHash -Algorithm SHA256 '.\Product-Operation-Report-macOS-版本-arm64.dmg'
   Get-FileHash -Algorithm SHA256 '.\Product-Operation-Report-macOS-版本-x64.dmg'
   ```

6. 更新服务读取服务器文件：

   `/opt/original-video-dedup-update/apps/ProductOperationReport/latest.json`

   总后台的“更新配置”页面目前是只读页，不能从网页提交。发布必须使用下方的 GitHub 自动流程或本机发布命令。

7. 客户端使用以下配置结构：

   ```json
   {
     "app_name": "ProductOperationReport",
    "version": "0.2.6",
    "min_supported_version": "0.2.5",
     "download_url": {
      "windows_x64": "https://update.dadaozixun.com/product-operation-report/releases/0.2.6/Product-Operation-Report-Windows-0.2.6-x64-Setup.exe",
      "mac_arm64": "https://update.dadaozixun.com/product-operation-report/releases/0.2.6/Product-Operation-Report-macOS-0.2.6-arm64.dmg",
      "mac_x64": "https://update.dadaozixun.com/product-operation-report/releases/0.2.6/Product-Operation-Report-macOS-0.2.6-x64.dmg"
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

8. 先保持 `force: false` 做三平台验证。只有旧版本存在无法继续使用的严重问题时才设为 `true`；也可通过提高 `min_supported_version` 触发强制更新。

如果更新接口对该 `app_name` 返回 404，客户端会安静地视为“暂无更新”，不会给用户显示报错。

## GitHub 自动发布到更新服务器

仓库的 `.github/workflows/build-desktop.yml` 已增加 `publish-update-server`。推送 `v*` 标签后，它会在三个安装包和 GitHub Release 全部成功后：

1. 核对版本与三个安装包文件名。
2. 计算 SHA256 并生成 `latest.json`。
3. 使用 SSH 密钥把三个安装包上传到独立目录。
4. 服务器再次核对 SHA256。
5. 原子替换 `ProductOperationReport/latest.json`。
6. 请求公网更新接口，确认 app_name 和版本正确。

需要在 GitHub 仓库配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Repository variable | `AUTO_PUBLISH_UPDATE_SERVER` | `true` 才启用自动发布 |
| Repository variable | `UPDATE_SERVER_PORT` | 默认可填 `22` |
| Repository variable | `PRODUCT_OPERATION_REPORT_MIN_SUPPORTED_VERSION` | 可空；例如 `0.2.5` |
| Repository variable | `FORCE_PRODUCT_OPERATION_REPORT_UPDATE` | 默认 `false` |
| Repository secret | `UPDATE_SERVER_HOST` | 更新服务器地址 |
| Repository secret | `UPDATE_SERVER_USER` | 建议使用专用发布用户 |
| Repository secret | `UPDATE_SERVER_SSH_PRIVATE_KEY` | 专用发布私钥，不能写入代码 |
| Repository secret | `UPDATE_SERVER_KNOWN_HOSTS` | 服务器 SSH host key 记录 |

未配置 `AUTO_PUBLISH_UPDATE_SERVER=true` 时，只构建安装包和 GitHub Release，不会修改更新服务器。

## Windows 本机手动发布

三个安装包已经放在 `dist` 后，可在项目目录执行：

```powershell
npm run update:publish -- -Version 0.2.7 -MinSupportedVersion 0.2.6
```

普通更新不要加 `-Force`。只有确实必须阻止旧版继续运行时才执行：

```powershell
npm run update:publish -- -Version 0.3.2 -MinSupportedVersion 0.3.2 -Force
```

本机发布会要求输入两次服务器密码：第一次上传，第二次校验并发布。密码不会写入脚本或日志。发布失败时不会替换线上 `latest.json`。
