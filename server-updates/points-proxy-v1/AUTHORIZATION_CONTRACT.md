# 授权服务返回契约（上线前置条件）

业务代理对授权响应采用“默认拒绝”。授权服务必须返回下面的字段；缺少、类型错误或不匹配时，业务代理不会创建会话或增加积分。

## 主激活码的设备状态

`GET /api/license/device/status` 成功响应至少包含：

```json
{
  "ok": true,
  "app_name": "ProductOperationReport",
  "code_id": "服务器生成且长期稳定的不可变编号",
  "code_role": "primary",
  "machine_code": "当前绑定机器码",
  "binding_status": "active",
  "remaining_credits": 0
}
```

- `ok` 必须是 JSON 布尔值 `true`，字符串 `"true"` 和数字 `1` 都不接受。
- `code_role` 只允许 `primary` 或兼容旧用户的 `legacy_manual`。当前 `/device/status` 由设备会话和设备凭证双重认证，迁移期允许该接口省略 `code_role`，代理仅在这条已认证路径中按 `primary` 处理；激活与充值响应仍必须显式返回角色。
- `binding_status` 只允许 `active` 或 `bound`。
- `app_name`、`code_id`、`machine_code` 必须存在并匹配，不能由客户端输入兜底。
- `remaining_credits` 即使为 `0` 也必须原样返回，不能回退为初始赠送积分。迁移期兼容旧顶层字段 `remaining_points`；两个字段同时存在时数值必须完全一致。
- 所有契约字段必须位于 JSON 顶层，且只使用上述 canonical 字段名。嵌套 `data/request/license`、旧别名或互相冲突的状态字段会被拒绝。
- 积分字段必须是真正的 JSON number；布尔值和数字字符串均不接受。

## 积分充值码激活

`POST /api/license/activate` 对充值码成功响应使用同样的必填身份字段，并且：

```json
{
  "ok": true,
  "app_name": "ProductOperationReport",
  "code_id": "充值码的稳定编号",
  "code_role": "auto_topup",
  "machine_code": "发起充值的机器码",
  "binding_status": "active",
  "remaining_credits": 100
}
```

授权后台必须把码的用途写成不可变字段：软件主码为 `primary`，旧授权为 `legacy_manual`，充值码为 `auto_topup`。不能仅依赖客户端或业务代理根据积分数量猜测用途。

在授权服务完成上述契约并用真实响应样本通过 `test_proxy.py` 前，不要启动或对公网暴露本代理。

## 真实用量扣费

模型任务成功产生有效内容后，业务代理调用：

```text
POST /api/license/credits/consume
Authorization: Bearer <device_session>
X-Device-Credential: <device_credential>
```

请求体包含固定 `app_name=ProductOperationReport`、本次真实积分 `amount`、功能标识 `reason`、稳定且不可重复扣费的 `request_id` 和 `client_version=proxy`。同一个逻辑任务的自动重试与备用模型必须使用同一个计费 ID。

成功响应至少包含：

```json
{
  "ok": true,
  "app_name": "ProductOperationReport",
  "code_id": "主授权的稳定编号",
  "remaining_credits": 80,
  "unlimited": false
}
```

- `remaining_credits` 是扣费后的服务器权威余额；代理只镜像该值，不再维护第二套可覆盖余额。
- `unlimited=true` 时接口仍需成功返回，但服务器不得扣减积分。
- 相同 `request_id` 重试必须返回同一结算结果，不能重复扣费。
- 失败、无内容的模型任务不调用该接口。
