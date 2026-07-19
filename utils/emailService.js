// EMAIL USAGE SUMMARY:
// Email is used in the following controllers and functions:
// - controllers/patient/paymentController.js: sendPaymentConfirmation
// - controllers/patient/authController.js: sendEmail, sendWelcomeEmail
//
// This file defines utility functions for sending emails, including:
// - sendEmail: Generic email sender
// - sendWelcomeEmail: Sends a welcome email to new users
// - sendDietPlanNotification: Notifies users about diet plan updates
// - sendPaymentConfirmation: Confirms payment to users

const { Resend } = require('resend');
const config = require('../config/environment');

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

// Send welcome email
const sendWelcomeEmail = async (user) => {
  const subject = 'Welcome to DocWellness!';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #4CAF50;">Welcome to DocWellness!</h1>
      <p>Hi ${user.profile?.firstName || 'there'},</p>
      <p>Thank you for joining DocWellness. We're excited to have you on board!</p>
      <p>With DocWellness, you can:</p>
      <ul>
        <li>Track your health metrics</li>
        <li>Get personalized diet plans</li>
        <li>Log your daily meals</li>
        <li>Monitor your progress</li>
        <li>Chat with dieticians</li>
      </ul>
      <p>Get started by completing your profile and health information.</p>
      <a href="${config.frontendUrl}/dashboard" style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px;">Go to Dashboard</a>
      <p style="margin-top: 30px; color: #666;">Best regards,<br>The DocWellness Team</p>
    </div>
  `;

  return sendEmail({
    to: user.email,
    subject,
    text: `Welcome to DocWellness! Thank you for joining us.`,
    html,
    from: config.email.fromAddressPersonal,
  });
};

// Send diet plan notification
const sendDietPlanNotification = async (user, dietPlan, action) => {
  const actionMessages = {
    requested: 'A new diet plan has been requested',
    approved: 'Your diet plan has been approved',
    rejected: 'Your diet plan has been rejected',
    completed: 'Congratulations! You have completed your diet plan',
  };

  const subject = `Diet Plan ${action.charAt(0).toUpperCase() + action.slice(1)} - DocWellness`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #4CAF50;">Diet Plan Update</h1>
      <p>Hi ${user.profile?.firstName || 'there'},</p>
      <p>${actionMessages[action]}</p>
      <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
        <h3 style="margin-top: 0;">${dietPlan.name}</h3>
        <p>${dietPlan.description || ''}</p>
        <p><strong>Status:</strong> ${dietPlan.status}</p>
      </div>
      <a href="${config.frontendUrl}/diet-plans/${dietPlan._id}" style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">View Diet Plan</a>
      <p style="margin-top: 30px; color: #666;">Best regards,<br>The DocWellness Team</p>
    </div>
  `;

  return sendEmail({
    to: user.email,
    subject,
    text: `${actionMessages[action]}. Plan: ${dietPlan.name}`,
    html,
  });
};

// Send payment confirmation
const sendPaymentConfirmation = async (user, payment, dietPlan) => {
  const subject = 'Payment Confirmation - DocWellness';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #4CAF50;">Payment Successful!</h1>
      <p>Hi ${user.profile?.firstName || 'there'},</p>
      <p>Your payment has been successfully processed.</p>
      <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
        <h3 style="margin-top: 0;">Payment Details</h3>
        <p><strong>Amount:</strong> ₹${payment.amount}</p>
        <p><strong>Diet Plan:</strong> ${dietPlan.name}</p>
        <p><strong>Payment ID:</strong> ${payment.razorpayPaymentId}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
      </div>
      <p>Your diet plan is now active. Get started on your wellness journey!</p>
      <a href="${config.frontendUrl}/diet-plans/${dietPlan._id}" style="display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">View Diet Plan</a>
      <p style="margin-top: 30px; color: #666;">Best regards,<br>The DocWellness Team</p>
    </div>
  `;

  return sendEmail({
    to: user.email,
    subject,
    text: `Payment of ₹${payment.amount} confirmed for ${dietPlan.name}`,
    html,
  });
};

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendDietPlanNotification,
  sendPaymentConfirmation,
};
