import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { sendSuccess, sendError, sendCreated } from '../utils/apiResponse.js';
import { contactFormSchema } from '@gaslink/shared';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// POST /api/contact - public contact form
router.post('/',
  validate(contactFormSchema),
  async (req, res) => {
    try {
      const data = req.body;

      const submission = await prisma.contactSubmission.create({
        data: {
          name: data.name,
          phone: data.phone,
          email: data.email || null,
          agency: data.agency,
          agencyName: data.agencyName,
          monthlySale: data.monthlySale,
        },
      });

      // Send email notification (non-blocking)
      if (config.smtp.host && config.smtp.contactEmail) {
        try {
          const nodemailer = await import('nodemailer');
          const transporter = nodemailer.default.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            auth: {
              user: config.smtp.user,
              pass: config.smtp.pass,
            },
          });

          await transporter.sendMail({
            from: config.smtp.from,
            to: config.smtp.contactEmail,
            subject: `New Contact Form Submission - ${data.agencyName}`,
            html: `
              <h2>New Contact Form Submission</h2>
              <p><strong>Name:</strong> ${escapeHtml(data.name)}</p>
              <p><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
              <p><strong>Email:</strong> ${escapeHtml(data.email || 'N/A')}</p>
              <p><strong>Agency:</strong> ${escapeHtml(data.agency)}</p>
              <p><strong>Agency Name:</strong> ${escapeHtml(data.agencyName)}</p>
              <p><strong>Monthly Sale:</strong> ${escapeHtml(data.monthlySale)}</p>
            `,
          });
        } catch (emailErr) {
          logger.error('Failed to send contact form email', { error: (emailErr as Error).message });
        }
      }

      return sendCreated(res, { message: 'Contact form submitted successfully', id: submission.id });
    } catch (err) {
      return sendError(res, (err as Error).message);
    }
  }
);

export default router;
