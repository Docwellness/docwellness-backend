/**
 * Patient Routes
 * All routes are prefixed with /api/patient
 * These routes are accessible only to patients
 */

const express = require('express');
const router = express.Router();

// Import middlewares
const authenticate = require('../middlewares/auth');
const { roleCheck } = require('../middlewares/roleCheck');
const {
  validateRegister,
  validateLogin,
  validateUpdateProfile,
  validateManualPaymentProof,
} = require('../middlewares/validation');

// Import patient controllers
const {
  authController,
  profileController,
  mealLogController,
  progressController,
  paymentController,
  dietPlanRequestController,
  dietController,
  waterController,
  journeyController,
  firstConsultationController,
} = require('../controllers/patient');
const {
  consultationFormController,
} = require('../controllers/dietician');

// Middleware for file uploads
const upload = require('../middlewares/upload');

// Middleware to check if user is a patient
const patientOnly = [authenticate, roleCheck('patient')];

// ==========================================
// Authentication Routes (Public)
// ==========================================

/**
 * @route   POST /api/patient/auth/register
 * @desc    Step 1: Register a new patient (username, email, password)
 */
router.post('/auth/register', validateRegister, authController.register);

/**
 * @route   POST /api/patient/auth/login
 * @desc    Login patient (email or username + password)
 */
router.post('/auth/login', validateLogin, authController.login);

/**
 * @route   GET /api/patient/auth/check-username/:username
 * @desc    Check if username is available
 */
router.get('/auth/check-username/:username', authController.checkUsername);

/**
 * @route   GET /api/patient/auth/check-email/:email
 * @desc    Check if email is available
 */
router.get('/auth/check-email/:email', authController.checkEmail);

/**
 * @route   POST /api/patient/auth/forgot-password
 * @desc    Request password reset
 */
router.post('/auth/forgot-password', authController.forgotPassword);

/**
 * @route   POST /api/patient/auth/reset-password/:token
 * @desc    Reset password with token
 */
router.post('/auth/reset-password/:token', authController.resetPassword);

// ==========================================
// Profile Completion Routes (After Registration)
// ==========================================

// ==========================================
// Authentication Routes (Protected)
// ==========================================

/**
 * @route   GET /api/patient/auth/me
 * @desc    Get current logged in patient
 */
router.get('/auth/me', patientOnly, authController.getMe);

/**
 * @route   POST /api/patient/auth/logout
 * @desc    Logout patient
 */
router.post('/auth/logout', patientOnly, authController.logout);

/**
 * @route   PUT /api/patient/auth/change-password
 * @desc    Change password
 */
router.put('/auth/change-password', patientOnly, authController.changePassword);

// ==========================================
// Profile Routes
// ==========================================

/**
 * @route   GET /api/patient/profile
 * @desc    Get patient profile
 */
router.get('/profile', patientOnly, profileController.getProfile);

/**
 * @route   PUT /api/patient/profile
 * @desc    Update patient profile
 */
router.put('/profile', patientOnly, validateUpdateProfile, profileController.updateProfile);

/**
 * @route   POST /api/patient/profile/image
 * @desc    Upload profile image
 */
router.post(
  '/profile/image',
  patientOnly,
  upload.single('profileImage'),
  profileController.uploadProfileImage
);

/**
 * @route   DELETE /api/patient/profile
 * @desc    Delete patient account
 */
router.delete('/profile', patientOnly, profileController.deleteAccount);

// ==========================================
// Health Profile Routes
// ==========================================

/**
 * @route   GET /api/patient/health-profile
 * @desc    Get health profile
 */
router.get('/health-profile', patientOnly, profileController.getHealthProfile);

/**
 * @route   PUT /api/patient/health-profile
 * @desc    Update health profile
 */
router.put('/health-profile', patientOnly, profileController.updateHealthProfile);

router.get('/meal-log/screen-data', patientOnly, dietController.getMealLogScreenData);

router.get('/meal-log/today-stats', patientOnly, dietController.getTodayMealLogStats);

router.post('/meal-log', patientOnly, dietController.submitMealLog);

router.post('/meal-log/add-note', patientOnly, upload.single('file'), dietController.addMealNote);

// ==========================================
// Tracking Data (Charts - calorie, weight, BMI trends)
// ==========================================
router.get('/tracking-data', patientOnly, progressController.getTrackingData);

// ==========================================
// Progress Routes
// ==========================================

/**
 * @route   POST /api/patient/progress
 * @desc    Create progress entry (with optional body image upload)
 */
router.post(
  '/progress',
  patientOnly,
  upload.fields([
    { name: 'bodyImage', maxCount: 1 },
    { name: 'bodyImage2', maxCount: 1 },
    { name: 'beforeImage', maxCount: 1 },
    { name: 'afterImage', maxCount: 1 },
  ]),
  progressController.createProgress
);

/**
 * @route   GET /api/patient/progress
 * @desc    Get all progress entries
 */
router.get('/progress', patientOnly, progressController.getProgress);

/**
 * @route   GET /api/patient/progress/stats
 * @desc    Get progress statistics
 */
router.get('/progress/stats', patientOnly, progressController.getProgressStats);

/**
 * @route   GET /api/patient/progress/goal
 * @desc    Get goal progress
 */
router.get('/progress/goal', patientOnly, progressController.getGoalProgress);

/**
 * @route   GET /api/patient/progress/:id
 * @desc    Get progress by ID
 */
router.get('/progress/:id', patientOnly, progressController.getProgressById);

/**
 * @route   PUT /api/patient/progress/:id
 * @desc    Update progress entry
 */
router.put('/progress/:id', patientOnly, progressController.updateProgress);

/**
 * @route   POST /api/patient/progress/:id/images
 * @desc    Upload progress images (before/after)
 */
router.post(
  '/progress/:id/images',
  patientOnly,
  upload.fields([
    { name: 'beforeImage', maxCount: 1 },
    { name: 'afterImage', maxCount: 1 },
  ]),
  progressController.uploadProgressImages
);

/**
 * @route   DELETE /api/patient/progress/:id
 * @desc    Delete progress entry
 */
router.delete('/progress/:id', patientOnly, progressController.deleteProgress);

// ==========================================
// Payment Routes
// ==========================================

/**
 * @route   POST /api/patient/diet-plan-requests
 * @desc    Create a diet plan request after patient submits form
 */
router.post('/diet-plan-requests', patientOnly, dietPlanRequestController.createDietPlanRequest);

/**
 * @route   GET /api/patient/diet-plan-requests/status
 * @desc    Get the latest diet plan request status for the patient
 */
router.get('/diet-plan-requests/status', patientOnly, dietPlanRequestController.getRequestStatus);

/**
 * @route   GET /api/patient/consultation-form-template
 * @desc    Get the field definitions for the patient's assigned dietician's
 *          first-consultation questionnaire (labels/types/sections/etc,
 *          not the patient's own answers - see /first-consultation for that)
 */
router.get(
  '/consultation-form-template',
  patientOnly,
  consultationFormController.getTemplateForPatient
);

/**
 * @route   GET /api/patient/first-consultation
 * @desc    Get the patient's own first consultation (as filled in by their
 *          dietician), so they can review it before consenting
 */
router.get('/first-consultation', patientOnly, firstConsultationController.getMyFirstConsultation);

/**
 * @route   PUT /api/patient/first-consultation/consent
 * @desc    Patient submits the Consent & Confidentiality section - the only
 *          part of the first consultation they can edit themselves
 * @body    { acknowledged: boolean, signatureName: string }
 */
router.put(
  '/first-consultation/consent',
  patientOnly,
  firstConsultationController.submitConsent
);

/**
 * @route   PATCH /api/patient/diet-plan-requests/:id/plan
 * @desc    Set the membership plan chosen for a diet plan request
 */
router.patch(
  '/diet-plan-requests/:id/plan',
  patientOnly,
  dietPlanRequestController.selectMembershipPlan
);

/**
 * @route   GET /api/patient/diet/active
 * @desc    Get currently active diet plan with recipes and summaries
 */
router.get('/diet/active', patientOnly, dietController.getActiveDietPlanForPatient);

/**
 * @route   GET /api/patient/diet/groceries
 * @desc    Get grocery list for the current week
 */
router.get('/diet/groceries', patientOnly, dietController.getGroceriesForCurrentWeek);

/**
 * @route   POST /api/patient/payments/manual-proof
 * @desc    Submit manual payment proof (image + amount details)
 */
router.post(
  '/payments/manual-proof',
  patientOnly,
  upload.single('proofImage'),
  validateManualPaymentProof,
  paymentController.submitManualPaymentProof
);

// ==========================================
// Custom Food Request Routes
// ==========================================

/**
 * @route   POST /api/patient/custom-food
 * @desc    Create a custom food request
 */
router.post(
  '/custom-food',
  patientOnly,
  upload.single('imageUrl'), // field name used in Flutter FormData
  dietController.createCustomFoodRequest
);

// ==========================================
// Chat Routes (Patient App Only)
// ==========================================

const chatController = require('../controllers/chatController');

/**
 * @route   GET /api/patient/chat/conversations
 * @desc    Get all conversations for patient
 */
router.get('/chat/conversations', patientOnly, chatController.getConversations);

/**
 * @route   POST /api/patient/chat/conversations
 * @desc    Get or create a conversation with dietician
 */
router.post('/chat/conversations', patientOnly, chatController.getOrCreateConversation);

/**
 * @route   GET /api/patient/chat/assigned-dietician
 * @desc    Get assigned dietician for patient
 */
router.get('/chat/assigned-dietician', patientOnly, chatController.getAssignedDietician);

/**
 * @route   GET /api/patient/chat/conversations/:conversationId/messages
 * @desc    Get messages for a specific conversation
 */
router.get('/chat/conversations/:conversationId/messages', patientOnly, chatController.getMessages);

/**
 * @route   POST /api/patient/chat/message
 * @desc    Send a message in conversation (patient auto-routes to default dietician)
 */
router.post('/chat/message', patientOnly, upload.single('image'), chatController.sendMessage);

/**
 * @route   POST /api/patient/chat/upload-image
 * @desc    Upload a chat image to Cloudinary and return the URL
 */
router.post('/chat/upload-image', patientOnly, upload.single('file'), chatController.uploadChatImage);

/**
 * @route   POST /api/patient/chat/conversations/:conversationId/read
 * @desc    Mark conversation messages as read
 */
router.post('/chat/conversations/:id/read', patientOnly, chatController.markAsRead);

// ==========================================
// Doctor Notes Routes (Patient App)
// ==========================================

/**
 * @route   GET /api/patient/doctor-notes
 * @desc    Get all doctor notes sent to this patient
 */
router.get('/doctor-notes', patientOnly, chatController.getPatientDoctorNotes);

router.get('/meal-logs/today', patientOnly, mealLogController.getTodayMealLogs);
router.get('/meal-logs/stats', patientOnly, mealLogController.getMealLogStats);
router.get('/meal-logs/calorie-trend', patientOnly, mealLogController.getCalorieTrend);
router.get('/meal-logs', patientOnly, mealLogController.getAllMealLogs);
router.post('/meal-logs', patientOnly, mealLogController.createMealLog);
router.put('/meal-logs/:id/meal/:mealIndex', patientOnly, mealLogController.updateMealLog);
router.delete('/meal-logs/:id/meal/:mealIndex', patientOnly, mealLogController.deleteMealLog);
router.post('/meal-logs/:id/meal/:mealIndex/complete', patientOnly, mealLogController.completeMeal);
router.post('/meal-notes', patientOnly, upload.single('image'), mealLogController.addMealNote);

// ==========================================
// Water Intake Routes
// ==========================================
router.post('/water/log', patientOnly, waterController.logWater);
router.get('/water/today', patientOnly, waterController.getToday);
router.get('/water/history', patientOnly, waterController.getHistory);
router.put('/water/goal', patientOnly, waterController.updateGoal);

// ==========================================
// Journey Routes
// ==========================================

/**
 * @route   GET /api/patient/journey/auto
 * @desc    Get auto-generated journey (first body log = before, latest = after)
 */
router.get('/journey/auto', patientOnly, journeyController.getAutoJourney);

/**
 * @route   GET /api/patient/journey/milestones
 * @desc    Get milestone-based journey cards from body log images
 */
router.get('/journey/milestones', patientOnly, journeyController.getJourneyMilestones);

/**
 * @route   POST /api/patient/journey
 * @desc    Upload journey images (before/after) — manual override
 */
router.post(
  '/journey',
  patientOnly,
  upload.fields([
    { name: 'beforeImage', maxCount: 1 },
    { name: 'afterImage', maxCount: 1 },
  ]),
  journeyController.uploadJourneyImage
);

/**
 * @route   GET /api/patient/journey
 * @desc    Get all manually uploaded journey images for the patient
 */
router.get('/journey', patientOnly, journeyController.getJourneyImages);

// ==========================================
// Videos Routes (visible videos from dietician)
// ==========================================
const { getVisibleVideosForPatient } = require('../controllers/dietician/videoController');
router.get('/videos', patientOnly, getVisibleVideosForPatient);

// ==========================================
// Quotes Routes (active quotes from dietician)
// ==========================================
const { getActiveQuotesForPatient } = require('../controllers/dietician/quoteController');
router.get('/quotes', patientOnly, getActiveQuotesForPatient);

// ==========================================
// Coupon Routes
// ==========================================

const { couponController } = require('../controllers/patient');

/**
 * @route   POST /api/patient/coupons/validate
 * @desc    Validate a coupon code and get discount info
 */
router.post('/coupons/validate', patientOnly, couponController.validateCoupon);

// ==========================================
// Assigned Doctor Profile Routes
// ==========================================
const { getAssignedDoctorProfile } = require('../controllers/dietician/profileController');

/**
 * @route   GET /api/patient/assigned-doctor/profile
 * @desc    Get assigned doctor's profile (public info)
 */
router.get('/assigned-doctor/profile', patientOnly, getAssignedDoctorProfile);

// ==========================================
// Notification Routes
// ==========================================
const notificationController = require('../controllers/notificationController');

router.get('/notifications', patientOnly, notificationController.getNotifications);
router.get('/notifications/unread-count', patientOnly, notificationController.getUnreadCount);
router.put('/notifications/read-all', patientOnly, notificationController.markAllAsRead);
router.put('/notifications/:id/read', patientOnly, notificationController.markAsRead);

module.exports = router;
