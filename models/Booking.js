import mongoose from 'mongoose';

const generateBookingNumberCandidate = () => {
  const now = new Date();
  const datePrefix = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const randomSuffix = String(Math.floor(Math.random() * 9000) + 1000);
  return `${datePrefix}${randomSuffix}`;
};

const assignedStaffSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    artistName: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      default: '',
    },
    specialization: {
      type: String,
      default: '',
    },
    works: {
      type: [String],
      default: [],
    },
    phone: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      default: '',
    },
    roleType: {
      type: String,
      enum: ['lead', 'assistant'],
      default: 'assistant',
    },
  },
  { _id: false }
);

const addonSchema = mongoose.Schema(
  {
    addonServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AddonService',
    },
    service: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    persons: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const bookingItemSchema = mongoose.Schema(
  {
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Package',
    },
    service: {
      type: String,
      required: true,
    },
    eventSlot: {
      type: String,
      default: '',
    },
    selectedDates: {
      type: [String],
      default: [],
    },
    totalPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    advanceAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    assignedStaff: {
      type: [assignedStaffSchema],
      default: [],
    },
  },
  { _id: false }
);

const bookingSchema = mongoose.Schema(
  {
    bookingNumber: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    packageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Package',
    },
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
    },
    customerName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
    },
    phone: {
      type: String,
    },
    service: {
      type: String,
      required: true,
    },
    region: {
      type: String,
    },
    driverName: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      default: 'pending',
    },
    mapUrl: {
      type: String,
      default: '',
    },
    travelMode: {
      type: String,
      default: '',
    },
    travelTime: {
      type: String,
      default: '',
    },
    travelDistanceKm: {
      type: Number,
      default: 0,
      min: 0,
    },
    eventSlot: {
      type: String,
      default: '',
    },
    requiredRoomDetail: {
      type: String,
      default: '',
    },
    secondaryContact: {
      type: String,
      default: '',
    },
    outfitDetails: {
      type: String,
      default: '',
    },
    captureStaffDetails: {
      type: String,
      default: '',
    },
    temporaryStaffDetails: {
      type: String,
      default: '',
    },
    staffInstructions: {
      type: String,
      default: '',
    },
    internalRemarks: {
      type: String,
      default: '',
    },
    contentCreationRequired: {
      type: Boolean,
      default: false,
    },
    bookingDate: {
      type: Date,
      required: true,
    },
    selectedDates: {
      type: [String],
      default: [],
    },
    serviceStart: {
      type: Date,
      required: true,
    },
    serviceEnd: {
      type: Date,
      required: true,
    },
    totalPrice: {
      type: Number,
      required: true,
    },
    advanceAmount: {
      type: Number,
      default: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    discountType: {
      type: String,
      enum: ['inr', 'percent'],
      default: 'inr',
    },
    discountValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    assignedStaff: {
      type: [assignedStaffSchema],
      default: [],
    },
    addons: {
      type: [addonSchema],
      default: [],
    },
    bookingItems: {
      type: [bookingItemSchema],
      default: [],
    },
    completionInvoiceSentAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

bookingSchema.pre('validate', async function assignBookingNumber(next) {
  if (this.bookingNumber) {
    next();
    return;
  }

  const BookingModel = mongoose.models.Booking;
  if (!BookingModel) {
    this.bookingNumber = generateBookingNumberCandidate();
    next();
    return;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generateBookingNumberCandidate();
    // Keep the visible booking number digit-only and human-readable.
    const existingBooking = await BookingModel.exists({
      bookingNumber: candidate,
      _id: { $ne: this._id },
    });

    if (!existingBooking) {
      this.bookingNumber = candidate;
      break;
    }
  }

  if (!this.bookingNumber) {
    this.bookingNumber = `${Date.now()}`;
  }

  next();
});

const Booking = mongoose.model('Booking', bookingSchema);

export default Booking;
