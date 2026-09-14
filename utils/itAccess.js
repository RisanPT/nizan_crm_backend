import { permissionsForRole } from '../controllers/roleController.js';

// Role keys that are IT staff without a permission lookup (fast path).
const IT_ROLE_KEYS = new Set(['it', 'admin', 'manager']);

// IT staff = admin/manager/it OR ANY role granted the 'it' feature permission.
// Permission-driven (not a hardcoded role list), so a custom role created in the
// Roles screen with the IT feature ticked gets full IT powers automatically —
// matching the frontend `canSeeIt` gate and the guard in ticketController.js.
export const isITStaff = async (u) => {
  if (!u) return false;
  if (IT_ROLE_KEYS.has(u.role)) return true;
  try {
    return (await permissionsForRole(u.role)).includes('it');
  } catch {
    return false;
  }
};
