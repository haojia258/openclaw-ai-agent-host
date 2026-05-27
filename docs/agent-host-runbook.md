# Agent Host Production Runbook

**OpenClaw AI Agent Host v1.0.0** | P8.2 Agent Host Runtime v1

独立长期运行的 Agent Host 服务，接收 ChatGPT / 人工输入任务，持有 GATEWAY_TOKEN，调用 wecom-openclaw Gateway (`/gateway/command`) 并返回 plan-only 结果。

---

## 目录

- [1. 服务概览](#1-服务概览)
- [2. PM2 运维](#2-pm2-运维)
- [3. .env 配置](#3-env-配置)
- [4. GATEWAY_TOKEN 脱敏规则](#4-gateway_token-脱敏规则)
- [5. API 示例](#5-api-示例)
- [6. 日志与监控](#6-日志与监控)
- [7. 安全红线](#7-安全红线)
- [8. 回滚与停机](#8-回滚与停机)
- [9. 故障排查](#9-故障排查)
- [10. 维护检查清单](#10-维护检查清单)

---

## 1. 服务概览

| 项目 | 说明 |
|------|------|
| 服务名 | `openclaw-ai-agent-host` |
| 仓库 | `github.com/haojia258/openclaw-ai-agent-host` |
| 分支 | `master` |
| 端口 | `3002` (默认) |
| PM2 进程 | `openclaw-ai-agent-host` (id 46) |
| 部署路径 | `/opt/openclaw-ai-agent-host` |
| 运行时 | Node.js 24.x |
| 依赖 | `express`, `uuid` |

### 架构

```
ChatGPT / 人工输入
       │
       ▼
┌──────────────────────────┐
│ Agent Host  :3002        │  ← 本服务
│ POST /tasks              │     持有 GATEWAY_TOKEN
│ GET  /tasks/:id          │     不持有 BRIDGE_TOKEN
│ GET  /health             │
│ GET  /tasks              │
└──────┬───────────────────┘
       │ GATEWAY_TOKEN
       ▼
┌──────────────────────────┐
│ wecom-openclaw :3001     │
│ POST /gateway/command    │
└──────┬───────────────────┘
       │ BRIDGE_TOKEN (server-side 注入)
       ▼
┌──────────────────────────┐
│ Commander Runtime        │
│ → DAG Plan (plan-only)   │
└──────────────────────────┘
```

### 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/tasks` | 接收任务，验证策略，转发到 Gateway |
| `GET` | `/tasks/:id` | 查询单个任务结果 |
| `GET` | `/tasks` | 列出最近任务（默认 50 条） |
| `GET` | `/health` | 健康检查 |

---

## 2. PM2 运维

### 2.1 首次注册

```bash
cd /opt/openclaw-ai-agent-host
pm2 start src/server.js --name openclaw-ai-agent-host
pm2 save
```

### 2.2 启动

```bash
pm2 start openclaw-ai-agent-host
```

### 2.3 重启

```bash
# 常规重启
pm2 restart openclaw-ai-agent-host

# 重启并重载 .env 环境变量（修改 .env 后必须使用）
pm2 restart openclaw-ai-agent-host --update-env
```

> **⚠️ 关键**: 修改 `.env` 后必须使用 `--update-env` 标志。普通 `pm2 restart` 不会重载环境变量，会导致 `GATEWAY_TOKEN` 等配置失效。

### 2.4 停止

```bash
pm2 stop openclaw-ai-agent-host
```

### 2.5 查看状态

```bash
pm2 status openclaw-ai-agent-host
pm2 logs openclaw-ai-agent-host --lines 50
pm2 info openclaw-ai-agent-host
```

### 2.6 保存 PM2 配置（重启服务器后自动恢复）

```bash
pm2 save
```

### 2.7 部署后检查命令

```bash
# 完整部署后检查
pm2 status openclaw-ai-agent-host          # 确认 online, unstable_restarts=0
curl -s http://localhost:3002/health | jq   # 确认 {"status":"ok",...}
tail -5 logs/host-audit.log | jq           # 确认审计日志正常
```

---

## 3. .env 配置

### 3.1 配置模板

基于 `.env.example` 创建 `.env`：

```ini
# Server
PORT=3002
HOST=0.0.0.0

# Gateway connection (required)
GATEWAY_URL=http://localhost:3001
GATEWAY_TOKEN=oc_gateway_prod_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Retry
MAX_RETRIES=3
RETRY_DELAY_MS=1000

# Audit
AUDIT_LOG_PATH=./logs/host-audit.log

# Execution mode (plan-only forever, do not change)
EXECUTION_MODE=plan-only
```

### 3.2 环境变量说明

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `GATEWAY_URL` | **是** | `http://localhost:3001` | wecom-openclaw Gateway 地址 |
| `GATEWAY_TOKEN` | **是** | — | Gateway 认证 Token（脱敏处理，见 §4） |
| `PORT` | 否 | `3002` | 服务端口 |
| `HOST` | 否 | `0.0.0.0` | 绑定地址 |
| `MAX_RETRIES` | 否 | `3` | Gateway 调用失败最大重试次数 |
| `RETRY_DELAY_MS` | 否 | `1000` | 重试间隔（毫秒） |
| `AUDIT_LOG_PATH` | 否 | `./logs/host-audit.log` | 审计日志路径 |
| `EXECUTION_MODE` | 否 | `plan-only` | 执行模式（**不可更改**） |

### 3.3 配置变更流程

```bash
# 1. 编辑 .env 文件
vim /opt/openclaw-ai-agent-host/.env

# 2. 必须使用 --update-env 重载
pm2 restart openclaw-ai-agent-host --update-env

# 3. 验证配置生效
curl -s http://localhost:3002/health | jq .status
# 预期: "ok"
```

---

## 4. GATEWAY_TOKEN 脱敏规则

### 4.1 Token 格式

```
格式: oc_gateway_prod_v1_<32位十六进制字符>
示例: oc_gateway_prod_v1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
```

### 4.2 脱敏规则

| 场景 | 显示形式 | 规则 |
|------|----------|------|
| 生产 .env 文件 | 完整值 | 仅文件所有者可读（`chmod 600`） |
| 审计日志 | 不出现 | `sanitizeBody()` 自动替换为 `***REDACTED***` |
| 终端输出 | `oc_gateway_***` | 仅显示前 16 个字符 |
| 文档/代码 | `oc_gateway_prod_v1_***_DO_NOT_COMMIT` | 占位符 |
| Git 仓库 | 不出现 | `.gitignore` 排除 `.env` |

### 4.3 审计日志脱敏实现

```js
// src/audit-log.js — sanitizeBody()
const sensitiveKeys = [
  'token', 'gatewayToken', 'gateway_token', 'GATEWAY_TOKEN',
  'bridgeToken', 'bridge_token', 'BRIDGE_TOKEN',
  'authorization', 'Authorization',
  'password', 'secret', 'apiKey', 'api_key'
];

// 所有匹配字段自动替换为 '***REDACTED***'
```

### 4.4 Token 隔离原则

| Token | 持有服务 | 说明 |
|-------|----------|------|
| `GATEWAY_TOKEN` | Agent Host | 认证到 Gateway |
| `BRIDGE_TOKEN` | wecom-openclaw (server-side) | Gateway → Bridge 内部调用 |

> **Agent Host 不持有 BRIDGE_TOKEN**。这是设计上的隔离 — 即使 Agent Host 被攻破，攻击者也无法绕过 Gateway 直接调用 Bridge。

---

## 5. API 示例

### 5.1 Health Check

```bash
curl -s http://localhost:3002/health | jq
```

响应：
```json
{
  "status": "ok",
  "service": "openclaw-ai-agent-host",
  "version": "v1.0.0",
  "startedAt": "2026-05-27T08:49:00.000Z",
  "uptimeSeconds": 3600,
  "taskCount": 15,
  "memoryMB": 42,
  "hostname": "VM-24-120"
}
```

### 5.2 发送任务 — cURL

```bash
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: my_trace_001" \
  -d '{
    "command": "/总控 提升GMV",
    "mode": "plan-only"
  }' | jq
```

成功响应：
```json
{
  "taskId": "host_1779853513187_64537fed",
  "status": "completed",
  "command": "/总控 提升GMV",
  "mode": "plan-only",
  "correlationId": "my_trace_001",
  "attempts": 1,
  "gatewayRequestId": "gw_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "result": {
    "success": true,
    "output": "[Commander Runtime] 目标: 提升GMV\nDAG: codex→deepseek→workbuddy→doubao"
  }
}
```

### 5.3 发送任务 — Node.js

```js
const http = require('http');

const payload = JSON.stringify({
  command: '/总控 提升GMV',
  mode: 'plan-only',
});

const req = http.request({
  hostname: 'localhost',
  port: 3002,
  path: '/tasks',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Correlation-ID': 'node_sdk_001',
    'Content-Length': Buffer.byteLength(payload),
  },
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const result = JSON.parse(data);
    console.log(`Task ${result.taskId}: ${result.status}`);
    console.log(`Attempts: ${result.attempts}`);
    console.log('Result:', JSON.stringify(result.result, null, 2));
  });
});

req.on('error', (err) => console.error('Error:', err.message));
req.write(payload);
req.end();
```

### 5.4 发送任务 — Python

```python
import requests
import json

response = requests.post(
    'http://localhost:3002/tasks',
    json={
        'command': '/总控 提升GMV',
        'mode': 'plan-only',
    },
    headers={'X-Correlation-ID': 'python_sdk_001'},
    timeout=60,
)

result = response.json()
print(f"Task {result['taskId']}: {result['status']}")
print(f"Attempts: {result['attempts']}")
print(f"Result: {json.dumps(result['result'], indent=2, ensure_ascii=False)}")
```

### 5.5 查询任务

```bash
# 查询单个任务
curl -s http://localhost:3002/tasks/host_1779853513187_64537fed | jq

# 列出所有任务
curl -s http://localhost:3002/tasks | jq '.tasks[:3]'

# 列出最近 10 条
curl -s "http://localhost:3002/tasks?limit=10" | jq '.tasks'
```

### 5.6 预期错误码

| 状态码 | 错误类型 | 含义 |
|--------|----------|------|
| `200` | — | 任务成功完成 |
| `400` | `BAD_REQUEST` | 缺少 `command` 字段 |
| `403` | `FORBIDDEN` | 命令/模式被策略禁止 |
| `404` | `NOT_FOUND` | 任务 ID 不存在 |
| `502` | — | Gateway 不可达（重试耗尽） |

---

## 6. 日志与监控

### 6.1 审计日志 (host-audit.log)

**路径**: `/opt/openclaw-ai-agent-host/logs/host-audit.log`

**格式**: JSONL（每行一条 JSON 记录）

**事件类型**:

| 事件 | 说明 |
|------|------|
| `TASK_RECEIVED` | 任务通过策略验证，即将调用 Gateway |
| `GATEWAY_CALL` | 开始调用 Gateway |
| `RETRY` | Gateway 调用失败，准备重试 |
| `TASK_COMPLETED` | Gateway 返回成功，任务完成 |
| `TASK_FAILED` | Gateway 调用最终失败 |
| `TASK_REJECTED` | 任务未通过策略验证 |

**示例记录**:
```json
{
  "timestamp": "2026-05-27T08:49:58.123Z",
  "event": "TASK_COMPLETED",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "taskId": "host_1779853513187_64537fed",
  "meta": {
    "statusCode": 200,
    "attempts": 1,
    "gatewayRequestId": "gw_a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

### 6.2 查看日志

```bash
# 查看最近 20 条审计日志
tail -20 /opt/openclaw-ai-agent-host/logs/host-audit.log | jq .

# 查看失败任务
grep '"TASK_FAILED"' /opt/openclaw-ai-agent-host/logs/host-audit.log | jq .

# 查看指定 taskId 的完整生命周期
grep '64537fed' /opt/openclaw-ai-agent-host/logs/host-audit.log | jq -c '{event, attempt: .meta.attempts, error: .meta.error}'

# 查看被拒绝的命令
grep '"TASK_REJECTED"' /opt/openclaw-ai-agent-host/logs/host-audit.log | jq '.meta'
```

### 6.3 Gateway 侧日志

Agent Host 调用的 Gateway 审计日志位于 wecom-openclaw 侧：

```bash
# Gateway 审计日志
tail -20 /opt/wecom-openclaw/logs/gateway-audit.log | jq .

# Bridge 任务日志
tail -5 /opt/wecom-openclaw/logs/tasks/bridge-$(date +%Y-%m-%d).jsonl | jq .
```

### 6.4 PM2 日志

```bash
# 实时日志
pm2 logs openclaw-ai-agent-host

# 最近 100 行
pm2 logs openclaw-ai-agent-host --lines 100

# 仅错误
pm2 logs openclaw-ai-agent-host --err
```

### 6.5 日志轮转

```bash
# 审计日志建议手动轮转（按日期归档）
cp logs/host-audit.log "logs/archive/host-audit-$(date +%Y%m%d).log"
> logs/host-audit.log

# 保留最近 30 天
find logs/archive/ -name 'host-audit-*.log' -mtime +30 -delete
```

---

## 7. 安全红线

### 7.1 禁止 live execution

Agent Host **永久禁止** live/dry-run/execute 模式。

```js
// src/policy.js — 仅允许 plan-only
const ALLOWED_MODES = ['plan-only'];
const FORBIDDEN_MODES = ['dry-run', 'live', 'execute'];
```

- `sanitizeTask()` 强制将所有 mode 输入改写为 `plan-only`
- 任何传 `live`、`dry-run`、`execute` 的请求返回 `403 FORBIDDEN`
- 此限制无法通过配置绕过

### 7.2 禁止 production deploy

以下命令**永久禁止**，无法通过 Agent Host 执行：

| 类别 | 命令 |
|------|------|
| 部署 | `/deploy`, `confirm:deploy` |
| 服务重启 | `/restart`, `confirm:restart` |
| 代码合并 | `/merge`, `confirm:merge` |
| 回滚 | `/rollback`, `confirm:rollback` |
| Nginx | `/nginx` |
| 特权操作 | `/sudo`, `/exec`, `/shell`, `/bash`, `/sh`, `/rm` |
| 通用 confirm | 所有 `confirm:*` 前缀的命令 |
| 未知斜杠命令 | 所有 `/` 开头但不在白名单的命令 |

### 7.3 命令白名单

仅以下命令被允许：

| 命令 | 中文名称 | 说明 |
|------|----------|------|
| `/总控` | Commander | 启动 Commander Runtime |
| `/目标` | Goal | 设置/查看目标 |
| `/状态` | Status | 查看系统状态 |
| `/进度` | Progress | 查看任务进度 |
| `/帮助` | Help | 查看帮助 |
| `/commander` | Commander (EN) | Commander Runtime 英文入口 |
| `/总控台` | Commander Console | 总控台 |
| `/任务列表` | Task List | 任务列表 |
| `/help` | Help (EN) | 英文帮助 |
| `/status` | Status (EN) | 英文状态 |
| `/target` | Target (EN) | 英文目标 |
| `/progress` | Progress (EN) | 英文进度 |

### 7.4 Token 安全

- Agent Host **仅持有** `GATEWAY_TOKEN`，**不持有** `BRIDGE_TOKEN`
- 审计日志永不出现完整 Token（`sanitizeBody()` 自动脱敏）
- `.env` 文件权限 `600`（仅所有者可读写）

### 7.5 Correlation ID

- 每个请求自动生成或接受传入的 `X-Correlation-ID`
- 在所有响应头中返回
- Gateway 调用时携带，实现全链路追踪
- 格式: `host_<uuid>`（自动生成）或自定义

---

## 8. 回滚与停机

### 8.1 紧急停机

```bash
# 立即停止 Agent Host（不影响 Gateway/Bridge）
pm2 stop openclaw-ai-agent-host

# 验证停止
pm2 status openclaw-ai-agent-host
# 预期: status = stopped
```

> 停机 Agent Host 不影响 wecom-openclaw（Gateway/Bridge/Commander）正常运行。
> Gateway `/gateway/command` 和 Bridge `/runtime/command` 保持可用。

### 8.2 回滚到上一版本

```bash
# 1. 停止服务
pm2 stop openclaw-ai-agent-host

# 2. 回滚代码
cd /opt/openclaw-ai-agent-host
git log --oneline -5              # 找到要回滚到的 commit
git reset --hard <rollback-commit>

# 3. 重启
pm2 start openclaw-ai-agent-host --update-env

# 4. 验证
curl -s http://localhost:3002/health | jq
pm2 status openclaw-ai-agent-host
```

### 8.3 完全删除

```bash
pm2 delete openclaw-ai-agent-host
pm2 save
# 可选: rm -rf /opt/openclaw-ai-agent-host
```

---

## 9. 故障排查

### 9.1 GATEWAY_TOKEN not configured

**症状**:
```
Error: GATEWAY_TOKEN not configured in environment
```
或 PM2 日志中持续报错。

**原因**: `.env` 中 `GATEWAY_TOKEN` 未设置或在 PM2 重启时未使用 `--update-env`。

**排查步骤**:

```bash
# 1. 确认 .env 文件存在且有 GATEWAY_TOKEN
cat /opt/openclaw-ai-agent-host/.env | grep GATEWAY_TOKEN

# 2. 确认 PM2 环境变量中已加载
pm2 env 46 | grep GATEWAY_TOKEN
# 预期: GATEWAY_TOKEN=oc_gateway_prod_v1_***

# 3. 如果缺失，使用 --update-env 重启
pm2 restart openclaw-ai-agent-host --update-env

# 4. 验证
curl -s http://localhost:3002/health | jq .status
# 预期: "ok"
```

### 9.2 403 policy denied

**症状**:
```json
{
  "error": "FORBIDDEN",
  "message": "命令 \"/deploy\" 被策略禁止",
  "correlationId": "host_xxx"
}
```

**原因**: 发送的命令在白名单之外或被明确禁止。

**排查步骤**:

```bash
# 1. 检查发送的命令是否是白名单命令
# 允许: /总控 /目标 /状态 /进度 /帮助 /commander /总控台 /任务列表 /help /status /target /progress

# 2. 检查 mode 是否为 plan-only
# 仅允许: plan-only（需要显式传入）

# 3. 查看被拒绝的记录
grep 'TASK_REJECTED' logs/host-audit.log | tail -5 | jq '.meta'
```

### 9.3 Gateway timeout

**症状**:
```
Gateway request timeout (30s)
```
或 `502` 响应 + `attempts > 1`。

**原因**:
1. wecom-openclaw Gateway 未运行
2. Gateway 处理超时（> 30s）
3. 网络不通

**排查步骤**:

```bash
# 1. 确认 Gateway 正在运行
curl -s http://localhost:3001/health | jq
# 预期: {"status":"ok","port":"3001",...}

# 2. 确认 PM2 状态
pm2 status wecom-adapter

# 3. 如果是 Gateway 未启动
pm2 start wecom-adapter

# 4. 检查网络连通性
curl -v -X POST http://localhost:3001/gateway/command \
  -H "Content-Type: application/json" \
  -H "Gateway-Token: $(grep GATEWAY_TOKEN /opt/openclaw-ai-agent-host/.env | cut -d= -f2)" \
  -d '{"requestId":"diag","timestamp":'$(date +%s%3N)',"command":"/状态","mode":"plan-only","user":"admin","source":"diagnostic"}'
```

### 9.4 Commander no response

**症状**:
- 任务状态 `completed`，但 `result.output` 为空或异常。
- Gateway 返回 200 但 Commander Runtime 未正常输出。

**原因**:
1. Commander Runtime 内部错误
2. 目标描述不够清晰
3. wecom-openclaw 进程异常

**排查步骤**:

```bash
# 1. 通过 Agent Host 发送诊断命令
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command":"/状态","mode":"plan-only"}' | jq .result

# 2. 直接调用 Gateway 排查
curl -s -X POST http://localhost:3001/gateway/command \
  -H "Content-Type: application/json" \
  -H "Gateway-Token: <token>" \
  -d '{
    "requestId": "diag_direct",
    "timestamp": <unix_ms>,
    "command": "/状态",
    "mode": "plan-only",
    "user": "admin",
    "source": "diagnostic"
  }' | jq

# 3. 查看 Gateway 审计日志
tail -20 /opt/wecom-openclaw/logs/gateway-audit.log | jq .

# 4. 查看 Bridge 日志
tail -20 /opt/wecom-openclaw/logs/tasks/bridge-$(date +%Y-%m-%d).jsonl | jq .

# 5. 重启 wecom-openclaw（如果确认挂死）
pm2 restart wecom-adapter --update-env
```

### 9.5 服务端口被占用

**症状**: PM2 反复 crash-restart，日志含 `EADDRINUSE`。

**排查**:
```bash
# 找到占用 3002 端口的进程
sudo fuser 3002/tcp
sudo lsof -i :3002

# 强制释放端口
sudo fuser -k 3002/tcp

# 重启
pm2 restart openclaw-ai-agent-host
```

### 9.6 目录权限问题

**症状**: 审计日志写入失败、`EACCES` 错误。

**修复**:
```bash
# 确保项目目录属于 ubuntu
sudo chown -R ubuntu:ubuntu /opt/openclaw-ai-agent-host

# 确保 logs 目录可写
mkdir -p /opt/openclaw-ai-agent-host/logs
chmod 755 /opt/openclaw-ai-agent-host/logs
```

---

## 10. 维护检查清单

### 每日检查

- [ ] `pm2 status openclaw-ai-agent-host` → status: online, unstable_restarts: 0
- [ ] `curl -s http://localhost:3002/health | jq .status` → "ok"
- [ ] `tail -5 logs/host-audit.log | jq` → 最后几条日志正常
- [ ] `df -h /opt` → 磁盘空间充足

### 升级检查

- [ ] `npm test` 全部通过（79/79）
- [ ] `git pull --ff-only` → 无冲突
- [ ] `pm2 restart openclaw-ai-agent-host --update-env` → 正常重启
- [ ] Health endpoint 正常
- [ ] 发送测试任务 `/状态` → 返回正常
- [ ] 审计日志写入正常
- [ ] 危险命令测试（发送 `/deploy` → 403）确认策略生效

### 安全审计

- [ ] `.env` 权限为 `600`
- [ ] 审计日志不含完整 Token
- [ ] `GATEWAY_TOKEN` 格式正确（`oc_gateway_prod_v1_<32hex>`）
- [ ] `.gitignore` 包含 `.env`
- [ ] `npm audit` 无高危漏洞
