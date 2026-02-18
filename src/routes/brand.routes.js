const router = require("express").Router();

const {
  createBrand,
  getBrands,
  updateBrand,
  deleteBrand,
  deleteBrandLogo,
} = require("../controllers/brand.controller");

const { protect, requireRole } = require("../middleware/auth.middleware");

/* =========================
   PUBLIC / CUSTOMER ROUTES
   ========================= */

// 👉 Customer listing (used in filters, product pages, etc.)
router.get("/", getBrands);

/* =========================
   ADMIN ROUTES
   ========================= */

router.post("/", protect, requireRole("admin"), createBrand);

router.put("/:id", protect, requireRole("admin"), updateBrand);

router.delete("/:id/logo", protect, requireRole("admin"), deleteBrandLogo);

router.delete("/:id", protect, requireRole("admin"), deleteBrand);

module.exports = router;
