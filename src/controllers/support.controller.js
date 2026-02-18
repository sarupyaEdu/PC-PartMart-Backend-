const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/AppError");
const SupportTicket = require("../models/SupportTicket");

const ALLOWED_STATUS = ["open", "pending", "closed"];
const ALLOWED_PRIORITY = ["low", "medium", "high"];
const ALLOWED_CATEGORY = ["general", "order", "compat", "returns", "bulk"];

exports.createTicket = asyncHandler(async (req, res) => {
  const {
    subject,
    priority,
    category,
    message,
    orderId,
    orderItemId, // keep as string unless you have a real model
    orderItemTitleSnapshot,
  } = req.body;

  if (!subject || !String(subject).trim()) {
    throw new AppError("Subject required", 400);
  }

  if (!message || !String(message).trim()) {
    throw new AppError("Message required", 400);
  }

  const cat = ALLOWED_CATEGORY.includes(String(category))
    ? String(category)
    : "general";

  const pr = ALLOWED_PRIORITY.includes(String(priority))
    ? String(priority)
    : "medium";

  const customerName = req.user?.name ? String(req.user.name) : "";
  const customerEmail = req.user?.email ? String(req.user.email) : "";

  const attachOrder = cat === "order";

  const orderIdSafe =
    attachOrder && orderId && mongoose.Types.ObjectId.isValid(orderId)
      ? new mongoose.Types.ObjectId(orderId)
      : null;

  // NOTE: orderItemId is usually NOT a real model; keep as string snapshot/id
  const orderItemIdSafe =
    attachOrder && orderItemId && mongoose.Types.ObjectId.isValid(orderItemId)
      ? new mongoose.Types.ObjectId(orderItemId)
      : null;

  const ticket = await SupportTicket.create({
    userId: req.user?._id || null,
    customerName,
    customerEmail,

    subject: String(subject).trim(),
    category: cat,
    priority: pr,
    status: "open",
    lastMessageAt: new Date(),

    orderId: orderIdSafe,
    orderItemId: orderItemIdSafe,
    orderItemTitleSnapshot:
      attachOrder && orderItemTitleSnapshot
        ? String(orderItemTitleSnapshot).trim()
        : "",

    messages: [
      {
        senderRole: "customer",
        text: String(message).trim(),
        at: new Date(),
      },
    ],
  });

  res.status(201).json({ ticket });
});

exports.myTickets = asyncHandler(async (req, res) => {
  const tickets = await SupportTicket.find({ userId: req.user._id })
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .populate("orderId", "_id status totalAmount createdAt");

  res.json({ tickets });
});

exports.addMessage = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text || !String(text).trim()) {
    throw new AppError("Message text required", 400);
  }

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw new AppError("Ticket not found", 404);

  // ✅ ADD THIS HERE
  if (ticket.status === "closed") {
    throw new AppError("Ticket is closed", 400);
  }

  const isOwner = String(ticket.userId) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

  ticket.messages.push({
    senderRole: isAdmin ? "admin" : "customer",
    text: String(text).trim(),
    at: new Date(),
  });

  ticket.lastMessageAt = new Date();

  ticket.status = isAdmin ? "pending" : "open";

  await ticket.save();
  res.json({ ticket });
});

// ADMIN
exports.adminListTickets = asyncHandler(async (req, res) => {
  const tickets = await SupportTicket.aggregate([
    // 1) add a numeric sort key for status
    {
      $addFields: {
        statusRank: {
          $switch: {
            branches: [
              { case: { $eq: ["$status", "open"] }, then: 0 },
              { case: { $eq: ["$status", "pending"] }, then: 1 },
              { case: { $eq: ["$status", "closed"] }, then: 2 },
            ],
            default: 3,
          },
        },
      },
    },

    // 2) sort by status priority first, then recent activity
    {
      $sort: {
        statusRank: 1,
        lastMessageAt: -1,
        createdAt: -1,
      },
    },

    // 3) populate user
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        as: "userId",
        pipeline: [{ $project: { name: 1, email: 1 } }],
      },
    },
    { $unwind: { path: "$userId", preserveNullAndEmptyArrays: true } },

    // 4) populate order (optional)
    {
      $lookup: {
        from: "orders",
        localField: "orderId",
        foreignField: "_id",
        as: "orderId",
        pipeline: [{ $project: { status: 1, totalAmount: 1, createdAt: 1 } }],
      },
    },
    { $unwind: { path: "$orderId", preserveNullAndEmptyArrays: true } },

    // 5) populate product (optional)
    {
      $lookup: {
        from: "products",
        localField: "orderItemId",
        foreignField: "_id",
        as: "orderItemId",
        pipeline: [{ $project: { title: 1, slug: 1 } }],
      },
    },
    { $unwind: { path: "$orderItemId", preserveNullAndEmptyArrays: true } },

    // 6) remove helper field
    { $project: { statusRank: 0 } },
  ]);

  res.json({ tickets });
});

exports.getTicket = asyncHandler(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id).populate(
    "orderId",
    "_id status totalAmount createdAt",
  );

  if (!ticket) throw new AppError("Ticket not found", 404);

  const isOwner = String(ticket.userId) === String(req.user._id);
  const isAdmin = req.user.role === "admin";
  if (!isOwner && !isAdmin) throw new AppError("Forbidden", 403);

  res.json({ ticket });
});

exports.adminUpdateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!ALLOWED_STATUS.includes(String(status))) {
    throw new AppError("Invalid status", 400);
  }

  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw new AppError("Ticket not found", 404);

  ticket.status = String(status);
  await ticket.save();

  res.json({ ticket });
});
