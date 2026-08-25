# ProductOperationReport 业务代理（待部署包）

该包没有部署到服务器。它把 CCG API Key、请求预留、真实 Token 计价和每日费用上限移到 `127.0.0.1:8794`；授权服务器仍是余额、充值和最终扣费的唯一权威。公网只暴露：

- `POST /api/product-operation-report/v1/session`
- `GET /api/product-operation-report/v1/wallet`
- `POST /api/product-operation-report/v1/wallet/redeem`
- `POST /api/product-operation-report/v1/chat/completions`
- `GET /api/product-operation-report/v1/health`

部署前必须先让授权服务满足 [AUTHORIZATION_CONTRACT.md](AUTHORIZATION_CONTRACT.md)：返回严格布尔成功值、稳定 `code_id`、真实机器码、绑定状态、当前剩余积分和不可变 `code_role`。代理采用默认拒绝策略；后台生成的充值码必须标记为 `auto_topup`，主激活码与充值码不能混用，显式 `0` 积分不会回退到初始赠送值。

## 以后部署时的顺序

1. 备份授权数据库、Nginx 和现有服务。
2. 将本目录复制到服务器临时目录。
3. 执行 `sudo bash install.sh`（只安装，不启动）。
4. 编辑 `/etc/product-operation-report/proxy.env` 检查非敏感配置；模型 Key 使用下面的服务器密钥保险箱写入，不写进客户端、安装包或 GitHub。
5. 使用真实授权响应样本验证 `AUTHORIZATION_CONTRACT.md`，重点验证 `/device/status` 与 `/credits/consume`，再在回环地址测试 `/health`、`/session`、充值与扣费。
6. `install.sh` 会安装 Nginx 限流区和公共代理片段；将 `nginx-location.conf` 加入 `api.dadaozixun.com` 后执行 `nginx -t`。
7. `systemctl enable --now product-report-proxy`，再重载 Nginx。

不要把 `proxy.env`、`provider-keys.json`、CCG Key、会话令牌或数据库复制回客户端或 GitHub Actions。

## 模型 Key 无停机轮换

首次配置或更换 Key 时，在服务器执行（命令会隐藏输入，不把 Key 放进命令行历史或进程列表）：

```bash
sudo /usr/local/sbin/product-report-rotate-key set \
  --profile ccg-main \
  --key-id 2026-08-b \
  --base-url https://ccg-cli.online/v1 \
  --models gpt-5.5,gpt-5.6-sol,claude-sonnet-4-6,gemini-3-flash,kimi-k2.6 \
  --activate
```

脚本会先用新 Key 做一个极小的真实请求验证，通过后才原子写入。运行中的代理会在下一次请求自动读取新版本，不需要重启；已经开始的请求继续使用它启动时取得的旧 Key。旧 Key 会保留为备用，如果新 Key 在建连时返回 401/403，代理会在尚未向用户输出内容前自动尝试备用 Key。

查看配置只显示标识，不显示密钥：

```bash
sudo /usr/local/sbin/product-report-rotate-key status
```

需要回滚时，将旧标识重新设为活动 Key：

```bash
sudo /usr/local/sbin/product-report-rotate-key activate --profile ccg-main --key-id 2026-08-a
```

确认新 Key 稳定并等待至少 10 分钟（覆盖最长在途请求）后，再删除非活动旧 Key：

```bash
sudo /usr/local/sbin/product-report-rotate-key remove --profile ccg-main --key-id 2026-08-a
```

`provider-keys.json` 由服务账号独占读取，权限固定为 `0600`。文件损坏、写入中断或权限错误时，代理继续使用内存中的上一份有效配置，并在 `/health` 只报告安全的加载状态和备用数量，绝不返回 Key、Key 哈希或完整配置。

默认四个模型可共用同一线路；如果需要抵御单个供应商、账号、DNS 或密钥整体故障，应按 `proxy.env.example` 为备用模型配置独立 Base URL 和独立 Key。代理会校验上游返回的模型名；返回模型与请求不一致时按两者中更高的价格保守结算并保留审计信息。

代理每次创建会话和开始模型任务前都会用 `/device/status` 刷新授权服务器余额。模型返回有效内容后，代理使用本次实际模型请求唯一的 `request_id` 调用 `/credits/consume`；客户端传入的稳定 `billing_request_id` 只用于把自动重试和备用模型归到同一个逻辑任务。结算服务短暂不可用时保留预留并标记为待结算，下一次设备验证时仍用该次模型请求原来的 `request_id` 重试，确保同一笔金额只结算一次。

升级前已经因“同一逻辑 ID、不同金额”进入 `billing_pending` 的旧冲突记录不会再次扣费；代理会保留其供应商成本审计，标记为 `billing_conflict_released`，并只释放对应的预留积分。

代理重启时，尚未提交给上游的任务会释放预留；已经提交的任务会进入待结算状态，等设备重新连接后按同一任务 ID 完成保守结算，避免供应商已产生费用而客户端零扣费。

本地只读验证：`python -m unittest -v test_proxy.py`。
