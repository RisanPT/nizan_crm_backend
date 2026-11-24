// Escape text before putting it in a RegExp, so a user's "(" or "[" can't
// crash the request and crafted input can't build a slow pattern.
export const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default escapeRegex;
