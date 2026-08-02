/**
 * Patient Controllers Index
 * Exports all patient-related controllers
 */

const authController = require('./authController');
const profileController = require('./profileController');
const progressController = require('./progressController');
const paymentController = require('./paymentController');
const dietPlanRequestController = require('./dietPlanRequestController');
const dietController = require('./dietController');
const mealLogController = require('./mealLogController');
const waterController = require('./waterController');
const journeyController = require('./journeyController');
const couponController = require('./couponController');
const firstConsultationController = require('./firstConsultationController');
const timelineController = require('./timelineController');
const exerciseController = require('./exerciseController');

module.exports = {
  authController,
  profileController,
  progressController,
  paymentController,
  dietPlanRequestController,
  dietController,
  mealLogController,
  waterController,
  journeyController,
  couponController,
  firstConsultationController,
  timelineController,
  exerciseController,
};
