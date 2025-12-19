// controllers/order.controller.js
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const Order = require("../models/Order");
const Product = require("../models/Product");

const calcTotal = (items) =>
  items.reduce((sum, it) => sum + it.priceSnapshot * it.qty, 0);

// ===============================
// CREATE ORDER (Customer)
// ===============================
exports.createOrder = asyncHandler(async (req, res) => {
  const { items, shippingAddress, paymentMethod } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("Cart items required", 400);
  }

  const snapshotItems = [];

  for (const it of items) {
    const product = await Product.findById(it.productId);
    if (!product) throw new AppError("Product not found", 404);

    if (!product.isActive) {
      throw new AppError(`Product unavailable: ${product.title}`, 400);
    }

    const qty = Number(it.qty || 0);
    if (qty <= 0) throw new AppError("Invalid quantity", 400);

    if (product.stock < qty) {
      throw new AppError(`Not enough stock for ${product.title}`, 400);
    }

    const priceSnapshot = product.discountPrice ?? product.price;

    snapshotItems.push({
      productId: product._id,
      titleSnapshot: product.title,
      priceSnapshot,
      qty,
    });

    // reduce stock
    product.stock -= qty;
    await product.save();
  }

  const totalAmount = calcTotal(snapshotItems);

  const method = paymentMethod || "COD";
  const paymentStatus =
    method === "UPI" || method === "CARD" ? "PAID" : "PENDING";

  const order = await Order.create({
    userId: req.user._id,
    items: snapshotItems,
    shippingAddress: shippingAddress || {},
    totalAmount,
    payment: { method, status: paymentStatus },
    status: "PLACED",
    statusHistory: [{ status: "PLACED", at: new Date(), note: "Order placed" }],
  });

  res.status(201).json({ order });
});

// ===============================
// CUSTOMER - My Orders
// ===============================
exports.myOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ userId: req.user._id }).sort("-createdAt");
  res.json({ orders });
});

// ===============================
// CUSTOMER/ADMIN - Get One Order
// ===============================
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  const isOwner = String(order.userId) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

  res.json({ order });
});

// ===============================
// ADMIN - List Orders
// ===============================
exports.adminListOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find()
    .populate("userId", "name email")
    .sort("-createdAt");
  res.json({ orders });
});

// ===============================
// ADMIN - Update Order Status
// ===============================
exports.adminUpdateStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;

  const allowed = [
    "PLACED",
    "CONFIRMED",
    "SHIPPED",
    "DELIVERED",
    "CANCELLED",
    "RETURNED",
    "REPLACED",
  ];

  if (!allowed.includes(status)) throw new AppError("Invalid status", 400);

  const order = await Order.findById(req.params.id);
  // 🚫 Delivered orders cannot move backward or be cancelled
  if (order.status === "DELIVERED") {
    const forbidden = ["PLACED", "CONFIRMED", "SHIPPED", "CANCELLED"];
    if (forbidden.includes(status)) {
      throw new AppError(
        "Delivered orders cannot be moved to previous or cancelled states",
        400
      );
    }
  }

  if (!order) throw new AppError("Order not found", 404);

  // ===============================
  // REPLACEMENT ORDER CANCEL → REFUND ORIGINAL
  // ===============================
  if (order.isReplacement && status === "CANCELLED") {
    // prevent cancelling shipped/delivered replacement
    if (["SHIPPED", "DELIVERED"].includes(order.status)) {
      throw new AppError("Cannot cancel shipped or delivered orders", 400);
    }

    if (order.status === "CANCELLED") {
      throw new AppError("Order already cancelled", 400);
    }

    order.status = "CANCELLED";

    // Restock items (replacement stock was deducted earlier)
    for (const it of order.items) {
      await Product.findByIdAndUpdate(it.productId, {
        $inc: { stock: it.qty },
      });
    }

    order.payment.status = "FAILED";

    order.statusHistory.push({
      status: "CANCELLED",
      at: new Date(),
      note: note || "Replacement order cancelled",
    });

    await order.save();

    // Refund ORIGINAL order if paid
    if (order.parentOrderId) {
      const parent = await Order.findById(order.parentOrderId);
      if (
        parent &&
        parent.payment?.status === "PAID" &&
        parent.payment.status !== "REFUNDED"
      ) {
        parent.payment.status = "REFUNDED";
        parent.statusHistory.push({
          status: "REFUNDED",
          at: new Date(),
          note: "Refunded because replacement order was cancelled",
        });
        await parent.save();
      }
    }

    return res.json({ order });
  }

  // 🚫 Terminal states (system finalized)
  if (["RETURNED", "REPLACED"].includes(order.status)) {
    throw new AppError("Finalized orders cannot be updated", 400);
  }

  // 🚫 System-controlled statuses
  if (["RETURNED", "REPLACED"].includes(status)) {
    throw new AppError(
      "RETURNED / REPLACED statuses are system-controlled",
      400
    );
  }

  // don't cancel shipped/delivered
  if (
    status === "CANCELLED" &&
    ["SHIPPED", "DELIVERED"].includes(order.status)
  ) {
    throw new AppError("Cannot cancel shipped or delivered orders", 400);
  }

  // Cancelled is final
  if (order.status === "CANCELLED" && status !== "CANCELLED") {
    throw new AppError("Cancelled orders cannot be updated", 400);
  }

  const prevStatus = order.status;
  order.status = status;

  // Restock only when moving into CANCELLED (avoid double restock)
  if (
    status === "CANCELLED" &&
    prevStatus !== "CANCELLED" &&
    !order.isReplacement
  ) {
    for (const it of order.items) {
      await Product.findByIdAndUpdate(it.productId, {
        $inc: { stock: it.qty },
      });
    }
  }

  // COD payment
  if (order.payment.method === "COD") {
    if (status === "DELIVERED") order.payment.status = "PAID";
    if (status === "CANCELLED") order.payment.status = "FAILED";
  }

  order.statusHistory.push({
    status,
    at: new Date(),
    note: note || "",
  });

  await order.save();
  res.json({ order });
});

// ===============================
// ADMIN - Refund (Manual Action)
// ===============================
exports.adminRefundOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  if (!["CANCELLED", "RETURNED"].includes(order.status)) {
    throw new AppError(
      "Order must be CANCELLED or RETURNED before refund",
      400
    );
  }

  if (order.payment.status === "REFUNDED") {
    throw new AppError("Order already refunded", 400);
  }

  if (order.payment.status !== "PAID") {
    throw new AppError("Order is not eligible for refund", 400);
  }

  order.payment.status = "REFUNDED";

  order.statusHistory.push({
    status: "REFUNDED",
    at: new Date(),
    note: "Refund processed by admin",
  });

  await order.save();
  res.json({ order });
});

// ===============================
// CUSTOMER - Request Return/Replacement
// ===============================
exports.requestReturnOrReplacement = asyncHandler(async (req, res) => {
  const { type, reason, note } = req.body; // "RETURN" | "REPLACEMENT"

  if (!["RETURN", "REPLACEMENT"].includes(type)) {
    throw new AppError("type must be RETURN or REPLACEMENT", 400);
  }
  if (!reason?.trim()) throw new AppError("reason is required", 400);

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  if (order.status === "CANCELLED") {
    throw new AppError(
      "Cannot request return/replacement on cancelled orders",
      400
    );
  }

  // owner only
  if (String(order.userId) !== String(req.user._id)) {
    throw new AppError("Forbidden", 403);
  }

  // Replacement orders: allow RETURN, block REPLACEMENT
  if (order.isReplacement && type === "REPLACEMENT") {
    throw new AppError("Replacement orders cannot be replaced again", 400);
  }

  // only after delivered
  if (order.status !== "DELIVERED") {
    throw new AppError("Return/Replacement allowed only after delivery", 400);
  }

  // prevent multiple
  if (order.returnRequest?.status && order.returnRequest.status !== "NONE") {
    throw new AppError("A return/replacement request already exists", 400);
  }

  order.returnRequest = {
    type,
    reason: reason.trim(),
    note: (note || "").trim(),
    status: "REQUESTED",
    requestedAt: new Date(),
  };

  order.statusHistory.push({
    status: `RR_REQUESTED_${type}`,
    at: new Date(),
    note: reason.trim(),
  });

  await order.save();
  res.json({ order });
});

// ===============================
// ADMIN - Approve/Reject RR
// ===============================
exports.adminDecideReturnOrReplacement = asyncHandler(async (req, res) => {
  const { action, adminNote } = req.body; // "APPROVE" | "REJECT"

  if (!["APPROVE", "REJECT"].includes(action)) {
    throw new AppError("action must be APPROVE or REJECT", 400);
  }

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  if (order.status === "CANCELLED") {
    throw new AppError(
      "Cancelled orders cannot have return/replacement actions",
      400
    );
  }

  if (order.isReplacement && order.returnRequest?.type === "REPLACEMENT") {
    throw new AppError("Replacement orders cannot be replaced again", 400);
  }

  if (order.status !== "DELIVERED") {
    throw new AppError(
      "Return/Replacement can be approved only after delivery",
      400
    );
  }

  if (order.returnRequest?.status !== "REQUESTED") {
    throw new AppError("No pending return/replacement request", 400);
  }

  order.returnRequest.status = action === "APPROVE" ? "APPROVED" : "REJECTED";
  order.returnRequest.decidedAt = new Date();
  order.returnRequest.decidedBy = req.user._id;
  order.returnRequest.adminNote = (adminNote || "").trim();

  order.statusHistory.push({
    status: action === "APPROVE" ? "RR_APPROVED" : "RR_REJECTED",
    at: new Date(),
    note: order.returnRequest.adminNote || "",
  });

  await order.save();
  res.json({ order });
});

// ===============================
// ADMIN - Complete RR (Return / Replacement)
// ===============================
exports.adminCompleteReturnOrReplacement = asyncHandler(async (req, res) => {
  const { adminNote } = req.body;

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  // Replacement orders: RETURN allowed, REPLACEMENT blocked
  if (order.isReplacement && order.returnRequest?.type === "REPLACEMENT") {
    throw new AppError("Replacement orders cannot be replaced again", 400);
  }

  if (["RETURNED", "REPLACED"].includes(order.status)) {
    throw new AppError("Order already finalized", 400);
  }

  if (order.returnRequest?.status !== "APPROVED") {
    throw new AppError("Return/Replacement is not in APPROVED state", 400);
  }

  // must be delivered
  if (order.status !== "DELIVERED") {
    throw new AppError(
      "Return/Replacement can be completed only for delivered orders",
      400
    );
  }

  if (order.returnRequest.status === "COMPLETED") {
    throw new AppError("Return/Replacement already completed", 400);
  }

  // ===============================
  // RETURN FLOW
  // ===============================
  if (order.returnRequest.type === "RETURN") {
    // Prevent double refund
    if (order.payment.status === "REFUNDED") {
      throw new AppError("Already refunded", 400);
    }

    // Refund THIS order only if it was a normal paid order (not a free replacement)
    if (!order.isReplacement && order.payment.status === "PAID") {
      order.payment.status = "REFUNDED";
    }

    // Restock items on return completion
    for (const it of order.items) {
      await Product.findByIdAndUpdate(it.productId, {
        $inc: { stock: it.qty },
      });
    }

    order.returnRequest.status = "COMPLETED";
    order.returnRequest.adminNote = adminNote || "Return completed";
    order.status = "RETURNED";

    order.statusHistory.push({
      status: "RETURNED",
      at: new Date(),
      note: order.returnRequest.adminNote,
    });

    // If this was a replacement order being returned, refund the ORIGINAL (parent) order
    if (order.isReplacement && order.parentOrderId) {
      const parent = await Order.findById(order.parentOrderId);

      if (parent && parent.payment?.status === "PAID") {
        // prevent double refund
        if (parent.payment.status !== "REFUNDED") {
          parent.payment.status = "REFUNDED";

          parent.statusHistory.push({
            status: "REFUNDED",
            at: new Date(),
            note: "Refunded because replacement order was returned",
          });

          await parent.save();
        }
      }
    }

    await order.save();
    return res.json({ order });
  }

  // ===============================
  // REPLACEMENT FLOW
  // ===============================
  if (order.returnRequest.type === "REPLACEMENT") {
    if (order.replacementOrderId) {
      throw new AppError("Replacement order already created", 400);
    }

    // ✅ FIX 3A: check stock before creating replacement
    for (const it of order.items) {
      const product = await Product.findById(it.productId);
      if (!product)
        throw new AppError("Product not found for replacement", 404);

      if (!product.isActive) {
        throw new AppError(
          `Product unavailable for replacement: ${product.title}`,
          400
        );
      }

      if (product.stock < it.qty) {
        throw new AppError(
          `Not enough stock for replacement: ${product.title}`,
          400
        );
      }
    }

    // ✅ FIX 3B: deduct stock for replacement shipment
    for (const it of order.items) {
      const updated = await Product.findOneAndUpdate(
        { _id: it.productId, stock: { $gte: it.qty }, isActive: true },
        { $inc: { stock: -it.qty } },
        { new: true }
      );

      if (!updated) {
        throw new AppError("Not enough stock for replacement", 400);
      }
    }

    const replacementOrder = await Order.create({
      userId: order.userId,

      items: order.items.map((it) => ({
        productId: it.productId,
        titleSnapshot: it.titleSnapshot,
        priceSnapshot: 0,
        qty: it.qty,
      })),

      shippingAddress: order.shippingAddress,
      totalAmount: 0,

      // keep method as REPLACEMENT (works with schema enum fix)
      payment: { method: "REPLACEMENT", status: "PAID", txnId: null },

      status: "CONFIRMED",
      statusHistory: [
        {
          status: "CONFIRMED",
          at: new Date(),
          note: "Replacement order created",
        },
      ],

      isReplacement: true,
      parentOrderId: order._id,
    });

    order.replacementOrderId = replacementOrder._id;
    order.returnRequest.status = "COMPLETED";
    order.returnRequest.adminNote = adminNote || "Replacement order created";
    order.status = "REPLACED";
    // 📝 Mark original payment as replaced (no refund)
    order.payment.note = "Replacement issued instead of refund";

    order.statusHistory.push({
      status: "REPLACED",
      at: new Date(),
      note: `Replacement Order ID: ${replacementOrder._id}`,
    });

    await order.save();

    return res.json({
      message: "Replacement order created",
      originalOrder: order,
      replacementOrder,
    });
  }

  throw new AppError("Invalid return request type", 400);
});
