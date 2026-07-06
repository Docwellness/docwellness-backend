/**
 * Chat Middleware - Request ID, Trace ID, and Logging
 */

const crypto = require('crypto');
const ChatLogger = require('../services/ChatLogger');

const { EVENTS } = ChatLogger;

/**
 * Generate unique request ID
 */
function generateRequestId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Generate trace ID
 */
function generateTraceId() {
  return `trace_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Request context middleware
 * Adds request_id, trace_id to request and response
 */
function requestContext(req, res, next) {
  // Generate or use provided IDs
  req.requestId = req.headers['x-request-id'] || generateRequestId();
  req.traceId = req.headers['x-trace-id'] || generateTraceId();

  // Add to response headers
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Trace-Id', req.traceId);

  // Create log context
  req.logContext = {
    request_id: req.requestId,
    trace_id: req.traceId,
    user_id: req.user?._id || null,
  };

  next();
}

/**
 * Request logging middleware
 * Logs request start and response
 */
function requestLogging(req, res, next) {
  const startTime = Date.now();

  // Log request start
  ChatLogger.info(EVENTS.REST_REQUEST, {
    request_id: req.requestId,
    trace_id: req.traceId,
    method: req.method,
    path: req.path,
    user_id: req.user?._id,
  });

  // Intercept response
  const originalSend = res.send;
  res.send = function (body) {
    ChatLogger.timed(EVENTS.REST_RESPONSE, startTime, {
      request_id: req.requestId,
      trace_id: req.traceId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      user_id: req.user?._id,
    });

    return originalSend.call(this, body);
  };

  next();
}

/**
 * Idempotency key middleware
 * Checks for and handles duplicate requests
 */
const IdempotencyService = require('../services/IdempotencyService');

async function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey || !req.user) {
    return next();
  }

  try {
    const existing = await IdempotencyService.checkKey(
      idempotencyKey,
      req.user._id,
      req.path,
      req.method
    );

    if (existing) {
      return res.status(existing.statusCode).json(existing.body);
    }

    // Store key reference for later
    req.idempotencyKey = idempotencyKey;

    // Override res.json to store response
    const originalJson = res.json.bind(res);
    res.json = async function (body) {
      await IdempotencyService.storeResponse(idempotencyKey, req.user._id, res.statusCode, body);
      return originalJson(body);
    };

    next();
  } catch (error) {
    if (error.message === 'Request in progress') {
      return res.status(409).json({
        success: false,
        message: 'Request with this idempotency key is already in progress',
      });
    }
    next(error);
  }
}

/**
 * Rate limiting (simple in-memory implementation)
 * NOTE: For production, use Redis-based rate limiting
 */
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // requests per window

function rateLimit(req, res, next) {
  if (!req.user) return next();

  const key = `rate:${req.user._id}:${req.path}`;
  const now = Date.now();

  let entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry = { windowStart: now, count: 0 };
  }

  entry.count++;
  rateLimitStore.set(key, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000);

    ChatLogger.warn(EVENTS.RATE_LIMIT_HIT, {
      ...req.logContext,
      path: req.path,
      retry_after_ms: retryAfter * 1000,
    });

    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      success: false,
      message: 'Too many requests',
      retry_after_ms: retryAfter * 1000,
    });
  }

  next();
}

// Clean up rate limit store periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000);

module.exports = {
  requestContext,
  requestLogging,
  idempotencyMiddleware,
  rateLimit,
  generateRequestId,
  generateTraceId,
};
