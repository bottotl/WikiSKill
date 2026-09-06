# WikiSkill

WikiSkill 是论文 Raw -> Wiki -> Skills 演化循环的独立复现。它可以脱离
jft0m 安装和运行，不导入或启动 jft0m 服务。

仓库自带 `fixtures/basic-flywheel/`，用于确定性验证完整产品流程。该
fixture 证明产品功能正常，不用于声称真实模型效果或复现论文统计结论。

## 环境要求

- Node.js 20 或更高版本
- Git
- 可选：已登录的 `claude` 或 `codex` CLI，用于真实 Provider 运行

## 安装与初始化

```sh
npm install
wikiskill init . --mode direct --dry-run --json
wikiskill init . --mode direct --json
wikiskill doctor --workspace . --json
```

`direct` 模式会在 `AGENTS.md` 中维护一个带标记的 WikiSkill 区块，并在
`CLAUDE.md` 中添加精简引用。若不能修改仓库说明文件，使用
`--mode zero-source-write`。

## 产品模型

WikiSkill 维护三层状态：

- `Raw`：不可变的执行轨迹、评分证据和失败诊断。
- `Wiki`：从训练轨迹中持续整理的模式、日志和 Skill 影响记录。
- `Skills`：当前生效的 Agent 程序知识，以及通过 validation gate 的候选。

一次 evolution 按以下顺序执行：

1. 用当前 Skills 运行完整 validation，得到 baseline。
2. 在 training split 上生成执行轨迹。
3. Wiki Maintainer 根据成功和失败轨迹增量更新 Wiki。
4. Skill Proposer 先选择至少 4 条 training trajectory，再读取正文。
5. Proposer 产生一个原子 Skill proposal。
6. 在完整 validation split 上评估 candidate。
7. 只有 `candidate score > best score` 才接受，否则回滚 Skills，保留 Wiki。
8. 循环结束后分别运行 frozen baseline 和 evolved Skills 的 test split。

Inference Agent 只接收当前 task、tools 和 Skills。系统不会把 Wiki、ground
truth 或其它 split 传给它。Maintainer 不能修改 Skills；Proposer 不能读取
validation/test evidence；scorer 不调用 Agent。

## Fixture 验收

```sh
npm run acceptance
```

`basic-flywheel` fixture 包含 4 个 training、2 个 validation 和 2 个 test
task。Proposer 不包含预写答案，而是从自己选择的 training traces 中读取
category，并与 training outcome 对齐，每轮只添加一条尚未知的映射。

期望结果：

```text
baseline validation = 0
iteration 1 candidate validation = 0.5 (accepted)
iteration 2 candidate validation = 1 (accepted)
baseline test = 0
evolved test = 1
testGain = 1
acceptedIterations = [1, 2]
```

验收还会执行 candidate diff、dry-run apply、apply 和 rollback，并确认 Wiki
跨两轮保留。输出中的 evidence class 固定为
`protocol-fixture-not-real-agent-evidence`。

## Dataset 合同

最短复现路径使用显式 `wikiskill.dataset.v1` 文件。每个 task 声明 split、
input、groundTruth 和 evaluator：

```json
{
  "schema": "wikiskill.dataset.v1",
  "domain": "example",
  "tasks": [
    {
      "id": "train-1",
      "split": "train",
      "input": { "instruction": "Return the transformed value", "value": "example" },
      "outputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["value"],
        "properties": { "value": { "type": "string" } }
      },
      "groundTruth": {
        "schema": "wikiskill.scorer.exact-output.v1",
        "expected": { "value": "expected prediction" }
      },
      "evaluator": { "capabilityRef": "builtin:exact-output-v1" }
    }
  ]
}
```

`groundTruth.expected` 必须与 Agent 的 `prediction` 具有相同 JSON 值和结构。
WikiSkill 只把 `input` 和 `outputSchema` 传给 Inference Agent；ground truth
只供 scorer 和 training outcome summary 使用。

执行：

```sh
wikiskill evolve --workspace . --target <skill-id> --dataset dataset.json --provider claude --model <model-id> --scorer builtin:exact-output-v1 --json-events
wikiskill status --workspace . --run <run-id> --json
```

使用 `--empty` 可以从空的 S0/W0 创建第一个 Skill。

## Coding Task

真实 build/test task 使用 `builtin:command-exit-v1`：

```json
{
  "groundTruth": {
    "schema": "wikiskill.scorer.command-exit.v1",
    "command": ["node", "--test", "value.test.cjs"],
    "timeoutMs": 120000,
    "allowedPaths": ["value.js"]
  },
  "evaluator": { "capabilityRef": "builtin:command-exit-v1" }
}
```

`command` 是参数数组，直接执行且不经过 shell。每个 task 使用临时 Git
checkout；Raw trajectory 保存 Provider tool events、Git status/diff 和
verifier command、退出码、stdout、stderr。评分完成并落盘 Raw 后会删除
临时 checkout，防止不同 split 互相读取残留环境。

## Candidate 发布

Evolution 不会直接修改 live Skill，而是生成候选：

```sh
wikiskill candidate diff --workspace . --candidate <id> --json
wikiskill candidate apply --workspace . --candidate <id> --dry-run --json
wikiskill candidate apply --workspace . --candidate <id> --json
wikiskill rollback --workspace . --receipt <receipt-id> --json
```

Apply 会检查 live Skill digest，只写 `.wikiskill/skills/<id>/`。Rollback 只
恢复 Skills，不回滚 Raw 或 Wiki。

## 公共命令

```text
init
doctor
uninstall
evolve
status
configure
candidate diff
candidate apply
rollback
```
