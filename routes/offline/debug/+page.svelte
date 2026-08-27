<script lang="ts">
/**
 * /offline/debug — the offline map WITH its debug rails.
 *
 * SAME PATH AS THE MOUNTING PARENT SERVES. This view used to live at
 * /debug/map, which is the same page under a different name, and a different
 * name is the whole problem: the tier pill translates a path to its
 * counterpart, so two tiers spelling one view differently means the table has
 * to carry a mapping — and a mapping that has to be written down is a mapping
 * that can be wrong. Spelled identically on both sides, the translation is the
 * identity and there is nothing left to get wrong.
 *
 * `rails` defaults on, so this file passes nothing. Deliberately NOT a second
 * copy of the page: the engine wiring is the part that drifts, and two copies
 * of it would drift apart the first time either was touched.
 */
import Demo from "../../demo/+page.svelte";
</script>

<Demo />
