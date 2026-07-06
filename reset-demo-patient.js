const mongoose = require('mongoose');
require('dotenv').config();

async function resetPatient() {
  await mongoose.connect(process.env.MONGODB_URI);
  const patientId = '699464efc89b9f3cc1e2415b';
  const User = require('./models/User');

  // Delete diet plan requests
  const reqResult = await mongoose.connection.db.collection('dietplanrequests').deleteMany({
    patientId: new mongoose.Types.ObjectId(patientId),
  });
  console.log('Deleted diet plan requests:', reqResult.deletedCount);

  // Delete first consultations
  const fcResult = await mongoose.connection.db.collection('firstconsultations').deleteMany({
    patientId: new mongoose.Types.ObjectId(patientId),
  });
  console.log('Deleted first consultations:', fcResult.deletedCount);

  // Delete diet plans
  const dpResult = await mongoose.connection.db.collection('dietplans').deleteMany({
    patientId: new mongoose.Types.ObjectId(patientId),
  });
  console.log('Deleted diet plans:', dpResult.deletedCount);

  // Delete chat messages
  const chatResult = await mongoose.connection.db.collection('chatmessages').deleteMany({
    $or: [
      { senderId: new mongoose.Types.ObjectId(patientId) },
      { receiverId: new mongoose.Types.ObjectId(patientId) },
    ],
  });
  console.log('Deleted chat messages:', chatResult.deletedCount);

  // Reset user status to fresh
  await User.findByIdAndUpdate(patientId, {
    $set: {
      'status.firstConsultationId': null,
      'status.activeDietPlanId': null,
      'status.requestId': null,
      'status.requestStatus': 'Unpaid',
      'status.canSendPaymentRequest': false,
      'status.hasPaymentUpdate': false,
    },
  });
  console.log('Reset user status to fresh state');

  // Verify
  const user = await User.findById(patientId).select('status username').lean();
  console.log('Patient:', user.username);
  console.log('New status:', JSON.stringify(user.status, null, 2));

  await mongoose.disconnect();
  console.log('Done!');
}

resetPatient().catch((e) => {
  console.error(e);
  process.exit(1);
});
