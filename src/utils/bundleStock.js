function computeBundleMaxQty(bundleDoc) {
  const items = bundleDoc?.bundleItems || [];
  if (!items.length) return 0;

  let max = Infinity;
  for (const it of items) {
    const stock = Number(it?.product?.stock || 0);
    const need = Number(it?.qty || 1);
    max = Math.min(max, Math.floor(stock / need));
  }
  return Number.isFinite(max) ? max : 0;
}

module.exports = { computeBundleMaxQty };
