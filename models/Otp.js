import mongoose from 'mongoose';
import { normalizePhone } from '../utils/phone.js';

// A one-time passcode for client phone login. The plain code is never stored —
// only its SHA-256 hash. `expiresAt` has a TTL index so expired codes are
// auto-purged by Mongo.
const otpSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true, set: normalizePhone },
    codeHash: { type: String, required: true },
    channel: { type: String, enum: ['sms', 'whatsapp'], default: 'sms' },
    attempts: { type: Number, default: 0 }, // verify attempts (cap at 5)
    consumedAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: Date.now }, // resend throttle (60s)
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL: Mongo removes the doc once `expiresAt` passes.
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Otp = mongoose.model('Otp', otpSchema);
export default Otp;
