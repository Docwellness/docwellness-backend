/**
 * Routes Index
 * Currently focused on Patient module only
 * Other modules (dietician, admin) will be added later
 */

const patientRoutes = require('./patient');
const dieticianRoutes = require('./dietician');
const internalRoutes = require('./internal');
const adminRoutes = require('./admin');

module.exports = {
  patientRoutes,
  dieticianRoutes,
  internalRoutes,
  adminRoutes,
};
