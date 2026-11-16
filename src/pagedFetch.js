// PostgREST caps a single response (1000 rows by default). Read every page so a long list is never silently cut off.
// `build` returns a FRESH query each call (a query builder is single-use) with a stable total order, so pages never
// overlap or skip rows. Resolves to the same { data, error } shape as one query.
export async function fetchAllPages(build, pageSize = 1000, maxPages = 200) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return { data: all, error: null };
}
