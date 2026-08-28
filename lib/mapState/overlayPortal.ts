// overlayPortal — move a node out of a clipped/scaled/low-z ancestor (a scrolled
// popover card, a transformed row) so full-screen overlays float free at top
// z-index and full size.
//
// Target: the dt-web phone frame (`.mobile-preview-frame`) when it exists, else
// <body>. The frame has `contain: layout`, so a portalled overlay's
// `position: fixed; inset: 0` resolves to the FRAME — the overlay stays inside
// the fake phone instead of escaping to the desktop viewport. On a real phone
// (and narrow dt-web) there is no frame and <body> IS the viewport, so the two
// targets are the same geometry.
export function overlayPortal(node: HTMLElement) {
	const host =
		document.querySelector<HTMLElement>(".mobile-preview-frame") ??
		document.body;
	host.appendChild(node);
	return { destroy: () => node.remove() };
}
