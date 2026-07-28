require('./config/instrument');
// Some local Windows/VPN network setups hand Node's DNS resolver a server
// it can't actually reach over UDP (even though the OS resolver succeeds
// via a different path) - breaks mongodb+srv:// lookups specifically with
// ECONNREFUSED on querySrv. Public resolvers as a fallback fix that without
// touching the OS/network config; harmless everywhere else (incl. prod).
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const http = require('http');
const { Server } = require('socket.io');
const connectDB = require('./config/database');
const config = require('./config/environment');
const createApp = require('./config/createApp');
const { initializeChatSocket } = require('./sockets');

// v1 Chat Module (see socket/chat-socket.js - the canonical entrypoint per
// AI_EXECUTION_PLAN.md Phase 4, P4-06 - which re-exports the actual
// implementation in chat/socket/index.js)
const { initializeChatSocketV1 } = require('./socket/chat-socket');

const app = createApp();

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Optional Socket.IO Redis adapter (AI_EXECUTION_PLAN.md Phase 5, P5-07) -
// only attempted when REDIS_URL is configured; a single-process deployment
// (today's setup) works fine without it, since io's default in-memory
// adapter already broadcasts to every locally-connected socket. This only
// matters once the backend runs as more than one process/instance, where
// io.to(room).emit() needs to reach sockets connected to a *different*
// process - the in-memory adapter can't do that on its own.
if (config.redisUrl) {
  try {
    // eslint-disable-next-line global-require
    const Redis = require('ioredis');
    // eslint-disable-next-line global-require
    const { createAdapter } = require('@socket.io/redis-adapter');
    // maxRetriesPerRequest: null - required for a long-lived pub/sub client
    // (ioredis' own documented recommendation for this exact case). The
    // adapter issues SUBSCRIBE commands that don't resolve while
    // disconnected; ioredis' default (fail after N retries) rejects that
    // command's promise with nothing to catch it in @socket.io/redis-adapter,
    // which surfaces as an unhandled rejection and kills the whole process
    // (see app.js's own `unhandledRejection` handler below) - confirmed via
    // a real reproduction against an unreachable Redis before this was set.
    // null instead queues commands until reconnected, matching the
    // reconnect-forever retryStrategy above instead of racing against it.
    const pubClient = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (err) => console.error('[redis-adapter] pub error:', err.message));
    subClient.on('error', (err) => console.error('[redis-adapter] sub error:', err.message));
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[redis-adapter] Socket.IO Redis adapter attached');
  } catch (err) {
    // Never let a bad/unreachable Redis prevent the server from starting -
    // falls back to the default in-memory adapter (single-process behavior,
    // same as when REDIS_URL isn't set at all).
    console.error('[redis-adapter] failed to attach, falling back to in-memory adapter:', err.message);
  }
}

// Initialize chat socket handlers (original) - gated by
// LEGACY_SOCKET_COMPAT (default true, i.e. opt-out) so legacy clients keep
// working during migration, per AI_EXECUTION_PLAN.md Phase 4, P4-08. Both
// handlers register on the SAME io instance and now join the same
// user:{id}/conv:{id} rooms (see P4-02), so a message routed through
// either system reaches a socket regardless of which handler's connection
// listener ran for it.
if (config.legacySocketCompat) {
  initializeChatSocket(io);
}

// Initialize v1 chat socket handlers (enhanced)
initializeChatSocketV1(io);

// Make io accessible to routes if needed
app.set('io', io);

// Connect to database and start server
const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Start server
    server.listen(config.port, '0.0.0.0', () => {
      console.log(`DocWellness API running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`Local API URL: http://localhost:${config.port}/api`);
      console.log(`Network API URL: http://[YOUR_IP]:${config.port}/api`);
      console.log(`Health Check: http://localhost:${config.port}/health`);
      console.log(`Chat v1 API: http://localhost:${config.port}/api/v1/chat`);
      console.log(`Chat Logs: ./logs/chat-service-*.log`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.error(`Unhandled Rejection: ${err.message}`);
  server.close(() => process.exit(1));
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Process terminated.');
    process.exit(0);
  });
});

// Start the server
startServer();
