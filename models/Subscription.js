import mongoose from 'mongoose';
import { ADMIN_DEPARTMENTS } from './AdminExpense.js';

export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly', 'one-time'];
export const SUBSCRIPTION_STATUSES = ['active', 'paused', 'cancelled', 'expired'];

const subscriptionSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please provide subscription or tool name'],
      trim: true,
    },
    department: {
      type: String,
      enum: ADMIN_DEPARTMENTS,
      default: 'IT',
      required: true,
    },
    plan: {
      type: String,
      default: '',
      trim: true,
    },
    cost: {
      type: Number,
      required: [true, 'Please specify the subscription cost'],
      min: [0, 'Cost cannot be negative'],
    },
    billingCycle: {
      type: String,
      enum: BILLING_CYCLES,
      default: 'monthly',
    },
    currency: {
      type: String,
      default: 'INR',
      trim: true,
    },
    renewalDate: {
      type: Date,
      required: [true, 'Please provide next renewal date'],
      default: Date.now,
    },
    paymentMethod: {
      type: String,
      default: 'credit_card',
      trim: true,
    },
    ownerEmployeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    ownerName: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: 'active',
    },
    autoRenew: {
      type: Boolean,
      default: true,
    },
    websiteUrl: {
      type: String,
      default: '',
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    receiptImage: {
      type: String,
      default: '',
    },
    // GST Reverse Charge Mechanism for imported services (foreign-currency tools)
    gstRcm: {
      type: Boolean,
      default: false,
    },
    // GST rate applicable under RCM (typically 18% for OIDAR services)
    gstRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Subscription = mongoose.model('Subscription', subscriptionSchema);

export default Subscription;
