import jwt from 'jsonwebtoken';
import ClientUser from '../models/ClientUser.js';

// Auth for the client-facing app. Mirrors `protect` but loads a ClientUser and
// REQUIRES the `typ:'client'` claim, so a staff token can never reach a client
// route. Accepts `Authorization: Bearer <t>` or `?token=` (for links/sockets).
export const protectClient = async (req, res, next) => {
  const authHeader = req.headers.authorization ?? '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) token = authHeader.split(' ')[1];
  else if (req.query.token) token = String(req.query.token);

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ !== 'client') {
      return res.status(401).json({ message: 'Not authorized' });
    }
    const client = await ClientUser.findById(decoded.id);
    if (!client || client.status === 'blocked') {
      return res.status(401).json({ message: 'Not authorized' });
    }
    req.client = client;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token invalid' });
  }
};
