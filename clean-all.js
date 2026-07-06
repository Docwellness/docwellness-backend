const mongoose = require('mongoose');
require('dotenv').config();

async function cleanAll() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Use raw collection access to ensure we get everything
  const db = mongoose.connection.db;

  console.log('\n=== CLEANING ALL RELATED DATA ===\n');

  // Check and delete diet plan requests
  const requests = await db.collection('dietplanrequests').find({}).toArray();
  console.log('DietPlanRequests found:', requests.length);
  if (requests.length > 0) {
    requests.forEach((r) => console.log('  -', r._id, 'status:', r.status));
    await db.collection('dietplanrequests').deleteMany({});
    console.log('  Deleted all!');
  }

  // Check and delete payment proofs
  const proofs = await db.collection('manualpaymentproofs').find({}).toArray();
  console.log('ManualPaymentProofs found:', proofs.length);
  if (proofs.length > 0) {
    proofs.forEach((p) => console.log('  -', p._id, 'amount:', p.amountReceived));
    await db.collection('manualpaymentproofs').deleteMany({});
    console.log('  Deleted all!');
  }

  // Check and delete first consultations
  const consultations = await db.collection('firstconsultations').find({}).toArray();
  console.log('FirstConsultations found:', consultations.length);
  if (consultations.length > 0) {
    await db.collection('firstconsultations').deleteMany({});
    console.log('  Deleted all!');
  }

  // Check and delete diet plans
  const plans = await db.collection('dietplans').find({}).toArray();
  console.log('DietPlans found:', plans.length);
  if (plans.length > 0) {
    await db.collection('dietplans').deleteMany({});
    console.log('  Deleted all!');
  }

  // Reset patient status
  const result = await db.collection('users').updateMany(
    { role: 'patient' },
    {
      $set: {
        'status.requestId': null,
        'status.requestStatus': null,
        'status.activeDietPlanId': null,
        'status.firstConsultationId': null,
        'status.canSendPaymentRequest': false,
        'status.hasPaymentUpdate': false,
      },
    }
  );
  console.log('Reset patient statuses:', result.modifiedCount);

  console.log('\n=== CLEANUP COMPLETE ===');
  console.log('Patient can now start fresh from Step 2: Request Diet Plan');
  console.log('\nIn Patient App:');
  console.log('1. Pull down to refresh');
  console.log('2. You should see "Request diet plan" button');

  await mongoose.disconnect();
}

cleanAll().catch(console.error);
