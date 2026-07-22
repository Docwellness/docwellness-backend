const express = require('express');
const cors = require('cors');
const path = require('path');
const Sentry = require('@sentry/node');
const { errorHandler } = require('../middlewares');

// v1 Chat Module
const { chatRoutes } = require('../chat');

// Import routes
const { patientRoutes, dieticianRoutes, internalRoutes } = require('../routes');

function createApp() {
  const app = express();

  // CORS configuration - allow all origins (mobile app doesn't need CORS restrictions)
  app.use(
    cors({
      origin: '*',
      credentials: false,
    })
  );

  // Body parser
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files (uploads)
  app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

  // v1 Chat API Routes (WhatsApp-like messaging)
  app.use('/api/v1/chat', chatRoutes);

  // Patient API Routes (Primary focus for Flutter frontend)
  app.use('/api/patient', patientRoutes);

  // Dietician API Routes
  app.use('/api/dietician', dieticianRoutes);

  // Internal/cron-triggered routes (shared-secret auth, not user JWT)
  app.use('/api/internal', internalRoutes);

  // Health check route
  app.get('/health', (req, res) => {
    res.status(200).json({
      success: true,
      message: 'DocWellness API is running',
      timestamp: new Date().toISOString(),
    });
  });

  // API documentation route
  app.get('/api', (req, res) => {
    res.status(200).json({
      success: true,
      message: 'Welcome to DocWellness API',
      version: '1.0.0',
      documentation: 'Patient API endpoints for Flutter frontend',
      endpoints: {
        patient: {
          base: '/api/patient',
          auth: {
            register: 'POST /api/patient/auth/register',
            login: 'POST /api/patient/auth/login',
            me: 'GET /api/patient/auth/me',
            logout: 'POST /api/patient/auth/logout',
            forgotPassword: 'POST /api/patient/auth/forgot-password',
            resetPassword: 'POST /api/patient/auth/reset-password/:token',
            changePassword: 'PUT /api/patient/auth/change-password',
          },
          profile: {
            get: 'GET /api/patient/profile',
            update: 'PUT /api/patient/profile',
            uploadImage: 'POST /api/patient/profile/image',
            delete: 'DELETE /api/patient/profile',
            healthProfile: 'GET/PUT /api/patient/health-profile',
          },
          mealLogs: {
            create: 'POST /api/patient/meal-logs',
            getAll: 'GET /api/patient/meal-logs',
            getToday: 'GET /api/patient/meal-logs/today',
            getStats: 'GET /api/patient/meal-logs/stats',
            getById: 'GET /api/patient/meal-logs/:id',
            update: 'PUT /api/patient/meal-logs/:id',
            delete: 'DELETE /api/patient/meal-logs/:id',
          },
          progress: {
            create: 'POST /api/patient/progress',
            getAll: 'GET /api/patient/progress',
            getStats: 'GET /api/patient/progress/stats',
            getGoal: 'GET /api/patient/progress/goal',
            getById: 'GET /api/patient/progress/:id',
            update: 'PUT /api/patient/progress/:id',
            uploadImages: 'POST /api/patient/progress/:id/images',
            delete: 'DELETE /api/patient/progress/:id',
          },
          payments: {
            createOrder: 'POST /api/patient/payments/create-order',
            verify: 'POST /api/patient/payments/verify',
            history: 'GET /api/patient/payments',
            getById: 'GET /api/patient/payments/:id',
            receipt: 'GET /api/patient/payments/:id/receipt',
            refund: 'POST /api/patient/payments/:id/refund',
          },
        },
      },
    });
  });

  // 404 handler
  app.use((req, res, next) => {
    res.status(404).json({
      success: false,
      message: `Route ${req.originalUrl} not found`,
    });
  });

  // Sentry needs to see errors before our own handler formats/logs them.
  // No-ops when SENTRY_DSN isn't configured.
  Sentry.setupExpressErrorHandler(app);

  // Global error handler
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
