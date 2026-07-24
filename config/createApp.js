const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const Sentry = require('@sentry/node');
const config = require('./environment');
const { errorHandler, requestLogger, sanitizeInput } = require('../middlewares');

// v1 Chat Module
const { chatRoutes } = require('../chat');

// Import routes
const { patientRoutes, dieticianRoutes, internalRoutes } = require('../routes');

function createApp() {
  const app = express();

  // Both deployment targets (Vercel serverless, and the VPS behind nginx -
  // see .github/workflows/deploy-dev-vps.yml) sit behind exactly one
  // reverse proxy hop. Without this, req.ip (and therefore every rate
  // limiter's default per-IP bucket - see middlewares/rateLimiters.js)
  // resolves to the proxy's own IP for every request, not the real
  // client's - collapsing all traffic into a single shared bucket instead
  // of limiting per-user. `1` = trust the X-Forwarded-For value set by
  // that one hop, no further back.
  app.set('trust proxy', 1);

  // Security headers (helmet) and gzip/deflate compression - both purely
  // additive, no behavior change for a well-formed request/response.
  // contentSecurityPolicy is off: this is a pure JSON API consumed by
  // native mobile apps, not a server-rendered site - a CSP header has no
  // effect on API responses and helmet's default policy is meant for HTML
  // pages, so leaving it enabled would just be dead configuration.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());

  // Structured request logging with a per-request id (see
  // middlewares/requestLogger.js) - registered early so every request gets
  // logged/timed regardless of where it fails.
  app.use(requestLogger);

  // CORS configuration. Native mobile apps (Dio/http don't send an Origin
  // header the way browsers do), curl, Postman, and server-to-server calls
  // are always allowed - CORS is a browser-enforced mechanism and doesn't
  // apply to them regardless. For a browser-based consumer (e.g. a Flutter
  // web build), only CLIENT_ORIGIN/DIETICIAN_ORIGIN are allowed once
  // configured; until then this stays as permissive as the previous
  // wildcard, so setting those env vars is what locks CORS down (see
  // docs/SECURITY.md and .env.example) rather than a prerequisite for the
  // app to keep working today.
  const allowedOrigins = [config.clientOrigin, config.dieticianOrigin].filter(Boolean);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: false,
    })
  );

  // Body parser
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Strips any key starting with '$' or containing '.' from req.body/
  // req.params (NoSQL injection prevention - a key like {"$gt": ""}
  // reaching a Mongoose query unsanitized could bypass an intended
  // filter). See middlewares/sanitizeInput.js for why this is NOT
  // express-mongo-sanitize's own middleware() export used directly - it
  // throws on every request under Express 5 (confirmed empirically).
  app.use(sanitizeInput);

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
