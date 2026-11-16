// Splits a budget across milestone percentages in whole cents. Rounding each milestone on its own can leave the
// invoices a cent off the budget; here the leftover cents go to the milestones with the biggest fractional part, so
// when the percentages add up to 100 the invoices add up to the budget exactly.
export function splitMilestoneAmounts(totalBudget, percentages) {
  const totalCents = Math.round((Number(totalBudget) || 0) * 100);
  const pcts = percentages.map((p) => Math.max(0, parseFloat(p) || 0));
  const exact = pcts.map((p) => (totalCents * p) / 100);
  const cents = exact.map(Math.floor);
  const sumPct = pcts.reduce((a, b) => a + b, 0);
  if (Math.abs(sumPct - 100) < 0.005) {
    let left = totalCents - cents.reduce((a, b) => a + b, 0);
    const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) cents[order[k].i] += 1;
  } else {
    // Not a full split: no leftover to hand out, so just round each to the nearest cent.
    exact.forEach((v, i) => { cents[i] = Math.round(v); });
  }
  return cents.map((c) => c / 100);
}
