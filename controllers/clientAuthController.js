import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import ClientUser from '../models/ClientUser.js';
import Otp from '../models/Otp.js';
import Customer from '../models/Customer.js';
import { normalizePhone, isValidMobile } from '../utils/phone.js';
import { phoneSuffixFilter } from '../utils/phone.js';
import { sendOtpSms, smsConfigured } from '../utils/sms.js';
import { generateClientToken } from '../utils/clientToken.js';
import { transporter, sendMail } from '../utils/mailer.js';

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_THROTTLE_MS = 60 * 1000; // 60 seconds
const MAX_ATTEMPTS = 5;

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sixDigit = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

const publicBase = (req) => {
  const env = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
  if (env) return env;
  return `${req.protocol}://${req.get('host')}`;
};

const clientResponse = (client) => ({
  id: String(client._id),
  name: client.name || '',
  phone: client.phone || '',
  email: client.email || '',
});

// Find (don't force-create — Customer.email is unique/required) a CRM Customer
// for this phone, so staff see one person.
const linkCustomer = async (client) => {
  try {
    if (client.customerId) return;
    const existing = await Customer.findOne(phoneSuffixFilter(client.phone)).select('_id').lean();
    if (existing) {
      client.customerId = existing._id;
      await client.save();
    }
  } catch (err) {
    console.error('linkCustomer failed:', err.message);
  }
};

// @route POST /api/client/auth/request-otp  { phone }
export const requestOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!isValidMobile(phone)) {
      return res.status(400).json({ message: 'Enter a valid 10-digit mobile number' });
    }
    // Resend throttle: reuse the most recent live OTP window.
    const recent = await Otp.findOne({ phone, consumedAt: null }).sort({ createdAt: -1 });
    if (recent && Date.now() - new Date(recent.lastSentAt).getTime() < RESEND_THROTTLE_MS) {
      const wait = Math.ceil((RESEND_THROTTLE_MS - (Date.now() - new Date(recent.lastSentAt).getTime())) / 1000);
      return res.status(429).json({ message: `Please wait ${wait}s before requesting another code` });
    }

    const code = sixDigit();
    await Otp.create({
      phone,
      codeHash: hash(code),
      channel: 'sms',
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      lastSentAt: new Date(),
    });
    await sendOtpSms(phone, code);

    const payload = { message: 'OTP sent', channel: 'sms', configured: smsConfigured() };
    // Dev convenience ONLY: when running outside production with no SMS provider
    // wired, hand the code straight back so the app can auto-fill it for testing.
    // Double-gated so it can never leak once a real provider is configured.
    if (process.env.NODE_ENV !== 'production' && !smsConfigured()) {
      payload.devCode = code;
    }
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route POST /api/client/auth/verify-otp  { phone, code, name?, email? }
export const verifyOtp = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    if (!isValidMobile(phone) || code.length !== 6) {
      return res.status(400).json({ message: 'Enter the 6-digit code' });
    }

    const otp = await Otp.findOne({ phone, consumedAt: null }).sort({ createdAt: -1 });
    if (!otp) {
      return res.status(400).json({ message: 'Code expired — request a new one' });
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many attempts — request a new code' });
    }
    if (new Date(otp.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ message: 'Code expired — request a new one' });
    }

    if (otp.codeHash !== hash(code)) {
      otp.attempts += 1;
      await otp.save();
      return res.status(400).json({ message: 'Incorrect code' });
    }

    otp.consumedAt = new Date();
    await otp.save();

    // Upsert the client identity by phone.
    let client = await ClientUser.findOne({ phone });
    const incomingName = String(req.body.name || '').trim();
    const incomingEmail = String(req.body.email || '').trim().toLowerCase();
    if (!client) {
      client = new ClientUser({ phone, name: incomingName, email: incomingEmail });
    } else {
      if (incomingName && !client.name) client.name = incomingName;
      if (incomingEmail && !client.email) client.email = incomingEmail;
    }
    client.verifiedAt = client.verifiedAt || new Date();
    client.lastLoginAt = new Date();
    await client.save();
    await linkCustomer(client);

    return res.json({ token: generateClientToken(client._id), client: clientResponse(client) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Magic-link fallback (email; reuses the mailer) ──────────────────────────
// A short-lived link JWT (typ:'client-link') is emailed; the GET handler trades
// it for a real client token. Only works for a ClientUser that already has this
// email (no account enumeration — always responds 200).

// @route POST /api/client/auth/request-link  { email }
export const requestLink = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const generic = { message: 'If an account exists for that email, a sign-in link has been sent.' };
    if (!email) return res.status(400).json({ message: 'Enter your email' });

    const client = await ClientUser.findOne({ email });
    if (client && transporter) {
      const linkToken = jwt.sign({ id: String(client._id), typ: 'client-link' }, process.env.JWT_SECRET, { expiresIn: '15m' });
      const url = `${publicBase(req)}/api/client/auth/link/${linkToken}`;
      await sendMail(transporter, {
        from: process.env.NODEMAILER_EMAIL,
        to: email,
        subject: 'Your Team N sign-in link',
        html:
          '<div style="font-family:Arial,sans-serif;max-width:460px;margin:auto">' +
          `<h2 style="color:#601A29">Sign in to Team N</h2>` +
          '<p>Tap the button to sign in. This link expires in 15 minutes.</p>' +
          `<p><a href="${url}" style="display:inline-block;background:#601A29;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Sign in</a></p>` +
          `<p style="color:#777;font-size:12px">Or paste: ${url}</p></div>`,
      });
    }
    return res.json(generic);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route GET /api/client/auth/link/:token  (public) — trade link for a token
export const linkLogin = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const decoded = jwt.verify(String(req.params.token), process.env.JWT_SECRET);
    if (decoded.typ !== 'client-link') throw new Error('bad token');
    const client = await ClientUser.findById(decoded.id);
    if (!client || client.status === 'blocked') throw new Error('no client');
    client.lastLoginAt = new Date();
    client.verifiedAt = client.verifiedAt || new Date();
    await client.save();
    const token = generateClientToken(client._id);
    const deepLink = `nizanbride://auth?token=${token}`;
    return res.send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Signed in</title>` +
        `<body style="font-family:Arial,sans-serif;background:#F5F3EF;text-align:center;padding:40px">` +
        `<h2 style="color:#601A29">You're signed in</h2>` +
        `<p>Return to the Team N app to continue.</p>` +
        `<p><a href="${deepLink}" style="display:inline-block;background:#601A29;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Open the app</a></p>` +
        `</body>`,
    );
  } catch (error) {
    return res
      .status(400)
      .send('<body style="font-family:Arial,sans-serif;text-align:center;padding:40px"><h2>Link expired</h2><p>Request a new sign-in link.</p></body>');
  }
};
