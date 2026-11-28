// /agy tasks overlay: SelectList over one conversation's background tasks.
// Watch-only: enter tails the selected task's log, r rescans, esc closes.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { AgyTask } from "./tasks.js";
import { humanBytes, showListBrowser } from "./ui-helpers.js";

export type TasksBrowserAction = { type: "tail"; task: AgyTask } | { type: "rescan" } | { type: "close" };

export function taskItems(tasks: AgyTask[]): SelectItem[] {
	return tasks.map((t) => {
		const when = new Date(t.modifiedMs);
		const stamp = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
		const state = t.livenessKnown ? (t.active ? "ACTIVE" : "idle") : "liveness?";
		return {
			value: String(t.id),
			label: `#${t.id} - ${state}`,
			description: `${humanBytes(t.bytes)} - last write ${stamp}`,
		};
	});
}

/** Render the overlay. Resolves tail (for the selected task), rescan (caller
 *  re-lists and reopens), or close. */
export async function showTasksBrowser(
	ctx: ExtensionUIContext,
	tasks: AgyTask[],
	livenessKnown: boolean,
): Promise<TasksBrowserAction> {
	return showListBrowser<TasksBrowserAction>(ctx, {
		title: `Antigravity tasks (${tasks.length})`,
		warning: livenessKnown
			? undefined
			: "lsof not found; liveness unknown (install lsof for ACTIVE/idle)",
		items: taskItems(tasks),
		footerHint: "up/down navigate - enter tail - r rescan - esc close",
		width: 72,
		onSelect: (item) => {
			const task = tasks.find((t) => String(t.id) === item.value);
			return task ? { type: "tail", task } : { type: "close" };
		},
		onRescan: () => ({ type: "rescan" }),
		onCancel: () => ({ type: "close" }),
	});
}
