/**
 * Admin panel API (admin.docwellness.fit) - openspec change add-admin-panel.
 * Every route sits behind adminAuth (Google SSO identity + email allowlist +
 * live session) and a deny-by-default permission guard.
 */
const express = require('express');
const validateObjectIdParam = require('../middlewares/validateObjectIdParam');
const upload = require('../middlewares/upload');
const { uploadLimiter } = require('../middlewares/rateLimiters');
const { adminAuth, requirePermission } = require('../middlewares/adminAuth');
const account = require('../controllers/admin/accountController');
const content = require('../controllers/admin/contentController');
const placements = require('../controllers/admin/placementController');
const payments = require('../controllers/admin/paymentController');
const users = require('../controllers/admin/userController');
const dieticians = require('../controllers/admin/dieticianController');

const router = express.Router();
router.param('id', validateObjectIdParam);

router.use(adminAuth);

// Session / identity
router.get('/me', account.me);
router.post('/session/logout-all', account.logoutAll);

// Roles & permissions (read-only in v1: single administrator)
router.get('/roles', requirePermission('roles', 'view'), account.listRoles);

// Audit log
router.get('/audit', requirePermission('audit', 'view'), account.listAudit);
router.get('/audit/export', requirePermission('audit', 'export'), account.exportAudit);

// Content: recipe / supplement catalog and main images
router.get('/content/recipes/summary', requirePermission('content', 'view'), content.recipeSummary);
router.get('/content/categories', requirePermission('content', 'view'), content.recipeCategories);
router.get('/content/recipes', requirePermission('content', 'view'), content.listRecipes);
router.post(
  '/content/recipes/:id/image',
  requirePermission('content', 'edit'),
  uploadLimiter,
  upload.single('image'),
  content.setRecipeImage
);

// Product placements (commercial product images)
router.get('/brands', requirePermission('placements', 'view'), placements.listBrands);
router.post('/brands', requirePermission('placements', 'create'), placements.createBrand);
router.put('/brands/:id', requirePermission('placements', 'edit'), placements.updateBrand);

router.get('/placements', requirePermission('placements', 'view'), placements.listPlacements);
router.post('/placements', requirePermission('placements', 'create'), placements.createPlacement);
router.get('/placements/:id', requirePermission('placements', 'view'), placements.getPlacement);
router.put('/placements/:id', requirePermission('placements', 'edit'), placements.updatePlacement);
router.post(
  '/placements/:id/image',
  requirePermission('placements', 'edit'),
  uploadLimiter,
  upload.single('image'),
  placements.uploadImage
);
router.post('/placements/:id/submit', requirePermission('placements', 'edit'), placements.submitPlacement);
router.post('/placements/:id/approve', requirePermission('placements', 'approve'), placements.approvePlacement);
router.post('/placements/:id/cancel', requirePermission('placements', 'edit'), placements.cancelPlacement);

// Payments (manual payment proofs)
router.get('/payments/reconciliation', requirePermission('payments', 'view'), payments.reconciliation);
router.get('/payments', requirePermission('payments', 'view'), payments.listPayments);
router.get('/payments/:id', requirePermission('payments', 'view'), payments.getPayment);
router.post('/payments/:id/confirm', requirePermission('payments', 'approve'), payments.confirmPayment);
router.post('/payments/:id/reject', requirePermission('payments', 'approve'), payments.rejectPayment);
router.post('/payments/:id/refunds', requirePermission('payments', 'edit'), payments.addRefund);

// Users (patients)
router.get('/users', requirePermission('users', 'view'), users.listUsers);
router.get('/users/:id', requirePermission('users', 'view'), users.getUser);
router.post('/users/:id/reveal', requirePermission('users', 'view'), users.revealField);
router.post('/users/:id/suspend', requirePermission('users', 'edit'), users.suspendUser);
router.post('/users/:id/reactivate', requirePermission('users', 'edit'), users.reactivateUser);
router.post('/users/:id/extend-subscription', requirePermission('users', 'edit'), users.extendSubscription);

// Dieticians
router.get('/dieticians', requirePermission('dieticians', 'view'), dieticians.listDieticians);
router.post('/dieticians', requirePermission('dieticians', 'create'), dieticians.createDietician);
router.get('/dieticians/:id', requirePermission('dieticians', 'view'), dieticians.getDietician);
router.post('/dieticians/:id/verification', requirePermission('dieticians', 'approve'), dieticians.setVerification);
router.post('/dieticians/:id/suspend', requirePermission('dieticians', 'edit'), dieticians.suspend);
router.post('/dieticians/:id/reactivate', requirePermission('dieticians', 'edit'), dieticians.reactivate);
router.post('/dieticians/:id/reassign', requirePermission('dieticians', 'edit'), dieticians.reassign);
router.get('/dieticians/:id/reviews', requirePermission('dieticians', 'view'), dieticians.listReviews);
router.post('/dieticians/:id/reviews/:reviewId/hide', requirePermission('dieticians', 'edit'), dieticians.hideReview);
router.post('/dieticians/:id/reviews/:reviewId/unhide', requirePermission('dieticians', 'edit'), dieticians.unhideReview);
router.get('/dieticians/:id/earnings', requirePermission('dieticians', 'view'), dieticians.earnings);

module.exports = router;
