// Shared number formatting for on-map measurement readouts — used by BOTH the
// Snake Ruler (snakeRuler/SnakeRuler.svelte) and the line/polygon draw tool
// (lineLabels.ts, MapDrawControls), so totals + subtotals round identically.
//
// Conventions (the ruler's, kept as the canonical one):
//   • distance: <1 km → whole metres; ≥1 km → km (≥20 km integer, else 1 dp)
//   • area:     <1 ha → 2 dp; 1–<30 ha → 1 dp; ≥30 ha → integer ha;
//               ≥100,000 ha → switch up to km² (1 km² = 100 ha)
//   • all integer parts get thousands separators ("18,194").

/** Insert thousands separators into the integer part of a numeric string. */
export function commas(s: string): string {
    const [int, dec] = s.split(".");
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec ? `.${dec}` : "");
}

/** Distance from km → "847 m" / "12.3 km" / "1,234 km" (see conventions above). */
export function formatMeasureDist(km: number): string {
    const m = km * 1000;
    if (m < 1000) return `${commas(Math.round(m).toString())} m`;
    return `${km >= 20 ? commas(Math.round(km).toString()) : km.toFixed(1)} km`;
}

/** Area from hectares → "0.42 ha" / "3.1 ha" / "156 ha" / "1,000 km²". */
export function formatHectares(ha: number): string {
    if (ha >= 100_000) return `${commas(Math.round(ha / 100).toString())} km²`;
    const n = ha >= 30 ? Math.round(ha).toString() : ha >= 1 ? ha.toFixed(1) : ha.toFixed(2);
    return `${commas(n)} ha`;
}
