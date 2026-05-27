/**
 * task-store.js - In-memory task status store
 *
 * Tracks task lifecycle: pending → running → completed/failed
 */

const { v4: uuidv4 } = require('uuid');

const tasks = new Map();

// Max tasks to keep in memory
const MAX_TASKS = 1000;

/**
 * Create a new task record.
 * @param {{ command: string, mode: string, agent?: string }} payload
 * @param {string} correlationId
 * @returns {{ taskId: string, status: string, createdAt: string }}
 */
function create(payload, correlationId) {
  const taskId = `host_${Date.now()}_${uuidv4().slice(0, 8)}`;
  const record = {
    taskId,
    status: 'pending',
    command: payload.command,
    mode: payload.mode,
    agent: payload.agent || null,
    correlationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    gatewayResponse: null,
    retryCount: 0,
    error: null,
  };
  tasks.set(taskId, record);

  // Evict oldest if over max
  if (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next().value;
    tasks.delete(oldest);
  }

  return record;
}

/**
 * Get a task by ID.
 * @param {string} taskId
 * @returns {object|undefined}
 */
function get(taskId) {
  return tasks.get(taskId);
}

/**
 * Update task status.
 * @param {string} taskId
 * @param {object} updates
 */
function update(taskId, updates) {
  const task = tasks.get(taskId);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  return task;
}

/**
 * Mark task as running.
 * @param {string} taskId
 */
function markRunning(taskId) {
  return update(taskId, { status: 'running' });
}

/**
 * Mark task as completed with gateway response.
 * @param {string} taskId
 * @param {object} gatewayResponse
 */
function markCompleted(taskId, gatewayResponse) {
  return update(taskId, { status: 'completed', gatewayResponse });
}

/**
 * Mark task as failed.
 * @param {string} taskId
 * @param {string} error
 * @param {number} retryCount
 */
function markFailed(taskId, error, retryCount) {
  return update(taskId, { status: 'failed', error, retryCount });
}

/**
 * Increment retry count.
 * @param {string} taskId
 */
function incrementRetry(taskId) {
  const task = tasks.get(taskId);
  if (!task) return null;
  task.retryCount += 1;
  task.updatedAt = new Date().toISOString();
  return task;
}

/**
 * List all tasks (summary).
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function list(limit = 50) {
  return Array.from(tasks.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(t => ({
      taskId: t.taskId,
      status: t.status,
      command: t.command,
      mode: t.mode,
      createdAt: t.createdAt,
      retryCount: t.retryCount,
    }));
}

/**
 * Clear all tasks (for testing).
 */
function clear() {
  tasks.clear();
}

/**
 * Get task count.
 * @returns {number}
 */
function count() {
  return tasks.size;
}

module.exports = {
  create,
  get,
  update,
  markRunning,
  markCompleted,
  markFailed,
  incrementRetry,
  list,
  clear,
  count,
};
