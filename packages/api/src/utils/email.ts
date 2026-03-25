import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from './logger.js';

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

/**
 * Send a password-reset OTP email with GasLink branding.
 */
export async function sendOtpEmail(to: string, otp: string, userName: string): Promise<void> {
  if (!config.smtp.host || !config.smtp.user) {
    logger.warn('SMTP not configured — OTP email not sent', { to });
    // In development, log the OTP so devs can still test
    if (config.isDev) {
      logger.info(`[DEV] Password reset OTP for ${to}: ${otp}`);
    }
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
          <!-- Header -->
          <tr>
            <td style="background-color:#1a2332;padding:24px 32px;text-align:center;">
              <span style="font-size:24px;font-weight:800;color:#ffffff;">MyGas</span><span style="font-size:24px;font-weight:800;color:#e63946;">Link</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 8px;font-size:20px;color:#1a2332;">Password Reset</h2>
              <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Hi ${userName},</p>
              <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">
                We received a request to reset your password. Use the OTP below to proceed. This code is valid for <strong>10 minutes</strong>.
              </p>
              <!-- OTP Box -->
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
          <!-- Footer -->
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
    await getTransporter().sendMail({
      from: `"MyGasLink" <${config.smtp.from}>`,
      to,
      subject: 'Password Reset OTP - MyGasLink',
      html,
    });
    logger.info('OTP email sent', { to });
  } catch (err) {
    logger.error('Failed to send OTP email', { to, error: (err as Error).message });
    throw new Error('Failed to send OTP email. Please try again later.');
  }
}
