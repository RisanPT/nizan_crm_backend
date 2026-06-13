import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

const userSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    role: {
      type: String,
      enum: ['admin', 'manager', 'crm', 'sales', 'artist', 'accounts', 'driver', 'fleet_manager'],
      default: 'manager',
      trim: true,
    },
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
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
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
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
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    next();
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = async function matchPassword(password) {
  return bcrypt.compare(password, this.password);
};

const User = mongoose.model('User', userSchema);

export default User;
