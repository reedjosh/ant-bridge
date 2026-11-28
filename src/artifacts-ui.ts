// /agy artifacts overlay: SelectList over one conversation's artifacts.
// Read-only on purpose: enter opens the selected file with the OS default
// handler, r rescans (the list is always a fresh scan), esc closes.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { AgyArtifact } from "./artifacts.js";
import { humanBytes, showListBrowser } from "./ui-helpers.js";

export type ArtifactsBrowserAction =
	| { type: "open"; artifact: AgyArtifact }
	| { type: "rescan" }
	| { type: "close" };

export function artifactItems(artifacts: AgyArtifact[]): SelectItem[] {
	return artifacts.map((a, i) => {
		const when = new Date(a.modifiedMs);
		const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
		return {
			value: String(i),
			label: a.name,
			description: `${a.kind} - ${a.mediaType} - ${humanBytes(a.bytes)} - ${stamp}`,
		};
	});
}

/** Render the overlay. Resolves with what the user asked for: open (with the
 *  selected artifact), rescan, or close. */
export async function showArtifactsBrowser(
	ctx: ExtensionUIContext,
	artifacts: AgyArtifact[],
): Promise<ArtifactsBrowserAction> {
	return showListBrowser<ArtifactsBrowserAction>(ctx, {
		title: `Antigravity artifacts (${artifacts.length})`,
		items: artifactItems(artifacts),
		footerHint: "up/down navigate - enter open - r rescan - esc close",
		width: 84,
		onSelect: (item) => ({ type: "open", artifact: artifacts[Number(item.value)] }),
		onRescan: () => ({ type: "rescan" }),
		onCancel: () => ({ type: "close" }),
	});
}
