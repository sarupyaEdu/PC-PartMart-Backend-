const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    titleSnapshot: { type: String, required: true },
    slugSnapshot: String,
    priceSnapshot: { type: Number, required: true, min: 0 },
    // ✅ NEW: for showing strike price / discount breakdown later
    strikeSnapshot: { type: Number, default: 0, min: 0 },
    typeSnapshot: { type: String, default: "SINGLE" }, // optional but useful
    offerSnapshot: { type: String, default: "NONE" }, // "NONE" | "DISCOUNT" | "TIMED"

    imageSnapshot: { type: String, default: "" },

    qty: { type: Number, required: true, min: 1 },

    // ✅ item-level progress
    cancelledQty: { type: Number, default: 0, min: 0 },
    returnedQty: { type: Number, default: 0, min: 0 },
    replacedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: [(arr) => arr.length > 0, "Order must have at least one item"],
    },

    shippingAddress: {
      name: String,
      phone: String,
      addressLine1: String,
      city: String,
      state: String,
      pincode: String,
    },

    totalAmount: { type: Number, required: true },

    // ✅ For Replacement order linking
    parentOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      required: function () {
        return this.isReplacement;
      },
    },

    isReplacement: {
      type: Boolean,
      default: false,
    },
    replacementOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },

    returnRequest: {
      type: {
        type: String,
        enum: ["NONE", "RETURN", "REPLACEMENT"],
        default: "NONE",
      },
      reason: { type: String, default: "" },
      note: { type: String, default: "" },

      items: {
        type: [
          {
            productId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "Product",
              required: true,
            },
            qty: { type: Number, required: true, min: 1 },
          },
        ],
        default: [], // ✅ add this
      },

      status: {
        type: String,
        enum: ["NONE", "REQUESTED", "APPROVED", "REJECTED", "COMPLETED"],
        default: "NONE",
      },
      requestedAt: Date,
      decidedAt: Date,
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      adminNote: { type: String, default: "" },
    },

    payment: {
      method: {
        type: String,
        enum: ["COD", "RAZORPAY", "REPLACEMENT"],
        default: "COD",
      },
      status: {
        type: String,
        enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
        default: "PENDING",
      },
      txnId: { type: String, default: null }, // for any external payment reference
      note: { type: String, default: "" }, // ✅ add this
    },

    razorpay: {
      orderId: { type: String, default: null }, // rzp_order_xxx
      paymentId: { type: String, default: null }, // rzp_payment_xxx
      signature: { type: String, default: null },
    },

    status: {
      type: String,
      enum: [
        "PLACED",
        "CONFIRMED",
        "SHIPPED",
        "DELIVERED",
        "CANCELLED",
        "RETURNED",
        "REPLACED",
      ],
      default: "PLACED",
    },

    statusHistory: [
      {
        status: String,
        at: Date,
        note: String,
      },
    ],
    // models/Order.js
    salesCounted: { type: Boolean, default: false },
    salesRolledBackQty: { type: Number, default: 0, min: 0 },
    salesRolledBack: {
      type: [
        {
          productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
          },
          qty: { type: Number, required: true, min: 0 },
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Order", orderSchema);
