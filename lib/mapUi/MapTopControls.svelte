<!--
    MapTopControls — the top-right control stack shared by BOTH map routes
    (/mobile/map and /mobile/offlinev4): the eye (map-only toggle) on top, the
    crow (online/offline switch) directly below it.

    Single source of truth so the two routes can never diverge. The eye owns
    map-only mode (hides the top/bottom nav via body.map-only). The crow's
    destination is the caller's — pass crowMode + onCrowToggle.
-->
<script lang="ts">
import CrowSwitch from "./CrowSwitch.svelte";
import {
    assetFacts,
    framePath,
} from "$lib/mobile/animation/registry_anime/sceneRegistry";

let {
    mapOnly = $bindable(false),
    crowMode,
    onCrowToggle,
}: {
    mapOnly?: boolean;
    crowMode: "online" | "offline";
    onCrowToggle: () => void;
} = $props();

// Eye animation: two frame sequences at 20fps.
//   eye_OPEN  plays when toggling on  (closed → open, ends on open)
//   eye_CLOSE plays when toggling off (open → closed, ends on closed)
// Frame counts + rate come from THE REGISTRY — eyeBlink.svelte.ts plays the
// same two folders (faster) and must not carry a second copy of these numbers.
const EYE_OPEN_FRAMES = assetFacts("eye_OPEN_20fps").frameCount;
const EYE_CLOSE_FRAMES = assetFacts("eye_CLOSE_20fps").frameCount;
const EYE_FRAME_MS = 1000 / assetFacts("eye_OPEN_20fps").fps; // 20fps → 50ms
let eyePlaying = $state<"open" | "close" | null>(null);
let eyeFrame = $state(1);
let eyeTimer: ReturnType<typeof setInterval> | null = null;
let navTimer: ReturnType<typeof setTimeout> | null = null;

function playEye(dir: "open" | "close") {
    if (eyeTimer) clearInterval(eyeTimer);
    eyePlaying = dir;
    eyeFrame = 1;
    const last = dir === "open" ? EYE_OPEN_FRAMES : EYE_CLOSE_FRAMES;
    eyeTimer = setInterval(() => {
        if (eyeFrame >= last) {
            if (eyeTimer) clearInterval(eyeTimer);
            eyeTimer = null;
            eyePlaying = null;
            return;
        }
        eyeFrame += 1;
    }, EYE_FRAME_MS);
}

function toggleEye() {
    const next = !mapOnly;
    mapOnly = next;
    playEye(next ? "open" : "close");
    // Choreograph the nav bar slide with the eye frame sequence.
    if (navTimer) clearTimeout(navTimer);
    const delay = next ? 150 : 200;
    navTimer = setTimeout(() => {
        document.body.classList.toggle("map-only", next);
        navTimer = null;
    }, delay);
}

const eyeSrc = $derived.by(() => {
    if (eyePlaying === "open") return framePath("eye_OPEN_20fps", eyeFrame);
    if (eyePlaying === "close") return framePath("eye_CLOSE_20fps", eyeFrame);
    return mapOnly
        ? framePath("eye_OPEN_20fps", EYE_OPEN_FRAMES)
        : framePath("eye_CLOSE_20fps", EYE_CLOSE_FRAMES);
});

// Measure the top bar at runtime → --top-bar-h so the stack anchors to its
// actual bottom edge regardless of nav height.
$effect(() => {
    if (typeof document === "undefined") return;
    const topBar = document.querySelector<HTMLElement>(".mobile-nav");
    if (!topBar) return;
    const setVar = () => {
        document.documentElement.style.setProperty(
            "--top-bar-h",
            `${topBar.offsetHeight}px`,
        );
    };
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(topBar);
    return () => {
        ro.disconnect();
        document.documentElement.style.removeProperty("--top-bar-h");
    };
});

// Cleanup body.map-only on unmount.
$effect(() => {
    if (typeof document === "undefined") return;
    return () => {
        document.body.classList.remove("map-only");
        if (navTimer) clearTimeout(navTimer);
    };
});
</script>

<div class="below-top-bar">
    <button
        class="eye-toggle"
        class:eye-toggle-open={mapOnly}
        onclick={toggleEye}
        aria-label={mapOnly ? "Show tools" : "Hide everything but the map"}
        aria-pressed={mapOnly}
    >
        <img class="eye-frame" src={eyeSrc} alt="" />
    </button>

    <!-- Crow stacked directly below the eye, same box so the centered art
         lines up on the eye's axis. -->
    <div class="crow-slot">
        <CrowSwitch mode={crowMode} onToggle={onCrowToggle} />
    </div>
</div>

<style>
/* Layer that starts BELOW the top bar (--top-bar-h is measured at runtime),
   so children use plain top/right offsets like any normal element. */
.below-top-bar {
    position: absolute;
    top: var(--top-bar-h, 4rem);
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 40;
}

.eye-toggle {
    position: absolute;
    top: 4px;
    right: 14px;
    pointer-events: auto;
    /* Frame aspect: 400×337 ≈ 1.187. */
    width: 74px;
    height: 62px;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.6));
    transition: transform 120ms ease;
}
.eye-toggle:active {
    transform: scale(0.92);
}
.eye-frame {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
}

/* Crow: same 74px box as the eye, right-aligned beneath it. The square crow
   art is centered by object-fit, so it lands on the eye's vertical axis and
   gets ~6px breathing room from the right edge. */
.crow-slot {
    position: absolute;
    top: 80px;
    right: 14px;
    pointer-events: none;
}

/* Map-only mode: slide the nav bars off-screen. Global so it works on every
   route that mounts these controls (online + offline maps). */
:global(.mobile-nav),
:global(.bottom-nav) {
    transition: transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 220ms ease;
    will-change: transform, opacity;
}
:global(body.map-only .mobile-nav) {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
}
:global(body.map-only .bottom-nav) {
    transform: translateY(100%);
    opacity: 0;
    pointer-events: none;
}
</style>
