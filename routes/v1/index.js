/**
 * /api/v1/patient and /api/v1/dietician - AI_EXECUTION_PLAN.md Phase 5, P5-01.
 *
 * Each v1 router registers its own new endpoints (dashboard, unread-count)
 * FIRST, then falls through to the exact same legacy router used at
 * /api/patient and /api/dietician (routes/patient.js, routes/dietician.js)
 * via router.use(...) with no path prefix - mounting the same Express
 * Router instance at a second base path is standard/safe (the router has
 * no memory of which mount matched), so every existing endpoint becomes
 * available under /api/v1/* too with zero duplication and zero risk of the
 * two diverging. Legacy /api/patient and /api/dietician are untouched (see
 * config/createApp.js) - this is purely additive.
 */

const express = require('express');

const authenticate = require('../../middlewares/auth');
const { roleCheck, dieticianOnly } = require('../../middlewares/roleCheck');
const dashboardV1Controller = require('../../controllers/dashboardV1Controller');
const notificationController = require('../../controllers/notificationController');
const patientRoutes = require('../patient');
const dieticianRoutes = require('../dietician');

const patientOnly = [authenticate, roleCheck('patient')];
const dieticianOnlyMiddleware = [authenticate, dieticianOnly];

const v1Patient = express.Router();

/**
 * @route   GET /api/v1/patient/dashboard
 */
v1Patient.get('/dashboard', patientOnly, dashboardV1Controller.getPatientDashboard);

/**
 * @route   GET /api/v1/patient/notifications/count
 * @desc    Same data as the existing GET /api/patient/notifications/unread-count
 *          (left untouched) under the path name AI_EXECUTION_PLAN.md Phase 5
 *          asks for.
 */
v1Patient.get('/notifications/count', patientOnly, notificationController.getUnreadCount);

v1Patient.use(patientRoutes);

const v1Dietician = express.Router();

/**
 * @route   GET /api/v1/dietician/dashboard
 */
v1Dietician.get('/dashboard', dieticianOnlyMiddleware, dashboardV1Controller.getDieticianDashboard);

v1Dietician.use(dieticianRoutes);

module.exports = { v1Patient, v1Dietician };
