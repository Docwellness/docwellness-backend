/**
 * Masking for personal data shown in the admin panel
 * (openspec: admin-user-management, "Personal data is masked by default").
 * Pure functions, no I/O. The full value is only returned by the audited
 * reveal endpoint.
 */

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length <= 2) return '*'.repeat(digits.length);
  return `${'*'.repeat(Math.min(8, digits.length - 2))}${digits.slice(-2)}`;
}

function maskEmail(value) {
  const s = String(value || '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? '***' : '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return `${local[0]}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

/** Date of birth is shown as the year only until revealed. */
function maskDob(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `**/**/${d.getUTCFullYear()}`;
}

module.exports = { maskPhone, maskEmail, maskDob };
