import mongoose from 'mongoose';

const pincodeSchema = mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Please add a pincode/postal code'],
      trim: true,
      unique: true,
    },
    district: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'District',
      required: [true, 'Please specify a district'],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

const Pincode = mongoose.model('Pincode', pincodeSchema);

export default Pincode;
