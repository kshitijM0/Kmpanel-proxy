// Distributes `total` across `legCount` legs following a bell-curve shape
// (slow start, peak in the middle, taper at the end), with random variance
// so no two schedules look identical. Total is always preserved exactly —
// any rounding remainder is folded into the peak leg.
function distributeBellCurve(total, legCount, variancePercent = 15) {
  if (legCount <= 1) return [total];

  const weights = [];
  for (let i = 0; i < legCount; i++) {
    // A smooth bell shape over [0, legCount-1], peak at the center.
    const x = (i / (legCount - 1)) * 2 - 1; // -1..1
    const base = Math.exp(-Math.pow(x * 1.6, 2)); // gaussian-ish
    const jitter = 1 + (Math.random() * 2 - 1) * (variancePercent / 100);
    weights.push(Math.max(0.05, base * jitter));
  }

  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / weightSum) * total);
  const quantities = raw.map((q) => Math.max(1, Math.round(q)));

  // Fix rounding drift so the sum is exactly `total`.
  let drift = total - quantities.reduce((a, b) => a + b, 0);
  const peakIndex = weights.indexOf(Math.max(...weights));
  quantities[peakIndex] = Math.max(1, quantities[peakIndex] + drift);

  return quantities;
}

module.exports = { distributeBellCurve };
