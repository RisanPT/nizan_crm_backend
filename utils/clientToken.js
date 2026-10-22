import jwt from 'jsonwebtoken';

// Client JWTs are a SEPARATE token family from staff tokens: the `typ:'client'`
// claim lets middleware keep the two apart so a client token can never satisfy
// a staff route (and vice versa). Longer TTL than staff (consumer app).
export const generateClientToken = (id) =>
  jwt.sign({ id: String(id), typ: 'client' }, process.env.JWT_SECRET, { expiresIn: '30d' });
