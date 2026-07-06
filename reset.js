const mongoose = require('mongoose');
require('dotenv').config();

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    const db = mongoose.connection.db;

    console.log('Cleaning database...');

    const r1 = await db.collection('dietplanrequests').deleteMany({});
    console.log('Deleted dietplanrequests:', r1.deletedCount);

    const r2 = await db.collection('manualpaymentproofs').deleteMany({});
    console.log('Deleted manualpaymentproofs:', r2.deletedCount);

    const r3 = await db.collection('firstconsultations').deleteMany({});
    console.log('Deleted firstconsultations:', r3.deletedCount);

    const r4 = await db.collection('dietplans').deleteMany({});
    console.log('Deleted dietplans:', r4.deletedCount);

    const r5 = await db
      .collection('users')
      .updateMany({ role: 'patient' }, { $set: { status: {} } });
    console.log('Reset patient status:', r5.modifiedCount);

    console.log('\nDONE! Patient can start fresh.');
    console.log('In Patient App: Pull down to refresh, you should see "Request diet plan" button');

    await mongoose.disconnect();
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
