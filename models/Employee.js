import mongoose from 'mongoose';

const employeeSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
    },
    email: {
      type: String,
      default: '',
    },
    profileImage: {
      type: String,
      default: '',
    },
    type: {
      type: String,
      enum: ['in-house', 'outsource', 'full-time', 'contract'],
      default: 'in-house',
    },
    artistRole: {
      type: String,
      enum: ['artist', 'assistant', 'driver', 'staff', 'other'],
      default: 'artist',
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
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      default: null,
    },
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Zone',
      default: null,
    },
    stateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'State',
      default: null,
    },
    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'District',
      default: null,
    },
    pincodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Pincode',
      default: null,
    },
    role: {
      type: String,
      default: '',
    },
    department: {
      type: String,
      default: 'Operations',
    },
    category: {
      type: String,
      enum: ['operations', 'administrative', 'creative', 'it', 'marketing', 'sales', 'admin'],
      default: 'operations',
    },
  },
  {
    timestamps: true,
  }
);

const Employee = mongoose.model('Employee', employeeSchema);

export default Employee;
