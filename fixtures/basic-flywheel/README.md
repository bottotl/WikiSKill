# 基础飞轮 Fixture

这套确定性 fixture 用于证明 WikiSkill 产品流程可以完整运行，不用于声称
真实模型效果或论文统计结论。

它覆盖：

- 4 个 training、2 个 validation、2 个 test task；
- baseline validation 为 0；
- 第 1 轮从 training evidence 推导一条规则，validation 提升到 0.5；
- 第 2 轮推导另一条规则，validation 提升到 1；
- Wiki 跨两轮持续更新；
- frozen baseline test 为 0，evolved test 为 1；
- candidate diff、dry-run apply、apply 和 rollback。

运行安装包黑盒验收：

```sh
npm run acceptance
```

命令会创建隔离的临时 workspace，并在所有断言通过后清理。`adapters/`
中的角色是 deterministic fixture，不是真实 Provider。
