require('dotenv').config();
const mongoose = require('mongoose');
const { User, DietPlanRequest } = require('./models');

async function test() {
  // Username no longer exists on User - pass the demo account's email:
  //   node test-patient-status.js demo1@example.com
  const email = process.argv[2];
  if (!email) {
    console.log('Usage: node test-patient-status.js <email>');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: email.toLowerCase() });
  console.log('User ID:', user._id);
  console.log('User status:', JSON.stringify(user.status, null, 2));

  const req = await DietPlanRequest.findOne({ patient: user._id }).sort({ createdAt: -1 }).lean();

  if (req) {
    console.log('\nDietPlanRequest found:');
    console.log('  requestId:', req._id);
    console.log('  status:', req.status);
    console.log('  paymentRequested:', req.paymentRequested);
  } else {
    console.log('No DietPlanRequest found');
  }

  await mongoose.disconnect();
}
test().catch(console.error);
