import { sendMail, transporter } from './mailer.js';

const toCurrency = (amount) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);

const parseDateOnlyValue = (value) => {
  const stringValue = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stringValue);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    );
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toDisplayDate = (value) => {
  const date = parseDateOnlyValue(value);
  if (!date) return '-';
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

const toSelectedDatesLabel = (booking) => {
  const selectedDates = Array.isArray(booking.selectedDates)
    ? booking.selectedDates
    : [];

  const normalizedDates = selectedDates
    .map(parseDateOnlyValue)
    .filter(Boolean);

  if (normalizedDates.length > 0) {
    return normalizedDates.map((date) => toDisplayDate(date)).join(', ');
  }

  return toDisplayDate(booking.serviceStart);
};

const toBookingNumber = (booking) => {
  const explicitBookingNumber = String(booking?.bookingNumber ?? '').trim();
  if (explicitBookingNumber) return explicitBookingNumber;

  const id = String(booking?._id ?? booking?.id ?? '').trim();
  if (!id) return '0000000000';
  if (/^\d+$/.test(id)) return id;

  if (/^[a-f0-9]+$/i.test(id)) {
    try {
      const numericValue = BigInt(`0x${id}`).toString();
      return numericValue.length > 10
        ? numericValue.slice(-10)
        : numericValue;
    } catch (_) {
      // Fall through to the generic digit cleanup below.
    }
  }

  const digitsOnly = id.replace(/\D/g, '');
  return digitsOnly || '0000000000';
};

const toInvoiceItems = (booking) => {
  const bookingItems = Array.isArray(booking?.bookingItems)
    ? booking.bookingItems
    : [];

  if (bookingItems.length > 0) {
    let invoiceCounter = 1;
    return bookingItems.flatMap((item) => {
      const itemDates =
        Array.isArray(item?.selectedDates) && item.selectedDates.length > 0
          ? item.selectedDates
          : booking?.selectedDates ?? [];
      const normalizedDates = itemDates.length > 0 ? itemDates : [''];

      return normalizedDates.map((selectedDate) => ({
        invoiceNumber: `${toBookingNumber(booking)}-${String(invoiceCounter++).padStart(2, '0')}`,
        service: String(item?.service ?? booking?.service ?? '').trim() || 'Package',
        eventSlot: String(item?.eventSlot ?? '').trim(),
        selectedDates: selectedDate ? [selectedDate] : [],
        totalPrice: Number(item?.totalPrice) || 0,
        advanceAmount: Number(item?.advanceAmount) || 0,
      }));
    });
  }

  const bookingDates =
    Array.isArray(booking?.selectedDates) && booking.selectedDates.length > 0
      ? booking.selectedDates
      : [''];

  return bookingDates.map((selectedDate, index) => ({
    invoiceNumber: `${toBookingNumber(booking)}-${String(index + 1).padStart(2, '0')}`,
    service: booking?.service ?? 'Package',
    eventSlot: booking?.eventSlot ?? '',
    selectedDates: selectedDate ? [selectedDate] : [],
    totalPrice: Number(booking?.totalPrice) || 0,
    advanceAmount: Number(booking?.advanceAmount) || 0,
  }));
};

const toInvoiceDateLabel = (selectedDates = [], fallbackBooking) => {
  return selectedDates.map((date) => toDisplayDate(date)).join(', ') || toSelectedDatesLabel(fallbackBooking);
};

const toInvoiceTotals = (booking) => {
  const items = toInvoiceItems(booking);
  return {
    items,
    totalAmount:
      Number(booking?.totalPrice) ||
      items.reduce((sum, item) => sum + item.totalPrice, 0),
    totalAdvance:
      Number(booking?.advanceAmount) ||
      items.reduce((sum, item) => sum + item.advanceAmount, 0),
  };
};

const renderAdvanceInvoiceSections = (booking) =>
  toInvoiceItems(booking)
    .map(
      (item, index) => `
        <div style="border:1px solid #d9dde3;border-radius:14px;padding:18px;margin:16px 0;background:#fcfcfd;">
          <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:12px;">Package ${index + 1}</div>
          <table style="border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Invoice No</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${item.invoiceNumber}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toBookingNumber(booking)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Package</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${item.service}</td></tr>
            ${item.eventSlot ? `<tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Slot</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${item.eventSlot}</td></tr>` : ''}
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Region</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking.region || 'Default'}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Selected Dates</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toInvoiceDateLabel(item.selectedDates, booking)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Advance Paid</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(item.advanceAmount)}</td></tr>
          </table>
        </div>
      `,
    )
    .join('');

const renderCompletionInvoiceSections = (booking) =>
  toInvoiceItems(booking)
    .map(
      (item, index) => `
        <div style="border:1px solid #d9dde3;border-radius:14px;padding:18px;margin:16px 0;background:#fcfcfd;">
          <div style="font-size:16px;font-weight:700;color:#0f172a;margin-bottom:12px;">Package ${index + 1}</div>
          <table style="border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Invoice No</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${item.invoiceNumber}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Booking ID</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toBookingNumber(booking)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Package</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${item.service}</td></tr>
            ${item.eventSlot ? `<tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Slot</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${item.eventSlot}</td></tr>` : ''}
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Region</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${booking.region || 'Default'}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Selected Dates</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toInvoiceDateLabel(item.selectedDates, booking)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Time</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toDisplayTime(booking.serviceStart)} - ${toDisplayTime(booking.serviceEnd)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Package Total</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(item.totalPrice)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Amount Paid</strong></td><td style="padding:8px;border:1px solid #d9dde3;">${toCurrency(item.totalPrice)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #d9dde3;"><strong>Payment Status</strong></td><td style="padding:8px;border:1px solid #d9dde3;">Paid in Full</td></tr>
          </table>
        </div>
      `,
    )
    .join('');

export const sendAdvanceInvoiceEmail = async (booking) => {
  if (!transporter) {
    console.warn(
      'Skipping advance invoice email because nodemailer settings are incomplete.'
    );
    return false;
  }

  const fromEmail =
    process.env.NODEMAILER_EMAIL ||
    'noreply@teamnmakeover.local';
  const companyName = process.env.COMPANY_NAME || 'Team N Makeovers';
  const { items, totalAmount, totalAdvance } = toInvoiceTotals(booking);

  return sendMail(transporter, {
    from: fromEmail,
    to: booking.email,
    subject: `Advance Payment Invoice - ${booking.customerName}`,
    text: `Hello ${booking.customerName},\n\nYour booking has been confirmed. Please review your advance payment details.\n\nBooking ID: ${toBookingNumber(booking)}\nTotal Advance Paid: ${toCurrency(totalAdvance)}\n\nPlease contact us if you have any questions.\n\nRegards,\n${companyName}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6;">
        <h2 style="margin-bottom:8px;">Advance Payment Invoice</h2>
        <p>Hello ${booking.customerName},</p>
        <p>Your booking has been confirmed. Please review your advance payment details below.</p>
        <div style="display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:14px;margin:20px 0;">
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Booking ID</div>
            <div style="font-size:22px;font-weight:700;">${toBookingNumber(booking)}</div>
          </div>
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Selected Dates</div>
            <div style="font-size:18px;font-weight:700;">${toSelectedDatesLabel(booking)}</div>
          </div>
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Package</div>
            <div style="font-size:18px;font-weight:700;">${booking.service || 'Standard Package'}</div>
          </div>
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fff7ed;border-color:#fed7aa;">
            <div style="font-size:12px;text-transform:uppercase;color:#9a3412;margin-bottom:8px;">Total Advance Paid</div>
            <div style="font-size:24px;font-weight:800;color:#c2410c;">${toCurrency(totalAdvance)}</div>
          </div>
        </div>
        ${items.length > 1 ? '<p style="margin:18px 0 8px;font-weight:700;">Package-wise breakdown</p>' : ''}
        ${renderAdvanceInvoiceSections(booking)}
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
    'noreply@teamnmakeover.local';
  const companyName = process.env.COMPANY_NAME || 'Team N Makeovers';
  const { items, totalAmount, totalAdvance } = toInvoiceTotals(booking);

  const discountAmt = Number(booking.discountAmount) || 0;
  // collectedAmount = sum of all verified artist collections (synced by backend)
  const collectedAmt = Number(booking.collectedAmount) || 0;
  const subtotal = totalAmount;
  const balanceDue = Math.max(0, subtotal - discountAmt - totalAdvance - collectedAmt);
  const isFullyPaid = balanceDue <= 0;

  const assignedArtists = (booking.assignedStaff ?? [])
    .map((staff) => staff.artistName)
    .filter(Boolean)
    .join(', ');

  const paymentSummaryRows = `
    <tr style="border-top:2px solid #d9dde3;">
      <td style="padding:10px 12px;font-size:14px;">Booking Total</td>
      <td style="padding:10px 12px;font-size:14px;text-align:right;">${toCurrency(subtotal)}</td>
    </tr>
    ${discountAmt > 0 ? `
    <tr>
      <td style="padding:6px 12px;font-size:14px;color:#667085;">Less: Discount</td>
      <td style="padding:6px 12px;font-size:14px;text-align:right;color:#667085;">− ${toCurrency(discountAmt)}</td>
    </tr>` : ''}
    ${totalAdvance > 0 ? `
    <tr>
      <td style="padding:6px 12px;font-size:14px;color:#667085;">Less: Advance Paid</td>
      <td style="padding:6px 12px;font-size:14px;text-align:right;color:#667085;">− ${toCurrency(totalAdvance)}</td>
    </tr>` : ''}
    ${collectedAmt > 0 ? `
    <tr>
      <td style="padding:6px 12px;font-size:14px;color:#667085;">Less: Final Payment Collected</td>
      <td style="padding:6px 12px;font-size:14px;text-align:right;color:#667085;">− ${toCurrency(collectedAmt)}</td>
    </tr>` : ''}
    <tr style="border-top:2px solid #d9dde3;background:${isFullyPaid ? '#ecfdf3' : '#fff7ed'};">
      <td style="padding:12px;font-size:16px;font-weight:700;color:${isFullyPaid ? '#166534' : '#9a3412'};">Balance Due</td>
      <td style="padding:12px;font-size:20px;font-weight:800;text-align:right;color:${isFullyPaid ? '#166534' : '#c2410c'};">${isFullyPaid ? '₹ 0' : toCurrency(balanceDue)}</td>
    </tr>
    <tr style="background:${isFullyPaid ? '#ecfdf3' : '#fff7ed'};">
      <td colspan="2" style="padding:4px 12px 12px;font-size:13px;font-weight:700;color:${isFullyPaid ? '#166534' : '#9a3412'};text-align:center;">
        ${isFullyPaid ? '✅ PAID IN FULL' : '⚠️ PAYMENT PENDING'}
      </td>
    </tr>
  `;

  return sendMail(transporter, {
    from: fromEmail,
    to: booking.email,
    subject: `Work Completion Invoice - ${booking.customerName}`,
    text: `Hello ${booking.customerName},\n\nYour work has been marked as completed.\n\nBooking ID: ${toBookingNumber(booking)}\nTotal: ${toCurrency(subtotal)}\nAdvance Paid: ${toCurrency(totalAdvance)}\nFinal Payment Collected: ${toCurrency(collectedAmt)}\nBalance Due: ${toCurrency(balanceDue)}\nPayment Status: ${isFullyPaid ? 'Paid in Full' : 'Pending'}\n\nRegards,\n${companyName}`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6;max-width:640px;margin:0 auto;">
        <h2 style="margin-bottom:8px;">Work Completion Invoice</h2>
        <p>Hello ${booking.customerName},</p>
        <p>Your work has been marked as completed. Please find the final payment summary below.</p>

        <div style="display:grid;grid-template-columns:repeat(2,minmax(200px,1fr));gap:14px;margin:20px 0;">
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Booking ID</div>
            <div style="font-size:22px;font-weight:700;">${toBookingNumber(booking)}</div>
          </div>
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Selected Dates</div>
            <div style="font-size:18px;font-weight:700;">${toSelectedDatesLabel(booking)}</div>
          </div>
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Package</div>
            <div style="font-size:18px;font-weight:700;">${booking.service || 'Standard Package'}</div>
          </div>
          <div style="border:1px solid #d9dde3;border-radius:14px;padding:16px;background:#fcfcfd;">
            <div style="font-size:12px;text-transform:uppercase;color:#667085;margin-bottom:8px;">Assigned Team</div>
            <div style="font-size:16px;font-weight:700;">${assignedArtists || 'Assigned by admin'}</div>
          </div>
        </div>

        <p style="margin:20px 0 8px;font-weight:700;font-size:15px;">Payment Breakdown</p>
        <table style="border-collapse:collapse;width:100%;border:1px solid #d9dde3;border-radius:12px;overflow:hidden;">
          <thead>
            <tr style="background:#f8fafc;">
              <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#667085;">Description</th>
              <th style="padding:10px 12px;text-align:right;font-size:12px;text-transform:uppercase;color:#667085;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${paymentSummaryRows}
          </tbody>
        </table>

        ${items.length > 1 ? '<p style="margin:18px 0 8px;font-weight:700;">Package-wise breakdown</p>' : ''}
        ${renderCompletionInvoiceSections(booking)}

        <p>Please contact us if you need the detailed invoice breakdown or payment support.</p>
        <p>Regards,<br />${companyName}</p>
      </div>
    `,
  });
};
