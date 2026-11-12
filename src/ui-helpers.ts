import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

/** Blocked-overlay metadata expected by Pi's `ui.custom(..., { blocked })`. */
export function dialogBlocked(title: string): { kind: "question"; message: string } {
	return { kind: "question", message: title };
}

export interface SettingsDialogOptions {
	title: string;
	subtitle?: string;
	items: SettingItem[];
	onChange: (id: string, newValue: string) => void;
}

/** Render an interactive settings overlay using Pi's built-in SettingsList. */
export async function showSettingsDialog(
	ui: ExtensionUIContext,
	opts: SettingsDialogOptions,
): Promise<void> {
	await ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(opts.title)), 1, 0));
			if (opts.subtitle) {
				container.addChild(new Text(theme.fg("muted", opts.subtitle), 1, 0));
			}
			container.addChild(new Spacer(1));

			const list = new SettingsList(
				opts.items,
				Math.min(Math.max(opts.items.length, 4), 12),
				{
					label: (text: string, selected: boolean) =>
						selected ? theme.fg("accent", theme.bold(text)) : text,
					value: (text: string, selected: boolean) =>
						selected ? theme.fg("accent", text) : theme.fg("muted", text),
					description: (text: string) => theme.fg("muted", text),
					cursor: theme.fg("accent", "> "),
					hint: (text: string) => theme.fg("dim", text),
				},
				(id, newValue) => {
					list.updateValue(id, newValue);
					opts.onChange(id, newValue);
				},
				() => done(),
				{ enableSearch: true },
			);
			container.addChild(list);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center" as const, width: 84, maxHeight: "85%" as const, margin: 1 },
			blocked: dialogBlocked(opts.title),
		},
	);
}
