const router = require("express").Router();
const o = require("../controllers/order.controller");
const { protect, requireRole } = require("../middleware/auth.middleware");

// Admin
router.get("/admin/all", protect, requireRole("admin"), o.adminListOrders);
router.patch(
  "/admin/:id/status",
  protect,
  requireRole("admin"),
  o.adminUpdateStatus
);
router.patch(
  "/admin/:id/refund",
  protect,
  requireRole("admin"),
  o.adminRefundOrder
);

router.patch(
  "/admin/:id/rr/decide",
  protect,
  requireRole("admin"),
  o.adminDecideReturnOrReplacement
);
router.patch(
  "/admin/:id/rr/complete",
  protect,
  requireRole("admin"),
  o.adminCompleteReturnOrReplacement
);

router.post("/", protect, o.createOrder);
router.get("/my", protect, o.myOrders);
router.patch("/:id/cancel", protect, o.cancelOrder);
router.patch("/:id/cancel-items", protect, o.cancelItems);
router.post("/:id/rr", protect, o.requestReturnOrReplacement);
router.patch("/:id/rr/cancel", protect, o.cancelReturnOrReplacementRequest);
router.get("/:id", protect, o.getOrder);

module.exports = router;
