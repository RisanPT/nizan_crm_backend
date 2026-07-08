import mongoose from 'mongoose';
import InventoryProduct from '../models/InventoryProduct.js';
import StaffKit from '../models/StaffKit.js';
import Purchase from '../models/Purchase.js';

const STUDIO_ROLES = ['inventory_manager', 'admin', 'manager'];

const canManageStudio = (user) => STUDIO_ROLES.includes(user.role);

const hasInventoryAccess = (user) =>
  canManageStudio(user) || (user.role === 'artist' && !!user.inventoryAccess);

// There is a single studio inventory. Everyone with access READS it; only
// managers WRITE it (guards below). Artists never own products.
const ownerScope = () => ({ owner: null });

// Kits: managers manage all kits; access-artists manage only their own.
const canAccessKits = (user) =>
  canManageStudio(user) || (user.role === 'artist' && !!user.inventoryAccess);

const kitScope = (user) =>
  canManageStudio(user) ? {} : { employeeId: user.employeeId ?? null };

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const clampPct = (v, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(100, Math.round(n)));
};

const cleanProduct = (body) => ({
  name: String(body.name ?? '').trim(),
  brand: String(body.brand ?? '').trim(),
  shade: String(body.shade ?? '').trim(),
  barcode: String(body.barcode ?? '').trim(),
  quantity: Math.max(0, Number.parseInt(body.quantity, 10) || 0),
  fillLevel: clampPct(body.fillLevel, 100),
  usagePerWork: clampPct(body.usagePerWork, 10),
  price: Math.max(0, Number(body.price) || 0),
  category: String(body.category ?? 'Other').trim() || 'Other',
  productType: String(body.productType ?? body.type ?? '').trim(),
  expiry: toDate(body.expiry),
  notes: String(body.notes ?? '').trim(),
});

// Tube model: consume `percent` of a tube from a product, cascading to the
// next sealed tube when the open one empties. Mutates the product in place.
//   total juice = (quantity - 1) * 100 + fillLevel   (for quantity >= 1)
const applyTubeUsage = (product, percent) => {
  const p = Math.max(0, Number(percent) || 0);
  if (p <= 0) return;
  const qty = Math.max(0, product.quantity ?? 0);
  let total = qty <= 0 ? 0 : (qty - 1) * 100 + (product.fillLevel ?? 100);
  total -= p;
  if (total <= 0) {
    product.quantity = 0;
    product.fillLevel = 0;
    return;
  }
  product.quantity = Math.floor((total - 1) / 100) + 1;
  product.fillLevel = Math.round(total - (product.quantity - 1) * 100);
};

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
  for (const run of sources) {
    try {
      const hit = await run();
      if (hit && (hit.name || hit.brand)) return hit;
    } catch (_) {
      // network/timeout on one source → fall through to the next
    }
  }
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
      .json({ message: 'External lookup failed', detail: error.message });
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
    if (req.body.name != null) product.name = data.name || product.name;
    if (req.body.brand != null) product.brand = data.brand;
    if (req.body.shade != null) product.shade = data.shade;
    if (req.body.barcode != null) product.barcode = data.barcode;
    if (req.body.quantity != null) product.quantity = data.quantity;
    if (req.body.fillLevel != null) product.fillLevel = data.fillLevel;
    if (req.body.usagePerWork != null) product.usagePerWork = data.usagePerWork;
    if (req.body.price != null) product.price = data.price;
    if (req.body.category != null) product.category = data.category;
    if (req.body.productType != null || req.body.type != null) {
      product.productType = data.productType;
    }
    if (req.body.expiry !== undefined) product.expiry = data.expiry;
    if (req.body.lowStockThreshold !== undefined) {
      product.lowStockThreshold =
        Number(req.body.lowStockThreshold) || product.lowStockThreshold;
    }
    if (req.body.notes !== undefined) product.notes = data.notes;
    await product.save();
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

// ── Staff Kits (studio managers only) ────────────────────────────────────────

const cleanKit = (body) => ({
  name: String(body.name ?? '').trim(),
  employeeId:
    body.employeeId && mongoose.Types.ObjectId.isValid(body.employeeId)
      ? body.employeeId
      : null,
  items: Array.isArray(body.items)
    ? body.items
        .map((it) => ({
          productId:
            it.productId && mongoose.Types.ObjectId.isValid(it.productId)
              ? it.productId
              : null,
          name: String(it.name ?? '').trim(),
          brand: String(it.brand ?? '').trim(),
          shade: String(it.shade ?? '').trim(),
          quantity: Math.max(1, Number.parseInt(it.quantity, 10) || 1),
          fillLevel: clampPct(it.fillLevel, 100),
        }))
        .filter((it) => it.name)
    : [],
  notes: String(body.notes ?? '').trim(),
});

export const getKits = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const kits = await StaffKit.find(kitScope(req.user)).sort({ name: 1 });
    res.json(kits);
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
    // Artists' kits are always bound to their own employee record.
    if (!canManageStudio(req.user)) {
      data.employeeId = req.user.employeeId ?? null;
    }
    const kit = await StaffKit.create(data);
    res.status(201).json(kit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

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
    const data = cleanKit(req.body);
    if (req.body.name != null) kit.name = data.name || kit.name;
    // Only managers may reassign a kit to a different employee.
    if (req.body.employeeId !== undefined && canManageStudio(req.user)) {
      kit.employeeId = data.employeeId;
    }
    if (req.body.items !== undefined) kit.items = data.items;
    if (req.body.notes !== undefined) kit.notes = data.notes;
    await kit.save();
    res.json(kit);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteKit = async (req, res) => {
  if (!canAccessKits(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const kit = await StaffKit.findOneAndDelete({
      _id: req.params.id,
      ...kitScope(req.user),
    });
    if (!kit) {
      return res.status(404).json({ message: 'Kit not found' });
    }
    res.json({ message: 'Kit removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update one kit item's PER-ARTIST allocation — its tube fill and/or tube
// count. This touches only this artist's kit, never the shared studio stock.
export const updateKitItem = async (req, res) => {
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
    const idx = Number.parseInt(req.params.index, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= kit.items.length) {
      return res.status(400).json({ message: 'Invalid kit item' });
    }
    const item = kit.items[idx];
    if (req.body.fillLevel != null) {
      item.fillLevel = clampPct(req.body.fillLevel, item.fillLevel ?? 100);
    }
    if (req.body.quantity != null) {
      item.quantity = Math.max(0, Number.parseInt(req.body.quantity, 10) || 0);
      if (item.quantity <= 0) item.fillLevel = 0;
    }
    await kit.save();
    res.json(kit);
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
  if (!canManageStudio(req.user)) {
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
        // Restocking an emptied product opens a fresh, full tube.
        if (product.quantity <= 0) product.fillLevel = 100;
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

    const purchaseDate = new Date(req.body.date);
    const purchase = await Purchase.create({
      supplier: String(req.body.supplier ?? '').trim(),
      invoiceNo: String(req.body.invoiceNo ?? '').trim(),
      date: Number.isNaN(purchaseDate.getTime()) ? new Date() : purchaseDate,
      items: resolvedItems,
      total,
      paid: !!req.body.paid,
      owner,
      notes: String(req.body.notes ?? '').trim(),
    });

    res.status(201).json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Toggle a purchase's ledger payment status (Paid / Not Paid).
export const setPurchasePaid = async (req, res) => {
  if (!canManageStudio(req.user)) {
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
    purchase.paid = !!req.body.paid;
    await purchase.save();
    res.json(purchase);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Tube consumption ─────────────────────────────────────────────────────────

// Deplete tubes when a work is completed. Depletes the completing artist's OWN
// kit-item allocations (never the shared studio stock, never other artists) by
// each item's linked-product usagePerWork% (default 10%).
export const consumeForWork = async (req, res) => {
  if (!hasInventoryAccess(req.user)) {
    return res.status(403).json({ message: 'No inventory access' });
  }
  try {
    let employeeId = req.user.employeeId ?? null;
    if (
      canManageStudio(req.user) &&
      req.body.employeeId &&
      mongoose.Types.ObjectId.isValid(req.body.employeeId)
    ) {
      employeeId = req.body.employeeId;
    }
    if (!employeeId) {
      return res.status(400).json({ message: 'No artist to deplete for' });
    }

    // Cache usagePerWork per linked product so we don't refetch per item.
    const usageCache = new Map();
    const usageFor = async (productId) => {
      if (!productId) return 10;
      const key = productId.toString();
      if (usageCache.has(key)) return usageCache.get(key);
      const prod = await InventoryProduct.findById(key).select('usagePerWork');
      const pct = prod && prod.usagePerWork != null ? prod.usagePerWork : 10;
      usageCache.set(key, pct);
      return pct;
    };

    const kits = await StaffKit.find({ employeeId });
    let updated = 0;
    for (const kit of kits) {
      let changed = false;
      for (const item of kit.items) {
        const percent = await usageFor(item.productId);
        if (percent <= 0) continue;
        applyTubeUsage(item, percent); // mutates item.quantity / item.fillLevel
        changed = true;
        updated += 1;
      }
      if (changed) await kit.save();
    }

    res.json({ updated });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Manually set a product's open-tube fill (0..100) — used by the artist tube
// adjuster and by managers. Opening/closing a tube nudges the tube count.
export const setProductFill = async (req, res) => {
  if (!hasInventoryAccess(req.user)) {
    return res.status(403).json({ message: 'No inventory access' });
  }
  try {
    const product = await InventoryProduct.findOne({
      _id: req.params.id,
      ...ownerScope(req.user),
    });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    if (req.body.fillLevel != null) {
      const f = clampPct(req.body.fillLevel, product.fillLevel ?? 100);
      product.fillLevel = f;
      // Keep quantity coherent with an empty / freshly-opened tube.
      if (f > 0 && product.quantity <= 0) product.quantity = 1;
      if (f === 0 && product.quantity <= 1) product.quantity = 0;
    }
    if (req.body.quantity != null) {
      product.quantity = Math.max(0, Number.parseInt(req.body.quantity, 10) || 0);
      // No tubes on hand → nothing in the open tube.
      if (product.quantity <= 0) product.fillLevel = 0;
    }
    await product.save();
    res.json(product);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
