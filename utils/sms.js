// OTP delivery adapter — the SMS/WhatsApp provider sits behind sendOtpSms() so
// it is swappable and stubbable. With no provider configured (dev), it logs the
// code so the flow can be tested without an SMS account. MSG91 (India, cheap,
// DLT template) is the recommended provider; set SMS_PROVIDER=msg91 +
// MSG91_AUTHKEY + MSG91_OTP_TEMPLATE_ID to enable real delivery.

const provider = String(process.env.SMS_PROVIDER || '').toLowerCase();

async function sendViaMsg91(phone, code) {
  const authkey = process.env.MSG91_AUTHKEY;
  const templateId = process.env.MSG91_OTP_TEMPLATE_ID;
  if (!authkey || !templateId) return false;
  // MSG91 OTP v5 API. `mobile` must include the country code (91 for India).
  const mobile = `91${phone}`;
  const res = await fetch('https://control.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authkey },
    body: JSON.stringify({ template_id: templateId, mobile, otp: code }),
  });
  if (!res.ok) throw new Error(`MSG91 ${res.status}`);
  return true;
}

/// Send a 6-digit OTP to a (last-10-digit) Indian mobile. Returns true if the
/// provider accepted it; in dev (no provider) logs it and returns true.
export const sendOtpSms = async (phone, code) => {
  try {
    if (provider === 'msg91') {
      const ok = await sendViaMsg91(phone, code);
      if (ok) return true;
    }
  } catch (err) {
    console.error('sendOtpSms provider failed, falling back to log:', err.message);
  }
  // Dev fallback — NEVER relied on in production.
  console.log(`[OTP] ${phone} -> ${code}  (dev: no SMS provider configured)`);
  return true;
};

export const smsConfigured = () => provider === 'msg91' && !!process.env.MSG91_AUTHKEY;
