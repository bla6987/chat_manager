/** Return the highest-scoring items while preserving input order for ties. */
export function selectTopStable(items, limit, getScore = item => item.similarity) {
    const cap = Math.max(0, Math.floor(limit));
    if (cap === 0 || items.length === 0) return [];
    const top = [];
    for (const item of items) {
        const score = getScore(item);
        let low = 0;
        let high = top.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (getScore(top[mid]) < score) high = mid;
            else low = mid + 1;
        }
        if (low < cap) {
            top.splice(low, 0, item);
            if (top.length > cap) top.pop();
        }
    }
    return top;
}

/** Resolve a fixed heatmap grid cell without scanning every rendered day. */
export function getGridCellAtPoint(cells, grid, x, y) {
    if (!grid || x < grid.originX || y < grid.originY) return null;
    const column = Math.floor((x - grid.originX) / grid.step);
    const row = Math.floor((y - grid.originY) / grid.step);
    if (column < 0 || column >= grid.columns || row < 0 || row >= grid.rows) return null;
    const localX = x - (grid.originX + column * grid.step);
    const localY = y - (grid.originY + row * grid.step);
    if (localX > grid.cellSize || localY > grid.cellSize) return null;
    return cells[column * grid.rows + row] || null;
}
