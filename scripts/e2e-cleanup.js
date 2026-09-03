/**
 * Removes the synthetic patients the E2E UI test (../e2e/e2e_flow.py) leaves
 * behind - anything whose email matches e2e.<digits>@docwellness.fit.
 *
 * Deletes, per matched patient: the Mongo User + FirstConsultation +
 * DietPlanRequest + DietPlan (+ its DayPlan/MealSlotPlan/PlanItem for a
 * plan-item plan) + MealLog + ManualPaymentProof + Notification +
 * Conversation/Chat, and the Supabase identity.
 *
 * IMPORTANT: this uses the connection in .env. Point it at the SAME
 * environment the test ran against (prod), or it will no-op / hit the wrong
 * DB. Pass --dry to list without deleting.
 *
 * Usage:
 *   node scripts/e2e-cleanup.js --dry
 *   node scripts/e2e-cleanup.js --execute
 *   node scripts/e2e-cleanup.js --execute --email=e2e.260903134741@docwellness.fit
 */

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');

const DRY = !process.argv.includes('--execute');
const ONE = (() => {
  const h = process.argv.find((a) => a.startsWith('--email='));
  return h ? h.split('=')[1] : null;
})();
const PATTERN = /^e2e\.\d+@docwellness\.fit$/i;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const models = require('../models');
  const { User } = models;

  const q = ONE ? { email: ONE.toLowerCase() } : { email: { $regex: PATTERN } };
  const patients = await User.find(q).lean();
  console.log(`${patients.length} matching test patient(s)${DRY ? ' (dry run)' : ''}`);

  const supa = process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

  for (const p of patients) {
    console.log(`  - ${p.email}  (${p._id})`);
    if (DRY) continue;

    const pid = p._id;
    const collections = [
      ['FirstConsultation', { patientId: pid }],
      ['DietPlanRequest', { patientId: pid }],
      ['MealLog', { patientId: pid }],
      ['ManualPaymentProof', { patientId: pid }],
      ['Notification', { userId: pid }],
      ['ExercisePlan', { patientId: pid }],
    ];
    for (const [name, filter] of collections) {
      if (!models[name]) continue;
      const r = await models[name].deleteMany(filter).catch(() => ({ deletedCount: 0 }));
      if (r.deletedCount) console.log(`      ${name}: ${r.deletedCount}`);
    }

    const plans = models.DietPlan ? await models.DietPlan.find({ patientId: pid }).lean() : [];
    for (const plan of plans) {
      if (models.DayPlan) {
        const days = await models.DayPlan.find({ dietPlanId: plan._id }).lean();
        const dayIds = days.map((x) => x._id);
        const slots = models.MealSlotPlan ? await models.MealSlotPlan.find({ dayPlanId: { $in: dayIds } }).lean() : [];
        const slotIds = slots.map((x) => x._id);
        if (models.PlanItem) await models.PlanItem.deleteMany({ mealSlotId: { $in: slotIds } });
        if (models.SupplementItem) await models.SupplementItem.deleteMany({ mealSlotId: { $in: slotIds } });
        if (models.MealSlotPlan) await models.MealSlotPlan.deleteMany({ _id: { $in: slotIds } });
        if (models.DayPlan) await models.DayPlan.deleteMany({ _id: { $in: dayIds } });
      }
    }
    if (models.DietPlan) await models.DietPlan.deleteMany({ patientId: pid });

    if (models.Conversation) {
      const convos = await models.Conversation.find({ 'participants.userId': pid }).lean();
      const cids = convos.map((c) => c._id);
      if (models.Chat) await models.Chat.deleteMany({ conversationId: { $in: cids } });
      await models.Conversation.deleteMany({ _id: { $in: cids } });
    }

    await User.deleteOne({ _id: pid });

    if (supa && p.supabaseId) {
      await supa.auth.admin.deleteUser(p.supabaseId).catch((e) => console.log(`      supabase: ${e.message}`));
    } else if (supa) {
      // no stored supabaseId - look it up by email
      const list = await supa.auth.admin.listUsers().catch(() => ({ data: { users: [] } }));
      const u = (list.data.users || []).find((x) => x.email === p.email);
      if (u) await supa.auth.admin.deleteUser(u.id).catch(() => {});
    }
    console.log('      done');
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
