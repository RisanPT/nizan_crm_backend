import * as dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

export const transporter =
  process.env.NODEMAILER_EMAIL && process.env.NODEMAILER_PASS
    ? nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        auth: {
          user: process.env.NODEMAILER_EMAIL,
          pass: process.env.NODEMAILER_PASS,
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
