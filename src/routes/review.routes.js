const router = require("express").Router();
const review = require("../controllers/review.controller");
const { protect } = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");

// --- Permission check ---
router.get("/can-review/:productId", protect, review.canReviewProduct);

// --- My Review (GET / UPDATE / DELETE) ---
router.get("/me/:productId", protect, review.getMyReviewForProduct);

router.put(
  "/me/:productId",
  protect,
  upload.array("images", 5), // allow image update
  review.updateMyReviewForProduct,
);

router.delete("/me/:productId", protect, review.deleteMyReviewForProduct);

// --- Public review listing ---
router.get("/product/:productId", review.listProductReviews);
router.get("/bundle/:bundleId", review.listBundleReviews);

// --- Create review ---
router.post("/", protect, upload.array("images", 5), review.createReview);

module.exports = router;
