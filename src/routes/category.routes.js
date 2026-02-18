const router = require("express").Router();
const c = require("../controllers/category.controller");
const { protect, requireRole } = require("../middleware/auth.middleware");

router.get("/", c.getAll);
router.get("/slug/:slug", c.getBySlug); // ✅ fixed
router.post("/", protect, requireRole("admin"), c.create);
router.put("/:id", protect, requireRole("admin"), c.update);
router.delete("/:id", protect, requireRole("admin"), c.remove);

module.exports = router;
