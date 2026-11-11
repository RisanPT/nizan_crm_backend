import Review from '../models/Review.js';
import Booking from '../models/Booking.js';
import { IST_OFFSET_MS, addDays, isDay, istDayKey, istStart, todayIst } from '../utils/istDate.js';
import { isTeamnChatConfigured, sendTeamnChatTemplate, toWhatsAppPhone } from '../utils/teamnChat.js';

// Next-day review request. Once a day (default 10:00 IST) the CRM sends the
// approved `review_request` WhatsApp template, from the CRM number through
// TeamN Chat, to every client whose booking was completed on an earlier day
// and who hasn't been sent the review link by hand.
//
// Safety gates — nothing is sent unless ALL hold:
//   • REVIEW_AUTO_SEND_FROM=YYYY-MM-DD is set. Only reviews created on or after
//     that IST day are ever sent, so old clients are never messaged in bulk.
//     Unset (or invalid) = the feature is off.
//   • TEAMN_CHAT_KEY is set.
//   • The review is still pending, was never sent by hand (manualSentAt), and
//     its booking is still completed and not a legacy import.
//   • It is at most MAX_AGE_DAYS old — after downtime we don't thank someone
//     weeks later.
// TeamN Chat refuses a second send of the same template + phone + reference,
// and each review is claimed atomically before sending, so a retry or two
// server processes can't message a client twice.

export const MAX_AGE_DAYS = 7;
export const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 200;
const GAP_MS = 1500; // between sends, to stay gentle on TeamN Chat
const STUCK_MS = 60 * 60 * 1000; // a 'sending' claim older than this was abandoned

const config = () => {
  const from = String(process.env.REVIEW_AUTO_SEND_FROM || '').trim();
  const time = String(process.env.REVIEW_AUTO_SEND_TIME || '').trim();
  return {
    fromDay: isDay(from) ? from : null,
    sendTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '10:00',
    template: String(process.env.REVIEW_TEMPLATE_NAME || '').trim() || 'review_request',
    channel: String(process.env.REVIEW_TEMPLATE_CHANNEL || '').trim() || 'crm',
  };
};

const IST_LONG_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/// "4 November 2026" — the work / wedding date for the template's {{2}}.
export const formatWorkDate = (date) => IST_LONG_DATE.format(date);

/// The window of review creation times that may be sent today: from the
/// later of the go-live day and MAX_AGE_DAYS ago, up to (not including) today.
export const dueWindow = (today, fromDay) => {
  const oldest = addDays(today, -MAX_AGE_DAYS);
  const startDay = fromDay > oldest ? fromDay : oldest;
  return { $gte: istStart(startDay), $lt: istStart(today) };
};

/// What to do with a TeamN Chat answer. Returns
///   { kind: 'sent' | 'skipped' | 'failed' | 'retry', stopRun, error }
/// `stopRun` means the problem affects every send (key, template, service
/// down), so the rest of today's batch waits for tomorrow.
export const classifyResult = ({ status, body }, attempts) => {
  if (body?.ok === true) return { kind: 'sent', stopRun: false, error: '' };
  const error = String(body?.detail || body?.error || `HTTP ${status}`).slice(0, 300);
  if (status === 409) return { kind: 'skipped', stopRun: false, error: 'Client opted out of WhatsApp messages' };
  if (status === 400) return { kind: 'failed', stopRun: false, error };
  // 502 = WhatsApp refused this one message; everything else here hits every send.
  const systemic = [401, 403, 422, 429].includes(status) || (status >= 500 && status !== 502);
  const kind = attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
  return { kind, stopRun: systemic, error };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const finish = (id, fields) => Review.updateOne({ _id: id }, { $set: fields });

/**
 * Sends today's due review requests. Returns a summary. [send] and [gapMs] are
 * injectable for tests; nothing here touches TeamN Chat except through [send].
 */
export const runReviewAutoSend = async ({ now = new Date(), send = sendTeamnChatTemplate, gapMs = GAP_MS } = {}) => {
  const cfg = config();
  const summary = { sent: 0, duplicate: 0, skipped: 0, failed: 0, retry: 0, stopped: '' };
  if (!cfg.fromDay) return { ...summary, stopped: 'REVIEW_AUTO_SEND_FROM not set' };
  if (!isTeamnChatConfigured()) return { ...summary, stopped: 'TEAMN_CHAT_KEY not set' };

  const today = istDayKey(now);
  const due = await Review.find({
    status: 'pending',
    manualSentAt: null,
    createdAt: dueWindow(today, cfg.fromDay),
    $or: [
      { autoSendStatus: { $in: ['', 'retry'] } },
      // Left mid-send by a crash or restart. Safe to pick up: TeamN Chat
      // won't send the same review twice.
      { autoSendStatus: 'sending', updatedAt: { $lt: new Date(now.getTime() - STUCK_MS) } },
    ],
  })
    .select('_id autoSendStatus')
    .sort({ createdAt: 1 })
    .limit(BATCH_LIMIT)
    .lean();

  for (let i = 0; i < due.length; i++) {
    // Claim it: only one run may move it out of ''/'retry'.
    const review = await Review.findOneAndUpdate(
      { _id: due[i]._id, autoSendStatus: due[i].autoSendStatus, status: 'pending', manualSentAt: null },
      { $set: { autoSendStatus: 'sending' }, $inc: { autoSendAttempts: 1 } },
      { new: true }
    );
    if (!review) continue;

    const booking = review.booking
      ? await Booking.findById(review.booking).select('status legacyBooking phone customerName').lean()
      : null;
    const skip = (why) => {
      summary.skipped += 1;
      return finish(review._id, { autoSendStatus: 'skipped', autoSendError: why });
    };
    if (!booking) {
      await skip('Booking not found');
      continue;
    }
    if (String(booking.status ?? '').toLowerCase() !== 'completed') {
      await skip('Booking is no longer completed');
      continue;
    }
    if (booking.legacyBooking) {
      await skip('Legacy booking');
      continue;
    }
    const phone = toWhatsAppPhone(review.customerPhone || booking.phone);
    if (phone.length < 11) {
      await skip('No valid phone number');
      continue;
    }

    const name = String(review.brideName || booking.customerName || '').trim() || 'there';
    const result = await send({
      template: cfg.template,
      channel: cfg.channel,
      phone,
      customerName: name,
      reference: review.bookingNumber || String(review._id),
      bodyParams: [name, formatWorkDate(review.weddingDate || review.createdAt)],
      buttonParams: [review.token],
      sentBy: 'CRM auto',
    });
    const verdict = classifyResult(result, review.autoSendAttempts);

    if (verdict.kind === 'sent') {
      if (result.body.duplicate) summary.duplicate += 1;
      else summary.sent += 1;
      await finish(review._id, {
        autoSendStatus: 'sent',
        autoSentAt: result.body.sent_at ? new Date(result.body.sent_at) : now,
        autoMessageId: String(result.body.message_id ?? ''),
        autoSendError: '',
      });
    } else {
      summary[verdict.kind] += 1;
      await finish(review._id, { autoSendStatus: verdict.kind, autoSendError: verdict.error });
    }

    if (verdict.stopRun) {
      summary.stopped = verdict.error;
      break;
    }
    if (gapMs > 0 && i < due.length - 1) await sleep(gapMs);
  }
  return summary;
};

/// Starts the once-a-day schedule. Checks every minute; runs once per IST day
/// at or after the send time (so a restart later in the day still sends).
export const startReviewAutoSend = () => {
  const cfg = config();
  if (!cfg.fromDay) {
    console.log('[ReviewAutoSend] Off — set REVIEW_AUTO_SEND_FROM=YYYY-MM-DD to enable.');
    return null;
  }
  let lastRunDay = '';
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    const today = todayIst();
    const hhmm = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
    if (lastRunDay === today || hhmm < config().sendTime) return;
    running = true;
    lastRunDay = today;
    try {
      const r = await runReviewAutoSend({ now });
      console.log('[ReviewAutoSend] Daily run:', JSON.stringify(r));
    } catch (err) {
      console.error('[ReviewAutoSend] Run failed:', err?.message || err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, 60 * 1000);
  console.log(`[ReviewAutoSend] Scheduler started — daily at ${cfg.sendTime} IST for reviews from ${cfg.fromDay}.`);
  return handle;
};
