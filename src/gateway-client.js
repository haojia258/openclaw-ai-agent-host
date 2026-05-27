/**
 * gateway-client.js - HTTP client for wecom-openclaw Gateway
 *
 * Calls POST /gateway/command with:
 *  - Auto-generated requestId (UUID)
 *  - Auto-filled timestamp (Unix ms)
 *  - GATEWAY_TOKEN from env
 *  - Correlation ID for tracing
 *  - Retry up to MAX_RETRIES times
 */

const http = require('http');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { sanitizeBody } = require('./audit-log');

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '1000', 10);

/**
 * Get gateway config from env.
 * @returns {{ url: string, token: string }}
 */
function getGatewayConfig() {
  const url = process.env.GATEWAY_URL || 'http://localhost:3001';
  const token = process.env.GATEWAY_TOKEN;
  if (!token) {
    throw new Error('GATEWAY_TOKEN not configured in environment');
  }
  return { url, token };
}

/**
 * Build the gateway request body.
 * @param {string} command
 * @param {string} mode
 * @param {string} [agent]
 * @param {string} correlationId
 * @returns {object}
 */
function buildRequestBody(command, mode, agent, correlationId, user, source) {
  return {
    requestId: uuidv4(),
    timestamp: Date.now(),
    command,
    mode,
    user: user || "",
    source: source || "unknown",
    ...(agent ? { agent } : {}),
  };
}

/**
 * Parse a URL into components for http.request.
 * @param {string} urlStr
 * @returns {{ protocol: string, hostname: string, port: number, path: string }}
 */
function parseUrl(urlStr) {
  const u = new URL(urlStr);
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
  };
}

/**
 * Make a single HTTP request to the gateway.
 * @param {{ hostname: string, port: number, path: string, protocol: string }} urlParts
 * @param {string} token
 * @param {object} body
 * @param {string} correlationId
 * @returns {Promise<{ statusCode: number, headers: object, body: object, requestId: string }>}
 */
function makeRequest(urlParts, token, body, correlationId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const transport = urlParts.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: urlParts.hostname,
        port: urlParts.port,
        path: '/gateway/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Gateway-Token': token,
          'X-Correlation-ID': correlationId,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = { raw: data };
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            requestId: body.requestId,
          });
        });
      },
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gateway request timeout (30s)'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Call the gateway with retry logic.
 *
 * @param {string} command - the command to execute
 * @param {string} mode - execution mode (must be plan-only)
 * @param {string} [agent] - optional agent
 * @param {string} correlationId - correlation ID for tracing
 * @param {function} onRetry - callback(retryNumber, error) for each retry
 * @returns {Promise<{ success: boolean, statusCode?: number, body?: object, error?: string, attempts: number }>}
 */
async function callGateway(command, mode, agent, correlationId, onRetry, user, source) {
  const { url, token } = getGatewayConfig();
  const urlParts = parseUrl(url);
  const body = buildRequestBody(command, mode, agent, correlationId, user, source);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const result = await makeRequest(urlParts, token, body, correlationId);
      return {
        success: true,
        statusCode: result.statusCode,
        body: result.body,
        requestId: result.requestId,
        attempts: attempt,
      };
    } catch (err) {
      const isLastAttempt = attempt > MAX_RETRIES;
      if (isLastAttempt) {
        return {
          success: false,
          error: err.message,
          attempts: attempt,
        };
      }
      // Retry on network errors only
      if (onRetry) {
        onRetry(attempt, err.message);
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getGatewayConfig,
  buildRequestBody,
  callGateway,
  MAX_RETRIES,
  RETRY_DELAY_MS,
};
