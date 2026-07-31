/**
 * Seed sample Social Media posts, Articles, and Reviews for the default
 * dietician (Tejasvini), so the patient app's reworked About Doctor page
 * has real content to render during development.
 *
 * Run: node seed-about-doctor-content.js
 */

require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const { SocialMediaPost, Article, Review } = require('./models');
  const config = require('./config/environment');
  const dieticianId = config.defaultDieticianId;

  if (!dieticianId) {
    throw new Error('DEFAULT_DIETICIAN_ID is not configured');
  }

  await Promise.all([
    SocialMediaPost.deleteMany({ dieticianId }),
    Article.deleteMany({ dieticianId }),
  ]);
  console.log('Cleared existing social posts + articles for this dietician');

  // ---- SOCIAL MEDIA ----
  await SocialMediaPost.insertMany([
    {
      dieticianId,
      platform: 'youtube',
      url: 'https://youtube.com/shorts/e5TjSga3KH8',
      thumbnailUrl: 'https://img.youtube.com/vi/e5TjSga3KH8/hqdefault.jpg',
      caption: '3 breakfast swaps that keep you full until lunch',
      order: 0,
      isActive: true,
    },
    {
      dieticianId,
      platform: 'youtube',
      url: 'https://youtube.com/shorts/e5TjSga3KH8',
      thumbnailUrl: 'https://img.youtube.com/vi/e5TjSga3KH8/hqdefault.jpg',
      caption: 'Why "eat less, move more" isn\'t the whole story',
      order: 1,
      isActive: true,
    },
    {
      dieticianId,
      platform: 'instagram',
      url: 'https://www.instagram.com/docwellness.fit/',
      thumbnailUrl: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=800&q=80',
      caption: 'Meal-prep Sunday: a full week of lunches in 45 minutes',
      order: 0,
      isActive: true,
    },
    {
      dieticianId,
      platform: 'instagram',
      url: 'https://www.instagram.com/docwellness.fit/',
      thumbnailUrl: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=80',
      caption: 'Client win: "I finally stopped fearing carbs" 🎉',
      order: 1,
      isActive: true,
    },
  ]);
  console.log('Inserted social media posts');

  // ---- ARTICLES ----
  await Article.insertMany([
    {
      dieticianId,
      title: '5 Sustainable Weight-Loss Habits That Actually Stick',
      category: 'Weight Loss',
      imageUrl: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=1000&q=80',
      excerpt:
        "Forget crash diets - these five small, doable habits are the ones my clients actually keep up long after the scale moves.",
      content:
        "Every January, the same question comes in: 'What's the fastest way to lose weight?' The honest answer is that fast and sustainable rarely live in the same sentence. The clients who keep the weight off aren't the ones who found a stricter diet - they're the ones who found habits small enough to survive a bad week.\n\n" +
        "1. Protein at every meal, not just dinner. It's the single biggest lever for staying full between meals.\n" +
        "2. A 10-minute walk after your biggest meal of the day - not a workout, just movement.\n" +
        "3. One 'anchor' vegetable-forward meal you eat on autopilot, so decision fatigue doesn't derail the whole day.\n" +
        "4. Protein + fiber before anything sweet, so cravings get met instead of fought.\n" +
        "5. A weekly weigh-in trend, not a daily number - your weight moves more day-to-day than you'd think, and daily numbers just add stress.\n\n" +
        "None of these require giving up foods you love. That's the point - a plan you can actually live in beats a plan that only works for two weeks.",
      order: 0,
      isActive: true,
    },
    {
      dieticianId,
      title: 'PCOS & Nutrition: What Really Helps',
      category: "Women's Health",
      imageUrl: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=1000&q=80',
      excerpt:
        "PCOS makes weight loss harder, not impossible. Here's what actually moves the needle, beyond just 'eat less'.",
      content:
        "If you have PCOS and feel like the normal weight-loss advice just doesn't work for your body, you're not imagining it - insulin resistance is common with PCOS, and it changes how your body responds to carbs and stress.\n\n" +
        "What tends to actually help: pairing carbs with protein or fat instead of eating them alone, prioritizing consistent meal timing over strict calorie counting, strength training over pure cardio (it improves insulin sensitivity directly), and treating sleep and stress as part of the nutrition plan, not separate from it.\n\n" +
        "This isn't about a stricter diet - it's about a different one, built around how your body actually processes food right now.",
      order: 1,
      isActive: true,
    },
    {
      dieticianId,
      title: 'Iron-Rich Foods Every Woman Needs',
      category: 'Nutrition',
      imageUrl: 'https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=1000&q=80',
      excerpt:
        'Low iron shows up as fatigue, brain fog, and hair thinning long before a blood test flags it. Here\'s how to eat ahead of it.',
      content:
        "Women lose iron every month, which is exactly why iron deficiency is one of the most common (and most missed) nutrition gaps I see. The tiredness that gets blamed on 'just being busy' is often this.\n\n" +
        "Good sources: lentils and chickpeas, spinach and other leafy greens, pumpkin seeds, and lean red meat if you eat it. The trick most people don't know: pairing these with vitamin C (a squeeze of lemon, a side of bell pepper) roughly doubles how much iron your body actually absorbs. Coffee or tea right after an iron-rich meal does the opposite, so give it 30-60 minutes.\n\n" +
        "If fatigue has been dragging on for weeks, food helps - but it's also worth asking your dietician or doctor about a simple blood test.",
      order: 2,
      isActive: true,
    },
    {
      dieticianId,
      title: 'Hormones & Weight: The Connection No One Explains',
      category: "Women's Health",
      imageUrl: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=1000&q=80',
      excerpt:
        "Your weight isn't just calories in, calories out - your hormones are quietly running the show. Here's how to work with them, not against them.",
      content:
        "Cortisol, insulin, estrogen, thyroid hormones - they all influence hunger, cravings, and where your body stores fat, and none of them care about your calorie spreadsheet.\n\n" +
        "Chronic under-eating raises cortisol and can slow your thyroid down, which is why extreme diets so often backfire. Cycle-aware eating (a little more food and carbs in the luteal phase, when hunger genuinely rises) works with your body instead of fighting it every month. And consistent sleep does more for hormonal balance than almost any single food choice.\n\n" +
        "The goal isn't to 'hack' your hormones - it's to stop working against them.",
      order: 3,
      isActive: true,
    },
    {
      dieticianId,
      title: 'Protein for Women: How Much Do You Actually Need?',
      category: 'Nutrition',
      imageUrl: 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=1000&q=80',
      excerpt:
        "Most women I meet are eating far less protein than their body actually needs. Here's the real number - and how to hit it without meal-prepping chicken breast forever.",
      content:
        "A rough, well-supported target for most active women is about 1.2-1.6g of protein per kg of bodyweight per day - noticeably more than the bare-minimum RDA, and more than most women actually eat.\n\n" +
        "It doesn't have to mean plain chicken and rice every day. Greek yogurt, eggs, lentils, cottage cheese, tofu, and edamame all count, and spreading protein across 3-4 meals is easier to hit than trying to cram it all into dinner.\n\n" +
        "More protein means more fullness between meals, better strength-training results, and less muscle lost during weight loss - which is exactly what keeps your metabolism from working against you.",
      order: 4,
      isActive: true,
    },
  ]);
  console.log('Inserted 5 articles');

  // ---- REVIEWS ----
  // Real test patient's review, plus two illustrative reviews under
  // synthetic (but validly-shaped) patientIds for demo purposes.
  const realPatientId = '6a624d8b07db36e5cf71cb21';
  const reviews = [
    {
      dieticianId,
      patientId: realPatientId,
      patientName: 'Test Frau A',
      rating: 5,
      text:
        "Tejasvini actually listens - my plan changed twice in the first month because my schedule changed, and she never made me feel bad about it. Down 3kg and it doesn't feel like a diet.",
      order: 0,
    },
    {
      dieticianId,
      patientId: new mongoose.Types.ObjectId(),
      patientName: 'Priya S.',
      rating: 5,
      text: "Best decision I made this year. I finally understand food instead of just avoiding it.",
      order: 1,
    },
    {
      dieticianId,
      patientId: new mongoose.Types.ObjectId(),
      patientName: 'Ananya K.',
      rating: 4,
      text:
        'Really knowledgeable and easy to talk to. Wish check-ins were a bit more frequent, but overall a great experience.',
      order: 2,
    },
  ];

  for (const review of reviews) {
    await Review.findOneAndUpdate(
      { dieticianId: review.dieticianId, patientId: review.patientId },
      review,
      { upsert: true, setDefaultsOnInsert: true }
    );
  }
  console.log('Inserted/updated 3 sample reviews');

  await mongoose.disconnect();
  console.log('Done!');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
