require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cloudinary = require('./config/cloudinary');
const { cloudinaryUserFolder } = require('./utils/cloudinaryFolder');

const SCRATCH = 'C:/Users/bhush/AppData/Local/Temp/claude/C--Users-bhush-docwellness-workspace-docwellness-specs/44b71281-21c2-4fab-897b-c8ab773059fc/scratchpad';
const MIGRATION_FILE = `${SCRATCH}/migration_manifest.jsonl`;

const [, , recipeId, dieticianId, imageFilePath, style, heroLabel, promptB64] = process.argv;
const prompt = Buffer.from(promptB64, 'base64').toString('utf8');

(async () => {
  const uploadResult = await cloudinary.uploader.upload(imageFilePath, {
    folder: cloudinaryUserFolder(dieticianId, 'recipes/main'),
  });
  const imageUrl = uploadResult?.secure_url || uploadResult?.url;
  if (!imageUrl) throw new Error('Cloudinary upload returned no URL');

  await mongoose.connect('mongodb://localhost:27018/docwellness_staging');
  await mongoose.connection.collection('recipes').updateOne(
    { _id: recipeId },
    { $set: { image: imageUrl, imageSource: 'ai-generated' } }
  );
  await mongoose.disconnect();

  fs.appendFileSync(
    MIGRATION_FILE,
    JSON.stringify({ recipeId, dieticianId, imageUrl, imageSource: 'ai-generated', style, heroLabel, prompt }) + '\n'
  );

  try { fs.unlinkSync(imageFilePath); } catch (e) {}

  console.log('STORED', recipeId, imageUrl);
})().catch((err) => {
  console.error('STORE_FAILED', recipeId, err.message);
  process.exit(1);
});
