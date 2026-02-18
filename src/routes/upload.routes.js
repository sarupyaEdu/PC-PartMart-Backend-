const router = require("express").Router();
const {
  uploadImage,
  uploadImages,
  deleteImage,
} = require("../controllers/upload.controller");
const { protect, requireRole } = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");

// Admin only (products)
router.post(
  "/image",
  protect,
  requireRole("admin"),
  upload.single("image"),
  uploadImage,
);
router.post(
  "/images",
  protect,
  requireRole("admin"),
  upload.array("images", 6),
  uploadImages,
);
router.delete("/image", protect, requireRole("admin"), deleteImage);

// Customer + Admin (profile avatar) ✅ force folder
router.post(
  "/avatar",
  protect,
  requireRole("customer", "admin"),
  upload.single("image"),
  (req, res, next) => {
    req.body.folder = "pc-parts-shop/avatars";
    next();
  },
  uploadImage,
);

module.exports = router;
