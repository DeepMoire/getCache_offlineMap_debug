# ⚠️ READ FIRST — the tree is mid-experiment (2026-08-10, late)

**4 tests fail right now. All four are EXPECTED. None is a bug in v2.**

The working tree is holding a deliberate experiment. Nothing here is finished
work, and none of it should be committed as-is.

---

## The 4 failing tests, and why

| test | why it fails |
|---|---|
| `offlineBakeService.test.ts` → tripwire 6 (fires at snapped position) | `FIRE_REFRESH_ENABLED = false` — the fetch it asserts on is switched off |
| `offlineBakeService.test.ts` → tripwire 7 (fires keep refreshing) | same flag |
| `v4FireCache.test.ts` → "scales LINEARLY in disc count" | the `unionHotspots` fix was reverted; the test correctly reports `4.14 > 2.5` |
| `v4FireCache.test.ts` → "absorbs a realistic full cache" | same revert; correctly reports **1,065,750 > 147,000** distance calls |

The first two prove the bisect flags are live. The last two prove the v1 cost
guard works. **All four are tests doing their job.**

---

## 🔬 The three bisect flags — NOT A FIX, must come out

These disable a **hazard layer** (wildfires near planters). They exist only to
answer "is the fire layer what makes the app burn 4 GB?" — and it is.

| flag | file | set to `true` to restore v1 fires |
|---|---|---|
| `FIRE_LAYER_ENABLED` | `src/routes/mobile/offlinev4/+page.svelte` | ✅ |
| `FIRE_LAYER_ENABLED_ONLINE` | `src/routes/mobile/map/MobMapPage.svelte` | ✅ |
| `FIRE_REFRESH_ENABLED` | `src/lib/mobile/offline/onPhone/bake/bakeService.svelte.ts` | ✅ |

**All three must flip together.** The app is one process: a fire layer live on
any route keeps the whole module resident. A half-bisect proves nothing — that
cost a round trip when the first attempt disabled only offlinev4 and fires kept
painting from `/mobile/map`.

### What the bisect measured

| state | route | total JS heap |
|---|---|---|
| fires ON | offlinev4 | **~4,000 MB** → crashed |
| fires OFF | offlinev4 | **963 MB** |
| fires OFF | /mobile/map | **274 MB** (workers 341 MB → 12.6 MB) |

---

## The reverted v1 CPU fix

`unionHotspots` in `v4FireCache.ts` had a genuine O(n³) bug — three nested loops
calling `kmBetween` per (detection × newer disc). Fixing it took CPU from 119%
to 3.4%, but **memory stayed high**, so it was reverted to isolate the memory
question.

- The fix is preserved at:
  `/private/tmp/claude-501/-Users-chrisharris-DEV-fetch-ReTreever/235b5398-18df-4aaf-a638-0eaeb3c3992d/scratchpad/v4FireCache.MYFIX.ts`
- Its regression test **stayed in the tree on purpose** — that is why two tests
  fail, and those failures are the proof the guard bites.

If v2 lands, this is moot: v1 gets deleted entirely. If v2 stalls, restore the
fix — it is real and it is verified.

---

## Where v2 stands

Written, typechecked, **43 tests passing**. Not wired to either map. The
Worker's `?v=2` route does not exist yet, so nothing can run.

Full spec + cutover steps: `src/lib/mobile/docs/WILDFIRE_LAYER_V2.md`
