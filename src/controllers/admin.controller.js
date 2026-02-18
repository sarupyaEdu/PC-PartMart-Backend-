const asyncHandler = require("../utils/asyncHandler");
const Order = require("../models/Order");
const Product = require("../models/Product");
const SupportTicket = require("../models/SupportTicket");

exports.getDashboardStats = asyncHandler(async (req, res) => {
  const LOW_STOCK_THRESHOLD = 5;

  const [totalOrders, totalProducts, lowStock, openTickets] = await Promise.all(
    [
      Order.countDocuments({}),
      Product.countDocuments({}),
      Product.countDocuments({
        type: "SINGLE", // ✅ exclude bundle products
        stock: { $lte: LOW_STOCK_THRESHOLD },
        isActive: { $ne: false },
      }),
      SupportTicket.countDocuments({ status: { $in: ["open", "pending"] } }),
    ],
  );

  res.json({
    totalOrders,
    totalProducts,
    lowStock,
    openTickets,
  });
});
