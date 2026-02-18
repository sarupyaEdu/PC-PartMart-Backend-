const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const { getDashboardStats } = require("../controllers/admin.controller");

router.get(
  "/dashboard-stats",
  protect,
  requireRole("admin"),
  getDashboardStats,
);

module.exports = router;
