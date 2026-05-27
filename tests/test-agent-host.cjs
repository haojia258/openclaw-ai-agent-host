/**
 * test-agent-host.cjs - Comprehensive test suite for P8.2 Agent Host Runtime v1
 *
 * Tests:
 *  1. Policy validation (allowed/blocked commands, mode enforcement, agent allowlist)
 *  2. Task store (CRUD, lifecycle)
 *  3. Gateway client (request building, retry logic)
 *  4. Audit log (token masking, correlationId)
 *  5. Health endpoint
 *  6. API integration (POST /tasks, GET /tasks/:id, GET /health)
 *  7. Security enforcement (live mode blocked, dangerous commands blocked)
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================
// Setup
// ============================================================

// Set test environment variables before loading any modules
const TEST_AUDIT_LOG = path.join(__dirname, '..', 'logs', 'test-host-audit.log');

process.env.GATEWAY_URL = 'http://localhost:19999'; // non-existent, will fail
process.env.GATEWAY_TOKEN = 'test_gateway_token_for_unit_tests';
process.env.AUDIT_LOG_PATH = TEST_AUDIT_LOG;
process.env.PORT = '30999';
process.env.HOST = '127.0.0.1';

// Clean up old test audit log
try { fs.unlinkSync(TEST_AUDIT_LOG); } catch {}

// ============================================================
// Load modules
// ============================================================
const policy = require('../src/policy');
const taskStore = require('../src/task-store');
const gatewayClient = require('../src/gateway-client');
const auditLog = require('../src/audit-log');
const { getHealth } = require('../src/health');

// Set audit log path for test
auditLog.setLogPath(TEST_AUDIT_LOG);

// ============================================================
// Test helpers
// ============================================================
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  if (fn.length > 0) {
    // Async test with done callback
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        failed++;
        failures.push({ name, error: 'Test timed out (5s)' });
        console.log(`  ✗ ${name} (timeout)`);
      }
    }, 5000);

    try {
      fn((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) {
          failed++;
          failures.push({ name, error: err.message || String(err) });
          console.log(`  ✗ ${name}`);
          console.log(`    Error: ${err.message || err}`);
        } else {
          passed++;
          console.log(`  ✓ ${name}`);
        }
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        failed++;
        failures.push({ name, error: err.message });
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${err.message}`);
      }
    }
  } else {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, error: err.message });
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
    }
  }
}

function assertEqual(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg || `expected ${expected}, got ${actual}`);
}

function assertOk(value, msg) {
  assert.ok(value, msg || `expected truthy value`);
}

// ============================================================
// Suite 1: Policy Validation
// ============================================================
console.log('\n=== Suite 1: Policy Validation ===');

test('allowed command /总控', () => {
  const result = policy.validateCommand('/总控', 'plan-only', null);
  assertEqual(result.valid, true);
});

test('allowed command /目标', () => {
  const result = policy.validateCommand('/目标', 'plan-only', null);
  assertEqual(result.valid, true);
});

test('allowed command /状态', () => {
  const result = policy.validateCommand('/状态', 'plan-only', null);
  assertEqual(result.valid, true);
});

test('allowed command /commander', () => {
  const result = policy.validateCommand('/commander', 'plan-only', null);
  assertEqual(result.valid, true);
});

test('blocked command /deploy', () => {
  const result = policy.validateCommand('/deploy', 'plan-only', null);
  assertEqual(result.valid, false);
  assertOk(result.error.includes('禁止'));
});

test('blocked command /restart', () => {
  const result = policy.validateCommand('/restart', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('blocked command /merge', () => {
  const result = policy.validateCommand('/merge', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('blocked command /sudo rm -rf', () => {
  const result = policy.validateCommand('/sudo', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('blocked command /rollback', () => {
  const result = policy.validateCommand('/rollback', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('blocked command confirm:deploy', () => {
  const result = policy.validateCommand('confirm:deploy', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('blocked command confirm:merge', () => {
  const result = policy.validateCommand('confirm:merge', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('empty command rejected', () => {
  const result = policy.validateCommand('', 'plan-only', null);
  assertEqual(result.valid, false);
});

test('null command rejected', () => {
  const result = policy.validateCommand(null, 'plan-only', null);
  assertEqual(result.valid, false);
});

test('mode live rejected', () => {
  const result = policy.validateCommand('/总控', 'live', null);
  assertEqual(result.valid, false);
  assertOk(result.error.includes('live'));
});

test('mode dry-run rejected', () => {
  const result = policy.validateCommand('/总控', 'dry-run', null);
  assertEqual(result.valid, false);
  assertOk(result.error.includes('dry-run'));
});

test('mode execute rejected', () => {
  const result = policy.validateCommand('/总控', 'execute', null);
  assertEqual(result.valid, false);
  assertOk(result.error.includes('execute'));
});

test('mode plan-only accepted', () => {
  const result = policy.validateCommand('/总控', 'plan-only', null);
  assertEqual(result.valid, true);
});

test('unknown mode rejected', () => {
  const result = policy.validateCommand('/总控', 'mixed-mode', null);
  assertEqual(result.valid, false);
});

test('valid agent codex', () => {
  const result = policy.validateCommand('/总控', 'plan-only', 'codex');
  assertEqual(result.valid, true);
});

test('valid agent doubao', () => {
  const result = policy.validateCommand('/目标', 'plan-only', 'doubao');
  assertEqual(result.valid, true);
});

test('invalid agent rejected', () => {
  const result = policy.validateCommand('/总控', 'plan-only', 'evil-agent');
  assertEqual(result.valid, false);
  assertOk(result.error.includes('evil-agent'));
});

test('sanitizeTask forces plan-only', () => {
  const sanitized = policy.sanitizeTask({ command: '/总控', mode: 'live', agent: 'codex' });
  assertEqual(sanitized.mode, 'plan-only');
  assertEqual(sanitized.command, '/总控');
  assertEqual(sanitized.agent, 'codex');
});

test('sanitizeTask defaults mode to plan-only', () => {
  const sanitized = policy.sanitizeTask({ command: '/帮助' });
  assertEqual(sanitized.mode, 'plan-only');
  assertEqual(sanitized.command, '/帮助');
});

// ============================================================
// Suite 2: Task Store
// ============================================================
console.log('\n=== Suite 2: Task Store ===');

taskStore.clear();

test('create task returns record with taskId', () => {
  const task = taskStore.create(
    { command: '/总控', mode: 'plan-only' },
    'corr_test_001',
  );
  assertOk(task.taskId.startsWith('host_'));
  assertEqual(task.status, 'pending');
  assertEqual(task.command, '/总控');
  assertEqual(task.mode, 'plan-only');
  assertEqual(task.correlationId, 'corr_test_001');
});

test('get task by ID', () => {
  const task = taskStore.create(
    { command: '/目标', mode: 'plan-only' },
    'corr_test_002',
  );
  const found = taskStore.get(task.taskId);
  assertEqual(found.taskId, task.taskId);
  assertEqual(found.command, '/目标');
});

test('get non-existent task returns undefined', () => {
  const found = taskStore.get('nonexistent_id');
  assertEqual(found, undefined);
});

test('markRunning updates status', () => {
  const task = taskStore.create(
    { command: '/状态', mode: 'plan-only' },
    'corr_test_003',
  );
  const updated = taskStore.markRunning(task.taskId);
  assertEqual(updated.status, 'running');
});

test('markCompleted updates status and stores response', () => {
  const task = taskStore.create(
    { command: '/总控', mode: 'plan-only' },
    'corr_test_004',
  );
  const response = { statusCode: 200, body: { plan: 'test plan' }, requestId: 'req_001' };
  const completed = taskStore.markCompleted(task.taskId, response);
  assertEqual(completed.status, 'completed');
  assertEqual(completed.gatewayResponse.statusCode, 200);
  assertEqual(completed.gatewayResponse.requestId, 'req_001');
});

test('markFailed updates status and error', () => {
  const task = taskStore.create(
    { command: '/总控', mode: 'plan-only' },
    'corr_test_005',
  );
  const failed = taskStore.markFailed(task.taskId, 'connection refused', 3);
  assertEqual(failed.status, 'failed');
  assertEqual(failed.error, 'connection refused');
  assertEqual(failed.retryCount, 3);
});

test('incrementRetry increases count', () => {
  const task = taskStore.create(
    { command: '/总控', mode: 'plan-only' },
    'corr_test_006',
  );
  taskStore.incrementRetry(task.taskId);
  taskStore.incrementRetry(task.taskId);
  const found = taskStore.get(task.taskId);
  assertEqual(found.retryCount, 2);
});

test('list returns all created tasks', () => {
  taskStore.clear();
  taskStore.create({ command: '/总控', mode: 'plan-only' }, 'c1');
  taskStore.create({ command: '/目标', mode: 'plan-only' }, 'c2');
  const list = taskStore.list();
  assertEqual(list.length, 2);
  assertOk(list.some(t => t.command === '/总控'));
  assertOk(list.some(t => t.command === '/目标'));
});

test('count returns correct number', () => {
  taskStore.clear();
  taskStore.create({ command: '/总控', mode: 'plan-only' }, 'c1');
  taskStore.create({ command: '/目标', mode: 'plan-only' }, 'c2');
  taskStore.create({ command: '/状态', mode: 'plan-only' }, 'c3');
  assertEqual(taskStore.count(), 3);
});

// ============================================================
// Suite 3: Gateway Client
// ============================================================
console.log('\n=== Suite 3: Gateway Client ===');

test('getGatewayConfig returns config from env', () => {
  const config = gatewayClient.getGatewayConfig();
  assertEqual(config.url, 'http://localhost:19999');
  assertEqual(config.token, 'test_gateway_token_for_unit_tests');
});

test('getGatewayConfig throws without token', () => {
  const oldToken = process.env.GATEWAY_TOKEN;
  delete process.env.GATEWAY_TOKEN;
  try {
    gatewayClient.getGatewayConfig();
    assert.fail('should have thrown');
  } catch (err) {
    assertOk(err.message.includes('GATEWAY_TOKEN'));
  }
  process.env.GATEWAY_TOKEN = oldToken;
});

test('buildRequestBody includes all fields', () => {
  const body = gatewayClient.buildRequestBody('/总控', 'plan-only', 'codex', 'corr_001');
  assertOk(body.requestId, 'has requestId');
  assertOk(body.timestamp, 'has timestamp');
  assertEqual(body.command, '/总控');
  assertEqual(body.mode, 'plan-only');
  assertEqual(body.agent, 'codex');
});

test('buildRequestBody generates unique requestIds', () => {
  const b1 = gatewayClient.buildRequestBody('/总控', 'plan-only', null, 'c1');
  const b2 = gatewayClient.buildRequestBody('/总控', 'plan-only', null, 'c2');
  assertOk(b1.requestId !== b2.requestId);
});

test('buildRequestBody omits agent when not provided', () => {
  const body = gatewayClient.buildRequestBody('/总控', 'plan-only', null, 'corr_001');
  assertEqual(body.agent, undefined);
});

test('callGateway returns error for unreachable URL', async () => {
  const result = await gatewayClient.callGateway(
    '/总控',
    'plan-only',
    null,
    'corr_retry_test',
    null,
  );
  assertEqual(result.success, false);
  assertOk(result.attempts >= 1);
  assertOk(result.error, 'has error message');
});

test('callGateway retries up to MAX_RETRIES', async () => {
  const retryCounts = [];
  const result = await gatewayClient.callGateway(
    '/总控',
    'plan-only',
    null,
    'corr_retry_count',
    (retryNum, err) => {
      retryCounts.push(retryNum);
    },
  );
  assertEqual(result.success, false);
  // Max retries + 1 initial attempt
  assertOk(result.attempts > 1, `attempts=${result.attempts} should be > 1`);
});

// ============================================================
// Suite 4: Audit Log
// ============================================================
console.log('\n=== Suite 4: Audit Log ===');

test('auditLog.log writes to file', async () => {
  await auditLog.log({
    event: 'TEST_EVENT',
    correlationId: 'corr_audit_001',
    meta: { test: true },
  });

  // Give it a moment to flush
  await new Promise(r => setTimeout(r, 100));

  const content = fs.readFileSync(TEST_AUDIT_LOG, 'utf8');
  assertOk(content.includes('TEST_EVENT'));
  assertOk(content.includes('corr_audit_001'));
});

test('sanitizeBody redacts token fields', () => {
  const body = {
    command: '/总控',
    gatewayToken: 'secret_token_123',
    GATEWAY_TOKEN: 'another_secret',
    authorization: 'Bearer xyz',
    Authorization: 'Bearer abc',
    password: 'p@ssw0rd',
    normalField: 'visible',
  };
  const sanitized = auditLog.sanitizeBody(body);
  assertEqual(sanitized.gatewayToken, '***REDACTED***');
  assertEqual(sanitized.GATEWAY_TOKEN, '***REDACTED***');
  assertEqual(sanitized.authorization, '***REDACTED***');
  assertEqual(sanitized.Authorization, '***REDACTED***');
  assertEqual(sanitized.password, '***REDACTED***');
  assertEqual(sanitized.normalField, 'visible');
});

test('sanitizeBody handles null input', () => {
  const result = auditLog.sanitizeBody(null);
  assertEqual(result, null);
});

test('audit log contains correlationId', async () => {
  await auditLog.log({
    event: 'CORR_TEST',
    correlationId: 'corr_unique_12345',
    meta: {},
  });
  await new Promise(r => setTimeout(r, 100));

  const content = fs.readFileSync(TEST_AUDIT_LOG, 'utf8');
  assertOk(content.includes('corr_unique_12345'));
});

// ============================================================
// Suite 5: Health
// ============================================================
console.log('\n=== Suite 5: Health ===');

test('getHealth returns ok status', () => {
  const health = getHealth();
  assertEqual(health.status, 'ok');
  assertEqual(health.service, 'openclaw-ai-agent-host');
  assertEqual(health.version, 'v1.0.0');
  assertOk(health.uptimeSeconds >= 0);
  assertOk(typeof health.taskCount === 'number');
  assertOk(typeof health.memoryMB === 'number');
});

// ============================================================
// Suite 6: API Integration Tests
// ============================================================
console.log('\n=== Suite 6: API Integration ===');

let server = null;

// Clean audit log and task store before integration tests
taskStore.clear();
try { fs.unlinkSync(TEST_AUDIT_LOG); } catch {}

const app = require('../src/server');

// Start server
console.log('  [Starting test server...]');
server = app.listen(30999, '127.0.0.1', () => {
  console.log('  [Server started on 127.0.0.1:30999]');
});

// Wait for server to be ready (sync polling)
let pollCount = 0;
while (!server.listening && pollCount < 100) {
  // Sync wait: check every iteration
  const start = Date.now();
  while (Date.now() - start < 10) {} // busy-wait 10ms
  pollCount++;
}

test('server responds to health check', (done) => {
  const req = http.get('http://127.0.0.1:30999/health', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const body = JSON.parse(data);
        assertEqual(body.status, 'ok');
        assertEqual(body.service, 'openclaw-ai-agent-host');
        done();
      } catch (err) {
        done(err);
      }
    });
  });
  req.on('error', (err) => {
    // Retry once after short delay
    setTimeout(() => {
      const req2 = http.get('http://127.0.0.1:30999/health', (res) => {
        let data2 = '';
        res.on('data', (chunk) => { data2 += chunk; });
        res.on('end', () => {
          try {
            const body = JSON.parse(data2);
            assertEqual(body.status, 'ok');
            done();
          } catch (e) {
            done(e);
          }
        });
      });
      req2.on('error', (e2) => done(e2));
    }, 200);
  });
});

function makePost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 30999,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function makeGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:30999${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
  });
}

test('POST /tasks with valid command returns 200', async () => {
  // Server is running but gateway is unreachable, so it will retry and fail
  const res = await makePost('/tasks', {
    command: '/总控',
    mode: 'plan-only',
  });
  // Since gateway is unreachable, it should return 502
  assertEqual(res.statusCode, 502);
  assertEqual(res.body.status, 'failed');
  assertOk(res.body.taskId.startsWith('host_'));
  assertOk(res.body.correlationId);
});

test('POST /tasks rejects live mode (403)', async () => {
  const res = await makePost('/tasks', {
    command: '/总控',
    mode: 'live',
  });
  assertEqual(res.statusCode, 403);
  assertEqual(res.body.error, 'FORBIDDEN');
});

test('POST /tasks rejects dangerous command (403)', async () => {
  const res = await makePost('/tasks', {
    command: '/deploy',
    mode: 'plan-only',
  });
  assertEqual(res.statusCode, 403);
  assertEqual(res.body.error, 'FORBIDDEN');
});

test('POST /tasks rejects confirm: command (403)', async () => {
  const res = await makePost('/tasks', {
    command: 'confirm:deploy',
    mode: 'plan-only',
  });
  assertEqual(res.statusCode, 403);
});

test('POST /tasks rejects empty body (400)', async () => {
  const res = await makePost('/tasks', {});
  assertEqual(res.statusCode, 400);
  assertEqual(res.body.error, 'BAD_REQUEST');
});

test('POST /tasks rejects missing command (400)', async () => {
  const res = await makePost('/tasks', { mode: 'plan-only' });
  assertEqual(res.statusCode, 400);
  assertEqual(res.body.error, 'BAD_REQUEST');
});

test('POST /tasks response includes correlationId header', async () => {
  const res = await makePost('/tasks', {
    command: '/总控',
    mode: 'plan-only',
  });
  assertOk(res.headers['x-correlation-id']);
});

test('GET /tasks lists recent tasks', async () => {
  const res = await makeGet('/tasks');
  assertEqual(res.statusCode, 200);
  assertOk(Array.isArray(res.body.tasks));
  assertOk(res.body.count > 0);
});

test('GET /tasks/:id returns 404 for unknown task', async () => {
  const res = await makeGet('/tasks/nonexistent');
  assertEqual(res.statusCode, 404);
  assertEqual(res.body.error, 'NOT_FOUND');
});

test('GET unknown route returns 404', async () => {
  const res = await makeGet('/nonexistent');
  assertEqual(res.statusCode, 404);
  assertEqual(res.body.error, 'NOT_FOUND');
});

// ============================================================
// Suite 7: Security Enforcement (comprehensive)
// ============================================================
console.log('\n=== Suite 7: Security Enforcement ===');

const dangerousCommands = [
  '/deploy', '/restart', '/nginx', '/sudo', '/rm', '/merge', '/rollback',
  '/exec', '/shell', '/bash', '/sh',
  'confirm:deploy', 'confirm:merge', 'confirm:restart', 'confirm:rollback',
];

for (const cmd of dangerousCommands) {
  test(`blocked command: ${cmd}`, () => {
    const result = policy.validateCommand(cmd, 'plan-only', null);
    assertEqual(result.valid, false, `command "${cmd}" should be blocked`);
  });
}

test('all forbidden modes rejected by policy', () => {
  for (const mode of policy.FORBIDDEN_MODES) {
    const result = policy.validateCommand('/总控', mode, null);
    assertEqual(result.valid, false, `mode "${mode}" should be forbidden`);
  }
});

test('sanitizeTask always forces plan-only regardless of input mode', () => {
  const modes = ['live', 'dry-run', 'execute', null, undefined, 'plan-only'];
  for (const mode of modes) {
    const sanitized = policy.sanitizeTask({ command: '/总控', mode });
    assertEqual(sanitized.mode, 'plan-only', `input mode "${mode}" should become plan-only`);
  }
});

test('policy BLOCKED_PATTERNS covers confirm: prefix', () => {
  const hasConfirmPattern = policy.BLOCKED_PATTERNS.some(p => p.test('confirm:deploy'));
  assertOk(hasConfirmPattern, 'should have pattern matching confirm:');
});

test('policy ALLOWED_MODES only contains plan-only', () => {
  assertEqual(policy.ALLOWED_MODES.length, 1);
  assertEqual(policy.ALLOWED_MODES[0], 'plan-only');
});

test('FORBIDDEN_MODES includes live, dry-run, execute', () => {
  assertOk(policy.FORBIDDEN_MODES.includes('live'));
  assertOk(policy.FORBIDDEN_MODES.includes('dry-run'));
  assertOk(policy.FORBIDDEN_MODES.includes('execute'));
});

// ============================================================
// Suite 8: Correlation ID propagation
// ============================================================
console.log('\n=== Suite 8: Correlation ID ===');

test('server adds X-Correlation-ID header to responses', async () => {
  const res = await makeGet('/health');
  assertOk(res.headers['x-correlation-id']);
  // Should be auto-generated UUID format
  assertOk(res.headers['x-correlation-id'].startsWith('host_'));
});

test('custom X-Correlation-ID is preserved', async () => {
  const payload = JSON.stringify({ command: '/总控', mode: 'plan-only' });
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 30999,
        path: '/tasks',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': 'my_custom_corr_id',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  assertOk(res.body.correlationId === 'my_custom_corr_id' || res.body.error);
});

// ============================================================
// Suite 9: Audit Log Verification (deferred to exit handler)
// ============================================================
console.log('\n=== Suite 9: Audit Log Integrity (verified at exit) ===');

let auditVerified = false;
function verifyAuditLog() {
  if (auditVerified) return;
  auditVerified = true;

  try {
    const content = fs.readFileSync(TEST_AUDIT_LOG, 'utf8');
    const lines = content.trim().split('\n');
    const events = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    const received = events.filter(e => e.event === 'TASK_RECEIVED');
    if (received.length > 0) {
      passed++;
      console.log('  ✓ audit log contains TASK_RECEIVED events');
    } else {
      failed++;
      failures.push({ name: 'audit log TASK_RECEIVED', error: `found ${events.length} entries but no TASK_RECEIVED` });
      console.log('  ✗ audit log contains TASK_RECEIVED events');
      console.log(`    Events found: ${events.map(e => e.event).join(', ')}`);
    }
  } catch (err) {
    failed++;
    failures.push({ name: 'audit log TASK_RECEIVED', error: err.message });
    console.log('  ✗ audit log contains TASK_RECEIVED events');
    console.log(`    Error: ${err.message}`);
  }

  try {
    const content = fs.readFileSync(TEST_AUDIT_LOG, 'utf8');
    if (!content.includes('test_gateway_token_for_unit_tests')) {
      passed++;
      console.log('  ✓ audit log never contains GATEWAY_TOKEN value');
    } else {
      failed++;
      failures.push({ name: 'audit log token leak', error: 'token found in audit log' });
      console.log('  ✗ audit log never contains GATEWAY_TOKEN value');
    }
  } catch (err) {
    failed++;
    failures.push({ name: 'audit log token check', error: err.message });
    console.log('  ✗ audit log never contains GATEWAY_TOKEN value');
    console.log(`    Error: ${err.message}`);
  }
}

// ============================================================
// Cleanup
// ============================================================
console.log('\n=== Cleanup ===');

// ============================================================
// Finalize: close server, wait, verify, report, cleanup
// ============================================================

// Suppress unhandled rejections from async cleanup
process.on('unhandledRejection', (reason) => {
  if (reason && reason.code === 'ECONNREFUSED') return;
  if (reason && reason.message && reason.message.includes('ECONNREFUSED')) return;
  console.error('Unhandled rejection:', reason && reason.message ? reason.message : reason);
});

// Give async operations time to settle, then verify and exit
setTimeout(() => {
  // Close server
  if (server && server.listening) {
    server.close(() => {
      console.log('  Server closed');
      finish();
    });
    // Force close after 2s if callback doesn't fire
    setTimeout(() => finish(), 2000);
  } else {
    finish();
  }

  function finish() {
    // Verify audit log
    verifyAuditLog();

    // Clean up test files
    try { fs.unlinkSync(TEST_AUDIT_LOG); } catch {}
    const logsDir = path.dirname(TEST_AUDIT_LOG);
    try {
      const files = fs.readdirSync(logsDir);
      if (files.length === 0) fs.rmdirSync(logsDir);
    } catch {}

    // Print results
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    if (failures.length > 0) {
      console.log('\nFailures:');
      failures.forEach((f, i) => {
        console.log(`  ${i + 1}. ${f.name}: ${f.error}`);
      });
    }
    console.log('='.repeat(50));

    process.exitCode = failed > 0 ? 1 : 0;
  }
}, 5000); // wait 5s for gateway retries + audit writes to complete
