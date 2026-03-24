import { sendMail, transporter } from './mailer.js';

const toCurrency = (amount) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);

const toDisplayDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
};

const toDisplayTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
};

export const sendAdvanceInvoiceEmail = async (booking) => {
  if (!transporter) {
    console.warn(
      'Skipping advance invoice email because nodemailer settings are incomplete.'
    );
    return false;
  }

  const fromEmail =
    process.env.NODEMAILER_EMAIL ||
    'noreply@nizancrm.local';
  const companyName = process.env.COMPANY_NAME || 'Nizan Makeovers';

  return sendMail(transporter, {
    from: fromEmail,
    to: booking.email,
    subject: `Advance Payment Invoice - ${booking.customerName}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6;">
        <h2 style="margin-bottom:8px;">Advance Payment Invoice</h2>
        <p>Hello ${booking.customerName},</p>
        <p>Your booking has been confirmed. Please review your advance payment details below.</p>
        <table style="border-collapse:collapse;width:100%;margin:16px 0;">
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking._id}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Package</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking.service}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Region</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking.region || 'Default'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Date</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toDisplayDate(booking.serviceStart)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Total Amount</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(booking.totalPrice)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Advance Due</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(booking.advanceAmount)}</td></tr>
        </table>
        <p>Please contact us if you have any questions about this invoice.</p>
        <p>Regards,<br />${companyName}</p>
      </div>
    `,
  });
};

export const sendCompletionInvoiceEmail = async (booking) => {
  if (!transporter) {
    console.warn(
      'Skipping completion invoice email because nodemailer settings are incomplete.'
    );
    return false;
  }

  const fromEmail =
    process.env.NODEMAILER_EMAIL ||
    'noreply@nizancrm.local';
  const companyName = process.env.COMPANY_NAME || 'Nizan Makeovers';
  const addonsTotal = (booking.addons ?? []).reduce(
    (sum, addon) => sum + ((Number(addon.amount) || 0) * (Number(addon.persons) || 1)),
    0
  );
  const remainingAmount = Math.max(
    0,
    (Number(booking.totalPrice) || 0) -
      (Number(booking.advanceAmount) || 0) -
      (Number(booking.discountAmount) || 0)
  );
  const assignedArtists = (booking.assignedStaff ?? [])
    .map((staff) => staff.artistName)
    .filter(Boolean)
    .join(', ');

  return sendMail(transporter, {
    from: fromEmail,
    to: booking.email,
    subject: `Work Completion Invoice - ${booking.customerName}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6;">
        <h2 style="margin-bottom:8px;">Work Completion Invoice</h2>
        <p>Hello ${booking.customerName},</p>
        <p>Your work has been marked as completed. Please find the final invoice summary below.</p>
        <table style="border-collapse:collapse;width:100%;margin:16px 0;">
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking._id}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Package</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking.service}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Region</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking.region || 'Default'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Date</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toDisplayDate(booking.serviceStart)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Time</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toDisplayTime(booking.serviceStart)} - ${toDisplayTime(booking.serviceEnd)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Assigned Team</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${assignedArtists || 'Assigned by admin'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Total Amount</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(booking.totalPrice)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Advance Paid</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(booking.advanceAmount)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Discount</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(booking.discountAmount)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Add-ons Total</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(addonsTotal)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Balance Due</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(remainingAmount)}</td></tr>
        </table>
        <p>Please contact us if you need the detailed invoice breakdown or payment support.</p>
        <p>Regards,<br />${companyName}</p>
      </div>
    `,
  });
};
