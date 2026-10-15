import mongoose from 'mongoose';
import InventoryProduct from '../models/InventoryProduct.js';
import StaffKit from '../models/StaffKit.js';
import KitMovement from '../models/KitMovement.js';
import Booking from '../models/Booking.js';
import Purchase from '../models/Purchase.js';
import Vendor from '../models/Vendor.js';
import InventoryCategory from '../models/InventoryCategory.js';
import { notifyRoles } from '../utils/notify.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { applyMoneyAccount } from '../utils/moneyAccount.js';

const STUDIO_ROLES = ['inventory_manager', 'admin', 'manager'];

// Feature keys granted to this user's role in Settings -> Roles & Permissions,
// populated by the attachRolePermissions middleware on this router.
const permissionsOf = (user) =>
  Array.isArray(user?.permissions) ? user.permissions.map((p) => String(p)) : [];

// The whole Inventory module was granted (the parent 'inventory' key) rather
// than individual sections. Parent = full toolset, including writes.
const hasInventoryModule = (user) => permissionsOf(user).includes('inventory');

// One or more specific sections were granted, e.g. 'inventory.stock'. The
// parent key counts as every section, mirroring Access.canSeeSub() on the
// Flutter side so the menu and the API agree on who may open what.
const hasInventorySection = (user, ...sections) => {
  const granted = permissionsOf(user);
  if (granted.includes('inventory')) return true;
  return sections.some((name) => granted.includes(`inventory.${name}`));
};

// A studio manager is anyone in a manager role, an artist who has been given
// the inventoryManage capability (the "workspace switcher" dual-role case), or
// any role an admin has granted the Inventory feature — they get the full
// studio toolset regardless of which workspace their client is currently
// showing.
const canManageStudio = (user) =>
  STUDIO_ROLES.includes(user.role) ||
  !!user?.inventoryManage ||
  hasInventoryModule(user);

// The product list backs the dashboard, stock list, restock alerts, expiry
// tracker and reports, so any one of those sections grants the read.
const hasInventoryAccess = (user) =>
  canManageStudio(user) ||
  (user.role === 'artist' && !!user.inventoryAccess) ||
  hasInventorySection(user, 'dashboard', 'stock', 'alerts', 'expiry', 'reports');

// Accounts may READ purchases for the finance dashboard (not create / edit).
const canViewPurchases = (user) =>
  canManageStudio(user) ||
  user.role === 'accounts' || user.role === 'finance_head' ||
  hasInventorySection(user, 'purchases');

// Vendor list. Granting Purchases implies this too, because a purchase row
// shows its vendor.
const canViewVendors = (user) =>
  canManageStudio(user) ||
  user.role === 'accounts' || user.role === 'finance_head' ||
  hasInventorySection(user, 'vendors', 'purchases');

// Accounts team can settle vendor bills (mark paid, record payments, edit
// billing / GST) alongside the studio managers — but not create/delete stock.
const canManagePayables = (user) =>
  canManageStudio(user) || user.role === 'accounts' || user.role === 'finance_head';

// Fully-settled once payments cover the grand total (base + GST).
const PURCHASE_PAY_MODES = ['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other'];

// A payment entry built from a request: amount / date / mode / note plus the
// bank / cash account it came from (moneyAccountId, from the pay form).
// Returns { payment } or { error }.
const paymentFromBody = async (body, amount, fallbackDate) => {
  const d = body.date ? new Date(body.date) : fallbackDate || new Date();
  const payment = {
    amount,
    date: Number.isNaN(d.getTime()) ? new Date() : d,
    mode: String(body.mode ?? body.paymentMode ?? 'cash').trim() || 'cash',
    note: String(body.note ?? '').trim(),
  };
  const err = await applyMoneyAccount(payment, { ...body, paymentMode: body.mode ?? body.paymentMode }, {
    modeField: 'mode',
    modes: PURCHASE_PAY_MODES,
  });
  return err ? { error: err } : { payment };
};

// Post a studio bill (Purchase voucher) and each of its payments; reverse the
// vouchers of payments that no longer exist ([previousPaymentIds]).
const postPurchaseLedger = async (purchase, userId = null, previousPaymentIds = []) => {
  const p = typeof purchase.toObject === 'function' ? purchase.toObject() : purchase;
  let supplierName = p.supplier || '';
  if (p.vendor) {
    const v = await Vendor.findById(p.vendor?._id || p.vendor).select('name').lean();
    if (v?.name) supplierName = v.name;
  }
  await safePost(() => postDoc('Purchase', { ...p, supplierName }, userId));
  const live = new Set();
  for (const pay of p.payments || []) {
    if (!pay._id) continue;
    live.add(String(pay._id));
    await safePost(() => postDoc('PurchasePayment', { ...pay, owner: p.owner, supplierName }, userId));
  }
  for (const id of previousPaymentIds) {
    if (!live.has(String(id))) await safePost(() => unpostDoc('PurchasePayment', id));
  }
};

const grandTotalOf = (purchase) =>
  (Number(purchase.total) || 0) + (Number(purchase.gstAmount) || 0);

// There is a single studio inventory. Everyone with access READS it; only
// managers WRITE it (guards below). Artists never own products.
const ownerScope = () => ({ owner: null });

// Kits: managers manage all kits; access-artists manage only their own; a role
// granted the Staff Kits section reads them through the same kitScope rules.
const canAccessKits = (user) =>
  canManageStudio(user) ||
  (user.role === 'artist' && !!user.inventoryAccess) ||
  hasInventorySection(user, 'kits');

const kitScope = (user) =>
  canManageStudio(user) ? {} : { employeeId: user.employeeId ?? null };

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const cleanProduct = (body) => ({
  name: String(body.name ?? '').trim(),
  brand: String(body.brand ?? '').trim(),
  shade: String(body.shade ?? '').trim(),
  barcode: String(body.barcode ?? '').trim(),
  quantity: Math.max(0, Number.parseInt(body.quantity, 10) || 0),
  price: Math.max(0, Number(body.price) || 0),
  category: String(body.category ?? 'Other').trim() || 'Other',
  productType: String(body.productType ?? body.type ?? '').trim(),
  expiry: toDate(body.expiry),
  notes: String(body.notes ?? '').trim(),
  // Bulk import sends a reorder threshold; keep it (0 is valid). Absent → model default.
  ...(body.lowStockThreshold != null
    ? { lowStockThreshold: Math.max(0, Number(body.lowStockThreshold) || 0) }
    : {}),
});

// ── Products ───────────────────────────────────────────────────────────────

export const getProducts = async (req, res) => {
  if (!hasInventoryAccess(req.user)) {
    return res.status(403).json({ message: 'No inventory access' });
  }
  try {
    const products = await InventoryProduct.find(ownerScope(req.user)).sort({
      createdAt: -1,
    });
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Barcode lookup — used by the scanner to resolve a scanned code.
export const getProductByBarcode = async (req, res) => {
  if (!hasInventoryAccess(req.user)) {
    return res.status(403).json({ message: 'No inventory access' });
  }
  try {
    const code = String(req.params.code ?? '').trim();
    if (!code) return res.status(400).json({ message: 'Barcode required' });
    const product = await InventoryProduct.findOne({
      barcode: code,
      ...ownerScope(req.user),
    });
    if (!product) {
      return res.status(404).json({ message: 'No product for this barcode' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── External barcode enrichment (public databases, no API key) ────────────────
// Used when a scanned barcode is not yet in our inventory: fetch the product's
// name/brand/image from open product databases so the Add form can prefill.

const EXT_HEADERS = {
  'User-Agent': 'NizanStudioCRM/1.0 (studio inventory barcode lookup)',
};

// Open Beauty Facts / Open Food Facts share a response shape.
const fromOpenFacts = async (url) => {
  const res = await fetch(url, {
    headers: EXT_HEADERS,
    signal: AbortSignal.timeout(4500),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  const p = data.product;
  const name = String(p.product_name || p.generic_name || '').trim();
  const brand = String(p.brands || '').split(',')[0].trim();
  const imageUrl =
    p.image_front_small_url || p.image_small_url || p.image_url || '';
  if (!name && !brand) return null;
  return { name, brand, imageUrl };
};

// UPCitemdb free trial endpoint (rate-limited, general retail catalogue).
const fromUpcItemDb = async (code) => {
  const res = await fetch(
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`,
    { headers: EXT_HEADERS, signal: AbortSignal.timeout(4500) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const item = Array.isArray(data.items) ? data.items[0] : null;
  if (!item) return null;
  const name = String(item.title || '').trim();
  const brand = String(item.brand || '').trim();
  const imageUrl =
    Array.isArray(item.images) && item.images.length ? item.images[0] : '';
  if (!name && !brand) return null;
  return { name, brand, imageUrl };
};

const fetchExternalProduct = async (code) => {
  const sources = [
    () =>
      fromOpenFacts(
        `https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(
          code
        )}.json`
      ),
    () => fromUpcItemDb(code),
    () =>
      fromOpenFacts(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
          code
        )}.json`
      ),
  ];
  let answered = 0;
  let lastError = null;
  for (const run of sources) {
    try {
      const hit = await run();
      answered += 1;
      if (hit && (hit.name || hit.brand)) return hit;
    } catch (err) {
      // network/timeout on one source → fall through to the next
      lastError = err;
    }
  }
  // Every source failed to respond (offline / all timed out): that is a real
  // failure, not "no public data" — let the caller report a 502 so the app can
  // tell the two apart.
  if (answered === 0 && lastError) throw lastError;
  return null;
};

export const lookupExternalBarcode = async (req, res) => {
  if (!hasInventoryAccess(req.user)) {
    return res.status(403).json({ message: 'No inventory access' });
  }
  const code = String(req.params.code ?? '').trim();
  if (!code) return res.status(400).json({ message: 'Barcode required' });
  try {
    const suggestion = await fetchExternalProduct(code);
    if (!suggestion) {
      return res
        .status(404)
        .json({ message: 'No public product data for this barcode' });
    }
    res.json({ source: 'external', barcode: code, ...suggestion });
  } catch (error) {
    res
      .status(502)
      .json({
        message:
          "Couldn't reach the public product databases right now. Please try again.",
      });
    console.error('[inventory] external barcode lookup failed:', error.message);
  }
};

export const createProduct = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can add products' });
  }
  try {
    const data = cleanProduct(req.body);
    if (!data.name) {
      return res.status(400).json({ message: 'Product name is required' });
    }
    const owner = canManageStudio(req.user) ? null : req.user.employeeId ?? null;
    const created = await InventoryProduct.create({
      ...data,
      lowStockThreshold:
        req.body.lowStockThreshold != null
          ? Number(req.body.lowStockThreshold)
          : 2,
      owner,
    });
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Bulk import — used by artists uploading their existing inventory.
export const bulkCreateProducts = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can add products' });
  }
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const owner = canManageStudio(req.user) ? null : req.user.employeeId ?? null;
    const docs = items
      .map((it) => ({ ...cleanProduct(it), owner }))
      .filter((d) => d.name);
    if (!docs.length) {
      return res.status(400).json({ message: 'No valid items to import' });
    }
    const created = await InventoryProduct.insertMany(docs);
    res.status(201).json({ inserted: created.length, items: created });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateProduct = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can edit products' });
  }
  try {
    const product = await InventoryProduct.findOne({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    const data = cleanProduct(req.body);
    // Remember the stock level before the edit so we can detect the moment it
    // crosses into low-stock territory (and alert only once, not every save).
    const prevQty = product.quantity;
    if (req.body.name != null) product.name = data.name || product.name;
    if (req.body.brand != null) product.brand = data.brand;
    if (req.body.shade != null) product.shade = data.shade;
    if (req.body.barcode != null) product.barcode = data.barcode;
    if (req.body.quantity != null) product.quantity = data.quantity;
    if (req.body.price != null) product.price = data.price;
    if (req.body.category != null) product.category = data.category;
    if (req.body.productType != null || req.body.type != null) {
      product.productType = data.productType;
    }
    if (req.body.expiry !== undefined) product.expiry = data.expiry;
    if (req.body.lowStockThreshold !== undefined) {
      // 0 is a valid threshold (alert only when fully out), so don't treat it as
      // falsy and revert — clamp to a non-negative number instead.
      product.lowStockThreshold = Math.max(0, Number(req.body.lowStockThreshold) || 0);
    }
    if (req.body.notes !== undefined) product.notes = data.notes;
    await product.save();

    // Alert studio managers the first time stock drops to/below its threshold.
    const threshold = product.lowStockThreshold ?? 0;
    if (prevQty > threshold && product.quantity <= threshold) {
      await notifyRoles({
        roles: STUDIO_ROLES,
        type: 'low_stock',
        title: 'Low stock alert',
        body: `${product.name} is low on stock (${product.quantity} left).`,
        link: '/inventory/alerts',
        createdBy: req.user?._id ?? null,
        excludeUserId: req.user?._id ?? null,
      });
    }

    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteProduct = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can delete products' });
  }
  try {
    const product = await InventoryProduct.findOneAndDelete({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json({ message: 'Product removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Staff Kits ───────────────────────────────────────────────────────────────
//
// Handing a studio product to an artist's kit MOVES it out of studio stock:
// the studio quantity drops the moment the kit is saved, and every hand-over,
// return or write-off is logged in KitMovement. Usage is not measured by
// percentage — it is estimated as the number of works the kit's artist
// completed as LEAD on or after the day the product was assigned.

const idStr = (v) => (v ? String(v) : '');

class KitStockError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const sendKitError = (res, error) =>
  res
    .status(error instanceof KitStockError ? error.status : 500)
    .json({ message: error.message });

const cleanKit = (body) => {
  const items = [];
  const byProduct = new Map();
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const productId =
      it.productId && mongoose.Types.ObjectId.isValid(it.productId)
        ? String(it.productId)
        : null;
    // 0 is kept as-is: kits from the old tube model can hold emptied lines,
    // and bumping them to 1 would silently deduct studio stock on re-save.
    const qty = Number.parseInt(it.quantity, 10);
    const item = {
      productId,
      name: String(it.name ?? '').trim(),
      brand: String(it.brand ?? '').trim(),
      shade: String(it.shade ?? '').trim(),
      quantity: Number.isFinite(qty) ? Math.max(0, qty) : 1,
    };
    if (!item.name) continue;
    // One line per studio product: a product added twice is merged.
    if (productId && byProduct.has(productId)) {
      byProduct.get(productId).quantity += item.quantity;
      continue;
    }
    if (productId) byProduct.set(productId, item);
    items.push(item);
  }
  return {
    name: String(body.name ?? '').trim(),
    employeeId:
      body.employeeId && mongoose.Types.ObjectId.isValid(body.employeeId)
        ? body.employeeId
        : null,
    items,
    notes: String(body.notes ?? '').trim(),
  };
};

// Units of each studio product held by a list of kit items.
const qtyByProduct = (items = []) => {
  const m = new Map();
  for (const it of items) {
    const id = idStr(it.productId);
    if (!id) continue;
    m.set(id, (m.get(id) ?? 0) + (Number(it.quantity) || 0));
  }
  return m;
};

const sameStock = (before, after) => {
  const a = qtyByProduct(before);
  const b = qtyByProduct(after);
  if (a.size !== b.size) return false;
  for (const [id, q] of a) if (b.get(id) !== q) return false;
  return true;
};

const rollbackKitStock = async (applied) => {
  for (const { id, delta } of applied) {
    try {
      await InventoryProduct.updateOne({ _id: id }, { $inc: { quantity: -delta } });
    } catch (err) {
      console.error('[inventory] kit stock rollback failed:', id, err.message);
    }
  }
};

// Applies the studio-stock side of a kit change: deducts units newly issued
// and, when returnToStudio, puts back units taken out of the kit (otherwise
// they are written off as used up). Each deduction is conditional on enough
// stock, so two managers can't hand out the same last unit. On failure the
// changes already applied are rolled back.
const applyKitStock = async ({ before, after, returnToStudio }) => {
  const oldQ = qtyByProduct(before);
  const newQ = qtyByProduct(after);
  const applied = []; // { id, delta } — for rollback
  const changes = []; // { id, type, quantity, product, prevQty }
  try {
    for (const id of new Set([...oldQ.keys(), ...newQ.keys()])) {
      const diff = (newQ.get(id) ?? 0) - (oldQ.get(id) ?? 0);
      if (diff > 0) {
        const updated = await InventoryProduct.findOneAndUpdate(
          { _id: id, owner: null, quantity: { $gte: diff } },
          { $inc: { quantity: -diff } },
          { new: true }
        );
        if (!updated) {
          const p = await InventoryProduct.findOne({ _id: id, owner: null }).select(
            'name quantity'
          );
          throw new KitStockError(
            p
              ? `Only ${p.quantity} × ${p.name} left in studio stock (tried to assign ${diff})`
              : 'A selected product is no longer in studio stock'
          );
        }
        applied.push({ id, delta: -diff });
        changes.push({
          id,
          type: 'assign',
          quantity: diff,
          product: updated,
          prevQty: updated.quantity + diff,
        });
      } else if (diff < 0) {
        const qty = -diff;
        if (returnToStudio) {
          const updated = await InventoryProduct.findOneAndUpdate(
            { _id: id, owner: null },
            { $inc: { quantity: qty } },
            { new: true }
          );
          if (updated) applied.push({ id, delta: qty });
          changes.push({ id, type: 'return', quantity: qty, product: updated });
        } else {
          changes.push({ id, type: 'used_up', quantity: qty, product: null });
        }
      }
    }
  } catch (err) {
    await rollbackKitStock(applied);
    throw err;
  }
  return { applied, changes };
};

// Logs the movements of a saved kit change and alerts studio managers when an
// assignment pushes a product to / below its low-stock threshold.
const recordKitChanges = async ({ req, kit, changes, items }) => {
  if (!changes.length) return;
  const info = new Map();
  for (const it of items) {
    const id = idStr(it.productId);
    if (id && !info.has(id)) info.set(id, it);
  }
  const docs = changes.map((c) => {
    const it = info.get(c.id) ?? {};
    return {
      kit: kit._id,
      kitName: kit.name,
      employeeId: kit.employeeId ?? null,
      product: c.id,
      productName: c.product?.name ?? it.name ?? '',
      brand: c.product?.brand ?? it.brand ?? '',
      shade: c.product?.shade ?? it.shade ?? '',
      type: c.type,
      quantity: c.quantity,
      studioQtyAfter: c.product ? c.product.quantity : null,
      by: req.user?._id ?? null,
      byName: req.user?.name ?? '',
    };
  });
  try {
    await KitMovement.insertMany(docs);
  } catch (err) {
    console.error('[inventory] kit movement log failed:', err.message);
  }
  for (const c of changes) {
    if (c.type !== 'assign' || !c.product) continue;
    const threshold = c.product.lowStockThreshold ?? 0;
    if (c.prevQty > threshold && c.product.quantity <= threshold) {
      try {
        await notifyRoles({
          roles: STUDIO_ROLES,
          type: 'low_stock',
          title: 'Low stock alert',
          body: `${c.product.name} is low on stock (${c.product.quantity} left).`,
          link: '/inventory/alerts',
          createdBy: req.user?._id ?? null,
          excludeUserId: req.user?._id ?? null,
        });
      } catch (err) {
        console.error('[inventory] low-stock alert failed:', err.message);
      }
    }
  }
};

const itemKey = (it) =>
  idStr(it.productId)
    ? `p:${idStr(it.productId)}`
    : `c:${[it.name, it.brand, it.shade].map((s) => String(s ?? '').trim().toLowerCase()).join('|')}`;

// Carries each line's assignment date and issued count over from the saved
// kit. A product new to the kit — or every product, when the kit is handed to
// a different artist (reset) — starts its usage window now.
const stampKitItems = ({ before, after, kitCreatedAt, returnToStudio, reset }) => {
  const now = new Date();
  const prevByKey = new Map(before.map((it) => [itemKey(it), it]));
  return after.map((it) => {
    const prev = reset ? null : prevByKey.get(itemKey(it));
    if (!prev) return { ...it, assignedAt: now, issuedTotal: it.quantity };
    const oldQty = Number(prev.quantity) || 0;
    const diff = it.quantity - oldQty;
    // Kits saved before this feature have no issuedTotal yet.
    let issued = prev.issuedTotal > 0 ? prev.issuedTotal : oldQty;
    if (diff > 0) issued += diff;
    // Returned units were never used, so they don't count as issued.
    else if (diff < 0 && returnToStudio) issued = Math.max(it.quantity, issued + diff);
    return {
      ...it,
      assignedAt: prev.assignedAt ?? kitCreatedAt ?? now,
      issuedTotal: issued,
    };
  });
};

// ── Usage estimate (works completed since assignment) ──

const IST_OFFSET_MS = 330 * 60 * 1000;
// Calendar day (YYYY-MM-DD) in studio time. Booking work dates are stored as
// plain day keys, so assignment times are compared on the same footing.
const studioDayKey = (d) =>
  new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const dayKeys = (dates) =>
  (Array.isArray(dates) ? dates : [])
    .map((d) => String(d ?? '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

const isLeadIn = (staff, empId) =>
  Array.isArray(staff) &&
  staff.some((s) => idStr(s.employeeId) === empId && s.roleType === 'lead');

// One "work" = one date of a completed booking (or booking package) on which
// the artist was the LEAD. A three-day wedding is three works; two packages
// on the same day (e.g. bride + family) are two works.
const leadWorkDates = (booking, empId) => {
  const bookingDates = dayKeys(booking.selectedDates);
  const fallback = bookingDates.length
    ? bookingDates
    : booking.serviceStart
      ? [studioDayKey(booking.serviceStart)]
      : [];
  const packages = Array.isArray(booking.bookingItems) ? booking.bookingItems : [];
  // Multi-package bookings carry staff per package; the booking-level list is
  // only a merged summary of them, so counting both would double up.
  if (packages.some((p) => Array.isArray(p.assignedStaff) && p.assignedStaff.length)) {
    const out = [];
    for (const p of packages) {
      if (!isLeadIn(p.assignedStaff, empId)) continue;
      const own = dayKeys(p.selectedDates);
      out.push(...(own.length ? own : fallback));
    }
    return out;
  }
  return isLeadIn(booking.assignedStaff, empId) ? fallback : [];
};

// Returns the kits as plain objects with each item's usage estimate:
//   worksDone    — completed lead works on/after the item's assignment day
//   lastWorkDate — most recent of those works (YYYY-MM-DD) or null
const attachKitUsage = async (kits) => {
  const plain = kits.map((k) => (typeof k.toObject === 'function' ? k.toObject() : k));
  const startOf = (k, it) => it.assignedAt ?? k.createdAt ?? null;
  const empIds = [...new Set(plain.map((k) => idStr(k.employeeId)).filter(Boolean))];
  let earliest = null;
  for (const k of plain) {
    for (const it of k.items ?? []) {
      const s = startOf(k, it);
      if (s && (!earliest || new Date(s) < earliest)) earliest = new Date(s);
    }
  }

  const worksByEmp = new Map(); // employeeId → [YYYY-MM-DD, …]
  if (empIds.length && earliest) {
    // Loose pre-filter with a 2-day margin; the exact day check is below.
    const since = new Date(earliest.getTime() - 2 * 86400000);
    const sinceKey = studioDayKey(since);
    const leadMatch = {
      $elemMatch: {
        employeeId: { $in: empIds.map((id) => new mongoose.Types.ObjectId(id)) },
        roleType: 'lead',
      },
    };
    const bookings = await Booking.find({
      status: { $regex: /^completed$/i },
      $and: [
        {
          $or: [
            { serviceEnd: { $gte: since } },
            { selectedDates: { $gte: sinceKey } },
            { 'bookingItems.selectedDates': { $gte: sinceKey } },
          ],
        },
        { $or: [{ assignedStaff: leadMatch }, { 'bookingItems.assignedStaff': leadMatch }] },
      ],
    })
      .select(
        'selectedDates serviceStart assignedStaff bookingItems.assignedStaff bookingItems.selectedDates'
      )
      .lean();
    for (const b of bookings) {
      for (const empId of empIds) {
        const dates = leadWorkDates(b, empId);
        if (!dates.length) continue;
        if (!worksByEmp.has(empId)) worksByEmp.set(empId, []);
        worksByEmp.get(empId).push(...dates);
      }
    }
  }

  for (const k of plain) {
    const works = worksByEmp.get(idStr(k.employeeId)) ?? [];
    k.items = (k.items ?? []).map((it) => {
      const start = startOf(k, it);
      const from = start ? studioDayKey(start) : null;
      const counted = from ? works.filter((d) => d >= from) : [];
      return {
        ...it,
        assignedAt: start,
        worksDone: counted.length,
        lastWorkDate: counted.length
          ? counted.reduce((a, b) => (b > a ? b : a))
          : null,
      };
    });
  }
  return plain;
};

const withUsage = async (kit) => (await attachKitUsage([kit]))[0];

export const getKits = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const kits = await StaffKit.find(kitScope(req.user)).sort({ name: 1 });
    res.json(await attachKitUsage(kits));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createKit = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const data = cleanKit(req.body);
    if (!data.name) {
      return res.status(400).json({ message: 'Kit name is required' });
    }
    // Artists' kits are always bound to their own employee record, and only
    // the inventory manager hands out studio stock.
    if (!canManageStudio(req.user)) {
      data.employeeId = req.user.employeeId ?? null;
      if (qtyByProduct(data.items).size) {
        return res.status(403).json({
          message: 'Only the inventory manager can assign studio products to a kit',
        });
      }
    }
    const { applied, changes } = await applyKitStock({
      before: [],
      after: data.items,
      returnToStudio: false,
    });
    let kit;
    try {
      kit = await StaffKit.create({
        ...data,
        items: stampKitItems({ before: [], after: data.items }),
      });
    } catch (err) {
      await rollbackKitStock(applied);
      throw err;
    }
    await recordKitChanges({ req, kit, changes, items: data.items });
    res.status(201).json(await withUsage(kit));
  } catch (error) {
    sendKitError(res, error);
  }
};

// Saving a kit sends its full item list. Units added to a studio product are
// deducted from studio stock; units removed are returned to studio stock when
// `returnToStudio` is true, otherwise written off as used up.
export const updateKit = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const kit = await StaffKit.findOne({
      _id: req.params.id,
      ...kitScope(req.user),
    });
    if (!kit) {
      return res.status(404).json({ message: 'Kit not found' });
    }
    const manager = canManageStudio(req.user);
    const data = cleanKit(req.body);
    const returnToStudio =
      req.body.returnToStudio === true || req.body.returnToStudio === 'true';
    const before = kit.items.map((it) => it.toObject());
    const after = req.body.items !== undefined ? data.items : before;
    if (!manager && !sameStock(before, after)) {
      return res.status(403).json({
        message: 'Only the inventory manager can change studio products in a kit',
      });
    }
    // Only managers may reassign a kit to a different employee.
    const employeeId =
      req.body.employeeId !== undefined && manager ? data.employeeId : kit.employeeId;
    const reassigned = idStr(employeeId) !== idStr(kit.employeeId);

    const { applied, changes } = await applyKitStock({ before, after, returnToStudio });
    try {
      if (req.body.name != null) kit.name = data.name || kit.name;
      kit.employeeId = employeeId;
      kit.items = stampKitItems({
        before,
        after,
        kitCreatedAt: kit.createdAt,
        returnToStudio,
        reset: reassigned,
      });
      if (req.body.notes !== undefined) kit.notes = data.notes;
      await kit.save();
    } catch (err) {
      await rollbackKitStock(applied);
      throw err;
    }
    await recordKitChanges({ req, kit, changes, items: [...after, ...before] });
    res.json(await withUsage(kit));
  } catch (error) {
    sendKitError(res, error);
  }
};

// Deleting a kit takes its studio products out of the kit too: back into
// studio stock with ?returnToStudio=true, otherwise written off as used up.
export const deleteKit = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const kit = await StaffKit.findOne({
      _id: req.params.id,
      ...kitScope(req.user),
    });
    if (!kit) {
      return res.status(404).json({ message: 'Kit not found' });
    }
    const before = kit.items.map((it) => it.toObject());
    if (!canManageStudio(req.user) && qtyByProduct(before).size) {
      return res.status(403).json({
        message: 'Only the inventory manager can delete a kit holding studio products',
      });
    }
    const returnToStudio =
      req.query.returnToStudio === 'true' || req.body?.returnToStudio === true;
    const { applied, changes } = await applyKitStock({
      before,
      after: [],
      returnToStudio,
    });
    try {
      await kit.deleteOne();
    } catch (err) {
      await rollbackKitStock(applied);
      throw err;
    }
    await recordKitChanges({ req, kit, changes, items: before });
    res.json({ message: 'Kit removed', id: req.params.id });
  } catch (error) {
    sendKitError(res, error);
  }
};

// Assignment history (newest first). Managers see every kit; an artist sees
// only movements on their own kits.
export const getKitMovements = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const filter = {};
    if (req.query.kitId && mongoose.Types.ObjectId.isValid(req.query.kitId)) {
      filter.kit = req.query.kitId;
    }
    if (req.query.productId && mongoose.Types.ObjectId.isValid(req.query.productId)) {
      filter.product = req.query.productId;
    }
    if (!canManageStudio(req.user)) filter.employeeId = req.user.employeeId ?? null;
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 200));
    const rows = await KitMovement.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Vendors (suppliers) ──────────────────────────────────────────────────────

const cleanVendor = (body) => ({
  name: String(body.name ?? '').trim(),
  gstNumber: String(body.gstNumber ?? '').trim(),
  phone: String(body.phone ?? '').trim(),
  email: String(body.email ?? '').trim(),
  address: String(body.address ?? '').trim(),
  state: String(body.state ?? '').trim(),
  stateCode: String(body.stateCode ?? '').trim(),
  bankName: String(body.bankName ?? '').trim(),
  bankAccount: String(body.bankAccount ?? '').trim(),
  bankIfsc: String(body.bankIfsc ?? '').trim(),
  notes: String(body.notes ?? '').trim(),
});

export const getVendors = async (req, res) => {
  if (!canViewVendors(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const vendors = await Vendor.find(ownerScope(req.user)).sort({ name: 1 });
    res.json(vendors);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createVendor = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can add vendors' });
  }
  try {
    const data = cleanVendor(req.body);
    if (!data.name) {
      return res.status(400).json({ message: 'Vendor name is required' });
    }
    const vendor = await Vendor.create({ ...data, owner: null });
    res.status(201).json(vendor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateVendor = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can edit vendors' });
  }
  try {
    const vendor = await Vendor.findOne({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!vendor) {
      return res.status(404).json({ message: 'Vendor not found' });
    }
    const data = cleanVendor(req.body);
    if (req.body.name != null) vendor.name = data.name || vendor.name;
    for (const key of [
      'gstNumber', 'phone', 'email', 'address', 'state', 'stateCode',
      'bankName', 'bankAccount', 'bankIfsc', 'notes',
    ]) {
      if (req.body[key] != null) vendor[key] = data[key];
    }
    await vendor.save();
    res.json(vendor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteVendor = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can delete vendors' });
  }
  try {
    const vendor = await Vendor.findOneAndDelete({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!vendor) {
      return res.status(404).json({ message: 'Vendor not found' });
    }
    res.json({ message: 'Vendor removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Categories ───────────────────────────────────────────────────────────────
//
// The list merges three sources (case-insensitively):
//   • built-in  — the original fixed list (mirrors InventoryProduct.categories
//                 in the app); always locked.
//   • in use    — any category an existing product / purchase line carries;
//                 locked while in use, so no product's category is ever
//                 renamed or orphaned.
//   • custom    — added from the Stock List; renamable / deletable only while
//                 no product uses it.
// Writes only ever touch the InventoryCategory collection — never products.

const BUILTIN_CATEGORIES = [
  'Prep', 'Eye', 'Base', 'Highlighting', 'Setting', 'Fixing',
  'Lip', 'Cheek', 'Contour', 'Hair', 'Application', 'Cleaner', 'Other',
];
const BUILTIN_KEYS = new Set(BUILTIN_CATEGORIES.map((c) => c.toLowerCase()));

const catKey = (name) => String(name ?? '').trim().toLowerCase();
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// How many products / purchase lines use a category (any owner, any casing).
const categoryUsage = async (name) => {
  const rx = new RegExp(`^\\s*${escapeRx(String(name).trim())}\\s*$`, 'i');
  const [products, purchases] = await Promise.all([
    InventoryProduct.countDocuments({ category: rx }),
    Purchase.countDocuments({ category: rx }),
  ]);
  return { products, purchases, total: products + purchases };
};

const cleanCategoryName = (raw) =>
  String(raw ?? '').replace(/\s+/g, ' ').trim();

export const getCategories = async (req, res) => {
  if (!hasInventoryAccess(req.user) && !canViewPurchases(req.user)) {
    return res.status(403).json({ message: 'No inventory access' });
  }
  try {
    const [custom, productUse, purchaseUse] = await Promise.all([
      InventoryCategory.find({}).sort({ name: 1 }).lean(),
      InventoryProduct.aggregate([
        { $group: { _id: { $toLower: { $trim: { input: { $ifNull: ['$category', ''] } } } }, n: { $sum: 1 }, name: { $first: '$category' } } },
      ]),
      Purchase.aggregate([
        { $group: { _id: { $toLower: { $trim: { input: { $ifNull: ['$category', ''] } } } }, n: { $sum: 1 }, name: { $first: '$category' } } },
      ]),
    ]);

    const byKey = new Map();
    const entry = (key, name) => {
      if (!byKey.has(key)) {
        byKey.set(key, { id: null, name, builtin: false, custom: false, productCount: 0, purchaseCount: 0 });
      }
      return byKey.get(key);
    };
    BUILTIN_CATEGORIES.forEach((name) => { entry(name.toLowerCase(), name).builtin = true; });
    custom.forEach((c) => {
      const e = entry(c.key, c.name);
      if (!e.builtin) { e.custom = true; e.id = String(c._id); e.name = c.name; }
    });
    productUse.forEach((u) => { if (u._id) entry(u._id, String(u.name).trim()).productCount = u.n; });
    purchaseUse.forEach((u) => { if (u._id) entry(u._id, String(u.name).trim()).purchaseCount = u.n; });

    const order = new Map(BUILTIN_CATEGORIES.map((c, i) => [c.toLowerCase(), i]));
    const list = [...byKey.entries()].map(([key, e]) => {
      const inUse = e.productCount + e.purchaseCount > 0;
      return {
        id: e.id,
        name: e.name,
        source: e.builtin ? 'builtin' : e.custom ? 'custom' : 'in_use',
        productCount: e.productCount,
        purchaseCount: e.purchaseCount,
        // Only an unused custom category can be renamed / deleted.
        locked: !e.custom || inUse,
        _key: key,
      };
    });
    list.sort((a, b) => {
      const ao = order.has(a._key) ? order.get(a._key) : 999;
      const bo = order.has(b._key) ? order.get(b._key) : 999;
      return ao !== bo ? ao - bo : a.name.localeCompare(b.name);
    });
    res.json(list.map(({ _key, ...rest }) => rest));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createCategory = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can add categories' });
  }
  try {
    const name = cleanCategoryName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    if (name.length > 40) return res.status(400).json({ message: 'Keep the name under 40 characters' });
    const key = catKey(name);
    if (BUILTIN_KEYS.has(key) || (await InventoryCategory.exists({ key }))) {
      return res.status(409).json({ message: `"${name}" already exists` });
    }
    if ((await categoryUsage(name)).total > 0) {
      return res.status(409).json({ message: `"${name}" is already used by products` });
    }
    const created = await InventoryCategory.create({ name, key, createdBy: req.user?._id || null });
    res.status(201).json({ id: String(created._id), name: created.name, source: 'custom', productCount: 0, purchaseCount: 0, locked: false });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'Category already exists' });
    res.status(500).json({ message: error.message });
  }
};

export const updateCategory = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can edit categories' });
  }
  try {
    const cat = await InventoryCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ message: 'Category not found' });
    const name = cleanCategoryName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    if (name.length > 40) return res.status(400).json({ message: 'Keep the name under 40 characters' });

    const usage = await categoryUsage(cat.name);
    if (usage.total > 0) {
      return res.status(409).json({
        message: `"${cat.name}" is used by ${usage.products} product(s) and can't be renamed`,
      });
    }
    const key = catKey(name);
    if (key !== cat.key) {
      if (BUILTIN_KEYS.has(key) || (await InventoryCategory.exists({ key, _id: { $ne: cat._id } }))) {
        return res.status(409).json({ message: `"${name}" already exists` });
      }
      if ((await categoryUsage(name)).total > 0) {
        return res.status(409).json({ message: `"${name}" is already used by products` });
      }
    }
    cat.name = name;
    cat.key = key;
    await cat.save();
    res.json({ id: String(cat._id), name: cat.name, source: 'custom', productCount: 0, purchaseCount: 0, locked: false });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'Category already exists' });
    res.status(500).json({ message: error.message });
  }
};

export const deleteCategory = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'Only managers can delete categories' });
  }
  try {
    const cat = await InventoryCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ message: 'Category not found' });
    const usage = await categoryUsage(cat.name);
    if (usage.total > 0) {
      return res.status(409).json({
        message: `"${cat.name}" is used by ${usage.products} product(s) and can't be deleted`,
      });
    }
    await cat.deleteOne();
    res.json({ message: 'Category removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Purchases (stock-in) ─────────────────────────────────────────────────────

const toNum = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const getPurchases = async (req, res) => {
  if (!canViewPurchases(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const purchases = await Purchase.find(ownerScope(req.user)).sort({
      date: -1,
      createdAt: -1,
    });
    res.json(purchases);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Creating a purchase increments stock for each line, creating the product by
// barcode when it does not already exist.
export const createPurchase = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const owner = canManageStudio(req.user) ? null : req.user.employeeId ?? null;
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) {
      return res
          .status(400)
          .json({ message: 'A purchase needs at least one item' });
    }

    const resolvedItems = [];
    let total = 0;

    for (const it of rawItems) {
      const qty = Math.max(1, Number.parseInt(it.quantity, 10) || 1);
      const unitCost = Math.max(0, toNum(it.unitCost));
      const barcode = String(it.barcode ?? '').trim();
      const stockIn = it.stockIn !== false; // default: adds to inventory

      // Expense-only line (e.g. software/service): ledger it, don't stock it.
      if (!stockIn) {
        const name = String(it.name ?? '').trim();
        if (!name) continue;
        total += qty * unitCost;
        resolvedItems.push({
          product: null,
          name,
          brand: String(it.brand ?? '').trim(),
          shade: String(it.shade ?? '').trim(),
          barcode,
          category: String(it.category ?? 'Other').trim() || 'Other',
          quantity: qty,
          unitCost,
          stockIn: false,
        });
        continue;
      }

      let product = null;
      if (it.productId && mongoose.Types.ObjectId.isValid(it.productId)) {
        product = await InventoryProduct.findOne({
          _id: it.productId,
          ...ownerScope(req.user),
        });
      }
      if (!product && barcode) {
        product = await InventoryProduct.findOne({
          barcode,
          ...ownerScope(req.user),
        });
      }

      if (product) {
        product.quantity += qty; // stock in
        if (unitCost > 0) product.price = unitCost; // latest cost
        if (barcode && !product.barcode) product.barcode = barcode;
        if (it.expiry) {
          const d = new Date(it.expiry);
          if (!Number.isNaN(d.getTime())) product.expiry = d;
        }
        await product.save();
      } else {
        const data = cleanProduct(it);
        if (!data.name) continue; // skip nameless lines
        product = await InventoryProduct.create({
          ...data,
          barcode,
          quantity: qty,
          price: unitCost > 0 ? unitCost : Math.max(0, toNum(it.price)),
          owner,
        });
      }

      total += qty * unitCost;
      resolvedItems.push({
        product: product._id,
        name: product.name,
        brand: product.brand,
        shade: product.shade,
        barcode: product.barcode,
        category: product.category,
        quantity: qty,
        unitCost,
        stockIn: true,
      });
    }

    if (!resolvedItems.length) {
      return res
          .status(400)
          .json({ message: 'No valid items in the purchase' });
    }

    // Resolve the vendor (if chosen) so the supplier name is authoritative.
    let vendorId = null;
    let supplier = String(req.body.supplier ?? '').trim();
    if (
      req.body.vendorId &&
      mongoose.Types.ObjectId.isValid(req.body.vendorId)
    ) {
      const vendor = await Vendor.findOne({
        _id: req.body.vendorId,
        ...ownerScope(req.user),
      });
      if (vendor) {
        vendorId = vendor._id;
        if (!supplier) supplier = vendor.name;
      }
    }

    const purchaseDate = new Date(req.body.date);
    const dueDateRaw = req.body.dueDate ? new Date(req.body.dueDate) : null;
    const gstEnabled = !!req.body.gstEnabled;
    const gstAmount = gstEnabled ? Number(req.body.gstAmount) || 0 : 0;
    const grandTotal = total + gstAmount;
    // paid=true => fully settled; else honour an explicit opening amountPaid.
    const amountPaid = req.body.paid
      ? grandTotal
      : Math.max(0, Number(req.body.amountPaid) || 0);
    // Money already paid at purchase time is recorded as a payment entry, so
    // it posts against the bank / cash account like any other payment.
    const openingPayments = [];
    if (amountPaid > 0) {
      const { payment, error } = await paymentFromBody(
        { ...req.body, note: req.body.paymentNote ?? 'Paid at purchase' },
        amountPaid,
        Number.isNaN(purchaseDate.getTime()) ? new Date() : purchaseDate
      );
      if (error) return res.status(400).json({ message: error });
      openingPayments.push(payment);
    }
    const purchase = await Purchase.create({
      supplier,
      vendor: vendorId,
      invoiceNo: String(req.body.invoiceNo ?? '').trim(),
      billImage: String(req.body.billImage ?? '').trim(),
      date: Number.isNaN(purchaseDate.getTime()) ? new Date() : purchaseDate,
      dueDate: dueDateRaw && !Number.isNaN(dueDateRaw.getTime()) ? dueDateRaw : null,
      items: resolvedItems,
      total,
      gstEnabled,
      gstin: String(req.body.gstin ?? '').trim(),
      gstRate: Number(req.body.gstRate) || 0,
      gstAmount,
      interState: !!req.body.interState,
      amountPaid,
      payments: openingPayments,
      paid: grandTotal > 0 ? amountPaid >= grandTotal - 0.01 : !!req.body.paid,
      owner,
      notes: String(req.body.notes ?? '').trim(),
    });

    await postPurchaseLedger(purchase, req.user?._id || null);
    res.status(201).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Toggle a bill's payment status (Paid / Not Paid). Syncs amountPaid so the
// balance stays consistent for the Accounts payables view.
export const setPurchasePaid = async (req, res) => {
  if (!canManagePayables(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    const paid = !!req.body.paid;
    const previousIds = (purchase.payments || []).map((x) => x._id).filter(Boolean);
    if (paid) {
      // Settle the remaining balance as one payment entry.
      const remaining = grandTotalOf(purchase) - (Number(purchase.amountPaid) || 0);
      if (remaining > 0.01) {
        const { payment, error } = await paymentFromBody(req.body, Math.round(remaining * 100) / 100);
        if (error) return res.status(400).json({ message: error });
        purchase.payments.push(payment);
      }
      purchase.amountPaid = grandTotalOf(purchase);
    } else {
      // Back to unpaid: clear the payments (their vouchers are reversed below).
      purchase.payments = [];
      purchase.amountPaid = 0;
    }
    purchase.paid = paid;
    await purchase.save();
    await postPurchaseLedger(purchase, req.user?._id || null, previousIds);
    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Record a payment against a bill (supports partial payments). Appends to the
// payments log, bumps amountPaid, and flips `paid` once fully settled.
export const recordPurchasePayment = async (req, res) => {
  if (!canManagePayables(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    const amount = Number(req.body.amount) || 0;
    if (amount <= 0) {
      return res
        .status(400)
        .json({ message: 'Payment amount must be greater than zero' });
    }
    const { payment, error } = await paymentFromBody(req.body, amount);
    if (error) return res.status(400).json({ message: error });
    purchase.payments.push(payment);
    purchase.amountPaid = (Number(purchase.amountPaid) || 0) + amount;
    const grand = grandTotalOf(purchase);
    purchase.paid = grand > 0 ? purchase.amountPaid >= grand - 0.01 : false;
    await purchase.save();
    await postPurchaseLedger(purchase, req.user?._id || null);
    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Edit a bill's billing / GST metadata (invoice no, due date, GST, vendor,
// notes) without touching stock. Used from the Accounts payables screen.
export const updatePurchase = async (req, res) => {
  if (!canManagePayables(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const purchase = await Purchase.findOne({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    const b = req.body;
    if (b.supplier !== undefined) purchase.supplier = String(b.supplier).trim();
    if (b.invoiceNo !== undefined) {
      purchase.invoiceNo = String(b.invoiceNo).trim();
    }
    if (b.billImage !== undefined) {
      purchase.billImage = String(b.billImage).trim();
    }
    if (b.notes !== undefined) purchase.notes = String(b.notes).trim();
    if (b.date !== undefined && b.date) {
      const d = new Date(b.date);
      if (!Number.isNaN(d.getTime())) purchase.date = d;
    }
    if (b.dueDate !== undefined) {
      const d = b.dueDate ? new Date(b.dueDate) : null;
      purchase.dueDate = d && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (b.gstEnabled !== undefined) purchase.gstEnabled = !!b.gstEnabled;
    if (b.gstin !== undefined) purchase.gstin = String(b.gstin).trim();
    if (b.gstRate !== undefined) purchase.gstRate = Number(b.gstRate) || 0;
    if (b.gstAmount !== undefined) purchase.gstAmount = Number(b.gstAmount) || 0;
    if (b.interState !== undefined) purchase.interState = !!b.interState;
    if (
      b.vendorId !== undefined &&
      (!b.vendorId || mongoose.Types.ObjectId.isValid(b.vendorId))
    ) {
      purchase.vendor = b.vendorId || null;
    }
    // Re-sync paid vs amountPaid against the (possibly new) grand total.
    const grand = grandTotalOf(purchase);
    purchase.paid =
      grand > 0 ? (Number(purchase.amountPaid) || 0) >= grand - 0.01 : false;
    await purchase.save();
    await postPurchaseLedger(purchase, req.user?._id || null);
    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Remove a purchase from the ledger. Does NOT reverse stock already added.
export const deletePurchase = async (req, res) => {
  if (!canManageStudio(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const purchase = await Purchase.findOneAndDelete({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!purchase) {
      return res.status(404).json({ message: 'Purchase not found' });
    }
    // Reverse the bill and its payments in the books.
    await safePost(() => unpostDoc('Purchase', purchase._id));
    for (const pay of purchase.payments || []) {
      if (pay._id) await safePost(() => unpostDoc('PurchasePayment', pay._id));
    }
    res.json({ message: 'Purchase removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
