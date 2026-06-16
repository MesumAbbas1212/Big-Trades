export function roundPrice(price) {
  // Dynamic tick based on price magnitude
  // Ensures meaningful price levels for all trading pairs
  let tick;
  if (price >= 10000) tick = 0.1;       // BTC: 64000.0, 64000.1
  else if (price >= 100) tick = 0.01;   // SOL: 150.00, 150.01
  else if (price >= 1) tick = 0.001;    // XRP: 0.500, 0.501
  else tick = 0.0001;                   // SHIB: 0.00001, 0.00002
  return Math.round(price / tick) * tick;
}

export function getTick(price) {
  if (price >= 10000) return 0.1;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.001;
  return 0.0001;
}
