/**
 * server.js - Agent Host Runtime v1
 *
 * Standalone Node.js service that:
 *  1. Receives tasks via POST /tasks
 *  2. Validates against security policy
 *  3. Forwards to wecom-openclaw Gateway (/gateway/command)
 *  4. Returns plan-only results
 *  5. Logs audit trail to host-audit.log
 *
 * Security:
 *  - Only GATEWAY_TOKEN stored (never BRIDGE_TOKEN)
 *  - plan-only mode enforced
 *  - Live execution permanently forbidden
 *  - Token never written to logs
 *  - All requests carry correlationId
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const policy = require('./policy');
const gatewayClient = require('./gateway-client');
const taskStore = require('./task-store');
const auditLog = require('./audit-log');
const { getHealth } = require('./health');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3002', 10);
const HOST = process.env.HOST || '0.0.0.0';

// ============================================================
// Middleware: Attach correlationId to every request
// ============================================================
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || `host_${uuidv4()}`;
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
});

// ============================================================
// POST /tasks — Receive and dispatch a task
// ============================================================
app.post('/tasks', async (req, res) => {
  const correlationId = req.correlationId;

  // 1. Validate request body
  const { command, mode, agent } = req.body || {};
  if (!command) {
    await auditLog.log({
      event: 'TASK_REJECTED',
      correlationId,
      meta: { reason: 'missing command', body: auditLog.sanitizeBody(req.body) },
    });
    return res.status(400).json({
      error: 'BAD_REQUEST',
      message: '缺少 command 字段',
      correlationId,
    });
  }

  // 2. Validate against policy
  const validation = policy.validateCommand(command, mode, agent);
  if (!validation.valid) {
    await auditLog.log({
      event: 'TASK_REJECTED',
      correlationId,
      meta: {
        reason: validation.error,
        command,
        mode,
        agent: agent || null,
      },
    });
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: validation.error,
      correlationId,
    });
  }

  // 3. Sanitize payload (force plan-only)
  const sanitized = policy.sanitizeTask({ command, mode, agent });

  // 4. Create task record
  const task = taskStore.create(sanitized, correlationId);

  await auditLog.log({
    event: 'TASK_RECEIVED',
    correlationId,
    taskId: task.taskId,
    meta: {
      command: sanitized.command,
      mode: sanitized.mode,
      agent: sanitized.agent,
    },
  });

  // 5. Mark running and call gateway
  taskStore.markRunning(task.taskId);

  await auditLog.log({
    event: 'GATEWAY_CALL',
    correlationId,
    taskId: task.taskId,
    meta: { command: sanitized.command },
  });

  const result = await gatewayClient.callGateway(
    sanitized.command,
    sanitized.mode,
    sanitized.agent,
    correlationId,
    (retryNum, errMsg) => {
      taskStore.incrementRetry(task.taskId);
      auditLog.log({
        event: 'RETRY',
        correlationId,
        taskId: task.taskId,
        meta: { retryNum, error: errMsg },
      }).catch(() => {});
    },
  );

  // 6. Handle result
  if (result.success) {
    taskStore.markCompleted(task.taskId, {
      statusCode: result.statusCode,
      gatewayResponse: result.body,
      requestId: result.requestId,
    });

    await auditLog.log({
      event: 'TASK_COMPLETED',
      correlationId,
      taskId: task.taskId,
      meta: {
        statusCode: result.statusCode,
        attempts: result.attempts,
        gatewayRequestId: result.requestId,
      },
    });

    return res.status(result.statusCode || 200).json({
      taskId: task.taskId,
      status: 'completed',
      command: sanitized.command,
      mode: sanitized.mode,
      correlationId,
      attempts: result.attempts,
      gatewayRequestId: result.requestId,
      result: result.body,
    });
  }

  // Failed
  taskStore.markFailed(task.taskId, result.error, result.attempts);

  await auditLog.log({
    event: 'TASK_FAILED',
    correlationId,
    taskId: task.taskId,
    meta: {
      error: result.error,
      attempts: result.attempts,
    },
  });

  return res.status(502).json({
    taskId: task.taskId,
    status: 'failed',
    command: sanitized.command,
    correlationId,
    error: result.error,
    attempts: result.attempts,
  });
});

// ============================================================
// GET /tasks/:id — Query task result
// ============================================================
app.get('/tasks/:id', async (req, res) => {
  const task = taskStore.get(req.params.id);
  if (!task) {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: `任务 ${req.params.id} 不存在`,
      correlationId: req.correlationId,
    });
  }

  // Only return safe fields — never expose tokens
  return res.json({
    taskId: task.taskId,
    status: task.status,
    command: task.command,
    mode: task.mode,
    agent: task.agent,
    correlationId: task.correlationId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    retryCount: task.retryCount,
    error: task.error,
    gatewayResponse: task.gatewayResponse ? {
      statusCode: task.gatewayResponse.statusCode,
      gatewayRequestId: task.gatewayResponse.requestId,
      result: task.gatewayResponse.gatewayResponse,
    } : null,
  });
});

// ============================================================
// GET /tasks — List all tasks
// ============================================================
app.get('/tasks', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const tasks = taskStore.list(Math.min(limit, 200));
  res.json({ count: tasks.length, tasks });
});

// ============================================================
// GET /health — Health check
// ============================================================
app.get('/health', (req, res) => {
  res.json(getHealth());
});

// ============================================================
// 404 handler
// ============================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `路由 ${req.method} ${req.path} 不存在`,
    correlationId: req.correlationId,
  });
});

// ============================================================
// Start server
// ============================================================
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[agent-host] OpenClaw AI Agent Host v1.0.0`);
    console.log(`[agent-host] Listening on ${HOST}:${PORT}`);
    console.log(`[agent-host] Gateway: ${process.env.GATEWAY_URL || 'http://localhost:3001'}`);
    console.log(`[agent-host] Mode: plan-only (live execution permanently disabled)`);
  });
}

module.exports = app;
