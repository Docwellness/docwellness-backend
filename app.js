require('./config/instrument');
const http = require('http');
const { Server } = require('socket.io');
const connectDB = require('./config/database');
const config = require('./config/environment');
const createApp = require('./config/createApp');
const { initializeChatSocket } = require('./sockets');

// v1 Chat Module
const { initializeChatSocketV1 } = require('./chat');

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

// Initialize chat socket handlers (original)
initializeChatSocket(io);

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
