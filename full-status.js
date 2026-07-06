const mongoose = require('mongoose');
require('dotenv').config();

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    const db = mongoose.connection.db;

    // Get full patient status
    const patients = await db.collection('users').find({ role: 'patient' }).toArray();
    console.log('=== PATIENT STATUS ===');
    patients.forEach((p) => {
      console.log('Name:', p.profile?.fullName);
      console.log('Full Status:', JSON.stringify(p.status, null, 2));
    });

    // Check first consultations
    const consultations = await db.collection('firstconsultations').find({}).toArray();
    console.log('\n=== FIRST CONSULTATIONS ===');
    console.log('Count:', consultations.length);
    consultations.forEach((c) =>
      console.log('  ID:', c._id.toString(), 'Patient:', c.patient?.toString())
    );

    // Check diet plan requests
    const requests = await db.collection('dietplanrequests').find({}).toArray();
    console.log('\n=== DIET PLAN REQUESTS ===');
    console.log('Count:', requests.length);
    requests.forEach((r) =>
      console.log('  ID:', r._id.toString(), 'Status:', r.status, 'Patient:', r.patient?.toString())
    );

    process.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
