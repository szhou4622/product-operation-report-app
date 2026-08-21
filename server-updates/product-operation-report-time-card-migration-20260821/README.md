# ProductOperationReport 时间卡迁移包

本包只处理固定的 5 个 `ProductOperationReport` 时间卡，将每张原码原地转换为 2,000 积分。

默认命令全部只读。生产写入必须同时提供 `--apply`、操作人和固定确认短语。

## 固定批次

1. `unused`：3 张未使用卡。
2. `unbound`：1 张已解绑卡。
3. `active`：1 张激活中卡。

## 只读预检

```bash
python3 migrate_time_cards.py inspect
python3 migrate_time_cards.py verify
python3 patch_ops_admin.py inspect
```

## 正式执行（用户最终确认后才能运行）

每批单独执行并验证：

```bash
python3 migrate_time_cards.py apply --phase unused --apply \
  --operator EDY --confirmation MIGRATE-ProductOperationReport-TIME-TO-2000
python3 migrate_time_cards.py verify --phase unused
```

随后依次执行 `unbound`、`active`。最后再应用后台时间卡禁用补丁：

```bash
python3 patch_ops_admin.py apply --apply \
  --operator EDY --confirmation DISABLE-ProductOperationReport-TIME-CODES
```

## 回滚

迁移脚本会在每批写入前使用 SQLite Backup API 同时备份授权库和业务代理库。

只要迁移后尚无新的生成/消费记录，可按批次回滚：

```bash
python3 migrate_time_cards.py rollback --phase unused --apply \
  --operator EDY --confirmation ROLLBACK-ProductOperationReport-TIME-TO-2000
```

若迁移后已经发生消费，回滚脚本会拒绝执行，必须根据审计流水设计补偿，不能直接覆盖数据库。

## 审计

- 新建 `license_type_migrations` 表。
- 每张卡使用固定唯一 request_id：`por-time-migration-20260821-<code_id>`。
- 活跃/解绑卡写入 `credit_transactions.transaction_type=migration_opening_balance`。
- 审计记录包括操作人、原因、调整前后值、原授权摘要、执行时间和回滚状态。

禁止修改脚本中的 `APP_NAME`、固定 code_id 或目标积分后直接执行；任何规则变化必须重新 dry-run 和确认。

## 本地回归

```bash
python3 test_migration.py
```

该测试使用临时合成数据库覆盖三批 apply、verify 和逆序 rollback，不接触生产数据。
