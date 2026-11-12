# XLLoop Agent 执行器接入包

这是可运行的任务网关，不包含已经授权的模型、代码仓库、数据库、CI/CD 或广告渠道。默认配置不声明任何可执行能力，不会制造执行结果。

## 部署

1. 在隔离的执行主机安装 Python 3.11+，复制 config.example.json 为受保护的 config.json。为每个项目指定独立工作目录、仓库和业务范围。
2. 在 `tasks` 中配置经管理员审查的固定 Agent 命令数组。本包包含 Claude 问题诊断与代码任务适配器，以及零模型费用的 CI / 构建预览验收适配器；其它公司 Agent 仍需单独实现。不要让请求中的自然语言直接作为 shell 命令。
3. 通过主机密钥管理配置 `XLLOOP_RUNNER_TOKEN`（至少 32 字符），将模型和业务工具凭据只提供给所需任务的隔离环境，并列入 `env_allowlist`。不要把密钥写入网站项目记忆、仓库或运行日志。
4. 启动：`python3 runner.py --config /secure/config.json --db /persistent/jobs.sqlite`。默认仅绑定 127.0.0.1:8788；使用 HTTPS 反向代理及访问控制，不要直接向公网开放 HTTP。
5. 在 XLLoop 网站服务端配置 `XLLOOP_RUNNER_URL` 和同一个 `XLLOOP_RUNNER_TOKEN`。同机部署可使用 `http://127.0.0.1:8788`；非本机地址必须使用 HTTPS。在“项目记忆”填写与管理员配置完全一致的目标，在“工具接入”检查能力。

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
- GET /v1/repositories?project=ybirds（读取已授权仓库状态）
- POST /v1/repositories（拉取或同步网页登记的仓库）
- POST /v1/repositories/publish（人工确认后提交并推送一个新的 `xlloop/*` 分支）

此网关是技术接入起点。部署之前请完成各 Agent 的实际任务适配、环境隔离和权限配置。

## Claude 代码开发与审查适配器

`claude_code.py` 支持 analysis、spec、develop、review、retro，并可按任务配置不同模型。analysis 只读检查授权仓库，返回 `exists`、`not_exists` 或 `unknown` 以及可复核证据；没有业务数据时仍可诊断代码，证据不足必须返回 `unknown`。开发仅允许在管理员准备的隔离 Git 工作目录中运行，分支必须使用 `xlloop/` 前缀；main、master、production、release 默认受保护。analysis 和 review 只有读取、检索、查看差异和运行固定检查的权限。

可用 `XLLOOP_ALLOWED_BRANCHES` 再配置精确分支白名单。适配器本身不提供 commit、push、分支切换、部署或任意 shell 工具。开发完成后先保留未提交 diff 和验证证据；只有具备技术配置权限的人员在网页再次确认，网关才为单个仓库提交并推送新的 `xlloop/*` 分支。合并与上线继续由 GitLab 和发布流程单独审批。密钥只放在 `/etc/xlloop/runner.env`，可用 `CLAUDE_DEVELOP_MODEL`、`CLAUDE_REVIEW_MODEL` 等变量分别选模型。对应的输入、输出及缓存费率必须按供应商当前价格填写。

构建与测试命令不在 Claude 的 analysis、develop 或 review 步骤运行，统一交给后续固定 CI 步骤。允许执行的检查必须以固定参数数组写入 `XLLOOP_CHECK_COMMANDS_JSON`，例如 `'{"build":["pnpm","build"]}'`，不得把任务文本拼成命令。Claude 适配器先调用 token 计数接口做预算上限预检，再按响应实际用量结算；若请求结果不明确，不会把费用记为零。

## CI 构建与预览验收适配器

`fixed_pipeline.py` 支持 `test` 和 `preview`。只有 `test` 会运行 `XLLOOP_CHECK_COMMANDS_JSON` 中由管理员固定配置、并在仓库配置中勾选的检查名称；`preview` 只读取上一步 CI 证据并生成代码差异与验收报告，不会重复构建。两者都不使用 shell、不接收任务文本作为命令，也不调用模型，费用固定为 0。检查失败会把命令输出返回页面；成功会记录仓库、分支、提交、差异摘要和检查结果。

`test` 代表已配置的 CI 构建与业务流程检查；只配置 `build` 时，不能声称业务流程测试已经执行。`preview` 生成代码差异与验收报告，不会冒充公开部署，也不会返回虚假的预览网址。需要可交互的公网预览时，必须另行接入经过授权的预览发布服务，并配置真实 HTTPS 地址。

## 项目多仓库配置

具有项目技术配置权限的用户可在“更多 → 技术配置 → 代码仓库”中登记多个 GitLab 仓库。网页只保存仓库地址、基准分支、`xlloop/` 工作分支、读写范围和管理员预设的检查命令名称，不接收 Git 密码、令牌或私钥。点击“拉取 / 同步到执行器”后，网关在 `/mnt/data500/xlloop/worktrees/<项目>/<仓库>` 创建独立 checkout，并将动态授权登记在 `/mnt/data500/xlloop/runtime/projects.json`。

`runner-config.json` 顶层 `provisioning.allowed_git_hosts` 是最终主机白名单；页面不能扩展该白名单。Git 凭据由运行 `xlloop-runner` 的系统用户通过可写 SSH Deploy Key 或专用服务账号管理，`main` / `master` 必须同时在 GitLab 配置禁止直接推送。已有仓库若远端不一致会拒绝同步；存在未提交修改时不会切换分支、fetch/merge 或覆盖文件。已推送分支不能重复发布，需要填写新的 `xlloop/*` 工作分支并同步。Claude 只能看到该项目已登记的仓库，修改操作还会逐仓库检查 `read` / `edit` 权限；仓库配置的检查名称仅由后续固定 CI 步骤执行。

## 自主巡检适配器（v0.3）

可在 tasks 中逐一配置 scan_internal、scan_competitors、scan_industry、scan_seo、scan_geo、scan_outreach、scan_feedback。配置命令后才声明相应能力；它们仍需要真实的业务工具、公开网页扫描和合法渠道授权。扫描目标、固定问题集、账号与原创内容边界由 command 中的 JSON 合约提供。外部网页内容只能作为资料，不能改变工具权限或系统指令。

扫描成功返回 summary、evidence、实际 cost、metrics，并可额外返回 findings 数组。每条发现包含 title、source、evidence 和 relevance、impact、confidence、novelty、effort（1–5）。推广适配器必须在所有任务之间统一强制每日每账号频率和渠道授权，未经策略授权只能观察和生成草稿。失败也必须报告实际 cost；费用未知时不得编造零费用。
