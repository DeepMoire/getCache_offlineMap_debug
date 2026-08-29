import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";

/** Prompt + raise the bar every this-many downloaded bytes (on cellular). */
const THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB

let sessionBytes = 0;
let nextThresholdBytes = THRESHOLD_BYTES;
let perFeatureOnly = false;

/** promptFn: shows the Continue / per-feature modal; null → gate never blocks. */
let promptFn: (() => Promise<"continue" | "per-feature">) | null = null;

export function registerDownloadPrompt(
	fn: (() => Promise<"continue" | "per-feature">) | null,
): void {
	promptFn = fn;
}

/** True once the user chose "per feature only" this session; resets on app restart. */
export function isPerFeatureOnly(): boolean {
	return perFeatureOnly;
}

/** Tally bytes the reconcile actually downloaded (pack tiles + satellite photo). */
export function noteDownloadedBytes(n: number): void {
	if (n > 0) sessionBytes += n;
}

/** For the /blobs debug surface. */
export function offlineDownloadGateStats(): {
	sessionBytes: number;
	nextThresholdBytes: number;
	perFeatureOnly: boolean;
} {
	return { sessionBytes, nextThresholdBytes, perFeatureOnly };
}

/** Cellular = the only connection type this gate protects; WiFi/unknown/non-native are treated as unmetered and never gate. */
async function onCellular(): Promise<boolean> {
	if (!Capacitor.isNativePlatform()) return false;
	try {
		const status = await Network.getStatus();
		return status.connectionType === "cellular";
	} catch {
		return false;
	}
}

export async function checkDownloadGate(): Promise<boolean> {
	if (sessionBytes < nextThresholdBytes) return false;
	if (!(await onCellular())) {
		nextThresholdBytes = sessionBytes + THRESHOLD_BYTES;
		return false;
	}
	if (!promptFn) {
		nextThresholdBytes = sessionBytes + THRESHOLD_BYTES;
		return false;
	}
	const choice = await promptFn();
	if (choice === "per-feature") {
		perFeatureOnly = true;
		return true; // stop the bulk pass
	}
	nextThresholdBytes = sessionBytes + THRESHOLD_BYTES;
	return false;
}
