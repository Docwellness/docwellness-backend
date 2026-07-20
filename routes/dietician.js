const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const { dieticianOnly } = require('../middlewares/roleCheck');
const uploadLabReport = require('../middlewares/uploadLabReport');
const upload = require('../middlewares/upload');
const {
  manualPaymentController,
  patientController,
  firstConsultationController,
  dietPlanController,
  dietController,
  uploadRecipieController,
  trackingController,
  dashboardController,
  videoController,
  quoteController,
  journeyController,
  profileController,
  couponController,
  consultationFormController,
} = require('../controllers/dietician');
const chatController = require('../controllers/chatController');
const notificationController = require('../controllers/notificationController');
const { authController } = require('../controllers/patient');

const dieticianOnlyMiddleware = [authenticate, dieticianOnly];

/**
 * @route   GET /api/dietician/auth/me
 * @desc    Get current logged in dietician. Reuses the same generic getMe
 *          handler patient auth uses - the User model is shared across
 *          roles, and this endpoint doesn't filter by role itself (the
 *          dieticianOnlyMiddleware wrapper does that).
 */
router.get('/auth/me', dieticianOnlyMiddleware, authController.getMe);

// ==========================================
// Doctor Profile Routes
// ==========================================

/**
 * @route   GET /api/dietician/profile
 * @desc    Get dietician's own profile
 */
router.get('/profile', dieticianOnlyMiddleware, profileController.getDoctorProfile);

/**
 * @route   PUT /api/dietician/profile
 * @desc    Update dietician's own profile
 */
router.put('/profile', dieticianOnlyMiddleware, profileController.updateDoctorProfile);

/**
 * @route   POST /api/dietician/profile/image
 * @desc    Upload dietician profile image
 */
router.post(
  '/profile/image',
  dieticianOnlyMiddleware,
  upload.single('profileImage'),
  profileController.uploadDoctorProfileImage
);

/**
 * @route   GET /api/dietician/dashboard-stats
 * @desc    Get action tile stats for dietician home dashboard
 */
router.get('/dashboard-stats', dieticianOnlyMiddleware, dashboardController.getDashboardStats);

/**
 * @route   POST /api/dietician/need-attention/:patientId/acknowledge
 * @desc    Mark a need-attention patient as read/acknowledged
 */
router.post('/need-attention/:patientId/acknowledge', dieticianOnlyMiddleware, dashboardController.acknowledgeNeedAttention);

/**
 * @route   GET /api/dietician/performance-trends
 * @desc    Weekly patient & revenue trends for performance charts
 */
router.get('/performance-trends', dieticianOnlyMiddleware, dashboardController.getPerformanceTrends);

router.get('/patients', dieticianOnlyMiddleware, dietPlanController.listPatientsForDietician);
router.put(
  '/patients/:requestId/complete',
  dieticianOnlyMiddleware,
  dietPlanController.markPatientCompleted
);

router.get('/chat-patients', dieticianOnlyMiddleware, chatController.listChatPatientsForDietician);

router.get(
  '/diet-plan-requests',
  dieticianOnlyMiddleware,
  dietPlanController.listDietPlanRequestsForDietician
);

router.post(
  '/patients/:patientId/diet-plan-requests/:requestId/payment-request',
  dieticianOnlyMiddleware,
  dietPlanController.sendPaymentRequest
);

// Manual payment proofs listing
router.get(
  '/patients/:patientId/payments/manual-proofs',
  dieticianOnlyMiddleware,
  manualPaymentController.getManualPaymentProofs
);

// Reject manual payment proof
router.put(
  '/patients/:patientId/payments/manual-proofs/:proofId/reject',
  dieticianOnlyMiddleware,
  manualPaymentController.rejectPaymentProof
);

// Confirm a renewal payment (patient already has an active plan) without
// requiring a new diet plan to be built/finalized/activated
router.put(
  '/patients/:patientId/payments/manual-proofs/:proofId/confirm',
  dieticianOnlyMiddleware,
  manualPaymentController.confirmRenewalPayment
);

// Patient profile summary for Flutter "Patient profile" screen
router.get(
  '/patients/:patientId/profile',
  dieticianOnlyMiddleware,
  patientController.getPatientProfile
);

// Toggle patient active status (deactivate/activate)
router.put(
  '/patients/:patientId/deactivate',
  dieticianOnlyMiddleware,
  patientController.togglePatientActive
);

// First consultation form APIs
router.get(
  '/patients/:patientId/first-consultation',
  dieticianOnlyMiddleware,
  firstConsultationController.getFirstConsultation
);

router.put(
  '/patients/:patientId/first-consultation',
  dieticianOnlyMiddleware,
  uploadLabReport.single('file'),
  firstConsultationController.upsertFirstConsultation
);

router.post(
  '/patients/:patientId/diet-plans/generate',
  dieticianOnlyMiddleware,
  dietPlanController.createAndGenerateDietPlan
);

router.post(
  '/patients/:patientId/diet-plans/:dietPlanId/generate-week',
  dieticianOnlyMiddleware,
  dietPlanController.generateWeekForExistingPlan
);

router.get(
  '/patients/:patientId/diet-plans/:dietPlanId/details',
  dieticianOnlyMiddleware,
  dietPlanController.getDietPlanDetails
);

router.get(
  '/patients/:patientId/diet-plans/:dietPlanId/weeks/:weekNumber',
  dieticianOnlyMiddleware,
  dietPlanController.getFinalizedWeekDetails
);

// Same shape as the route above but works on a not-yet-finalized (Draft)
// plan's AI-generated week, so the dietician can review the full recipe
// options pool before finalizing - see getFinalizedWeekDetails' doc comment
// for why these are two separate endpoints (different status gating and
// different underlying plan field: generatedPlan vs finalizedPlan).
router.get(
  '/patients/:patientId/diet-plans/:dietPlanId/weeks/:weekNumber/draft-options',
  dieticianOnlyMiddleware,
  dietPlanController.getDraftWeekOptions
);

router.put(
  '/patients/:patientId/diet-plans/:dietPlanId/finalize-week',
  dieticianOnlyMiddleware,
  dietPlanController.finalizeWeekPlan
);

router.put(
  '/patients/:patientId/diet-plans/:dietPlanId/finalize-all',
  dieticianOnlyMiddleware,
  dietPlanController.finalizeEntireDietPlan
);

router.post(
  '/patients/:patientId/diet-plans/:dietPlanId/activate',
  dieticianOnlyMiddleware,
  dietPlanController.activateDietPlan
);

// Patient tracking data (calorie intake, weight trend, BMI) for charts
router.get(
  '/patients/:patientId/tracking-data',
  dieticianOnlyMiddleware,
  trackingController.getPatientTrackingData
);

// Patient meal-log stats for Client Logged Data screen
router.get(
  '/patients/:patientId/meal-log/today-stats',
  dieticianOnlyMiddleware,
  trackingController.getPatientMealLogStats
);

// Patient water intake for Client Logged Data screen
router.get(
  '/patients/:patientId/water/today',
  dieticianOnlyMiddleware,
  trackingController.getPatientWaterIntake
);

// Get custom food requests for dietician
router.get(
  '/custom-food/requests',
  dieticianOnlyMiddleware,
  dietController.getCustomFoodRequestsForDietician
);

// Update custom food request status
router.patch(
  '/custom-food/requests/:id',
  dieticianOnlyMiddleware,
  dietController.updateCustomFoodRequestStatus
);

// Generate recipe preview with AI
router.post(
  '/recipes/ai-generate-preview',
  dieticianOnlyMiddleware,
  uploadRecipieController.generateRecipeWithAI
);

// Update recipe preview based on dietician edits
router.post(
  '/recipes/ai-update-from-edits',
  dieticianOnlyMiddleware,
  uploadRecipieController.updateRecipeFromEdits
);

// Get recipe categories with counts
router.get(
  '/recipes/categories',
  dieticianOnlyMiddleware,
  uploadRecipieController.getRecipeCategories
);

// Real per-serving-time recipe counts, optionally scoped to a top-level
// category group - powers the "Recipes & Supplements" landing grid.
// Must be registered before the '/recipes/:id' route below, or Express
// would match this path as :id='serving-time-summary' instead.
router.get(
  '/recipes/serving-time-summary',
  dieticianOnlyMiddleware,
  uploadRecipieController.getServingTimeSummary
);

// List recipes by serving time (with optional cuisine filter). Also must be
// registered before '/recipes/:id' for the same reason - previously placed
// after it, which silently shadowed this route (matches the "zero callers"
// dead-code state this endpoint was found in).
router.get(
  '/recipes/by-serving-time',
  dieticianOnlyMiddleware,
  uploadRecipieController.listRecipesByServingTime
);

// List all recipes with optional category filter
router.get('/recipes', dieticianOnlyMiddleware, uploadRecipieController.listRecipes);

// Get single recipe by ID
router.get('/recipes/:id', dieticianOnlyMiddleware, uploadRecipieController.getRecipeById);

// Update selected fields on an existing recipe (e.g., image)
router.patch(
  '/recipes/:id',
  dieticianOnlyMiddleware,
  uploadRecipieController.updateRecipe
);

// Persist a single ingredient's refreshed image on an already-saved recipe
router.patch(
  '/recipes/:id/ingredient-image',
  dieticianOnlyMiddleware,
  uploadRecipieController.updateIngredientImage
);

// Create final recipe (with images URLs already set in JSON)
router.post('/recipes', dieticianOnlyMiddleware, uploadRecipieController.createRecipe);

// Upload main recipe image
router.post(
  '/uploads/recipe-image',
  dieticianOnlyMiddleware,
  upload.single('file'),
  uploadRecipieController.uploadRecipeImage
);

// Upload ingredient image
router.post(
  '/uploads/ingredient-image',
  dieticianOnlyMiddleware,
  upload.single('file'),
  uploadRecipieController.uploadIngredientImage
);

// Fetch an ingredient image from the internet (Pexels) - JSON body, not a
// file upload, so no multer middleware needed.
router.post(
  '/uploads/ingredient-image/fetch',
  dieticianOnlyMiddleware,
  uploadRecipieController.fetchIngredientImageFromWeb
);

// ==========================================
// Chat Routes (Dietician App Only)
// ==========================================

/**
 * @route   GET /api/dietician/chat/conversations
 * @desc    Get all conversations for dietician
 */
router.get('/chat/conversations', dieticianOnlyMiddleware, chatController.getConversations);

/**
 * @route   POST /api/dietician/chat/conversations/get-or-create
 * @desc    Get or create a conversation with a patient
 */
router.post('/chat/conversations/get-or-create', dieticianOnlyMiddleware, chatController.getOrCreateConversation);

/**
 * @route   GET /api/dietician/chat/conversations/:conversationId/messages
 * @desc    Get messages for a specific conversation
 */
router.get(
  '/chat/conversations/:conversationId/messages',
  dieticianOnlyMiddleware,
  chatController.getMessages
);

/**
 * @route   POST /api/dietician/chat/message
 * @desc    Send a message (dietician must specify receiverId)
 */

// sendMessage reads receiverId from req.params first, falling back to
// req.body - this bare route covers text-message sends, which post
// receiverId in the JSON body instead of the URL (the /:receiverId route
// below is for the multipart image-upload send, which needs it in the URL
// since the body is form-data). Without this, every dietician text send
// 404'd - the frontend only ever posts to '/chat/message'.
router.post(
  '/chat/message',
  dieticianOnlyMiddleware,
  upload.single('image'),
  chatController.sendMessage
);

router.post(
  '/chat/message/:receiverId',
  dieticianOnlyMiddleware,
  upload.single('image'),
  chatController.sendMessage
);

//route to upload image in chats
// router.post('/chat/upload-image', dieticianOnlyMiddleware, upload.single('image'), chatController.uploadChatImage);

/**
 * @route   POST /api/dietician/chat/conversations/:conversationId/read
 * @desc    Mark conversation messages as read
 */
router.post(
  '/chat/conversations/:conversationId/read',
  dieticianOnlyMiddleware,
  chatController.markAsRead
);

// ==========================================
// Doctor Notes Routes
// ==========================================

/**
 * @route   POST /api/dietician/patients/:patientId/notes
 * @desc    Send a doctor note to a patient (creates a chat message)
 */
router.post('/patients/:patientId/notes', dieticianOnlyMiddleware, chatController.sendDoctorNote);

/**
 * @route   GET /api/dietician/patients/:patientId/notes
 * @desc    Get all doctor notes sent to a patient
 */
router.get('/patients/:patientId/notes', dieticianOnlyMiddleware, chatController.getDoctorNotes);

// ==========================================
// Video Routes
// ==========================================

/**
 * @route   GET /api/dietician/videos
 * @desc    Get all dietician's videos
 */
router.get('/videos', dieticianOnlyMiddleware, videoController.getVideos);

/**
 * @route   POST /api/dietician/videos
 * @desc    Add a new video (banner + video file via multipart)
 */
router.post(
  '/videos',
  dieticianOnlyMiddleware,
  upload.fields([
    { name: 'bannerImage', maxCount: 1 },
    { name: 'videoFile', maxCount: 1 },
  ]),
  videoController.addVideo
);

/**
 * @route   PUT /api/dietician/videos/:videoId
 * @desc    Update an existing video
 */
router.put(
  '/videos/:videoId',
  dieticianOnlyMiddleware,
  upload.fields([
    { name: 'bannerImage', maxCount: 1 },
    { name: 'videoFile', maxCount: 1 },
  ]),
  videoController.updateVideo
);

/**
 * @route   DELETE /api/dietician/videos/:videoId
 * @desc    Delete a specific video
 */
router.delete('/videos/:videoId', dieticianOnlyMiddleware, videoController.deleteVideo);

// ==========================================
// Journey Routes
// ==========================================

/**
 * @route   GET /api/dietician/patients/:patientId/journey/auto
 * @desc    Get auto-generated journey for a patient
 */
router.get(
  '/patients/:patientId/journey/auto',
  dieticianOnlyMiddleware,
  journeyController.getAutoJourney
);

/**
 * @route   GET /api/dietician/patients/:patientId/journey/milestones
 * @desc    Get milestone-based journey cards for a patient
 */
router.get(
  '/patients/:patientId/journey/milestones',
  dieticianOnlyMiddleware,
  journeyController.getJourneyMilestones
);

/**
 * @route   GET /api/dietician/patients/:patientId/journey
 * @desc    Get all manually uploaded journey images for a patient
 */
router.get(
  '/patients/:patientId/journey',
  dieticianOnlyMiddleware,
  journeyController.getPatientJourneyImages
);

/**
 * @route   POST /api/dietician/patients/:patientId/journey
 * @desc    Upload journey images for a patient
 */
router.post(
  '/patients/:patientId/journey',
  dieticianOnlyMiddleware,
  upload.fields([
    { name: 'beforeImage', maxCount: 1 },
    { name: 'afterImage', maxCount: 1 },
  ]),
  journeyController.uploadJourneyImage
);

/**
 * @route   PUT /api/dietician/patients/:patientId/journey/:imageId
 * @desc    Update a journey image entry
 */
router.put(
  '/patients/:patientId/journey/:imageId',
  dieticianOnlyMiddleware,
  upload.fields([
    { name: 'beforeImage', maxCount: 1 },
    { name: 'afterImage', maxCount: 1 },
  ]),
  journeyController.updateJourneyImage
);

/**
 * @route   DELETE /api/dietician/patients/:patientId/journey/:imageId
 * @desc    Delete a journey image entry
 */
router.delete(
  '/patients/:patientId/journey/:imageId',
  dieticianOnlyMiddleware,
  journeyController.deleteJourneyImage
);

// ==========================================
// Quote Routes
// ==========================================

/**
 * @route   GET /api/dietician/quotes
 * @desc    Get all dietician's quotes
 */
router.get('/quotes', dieticianOnlyMiddleware, quoteController.getQuotes);

/**
 * @route   POST /api/dietician/quotes
 * @desc    Add a new quote (image uploaded to Cloudinary)
 */
router.post('/quotes', dieticianOnlyMiddleware, upload.single('image'), quoteController.addQuote);

/**
 * @route   PUT /api/dietician/quotes/:quoteId
 * @desc    Update an existing quote
 */
router.put(
  '/quotes/:quoteId',
  dieticianOnlyMiddleware,
  upload.single('image'),
  quoteController.updateQuote
);

/**
 * @route   DELETE /api/dietician/quotes/:quoteId
 * @desc    Delete a specific quote
 */
router.delete('/quotes/:quoteId', dieticianOnlyMiddleware, quoteController.deleteQuote);

// ==========================================
// Coupon Routes
// ==========================================

/**
 * @route   GET /api/dietician/coupons
 * @desc    Get all dietician's coupons
 */
router.get('/coupons', dieticianOnlyMiddleware, couponController.getCoupons);

/**
 * @route   POST /api/dietician/coupons
 * @desc    Add a new coupon
 */
router.post('/coupons', dieticianOnlyMiddleware, couponController.addCoupon);

/**
 * @route   PUT /api/dietician/coupons/:couponId
 * @desc    Update an existing coupon
 */
router.put('/coupons/:couponId', dieticianOnlyMiddleware, couponController.updateCoupon);

/**
 * @route   DELETE /api/dietician/coupons/:couponId
 * @desc    Delete a specific coupon
 */
router.delete('/coupons/:couponId', dieticianOnlyMiddleware, couponController.deleteCoupon);

// ==========================================
// Consultation Form Template Routes
// ==========================================

/**
 * @route   GET /api/dietician/consultation-form
 * @desc    Get the dietician's custom consultation form template
 */
router.get(
  '/consultation-form',
  dieticianOnlyMiddleware,
  consultationFormController.getMyTemplate
);

/**
 * @route   PUT /api/dietician/consultation-form
 * @desc    Create or replace the dietician's consultation form template
 */
router.put(
  '/consultation-form',
  dieticianOnlyMiddleware,
  consultationFormController.upsertMyTemplate
);

// ==========================================
// Notification Routes
// ==========================================

/**
 * @route   GET /api/dietician/notifications
 * @desc    Get all notifications for the dietician
 */
router.get('/notifications', dieticianOnlyMiddleware, notificationController.getNotifications);

/**
 * @route   GET /api/dietician/notifications/unread-count
 * @desc    Get unread notification count (for badge)
 */
router.get(
  '/notifications/unread-count',
  dieticianOnlyMiddleware,
  notificationController.getUnreadCount
);

/**
 * @route   PUT /api/dietician/notifications/read-all
 * @desc    Mark all notifications as read
 */
router.put(
  '/notifications/read-all',
  dieticianOnlyMiddleware,
  notificationController.markAllAsRead
);

/**
 * @route   PUT /api/dietician/notifications/:id/read
 * @desc    Mark a single notification as read
 */
router.put('/notifications/:id/read', dieticianOnlyMiddleware, notificationController.markAsRead);

module.exports = router;
