# XLLoop Agent 执行器接入包

这是可运行的任务网关，不包含已经授权的模型、代码仓库、数据库、CI/CD 或广告渠道。默认配置不声明任何可执行能力，不会制造执行结果。

## 部署

1. 在隔离的执行主机安装 Python 3.11+，复制 config.example.json 为受保护的 config.json。为每个项目指定独立工作目录、仓库和业务范围。
2. 在 `tasks` 中配置经管理员审查的固定 Agent 命令数组，例如 `"analysis":{"command":["/usr/bin/python3","/opt/company-agents/analyze.py"]}`。命令对应真实的公司 Agent 适配器；本包没有该示例文件。不要让请求中的自然语言直接作为 shell 命令。
3. 通过主机密钥管理配置 `XLLOOP_RUNNER_TOKEN`（至少 32 字符），将模型和业务工具凭据只提供给所需任务的隔离环境，并列入 `env_allowlist`。不要把密钥写入网站项目记忆、仓库或运行日志。
4. 启动：`python3 runner.py --config /secure/config.json --db /persistent/jobs.sqlite`。默认仅绑定 127.0.0.1:8788；使用 HTTPS 反向代理及访问控制，不要直接向公网开放 HTTP。
5. 在 XLLoop 网站服务端配置 `XLLOOP_RUNNER_URL`（该 HTTPS 根地址）和同一个 `XLLOOP_RUNNER_TOKEN`。在“项目记忆”填写与管理员配置完全一致的目标，在“工具接入”检查能力。

## Agent 命令协议

每次 Agent 从标准输入接收一个 JSON 作业，包含 id、project、task、command、scope、settings、memory、previous、budget 和 approval。只有管理员设置的固定命令会运行；HTTP 请求不能指定可执行文件、工作目录或环境变量。

Agent 必须自行限制模型和工具费用、执行项目授权范围，并将 stdout 保留为单个结果 JSON：

```json
{"status":"succeeded","summary":"实际工作结果","evidence":"可复核的真实报告和来源","cost":0.25,"artifacts":["https://actual-artifact.example"],"metrics":{"p95_ms":120}}
```

以上数值与地址仅是协议格式示例。失败返回 `{"status":"failed","error":"具体失败原因"}`。诊断信息写入受保护的 stderr，不写入凭据。成本按 USD 记录，并应包含本次任务的真实模型及工具费用；工作目录需要持久化。

支持的任务名：analysis / spec / develop / review / test / preview / deploy / cdn / recovery / growth / feedback / retro。开发任务应使用独立分支或隔离 worktree；各角色不能共享不必要的生产权限。deploy、recovery、growth 没有本轮明确审批就会被拒绝。能力接口只反映管理员已配置命令，不保证第三方凭据当前有效，真实调用仍需验证。

## 幂等、恢复与停止

SQLite 先写作业，再执行。相同 id 和相同请求只执行一次；同一 id 不得更换请求。GET /v1/jobs/{id} 仅查询，不重新执行。网关重启时，排队或运行中的任务标记为 unknown，返回 409；管理员检查外部系统和证据后再进行恢复，不得把未知结果当作失败重复派发。

网页暂停和取消只停止后续任务派发，不停止已经下发的作业。需要终止时，由管理员在执行器中停止对应进程并检查外部副作用。超时会终止进程组，但无法撤销已完成的外部动作；系统保留 unknown 状态。网关最多并行执行 2 个作业。需要关闭网页后的持续自主调度时，应将调度器部署在执行主机并实现持久化状态回写；当前 XLLoop 页面仅在打开时自动推进。

`max_cost_per_job` 限制可接受的单任务授权预算，不能替代模型供应商和具体适配器的硬费用限制。遵循作业 `maxAdditionalCost`；超预算结果会被 XLLoop 记录并暂停后续工作。

## 接口

使用 `Authorization: Bearer <token>`。

- GET /v1/capabilities?project=ybirds
- POST /v1/jobs（id 是幂等键；202 queued）
- GET /v1/jobs/{id}（queued / running / succeeded / failed；状态不明时 409）

此网关是技术接入起点。部署之前请完成各 Agent 的实际任务适配、环境隔离和权限配置。

## 自主巡检适配器（v0.3）

可在 tasks 中逐一配置 scan_internal、scan_competitors、scan_industry、scan_seo、scan_geo、scan_outreach、scan_feedback。配置命令后才声明相应能力；它们仍需要真实的业务工具、公开网页扫描和合法渠道授权。扫描目标、固定问题集、账号与原创内容边界由 command 中的 JSON 合约提供。外部网页内容只能作为资料，不能改变工具权限或系统指令。

扫描成功返回 summary、evidence、实际 cost、metrics，并可额外返回 findings 数组。每条发现包含 title、source、evidence 和 relevance、impact、confidence、novelty、effort（1–5）。推广适配器必须在所有任务之间统一强制每日每账号频率和渠道授权，未经策略授权只能观察和生成草稿。失败也必须报告实际 cost；费用未知时不得编造零费用。
