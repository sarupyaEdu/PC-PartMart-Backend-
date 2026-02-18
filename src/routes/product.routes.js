const router = require("express").Router();
const p = require("../controllers/product.controller");
const { protect, requireRole } = require("../middleware/auth.middleware");

router.get("/", p.list);
router.get("/admin", protect, requireRole("admin"), p.listAdmin);
router.post("/bulk", p.bulk);

router.get("/tags", p.listTags);

router.delete(
  "/:productId/image",
  protect,
  requireRole("admin"),
  p.removeProductImage,
);

router.get("/:slug", p.getBySlug);

router.post("/", protect, requireRole("admin"), p.create);
router.put("/:id", protect, requireRole("admin"), p.update);
router.delete("/:id", protect, requireRole("admin"), p.remove);

module.exports = router;
