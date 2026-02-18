// controllers/order.controller.js
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const Order = require("../models/Order");
const Product = require("../models/Product");
const mongoose = require("mongoose");
const { deleteUserReviewsForProducts } = require("../utils/reviewCleanup");

// ===== BUNDLE helpers =====
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

function getFinalUnitPrice(product) {
  const price = Number(product?.price || 0);
  const dp = product?.discountPrice;
  const hasDiscount = dp != null && Number(dp) >= 0 && Number(dp) < price;
  return hasDiscount ? Number(dp) : price;
}

function getStrikeUnitPrice(product) {
  if (!product) return 0;

  const type = product.type || "SINGLE";
  const isBundle = type === "BUNDLE";

  // SINGLE: strike is original MRP (price)
  if (!isBundle) return Number(product.price || 0);

  // BUNDLE: strike is sum of children (discountPrice if valid else price) * bundle qty
  const items = Array.isArray(product.bundleItems) ? product.bundleItems : [];
  if (items.length < 2) return Number(product.price || 0);

  let sum = 0;
  for (const bi of items) {
    const q = Number(bi?.qty || 1);
    const child = bi?.product;
    if (!child) continue;

    const childPrice = Number(child?.price || 0);
    const childDp = Number(child?.discountPrice || 0);
    const childUnit =
      childDp > 0 && childDp < childPrice ? childDp : childPrice;

    sum += childUnit * (Number.isFinite(q) ? q : 1);
  }

  return Number.isFinite(sum) ? sum : Number(product.price || 0);
}

function getTimedOfferPriceIfActive(product) {
  const now = new Date();

  const to = product?.timedOffer;

  // ✅ match your schema: timedOffer.isActive
  if (to && to.isActive === true) {
    const start = to.startAt ? new Date(to.startAt) : null;
    const end = to.endAt ? new Date(to.endAt) : null;

    // require both dates (your schema validation already enforces it)
    const within = !!start && !!end && now >= start && now <= end;

    const p = Number(to.price ?? 0);

    if (within && Number.isFinite(p) && p > 0) return p;
  }

  // (Optional) if you still want legacy flat fields support, keep this:
  if (product?.timedOfferEnabled) {
    const start = product?.timedOfferStart
      ? new Date(product.timedOfferStart)
      : null;
    const end = product?.timedOfferEnd ? new Date(product.timedOfferEnd) : null;

    const within = !!start && !!end && now >= start && now <= end;
    const p = Number(product?.timedOfferPrice ?? 0);

    if (within && Number.isFinite(p) && p > 0) return p;
  }

  return null;
}

function getPaidUnitPrice(product) {
  if (!product) return 0;

  const basePrice = Number(product?.price || 0);

  // ✅ timed offer overrides discountPrice
  const timed = getTimedOfferPriceIfActive(product);
  if (timed != null && timed > 0 && timed < basePrice) {
    return timed;
  }

  // fallback normal discount
  return getFinalUnitPrice(product);
}

// For SINGLE: use product.stock
// For BUNDLE: compute from children stocks
function getAvailableStock(product) {
  if (!product) return 0;
  if ((product.type || "SINGLE") !== "BUNDLE") {
    return Math.max(0, Number(product.stock ?? 0));
  }

  // bundleStock = min( floor(child.stock / childQty) )
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

const calcTotal = (items) =>
  items.reduce((sum, it) => sum + it.priceSnapshot * it.qty, 0);

const normId = (v) => String(v || "");

const getEligibleQtyForRR = (it) => {
  // qty that can still be returned/replaced (excluding already returned/replaced/cancelled)
  return (
    Number(it.qty || 0) -
    Number(it.cancelledQty || 0) -
    Number(it.returnedQty || 0) -
    Number(it.replacedQty || 0)
  );
};

const recomputeTotalAfterCancel = (order) => {
  // payable qty excludes cancelledQty (return/replacement does not reduce payable here)
  const newTotal = order.items.reduce((sum, it) => {
    const activeQty = Number(it.qty || 0) - Number(it.cancelledQty || 0);
    return sum + Math.max(activeQty, 0) * Number(it.priceSnapshot || 0);
  }, 0);
  order.totalAmount = newTotal;
};

const isFullyCancelled = (order) =>
  order.items.every(
    (it) => Number(it.cancelledQty || 0) >= Number(it.qty || 0),
  );

const isFullyReturned = (order) =>
  order.items.every((it) => Number(it.returnedQty || 0) >= Number(it.qty || 0));

const isFullyReplaced = (order) =>
  order.items.every((it) => Number(it.replacedQty || 0) >= Number(it.qty || 0));

const incSoldCountOnceOnPaidDelivered = async (order) => {
  if (!order) return false;

  // only count once
  if (order.salesCounted) return false;

  // only when PAID + DELIVERED
  if (order.status !== "DELIVERED") return false;
  if (order.payment?.status !== "PAID") return false;

  const bulkOps = (order.items || [])
    .map((it) => {
      const activeQty =
        Number(it.qty || 0) -
        Number(it.cancelledQty || 0) -
        Number(it.returnedQty || 0) -
        Number(it.replacedQty || 0);

      if (activeQty <= 0) return null;

      return {
        updateOne: {
          filter: { _id: it.productId },
          update: { $inc: { soldCount: activeQty } },
        },
      };
    })
    .filter(Boolean);

  if (bulkOps.length) {
    await Product.bulkWrite(bulkOps);
  }

  // mark counted (but DO NOT save here)
  order.salesCounted = true;
  order.salesRolledBackQty = Number(order.salesRolledBackQty || 0);
  order.salesRolledBack = order.salesRolledBack || [];

  return true;
};

const decSoldCount = async (lines = [], session = null) => {
  // lines: [{ productId, qty }]
  const bulkOps = lines
    .map((x) => {
      const qty = Number(x?.qty || 0);
      if (!x?.productId || qty <= 0) return null;

      return {
        updateOne: {
          filter: { _id: x.productId },
          // ✅ clamp to 0: soldCount = max(0, soldCount - qty)
          update: [
            {
              $set: {
                soldCount: {
                  $max: [0, { $subtract: ["$soldCount", qty] }],
                },
              },
            },
          ],
        },
      };
    })
    .filter(Boolean);

  if (bulkOps.length) {
    await Product.bulkWrite(bulkOps, session ? { session } : undefined);
  }
};

// ===============================
// CREATE ORDER (Customer)
// ===============================
exports.createOrder = asyncHandler(async (req, res) => {
  const { items, shippingAddress, paymentMethod } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("Cart items required", 400);
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const snapshotItems = [];

    for (const it of items) {
      const qty = Number(it.qty || 0);
      if (qty <= 0) throw new AppError("Invalid quantity", 400);

      // ✅ use session in product load
      const product = await Product.findById(it.productId)
        .session(session)
        .select(
          "_id title slug price discountPrice isActive type stock bundleItems images timedOffer",
        )

        .populate(
          "bundleItems.product",
          "_id title stock isActive type price discountPrice",
        );

      if (!product) throw new AppError("Product not found", 404);
      if (!product.isActive) {
        throw new AppError(`Product unavailable: ${product.title}`, 400);
      }

      const imageSnapshot =
        Array.isArray(product.images) && product.images[0]?.url
          ? product.images[0].url
          : "";
      const timed = getTimedOfferPriceIfActive(product);
      const paidUnit = timed != null ? timed : getFinalUnitPrice(product);
      const strikeUnit = getStrikeUnitPrice(product); // context/original (32998 for bundle)

      snapshotItems.push({
        productId: product._id,
        titleSnapshot: product.title,
        slugSnapshot: product.slug,
        typeSnapshot: product.type || "SINGLE", // optional
        priceSnapshot: paidUnit,
        strikeSnapshot: strikeUnit,
        offerSnapshot:
          timed != null ? "TIMED" : product.discountPrice ? "DISCOUNT" : "NONE",
        imageSnapshot,
        qty,
      });

      // ✅ consume stock WITH session
      await consumeStockOrThrow(product, qty, session);
    }

    const totalAmount = calcTotal(snapshotItems);

    const method = paymentMethod || "COD";

    // ✅ Razorpay must always start as PENDING (PAID only after verify)
    let paymentStatus = "PENDING";

    if (method === "COD") paymentStatus = "PENDING";
    if (method === "REPLACEMENT") paymentStatus = "PAID";

    // Optional: if someone still sends "UPI"/"CARD" from old UI, treat as Razorpay
    // (remove later once frontend is updated)
    const normalizedMethod =
      method === "UPI" || method === "CARD" ? "RAZORPAY" : method;

    const created = await Order.create(
      [
        {
          userId: req.user._id,
          items: snapshotItems,
          shippingAddress: shippingAddress || {},
          totalAmount,
          payment: { method: normalizedMethod, status: paymentStatus },
          status: "PLACED",
          statusHistory: [
            { status: "PLACED", at: new Date(), note: "Order placed" },
          ],
        },
      ],
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({ order: created[0] });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
});

// ===============================
// CUSTOMER - My Orders
// ===============================
exports.myOrders = asyncHandler(async (req, res) => {
  const orders = await Order.find({ userId: req.user._id })
    .populate("items.productId", "images title") // ✅ fallback for old orders
    .sort("-createdAt");

  res.json({ orders });
});

// ===============================
// CUSTOMER/ADMIN - Get One Order
// ===============================
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate(
    "items.productId",
    "images title slug",
  ); // ✅

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
    //"RETURNED",
    //"REPLACED",
  ];

  if (!allowed.includes(status)) throw new AppError("Invalid status", 400);

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  // 🚫 Delivered orders cannot move backward or be cancelled
  if (order.status === "DELIVERED") {
    const forbidden = ["PLACED", "CONFIRMED", "SHIPPED", "CANCELLED"];
    if (forbidden.includes(status)) {
      throw new AppError(
        "Delivered orders cannot be moved to previous or cancelled states",
        400,
      );
    }
  }

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

    // Restock full replacement quantities
    for (const it of order.items) {
      const remaining = Number(it.qty || 0) - Number(it.cancelledQty || 0);
      if (remaining > 0) {
        it.cancelledQty = Number(it.cancelledQty || 0) + remaining;
        await restockForOrderLine(it.productId, remaining);
      }
    }
    recomputeTotalAfterCancel(order);

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
      400,
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
      const remaining = Number(it.qty || 0) - Number(it.cancelledQty || 0);
      if (remaining > 0) {
        it.cancelledQty = Number(it.cancelledQty || 0) + remaining;

        await restockForOrderLine(it.productId, remaining);
      }
    }

    // optional but recommended so totalAmount becomes 0 when fully cancelled
    recomputeTotalAfterCancel(order);
  }

  // COD payment
  if (order.payment.method === "COD") {
    if (status === "DELIVERED") order.payment.status = "PAID";
    if (status === "CANCELLED") order.payment.status = "FAILED";
  }
  // ✅ BEST SELLING COUNT (once, paid + delivered)
  if (status === "DELIVERED" && order.payment?.status === "PAID") {
    await incSoldCountOnceOnPaidDelivered(order);
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
      400,
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
// CUSTOMER - Request Return/Replacement (PARTIAL)
// ===============================
exports.requestReturnOrReplacement = asyncHandler(async (req, res) => {
  const { type, reason, note, items } = req.body; // items: [{productId, qty}]

  if (!["RETURN", "REPLACEMENT"].includes(type)) {
    throw new AppError("type must be RETURN or REPLACEMENT", 400);
  }
  if (!reason?.trim()) throw new AppError("reason is required", 400);

  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("items[] required for partial return/replacement", 400);
  }

  const order = await Order.findById(req.params.id);

  if (!order) throw new AppError("Order not found", 404);

  const hasAnyActive = order.items.some(
    (it) => Number(it.qty || 0) - Number(it.cancelledQty || 0) > 0,
  );
  if (!hasAnyActive) {
    throw new AppError("No active items available for return/replacement", 400);
  }
  if (order.status === "CANCELLED") {
    throw new AppError(
      "Cannot request return/replacement on cancelled orders",
      400,
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

  // build req map
  const reqMap = new Map();
  for (const x of items) {
    const pid = normId(x?.productId);
    const qty = Number(x?.qty || 0);
    if (!pid || qty <= 0) throw new AppError("Invalid items payload", 400);
    reqMap.set(pid, (reqMap.get(pid) || 0) + qty);
  }

  // ✅ keep a copy (because reqMap will be mutated during validation)
  const finalMap = new Map(reqMap);

  // validate eligibility
  for (const line of order.items) {
    const pid = normId(line.productId);
    const rq = reqMap.get(pid) || 0;
    if (!rq) continue;

    const eligible = getEligibleQtyForRR(line);
    if (rq > eligible) {
      throw new AppError(
        `Requested qty exceeds eligible qty for ${line.titleSnapshot}`,
        400,
      );
    }

    reqMap.delete(pid);
  }

  if (reqMap.size) throw new AppError("Some items not found in order", 400);

  order.returnRequest = {
    type,
    reason: reason.trim(),
    note: (note || "").trim(),
    items: Array.from(finalMap.entries()).map(([productId, qty]) => ({
      productId: new mongoose.Types.ObjectId(productId),
      qty: Number(qty),
    })),

    status: "REQUESTED",
    requestedAt: new Date(),
    decidedAt: null,
    decidedBy: null,
    adminNote: "",
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
      400,
    );
  }

  if (order.isReplacement && order.returnRequest?.type === "REPLACEMENT") {
    throw new AppError("Replacement orders cannot be replaced again", 400);
  }

  if (order.status !== "DELIVERED") {
    throw new AppError(
      "Return/Replacement can be approved only after delivery",
      400,
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
// ADMIN - Complete RR (Return / Replacement) (PARTIAL)
// ===============================
exports.adminCompleteReturnOrReplacement = asyncHandler(async (req, res) => {
  const { adminNote } = req.body;

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  if (order.isReplacement && order.returnRequest?.type === "REPLACEMENT") {
    throw new AppError("Replacement orders cannot be replaced again", 400);
  }

  if (["RETURNED", "REPLACED"].includes(order.status)) {
    throw new AppError("Order already finalized", 400);
  }

  if (order.returnRequest?.status !== "APPROVED") {
    throw new AppError("Return/Replacement is not in APPROVED state", 400);
  }

  if (order.status !== "DELIVERED") {
    throw new AppError(
      "Return/Replacement can be completed only for delivered orders",
      400,
    );
  }

  if (order.returnRequest.status === "COMPLETED") {
    throw new AppError("Return/Replacement already completed", 400);
  }

  const rrItems = Array.isArray(order.returnRequest.items)
    ? order.returnRequest.items
    : [];

  if (rrItems.length === 0) {
    throw new AppError("No RR items found", 400);
  }

  // ===============================
  // RETURN (PARTIAL)
  // ===============================
  if (order.returnRequest.type === "RETURN") {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // ✅ always work on a fresh copy inside the transaction
      const freshOrder = await Order.findById(order._id).session(session);
      if (!freshOrder) throw new AppError("Order not found", 404);

      const rrItemsFresh = Array.isArray(freshOrder.returnRequest?.items)
        ? freshOrder.returnRequest.items
        : [];

      if (!rrItemsFresh.length) throw new AppError("No RR items found", 400);

      const rollbackLines = [];
      const alreadyRolledBack = new Map(
        (freshOrder.salesRolledBack || []).map((x) => [
          String(x.productId),
          Number(x.qty || 0),
        ]),
      );

      for (const x of rrItemsFresh) {
        const qty = Number(x?.qty || 0);
        if (qty <= 0) continue;

        const line = freshOrder.items.find(
          (it) => normId(it.productId) === normId(x.productId),
        );
        if (!line) throw new AppError("RR item not found in order", 400);

        const eligible = getEligibleQtyForRR(line);
        if (qty > eligible) {
          throw new AppError(
            `Return qty exceeds eligible qty for ${line.titleSnapshot}`,
            400,
          );
        }

        line.returnedQty = Number(line.returnedQty || 0) + qty;

        // ✅ restock inside same transaction
        await restockForOrderLine(line.productId, qty, session);

        if (freshOrder.salesCounted) {
          const key = String(line.productId);
          const done = alreadyRolledBack.get(key) || 0;

          const totalReturned = Number(line.returnedQty || 0);
          const canRollback = Math.max(0, totalReturned - done);

          if (canRollback > 0) {
            rollbackLines.push({ productId: line.productId, qty: canRollback });
          }
        }
      }

      freshOrder.returnRequest.status = "COMPLETED";
      freshOrder.returnRequest.adminNote = adminNote || "Return completed";

      if (isFullyReturned(freshOrder)) {
        freshOrder.status = "RETURNED";

        if (
          !freshOrder.isReplacement &&
          freshOrder.payment?.status === "PAID"
        ) {
          freshOrder.payment.status = "REFUNDED";
        }

        freshOrder.statusHistory.push({
          status: "RETURNED",
          at: new Date(),
          note: freshOrder.returnRequest.adminNote,
        });
      } else {
        freshOrder.statusHistory.push({
          status: "PARTIAL_RETURNED",
          at: new Date(),
          note: freshOrder.returnRequest.adminNote,
        });
      }

      // ✅ refund parent (replacement case) inside same transaction
      if (
        freshOrder.isReplacement &&
        freshOrder.parentOrderId &&
        isFullyReturned(freshOrder)
      ) {
        const parent = await Order.findById(freshOrder.parentOrderId).session(
          session,
        );

        if (
          parent &&
          parent.payment?.status === "PAID" &&
          parent.payment.status !== "REFUNDED"
        ) {
          parent.payment.status = "REFUNDED";
          parent.statusHistory.push({
            status: "REFUNDED",
            at: new Date(),
            note: "Refunded because replacement order was fully returned",
          });
          await parent.save({ session });
        }
      }

      if (rollbackLines.length) {
        // ✅ rollback soldCount inside transaction
        await decSoldCount(rollbackLines, session);

        const existing = new Map(
          (freshOrder.salesRolledBack || []).map((x) => [
            String(x.productId),
            Number(x.qty || 0),
          ]),
        );

        for (const r of rollbackLines) {
          const key = String(r.productId);
          existing.set(key, (existing.get(key) || 0) + Number(r.qty || 0));
        }

        freshOrder.salesRolledBack = Array.from(existing.entries()).map(
          ([productId, qty]) => ({
            productId: new mongoose.Types.ObjectId(productId),
            qty,
          }),
        );

        const rolledBackNow = rollbackLines.reduce(
          (sum, x) => sum + Number(x.qty || 0),
          0,
        );
        freshOrder.salesRolledBackQty =
          Number(freshOrder.salesRolledBackQty || 0) + rolledBackNow;
      }

      await freshOrder.save({ session });

      await session.commitTransaction();
      session.endSession();

      // ✅ AFTER DB COMMIT: delete reviews for returned products
      // rrItems in your schema is: [{ productId, qty }]
      // NOTE: Order items store productId (could be SINGLE or BUNDLE product)
      const returnedProductIds = [];

      for (const x of rrItemsFresh) {
        const pid = x?.productId;
        const qty = Number(x?.qty || 0);
        if (!pid || qty <= 0) continue;

        // Load the purchased product to see if it was SINGLE or BUNDLE
        const p = await Product.findById(pid)
          .select("_id type bundleItems")
          .populate("bundleItems.product", "_id");

        if (!p) continue;

        // If SINGLE => delete review for this product
        if ((p.type || "SINGLE") !== "BUNDLE") {
          returnedProductIds.push(p._id);
        } else {
          // If BUNDLE => delete reviews of CHILD products (because customer reviewed child products)
          const bis = Array.isArray(p.bundleItems) ? p.bundleItems : [];
          for (const bi of bis) {
            const childId = bi?.product?._id;
            if (childId) returnedProductIds.push(childId);
          }
        }
      }

      // ✅ Delete reviews + cloudinary images (and recompute ratings inside util)
      // Remove duplicates (important for bundles)
      const uniqReturnedProductIds = Array.from(
        new Set(returnedProductIds.map(String)),
      );

      if (uniqReturnedProductIds.length) {
        await deleteUserReviewsForProducts(
          freshOrder.userId,
          uniqReturnedProductIds,
        );
      }

      return res.json({ order: freshOrder });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  }

  // ===============================
  // REPLACEMENT (PARTIAL)
  // ===============================
  if (order.returnRequest.type === "REPLACEMENT") {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freshOrder = await Order.findById(order._id).session(session);
      // ✅ prevent duplicate replacement orders
      if (freshOrder.replacementOrderId) {
        throw new AppError(
          "Replacement order already created for this order",
          400,
        );
      }

      const repLines = [];

      for (const x of rrItems) {
        const qty = Number(x?.qty || 0);
        if (qty <= 0) continue;

        const line = freshOrder.items.find(
          (it) => normId(it.productId) === normId(x.productId),
        );
        if (!line) throw new AppError("RR item not found in order", 400);

        const eligible = getEligibleQtyForRR(line);
        if (qty > eligible) {
          throw new AppError(
            `Replacement qty exceeds eligible qty for ${line.titleSnapshot}`,
            400,
          );
        }

        const product = await loadProductForOrder(line.productId, session);
        if (!product)
          throw new AppError("Product not found for replacement", 404);
        if (!product.isActive) {
          throw new AppError(
            `Product unavailable for replacement: ${product.title}`,
            400,
          );
        }

        const available = getAvailableStock(product);
        if (available < qty) {
          throw new AppError(
            `Not enough stock for replacement: ${product.title}`,
            400,
          );
        }

        repLines.push({
          productId: line.productId,
          titleSnapshot: line.titleSnapshot,
          slugSnapshot: line.slugSnapshot, // ✅ ADD THIS
          typeSnapshot: line.typeSnapshot || "SINGLE",
          priceSnapshot: 0,
          strikeSnapshot: 0,
          offerSnapshot: "NONE",
          imageSnapshot: line.imageSnapshot || "",
          qty,
        });
      }

      if (repLines.length === 0)
        throw new AppError("No valid replacement items", 400);

      // deduct stock safely inside transaction
      for (const r of repLines) {
        const product = await loadProductForOrder(r.productId, session);
        await consumeStockOrThrow(product, r.qty, session);
      }

      const replacementOrder = await Order.create(
        [
          {
            userId: freshOrder.userId,
            items: repLines.map((r) => ({
              productId: r.productId,
              titleSnapshot: r.titleSnapshot,
              slugSnapshot: r.slugSnapshot, // ✅ ADD THIS
              typeSnapshot: r.typeSnapshot,
              priceSnapshot: r.priceSnapshot,
              strikeSnapshot: r.strikeSnapshot,
              offerSnapshot: r.offerSnapshot,
              imageSnapshot: r.imageSnapshot,
              qty: r.qty,
            })),
            shippingAddress: freshOrder.shippingAddress,
            totalAmount: 0,
            payment: { method: "REPLACEMENT", status: "PAID", txnId: null },
            status: "CONFIRMED",
            statusHistory: [
              {
                status: "CONFIRMED",
                at: new Date(),
                note: "Replacement order created (partial)",
              },
            ],
            isReplacement: true,
            parentOrderId: freshOrder._id,
          },
        ],
        { session },
      );

      // update original order
      for (const r of repLines) {
        const line = freshOrder.items.find(
          (it) => normId(it.productId) === normId(r.productId),
        );
        if (line) {
          line.replacedQty = Number(line.replacedQty || 0) + Number(r.qty || 0);
        }
      }

      freshOrder.replacementOrderId = replacementOrder[0]._id;
      freshOrder.returnRequest.status = "COMPLETED";
      freshOrder.returnRequest.adminNote =
        adminNote || "Replacement order created";
      freshOrder.payment.note = "Replacement issued instead of refund";

      if (isFullyReplaced(freshOrder)) {
        freshOrder.status = "REPLACED";
        freshOrder.statusHistory.push({
          status: "REPLACED",
          at: new Date(),
          note: `Replacement Order ID: ${replacementOrder[0]._id}`,
        });
      } else {
        freshOrder.statusHistory.push({
          status: "PARTIAL_REPLACED",
          at: new Date(),
          note: `Replacement Order ID: ${replacementOrder[0]._id}`,
        });
      }

      await freshOrder.save({ session });

      await session.commitTransaction();
      session.endSession();

      return res.json({
        message: "Replacement order created",
        originalOrder: freshOrder,
        replacementOrder: replacementOrder[0],
      });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  }

  throw new AppError("Invalid return request type", 400);
});

// ===============================
// CUSTOMER - Cancel Order (supports replacement cancel before shipped)
// ===============================
exports.cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body || {};

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  // owner only
  if (String(order.userId) !== String(req.user._id)) {
    throw new AppError("Forbidden", 403);
  }

  // already final
  if (["CANCELLED", "RETURNED", "REPLACED"].includes(order.status)) {
    throw new AppError(`Order already ${order.status}`, 400);
  }

  // cannot cancel after shipped/delivered
  if (["SHIPPED", "DELIVERED"].includes(order.status)) {
    throw new AppError("Cannot cancel shipped or delivered orders", 400);
  }

  // ✅ Standard rule: cancel only when PLACED/CONFIRMED
  if (!["PLACED", "CONFIRMED"].includes(order.status)) {
    throw new AppError("Order cannot be cancelled at this stage", 400);
  }

  // mark cancelled
  order.status = "CANCELLED";

  // restock (both normal + replacement orders should restock, because stock was deducted)
  for (const it of order.items) {
    const remaining = Number(it.qty || 0) - Number(it.cancelledQty || 0);
    if (remaining > 0) {
      it.cancelledQty = Number(it.cancelledQty || 0) + remaining;

      await restockForOrderLine(it.productId, remaining);
    }
  }
  recomputeTotalAfterCancel(order);
  // payment status handling
  // - COD: cancelled => FAILED
  // - replacement order: treat as FAILED (like your admin cancel)
  if (order.payment?.method === "COD") {
    order.payment.status = "FAILED";
  }
  if (order.payment?.method === "RAZORPAY" && order.payment.status !== "PAID") {
    order.payment.status = "FAILED";
  }
  if (order.isReplacement) {
    order.payment.status = "FAILED";
  }

  order.statusHistory.push({
    status: "CANCELLED",
    at: new Date(),
    note: (
      reason ||
      (order.isReplacement
        ? "Replacement order cancelled by customer"
        : "Cancelled by customer")
    ).trim(),
  });

  await order.save();

  // ✅ If replacement order cancelled → refund ORIGINAL order if paid (same as admin logic)
  if (order.isReplacement && order.parentOrderId) {
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
        note: "Refunded because replacement order was cancelled by customer",
      });

      await parent.save();
    }
  }

  res.json({ order });
});

// ===============================
// CUSTOMER - Cancel Return/Replacement Request
// ===============================
exports.cancelReturnOrReplacementRequest = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  // owner only
  if (String(order.userId) !== String(req.user._id)) {
    throw new AppError("Forbidden", 403);
  }

  // blocked if cancelled/finalized
  if (order.status === "CANCELLED") {
    throw new AppError("Cannot modify RR on cancelled orders", 400);
  }
  if (["RETURNED", "REPLACED"].includes(order.status)) {
    throw new AppError("Finalized orders cannot be updated", 400);
  }

  // RR exists?
  const rr = order.returnRequest || {};
  if (!rr.status || rr.status === "NONE") {
    throw new AppError("No return/replacement request to cancel", 400);
  }

  // ✅ allow cancel only while REQUESTED (before admin decision)
  if (rr.status !== "REQUESTED") {
    throw new AppError(
      "You can cancel only when request is in REQUESTED state",
      400,
    );
  }

  // must be delivered (since RR can be requested only after delivered)
  if (order.status !== "DELIVERED") {
    throw new AppError("RR cancellation allowed only after delivery", 400);
  }

  const prevType = rr.type;

  // reset RR to NONE (same schema structure)
  order.returnRequest = {
    type: "NONE",
    reason: "",
    note: "",
    items: [], // ✅ important
    status: "NONE",
    requestedAt: null,
    decidedAt: null,
    decidedBy: null,
    adminNote: "",
  };

  order.statusHistory.push({
    status: `RR_CANCELLED_${prevType}`,
    at: new Date(),
    note: "Cancelled by customer",
  });

  await order.save();
  res.json({ order });
});

// ===============================
// CUSTOMER - Partial Cancel Items (PLACED/CONFIRMED only)
// ===============================
exports.cancelItems = asyncHandler(async (req, res) => {
  const { items, reason } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError("items[] required", 400);
  }

  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order not found", 404);

  if (String(order.userId) !== String(req.user._id)) {
    throw new AppError("Forbidden", 403);
  }

  if (!["PLACED", "CONFIRMED"].includes(order.status)) {
    throw new AppError("Partial cancel allowed only in PLACED/CONFIRMED", 400);
  }

  // map requested cancels
  const reqMap = new Map();
  for (const x of items) {
    const pid = normId(x?.productId);
    const qty = Number(x?.qty || 0);
    if (!pid || qty <= 0) throw new AppError("Invalid items payload", 400);
    reqMap.set(pid, (reqMap.get(pid) || 0) + qty);
  }

  // apply cancels
  for (const line of order.items) {
    const pid = normId(line.productId);
    const cq = reqMap.get(pid) || 0;
    if (!cq) continue;

    const available = Number(line.qty || 0) - Number(line.cancelledQty || 0);
    if (cq > available) {
      throw new AppError(
        `Cancel qty exceeds available for ${line.titleSnapshot}`,
        400,
      );
    }

    line.cancelledQty = Number(line.cancelledQty || 0) + cq;

    await restockForOrderLine(line.productId, cq);

    reqMap.delete(pid);
  }

  if (reqMap.size) throw new AppError("Some items not found in order", 400);

  recomputeTotalAfterCancel(order);

  // if everything cancelled => cancel order
  // if everything cancelled => cancel order
  if (isFullyCancelled(order)) {
    order.status = "CANCELLED";

    // COD => failed
    if (order.payment?.method === "COD") order.payment.status = "FAILED";

    // Razorpay (not paid yet) => failed
    if (
      order.payment?.method === "RAZORPAY" &&
      order.payment.status !== "PAID"
    ) {
      order.payment.status = "FAILED";
    }

    // replacement => failed
    if (order.isReplacement) order.payment.status = "FAILED";
  }

  order.statusHistory.push({
    status: "PARTIAL_CANCEL",
    at: new Date(),
    note: `${(reason || "").trim()} | Items: ${items.length}`,
  });

  await order.save();
  res.json({ order });
});
