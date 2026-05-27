# Agent Host Security Policy

**OpenClaw AI Agent Host v1.0.0** | 安全策略文档

---

## 目录

- [1. 安全架构](#1-安全架构)
- [2. 认证与 Token 管理](#2-认证与-token-管理)
- [3. 命令安全策略](#3-命令安全策略)
- [4. 执行模式策略](#4-执行模式策略)
- [5. Audit Log 安全](#5-audit-log-安全)
- [6. AI Agent 策略](#6-ai-agent-策略)
- [7. 安全红线](#7-安全红线)
- [8. 安全测试矩阵](#8-安全测试矩阵)

---

## 1. 安全架构

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Host :3002                     │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │  Policy   │ → │ Sanitize │ → │ Gateway  │          │
│  │ Validation│    │  (force  │    │ Client   │          │
│  │           │    │plan-only)│    │          │          │
│  └──────────┘    └──────────┘    └──────────┘          │
│                                                         │
│  安全层:                                                 │
│  ① 命令白名单 + 黑名单 (policy.js)                       │
│  ② plan-only 强制 (sanitizeTask)                        │
│  ③ GATEWAY_TOKEN Header 认证 (gateway-client.js)        │
│  ④ Token 脱敏审计 (audit-log.js)                         │
│  ⑤ Correlation ID 全链路 (server.js middleware)         │
└─────────────────────────────────────────────────────────┘
```

### 分层安全模型

| 层级 | 组件 | 策略 | 位置 |
|------|------|------|------|
| L1 | 输入验证 | 必填字段检查 (`command` 不为空) | `server.js` |
| L2 | 命令策略 | 白名单 + 黑名单 + 模式检查 | `policy.js` |
| L3 | 数据净化 | 强制 plan-only, 忽略请求 mode | `policy.js: sanitizeTask()` |
| L4 | 认证 | GATEWAY_TOKEN Header | `gateway-client.js` |
| L5 | 审计 | JSONL + Token 脱敏 + Correlation ID | `audit-log.js` |

---

## 2. 认证与 Token 管理

### 2.1 Token 类型隔离

| Token | 持有者 | 用途 | 暴露面 |
|-------|--------|------|--------|
| `GATEWAY_TOKEN` | Agent Host (.env) | 认证到 Gateway `/gateway/command` | 服务器本地 |
| `BRIDGE_TOKEN` | wecom-openclaw (.env, server-side) | Gateway 内部调用 Bridge `/runtime/command` | wecom-openclaw 内部 |

> **Agent Host 不持有 BRIDGE_TOKEN**。这是有意为之的安全隔离 — 即使 Agent Host 被攻破，攻击者无法绕过 Gateway 的安全策略直接调用 Bridge 的 Commander Runtime。

### 2.2 Token 配置规范

```ini
# .env 文件
GATEWAY_TOKEN=oc_gateway_prod_v1_<32位小写十六进制>

# 文件权限
chmod 600 /opt/openclaw-ai-agent-host/.env
```

### 2.3 Token 传输

Gateway Token 通过 HTTP Header 传输：
```
Gateway-Token: oc_gateway_prod_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- **不在 URL query string 中传输**（防止被代理日志记录）
- **不在 request body 中传输**
- **不在 审计日志中记录**

### 2.4 Token 脱敏规则

| 场景 | 处理方式 |
|------|----------|
| 审计日志写入 | `sanitizeBody()` 自动替换为 `***REDACTED***` |
| 异常/错误信息 | 不包含 Token 值 |
| 终端输出 | `oc_gateway_***` (仅前缀) |
| Git 仓库 | `.env` 被 `.gitignore` 排除 |

### 2.5 Token 泄露应急

如果怀疑 GATEWAY_TOKEN 泄露：

```bash
# 1. 立即生成新 Token
# （在 wecom-openclaw .env 中更新 GATEWAY_TOKEN）

# 2. 更新 Agent Host .env
vim /opt/openclaw-ai-agent-host/.env
# 修改 GATEWAY_TOKEN=<new_token>

# 3. 重启 Agent Host
pm2 restart openclaw-ai-agent-host --update-env

# 4. 验证
curl -s http://localhost:3002/health | jq .status

# 5. 审计日志回溯
grep 'UNAUTHORIZED' /opt/wecom-openclaw/logs/gateway-audit.log | tail -20
```

---

## 3. 命令安全策略

### 3.1 命令白名单

仅以下命令被允许通过 Agent Host：

```js
// src/policy.js
const ALLOWED_COMMANDS = [
  '/总控', '/目标', '/状态', '/进度', '/帮助',
  '/commander', '/总控台', '/任务列表',
  '/help', '/status', '/target', '/progress',
];
```

### 3.2 命令黑名单

以下命令**永久禁止**：

```js
const BLOCKED_COMMANDS = [
  '/deploy', '/restart', '/nginx', '/sudo', '/rm',
  '/merge', '/rollback', '/exec', '/shell', '/bash', '/sh',
  'confirm:deploy', 'confirm:merge', 'confirm:restart', 'confirm:rollback',
];
```

### 3.3 黑名单模式匹配

```js
const BLOCKED_PATTERNS = [
  /^confirm:/,      // 所有 confirm:* 前缀
  /^\/deploy/,      // 所有 /deploy* 前缀
  /^\/restart/,
  /^\/merge/,
  /^\/rollback/,
  /^\/nginx/,
  /^\/sudo/,
  /^\/rm/,
  /^\/exec/,
  /^\//,            // 未在 ALLOWED_COMMANDS 中的任何 / 命令
];
```

### 3.4 策略评估流程

```
输入 command
    │
    ▼
[1] command 是否为空？───是───→ 400 BAD_REQUEST
    │否
    ▼
[2] 匹配 BLOCKED_PATTERNS？
    │是
    ├── 在 ALLOWED_COMMANDS 中？───是───→ 放行
    │否
    └──→ 403 FORBIDDEN
    │否
    ▼
[3] 在 BLOCKED_COMMANDS 中？───是───→ 403 FORBIDDEN
    │否
    ▼
[4] 检查 mode ──→ 通过
    ▼
[5] 检查 agent ──→ 通过
    ▼
返回 { valid: true }
```

---

## 4. 执行模式策略

### 4.1 模式限制

| 模式 | 状态 | 说明 |
|------|------|------|
| `plan-only` | ✅ 允许 | 唯一允许的模式。返回计划，不执行 |
| `live` | ❌ 永久禁止 | 直接执行 — 安全红线 |
| `dry-run` | ❌ 永久禁止 | 试运行 — 相当于执行检查 |
| `execute` | ❌ 永久禁止 | 直接执行 — 安全红线 |
| 其他 | ❌ 返回 403 | 任何不在白名单的模式 |

### 4.2 plan-only 强制机制

```js
// src/policy.js — sanitizeTask()
function sanitizeTask(body) {
  return {
    command: body.command.trim(),
    mode: 'plan-only',  // 强制 plan-only，忽略请求中的任何 mode 值
    ...(body.agent ? { agent: body.agent.toLowerCase().trim() } : {}),
  };
}
```

无论请求体中的 `mode` 是何值（`live`、`dry-run`、`execute` 或空），`sanitizeTask()` 始终将其改写为 `plan-only`。即使策略验证层（`validateCommand`）因其他原因通过了某个 mode，净化层仍然保证最终转发到 Gateway 的是 `plan-only`。

### 4.3 为什么禁止 live execution？

1. **AI Agent 的不确定性**: AI 生成的命令可能产生意外后果
2. **安全审计可追溯性**: plan-only 模式下每条操作都有明确计划，可审可查
3. **防御纵深**: 即使 Gateway 和 Bridge 也有自己的安全层，Agent Host 作为最外层防线必须兜底
4. **最小权限原则**: Agent Host 仅应提供信息查询和计划生成，不应具备执行能力

---

## 5. Audit Log 安全

### 5.1 日志格式

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

### 5.2 Token 脱敏字段

`sanitizeBody()` 自动脱敏以下字段：

```js
const sensitiveKeys = [
  'token', 'gatewayToken', 'gateway_token', 'GATEWAY_TOKEN',
  'bridgeToken', 'bridge_token', 'BRIDGE_TOKEN',
  'authorization', 'Authorization',
  'password', 'secret', 'apiKey', 'api_key',
];
```

任何匹配字段的值被替换为 `***REDACTED***`。

### 5.3 日志安全规则

| 规则 | 实现 |
|------|------|
| 永不记录完整 Token | `sanitizeBody()` 自动脱敏 |
| 所有事件带 correlationId | `server.js` middleware 强制注入 |
| 写入选通化 (serialized writes) | `audit-log.js` 使用 Promise 队列 |
| 日志文件权限 | 默认继承进程用户 (ubuntu) |
| 无缓冲区延迟 | 每次 `log()` 调用立即 `fs.appendFile` |

### 5.4 日志审计检查

```bash
# 确认日志中无 Token 泄露
grep -i 'gateway_token\|oc_gateway' logs/host-audit.log

# 预期: 无匹配（Token 不应出现在审计日志中）
# 如果出现 ***REDACTED*** 是正常的（脱敏后的占位符）

# 确认所有日志条目有 correlationId
cat logs/host-audit.log | jq '.correlationId' | wc -l
# 应等于日志总行数
```

---

## 6. AI Agent 策略

### 6.1 Agent 白名单

通过 Agent Host 的任务可指定 Agent 执行，仅允许以下 Agent：

| Agent | 用途 |
|-------|------|
| `codex` | 代码生成、PR 起草 |
| `deepseek` | 深度分析、审查 |
| `workbuddy` | 审计、状态检查 |
| `doubao` | 内容生成 |

```js
const ALLOWED_AGENTS = ['codex', 'deepseek', 'workbuddy', 'doubao'];
```

### 6.2 Agent 用途限制

| Agent | 允许操作 | 禁止操作 |
|-------|----------|----------|
| codex | draft-pr, review-code | deploy, merge |
| deepseek | review, analyze | execute |
| workbuddy | audit, status, health | write, modify |
| doubao | content-generate | code-exec |

> Agent 级权限通过 wecom-openclaw 侧 AI Runtime RBAC 强制执行（见 wecom-openclaw `src/runtime/ai-runtime-rbac.js`）。

---

## 7. 安全红线

以下红线不可突破：

| # | 红线 | 实施方式 |
|---|------|----------|
| 1 | plan-only 永久强制 | `sanitizeTask()` 强制改写 + `validateCommand()` 拒绝其他 mode |
| 2 | 禁止 live execution | `FORBIDDEN_MODES` 包含 live/dry-run/execute |
| 3 | 禁止 deploy/restart/merge | `BLOCKED_COMMANDS` + `BLOCKED_PATTERNS` |
| 4 | Token 永不写入审计日志 | `sanitizeBody()` 自动脱敏 |
| 5 | Agent Host 不持有 BRIDGE_TOKEN | 架构设计，.env 中不存在 |
| 6 | 所有请求携带 Correlation ID | middleware 自动注入 |
| 7 | 禁止输出 API Key | 代码中无硬编码，Git 历史中无泄露 |

### 红线违规后果

任何违反红线的代码变更**不得 merge、不得 deploy**。安全审计必须在 merge 前通过。

---

## 8. 安全测试矩阵

### 8.1 测试套件

| 测试套件 | 测试数 | 说明 |
|----------|--------|------|
| Suite 1: Policy Validation | 24 | 命令白名单、黑名单、模式验证 |
| Suite 2: Task Store | 10 | 任务生命周期管理 |
| Suite 3: Gateway Client | 6 | 请求构建、重试、Token 检查 |
| Suite 4: Audit Log | 4 | Token 脱敏、correlationId |
| Suite 5: Health | 1 | 健康检查返回 |
| Suite 6: API Integration | 10 | POST/GET 端点集成测试 |
| Suite 7: Security Enforcement | 19 | 综合安全强制测试 |
| Suite 8: Correlation ID | 2 | 全链路追踪 |
| Suite 9: Audit Log Integrity | 2 | 日志完整性验证 |

**总计: 79 tests**

### 8.2 安全测试覆盖

| 安全场景 | 测试覆盖 |
|----------|----------|
| 命令白名单通过 | ✅ Suite 1 |
| 命令黑名单拒绝 | ✅ Suite 1 (15 个危险命令) |
| live mode 被拒绝 | ✅ Suite 1, Suite 7 |
| sanitizeTask 强制 plan-only | ✅ Suite 1, Suite 7 |
| empty/null command → 400 | ✅ Suite 1, Suite 6 |
| dangerous command → 403 | ✅ Suite 6 |
| confirm: command → 403 | ✅ Suite 6 |
| Token 脱敏 | ✅ Suite 4 |
| GATEWAY_TOKEN 未配置 → throw | ✅ Suite 3 |
| correlationId 传播 | ✅ Suite 8 |
| 审计日志完整性 | ✅ Suite 9 |

### 8.3 运行安全测试

```bash
cd /opt/openclaw-ai-agent-host
npm test

# 预期输出:
# Results: 79 passed, 0 failed, 79 total
```

---

## 附录: 安全事件响应

### A.1 可疑请求检测

```bash
# 检查被拒绝的请求
grep 'TASK_REJECTED' logs/host-audit.log | tail -20 | jq -c '{time: .timestamp, reason: .meta.reason, cmd: .meta.command, mode: .meta.mode}'

# 检查高频失败
grep 'TASK_FAILED' logs/host-audit.log | jq -c '{time: .timestamp, error: .meta.error}'
```

### A.2 强制策略验证

```bash
# 测试命令是否被拦截
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy","mode":"plan-only"}' | jq
# 预期: {"error":"FORBIDDEN","message":"命令 \"/deploy\" 被策略禁止"}

# 测试 live mode 是否被拦截
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command":"/总控","mode":"live"}' | jq
# 预期: {"error":"FORBIDDEN","message":"执行模式 \"live\" 被禁止，仅允许 plan-only"}
```
