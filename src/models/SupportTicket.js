const mongoose = require("mongoose");

const SupportMessageSchema = new mongoose.Schema(
  {
    senderRole: {
      type: String,
      enum: ["customer", "admin"],
      required: true,
    },
    text: { type: String, required: true, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const SupportTicketSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // allow guest (optional) - keep false if you want logged-in only
      index: true,
    },

    // snapshots (useful even if user changes later)
    customerName: { type: String, trim: true, default: "" },
    customerEmail: { type: String, trim: true, lowercase: true, default: "" },

    subject: { type: String, required: true, trim: true },

    category: {
      type: String,
      enum: ["general", "order", "compat", "returns", "bulk"],
      default: "general",
      index: true,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
      index: true,
    },

    status: {
      type: String,
      enum: ["open", "pending", "closed"],
      default: "open",
      index: true,
    },

    // order-specific fields (only when category = order)
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },

    // This is the specific product (or order item productId) the customer selected
    orderItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
      index: true,
    },

    // Snapshot so admin sees title even if product removed/renamed
    orderItemTitleSnapshot: { type: String, trim: true, default: "" },
    lastMessageAt: { type: Date, default: Date.now, index: true },

    messages: { type: [SupportMessageSchema], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("SupportTicket", SupportTicketSchema);
