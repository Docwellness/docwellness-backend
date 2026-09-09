/**
 * Seeds the "Daily wisdom" quotes shown in the user app's Home carousel.
 * Text-first quotes (no image) across Nutrition / Wellness / Mindfulness.
 *
 * With --wipe it first deletes the dietician's existing quotes (the old
 * image-based ones), then inserts these 12 as isActive: true.
 *
 * ── Connection ──────────────────────────────────────────────────────────────
 *   remote:       set PROD_MONGODB_URI, then --dietician-id=<id> --execute
 *   in-container: --use-default-uri --dietician-id=<id> --execute
 *   (run with no --dietician-id to list candidate dietician ids)
 * DRY RUN unless --execute.
 *
 * Usage:
 *   node scripts/seed-quotes.js --dietician-id=<ObjectId>                   # dry run
 *   node scripts/seed-quotes.js --dietician-id=<ObjectId> --wipe --execute
 */

const USE_DEFAULT_URI = process.argv.includes('--use-default-uri');

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const EXECUTE = process.argv.includes('--execute');
const WIPE = process.argv.includes('--wipe');
const dieticianArg = process.argv.find((a) => a.startsWith('--dietician-id='));
const DIETICIAN_ID = dieticianArg
  ? dieticianArg.split('=')[1]
  : process.env.SEED_DIETICIAN_ID || null;

// Each quote in English / Hindi / Marathi - all three shown on one card.
const QUOTES = [
  {
    text: 'Let food be thy medicine, and medicine be thy food.',
    textHi: 'भोजन ही तुम्हारी औषधि हो, और औषधि ही तुम्हारा भोजन।',
    textMr: 'अन्न हेच तुमचे औषध असू द्या, आणि औषध हेच तुमचे अन्न.',
    author: 'Hippocrates',
    category: 'Nutrition',
  },
  {
    text: 'You don’t need to eat less — you need to eat right.',
    textHi: 'आपको कम खाने की ज़रूरत नहीं — सही खाने की ज़रूरत है।',
    textMr: 'तुम्हाला कमी खाण्याची गरज नाही — योग्य खाण्याची गरज आहे.',
    author: 'DocWellness',
    category: 'Nutrition',
  },
  {
    text: 'Progress, not perfection. Every meal is a fresh start.',
    textHi: 'पूर्णता नहीं, प्रगति। हर भोजन एक नई शुरुआत है।',
    textMr: 'परिपूर्णता नव्हे, प्रगती. प्रत्येक जेवण ही नवी सुरुवात आहे.',
    author: 'DocWellness',
    category: 'Nutrition',
  },
  {
    text: 'Eat for the body you’re building, not the one you’re leaving behind.',
    textHi: 'उस शरीर के लिए खाओ जो तुम बना रहे हो, उसके लिए नहीं जिसे तुम पीछे छोड़ रहे हो।',
    textMr: 'तुम्ही घडवत असलेल्या शरीरासाठी खा, मागे सोडत असलेल्या शरीरासाठी नाही.',
    author: 'DocWellness',
    category: 'Nutrition',
  },
  {
    text: 'Take care of your body. It’s the only place you have to live.',
    textHi: 'अपने शरीर का ध्यान रखो। रहने के लिए यही एकमात्र जगह है।',
    textMr: 'आपल्या शरीराची काळजी घ्या. राहण्यासाठी हीच एकमेव जागा आहे.',
    author: 'Jim Rohn',
    category: 'Wellness',
  },
  {
    text: 'The greatest wealth is health.',
    textHi: 'सबसे बड़ा धन स्वास्थ्य है।',
    textMr: 'सर्वात मोठी संपत्ती म्हणजे आरोग्य.',
    author: 'Virgil',
    category: 'Wellness',
  },
  {
    text: 'A healthy outside starts from the inside.',
    textHi: 'स्वस्थ बाहरी रूप की शुरुआत भीतर से होती है।',
    textMr: 'निरोगी बाह्यरूपाची सुरुवात आतून होते.',
    author: 'Robert Urich',
    category: 'Wellness',
  },
  {
    text: 'Small daily habits compound into a life you’re proud of.',
    textHi: 'छोटी-छोटी रोज़ की आदतें मिलकर ऐसा जीवन बनाती हैं जिस पर तुम्हें गर्व हो।',
    textMr: 'छोट्या रोजच्या सवयी मिळून असे आयुष्य घडवतात ज्याचा तुम्हाला अभिमान वाटेल.',
    author: 'DocWellness',
    category: 'Wellness',
  },
  {
    text: 'Your body hears everything your mind says.',
    textHi: 'तुम्हारा शरीर वह सब सुनता है जो तुम्हारा मन कहता है।',
    textMr: 'तुमचं मन जे बोलतं ते सर्व तुमचं शरीर ऐकतं.',
    author: 'Naomi Judd',
    category: 'Mindfulness',
  },
  {
    text: 'Almost everything works again if you unplug it for a few minutes — including you.',
    textHi: 'कुछ मिनटों के लिए बंद कर दो तो लगभग सब कुछ फिर से चलने लगता है — तुम भी।',
    textMr: 'काही मिनिटांसाठी बंद केलं तर जवळपास सर्व काही पुन्हा चालू लागतं — तुम्हीसुद्धा.',
    author: 'Anne Lamott',
    category: 'Mindfulness',
  },
  {
    text: 'Feelings come and go like clouds. Your breath is the anchor.',
    textHi: 'भावनाएँ बादलों की तरह आती-जाती हैं। तुम्हारी साँस ही लंगर है।',
    textMr: 'भावना ढगांसारख्या येतात-जातात. तुमचा श्वास हाच नांगर आहे.',
    author: 'after Thich Nhat Hanh',
    category: 'Mindfulness',
  },
  {
    text: 'It’s not about being good at it. It’s about being good to yourself.',
    textHi: 'बात इसमें माहिर होने की नहीं है। बात खुद के प्रति अच्छा होने की है।',
    textMr: 'यात प्रवीण असण्याचा प्रश्न नाही. स्वतःशी चांगलं वागण्याचा प्रश्न आहे.',
    author: 'DocWellness',
    category: 'Mindfulness',
  },
];

async function openConnection() {
  const tlsCAFile = connectDB.resolveTlsCAFile();
  const tlsOptions = tlsCAFile ? { tls: true, tlsCAFile } : {};
  const uri = USE_DEFAULT_URI
    ? process.env.MONGODB_URI
    : process.env.PROD_MONGODB_URI;
  if (!uri) {
    console.error(
      USE_DEFAULT_URI
        ? 'MONGODB_URI is not set in this environment.'
        : 'PROD_MONGODB_URI must be set (or run in-container with --use-default-uri).'
    );
    process.exit(1);
  }
  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1']);
  }
  const conn = mongoose.createConnection(uri, tlsOptions);
  await conn.asPromise();
  return conn;
}

async function main() {
  console.log(
    EXECUTE ? '=== EXECUTING quote seed ===' : '=== DRY RUN (pass --execute) ==='
  );
  const conn = await openConnection();
  console.log(`Connected to DB "${conn.name}" @ ${conn.host}:${conn.port}`);
  const quotes = conn.collection('quotes');

  if (!DIETICIAN_ID || !mongoose.Types.ObjectId.isValid(DIETICIAN_ID)) {
    const byDietician = await quotes
      .aggregate([{ $group: { _id: '$dieticianId', count: { $sum: 1 } } }])
      .toArray();
    const dieticians = await conn
      .collection('users')
      .find({ role: 'dietician' })
      .project({ 'profile.fullName': 1, email: 1 })
      .toArray();
    console.log('\nNo valid --dietician-id. Candidates:');
    console.table(
      dieticians.map((d) => ({
        _id: String(d._id),
        name: d.profile && d.profile.fullName,
        email: d.email,
      }))
    );
    console.log('Existing quotes by dieticianId:');
    console.table(
      byDietician.map((g) => ({ dieticianId: String(g._id), quotes: g.count }))
    );
    await conn.close();
    process.exitCode = 1;
    return;
  }

  const dieticianId = new mongoose.Types.ObjectId(DIETICIAN_ID);

  try {
    const existing = await quotes.countDocuments({ dieticianId });
    console.log(`\nExisting quotes for this dietician: ${existing}`);
    console.log(
      WIPE
        ? `--wipe: ${EXECUTE ? 'deleting' : 'would delete'} all ${existing}`
        : '(pass --wipe to remove the existing ones first)'
    );

    console.log(`\n${EXECUTE ? 'Inserting' : 'Would insert'} ${QUOTES.length} quotes:`);
    console.table(
      QUOTES.map((q) => ({ category: q.category, author: q.author, text: q.text.slice(0, 60) }))
    );

    if (!EXECUTE) {
      console.log('\nDry run - no writes. Re-run with --execute.');
      return;
    }

    if (WIPE) {
      const del = await quotes.deleteMany({ dieticianId });
      console.log(`Deleted ${del.deletedCount} existing quote(s).`);
    }

    const now = new Date();
    const docs = QUOTES.map((q, i) => ({
      dieticianId,
      imageUrl: '',
      cloudinaryPublicId: '',
      text: q.text,
      textHi: q.textHi || '',
      textMr: q.textMr || '',
      author: q.author,
      category: q.category,
      isActive: true,
      // Spread createdAt so the carousel/notification "latest" ordering is
      // stable and matches array order (index 0 = newest).
      createdAt: new Date(now.getTime() - i * 60000),
      updatedAt: now,
      __v: 0,
    }));
    const res = await quotes.insertMany(docs, { ordered: false });
    console.log(`\nInserted ${res.insertedCount} quotes.`);
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error('Quote seed failed:', err);
  process.exit(1);
});
