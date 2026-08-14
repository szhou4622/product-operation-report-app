# ProductOperationReport 业务代理（待部署包）

该包没有部署到服务器。它把 CCG API Key、积分余额、充值幂等、请求预留、Token 结算和每日费用上限移到 `127.0.0.1:8794`，公网只暴露：

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
4. 编辑 `/etc/product-operation-report/proxy.env`，只在服务器填写新轮换的 CCG Key。
5. 使用真实授权响应样本验证 `AUTHORIZATION_CONTRACT.md`，再在回环地址测试 `/health`、`/session`、充值与扣费。
6. `install.sh` 会安装 Nginx 限流区和公共代理片段；将 `nginx-location.conf` 加入 `api.dadaozixun.com` 后执行 `nginx -t`。
7. `systemctl enable --now product-report-proxy`，再重载 Nginx。

不要把 `proxy.env`、CCG Key、会话令牌或数据库复制回客户端或 GitHub Actions。

默认四个模型可共用同一线路；如果需要抵御单个供应商、账号、DNS 或密钥整体故障，应按 `proxy.env.example` 为备用模型配置独立 Base URL 和独立 Key。代理会校验上游返回的模型名；返回模型与请求不一致时按两者中更高的价格保守结算并保留审计信息。

代理重启时，尚未提交给上游的任务会释放预留；已经提交的任务会至少按输入估算保守结算，避免供应商已产生费用而客户端零扣费。

本地只读验证：`python -m unittest -v test_proxy.py`。
