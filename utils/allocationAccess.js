// WHO MAY DO WHAT with the smart booking allocation (pure — tests/allocationAccess.test.js). Leadership (CEO / Executive Director) reads
// everything and changes nothing (middleware/ceoGuard.js refuses their writes anyway).
import { isCrmHead, isCrmRole } from './crmAccess.js';
import { isLeadership } from './leadership.js';

const lc = (v) => String(v ?? '').trim().toLowerCase();
const isAdminish = (u) => ['admin', 'manager'].includes(lc(u?.role));
/** The Artist Head: the artist_head role, or a login flagged as the artists' head. */
export const isArtistHead = (u) => lc(u?.role) === 'artist_head' || u?.artistHead === true;

/** The Allocation Board, the Artist Management screen and the suggestions. */
export const mayViewAllocation = (u) => isAdminish(u) || isCrmRole(u) || isArtistHead(u) || lc(u?.role) === 'regional_artist_head' || isLeadership(u);
/** Give a work to a team (confirm a suggestion). Not sales, not the artists themselves. */
export const mayAllocate = (u) => isAdminish(u) || isCrmRole(u) || isArtistHead(u);
/** OK an EXTRA (4th) slot. */
export const mayApproveExtra = (u) => isAdminish(u) || isArtistHead(u);
/** Set up the teams (main artist, assistants, preferred places, rotation, slots) — the whole CRM team does this. */
export const mayManageTeams = (u) => isAdminish(u) || isCrmRole(u) || isArtistHead(u);
/** Change the rules (cut-off, 30 minutes, extras…): the CRM Head, the Artist Head, managers — not every CRM member. */
export const mayEditAllocationSettings = (u) => isAdminish(u) || isCrmHead(u) || isArtistHead(u);
/** The salespeople (they read their bookings' artist allocation, nothing more). */
export const isSalesRole = (u) => ['sales', 'sales_executive', 'sales_manager', 'salesmanager'].includes(lc(u?.role));
/** Read one booking's artist allocation (who has it, or why it waits): the allocation's readers and the salespeople. */
export const mayViewBookingAllocation = (u) => mayViewAllocation(u) || isSalesRole(u);
/** Switch the whole thing off / to shadow / on. */
export const mayChangeAllocationMode = (u) => isAdminish(u);
