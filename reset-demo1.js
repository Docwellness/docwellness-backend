const mongoose = require('mongoose');
require('dotenv').config();
const { User, DietPlan, DietPlanRequest, FirstConsultation } = require('./models');

async function reset() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const user = await User.findOne({ username: 'demo1' });
  if (!user) {
    console.log('User demo1 not found');
    process.exit(1);
  }
  console.log('Found user:', user._id, user.username);

  // Delete all diet plans for this user
  const dp = await DietPlan.deleteMany({ patientId: user._id });
  console.log('Deleted DietPlans:', dp.deletedCount);

  // Delete all diet plan requests
  const dpr = await DietPlanRequest.deleteMany({ patient: user._id });
  console.log('Deleted DietPlanRequests:', dpr.deletedCount);

  // Delete first consultations
  const fc = await FirstConsultation.deleteMany({ patient: user._id });
  console.log('Deleted FirstConsultations:', fc.deletedCount);

  // Reset user status
  user.status = {
    isProfileComplete: true,
    firstConsultationId: null,
    activeDietPlanId: null,
    requestId: null,
    requestStatus: null,
    canSendPaymentRequest: false,
    hasPaymentUpdate: false,
  };
  await user.save();
  console.log('User status reset to fresh state');

  await mongoose.disconnect();
  console.log('Done!');
}
reset().catch(console.error);
