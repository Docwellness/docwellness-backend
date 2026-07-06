require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB Connected');
  } catch (error) {
    console.error('Database connection error:', error.message);
    process.exit(1);
  }
};

const setup = async () => {
  await connectDB();

  const User = require('../models/User');
  const DietPlanRequest = require('../models/DietPlanRequest');
  const ManualPaymentProof = require('../models/ManualPaymentProof');
  const DietPlan = require('../models/DietPlan');

  try {
    console.log('\n🔧 Setting up test environment...\n');

    const hashedPassword = await bcrypt.hash('test123', 10);

    const allUsers = await User.find({}).lean();
    console.log('📋 Current users:');
    allUsers.forEach((u) => {
      console.log(`  - ${u.email} (${u.role}) ID: ${u._id}`);
    });

    const dieticians = allUsers.filter((u) => u.role === 'dietician');
    const patients = allUsers.filter((u) => u.role === 'patient');

    let dietician = dieticians[0];
    let patient = patients[0];

    if (dietician) {
      await User.updateOne({ _id: dietician._id }, { $set: { password: hashedPassword } });
      console.log(`\n✅ Updated dietician password: ${dietician.email}`);
    }

    if (patient) {
      await User.updateOne(
        { _id: patient._id },
        {
          $set: { password: hashedPassword },
          $unset: { status: 1 },
        }
      );
      console.log(`✅ Updated patient password: ${patient.email}`);
    }

    if (!dietician || !patient) {
      console.log(
        '\n❌ Missing accounts. Please ensure at least one dietician and one patient exist.'
      );
      await mongoose.connection.close();
      process.exit(1);
    }

    await DietPlanRequest.deleteMany({});
    await ManualPaymentProof.deleteMany({});
    await DietPlan.deleteMany({});

    const newRequest = await DietPlanRequest.create({
      patient: patient._id,
      dieticianId: dietician._id,
      status: 'Unpaid',
      hasActivePlan: false,
      startDateForDiet: new Date(),
    });

    console.log(`\n✅ Created fresh diet plan request`);
    console.log(`   Request ID: ${newRequest._id}`);
    console.log(`   Status: ${newRequest.status}`);

    console.log('\n📋 Test credentials (password: test123):');
    console.log(`   Dietician: ${dietician.email}`);
    console.log(`   Patient: ${patient.email}`);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

setup();
