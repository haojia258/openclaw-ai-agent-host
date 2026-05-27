# OpenClaw AI Agent Host

**P8.2 Agent Host Runtime v1** — 独立长期运行的 Agent Host，用于接收 ChatGPT/人工输入任务，持有 GATEWAY_TOKEN，调用 wecom-openclaw 的 `/gateway/command`。

## 架构

```
ChatGPT / 人工输入
        │
        ▼
┌──────────────────────┐
│  Agent Host (本服务)  │  port 3002
│  POST /tasks         │
│  GET  /tasks/:id     │
│  GET  /health        │
└──────┬───────────────┘
       │ GATEWAY_TOKEN
       ▼
┌──────────────────────┐
│  wecom-openclaw      │  port 3001
│  /gateway/command    │
└──────┬───────────────┘
       │ BRIDGE_TOKEN (server-side)
       ▼
┌──────────────────────┐
│  Commander Runtime   │
│  (plan-only)         │
└──────────────────────┘
```

## 目录结构

```
openclaw-ai-agent-host/
├── src/
│   ├── server.js          # Express 主服务
│   ├── gateway-client.js  # Gateway HTTP 客户端（重试/自动补字段）
│   ├── task-store.js      # 任务状态存储
│   ├── audit-log.js       # JSONL 审计日志
│   ├── policy.js          # 安全策略
│   └── health.js          # 健康检查
├── tests/
│   └── test-agent-host.cjs
├── .env.example
├── package.json
└── README.md
```

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 GATEWAY_URL 和 GATEWAY_TOKEN

# 3. 启动服务
npm start

# 4. 运行测试
npm test
```

## API

### POST /tasks

接收任务，验证安全策略，转发到 Gateway。

```bash
curl -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command": "/总控", "mode": "plan-only"}'
```

响应：
```json
{
  "taskId": "host_1779800000000_a1b2c3d4",
  "status": "completed",
  "command": "/总控",
  "mode": "plan-only",
  "correlationId": "host_<uuid>",
  "attempts": 1,
  "result": { ... }
}
```

### GET /tasks/:id

查询任务结果。

### GET /tasks

列出最近任务（默认 50 条）。

### GET /health

健康检查。

## 安全策略

| 策略 | 说明 |
|---|---|
| plan-only | 永久强制，不允许 live/dry-run/execute |
| 命令白名单 | 仅允许 `/总控` `/目标` `/状态` `/进度` `/帮助` `/commander` 等 |
| 禁止命令 | `/deploy` `/restart` `/merge` `/rollback` `/nginx` `/sudo` `/rm` `/exec` `/shell` 及所有 `confirm:*` |
| Token 隔离 | 仅持有 GATEWAY_TOKEN，不持有 BRIDGE_TOKEN |
| Token 脱敏 | 审计日志中永不出现完整 Token |
| Correlation ID | 每个请求携带全链路追踪 ID |
| 重试 | 网络错误自动重试最多 3 次 |

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `GATEWAY_URL` | 是 | wecom-openclaw Gateway 地址 |
| `GATEWAY_TOKEN` | 是 | Gateway 认证 Token |
| `PORT` | 否 | 服务端口（默认 3002） |
| `HOST` | 否 | 绑定地址（默认 0.0.0.0） |
| `MAX_RETRIES` | 否 | 最大重试次数（默认 3） |
| `RETRY_DELAY_MS` | 否 | 重试间隔毫秒（默认 1000） |
| `AUDIT_LOG_PATH` | 否 | 审计日志路径（默认 ./logs/host-audit.log） |
