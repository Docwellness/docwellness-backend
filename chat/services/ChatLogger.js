/**
 * ChatLogger - JSONL Logging Service
 * Writes structured logs to both console and daily JSONL files
 * Uses pino for high-performance logging
 */

const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const LOGS_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Log levels
 */
const LOG_LEVELS = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/**
 * Event taxonomy
 */
const EVENTS = {
  // WebSocket
  WS_CONNECT: 'WS_CONNECT',
  WS_AUTH_OK: 'WS_AUTH_OK',
  WS_AUTH_FAIL: 'WS_AUTH_FAIL',
  WS_DISCONNECT: 'WS_DISCONNECT',

  // Chat
  CHAT_JOIN: 'CHAT_JOIN',
  CHAT_LEAVE: 'CHAT_LEAVE',

  // Messages
  MSG_SEND: 'MSG_SEND',
  MSG_DEDUP_HIT: 'MSG_DEDUP_HIT',
  MSG_SEQ_ALLOC: 'MSG_SEQ_ALLOC',
  MSG_PERSISTED: 'MSG_PERSISTED',
  MSG_ACK: 'MSG_ACK',
  MSG_FANOUT: 'MSG_FANOUT',
  MSG_DELIVERED: 'MSG_DELIVERED',
  MSG_UPDATED: 'MSG_UPDATED',
  MSG_UPDATED_FANOUT: 'MSG_UPDATED_FANOUT',

  // Conversation
  CONV_READ: 'CONV_READ',
  CONV_CREATED: 'CONV_CREATED',
  CONV_FETCH: 'CONV_FETCH',

  // Typing & Presence
  TYPING_START: 'TYPING_START',
  TYPING_STOP: 'TYPING_STOP',
  PRESENCE_ONLINE: 'PRESENCE_ONLINE',
  PRESENCE_OFFLINE: 'PRESENCE_OFFLINE',
  PRESENCE_PING: 'PRESENCE_PING',

  // Media
  MEDIA_PRESIGN: 'MEDIA_PRESIGN',

  // Link Preview
  LINK_PREVIEW_FETCH: 'LINK_PREVIEW_FETCH',
  LINK_PREVIEW_OK: 'LINK_PREVIEW_OK',
  LINK_PREVIEW_FAIL: 'LINK_PREVIEW_FAIL',
  LINK_PREVIEW_CACHE_HIT: 'LINK_PREVIEW_CACHE_HIT',

  // Rate Limiting
  RATE_LIMIT_HIT: 'RATE_LIMIT_HIT',

  // Meal Log
  MEAL_LOG_EVENT_IN: 'MEAL_LOG_EVENT_IN',
  MEAL_LOG_DEDUP_OK: 'MEAL_LOG_DEDUP_OK',
  MEAL_LOG_DEDUP_HIT: 'MEAL_LOG_DEDUP_HIT',
  MSG_MEAL_LOG_UPDATED: 'MSG_MEAL_LOG_UPDATED',

  // Client
  CLIENT_RENDER_ACK: 'CLIENT_RENDER_ACK',

  // REST
  REST_REQUEST: 'REST_REQUEST',
  REST_RESPONSE: 'REST_RESPONSE',

  // Errors
  ERROR: 'ERROR',
};

/**
 * Get current date string for log file naming
 */
function getDateString() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Get log file path for current date
 */
function getLogFilePath() {
  return path.join(LOGS_DIR, `chat-service-${getDateString()}.log`);
}

/**
 * Write log entry to file (append mode)
 */
function writeToFile(logEntry) {
  const logLine = JSON.stringify(logEntry) + '\n';
  fs.appendFileSync(getLogFilePath(), logLine, { encoding: 'utf8' });
}

/**
 * Format log entry with all required fields
 */
function formatLogEntry(level, event, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'chat-service',
    event,
    ...data,
  };

  // Ensure required fields have defaults
  if (!entry.trace_id) entry.trace_id = null;
  if (!entry.request_id && !entry.session_id) entry.request_id = null;
  if (!entry.user_id) entry.user_id = null;
  if (!entry.conversation_id) entry.conversation_id = null;
  if (!entry.message_id) entry.message_id = null;

  return entry;
}

/**
 * Main logging function
 */
function log(level, event, data = {}) {
  const entry = formatLogEntry(level, event, data);

  // Write to console with color coding
  const consolePrefix = getConsolePrefix(level);
  console.log(`${consolePrefix} [${event}]`, JSON.stringify(data, null, 0));

  // Write to JSONL file
  try {
    writeToFile(entry);
  } catch (err) {
    console.error('Failed to write log to file:', err.message);
  }

  return entry;
}

/**
 * Get colored console prefix
 */
function getConsolePrefix(level) {
  const timestamp = new Date().toISOString();
  switch (level) {
    case LOG_LEVELS.DEBUG:
      return `\x1b[36m[${timestamp}] DEBUG:\x1b[0m`;
    case LOG_LEVELS.INFO:
      return `\x1b[32m[${timestamp}] INFO:\x1b[0m`;
    case LOG_LEVELS.WARN:
      return `\x1b[33m[${timestamp}] WARN:\x1b[0m`;
    case LOG_LEVELS.ERROR:
      return `\x1b[31m[${timestamp}] ERROR:\x1b[0m`;
    default:
      return `[${timestamp}]`;
  }
}

/**
 * Convenience methods
 */
const ChatLogger = {
  EVENTS,
  LOG_LEVELS,

  debug(event, data = {}) {
    return log(LOG_LEVELS.DEBUG, event, data);
  },

  info(event, data = {}) {
    return log(LOG_LEVELS.INFO, event, data);
  },

  warn(event, data = {}) {
    return log(LOG_LEVELS.WARN, event, data);
  },

  error(event, data = {}) {
    if (data.error instanceof Error) {
      data.error = {
        message: data.error.message,
        stack: data.error.stack,
        name: data.error.name,
      };
    }
    return log(LOG_LEVELS.ERROR, event, data);
  },

  /**
   * Create a child logger with preset context
   */
  child(context = {}) {
    return {
      debug: (event, data = {}) => ChatLogger.debug(event, { ...context, ...data }),
      info: (event, data = {}) => ChatLogger.info(event, { ...context, ...data }),
      warn: (event, data = {}) => ChatLogger.warn(event, { ...context, ...data }),
      error: (event, data = {}) => ChatLogger.error(event, { ...context, ...data }),
    };
  },

  /**
   * Log with timing
   */
  timed(event, startTime, data = {}) {
    const latencyMs = Date.now() - startTime;
    return log(LOG_LEVELS.INFO, event, { ...data, latency_ms: latencyMs });
  },

  /**
   * Get logs directory path
   */
  getLogsDir() {
    return LOGS_DIR;
  },
};

module.exports = ChatLogger;
