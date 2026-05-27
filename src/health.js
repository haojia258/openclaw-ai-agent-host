/**
 * health.js - Health check endpoint logic
 */

const os = require('os');
const { count: taskCount } = require('./task-store');

const startTime = new Date().toISOString();

/**
 * Get health status.
 * @returns {{ status: string, version: string, uptimeSeconds: number, taskCount: number, memoryMB: number }}
 */
function getHealth() {
  return {
    status: 'ok',
    service: 'openclaw-ai-agent-host',
    version: 'v1.0.0',
    startedAt: startTime,
    uptimeSeconds: Math.floor(process.uptime()),
    taskCount: taskCount(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    hostname: os.hostname(),
  };
}

module.exports = { getHealth };
