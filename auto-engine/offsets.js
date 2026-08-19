// Generates `legCount` scheduled times spread across `totalDurationMinutes`,
// starting from `startTime`, with organic (non-uniform) gaps — never a fixed
// interval like 10/20/30/40.
function generateOffsets(legCount, totalDurationMinutes, startTime = new Date()) {
  if (legCount <= 1) return [new Date(startTime)];

  // Random gap weights, normalized to fill the total duration.
  const gapWeights = Array.from({ length: legCount - 1 }, () => 0.6 + Math.random() * 0.8);
  const weightSum = gapWeights.reduce((a, b) => a + b, 0);
  const gapsMinutes = gapWeights.map((w) => (w / weightSum) * totalDurationMinutes);

  const times = [new Date(startTime)];
  let cursor = new Date(startTime);
  for (const gap of gapsMinutes) {
    cursor = new Date(cursor.getTime() + gap * 60 * 1000);
    times.push(new Date(cursor));
  }
  return times;
}

// Mode presets: [legCountRange, totalDurationMinutesRange]. Used by the
// chunk/leg engine to decide how a chunk gets broken up.
const MODE_PRESETS = {
  viral: { minLegs: 12, maxLegs: 30, minDurationMin: 180, maxDurationMin: 480, variance: 18 },
  fast: { minLegs: 3, maxLegs: 8, minDurationMin: 20, maxDurationMin: 90, variance: 10 },
  trending: { minLegs: 10, maxLegs: 20, minDurationMin: 120, maxDurationMin: 300, variance: 14 },
  slow: { minLegs: 25, maxLegs: 60, minDurationMin: 480, maxDurationMin: 1440, variance: 8 },
};

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function presetFor(mode) {
  const p = MODE_PRESETS[mode] || MODE_PRESETS.viral;
  return {
    legCount: randInt(p.minLegs, p.maxLegs),
    durationMinutes: randInt(p.minDurationMin, p.maxDurationMin),
    variance: p.variance,
  };
}

module.exports = { generateOffsets, presetFor, MODE_PRESETS };
