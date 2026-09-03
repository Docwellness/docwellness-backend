/**
 * E2E test helper - returns the signup verification OTP that the app just
 * emailed to <email>, by reading it back from Resend (the same provider
 * utils/emailService.js sends through).
 *
 * Why read the real email instead of regenerating: Supabase's
 * admin.generateLink() only returns a `verifyOtp()`-valid code on the FIRST
 * call for an identity (which is the app's own /auth/signup-request). A
 * second generateLink here mints a code that verifyOtp rejects, so the
 * E2E script has to use the genuine emailed one.
 *
 * Usage:
 *   node scripts/e2e-get-signup-otp.js <email> [--since-ms=120000] [--timeout-ms=90000]
 *
 * Prints ONLY the numeric code to stdout on success; diagnostics -> stderr.
 * Exit 1 on failure.
 */

require('dotenv').config({ quiet: true });

const { Resend } = require('resend');

const argFlag = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const OTP_RE = /\b(\d{6,8})\b/;
const SUBJECT_RE = /verif|code|otp|sign\s?up|confirm/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCode(email) {
  const blobs = [email.text, email.html, email.subject].filter(Boolean);
  for (const b of blobs) {
    // strip tags so "<b>123456</b>" and "1 2 3 4 5 6" don't fool the regex
    const flat = String(b).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const m = flat.match(OTP_RE);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/e2e-get-signup-otp.js <email> [--since-ms=..] [--timeout-ms=..]');
    return 1;
  }
  const sinceMs = argFlag('since-ms', 180000);
  const timeoutMs = argFlag('timeout-ms', 90000);
  const target = email.toLowerCase();
  const notBefore = Date.now() - sinceMs;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const deadline = Date.now() + timeoutMs;
  let polls = 0;

  while (Date.now() < deadline) {
    polls += 1;
    let list;
    try {
      list = await resend.emails.list();
    } catch (e) {
      console.error(`[e2e-otp] resend.emails.list threw: ${e.message}`);
      await sleep(4000);
      continue;
    }
    const rows = (list && list.data && (list.data.data || list.data)) || [];
    // newest first; keep only recent ones addressed to our test mailbox
    const candidates = rows
      .filter((r) => {
        const to = Array.isArray(r.to) ? r.to.join(',') : String(r.to || '');
        if (!to.toLowerCase().includes(target)) return false;
        const ts = Date.parse(r.created_at || r.createdAt || 0);
        return Number.isNaN(ts) ? true : ts >= notBefore;
      })
      .sort((a, b) => Date.parse(b.created_at || b.createdAt || 0) - Date.parse(a.created_at || a.createdAt || 0));

    for (const row of candidates) {
      if (row.subject && !SUBJECT_RE.test(row.subject)) continue;
      let full;
      try {
        full = await resend.emails.get(row.id);
      } catch (e) {
        console.error(`[e2e-otp] resend.emails.get(${row.id}) threw: ${e.message}`);
        continue;
      }
      const body = (full && full.data) || full || {};
      const code = extractCode(body);
      if (code) {
        console.error(`[e2e-otp] found code in Resend email ${row.id} (poll ${polls})`);
        process.stdout.write(code);
        return 0;
      }
    }
    await sleep(4000);
  }

  console.error(`[e2e-otp] no signup email for ${email} within ${timeoutMs}ms (${polls} polls)`);
  return 1;
}

main().then(
  (code) => process.stdout.write('', () => process.nextTick(() => process.exit(code || 0))),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
