/**
 * Database Cleanup Script
 * Removes all users except dieticians and creates one fresh patient account
 */

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

const cleanup = async () => {
  await connectDB();

  const User = require('../models/User');
  const DietPlanRequest = require('../models/DietPlanRequest');
  const ManualPaymentProof = require('../models/ManualPaymentProof');
  const FirstConsultation = require('../models/FirstConsultation');
  const DietPlan = require('../models/DietPlan');
  const MealLog = require('../models/MealLog');

  try {
    // Get all users
    const allUsers = await User.find({});
    console.log(`\nFound ${allUsers.length} total users:`);

    allUsers.forEach((u) => {
      console.log(`  - ${u.email || u.username} (${u.role}) ID: ${u._id}`);
    });

    // Keep dieticians, remove all patients
    const patientsToDelete = allUsers.filter((u) => u.role === 'patient');
    console.log(`\nRemoving ${patientsToDelete.length} patient accounts...`);

    // Delete related data for patients
    for (const patient of patientsToDelete) {
      await DietPlanRequest.deleteMany({ patient: patient._id });
      await ManualPaymentProof.deleteMany({ patient: patient._id });
      await FirstConsultation.deleteMany({ patient: patient._id });
      await DietPlan.deleteMany({ patientId: patient._id });
      await MealLog.deleteMany({ patient: patient._id });
      await User.deleteOne({ _id: patient._id });
      console.log(`  Deleted patient: ${patient.email || patient.username}`);
    }

    // Create a fresh patient account
    const hashedPassword = await bcrypt.hash('patient123', 10);
    const newPatient = await User.create({
      email: 'patient@test.com',
      username: 'testpatient',
      password: hashedPassword,
      role: 'patient',
      isVerified: true,
      profile: {
        fullName: 'Test Patient',
        gender: 'Male',
        dateOfBirth: new Date('1995-05-15'),
      },
      healthProfile: {
        height: 175,
        weight: 70,
        primaryGoal: 'Weight Loss',
        activityLevel: 'Moderately Activity',
      },
    });

    console.log(`\n✅ Created fresh patient account:`);
    console.log(`   Email: patient@test.com`);
    console.log(`   Password: patient123`);
    console.log(`   ID: ${newPatient._id}`);

    // List remaining users
    const remainingUsers = await User.find({});
    console.log(`\n📋 Remaining users (${remainingUsers.length}):`);
    remainingUsers.forEach((u) => {
      console.log(`  - ${u.email || u.username} (${u.role})`);
    });

    console.log('\n✅ Database cleanup complete!');
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

cleanup();
