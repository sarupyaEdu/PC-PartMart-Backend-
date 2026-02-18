const router = require("express").Router();
const s = require("../controllers/support.controller");
const { protect, requireRole } = require("../middleware/auth.middleware");

// CUSTOMER
router.post("/tickets", protect, s.createTicket);
router.get("/tickets/my", protect, s.myTickets);
router.get("/tickets/:id", protect, s.getTicket);
router.post("/tickets/:id/messages", protect, s.addMessage);

// ADMIN
router.get(
  "/tickets/admin/all",
  protect,
  requireRole("admin"),
  s.adminListTickets,
);
router.patch(
  "/tickets/admin/:id/status",
  protect,
  requireRole("admin"),
  s.adminUpdateStatus,
);
// (optional) admin reply
router.post(
  "/tickets/admin/:id/messages",
  protect,
  requireRole("admin"),
  s.addMessage,
);

module.exports = router;
