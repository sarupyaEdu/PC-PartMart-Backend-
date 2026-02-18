const express = require("express");
const router = express.Router();

const paymentController = require("../controllers/payment.controller");

// ✅ correct import (because middleware exports an object)
const { protect, requireRole } = require("../middleware/auth.middleware");

router.post("/create-order", protect, paymentController.createRazorpayOrder);
router.post("/verify", protect, paymentController.verifyRazorpayPayment);

// optional endpoints you added
router.post("/retry", protect, paymentController.retryPaymentByCloningOrder);
router.post(
  "/cancel-attempt",
  protect,
  paymentController.cancelRazorpayAttempt,
);

// admin refund (you might want requireRole('admin') here later)
router.post(
  "/refund",
  protect,
  requireRole("admin"),
  paymentController.refundRazorpayPayment
);

module.exports = router;
