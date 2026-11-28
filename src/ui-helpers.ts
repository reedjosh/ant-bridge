import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

/** Format a byte count for compact UI display. */
export function humanBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export interface ListBrowserOptions<T> {
	title: string;
	warning?: string;
	items: SelectItem[];
	footerHint: string;
	width: number;
	onSelect: (item: SelectItem) => T;
	onRescan: () => T;
	onCancel: () => T;
}

/** Render an interactive SelectList overlay framed by DynamicBorder. */
export async function showListBrowser<T>(
	ui: ExtensionUIContext,
	opts: ListBrowserOptions<T>,
): Promise<T> {
	return ui.custom<T>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(opts.title)), 1, 0));
			if (opts.warning) {
				container.addChild(new Text(theme.fg("warning", opts.warning), 1, 0));
			}
			container.addChild(new Spacer(1));

			const list = new SelectList(opts.items, Math.min(opts.items.length, 12), {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(opts.onSelect(item));
			list.onCancel = () => done(opts.onCancel());
			container.addChild(list);

			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", opts.footerHint), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (data.trim().toLowerCase() === "r") {
						done(opts.onRescan());
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center" as const, width: opts.width, maxHeight: "85%" as const, margin: 1 },
			blocked: dialogBlocked(opts.title),
		},
	);
}

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
