// EMAIL USAGE SUMMARY:
// Email is used in the following controllers and functions:
// - controllers/patient/authController.js: sendEmail, sendWelcomeEmail
//
// This file defines utility functions for sending emails, including:
// - sendEmail: Generic email sender
// - sendWelcomeEmail: Sends a welcome email to new users
// - sendDietPlanNotification: Notifies users about diet plan updates

const { Resend } = require('resend');
const config = require('../config/environment');
const { enqueue } = require('./jobQueue');

// Constructed lazily (not at module load) so a missing RESEND_API_KEY only
// breaks actual send attempts, not the whole app's startup - this file is
// required by authController.js/paymentController.js regardless of whether
// any email is ever sent.
let resend;
const getResendClient = () => {
  if (!resend) resend = new Resend(config.email.resendApiKey);
  return resend;
};

// Send email. `from` defaults to the general/promotional sender; pass
// config.email.fromAddressPersonal explicitly for onboarding-style emails
// that should come from a real person instead.
const sendEmail = async ({ to, subject, text, html, from }) => {
  try {
    const { data, error } = await getResendClient().emails.send({
      from: from || config.email.fromAddress,
      to,
      subject,
      text,
      html,
    });

    if (error) throw error;

    console.log('Email sent:', data.id);
    return data;
  } catch (error) {
    console.error('Email error:', error);
    throw error;
  }
};

/**
 * Cross-app performance optimization, Phase 3 (task 3.3): get an email off
 * the request's critical path so the triggering action returns without
 * awaiting Resend.
 *
 *  - urgent (OTP codes the user is staring at a screen waiting for): try
 *    one inline send for the fast happy path; only if that throws, hand it
 *    to the queue for retry with backoff. Either way this never throws, so
 *    the request still succeeds and responds - a transient Resend outage
 *    no longer turns a signup / password-reset into a 500.
 *  - non-urgent (welcome, notifications): straight onto the queue.
 *
 * With no REDIS_URL, `enqueue` runs the send inline itself - identical to
 * the pre-Phase-3 behavior.
 * @param {{to,subject,text,html,from}} spec  a fully-rendered email
 * @param {{ urgent?: boolean }} [opts]
 */
const dispatchEmail = async (spec, { urgent = false } = {}) => {
  if (urgent) {
    try {
      return await sendEmail(spec);
    } catch (err) {
      console.error('[emailService] urgent send failed, queuing for retry:', err.message);
      await enqueue('email', spec);
      return { queued: true };
    }
  }
  await enqueue('email', spec);
  return { queued: true };
};

// Brand palette - matches the actual Flutter apps' colors (splash screen,
// section headers, primary buttons) so these emails read as the same
// product rather than a generic template.
const BRAND = {
  pageBg: '#FEF6FB',
  cardBg: '#FFFFFF',
  border: '#F3D9EA',
  heading: '#530630',
  primary: '#851653',
  text: '#1F2A37',
  muted: '#6C737F',
  codeBg: '#FDF2FA',
};
const LOGO_URL = 'https://docwellness.fit/docwellness-logo-wordmark.png';

/**
 * Wraps `bodyHtml` in the shared card layout every email below uses: hidden
 * preheader text (the summary inbox clients show next to the subject),
 * centered logo, white card on the app's own light-pink background, and a
 * footer - so each template only needs to supply its own heading/copy
 * instead of repeating the whole shell. Table-based layout is deliberate
 * (not flexbox/grid) since Outlook's rendering engine only reflows tables
 * reliably.
 */
const renderEmailLayout = ({ preheader, bodyHtml }) => `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:${BRAND.pageBg};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.pageBg};padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:100%;background-color:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:16px;">
            <tr>
              <td style="padding:36px 40px 20px 40px;text-align:center;">
                <img src="${LOGO_URL}" alt="DocWellness" width="176" style="display:inline-block;border:0;max-width:176px;" />
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 36px 40px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 40px;border-top:1px solid ${BRAND.border};">
                <p style="margin:0;font-size:12px;line-height:18px;color:${BRAND.muted};text-align:center;">
                  &copy; ${new Date().getFullYear()} DocWellness &middot; Nourishing you, transforming lives.<br />
                  This is an automated message - please don't reply directly to this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const ctaButton = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0 0;">
    <tr>
      <td style="border-radius:8px;background-color:${BRAND.primary};">
        <a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>
      </td>
    </tr>
  </table>
`;

const otpBlock = (otp) => `
  <div style="background-color:${BRAND.codeBg};border:1px solid ${BRAND.border};border-radius:12px;padding:22px;text-align:center;margin:20px 0 24px 0;">
    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:${BRAND.heading};font-family:'Courier New',Courier,monospace;">${otp}</span>
  </div>
`;

// Send welcome email
const sendWelcomeEmail = async (user) => {
  const name = user.profile?.fullName || 'there';
  const subject = 'Welcome to DocWellness!';
  const html = renderEmailLayout({
    preheader: 'Thanks for joining DocWellness - here is how to get started.',
    bodyHtml: `
      <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:${BRAND.heading};">Welcome to DocWellness!</h1>
      <p style="margin:0 0 16px 0;font-size:15px;line-height:24px;color:${BRAND.text};">Hi ${name},</p>
      <p style="margin:0 0 16px 0;font-size:15px;line-height:24px;color:${BRAND.text};">Thank you for joining DocWellness. We're excited to have you on board! With DocWellness, you can:</p>
      <ul style="margin:0 0 24px 0;padding-left:20px;font-size:15px;line-height:26px;color:${BRAND.text};">
        <li>Track your health metrics</li>
        <li>Get personalized diet plans</li>
        <li>Log your daily meals</li>
        <li>Monitor your progress</li>
        <li>Chat with dieticians</li>
      </ul>
      <p style="margin:0 0 8px 0;font-size:15px;line-height:24px;color:${BRAND.text};">Get started by completing your profile and health information.</p>
      ${ctaButton(`${config.frontendUrl}/dashboard`, 'Go to Dashboard')}
      <p style="margin:32px 0 0 0;font-size:14px;color:${BRAND.muted};">Best regards,<br />The DocWellness Team</p>
    `,
  });

  return dispatchEmail({
    to: user.email,
    subject,
    text: `Welcome to DocWellness! Thank you for joining us.`,
    html,
    from: config.email.fromAddressPersonal,
  });
};

// Send password reset code (Supabase-generated OTP, sent via our own
// branding instead of Supabase's default templates - see forgotPassword in
// authController.js)
const sendPasswordResetOtp = async (user, otp) => {
  const name = user.profile?.fullName || 'there';
  const subject = 'Your DocWellness password reset code';
  const html = renderEmailLayout({
    preheader: `Your password reset code is ${otp}`,
    bodyHtml: `
      <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:${BRAND.heading};">Password reset code</h1>
      <p style="margin:0 0 8px 0;font-size:15px;line-height:24px;color:${BRAND.text};">Hi ${name},</p>
      <p style="margin:0;font-size:15px;line-height:24px;color:${BRAND.text};">Use this code in the app to reset your password:</p>
      ${otpBlock(otp)}
      <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND.muted};">This code expires shortly. If you didn't request this, you can safely ignore this email.</p>
      <p style="margin:32px 0 0 0;font-size:14px;color:${BRAND.muted};">Best regards,<br />The DocWellness Team</p>
    `,
  });

  return dispatchEmail(
    {
      to: user.email,
      subject,
      text: `Your DocWellness password reset code is: ${otp}`,
      html,
    },
    { urgent: true }
  );
};

// Send signup verification code (same OTP-via-Resend pattern as password
// reset - see signupRequest in authController.js). Takes a plain email
// string rather than a user object since no Mongo profile exists yet at
// this point in the flow.
const sendSignupOtp = async (email, otp) => {
  const subject = 'Verify your DocWellness account';
  const html = renderEmailLayout({
    preheader: `Your verification code is ${otp}`,
    bodyHtml: `
      <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:${BRAND.heading};">Welcome to DocWellness!</h1>
      <p style="margin:0;font-size:15px;line-height:24px;color:${BRAND.text};">Use this code in the app to verify your email and finish creating your account:</p>
      ${otpBlock(otp)}
      <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND.muted};">This code expires shortly. If you didn't request this, you can safely ignore this email.</p>
      <p style="margin:32px 0 0 0;font-size:14px;color:${BRAND.muted};">Best regards,<br />The DocWellness Team</p>
    `,
  });

  return dispatchEmail(
    {
      to: email,
      subject,
      text: `Your DocWellness verification code is: ${otp}`,
      html,
      from: config.email.fromAddressPersonal,
    },
    { urgent: true }
  );
};

// Send diet plan notification
const sendDietPlanNotification = async (user, dietPlan, action) => {
  const actionMessages = {
    requested: 'A new diet plan has been requested',
    approved: 'Your diet plan has been approved',
    rejected: 'Your diet plan has been rejected',
    completed: 'Congratulations! You have completed your diet plan',
  };
  const name = user.profile?.fullName || 'there';

  const subject = `Diet Plan ${action.charAt(0).toUpperCase() + action.slice(1)} - DocWellness`;
  const html = renderEmailLayout({
    preheader: actionMessages[action],
    bodyHtml: `
      <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:${BRAND.heading};">Diet plan update</h1>
      <p style="margin:0 0 8px 0;font-size:15px;line-height:24px;color:${BRAND.text};">Hi ${name},</p>
      <p style="margin:0 0 20px 0;font-size:15px;line-height:24px;color:${BRAND.text};">${actionMessages[action]}</p>
      <div style="background-color:${BRAND.codeBg};border:1px solid ${BRAND.border};border-radius:12px;padding:20px;margin:0 0 24px 0;">
        <p style="margin:0 0 6px 0;font-size:16px;font-weight:600;color:${BRAND.heading};">${dietPlan.name}</p>
        ${dietPlan.description ? `<p style="margin:0 0 10px 0;font-size:14px;line-height:22px;color:${BRAND.text};">${dietPlan.description}</p>` : ''}
        <p style="margin:0;font-size:13px;color:${BRAND.muted};">Status: <strong style="color:${BRAND.text};">${dietPlan.status}</strong></p>
      </div>
      ${ctaButton(`${config.frontendUrl}/diet-plans/${dietPlan._id}`, 'View Diet Plan')}
      <p style="margin:32px 0 0 0;font-size:14px;color:${BRAND.muted};">Best regards,<br />The DocWellness Team</p>
    `,
  });

  return dispatchEmail({
    to: user.email,
    subject,
    text: `${actionMessages[action]}. Plan: ${dietPlan.name}`,
    html,
  });
};

module.exports = {
  sendEmail,
  dispatchEmail,
  sendWelcomeEmail,
  sendPasswordResetOtp,
  sendSignupOtp,
  sendDietPlanNotification,
};
