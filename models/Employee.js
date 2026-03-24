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
    type: {
      type: String,
      enum: ['in-house', 'outsource'],
      default: 'outsource',
    },
    artistRole: {
      type: String,
      enum: ['artist', 'assistant', 'driver'],
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
    role: {
      type: String,
      default: '',
    },
    department: {
      type: String,
      default: 'Staff',
    },
  },
  {
    timestamps: true,
  }
);

const Employee = mongoose.model('Employee', employeeSchema);

export default Employee;
