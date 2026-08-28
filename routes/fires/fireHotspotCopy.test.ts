/**
 * fireHotspotCopy.test.ts — the words are the product here.
 *
 * The editorial rule these pin: **facts, not disclaimers.** An earlier version
 * hedged ("not a confirmed fire", "may be a false reading", "industrial sites
 * and flares all show up here") and it was cut — a screen that spends more words
 * apologising for its data than reporting it teaches people to distrust the
 * layer. So the tests assert the card reports the measurement and does NOT
 * editorialise.
 */
import { describe, expect, it } from "vitest";
import {
	areaLabel,
	bearingLabel,
	buildClusterCard,
	buildHotspotCard,
	CELL_KM,
	clusterAreaKm2,
	distanceLine,
	footprintLine,
	intensityLabel,
	intensityOf,
	kmApart,
	pingAgo,
	seenLabel,
} from "./fireHotspotCopy";
import { CELL_DEG } from "./masks/staticHeatSources";

const VANCOUVER: [number, number] = [-123.1, 49.28];
const KAMLOOPS: [number, number] = [-120.33, 50.67];
const NOW = Date.UTC(2026, 7, 8, 12, 0);

describe("intensity — the 'how big is this' number", () => {
	it("bands FRP from low to extreme", () => {
		expect(intensityOf(2)).toBe("low");
		expect(intensityOf(25)).toBe("moderate");
		expect(intensityOf(120)).toBe("high");
		expect(intensityOf(900)).toBe("extreme");
	});

	it("treats a garbage FRP as LOW, never as an emergency", () => {
		expect(intensityOf(Number.NaN)).toBe("low");
	});

	it("states the heat plainly, with no speculation about the cause", () => {
		// "often industrial or a small burn" used to live here. Guessing at cause
		// belongs to static-source flagging, not to a word in the label.
		expect(intensityLabel(3)).toBe("Low heat");
		expect(intensityLabel(900)).toBe("Very high heat");
		for (const frp of [1, 30, 120, 5000]) {
			expect(intensityLabel(frp).toLowerCase()).not.toContain("industrial");
		}
	});
});

describe("distance + bearing — 'is it coming for me?'", () => {
	it("measures a real distance", () => {
		const km = kmApart(VANCOUVER, KAMLOOPS);
		expect(km).toBeGreaterThan(230);
		expect(km).toBeLessThan(270);
	});

	it("names a compass direction, not degrees", () => {
		expect(bearingLabel(VANCOUVER, KAMLOOPS)).toBe("NE");
	});

	it("reads as a sentence a person can act on", () => {
		expect(distanceLine(KAMLOOPS, VANCOUVER)).toMatch(/^\d+ km NE of you$/);
	});

	it("never claims sub-km precision — the pixel is bigger than that", () => {
		const nearby: [number, number] = [-123.094, 49.284];
		expect(distanceLine(nearby, VANCOUVER)).toBe("Less than 1 km NE of you");
	});

	it("omits the line with no fix rather than inventing one", () => {
		expect(distanceLine(KAMLOOPS, null)).toBeNull();
	});
});

describe("seen — when the SATELLITE saw it", () => {
	it("counts minutes, then hours — and NEVER days", () => {
		// The day rounding is gone: see "age is reported in HOURS" below for why.
		expect(seenLabel(NOW - 30 * 60_000, NOW)).toBe("Seen 30 min ago");
		expect(seenLabel(NOW - 3 * 3_600_000, NOW)).toBe("Seen 3h ago");
		expect(seenLabel(NOW - 26 * 3_600_000, NOW)).toBe("Seen 26.0h ago");
		expect(seenLabel(NOW - 72 * 3_600_000, NOW)).toBe("Seen 72.0h ago");
	});

	it("never shows a negative age from clock skew", () => {
		expect(seenLabel(NOW + 60_000, NOW)).toBe("Seen 0 min ago");
	});
});

describe("footprint — a fact, not a caveat", () => {
	it("states the pixel size with no lecture attached", () => {
		expect(footprintLine(0.4)).toBe("Covers 400 m");
		// The old "— the heat is somewhere inside, not the whole area" is gone.
		expect(footprintLine(0.4)).not.toContain("not the whole");
	});

	it("falls back to VIIRS's nominal 375 m when the feed omits it", () => {
		expect(footprintLine(undefined)).toBe("Covers 375 m");
	});
});

describe("cluster area — one patch of ground counts ONCE", () => {
	// The bug: this used to sum every detection's footprint, so the same ground
	// was counted once per satellite per overpass. A card read "Size — 239 km²"
	// for a fire that was really ~95. Measured on the real cluster:
	//   1,228 detections → naive 373 km² → 673 unique cells → 94.6 km² (3.9×)

	/** A coordinate n cells east of a base point — guaranteed distinct cells. */
	const cellsEast = (n: number, px?: number) =>
		Array.from({ length: n }, (_, i) => ({
			coordinates: [-121 + i * 0.004, 50] as [number, number],
			...(px === undefined ? {} : { px }),
		}));

	it("sums genuinely DIFFERENT ground", () => {
		// Four distinct cells = 4 × 0.375² = 0.5625 km² (56 ha).
		expect(clusterAreaKm2(cellsEast(4, 0.5))).toBeCloseTo(4 * 0.140625, 6);
	});

	it("counts a CELL of ground, not the pixel's footprint", () => {
		// Measured on a live cluster: px runs 0.4–0.7 km while cells sit 0.375 km
		// apart, so neighbouring pixels overlap. Summing px² gave 280 km² for 712
		// cells whose distinct ground is ~100 km². The cell is the unit; extra
		// evidence about a cell doesn't make the cell bigger.
		const wide = [{ coordinates: [-121, 50] as [number, number], px: 0.7 }];
		expect(clusterAreaKm2(wide)).toBeCloseTo(0.140625, 6);
	});

	it("counts the SAME ground once, however many times it was seen", () => {
		// THE BUG, as a test. Four detections at one coordinate is one cell.
		const same = Array.from({ length: 4 }, () => ({
			coordinates: [-121, 50] as [number, number],
			px: 0.5,
		}));
		expect(clusterAreaKm2(same)).toBeCloseTo(0.140625, 6);
	});

	it("collapses three satellites × eight passes over one patch", () => {
		// The realistic shape: 24 looks at the same 3 cells. Naive summing would
		// report 24 × 0.1406 = 3.4 km²; the truth is 3 × 0.1406 = 0.42.
		const patch = [];
		for (let pass = 0; pass < 8; pass++) {
			for (let sat = 0; sat < 3; sat++) {
				for (let cell = 0; cell < 3; cell++) {
					patch.push({
						coordinates: [-121 + cell * 0.004, 50] as [number, number],
					});
				}
			}
		}
		expect(patch).toHaveLength(72);
		expect(clusterAreaKm2(patch)).toBeCloseTo(3 * 0.140625, 6);
	});

	it("reproduces the MEASURED cluster: 673 cells → ~95 km²", () => {
		// The live-FIRMS ground truth for the fire in the screenshot, with each
		// cell seen twice so the dedupe is doing real work.
		const cells = [];
		for (let i = 0; i < 673; i++) {
			const c = [-121 + (i % 30) * 0.004, 50 + Math.floor(i / 30) * 0.004] as [
				number,
				number,
			];
			cells.push({ coordinates: c }, { coordinates: c });
		}
		expect(cells).toHaveLength(1346);
		const km2 = clusterAreaKm2(cells);
		expect(km2).toBeCloseTo(673 * 0.140625, 1);
		expect(areaLabel(km2)).toBe("9,464 ha");
	});

	it("is NOT the area BETWEEN the dots", () => {
		// The opposite error, and a worse one: a hull round six markers measured
		// 22,328 ha of mostly unburnt hillside. Four detections at the corners of
		// a ~44 km box are four pixels of fire, not 1,900 km² of it.
		const corners = [
			{ coordinates: [-121, 50] as [number, number] },
			{ coordinates: [-120.4, 50] as [number, number] },
			{ coordinates: [-121, 50.4] as [number, number] },
			{ coordinates: [-120.4, 50.4] as [number, number] },
		];
		expect(clusterAreaKm2(corners)).toBeCloseTo(4 * 0.140625, 6);
	});

	it("is independent of detection ORDER and of pixel size", () => {
		const at = (px: number) => ({
			coordinates: [-121, 50] as [number, number],
			px,
		});
		expect(clusterAreaKm2([at(0.375), at(0.75)])).toBeCloseTo(0.140625, 6);
		expect(clusterAreaKm2([at(0.75), at(0.375)])).toBeCloseTo(0.140625, 6);
	});

	it("the grid cell and the nominal pixel agree within 15%", () => {
		// CELL_DEG is chosen to approximate one VIIRS pixel. If they ever diverge
		// the reported area stops meaning "pixels of ground burning".
		const fromDegrees = CELL_DEG * 111.32;
		expect(Math.abs(CELL_KM - fromDegrees) / fromDegrees).toBeLessThan(0.15);
	});

	it("uses the nominal pixel when px is missing", () => {
		expect(clusterAreaKm2([{ coordinates: [-121, 50] }])).toBeCloseTo(
			0.140625,
			5,
		);
	});

	it("keeps an ungriddable detection rather than dropping its area", () => {
		// Malformed input only. Under-reporting burned ground is the worse
		// failure, so it counts once standalone.
		expect(clusterAreaKm2([{ px: 0.5 }])).toBeCloseTo(0.25, 6);
	});

	it("is zero for no detections", () => {
		expect(clusterAreaKm2([])).toBe(0);
	});
});

describe("areaLabel — hectares, the unit the job speaks", () => {
	it("reports hectares, never km²", () => {
		expect(areaLabel(0.140625)).toBe("14 ha"); // one VIIRS pixel = 14.06 ha
		expect(areaLabel(2.08)).toBe("208 ha");
		expect(areaLabel(94.6)).toBe("9,460 ha");
	});

	it("shows one decimal under 10 ha and whole hectares above", () => {
		expect(areaLabel(0.042)).toBe("4.2 ha");
		expect(areaLabel(0.1)).toBe("10 ha");
	});

	it("falls to m² for a sliver, and NEVER prints zero", () => {
		// A detection with area is not zero area. 1 km² = 1,000,000 m².
		expect(areaLabel(0.0005)).toBe("500 m²");
		expect(areaLabel(0.0000005)).toBe("1 m²"); // floored, not rounded to 0
	});

	it("matches the app's own formatArea rules", () => {
		// mapDrawUtils.formatArea renders "22,328 ha" on the user's drawn
		// polygons. A fire and a block must be described the same way. It is
		// MIRRORED not imported (that module pulls in turf; this one is pure), so
		// this test is what stops the duplication rotting.
		const formatArea = (sqMetres: number): string => {
			const ha = sqMetres / 10000;
			if (ha < 0.1) return `${Math.round(sqMetres).toLocaleString()} m²`;
			if (ha < 10) return `${ha.toFixed(1)} ha`;
			return `${Math.round(ha).toLocaleString()} ha`;
		};
		for (const km2 of [0.0000005, 0.042, 0.1, 0.140625, 2.08, 94.6, 223.28]) {
			expect(areaLabel(km2)).toBe(formatArea(km2 * 1_000_000));
		}
	});
});

/** Row lookup by label — the tests read like the card does. */
const val = (
	c: { rows: readonly { label: string; value: string }[] },
	label: string,
) => c.rows.find((r) => r.label === label)?.value;
const labels = (c: { rows: readonly { label: string }[] }) =>
	c.rows.map((r) => r.label);

describe("buildHotspotCard — labelled rows, not sentences", () => {
	const card = buildHotspotCard(
		{ coordinates: KAMLOOPS, t: NOW - 21 * 3_600_000, frp: 33, px: 0.375 },
		VANCOUVER,
		NOW,
		"46 km W of Merritt · 100 km NNE of Chilliwack",
	);

	it("is titled 'Fire detected'", () => {
		expect(card.title).toBe("Fire detected");
	});

	it("leads with Intensity as 'N of 5' and exposes the level for a meter", () => {
		expect(card.rows[0].label).toBe("Intensity");
		expect(card.rows[0].value).toMatch(/^[1-5] of 5$/);
		expect(card.rows[0].level).toBeGreaterThanOrEqual(1);
		expect(card.rows[0].level).toBeLessThanOrEqual(5);
	});

	it("orders the rows most-urgent first", () => {
		expect(labels(card)).toEqual([
			"Intensity",
			"Status",
			"Size",
			"First detected",
			"Nearest",
			"From you",
		]);
	});

	it("does not repeat the label inside the value", () => {
		// "Last seen — Seen 9h ago" and "From you — 146 km NE of you" both say it
		// twice. The label already did that work.
		expect(val(card, "First detected")).toBe("21.0h ago");
		expect(val(card, "From you")).toMatch(/^\d+ km NE$/);
		expect(val(card, "First detected")).not.toContain("Seen");
		expect(val(card, "From you")).not.toContain("of you");
	});

	it("carries the place reference verbatim", () => {
		expect(val(card, "Nearest")).toBe(
			"46 km W of Merritt · 100 km NNE of Chilliwack",
		);
	});

	it("OMITS rows it cannot fill, rather than faking them", () => {
		const bare = buildHotspotCard(
			{ coordinates: KAMLOOPS, t: NOW, frp: 1 },
			null,
			NOW,
		);
		expect(labels(bare)).not.toContain("From you");
		expect(labels(bare)).not.toContain("Nearest");
		// The rows that are always knowable survive.
		expect(labels(bare)).toEqual([
			"Intensity",
			"Status",
			"Size",
			"First detected",
		]);
	});

	it("carries no units to decode, no disclaimer, no agency link", () => {
		const all = card.rows.map((r) => `${r.label} ${r.value}`).join(" ");
		expect(all).not.toContain("MW");
		expect(all.toLowerCase()).not.toContain("confidence");
		expect(all.toLowerCase()).not.toContain("not a confirmed");
		expect(card).not.toHaveProperty("agency");
	});

	it("a single detection claims no trend — it has one pass by definition", () => {
		expect(val(card, "Status")).toBe("Newly spotted");
	});
});

describe("buildClusterCard — same shape, plus the spot count", () => {
	const many = Array.from({ length: 20 }, (_, i) => ({
		coordinates: [-120.3 + i * 0.01, 50.6] as [number, number],
		t: NOW - 6 * 3_600_000,
		frp: 5,
		px: 0.375,
	}));
	const withOneBig = [
		...many,
		{
			coordinates: [-120.1, 50.6] as [number, number],
			t: NOW - 2 * 3_600_000,
			frp: 400,
			px: 0.375,
		},
	];
	const card = buildClusterCard(withOneBig, KAMLOOPS, VANCOUVER, NOW);

	it("looks like a single detection's card — the reader sees ONE fire", () => {
		// Whether a marker is one pixel or two thousand is our plumbing.
		expect(card.title).toBe("Fire detected");
		expect(labels(card).slice(0, 3)).toEqual(["Intensity", "Status", "Size"]);
	});

	it("adds a 'Hot spots' row right after Size, where it gives area meaning", () => {
		expect(labels(card)).toEqual([
			"Intensity",
			"Status",
			"Size",
			"Hot spots",
			// ONE detection row. "Last detected" was removed: it only parsed for a
			// reader holding the difference between a satellite observing fire and
			// our feed refreshing, which is not a thing to expect of someone
			// worried about a fire.
			"First detected",
			"From you",
		]);
		expect(val(card, "Hot spots")).toBe("21 detected");
	});

	it("uses the PEAK heat, never a sum — 21 small fires are not an inferno", () => {
		// max 400 MW over ~3 km² → level 4. The sum (500) would inflate it.
		expect(val(card, "Intensity")).toBe("4 of 5");
	});

	it("a cluster of only mild fires stays mild", () => {
		const mild = buildClusterCard(many, KAMLOOPS, VANCOUVER, NOW);
		expect(val(mild, "Intensity")).toBe("2 of 5");
	});

	it("reports the EARLIEST sighting — 'how long has this been burning?'", () => {
		// Was "most recent". The card now leads with when the fire STARTED: the
		// last-sighting row was removed because it could only be read correctly by
		// someone holding the difference between a satellite observing fire and
		// our feed refreshing. `Last updated` answers "how current is this screen".
		expect(val(card, "First detected")).toBe("6h ago");
	});

	it("reports a short status, not a sentence", () => {
		// The label says "Status"; repeating "since last pass" in the value is
		// saying it twice. Needs 3+ passes now — two samples of a signal that
		// swings 0.20–3.43× between overpasses is noise, not a trend.
		const rising = [
			{ coordinates: KAMLOOPS, t: NOW - 18 * 3_600_000, frp: 20, px: 0.375 },
			{ coordinates: KAMLOOPS, t: NOW - 12 * 3_600_000, frp: 20, px: 0.375 },
			{ coordinates: KAMLOOPS, t: NOW - 6 * 3_600_000, frp: 300, px: 0.375 },
			{ coordinates: KAMLOOPS, t: NOW, frp: 300, px: 0.375 },
		];
		const c = buildClusterCard(rising, KAMLOOPS, VANCOUVER, NOW);
		expect(val(c, "Status")).toBe("Growing");
		expect(val(c, "Status")).not.toContain("last pass");
	});

	it("says 'Dying down' when the heat is falling", () => {
		// A SUSTAINED decline across four passes — not one low reading, which
		// would be cloud or swath angle rather than the fire going out.
		const fading = [
			{ coordinates: KAMLOOPS, t: NOW - 18 * 3_600_000, frp: 300, px: 0.375 },
			{ coordinates: KAMLOOPS, t: NOW - 12 * 3_600_000, frp: 280, px: 0.375 },
			{ coordinates: KAMLOOPS, t: NOW - 6 * 3_600_000, frp: 30, px: 0.375 },
			{ coordinates: KAMLOOPS, t: NOW, frp: 20, px: 0.375 },
		];
		expect(
			val(buildClusterCard(fading, KAMLOOPS, VANCOUVER, NOW), "Status"),
		).toBe("Dying down");
	});

	it("handles a single-member cluster", () => {
		const one = buildClusterCard([many[0]], KAMLOOPS, VANCOUVER, NOW);
		expect(val(one, "Hot spots")).toBe("1 detected");
	});

	it("never asks 'hottest WHAT?'", () => {
		const all = card.rows
			.map((r) => `${r.label} ${r.value}`)
			.join(" ")
			.toLowerCase();
		expect(all).not.toContain("hottest");
		expect(all).not.toContain("cluster");
		expect(all).not.toContain("peak");
	});
});

/**
 * ⛔ ONE CLOCK. The card briefly carried `Last seen` AND `Checked` (when we last
 * downloaded the file), and the pair read as a contradiction the moment they
 * disagreed — "Last seen 22h ago / Checked 20h ago" invites the obvious "how
 * could you SEE it if you hadn't CHECKED?".
 *
 * They were never the same kind of fact: one is per-FIRE, the other per-FILE.
 * No two-word label can carry that, so the second clock is GONE and the
 * remaining one uses a verb the satellite owns.
 */
describe("the time row — one clock, in the satellite's own verb", () => {
	const hot = {
		coordinates: KAMLOOPS,
		t: NOW - 9 * 3_600_000,
		frp: 40,
		px: 0.375,
	};
	const val = (
		c: { rows: readonly { label: string; value: string }[] },
		l: string,
	) => c.rows.find((r) => r.label === l)?.value;

	it("says 'First detected', not 'Last seen'", () => {
		// "Seen" begs "seen by whom?"; "detected" is something a sensor does, so
		// nobody asks why it differs from when the app last looked.
		const card = buildHotspotCard(hot, VANCOUVER, NOW);
		expect(val(card, "First detected")).toBe("9h ago");
		expect(card.rows.some((r) => r.label === "Last seen")).toBe(false);
	});

	it("carries NO second clock — no download-age row of any name", () => {
		// The row that caused the contradiction. Any of these names reintroduces it.
		const card = buildHotspotCard(hot, VANCOUVER, NOW);
		const labels = card.rows.map((r) => r.label);
		for (const banned of [
			"Checked",
			"Updated",
			"Fetched",
			"Downloaded",
			"As of",
		]) {
			expect(labels).not.toContain(banned);
		}
	});

	it("holds for the CLUSTER card too — both cards or neither", () => {
		const many = [
			hot,
			{ coordinates: KAMLOOPS, t: NOW - 3 * 3_600_000, frp: 90, px: 0.375 },
		];
		const card = buildClusterCard(many, KAMLOOPS, VANCOUVER, NOW);
		expect(val(card, "First detected")).toBe("9h ago");
		expect(card.rows.some((r) => r.label === "Checked")).toBe(false);
		expect(card.rows.some((r) => r.label === "Last detected")).toBe(false);
	});

	it("never shows two time rows at once", () => {
		// Structural guard: exactly ONE row whose value is an age.
		const card = buildClusterCard([hot], KAMLOOPS, VANCOUVER, NOW);
		const ageRows = card.rows.filter((r) => /ago|Just now/.test(r.value));
		expect(ageRows).toHaveLength(1);
	});
});

/**
 * ⛔ HOURS, NEVER DAYS.
 *
 * "1 day ago" collapsed 23 h, 28 h and 47 h into one useless phrase, on the row
 * a person reads while deciding whether to drive toward a fire. It also read as
 * indifference — *"stop saying one day, it's infuriating"* — because a screen
 * counting in days, about a fire, looks like a screen that is not trying.
 *
 * FIRMS ships two calendar days, so the feed spans ~37 h and hours never grow
 * unwieldy. Measured live: the oldest detection in a real response was 37.1 h.
 */
describe("age is reported in HOURS, never rounded to days", () => {
	const NOW2 = Date.UTC(2026, 7, 9, 12, 0);
	const hAgo = (h: number) => NOW2 - h * 3_600_000;

	it("never emits the word 'day'", () => {
		for (const h of [23, 24, 25, 28, 36, 37, 47, 72]) {
			expect(seenLabel(hAgo(h), NOW2)).not.toMatch(/day/);
		}
	});

	it("keeps the exact hour past the 24 h line", () => {
		// These three used to be indistinguishable — all "1 day ago".
		expect(seenLabel(hAgo(23), NOW2)).toBe("Seen 23.0h ago");
		expect(seenLabel(hAgo(28), NOW2)).toBe("Seen 28.0h ago");
		expect(seenLabel(hAgo(36), NOW2)).toBe("Seen 36.0h ago");
	});

	it("still uses minutes under an hour — the fresh end keeps its resolution", () => {
		expect(seenLabel(NOW2 - 42 * 60_000, NOW2)).toBe("Seen 42 min ago");
	});

	it("the card row carries it through", () => {
		const card = buildHotspotCard(
			{ coordinates: KAMLOOPS, t: hAgo(28), frp: 20, px: 0.375 },
			VANCOUVER,
			NOW2,
		);
		const v = card.rows.find((r) => r.label === "First detected")?.value;
		expect(v).toBe("28.0h ago");
	});
});

/**
 * FIRST + LAST — the two rows FIRMS' own table shows for a fire, and the only
 * momentum fact the feed can honestly support.
 *
 * NASA's site, for the Harrison fire, shows exactly:
 *     2026-08-08 13:42  D  FRP 2.95   ← first
 *     2026-08-09 03:36  N  FRP 0.24   ← last
 * The GAP is the information: burning ~14 h, not a one-off flare.
 */
describe("First detected — when it started burning", () => {
	const NOW3 = Date.UTC(2026, 7, 9, 12, 0);
	const hAgo = (h: number) => NOW3 - h * 3_600_000;
	const val = (
		c: { rows: readonly { label: string; value: string }[] },
		l: string,
	) => c.rows.find((r) => r.label === l)?.value;

	it("shows BOTH ends for a cluster seen across passes", () => {
		const card = buildClusterCard(
			[
				{ coordinates: KAMLOOPS, t: hAgo(22.3), frp: 2.95, px: 0.375 },
				{ coordinates: KAMLOOPS, t: hAgo(8.4), frp: 0.24, px: 0.375 },
			],
			KAMLOOPS,
			VANCOUVER,
			NOW3,
		);
		expect(val(card, "First detected")).toBe("22.3h ago");
		expect(card.rows.some((r) => r.label === "Last detected")).toBe(false);
	});

	it("a lone detection still reports WHEN, under First detected", () => {
		// One sighting means first and last are the same instant, so the single
		// row simply carries it — never an omitted time.
		const card = buildHotspotCard(
			{ coordinates: KAMLOOPS, t: hAgo(11), frp: 20, px: 0.375 },
			VANCOUVER,
			NOW3,
		);
		expect(val(card, "First detected")).toBe("11.0h ago");
	});

	it("uses FRACTIONS past 10h — a measurement, not a shrug", () => {
		// "24h ago" reads as a round-number brush-off; NASA stamps to the minute,
		// so the precision is real.
		expect(seenLabel(hAgo(23.7), NOW3)).toBe("Seen 23.7h ago");
		expect(seenLabel(hAgo(35.4), NOW3)).toBe("Seen 35.4h ago");
	});

	it("stays whole under 10h — no false precision on fresh data", () => {
		expect(seenLabel(hAgo(3), NOW3)).toBe("Seen 3h ago");
	});
});

/**
 * ⛔ "Last checked" — WHEN WE LAST PINGED NASA.
 *
 * This was asked for four separate times before it was built, in increasingly
 * plain terms: *"when did we last see it on the NASA site?"*, *"when did it get
 * pinged?"*, *"we're just curious people"*. The answer kept being explained
 * instead of shipped.
 *
 * THREE rows, three different facts, and the verbs keep them apart:
 *   First detected — NASA saw fire (earliest)
 *   (Last detected was REMOVED — see fireHotspotCopy.ts)
 *   Last checked   — WE last asked NASA
 *
 * An earlier attempt called this `Checked` and sat it under `Last seen`; with no
 * actor and the same verb it read as a contradiction and was rightly killed.
 * "Detected" vs "updated" is what makes the pair legible.
 */
describe("Last checked — our ping, not NASA's sighting", () => {
	const NOW4 = Date.UTC(2026, 7, 9, 12, 0);
	const mAgo = (m: number) => NOW4 - m * 60_000;
	const hAgo4 = (h: number) => NOW4 - h * 3_600_000;
	const val = (
		c: { rows: readonly { label: string; value: string }[] },
		l: string,
	) => c.rows.find((r) => r.label === l)?.value;

	it("keeps MINUTE resolution — the number people are actually curious about", () => {
		expect(pingAgo(mAgo(4), NOW4)).toBe("4 min ago");
		expect(pingAgo(mAgo(42), NOW4)).toBe("42 min ago");
	});

	it("says 'Just now' under a minute, never '0 min ago'", () => {
		expect(pingAgo(NOW4, NOW4)).toBe("Just now");
	});

	it("goes fractional past 10h — for someone who has been offline", () => {
		// The offline planter's case: the honest answer may be large, and a round
		// number would read as a shrug.
		expect(pingAgo(hAgo4(23.7), NOW4)).toBe("23.7h ago");
	});

	it("appears BELOW the detections, as its own fact", () => {
		const card = buildClusterCard(
			[
				{ coordinates: KAMLOOPS, t: hAgo4(22.3), frp: 3, px: 0.375 },
				{ coordinates: KAMLOOPS, t: hAgo4(8.4), frp: 0.2, px: 0.375 },
			],
			KAMLOOPS,
			VANCOUVER,
			NOW4,
			null,
			false,
			mAgo(4),
		);
		const labels = card.rows.map((r) => r.label);
		expect(labels).toContain("Last checked");
		expect(labels.indexOf("Last checked")).toBeGreaterThan(
			labels.indexOf("First detected"),
		);
		expect(val(card, "Last checked")).toBe("4 min ago");
	});

	it("is DISTINCT from the detection rows — three facts, three verbs", () => {
		const card = buildHotspotCard(
			{ coordinates: KAMLOOPS, t: hAgo4(23), frp: 20, px: 0.375 },
			VANCOUVER,
			NOW4,
			null,
			false,
			mAgo(5),
		);
		// The whole point: NASA saw it 23h ago, we refreshed 5 min ago.
		expect(val(card, "First detected")).toBe("23.0h ago");
		expect(val(card, "Last checked")).toBe("5 min ago");
	});

	it("is OMITTED, never faked, when unknown", () => {
		const card = buildHotspotCard(
			{ coordinates: KAMLOOPS, t: hAgo4(3), frp: 20, px: 0.375 },
			VANCOUVER,
			NOW4,
		);
		expect(card.rows.some((r) => r.label === "Last checked")).toBe(false);
	});
});
