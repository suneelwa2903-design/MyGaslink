import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { prisma } from '../lib/prisma.js';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  }
  return transporter;
}

/** Reset the cached transporter — used by tests to force a fresh client after env changes. */
export function _resetTransporter(): void {
  transporter = null;
}

// ─── EmailLog audit writer ───────────────────────────────────────────────────
// Every outbound email writes one row (sent | failed | skipped). Best-effort:
// the audit write must never block the caller — if logging fails we record
// the failure to Winston and move on.
type EmailLogType =
  | 'welcome'
  | 'password_reset_otp'
  | 'contact_form'
  | 'smtp_test';

type EmailLogStatus = 'sent' | 'failed' | 'skipped';

async function writeEmailLog(input: {
  toEmail: string;
  subject: string;
  type: EmailLogType;
  status: EmailLogStatus;
  errorText?: string | null;
  userId?: string | null;
}): Promise<void> {
  try {
    await prisma.emailLog.create({
      data: {
        toEmail: input.toEmail,
        subject: input.subject,
        type: input.type,
        status: input.status,
        errorText: input.errorText ?? null,
        userId: input.userId ?? null,
      },
    });
  } catch (err) {
    logger.error('Failed to write email_logs row', {
      type: input.type,
      to: input.toEmail,
      error: (err as Error).message,
    });
  }
}

function fromHeader(): string {
  return `"${config.smtp.fromName}" <${config.smtp.from}>`;
}

// ─── Password reset OTP ──────────────────────────────────────────────────────
export async function sendOtpEmail(to: string, otp: string, userName: string): Promise<void> {
  const subject = 'Password Reset OTP - MyGasLink';

  if (!config.smtp.host || !config.smtp.user) {
    logger.warn('SMTP not configured — OTP email not sent', { to });
    if (config.isDev) {
      logger.info(`[DEV] Password reset OTP for ${to}: ${otp}`);
    }
    await writeEmailLog({ toEmail: to, subject, type: 'password_reset_otp', status: 'skipped', errorText: 'SMTP not configured' });
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#1a2332;padding:24px 32px;text-align:center;">
              <span style="font-size:24px;font-weight:800;color:#ffffff;">MyGas</span><span style="font-size:24px;font-weight:800;color:#e63946;">Link</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 8px;font-size:20px;color:#1a2332;">Password Reset</h2>
              <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Hi ${userName},</p>
              <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
                We received a request to reset your password. Use the OTP below to proceed. This code is valid for <strong>10 minutes</strong>.
              </p>
              <div style="text-align:center;margin:0 0 24px;">
                <div style="display:inline-block;background-color:#f0f4ff;border:2px dashed #e63946;border-radius:12px;padding:16px 40px;">
                  <span style="font-size:32px;font-weight:800;letter-spacing:8px;color:#1a2332;">${otp}</span>
                </div>
              </div>
              <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;line-height:1.5;">
                If you did not request this, please ignore this email. Your password will remain unchanged.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                &copy; ${new Date().getFullYear()} MyGasLink. Commercial LPG Distribution Platform.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    await getTransporter().sendMail({ from: fromHeader(), to, subject, html });
    logger.info('OTP email sent', { to });
    await writeEmailLog({ toEmail: to, subject, type: 'password_reset_otp', status: 'sent' });
  } catch (err) {
    const message = (err as Error).message;
    logger.error('Failed to send OTP email', { to, error: message });
    await writeEmailLog({ toEmail: to, subject, type: 'password_reset_otp', status: 'failed', errorText: message });
    throw new Error('Failed to send OTP email. Please try again later.');
  }
}

// ─── Welcome email on new-user creation ─────────────────────────────────────
// Sent immediately after POST /api/users creates a user. Carries the temporary
// password set by the admin (the user must change it on first login —
// `requiresPasswordReset` is already true on the row). If SMTP isn't
// configured or the send fails we DO NOT throw — user creation must succeed
// regardless, and the admin can copy the temp password from the modal banner
// and WhatsApp it manually (Group B Part 2 manual-handoff fallback).
export async function sendWelcomeEmail(input: {
  to: string;
  name: string;
  email: string;
  tempPassword: string;
  loginUrl: string;
  distributorName?: string | null;
  userId?: string | null;
}): Promise<{ status: EmailLogStatus; error?: string }> {
  const subject = 'Welcome to MyGasLink — Your login credentials';

  if (!config.smtp.host || !config.smtp.user) {
    logger.warn('SMTP not configured — welcome email not sent', { to: input.to });
    await writeEmailLog({
      toEmail: input.to,
      subject,
      type: 'welcome',
      status: 'skipped',
      errorText: 'SMTP not configured',
      userId: input.userId,
    });
    return { status: 'skipped', error: 'SMTP not configured' };
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#1a2332;padding:24px 32px;text-align:center;">
              <span style="font-size:24px;font-weight:800;color:#ffffff;">MyGas</span><span style="font-size:24px;font-weight:800;color:#e63946;">Link</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 8px;font-size:20px;color:#1a2332;">Welcome aboard, ${escapeHtml(input.name)} 👋</h2>
              <p style="margin:0 0 20px;font-size:14px;color:#6b7280;line-height:1.6;">
                Your MyGasLink account ${input.distributorName ? `with <strong>${escapeHtml(input.distributorName)}</strong> ` : ''}is ready.
                Use the temporary password below to log in — you'll be prompted to set a new one immediately.
              </p>
              <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
                <tr>
                  <td style="padding:6px 0;font-size:13px;color:#9ca3af;width:140px;">Login URL</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a2332;"><a href="${input.loginUrl}" style="color:#e63946;text-decoration:none;">${input.loginUrl}</a></td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:13px;color:#9ca3af;">Email</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a2332;font-family:monospace;">${escapeHtml(input.email)}</td>
                </tr>
                <tr>
                  <td style="padding:6px 0;font-size:13px;color:#9ca3af;">Temporary password</td>
                  <td style="padding:6px 0;">
                    <span style="display:inline-block;background-color:#f0f4ff;border:1px dashed #e63946;border-radius:8px;padding:8px 14px;font-family:monospace;font-size:15px;color:#1a2332;">${escapeHtml(input.tempPassword)}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;color:#9ca3af;line-height:1.5;">
                For your security, please change this password on first login. If you didn't expect this email, ignore it — the account will be removed by your administrator.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;padding:16px 32px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                &copy; ${new Date().getFullYear()} MyGasLink. Commercial LPG Distribution Platform.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    await getTransporter().sendMail({ from: fromHeader(), to: input.to, subject, html });
    logger.info('Welcome email sent', { to: input.to, userId: input.userId });
    await writeEmailLog({ toEmail: input.to, subject, type: 'welcome', status: 'sent', userId: input.userId });
    return { status: 'sent' };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`Welcome email failed for user ${input.userId ?? '?'}: ${message}`);
    await writeEmailLog({
      toEmail: input.to,
      subject,
      type: 'welcome',
      status: 'failed',
      errorText: message,
      userId: input.userId,
    });
    return { status: 'failed', error: message };
  }
}

// ─── Diagnostic — used by scripts/test-smtp.ts ───────────────────────────────
export async function sendSmtpTestEmail(to: string): Promise<void> {
  const subject = 'SMTP Test — MyGasLink';
  if (!config.smtp.host || !config.smtp.user) {
    throw new Error('SMTP_HOST and SMTP_USER must be set to run the SMTP test');
  }
  try {
    await getTransporter().sendMail({
      from: fromHeader(),
      to,
      subject,
      text: 'SMTP is configured and working. Sent from packages/api/scripts/test-smtp.ts.',
    });
    logger.info('SMTP test email sent', { to });
    await writeEmailLog({ toEmail: to, subject, type: 'smtp_test', status: 'sent' });
  } catch (err) {
    const message = (err as Error).message;
    logger.error('SMTP test email failed', { to, error: message });
    await writeEmailLog({ toEmail: to, subject, type: 'smtp_test', status: 'failed', errorText: message });
    throw err;
  }
}

// Minimal HTML escape for the few interpolation slots in the welcome email.
// Names + distributor names come from the DB and may contain quotes / angle
// brackets; we don't want them re-interpreted by a permissive email client.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
