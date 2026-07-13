/**
 * Migration Script: Move existing Cloudinary assets into per-user folders
 *
 * Historically every upload landed in a flat, feature-based folder shared by
 * all users (docwellness/chat, docwellness/profiles, docwellness/journey,
 * etc.). This script moves each already-uploaded asset into
 * docwellness/<ownerUserId>/<assetType>/<filename> (matching what new
 * uploads now do, see utils/cloudinaryFolder.js) and rewrites every DB
 * field that stored the old URL to point at the new one.
 *
 * Safe to re-run: assets already living under a docwellness/<ObjectId>/...
 * folder are skipped, and each distinct asset is renamed at most once even
 * if the same URL is duplicated across multiple documents/collections
 * (e.g. a meal note's image lives in both Chat.attachment and
 * Chat.metadata.imageUrl; a chat image sent via the v1 socket path is
 * dual-written into both Chat.attachment and MessageV1.attachment.url).
 *
 * Usage:
 *   node scripts/migrate-cloudinary-user-folders.js            # dry run - prints the plan, changes nothing
 *   node scripts/migrate-cloudinary-user-folders.js --execute  # actually renames assets in Cloudinary and updates MongoDB
 */

require('dotenv').config();
const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinary');

const EXECUTE = process.argv.includes('--execute');
const CLOUDINARY_HOST = 'res.cloudinary.com';

function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.includes(CLOUDINARY_HOST);
}

// https://res.cloudinary.com/<cloud>/image/upload/v169.../docwellness/chat/abc123.jpg
// -> docwellness/chat/abc123
function extractPublicId(url) {
  const marker = '/upload/';
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  let rest = url.slice(idx + marker.length);
  rest = rest.replace(/^v\d+\//, '');
  rest = rest.replace(/\.[a-zA-Z0-9]+$/, '');
  return rest;
}

// Already-migrated assets have the owner's 24-char ObjectId as the folder
// segment right after "docwellness/".
function isAlreadyMigrated(publicId) {
  const parts = publicId.split('/');
  return parts.length > 1 && /^[0-9a-fA-F]{24}$/.test(parts[1]);
}

function computeNewPublicId(publicId, ownerId) {
  const parts = publicId.split('/'); // docwellness / <assetType...> / filename
  const filename = parts[parts.length - 1];
  const assetTypeParts = parts.slice(1, -1);
  return ['docwellness', String(ownerId), ...assetTypeParts, filename].join('/');
}

// oldPublicId -> { ownerId, refs: [{ collection, docId, field, oldUrl }] }
const workMap = new Map();

function registerAsset(oldUrl, ownerId, collection, docId, field) {
  if (!isCloudinaryUrl(oldUrl)) return;
  const publicId = extractPublicId(oldUrl);
  if (!publicId) return;
  if (isAlreadyMigrated(publicId)) return;
  if (!ownerId) {
    console.warn(`  ! No owner id resolved for ${collection}:${docId}.${field} (${oldUrl}) - skipping`);
    return;
  }
  if (!workMap.has(publicId)) {
    workMap.set(publicId, { ownerId, refs: [] });
  }
  workMap.get(publicId).refs.push({ collection, docId, field, oldUrl });
}

async function discover(models) {
  const { Chat, MessageV1, FirstConsultation, JourneyImage, ManualPaymentProof, User, Quote, Progress, Recipe } =
    models;

  const chats = await Chat.find({
    $or: [
      { attachment: { $regex: CLOUDINARY_HOST } },
      { 'metadata.imageUrl': { $regex: CLOUDINARY_HOST } },
    ],
  }).select('attachment metadata senderId');
  for (const c of chats) {
    registerAsset(c.attachment, c.senderId, 'Chat', c._id, 'attachment');
    if (c.metadata) registerAsset(c.metadata.imageUrl, c.senderId, 'Chat', c._id, 'metadata.imageUrl');
  }

  const msgs = await MessageV1.find({ 'attachment.url': { $regex: CLOUDINARY_HOST } }).select(
    'attachment senderId'
  );
  for (const m of msgs) {
    if (m.attachment) registerAsset(m.attachment.url, m.senderId, 'MessageV1', m._id, 'attachment.url');
  }

  const consultations = await FirstConsultation.find({
    'labReports.files': { $regex: CLOUDINARY_HOST },
  }).select('labReports patient');
  for (const fc of consultations) {
    (fc.labReports?.files || []).forEach((url, idx) => {
      registerAsset(url, fc.patient, 'FirstConsultation', fc._id, `labReports.files.${idx}`);
    });
  }

  const journeys = await JourneyImage.find({
    $or: [
      { beforeImageUrl: { $regex: CLOUDINARY_HOST } },
      { afterImageUrl: { $regex: CLOUDINARY_HOST } },
    ],
  }).select('beforeImageUrl afterImageUrl patientId');
  for (const j of journeys) {
    registerAsset(j.beforeImageUrl, j.patientId, 'JourneyImage', j._id, 'beforeImageUrl');
    registerAsset(j.afterImageUrl, j.patientId, 'JourneyImage', j._id, 'afterImageUrl');
  }

  const proofs = await ManualPaymentProof.find({ proofImage: { $regex: CLOUDINARY_HOST } }).select(
    'proofImage patient'
  );
  for (const p of proofs) {
    registerAsset(p.proofImage, p.patient, 'ManualPaymentProof', p._id, 'proofImage');
  }

  const users = await User.find({ 'profile.profileImage': { $regex: CLOUDINARY_HOST } }).select(
    'profile.profileImage'
  );
  for (const u of users) {
    registerAsset(u.profile.profileImage, u._id, 'User', u._id, 'profile.profileImage');
  }

  const quotes = await Quote.find({ imageUrl: { $regex: CLOUDINARY_HOST } }).select(
    'imageUrl dieticianId'
  );
  for (const q of quotes) {
    registerAsset(q.imageUrl, q.dieticianId, 'Quote', q._id, 'imageUrl');
  }

  const progresses = await Progress.find({
    $or: [
      { bodyImage: { $regex: CLOUDINARY_HOST } },
      { bodyImage2: { $regex: CLOUDINARY_HOST } },
      { beforeImage: { $regex: CLOUDINARY_HOST } },
      { afterImage: { $regex: CLOUDINARY_HOST } },
    ],
  }).select('bodyImage bodyImage2 beforeImage afterImage patientId');
  for (const pr of progresses) {
    ['bodyImage', 'bodyImage2', 'beforeImage', 'afterImage'].forEach((f) => {
      registerAsset(pr[f], pr.patientId, 'Progress', pr._id, f);
    });
  }

  const recipes = await Recipe.find({
    $or: [{ image: { $regex: CLOUDINARY_HOST } }, { 'ingredients.image': { $regex: CLOUDINARY_HOST } }],
  }).select('image ingredients dieticianId');
  for (const r of recipes) {
    registerAsset(r.image, r.dieticianId, 'Recipe', r._id, 'image');
    (r.ingredients || []).forEach((ing, idx) => {
      registerAsset(ing.image, r.dieticianId, 'Recipe', r._id, `ingredients.${idx}.image`);
    });
  }
}

// Cloudinary resource_type must match what the asset was uploaded as.
// Everything here went through cloudinary.uploader.upload() with no
// explicit resource_type, which defaults to 'image' (Cloudinary treats PDFs
// as an image-derived type too) - but fall back to raw/video just in case
// an older upload landed differently.
async function renameWithFallback(oldPublicId, newPublicId) {
  const resourceTypes = ['image', 'raw', 'video'];
  let lastError;
  for (const resource_type of resourceTypes) {
    try {
      return await cloudinary.uploader.rename(oldPublicId, newPublicId, {
        resource_type,
        overwrite: false,
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function applyFieldUpdate(Models, ref, newUrl) {
  const Model = Models[ref.collection];
  const update = { [ref.field]: newUrl };
  if (ref.collection === 'Quote' && ref.field === 'imageUrl') {
    update.cloudinaryPublicId = extractPublicId(newUrl);
  }
  await Model.updateOne({ _id: ref.docId }, { $set: update });
}

async function run() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected.');
    console.log(EXECUTE ? '=== EXECUTING migration ===' : '=== DRY RUN (pass --execute to apply changes) ===\n');

    const models = {
      Chat: require('../models/Chat'),
      MessageV1: require('../chat/models').MessageV1,
      FirstConsultation: require('../models/FirstConsultation'),
      JourneyImage: require('../models/JourneyImage'),
      ManualPaymentProof: require('../models/ManualPaymentProof'),
      User: require('../models/User'),
      Quote: require('../models/Quote'),
      Progress: require('../models/Progress'),
      Recipe: require('../models/Recipe'),
    };

    await discover(models);

    console.log(`Discovered ${workMap.size} distinct legacy Cloudinary asset(s) to migrate.\n`);

    let renamed = 0;
    let renameFailed = 0;
    let fieldsUpdated = 0;
    const urlRewrites = new Map(); // oldUrl -> newUrl

    for (const [oldPublicId, { ownerId, refs }] of workMap) {
      const newPublicId = computeNewPublicId(oldPublicId, ownerId);
      console.log(
        `${EXECUTE ? 'Renaming' : 'Would rename'}: ${oldPublicId}  ->  ${newPublicId}  (${refs.length} reference${refs.length > 1 ? 's' : ''}: ${refs.map((r) => `${r.collection}.${r.field}`).join(', ')})`
      );

      if (!EXECUTE) {
        renamed++;
        continue;
      }

      try {
        const result = await renameWithFallback(oldPublicId, newPublicId);
        refs.forEach((ref) => urlRewrites.set(ref.oldUrl, result.secure_url));
        renamed++;
      } catch (err) {
        console.error(`  x FAILED to rename ${oldPublicId}: ${err.message}`);
        renameFailed++;
      }
    }

    if (EXECUTE && urlRewrites.size > 0) {
      console.log('\nUpdating MongoDB references...');
      for (const { refs } of workMap.values()) {
        for (const ref of refs) {
          const newUrl = urlRewrites.get(ref.oldUrl);
          if (!newUrl) continue; // rename failed for this asset, leave DB untouched
          await applyFieldUpdate(models, ref, newUrl);
          fieldsUpdated++;
        }
      }
    }

    console.log(
      `\nDone. Assets ${EXECUTE ? 'renamed' : 'planned'}: ${renamed}, failed: ${renameFailed}, DB fields updated: ${fieldsUpdated}.`
    );
    if (!EXECUTE) {
      console.log('This was a dry run - nothing was changed. Re-run with --execute to apply.');
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
  }
}

run();
