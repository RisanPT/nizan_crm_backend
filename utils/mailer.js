import * as dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

export const transporter =
  process.env.NODEMAILER_EMAIL && process.env.NODEMAILER_PASS
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST?.trim() || 'smtp.titan.email',
        port: Number(process.env.SMTP_PORT?.trim()) || 465,
        secure: Number(process.env.SMTP_PORT?.trim() || 465) === 465,
        auth: {
          user: process.env.NODEMAILER_EMAIL.trim(),
          pass: process.env.NODEMAILER_PASS.trim(),
        },
      })
    : null;

export const sendMail = async (activeTransporter, mailOptions) => {
  try {
    if (!activeTransporter) {
      console.warn('mail transporter is not configured');
      return false;
    }

    await activeTransporter.sendMail(mailOptions);
    console.log('mail sent');
    return true;
  } catch (error) {
    console.log(error);
    return false;
  }
};
