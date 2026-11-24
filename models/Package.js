import mongoose from 'mongoose';

const regionPriceSchema = mongoose.Schema(
  {
    region: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const districtPriceSchema = mongoose.Schema(
  {
    district: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'District',
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const websiteImageSchema = mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    alt: { type: String, default: '', trim: true, maxlength: 150 },
  },
  { _id: false }
);

const websiteSchema = mongoose.Schema(
  {
    show: { type: Boolean, default: false },
    sortOrder: { type: Number, default: null },
    tagline: { type: String, default: '', trim: true, maxlength: 100 },
    description: { type: String, default: '', trim: true, maxlength: 400 },
    idealFor: { type: String, default: '', trim: true, maxlength: 200 },
    features: {
      type: [{ type: String, trim: true, maxlength: 120 }],
      default: [],
      validate: [(v) => v.length <= 12, 'At most 12 features'],
    },
    durationLabel: { type: String, default: '', trim: true, maxlength: 30 },
    highlighted: { type: Boolean, default: false },
    priceFrom: { type: Boolean, default: false },
    coverImage: { type: websiteImageSchema, default: null },
  },
  { _id: false }
);

// Bridal Quote "What's Included" rows, set in Services → Packages.
const quoteInclusionsSchema = mongoose.Schema(
  {
    technique: { type: String, default: '', trim: true, maxlength: 60 },
    products: { type: String, default: '', trim: true, maxlength: 80 },
    included: {
      type: [{ type: String, trim: true, maxlength: 120 }],
      default: [],
      validate: [(v) => v.length <= 20, 'At most 20 inclusions'],
    },
  },
  { _id: false }
);

const packageSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a package name'],
      trim: true,
    },
    price: {
      type: Number,
      required: [true, 'Please add a base price'],
      min: 0,
    },
    advanceAmount: {
      type: Number,
      default: 3000,
      min: 0,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    regionPrices: {
      type: [regionPriceSchema],
      default: [],
    },
    districtPrices: {
      type: [districtPriceSchema],
      default: [],
    },
    // Display order set in Services → Packages (lower first). Unset = after
    // the ordered ones, oldest first.
    sortOrder: {
      type: Number,
      default: null,
    },
    // Quote inclusions. Null = never set (the quote then uses its built-in
    // values for known package names, else shows "—").
    quoteInclusions: {
      type: quoteInclusionsSchema,
      default: null,
    },
    // Public website (Team N Website → Packages on Website). All optional:
    // existing packages stay hidden from the site until switched on there.
    // Price and advance always come from the fields above.
    website: {
      type: websiteSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

const ServicePackage = mongoose.model('Package', packageSchema);

export default ServicePackage;
