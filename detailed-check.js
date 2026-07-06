const mongoose = require('mongoose');
require('dotenv').config();

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    const db = mongoose.connection.db;

    console.log('\n=== DETAILED DATABASE CHECK ===\n');

    // Check diet plan requests
    const requests = await db.collection('dietplanrequests').find({}).toArray();
    console.log('DietPlanRequests:', requests.length);
    requests.forEach((r) => {
      console.log('  ID:', r._id.toString());
      console.log('  Status:', r.status);
      console.log('  Patient:', r.patient?.toString());
      console.log('');
    });

    // Check patients
    const patients = await db.collection('users').find({ role: 'patient' }).toArray();
    console.log('Patients:');
    patients.forEach((p) => {
      console.log('  Name:', p.profile?.fullName);
      console.log('  ID:', p._id.toString());
      console.log('  Status:', JSON.stringify(p.status, null, 2));
      console.log('');
    });

    await mongoose.disconnect();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
