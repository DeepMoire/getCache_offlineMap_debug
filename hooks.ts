import type { Reroute } from "@sveltejs/kit";

// ⚠️ keep DEFAULT in step with this child's defaultPath in retreeved/childRegistry.ts — nav and the printed url read it.
// ⚠️ list dev endpoints in SERVED — an unlisted path collapses to DEFAULT, so fetch("/api/…") gets the map page's HTML with a 200.
const SERVED: string[] = ["/api/parentGuard"];
const DEFAULT = "/offline";

export const reroute: Reroute = ({ url }) => {
	const known = [DEFAULT, ...SERVED].some((p) => url.pathname === p);
	if (!known) return DEFAULT;
};
