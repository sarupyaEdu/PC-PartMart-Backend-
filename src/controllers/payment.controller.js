// controllers/payment.controller.js
const Razorpay = require("razorpay");
const crypto = require("crypto");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const Order = require("../models/Order");
const Product = require("../models/Product"); // ✅ add this import
const mongoose = require("mongoose");

async function loadProductForOrder(productId, session = null) {
  let q = Product.findById(productId).select(
    "_id title price discountPrice isActive type stock bundleItems images timedOffer",
  );

  if (session) q = q.session(session);
  return q.populate(
    "bundleItems.product",
    "_id title stock isActive type price discountPrice timedOffer",
  );
}

// For SINGLE: use product.stock
// For BUNDLE: compute from children stocks
function getAvailableStock(product) {
  if (!product) return 0;

  // SINGLE
  if ((product.type || "SINGLE") !== "BUNDLE") {
    return Math.max(0, Number(product.stock ?? 0));
  }

  // BUNDLE: min( floor(child.stock / childQty) )
  const items = Array.isArray(product.bundleItems) ? product.bundleItems : [];
  if (items.length < 2) return 0;

  let min = Infinity;

  for (const bi of items) {
    const child = bi?.product;
    const q = Number(bi?.qty || 0);

    if (!child) return 0;
    if (child.isActive === false) return 0;
    if ((child.type || "SINGLE") === "BUNDLE") return 0; // prevent nested bundle
    if (!Number.isFinite(q) || q <= 0) return 0;

    const childStock = Math.max(0, Number(child.stock ?? 0));
    min = Math.min(min, Math.floor(childStock / q));
  }

  return Number.isFinite(min) ? Math.max(0, min) : 0;
}

async function consumeStockOrThrow(product, orderQty, session = null) {
  const qty = Number(orderQty || 0);
  if (qty <= 0) throw new AppError("Invalid quantity", 400);

  if ((product.type || "SINGLE") !== "BUNDLE") {
    const updated = await Product.findOneAndUpdate(
      { _id: product._id, stock: { $gte: qty }, isActive: true },
      { $inc: { stock: -qty } },
      { new: true, session },
    );

    if (!updated)
      throw new AppError(`Not enough stock for ${product.title}`, 400);
    return;
  }

  const items = Array.isArray(product.bundleItems) ? product.bundleItems : [];
  if (items.length < 2) throw new AppError("Invalid bundle configuration", 400);

  const bundleStock = getAvailableStock(product);
  if (bundleStock < qty) {
    throw new AppError(`Not enough stock for bundle ${product.title}`, 400);
  }

  const decremented = [];

  try {
    for (const bi of items) {
      const child = bi.product;
      const perBundle = Number(bi.qty || 0);
      const need = perBundle * qty;

      const ok = await Product.findOneAndUpdate(
        { _id: child._id, stock: { $gte: need }, isActive: true },
        { $inc: { stock: -need } },
        { new: true, session },
      );

      if (!ok) {
        throw new AppError(
          `Not enough stock for bundle item ${child.title}`,
          400,
        );
      }

      decremented.push({ childId: child._id, need });
    }
  } catch (err) {
    if (decremented.length) {
      const rollbackOps = decremented.map((x) => ({
        updateOne: {
          filter: { _id: x.childId },
          update: { $inc: { stock: x.need } }, // add back what we deducted
        },
      }));

      await Product.bulkWrite(rollbackOps, session ? { session } : undefined);
    }
    throw err;
  }
}

// ✅ Bundle-safe restock (same logic as order.controller.js)
async function restockForOrderLine(productId, qtyToRestock, session = null) {
  const qty = Number(qtyToRestock || 0);
  if (qty <= 0) return;

  let q = Product.findById(productId).select("_id type bundleItems");
  if (session) q = q.session(session);

  const product = await q.populate("bundleItems.product", "_id");
  if (!product) return;

  if ((product.type || "SINGLE") !== "BUNDLE") {
    await Product.findByIdAndUpdate(
      productId,
      { $inc: { stock: qty } },
      { session },
    );
    return;
  }

  const items = Array.isArray(product.bundleItems) ? product.bundleItems : [];
  if (!items.length) return;

  const ops = [];
  for (const bi of items) {
    const childId = bi?.product?._id;
    const perBundle = Number(bi?.qty || 0);
    if (!childId || perBundle <= 0) continue;

    ops.push({
      updateOne: {
        filter: { _id: childId },
        update: { $inc: { stock: perBundle * qty } },
      },
    });
  }

  if (ops.length) {
    await Product.bulkWrite(ops, session ? { session } : undefined);
  }
}

// ✅ Make totalAmount reflect non-cancelled qty
function recomputeTotalAfterCancel(order) {
  const newTotal = (order.items || []).reduce((sum, it) => {
    const activeQty = Number(it.qty || 0) - Number(it.cancelledQty || 0);
    return sum + Math.max(activeQty, 0) * Number(it.priceSnapshot || 0);
  }, 0);
  order.totalAmount = newTotal;
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.createRazorpayOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.body; // Mongo order _id

  const order = await Order.findById(orderId);
  if (!order) throw new AppError("Order not found", 404);

  order.payment = order.payment || { method: "COD", status: "PENDING" };
  order.razorpay = order.razorpay || {
    orderId: null,
    paymentId: null,
    signature: null,
  };

  // ❌ Do not allow payment for cancelled orders
  if (order.status === "CANCELLED") {
    throw new AppError("Order is cancelled", 400);
  }

  // ❌ Replacement orders don't require Razorpay
  if (order.isReplacement) {
    throw new AppError("Replacement orders don't require payment", 400);
  }

  // owner/admin check
  const isOwner = String(order.userId) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

  // ❌ Already paid
  if (order.payment?.status === "PAID") {
    throw new AppError("Order already paid", 400);
  }

  // amount in paise
  const amount = Math.round(Number(order.totalAmount || 0) * 100);
  if (amount <= 0) throw new AppError("Invalid order amount", 400);

  // ✅ Prevent creating multiple Razorpay orders for same Mongo order
  if (order.razorpay?.orderId && order.payment?.status === "PENDING") {
    return res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      razorpayOrder: {
        id: order.razorpay.orderId,
        amount,
        currency: "INR",
      },
      mongoOrderId: order._id,
    });
  }

  const rzpOrder = await razorpay.orders.create({
    amount,
    currency: "INR",
    receipt: `rcpt_${order._id}`,
    notes: { mongoOrderId: String(order._id) },
  });

  // ✅ update order payment state
  order.payment.method = "RAZORPAY";
  order.payment.status = "PENDING";

  // ✅ Option A: store razorpay fields at ROOT (matches your schema)
  order.razorpay = order.razorpay || {};
  order.razorpay.orderId = rzpOrder.id;

  order.statusHistory.push({
    status: "PAYMENT_ORDER_CREATED",
    at: new Date(),
    note: `Razorpay order created: ${rzpOrder.id}`,
  });

  await order.save();

  res.json({
    keyId: process.env.RAZORPAY_KEY_ID, // safe to send
    razorpayOrder: rzpOrder,
    mongoOrderId: order._id,
  });
});

exports.verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const {
    mongoOrderId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = req.body;

  const order = await Order.findById(mongoOrderId);
  if (!order) throw new AppError("Order not found", 404);
  order.payment = order.payment || { method: "COD", status: "PENDING" };
  order.razorpay = order.razorpay || {
    orderId: null,
    paymentId: null,
    signature: null,
  };

  // optional safety:
  if (order.status === "CANCELLED") {
    throw new AppError("Order cancelled. Please retry payment.", 400);
  }

  // ✅ idempotent: already verified
  if (order.payment?.status === "PAID") {
    return res.json({ success: true, order });
  }

  // owner/admin check
  const isOwner = String(order.userId) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

  // ✅ Option A: compare with ROOT razorpay.orderId
  if (order.razorpay?.orderId !== razorpay_order_id) {
    throw new AppError("Razorpay order mismatch", 400);
  }

  // expected signature = HMAC_SHA256(order_id|payment_id, key_secret)
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");

  if (expected !== razorpay_signature) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // work on fresh copy in txn
      const freshOrder = await Order.findById(mongoOrderId).session(session);
      if (!freshOrder) throw new AppError("Order not found", 404);

      // mark payment failed
      freshOrder.payment.status = "FAILED";

      // cancel order (only if not already terminal)
      if (!["CANCELLED", "RETURNED", "REPLACED"].includes(freshOrder.status)) {
        freshOrder.status = "CANCELLED";
      }

      // ✅ restock remaining qty + set cancelledQty
      for (const it of freshOrder.items || []) {
        const remaining = Number(it.qty || 0) - Number(it.cancelledQty || 0);

        if (remaining > 0) {
          it.cancelledQty = Number(it.cancelledQty || 0) + remaining;

          // bundle-safe restock
          await restockForOrderLine(it.productId, remaining, session);
        }
      }

      // ✅ totalAmount becomes 0 if fully cancelled
      recomputeTotalAfterCancel(freshOrder);

      freshOrder.statusHistory.push({
        status: "PAYMENT_FAILED",
        at: new Date(),
        note: "Razorpay signature mismatch (auto-cancel + restock)",
      });

      await freshOrder.save({ session });

      await session.commitTransaction();
      session.endSession();

      throw new AppError("Payment verification failed", 400);
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  }

  // ✅ verified
  order.payment.status = "PAID";
  order.payment.txnId = razorpay_payment_id;

  // ✅ Option A: store at ROOT
  order.razorpay = order.razorpay || {};
  order.razorpay.orderId = razorpay_order_id;
  order.razorpay.paymentId = razorpay_payment_id;
  order.razorpay.signature = razorpay_signature;

  // auto-confirm after payment
  if (order.status === "PLACED") order.status = "CONFIRMED";

  order.statusHistory.push({
    status: "PAID",
    at: new Date(),
    note: `Razorpay payment verified: ${razorpay_payment_id}`,
  });

  await order.save();

  res.json({ success: true, order });
});

// ✅ Create a fresh order for retry (clone items + reserve stock again)
// Call this when old order is CANCELLED due to payment failure
exports.retryPaymentByCloningOrder = asyncHandler(async (req, res) => {
  const { oldOrderId } = req.body;

  const oldOrder = await Order.findById(oldOrderId);
  if (!oldOrder) throw new AppError("Old order not found", 404);

  const isOwner = String(oldOrder.userId) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

  if (oldOrder.payment?.status === "PAID") {
    throw new AppError("Order already paid", 400);
  }

  if (
    oldOrder.status !== "CANCELLED" ||
    oldOrder.payment?.status !== "FAILED"
  ) {
    throw new AppError("Retry allowed only for CANCELLED + FAILED orders", 400);
  }

  // ✅ recompute total from snapshots (not oldOrder.totalAmount, which is now 0)
  const totalAmount = (oldOrder.items || []).reduce(
    (sum, it) => sum + Number(it.priceSnapshot || 0) * Number(it.qty || 0),
    0,
  );

  if (totalAmount <= 0) throw new AppError("Invalid retry amount", 400);

  // ✅ IMPORTANT: reserve stock again (otherwise oversell)
  // ✅ IMPORTANT: reserve stock again (bundle-safe)
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const it of oldOrder.items || []) {
      const qty = Number(it.qty || 0);
      if (qty <= 0) continue;

      const product = await loadProductForOrder(it.productId, session);
      if (!product || product.isActive === false) {
        throw new AppError("Product unavailable", 400);
      }

      await consumeStockOrThrow(product, qty, session);
    }

    const fresh = await Order.create(
      [
        {
          userId: oldOrder.userId,
          items: oldOrder.items.map((it) => ({
            productId: it.productId,
            titleSnapshot: it.titleSnapshot,
            priceSnapshot: it.priceSnapshot,
            strikeSnapshot: it.strikeSnapshot || 0,
            typeSnapshot: it.typeSnapshot || "SINGLE",
            offerSnapshot: it.offerSnapshot || "NONE",
            imageSnapshot: it.imageSnapshot || "",
            qty: it.qty,
            cancelledQty: 0,
            returnedQty: 0,
            replacedQty: 0,
          })),
          shippingAddress: oldOrder.shippingAddress,
          totalAmount,
          payment: { method: "RAZORPAY", status: "PENDING" },
          status: "PLACED",
          statusHistory: [
            { status: "PLACED", at: new Date(), note: "Retry order created" },
          ],
          razorpay: { orderId: null, paymentId: null, signature: null },
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    return res.json({ success: true, newOrder: fresh[0] });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
});

// ✅ User cancels payment (modal dismissed) => cancel order + restock + clear razorpay orderId
exports.cancelRazorpayAttempt = asyncHandler(async (req, res) => {
  const { mongoOrderId, reason } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(mongoOrderId).session(session);
    if (!order) throw new AppError("Order not found", 404);

    order.payment = order.payment || { method: "COD", status: "PENDING" };
    order.razorpay = order.razorpay || {
      orderId: null,
      paymentId: null,
      signature: null,
    };

    const isOwner = String(order.userId) === String(req.user._id);
    const isAdmin = req.user.role === "admin";
    if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

    if (order.payment?.status === "PAID") {
      throw new AppError("Paid orders cannot be cancelled here", 400);
    }

    // mark failed + cancel (release stock)
    order.payment.method = "RAZORPAY";
    order.payment.status = "FAILED";
    order.status = "CANCELLED";

    // restock remaining qty + set cancelledQty
    for (const it of order.items || []) {
      const remaining = Number(it.qty || 0) - Number(it.cancelledQty || 0);
      if (remaining > 0) {
        it.cancelledQty = Number(it.cancelledQty || 0) + remaining;
        await restockForOrderLine(it.productId, remaining, session);
      }
    }

    recomputeTotalAfterCancel(order);

    // ✅ clear stored razorpay ids (so retry creates fresh Razorpay order)
    order.razorpay = order.razorpay || {};
    order.razorpay.orderId = null;
    order.razorpay.paymentId = null;
    order.razorpay.signature = null;

    order.statusHistory.push({
      status: "PAYMENT_CANCELLED",
      at: new Date(),
      note: reason || "User cancelled Razorpay payment",
    });

    await order.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.json({ success: true, order });
  } catch (e) {
    await session.abortTransaction();
    session.endSession();
    throw e;
  }
});

// ✅ Admin (or system) refund via Razorpay API
exports.refundRazorpayPayment = asyncHandler(async (req, res) => {
  const { mongoOrderId, amount } = req.body; // amount optional (INR)

  const order = await Order.findById(mongoOrderId);
  if (!order) throw new AppError("Order not found", 404);

  order.payment = order.payment || { method: "COD", status: "PENDING" };
  order.razorpay = order.razorpay || {
    orderId: null,
    paymentId: null,
    signature: null,
  };

  // only admin
  if (req.user.role !== "admin") throw new AppError("Forbidden", 403);

  if (order.payment?.method !== "RAZORPAY") {
    throw new AppError("Not a Razorpay order", 400);
  }

  if (order.payment?.status !== "PAID") {
    throw new AppError("Order is not PAID", 400);
  }

  if (order.payment?.status === "REFUNDED") {
    throw new AppError("Already refunded", 400);
  }

  const paymentId = order.razorpay?.paymentId || order.payment?.txnId;
  if (!paymentId) throw new AppError("Missing Razorpay paymentId", 400);

  // amount in paise; default full refund
  const refundAmountPaise =
    amount != null
      ? Math.round(Number(amount) * 100)
      : Math.round(Number(order.totalAmount || 0) * 100);

  if (refundAmountPaise <= 0) throw new AppError("Invalid refund amount", 400);

  // ✅ Razorpay refund call
  // Node SDK supports refunding a payment
  const refund = await razorpay.payments.refund(paymentId, {
    amount: refundAmountPaise,
    notes: { mongoOrderId: String(order._id) },
  });

  order.payment.status = "REFUNDED";
  order.payment.note = `Refunded via Razorpay: ${refund.id || ""}`;

  order.statusHistory.push({
    status: "REFUNDED",
    at: new Date(),
    note: `Refund initiated via Razorpay (${refundAmountPaise} paise)`,
  });

  await order.save();

  return res.json({ success: true, refund, order });
});
