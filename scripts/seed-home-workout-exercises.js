/**
 * Seeds a set of bodyweight, no-equipment-needed exercises into a
 * dietician's Exercise catalog - mirrors add-salad-recipes.js's dry-run/
 * --execute pattern, but authors the data directly instead of calling
 * generateExerciseWithAI: MET values here are the same literature-grounded
 * reference points baked into that function's own system prompt (Compendium
 * of Physical Activities), so this produces the same quality of data the
 * AI-generate flow would, without an OpenAI round trip for content that's
 * well-established exercise science.
 *
 * Usage:
 *   node scripts/seed-home-workout-exercises.js                                    # dry run
 *   node scripts/seed-home-workout-exercises.js --execute                          # write
 *   node scripts/seed-home-workout-exercises.js --execute --dietician=email@x.com  # override target
 */

// The default system DNS resolver on this machine doesn't handle the
// mongodb+srv:// scheme's SRV/TXT lookups (ECONNREFUSED on
// dns.resolveSrv even though the app itself resolves fine via other
// paths) - overriding to public resolvers fixes it. Must happen before
// mongoose.connect().
require('dns').setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const mongoose = require('mongoose');

const EXECUTE = process.argv.includes('--execute');
const dieticianArg = process.argv.find((a) => a.startsWith('--dietician='));
const DIETICIAN_EMAIL = dieticianArg ? dieticianArg.split('=')[1] : 'tejasvini@docwellness.fit';

const EXERCISES = [
  {
    name: 'Sun Salutations (Surya Namaskar)',
    category: 'Flexibility',
    met: 4.0,
    description: 'A flowing sequence of 12 yoga poses that stretches and warms the entire body while building light cardiovascular endurance.',
    instructions: [
      'Start standing tall at the front of your mat, palms together at your chest (Pranamasana).',
      'Inhale, sweep your arms overhead and arch back slightly (Hasta Uttanasana).',
      'Exhale, fold forward and place your hands by your feet (Hasta Padasana).',
      'Inhale, step your right leg back into a lunge, look up (Ashwa Sanchalanasana).',
      'Exhale, step the left leg back into a plank, then lower down to the floor (Ashtanga Namaskara).',
      'Inhale into Cobra or Upward Dog, then exhale into Downward Dog.',
      'Reverse the sequence step by step back to standing, then repeat leading with the other leg.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Full Body', 'Core', 'Shoulders'],
  },
  {
    name: 'Push-Ups',
    category: 'Strength',
    met: 3.8,
    description: 'A classic bodyweight exercise that builds chest, shoulder, and tricep strength while engaging the core.',
    instructions: [
      'Start in a high plank with hands shoulder-width apart.',
      'Keep your body in a straight line from head to heels.',
      'Lower your chest toward the floor by bending your elbows.',
      'Push back up to the starting position.',
      'Keep your core braced throughout to avoid sagging hips.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Chest', 'Triceps', 'Shoulders', 'Core'],
  },
  {
    name: 'Sit-Ups',
    category: 'Strength',
    met: 3.8,
    description: 'A core-strengthening exercise that targets the abdominal muscles through a full range of motion.',
    instructions: [
      'Lie on your back with knees bent and feet flat on the floor.',
      'Place your hands lightly behind your head or crossed over your chest.',
      'Engage your core and curl your torso all the way up toward your knees.',
      'Lower back down with control.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Abdominals', 'Hip Flexors'],
  },
  {
    name: 'Abs Crunches',
    category: 'Strength',
    met: 3.8,
    description: 'A shorter-range core exercise that isolates the upper abdominals with less strain on the lower back than a full sit-up.',
    instructions: [
      'Lie on your back with knees bent, feet flat on the floor.',
      'Place your fingertips lightly behind your ears.',
      'Lift your shoulder blades a few inches off the floor, exhaling as you curl up.',
      'Lower back down slowly without fully relaxing.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Abdominals'],
  },
  {
    name: 'Plank',
    category: 'Strength',
    met: 3.0,
    description: 'An isometric hold that builds core, shoulder, and back endurance without any movement.',
    instructions: [
      'Rest on your forearms and toes, elbows under your shoulders.',
      'Keep your body in a straight line from head to heels.',
      'Brace your core and squeeze your glutes.',
      'Hold the position, breathing steadily, without letting your hips sag or pike.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Core', 'Shoulders', 'Back'],
  },
  {
    name: 'Jumping Jacks',
    category: 'Cardio',
    met: 8.0,
    description: 'A full-body cardio movement that raises your heart rate quickly and warms up the whole body.',
    instructions: [
      'Stand tall with feet together and arms at your sides.',
      'Jump your feet out wide while raising your arms overhead.',
      'Jump back to the starting position.',
      'Repeat at a steady, quick pace.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Full Body', 'Calves', 'Shoulders'],
  },
  {
    name: 'Burpees',
    category: 'Cardio',
    met: 8.0,
    description: 'A high-intensity full-body movement that combines a squat, plank, push-up, and jump for a big calorie burn.',
    instructions: [
      'Start standing, then squat down and place your hands on the floor.',
      'Jump your feet back into a plank position.',
      'Perform a push-up (optional for beginners).',
      'Jump your feet back toward your hands.',
      'Explosively jump up with arms overhead.',
    ],
    equipment: [],
    difficultyLevel: 'Intermediate',
    targetMuscleGroups: ['Full Body', 'Legs', 'Core'],
  },
  {
    name: 'Mountain Climbers',
    category: 'Cardio',
    met: 8.0,
    description: 'A fast-paced plank variation that drives your knees toward your chest, building cardio fitness and core strength together.',
    instructions: [
      'Start in a high plank position with hands under shoulders.',
      'Drive one knee toward your chest, then quickly switch legs.',
      'Keep your hips low and core engaged throughout.',
      'Continue alternating at a quick, controlled pace.',
    ],
    equipment: [],
    difficultyLevel: 'Intermediate',
    targetMuscleGroups: ['Core', 'Legs', 'Shoulders'],
  },
  {
    name: 'Bodyweight Squats',
    category: 'Strength',
    met: 5.0,
    description: 'A foundational lower-body exercise that builds strength in the legs and glutes using just your body weight.',
    instructions: [
      'Stand with feet shoulder-width apart, toes slightly turned out.',
      'Push your hips back and bend your knees to lower into a squat.',
      'Keep your chest up and knees tracking over your toes.',
      'Lower until thighs are roughly parallel to the floor, then drive back up.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Quadriceps', 'Glutes', 'Hamstrings'],
  },
  {
    name: 'Walking Lunges',
    category: 'Strength',
    met: 4.0,
    description: 'A single-leg strength exercise that builds balance and lower-body strength by stepping forward into alternating lunges.',
    instructions: [
      'Stand tall, then step forward with one leg.',
      'Lower your hips until both knees are bent at about 90 degrees.',
      'Push through your front heel to step forward into the next lunge.',
      'Alternate legs as you move forward.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Quadriceps', 'Glutes', 'Hamstrings'],
  },
  {
    name: 'High Knees',
    category: 'Cardio',
    met: 8.0,
    description: 'A fast running-in-place drill that raises your heart rate and warms up the hip flexors and legs.',
    instructions: [
      'Stand tall and jog in place, driving your knees up toward your chest.',
      'Pump your arms in rhythm with your legs.',
      'Stay on the balls of your feet and keep a quick pace.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Hip Flexors', 'Quadriceps', 'Calves'],
  },
  {
    name: 'Wall Sit',
    category: 'Strength',
    met: 3.0,
    description: 'An isometric lower-body hold that builds quad and glute endurance using just a wall for support.',
    instructions: [
      'Stand with your back against a wall and slide down until your knees are bent at 90 degrees.',
      'Keep your feet flat and knees directly above your ankles.',
      'Hold the position, keeping your back flat against the wall.',
    ],
    equipment: ['Wall'],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Quadriceps', 'Glutes'],
  },
  {
    name: 'Glute Bridges',
    category: 'Strength',
    met: 3.5,
    description: 'A hip-hinge exercise that strengthens the glutes and lower back while lying on the floor.',
    instructions: [
      'Lie on your back with knees bent and feet flat, hip-width apart.',
      'Press through your heels and lift your hips toward the ceiling.',
      'Squeeze your glutes at the top.',
      'Lower back down with control and repeat.',
    ],
    equipment: [],
    difficultyLevel: 'Beginner',
    targetMuscleGroups: ['Glutes', 'Hamstrings', 'Lower Back'],
  },
  {
    name: 'Bicycle Crunches',
    category: 'Strength',
    met: 4.5,
    description: 'A rotational core exercise that targets the obliques and abdominals through alternating elbow-to-knee movement.',
    instructions: [
      'Lie on your back with hands lightly behind your head, knees bent.',
      'Lift your shoulders off the floor and bring one knee toward your chest.',
      'Rotate to touch your opposite elbow toward that knee.',
      'Switch sides in a smooth pedaling motion.',
    ],
    equipment: [],
    difficultyLevel: 'Intermediate',
    targetMuscleGroups: ['Abdominals', 'Obliques'],
  },
  {
    name: 'Tricep Dips (Chair)',
    category: 'Strength',
    met: 3.8,
    description: 'An upper-body exercise using a sturdy chair or step to target the triceps and shoulders.',
    instructions: [
      'Sit on the edge of a sturdy chair, hands gripping the edge beside your hips.',
      'Slide your hips off the chair with legs extended or bent.',
      'Lower your body by bending your elbows to about 90 degrees.',
      'Push back up through your palms to the starting position.',
    ],
    equipment: ['Chair'],
    difficultyLevel: 'Intermediate',
    targetMuscleGroups: ['Triceps', 'Shoulders', 'Chest'],
  },
  {
    name: 'Jump Rope (Skipping)',
    category: 'Cardio',
    met: 11.0,
    description: 'A high-intensity cardio exercise that builds coordination, calf strength, and cardiovascular fitness.',
    instructions: [
      'Hold the rope handles at hip height, rope behind your heels.',
      'Swing the rope overhead and jump just as it reaches your feet.',
      'Land softly on the balls of your feet with a slight knee bend.',
      'Keep a steady rhythm, using your wrists more than your arms to turn the rope.',
    ],
    equipment: ['Jump Rope'],
    difficultyLevel: 'Intermediate',
    targetMuscleGroups: ['Calves', 'Shoulders', 'Core'],
  },
];

async function main() {
  console.log(EXECUTE ? '=== EXECUTING home-workout exercise seed ===' : '=== DRY RUN (pass --execute to write) ===');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const { User, Exercise } = require('../models');
    const dietician = await User.findOne({ email: DIETICIAN_EMAIL, role: 'dietician' });
    if (!dietician) throw new Error(`Dietician account not found: ${DIETICIAN_EMAIL}`);
    console.log(`Target dietician: ${dietician.profile?.fullName || dietician.email} (${dietician._id})`);

    const toCreate = [];
    for (const ex of EXERCISES) {
      const existing = await Exercise.findOne({
        dieticianId: dietician._id,
        name: new RegExp(`^${ex.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      });
      if (existing) {
        console.log(`  [skip: already in catalog] "${ex.name}"`);
        continue;
      }
      toCreate.push(ex);
    }

    console.log(`\n=== PLAN: ${toCreate.length} exercise(s) ===`);
    toCreate.forEach((e, i) => console.log(`${i + 1}. "${e.name}" [${e.category}, MET ${e.met}]`));

    if (!EXECUTE) {
      console.log('\nThis was a dry run - no DB writes. Re-run with --execute to create these.');
      return;
    }

    let created = 0;
    for (const ex of toCreate) {
      await Exercise.create({ dieticianId: dietician._id, tags: ['home-workout'], ...ex });
      created++;
      console.log(`  ✓ Created "${ex.name}"`);
    }
    console.log(`\nDone. Created ${created} exercise(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
