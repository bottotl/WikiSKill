# WikiSkill

WikiSkill 复现了论文中的 Raw -> Wiki -> Skills 演化循环：将 Agent 执行
经验整理为持久 Wiki，并通过验证门禁持续迭代 Skills。

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

### 演化输入合同

论文的演化算法将训练任务 `Dtrain`、验证任务 `Dval`、测试任务 `Dtest`、性能
度量 `R` 和迭代次数 `K` 作为运行循环的前提条件。Standalone CLI 要求调用方
显式提供这些输入：具体包括任务输入与环境、正确性判定所需的 ground truth 或
verifier、彼此独立的 train/val/test 划分，以及能反映目标质量的 scorer。

上层产品可以从多次独立任务轨迹和验证证据物化这些输入，再调用
`wikiskill experiment prepare` 和 `wikiskill evolve --experiment`。WikiSkill 的算法层不会自行
猜测、复制或补齐缺失的数据集和 scorer。

### 证据与演化分层

单次需求、事故或 commit 只适合积累 episode evidence：保留任务与环境、执行命令与结果、失败恢复过程，以及可能复用的程序假设。确定性缺陷直接进入普通代码修复。不要从一个 episode 改写出 train/validation/test 并据此声明 Skill 得到验证。

`dataset recommend-commit` 和 `dataset compile-commit` 只用于发现、整理历史工程材料。编译出的同源行为案例可用于检查 harness 和 scorer，不自动成为具有独立性的正式演化数据集。

只有积累了多个独立 episode，且能形成相互独立的 train/validation/test 与可观察 scorer 时，才进入 Skill evolution。论文复现还要求从空的 `(S0, W0)` 开始。`skills/wikiskill-evolution/SKILL.md` 提供对应的模式选择和结果判读表。

在这些前提就绪后，论文定义的单次演化循环不包含人工决策角色：Inference Agent
执行任务，Wiki Maintainer 更新 Wiki，Skill Proposer 提出修改，validation gate 根据
`R` 自动接受或回滚 Skill。论文没有规定人工逐轮审批候选或维护 Wiki；本项目的
`candidate diff`、`candidate apply` 和 `rollback` 是工程上的显式发布接口，不应视为
论文算法的人工步骤。

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

## 冻结 Skill 上下文

jft0m 等宿主可以在一次 Agent 会话开始前冻结当前 live Skills：

```sh
wikiskill context prepare --workspace <workspace> --json
wikiskill context skill-get --workspace <workspace> --context <context-id> --skill <skill-id> --json
wikiskill context receipt --workspace <workspace> --context <context-id> --skill <skill-id> --json
wikiskill context receipts --workspace <workspace> --context <context-id> --json
```

`prepare` 返回 Skill inventory、bundle digest 和两条可调用命令。`skill-get`
始终读取该 context 创建时的快照，即使 live Skill 随后发生变化；`receipt` 记录
本次 context 实际消费的 Skill revision；`receipts` 只读列出该 context 已记录的
消费凭据。Context 只服务会话注入，不允许读取
Wiki、candidate 或评测私有输入。

宿主需要把冻结上下文接入现有代码仓库时，可以只安装受管说明区块，而不在代码
仓库中创建第二份 `.wikiskill` 状态：

```sh
wikiskill bootstrap install --workspace <repo> --command "jft0m workspace harness prepare-context --repo . --json" --dry-run --json
wikiskill bootstrap install --workspace <repo> --command "jft0m workspace harness prepare-context --repo . --json" --json
wikiskill bootstrap uninstall --workspace <repo> --command "jft0m workspace harness prepare-context --repo . --json" --json
```

`install` 只维护 `AGENTS.md` 中带 marker 的区块和 `CLAUDE.md` 的
`@AGENTS.md` 引用。`uninstall` 发现受管区块被人工修改时会停止，避免覆盖用户
规则。

## 真实 Codex Demo

`examples/cli-config-evolution/` 提供一个真实 Codex 的 CLI 配置迁移实验。
它用 4 个 training、2 个 validation 和 2 个 test task 演化内置
`execctl-v2` Skill；所有可变状态和已应用候选保留在被忽略的 demo artifact
目录中，提交的 seed Skill 不会被修改。

```sh
npm run demo:check
npm run demo:live -- --model gpt-5.6-terra
```

真实运行会调用模型；当没有获得严格的 validation 和 test 提升时，命令会以
非零状态退出，但会保留完整证据供检查。

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
wikiskill experiment prepare --workspace . --target <skill-id> --dataset dataset.json --scorer builtin:exact-output-v1 --json > experiment.json
wikiskill evolve --experiment experiment.json --provider claude --model <model-id> --reasoning-effort low --tool-profile none --iterations 1 --max-provider-launches 24 --json-events
wikiskill status --workspace . --run <run-id> --json
```

`--iterations`、`--reasoning-effort`、`--tool-profile` 和 `--max-provider-launches` 都是冻结运行配置。K 接受正安全整数，不设 3 次的通用上限。`workspace` 允许 Inference Agent 修改独立任务工作区，`none` 不提供工具；内置 command-exit scorer 使用 `workspace`，exact-output scorer 使用 `none`。最坏情况 Provider 启动次数仅作预估，预算无需覆盖全部预估迭代；每次启动前记录并扣减实际启动次数，resume/fork 参数、配置漂移或预算耗尽会阻止该次启动。Provider 启动次数不等于模型 API 调用次数或费用。

当前采样次数是实验设置：command-exit 在训练任务不足 4 个时重复执行，以提供至少 4 条真实训练轨迹；内置其他运行路径采用每任务训练 2 次、评估 3 次。论文附录要求 Proposer 读取至少 4 条轨迹，并未规定这些重复次数或固定 4/2/2 划分。baseline validation 满分时按算法提前结束，不为凑轨迹启动训练。

`wikiskill dataset verify-known-fix` 是已有修复补丁的缺陷诊断命令，用于检查该补丁在指定任务上的 RED→GREEN 表现；它不是通用演化的启动条件。合法任务集与 scorer 可以在没有已知补丁时用于演化。

## Experiment Authoring Skill

The package includes `skills/wikiskill-evolution/SKILL.md` for designing,
auditing, running, and interpreting Skill-evolution experiments. Before an
expensive rollout, prepare one frozen experiment artifact:

```sh
wikiskill experiment prepare --workspace . --target <skill-id> --dataset dataset.json --scorer <scorer-ref> --json > experiment.json
wikiskill experiment audit --experiment experiment.json --json
```

Preparation owns dataset and scorer validation, context freezing, baseline
capture, and experiment audit. The stored artifact removes manual digest
plumbing while `evolve` still blocks authority drift. Task semantics, split
provenance, and task/fixture/scorer alignment require domain review. Audit a completed run with
`wikiskill run audit --run-root <run-root> --workspace <workspace> --json`
before candidate publication.

使用 `--empty` 可以从空的 active S0 创建第一个 Skill；若要复现论文的空 W0，需从新初始化且尚未积累模式的 Wiki 开始。
`experiment prepare` 将 workspace、dataset、target Skill 和 Wiki 基线收敛到一个
artifact；任一 authority 在准备后发生变化，都会在创建 evolution run 前被阻断。

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
evolution baseline
context prepare
context skill-get
context receipt
context receipts
experiment prepare
experiment audit
run audit
bootstrap install
bootstrap uninstall
dataset validate
dataset recommend-commit
dataset compile-commit
dataset verify-known-fix
candidate diff
candidate apply
rollback
```
