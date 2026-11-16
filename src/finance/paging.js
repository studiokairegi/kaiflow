// Paged table reads for Finance. Paging with .range() is only safe over a total order. Ordering by a
// non-unique column (paid_date, issue_date, created_at, name) lets rows that tie across a 1000-row page
// boundary be skipped or repeated, so every query is finished with the table's unique key as a tiebreaker.
export const PAGE = 1000;

export async function fetchAll(client, table, { select = "*", order, ascending = true, tiebreak = ["id"] } = {}) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = client.from(table).select(select).range(from, from + PAGE - 1);
    if (order) q = q.order(order, { ascending });
    for (const col of tiebreak) if (col !== order) q = q.order(col, { ascending: true });
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
