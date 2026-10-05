require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const cloudinary = require('./config/cloudinary');
const { cloudinaryUserFolder } = require('./utils/cloudinaryFolder');

const SCRATCH = 'C:/Users/bhush/AppData/Local/Temp/claude/C--Users-bhush-docwellness-workspace-docwellness-specs/44b71281-21c2-4fab-897b-c8ab773059fc/scratchpad';
const MIGRATION_FILE = `${SCRATCH}/migration_manifest.jsonl`;

const [, , indexStr, imageFilePath] = process.argv;
const index = parseInt(indexStr, 10);
const manifest = JSON.parse(fs.readFileSync(`${SCRATCH}/image_gen_manifest.json`, 'utf8'));
const entry = manifest[index];
if (!entry) throw new Error(`No manifest entry at index ${index}`);

(async () => {
  const uploadResult = await cloudinary.uploader.upload(imageFilePath, {
    folder: cloudinaryUserFolder(entry.dieticianId, 'recipes/main'),
  });
  const imageUrl = uploadResult?.secure_url || uploadResult?.url;
  if (!imageUrl) throw new Error('Cloudinary upload returned no URL');

  await mongoose.connect('mongodb://localhost:27018/docwellness_staging');
  await mongoose.connection.collection('recipes').updateOne(
    { _id: entry.recipeId },
    { $set: { image: imageUrl, imageSource: 'ai-generated' } }
  );
  await mongoose.disconnect();

  fs.appendFileSync(
    MIGRATION_FILE,
    JSON.stringify({
      recipeId: entry.recipeId,
      dieticianId: entry.dieticianId,
      name: entry.name,
      imageUrl,
      imageSource: 'ai-generated',
      style: entry.style,
      heroLabel: entry.heroLabel,
      prompt: entry.prompt,
    }) + '\n'
  );

  try { fs.unlinkSync(imageFilePath); } catch (e) {}

  console.log(`[${index + 1}/${manifest.length}] STORED ${entry.name} -> ${imageUrl}`);
})().catch((err) => {
  console.error(`[${index + 1}/${manifest.length}] STORE_FAILED ${entry.name}: ${err.message}`);
  process.exit(1);
});
