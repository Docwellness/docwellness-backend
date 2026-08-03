/**
 * Patient Routes
 * All routes are prefixed with /api/patient
 * These routes are accessible only to patients
 */

const express = require('express');
const router = express.Router();

// Import middlewares
const authenticate = require('../middlewares/auth');
const supabaseTokenOnly = require('../middlewares/supabaseTokenOnly');
const { roleCheck } = require('../middlewares/roleCheck');
const {
  validateRegister,
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
  timelineController,
  exerciseController,
} = require('../controllers/patient');
const {
  consultationFormController,
} = require('../controllers/dietician');

// Middleware for file uploads
const upload = require('../middlewares/upload');
const validateObjectIdParam = require('../middlewares/validateObjectIdParam');
const { authLimiter, messageLimiter, uploadLimiter } = require('../middlewares/rateLimiters');

// Middleware to check if user is a patient
const patientOnly = [authenticate, roleCheck('patient')];

// Reject a malformed :id (e.g. the literal string "undefined") with a clean
// 400 before it ever reaches a Mongoose query - see validateObjectIdParam's
// doc comment for the production CastError this was closing.
router.param('id', validateObjectIdParam);
router.param('taskId', validateObjectIdParam);

// ==========================================
// Authentication Routes (Public)
// ==========================================

/**
 * @route   POST /api/patient/auth/signup-request
 * @desc    Creates the Supabase identity (unconfirmed) and emails a
 *          verification code via Resend. The app then verifies that code
 *          directly against Supabase to get a session before calling
 *          /auth/register below.
 */
router.post('/auth/signup-request', authLimiter, authController.signupRequest);

/**
 * @route   POST /api/patient/auth/register
 * @desc    Complete registration - links a verified Supabase identity to a
 *          new Mongo profile. Requires a valid Supabase access token (from
 *          verifying the signup-request code), but no linked profile is
 *          expected to exist yet (that's what this creates).
 */
router.post('/auth/register', authLimiter, supabaseTokenOnly, validateRegister, authController.register);

/**
 * @route   GET /api/patient/auth/check-email/:email
 * @desc    Check if email is available
 */
router.get('/auth/check-email/:email', authLimiter, authController.checkEmail);

/**
 * @route   POST /api/patient/auth/forgot-password
 * @desc    Request a password reset code (delivered via Resend, not
 *          Supabase's own email templates). See §"Recovery via OTP" -
 *          the app then calls supabase.auth.verifyOtp(type: recovery)
 *          and supabase.auth.updateUser() directly, no backend involved.
 */
router.post('/auth/forgot-password', authLimiter, authController.forgotPassword);

// Login, logout (sign-out), and the rest of the reset flow (verify code +
// set new password) all happen client-side via the Supabase SDK directly -
// no backend endpoints needed for those.

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
 * @desc    Logout patient (best-effort no-op, kept for backward compat)
 */
router.post('/auth/logout', patientOnly, authController.logout);

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
  uploadLimiter,
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

router.post('/meal-log/add-note', patientOnly, uploadLimiter, upload.single('file'), dietController.addMealNote);

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
  uploadLimiter,
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
  uploadLimiter,
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
 * @route   GET /api/patient/diet-plan-requests/all
 * @desc    List every diet plan request ("order") the patient has ever
 *          submitted, for the profile screen's "Your Orders" list. Must be
 *          registered before the GET /:id route below.
 */
router.get('/diet-plan-requests/all', patientOnly, dietPlanRequestController.listRequests);

/**
 * @route   GET /api/patient/diet-plan-requests/:id
 * @desc    Get one specific diet plan request's full Order Summary detail
 */
router.get('/diet-plan-requests/:id', patientOnly, dietPlanRequestController.getRequestById);

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
 * @route   POST /api/patient/diet-plan-requests/:id/renew
 * @desc    Start a renewal cycle on an already-activated diet plan request
 */
router.post(
  '/diet-plan-requests/:id/renew',
  patientOnly,
  dietPlanRequestController.startRenewal
);

/**
 * @route   GET /api/patient/diet/active
 * @desc    Get currently active diet plan with recipes and summaries
 */
router.get('/diet/active', patientOnly, dietController.getActiveDietPlanForPatient);

/**
 * @route   GET /api/patient/diet/week-completion?week=N
 * @desc    Real per-day/week meal-logging completion for diet-plan week N
 */
router.get('/diet/week-completion', patientOnly, dietController.getWeekCompletion);

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
  uploadLimiter,
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
  uploadLimiter,
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
router.post('/chat/message', patientOnly, messageLimiter, upload.single('image'), chatController.sendMessage);

/**
 * @route   POST /api/patient/chat/upload-image
 * @desc    Upload a chat image to Cloudinary and return the URL
 */
router.post('/chat/upload-image', patientOnly, uploadLimiter, upload.single('file'), chatController.uploadChatImage);

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
router.post('/meal-notes', patientOnly, uploadLimiter, upload.single('image'), mealLogController.addMealNote);

// ==========================================
// Water Intake Routes
// ==========================================
router.post('/water/log', patientOnly, waterController.logWater);
router.get('/water/today', patientOnly, waterController.getToday);
router.get('/water/history', patientOnly, waterController.getHistory);
router.put('/water/goal', patientOnly, waterController.updateGoal);

// ==========================================
// Exercise Plan (patient-facing)
// ==========================================

router.get('/exercise/active', patientOnly, exerciseController.getActiveExercisePlanForPatient);
router.get('/exercise-log/today-stats', patientOnly, exerciseController.getTodayExerciseStats);
router.post('/exercise-log', patientOnly, exerciseController.submitExerciseLog);

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
  uploadLimiter,
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
// Device Token (push notifications)
// ==========================================
const deviceTokenController = require('../controllers/deviceTokenController');

/**
 * @route   POST /api/patient/device-token
 * @desc    Register/refresh this device's FCM token for push notifications
 */
router.post('/device-token', patientOnly, deviceTokenController.registerDeviceToken);

// ==========================================
// Goal Journey Timeline Routes
// ==========================================
// Distinct from the photo-based Journey routes above - this is a
// task/adherence timeline toward a weight goal, not before/after images.

/**
 * @route   GET /api/patient/timeline?from=-14&to=30
 * @desc    Full goal + stats + windowed milestone/task list
 */
router.get('/timeline', patientOnly, timelineController.getTimeline);

/**
 * @route   GET /api/patient/timeline/summary
 * @desc    Header stats only (light poll after a check-in)
 */
router.get('/timeline/summary', patientOnly, timelineController.getTimelineSummary);

/**
 * @route   GET /api/patient/timeline/days/:date/logs
 * @desc    What this patient actually logged that day
 */
router.get('/timeline/days/:date/logs', patientOnly, timelineController.getMyDayLogs);

/**
 * @route   POST /api/patient/check-ins
 * @desc    Mark a task done for today
 */
router.post('/check-ins', patientOnly, timelineController.createCheckIn);

/**
 * @route   DELETE /api/patient/check-ins/today/:taskId
 * @desc    Uncheck a task for today
 */
router.delete('/check-ins/today/:taskId', patientOnly, timelineController.deleteTodayCheckIn);

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
// Social Media Routes (dietician's YouTube/Instagram, About Doctor page)
// ==========================================
const { getActiveSocialPostsForPatient } = require('../controllers/dietician/socialMediaController');
router.get('/social-media', patientOnly, getActiveSocialPostsForPatient);

// ==========================================
// Article Routes (dietician's nutrition/wellness articles)
// ==========================================
const { getActiveArticlesForPatient } = require('../controllers/dietician/articleController');
router.get('/articles', patientOnly, getActiveArticlesForPatient);

// ==========================================
// Review Routes (patient reviews of their assigned dietician)
// ==========================================
const { getReviewsForPatient, addReview } = require('../controllers/dietician/reviewController');
router.get('/reviews', patientOnly, getReviewsForPatient);
router.post('/reviews', patientOnly, addReview);

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
