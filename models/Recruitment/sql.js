/**
 * Small SQL helpers shared by the recruitment models.
 */

/**
 * Builds "col = $n, ..." from the keys of `data` that are in `allowed`.
 * Keys set to `undefined` are skipped, so a partial update touches only what
 * was sent. Returns null when there is nothing to update.
 */
function buildUpdate(data, allowed, startIndex = 1) {
    const sets = [];
    const values = [];
    for (const key of allowed) {
        if (data[key] === undefined) continue;
        values.push(data[key]);
        sets.push(`${key} = $${startIndex + values.length - 1}`);
    }
    return sets.length ? { sets: sets.join(", "), values } : null;
}

/** Builds "(a, b) VALUES ($1, $2)" for an INSERT from the keys present. */
function buildInsert(data, allowed) {
    const cols = allowed.filter((k) => data[k] !== undefined);
    return {
        cols: cols.join(", "),
        params: cols.map((_, i) => `$${i + 1}`).join(", "),
        values: cols.map((k) => data[k]),
    };
}

module.exports = { buildUpdate, buildInsert };
