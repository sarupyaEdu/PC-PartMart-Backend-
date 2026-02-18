const router = require("express").Router();
const w = require("../controllers/wishlist.controller");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.get("/ids", w.getWishlistIds);
router.get("/", w.getMyWishlist);
router.post("/toggle/:productId", w.toggleWishlistItem);
router.post("/add/:productId", w.addToWishlist);
router.delete("/remove/:productId", w.removeFromWishlist);
router.delete("/clear", w.clearWishlist);

module.exports = router;
