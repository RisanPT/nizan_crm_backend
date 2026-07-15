import mongoose from 'mongoose';

const trialPackageSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a package name'],
      trim: true,
      unique: true,
    },
    price: {
      type: Number,
      required: [true, 'Please add a price'],
      min: 0,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    }
  },
  { timestamps: true }
);

const TrialPackage = mongoose.model('TrialPackage', trialPackageSchema);
export default TrialPackage;
