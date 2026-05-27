/**
 * audit-log.js - JSONL audit logging for Agent Host
 *
 * Requirements:
 *  - Never log tokens
 *  - Always include correlationId
 *  - Sanitize request/response bodies
 *  - Write to host-audit.log
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = path.join(__dirname, '..', 'logs', 'host-audit.log');

let logPath = process.env.AUDIT_LOG_PATH || DEFAULT_LOG_PATH;
let writeQueue = Promise.resolve();

/**
 * Set the audit log path (for testing).
 * @param {string} p
 */
function setLogPath(p) {
  logPath = p;
}

/**
 * Get the current log path.
 * @returns {string}
 */
function getLogPath() {
  return logPath;
}

/**
 * Mask a body for audit — remove sensitive fields.
 * @param {object} body
 * @returns {object}
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const sanitized = { ...body };
  // Redact any token-like fields
  const sensitiveKeys = ['token', 'gatewayToken', 'gateway_token', 'GATEWAY_TOKEN',
    'bridgeToken', 'bridge_token', 'BRIDGE_TOKEN', 'authorization', 'Authorization',
    'password', 'secret', 'apiKey', 'api_key'];
  for (const key of sensitiveKeys) {
    if (sanitized[key] !== undefined) {
      sanitized[key] = '***REDACTED***';
    }
  }
  return sanitized;
}

/**
 * Log an audit entry.
 * @param {object} entry
 * @param {string} entry.event - event type (TASK_RECEIVED, GATEWAY_CALL, GATEWAY_RESPONSE, TASK_COMPLETED, TASK_FAILED, RETRY)
 * @param {string} entry.correlationId
 * @param {string} [entry.taskId]
 * @param {object} [entry.meta] - additional sanitized metadata
 */
function log(entry) {
  return new Promise((resolve, reject) => {
    // Use a queue to serialize writes
    writeQueue = writeQueue.then(() => {
      return new Promise((res) => {
        const record = {
          timestamp: new Date().toISOString(),
          ...entry,
        };
        const line = JSON.stringify(record) + '\n';

        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.appendFile(logPath, line, (err) => {
          if (err) {
            console.error('[audit-log] Write error:', err.message);
            reject(err);
          } else {
            resolve();
          }
          res();
        });
      });
    }).then(resolve).catch(reject);
  });
}

module.exports = {
  setLogPath,
  getLogPath,
  sanitizeBody,
  log,
};
