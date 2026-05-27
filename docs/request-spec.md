# Agent Host Request Specification

**OpenClaw AI Agent Host v1.0.0** | 请求规范与集成指南

Agent Host → Gateway 的请求规范，包括 Schema、错误码、集成示例。

---

## 目录

- [1. 请求规范](#1-请求规范)
- [2. 响应规范](#2-响应规范)
- [3. 错误码参考](#3-错误码参考)
- [4. 集成示例](#4-集成示例)
- [5. ChatGPT 集成指南](#5-chatgpt-集成指南)
- [6. 请求字段参考](#6-请求字段参考)

---

## 1. 请求规范

### 1.1 Agent Host → Gateway 请求体 Schema

Agent Host 内部构建并发送到 `POST /gateway/command` 的请求体：

```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1779853513187,
  "command": "/总控 提升GMV",
  "mode": "plan-only",
  "user": "HaoZhongLiang",
  "source": "agent-host",
  "agent": "codex"
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `requestId` | string (UUID v4) | **是** | 唯一请求 ID，由 `uuidv4()` 生成 |
| `timestamp` | number | **是** | Unix 毫秒时间戳 (`Date.now()`) |
| `command` | string | **是** | 命令字符串，如 `/总控 提升GMV` |
| `mode` | string | **是** | 执行模式，**必须为 `plan-only`** |
| `user` | string | 否 | 用户标识，默认 `"unknown"` |
| `source` | string | 否 | 来源标识，默认 `"unknown"` |
| `agent` | string | 否 | 指定 AI Agent (codex/deepseek/workbuddy/doubao) |

### 1.2 请求 Headers

```http
POST /gateway/command HTTP/1.1
Host: localhost:3001
Content-Type: application/json
Gateway-Token: oc_gateway_prod_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
X-Correlation-ID: host_a1b2c3d4-e5f6-7890-abcd-ef1234567890
Content-Length: 256
```

| Header | 说明 |
|--------|------|
| `Content-Type` | `application/json` |
| `Gateway-Token` | GATEWAY_TOKEN，用于认证 |
| `X-Correlation-ID` | 全链路追踪 ID，由 Agent Host 生成或传入 |

### 1.3 Agent Host 接收请求体 Schema

客户端发送到 `POST /tasks` 的请求体：

```json
{
  "command": "/总控 提升GMV",
  "mode": "plan-only",
  "agent": "codex"
}
```

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `command` | string | **是** | 命令字符串，**不能为空** |
| `mode` | string | 否 | 可选，但不传则强制 `plan-only` |
| `agent` | string | 否 | 指定 AI Agent，可选值: codex/deepseek/workbuddy/doubao |

### 1.4 请求验证流程

```
客户端 POST /tasks
    │
    ▼
① command 为空？──── 是 ──→ 400 BAD_REQUEST
    │否
    ▼
② command 在黑名单？─ 是 ──→ 403 FORBIDDEN
    │否
    ▼
③ mode 非 plan-only？── 是 ──→ 403 FORBIDDEN
    │否
    ▼
④ agent 不在白名单？─ 是 ──→ 403 FORBIDDEN
    │否
    ▼
⑤ sanitizeTask (强制 plan-only)
    │
    ▼
⑥ 构建 Gateway 请求体 (填充 requestId/timestamp/user/source)
    │
    ▼
⑦ POST /gateway/command (GATEWAY_TOKEN + X-Correlation-ID)
    │
    ▼
⑧ 返回结果到客户端
```

---

## 2. 响应规范

### 2.1 成功响应 (200)

```json
{
  "taskId": "host_1779853513187_64537fed",
  "status": "completed",
  "command": "/总控 提升GMV",
  "mode": "plan-only",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "attempts": 1,
  "gatewayRequestId": "gw_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "result": {
    "success": true,
    "output": "[Commander Runtime] 目标: 提升GMV\nDAG: codex→deepseek→workbuddy→doubao"
  }
}
```

### 2.2 失败响应 (502 - Gateway 不可达)

```json
{
  "taskId": "host_1779853513187_64537fed",
  "status": "failed",
  "command": "/总控 提升GMV",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "error": "Gateway request timeout (30s)",
  "attempts": 4
}
```

### 2.3 响应 Headers

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-Correlation-ID: host_a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

- `X-Correlation-ID` 始终包含在响应头中，用于全链路追踪

### 2.4 任务查询响应

**GET /tasks/:id**:
```json
{
  "taskId": "host_1779853513187_64537fed",
  "status": "completed",
  "command": "/总控 提升GMV",
  "mode": "plan-only",
  "agent": "codex",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "createdAt": "2026-05-27T08:49:58.123Z",
  "updatedAt": "2026-05-27T08:49:59.456Z",
  "retryCount": 0,
  "error": null,
  "gatewayResponse": {
    "statusCode": 200,
    "gatewayRequestId": "gw_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "result": { ... }
  }
}
```

**GET /tasks**:
```json
{
  "count": 15,
  "tasks": [
    {
      "taskId": "host_1779853513187_64537fed",
      "status": "completed",
      "command": "/总控 提升GMV",
      "mode": "plan-only",
      "createdAt": "2026-05-27T08:49:58.123Z",
      "retryCount": 0
    }
  ]
}
```

---

## 3. 错误码参考

### 3.1 Agent Host 错误码

| HTTP 状态码 | 错误类型 | 含义 | 触发条件 |
|-------------|----------|------|----------|
| `200` | — | 成功 | Gateway 返回成功 |
| `400` | `BAD_REQUEST` | 缺少必填字段 | `command` 为空 |
| `403` | `FORBIDDEN` | 策略拒绝 | 命令/模式/agent 被禁止 |
| `404` | `NOT_FOUND` | 资源不存在 | 查询的 taskId 不存在 |
| `502` | — | Gateway 不可达 | 重试耗尽后仍失败 |

### 3.2 Gateway 透传错误

Agent Host 在 Gateway 返回非成功状态时，将 Gateway 响应体原样返回在 `result` 字段中：

| Gateway 状态码 | 含义 |
|----------------|------|
| `401` | Token 无效或缺失 |
| `403` | 命令/模式被 Gateway 策略拒绝 |
| `400` | 请求体格式错误（timestamp 校验失败等） |
| `429` | 速率限制 |

### 3.3 错误响应格式

**400 BAD_REQUEST**:
```json
{
  "error": "BAD_REQUEST",
  "message": "缺少 command 字段",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**403 FORBIDDEN**:
```json
{
  "error": "FORBIDDEN",
  "message": "命令 \"/deploy\" 被策略禁止",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**404 NOT_FOUND**:
```json
{
  "error": "NOT_FOUND",
  "message": "任务 host_nonexistent_id 不存在",
  "correlationId": "host_a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

---

## 4. 集成示例

### 4.1 cURL

#### Health Check
```bash
curl -s http://localhost:3002/health | jq
```

#### 发送任务（基本）
```bash
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command":"/总控 提升GMV"}' | jq
```

#### 发送任务（完整参数）
```bash
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -H "X-Correlation-ID: my_trace_$(date +%s)" \
  -d '{
    "command": "/总控 提升GMV",
    "mode": "plan-only",
    "agent": "deepseek"
  }' | jq
```

#### 查询任务
```bash
curl -s "http://localhost:3002/tasks?limit=10" | jq '.tasks[] | {taskId, status, command}'
```

#### 验证策略（发送禁止命令应返回 403）
```bash
curl -s -X POST http://localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command":"/deploy"}' | jq
# 预期: {"error":"FORBIDDEN","message":"命令 \"/deploy\" 被策略禁止"}
```

### 4.2 Node.js

```js
const http = require('http');

/**
 * Send a task to Agent Host.
 * @param {string} command - e.g. "/总控 提升GMV"
 * @param {object} [options] - { mode, agent, correlationId }
 * @returns {Promise<object>} task result
 */
function sendTask(command, options = {}) {
  const payload = JSON.stringify({
    command,
    mode: options.mode || 'plan-only',
    ...(options.agent ? { agent: options.agent } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: options.host || 'localhost',
      port: options.port || 3002,
      path: '/tasks',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.correlationId
          ? { 'X-Correlation-ID': options.correlationId }
          : {}),
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout (60s)'));
    });

    req.write(payload);
    req.end();
  });
}

// Usage
(async () => {
  try {
    // Health check
    const health = await httpGet('http://localhost:3002/health');
    console.log('Health:', health.status);

    // Send a task
    const result = await sendTask('/总控 提升GMV', {
      agent: 'codex',
      correlationId: 'node_sdk_' + Date.now(),
    });

    console.log(`Task ${result.taskId}: ${result.status}`);
    console.log(`Attempts: ${result.attempts}`);

    if (result.status === 'completed') {
      console.log('Output:', result.result.output);
    } else {
      console.error('Error:', result.error);
    }
  } catch (err) {
    console.error('Fatal:', err.message);
  }
})();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}
```

### 4.3 Python

```python
import requests
import json
import time
import uuid


class AgentHostClient:
    """OpenClaw AI Agent Host client."""

    def __init__(self, host="localhost", port=3002):
        self.base_url = f"http://{host}:{port}"

    def health(self):
        """Check service health."""
        resp = requests.get(f"{self.base_url}/health", timeout=10)
        resp.raise_for_status()
        return resp.json()

    def send_task(self, command, mode="plan-only", agent=None, correlation_id=None):
        """
        Send a task to Agent Host.

        Args:
            command: Command string, e.g. "/总控 提升GMV"
            mode: Execution mode (default "plan-only")
            agent: AI agent (codex/deepseek/workbuddy/doubao)
            correlation_id: Custom correlation ID

        Returns:
            dict: Task result
        """
        body = {"command": command, "mode": mode}
        if agent:
            body["agent"] = agent

        headers = {"Content-Type": "application/json"}
        if correlation_id:
            headers["X-Correlation-ID"] = correlation_id

        resp = requests.post(
            f"{self.base_url}/tasks",
            json=body,
            headers=headers,
            timeout=60,
        )
        return resp.json()

    def get_task(self, task_id):
        """Query a specific task."""
        resp = requests.get(
            f"{self.base_url}/tasks/{task_id}",
            timeout=10,
        )
        return resp.json()

    def list_tasks(self, limit=50):
        """List recent tasks."""
        resp = requests.get(
            f"{self.base_url}/tasks",
            params={"limit": limit},
            timeout=10,
        )
        return resp.json()


# Usage
if __name__ == "__main__":
    client = AgentHostClient()

    # Health check
    health = client.health()
    print(f"Service: {health['service']} v{health['version']}")
    print(f"Status: {health['status']}, Uptime: {health['uptimeSeconds']}s")

    # Send a task
    result = client.send_task(
        command="/总控 提升GMV",
        agent="codex",
        correlation_id=f"python_{int(time.time())}",
    )

    print(f"\nTask: {result['taskId']}")
    print(f"Status: {result['status']}")
    print(f"Attempts: {result['attempts']}")

    if result.get("status") == "completed":
        output = result.get("result", {}).get("output", "N/A")
        print(f"Output: {output}")
    else:
        print(f"Error: {result.get('error', 'Unknown')}")
```

### 4.4 Bash 脚本（批量任务）

```bash
#!/bin/bash
# send-tasks.sh — 批量发送任务到 Agent Host

AGENT_HOST="${AGENT_HOST:-http://localhost:3002}"
CORR_ID="batch_$(date +%s)"

echo "=== Agent Host Batch Tasks ==="
echo "Host: $AGENT_HOST"
echo "Correlation: $CORR_ID"
echo ""

# Health check
echo "[1/4] Health check..."
HEALTH=$(curl -sf "$AGENT_HOST/health" | jq -r '.status')
echo "  Status: $HEALTH"

if [ "$HEALTH" != "ok" ]; then
  echo "  ERROR: Agent Host not healthy"
  exit 1
fi

# Send tasks
commands=(
  "/状态"
  "/总控 提升GMV"
  "/进度"
  "/帮助"
)

for cmd in "${commands[@]}"; do
  echo ""
  echo "[>] Sending: $cmd"
  RESULT=$(curl -sf -X POST "$AGENT_HOST/tasks" \
    -H "Content-Type: application/json" \
    -H "X-Correlation-ID: $CORR_ID" \
    -d "{\"command\":\"$cmd\"}")

  TASK_ID=$(echo "$RESULT" | jq -r '.taskId')
  STATUS=$(echo "$RESULT" | jq -r '.status')
  ATTEMPTS=$(echo "$RESULT" | jq -r '.attempts')

  echo "  Task: $TASK_ID"
  echo "  Status: $STATUS"
  echo "  Attempts: $ATTEMPTS"

  if [ "$STATUS" = "completed" ]; then
    OUTPUT=$(echo "$RESULT" | jq -r '.result.output // "N/A"' | head -5)
    echo "  Output:"
    echo "$OUTPUT" | sed 's/^/    /'
  else
    ERROR=$(echo "$RESULT" | jq -r '.error // "Unknown"')
    echo "  Error: $ERROR"
  fi
done

echo ""
echo "=== Done ==="
```

---

## 5. ChatGPT 集成指南

### 5.1 架构

```
ChatGPT
  │
  │ HTTP POST /tasks
  ▼
Agent Host :3002
  │
  │ GATEWAY_TOKEN
  ▼
Gateway :3001 → Bridge → Commander
```

### 5.2 ChatGPT Action (OpenAPI Spec)

```yaml
openapi: 3.0.0
info:
  title: OpenClaw Commander
  version: 1.0.0
  description: 通过 Agent Host 调用 OpenClaw Commander Runtime (plan-only)

servers:
  - url: https://your-agent-host.example.com

paths:
  /tasks:
    post:
      operationId: sendCommanderTask
      summary: 发送任务到 Commander Runtime
      description: 所有任务以 plan-only 模式执行，仅返回计划，不执行实际操作
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required:
                - command
              properties:
                command:
                  type: string
                  description: 命令，如 "/总控 提升GMV"、"/状态"、"/目标 降低退款率"
                  example: "/总控 提升GMV"
                mode:
                  type: string
                  enum: [plan-only]
                  default: plan-only
                  description: 执行模式（只能为 plan-only）
                agent:
                  type: string
                  enum: [codex, deepseek, workbuddy, doubao]
                  description: 指定 AI Agent（可选）
      responses:
        '200':
          description: 任务成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  taskId:
                    type: string
                  status:
                    type: string
                    enum: [completed]
                  result:
                    type: object
        '400':
          description: 请求格式错误
        '403':
          description: 命令/模式被策略禁止
        '502':
          description: Gateway 不可达

  /health:
    get:
      operationId: healthCheck
      summary: 健康检查
      responses:
        '200':
          description: 服务正常
```

### 5.3 ChatGPT Prompt 模板

```
你是 OpenClaw Commander 助手，通过 Agent Host 与 Commander Runtime 交互。

可用命令:
- /总控 <目标>: 分析目标并生成 DAG 执行计划
- /状态: 查看系统状态
- /目标 <描述>: 设置/查看业务目标
- /进度: 查看任务进度
- /帮助: 查看帮助

重要规则:
- 所有操作以 plan-only 模式执行（仅返回计划，不执行）
- Deployment / restart / merge 命令被永久禁止
- 可在 URL 中传入 agent 参数指定 AI Agent (codex/deepseek/workbuddy/doubao)

当用户提出业务目标时，使用 /总控 命令并传递目标描述。
```

### 5.4 注意事项

1. **plan-only**: 所有通过 Agent Host 的命令都是 plan-only，ChatGPT 应告知用户"这是计划，需要人工确认后执行"
2. **Agent 指定**: 如果需要特定 Agent 分析（如 codex 代码审查、deepseek 深度分析），在请求中添加 `"agent"` 字段
3. **Correlation ID**: ChatGPT 集成建议每次对话生成一个 correlation ID，方便追踪
4. **超时处理**: Agent Host 有 30 秒 Gateway 超时 + 3 次重试，ChatGPT Action 建议设置 60 秒超时

---

## 6. 请求字段参考

### 6.1 command 字段

| 命令 | 格式 | 示例 | 说明 |
|------|------|------|------|
| `/总控` | `/总控 <目标描述>` | `/总控 提升GMV` | 启动 Commander Runtime |
| `/commander` | `/commander <目标描述>` | `/commander 降低退款率` | Commander Runtime (EN) |
| `/总控台` | `/总控台` | `/总控台` | 总控台 |
| `/目标` | `/目标 [描述]` | `/目标` 或 `/目标 提升GMV` | 设置/查看目标 |
| `/状态` | `/状态` | `/状态` | 系统状态 |
| `/进度` | `/进度` | `/进度` | 任务进度 |
| `/帮助` | `/帮助` | `/帮助` | 帮助信息 |
| `/任务列表` | `/任务列表` | `/任务列表` | 任务列表 |

### 6.2 mode 字段

| 值 | 状态 |
|----|------|
| `plan-only` | ✅ 唯一允许 |
| `live` | ❌ 永久禁止 |
| `dry-run` | ❌ 永久禁止 |
| `execute` | ❌ 永久禁止 |
| 不传 | → 强制设为 `plan-only` |

### 6.3 agent 字段

| 值 | Agent | 典型用途 |
|----|-------|----------|
| `codex` | Codex | 代码生成、PR 起草 |
| `deepseek` | DeepSeek | 深度分析、代码审查 |
| `workbuddy` | WorkBuddy | 审计、状态检查 |
| `doubao` | Doubao | 内容生成 |

### 6.4 Correlation ID 格式

```
自动生成: host_<UUID v4>
自定义:   <任意字符串>
示例:     host_a1b2c3d4-e5f6-7890-abcd-ef1234567890
          my_trace_1779853513
          chatgpt_session_abc123
```

### 6.5 taskId 格式

```
格式: host_<Unix毫秒时间戳>_<8位小写十六进制随机值>
示例: host_1779853513187_64537fed
```

### 6.6 重试机制

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `MAX_RETRIES` | 3 | 最大重试次数 |
| `RETRY_DELAY_MS` | 1000 | 重试间隔（毫秒） |
| 总超时 | ~33s | 1 初始 + 3 重试 × (30s 超时 + 1s 延迟) |

---

## 附录: 快速参考卡片

### Agent Host 端点

```
POST  /tasks        # 发送任务
GET   /tasks/:id    # 查询任务
GET   /tasks        # 列出任务
GET   /health       # 健康检查
```

### 最小可用的 cURL

```bash
curl -X POST localhost:3002/tasks \
  -H "Content-Type: application/json" \
  -d '{"command":"/状态"}'
```

### 端口映射

```
Agent Host  :3002  ← 本服务
Gateway     :3001  ← wecom-openclaw
```
