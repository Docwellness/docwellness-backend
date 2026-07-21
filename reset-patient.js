const mongoose = require('mongoose');
require('dotenv').config();

async function resetPatient() {
  await mongoose.connect(process.env.MONGODB_URI);

  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));
  const DietPlanRequest = mongoose.model(
    'DietPlanRequest',
    new mongoose.Schema({}, { strict: false })
  );
  const DietPlan = mongoose.model('DietPlan', new mongoose.Schema({}, { strict: false }));
  const ManualPaymentProof = mongoose.model(
    'ManualPaymentProof',
    new mongoose.Schema({}, { strict: false })
  );
  const FirstConsultation = mongoose.model(
    'FirstConsultation',
    new mongoose.Schema({}, { strict: false })
  );

  // Find test patient
  const patient = await User.findOne({ role: 'patient' });

  if (!patient) {
    console.log('No patient found!');
    await mongoose.disconnect();
    return;
  }

  console.log('\n=== RESETTING PATIENT ===');
  console.log('Patient:', patient.profile?.fullName || patient.email);
  console.log('ID:', patient._id.toString());

  // Delete all related records
  const deletedRequests = await DietPlanRequest.deleteMany({ patient: patient._id });
  console.log('Deleted DietPlanRequests:', deletedRequests.deletedCount);

  const deletedPlans = await DietPlan.deleteMany({ patientId: patient._id });
  console.log('Deleted DietPlans:', deletedPlans.deletedCount);

  const deletedProofs = await ManualPaymentProof.deleteMany({ patient: patient._id });
  console.log('Deleted PaymentProofs:', deletedProofs.deletedCount);

  const deletedConsultations = await FirstConsultation.deleteMany({ patient: patient._id });
  console.log('Deleted FirstConsultations:', deletedConsultations.deletedCount);

  // Reset patient status
  await User.updateOne(
    { _id: patient._id },
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
  console.log('Reset patient status to initial state');

  console.log('\n=== PATIENT RESET COMPLETE ===');
  console.log('The patient can now start fresh from "Request Diet Plan"');

  await mongoose.disconnect();
}

resetPatient().catch(console.error);
