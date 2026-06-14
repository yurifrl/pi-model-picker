/**
 * Model Picker Extension
 *
 * Categorized, keyboard-driven model selector with per-category search.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  Select Model                                   │
 *   ├─────────────────────────────────────────────────┤
 *   │◀  Anthropic │ Google │ OpenAI │ … ▶             │  ← Tab/Shift+Tab or ←→ at edges
 *   ├─────────────────────────────────────────────────┤
 *   │  Search: claude_                                │  ← type to filter this category
 *   ├─────────────────────────────────────────────────┤
 *   │▶ Claude Sonnet 4.6 ●            200k  thinking  │
 *   │  Claude Opus 4.5                200k  thinking  │
 *   ├─────────────────────────────────────────────────┤
 *   │  ↑↓ navigate · Tab/← → category · esc cancel   │
 *   └─────────────────────────────────────────────────┘
 *
 * Usage:
 *   /models          — open the categorized picker
 *   Ctrl+Shift+M     — keyboard shortcut
 *
 * Note: /model is a built-in pi command and cannot be overridden.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Input, Key, Text, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Api, Model } from "@mariozechner/pi-ai";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── list persistence ──────────────────────────────────────────────────────

const FAVORITES_CATEGORY = "★ Favorites";
const HIDDEN_CATEGORY = "◌ Hidden";
const ALL_CATEGORY = "✓ All";
const STORAGE_DIR = join(homedir(), ".pi", "extensions", "pi-model-picker");
const FAVORITES_FILE = join(STORAGE_DIR, "favorites.json");
const HIDDEN_FILE = join(STORAGE_DIR, "hidden.json");

function modelKey(m: Model<Api>): string {
	return `${m.provider}:${m.id}`;
}

function loadModelKeys(file: string): Set<string> {
	try {
		if (!existsSync(file)) return new Set();
		const raw = readFileSync(file, "utf8");
		const arr = JSON.parse(raw);
		return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function saveModelKeys(file: string, keys: Set<string>): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify([...keys], null, 2), "utf8");
	} catch {
		// best-effort persistence; ignore disk errors
	}
}

function loadFavorites(): Set<string> {
	return loadModelKeys(FAVORITES_FILE);
}

function saveFavorites(favs: Set<string>): void {
	saveModelKeys(FAVORITES_FILE, favs);
}

function loadHidden(): Set<string> {
	return loadModelKeys(HIDDEN_FILE);
}

function saveHidden(hidden: Set<string>): void {
	saveModelKeys(HIDDEN_FILE, hidden);
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Friendly display name for a provider id — derived from the id itself, no hardcoding */
function providerLabel(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Format context window as human-readable */
function fmtCtx(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

// ─── component ──────────────────────────────────────────────────────────────

interface ModelPickerOptions {
	allModels: Model<Api>[];
	currentModel: Model<Api> | undefined;
	onSelect: (model: Model<Api>) => void;
	onCancel: () => void;
}

class ModelPickerComponent {
	// Focusable — needed so the Input inside gets IME cursor positioning
	focused = false;

	private categories: string[];
	private catIndex: number;
	private rowIndex = 0;

	// per-category source models (sorted, never mutated)
	private byCategory: Map<string, Model<Api>[]>;

	// favorite model keys ("provider:id") — persisted to disk
	private favorites: Set<string>;

	// hidden model keys ("provider:id") — persisted to disk
	private hidden: Set<string>;

	// per-category search terms (reset when category changes, preserved when returning)
	private searchTerms: Map<string, string> = new Map();

	// the search Input widget
	private searchInput: Input;

	// filtered models for the current view (recomputed on query/category change)
	private filteredRows: Model<Api>[] = [];

	constructor(private opts: ModelPickerOptions) {
		this.favorites = loadFavorites();
		this.hidden = loadHidden();
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());

		// Always start on the Favorites category (index 0)
		this.catIndex = 0;

		// Build the search Input
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onEscape = () => opts.onCancel();
		this.searchInput.onSubmit = () => {
			const selected = this.filteredRows[this.rowIndex];
			if (selected) opts.onSelect(selected);
		};

		// Initialise filtered rows and pre-select current model if visible in this category
		this.applyFilter();
		const cur = this.opts.currentModel;
		if (cur) {
			const idx = this.filteredRows.findIndex(
				(m) => m.id === cur.id && m.provider === cur.provider,
			);
			if (idx >= 0) this.rowIndex = idx;
		}
	}

	// ── public Focusable propagation ─────────────────────────────────────
	set focusedState(v: boolean) {
		this.focused = v;
		this.searchInput.focused = v;
	}

	// ── category building ────────────────────────────────────────────────

	private buildCategories(): Map<string, Model<Api>[]> {
		const map = new Map<string, Model<Api>[]>();
		for (const m of this.opts.allModels) {
			if (this.hidden.has(modelKey(m))) continue;
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}

		const cur = this.opts.currentModel;

		// Sort models within each category: active first, then alphabetical
		for (const [, arr] of map) {
			arr.sort((a, b) => {
				const aCur = cur && a.id === cur.id && a.provider === cur.provider ? -1 : 0;
				const bCur = cur && b.id === cur.id && b.provider === cur.provider ? -1 : 0;
				if (aCur !== bCur) return aCur - bCur;
				return a.name.localeCompare(b.name);
			});
		}

		// Sort providers: active provider first, then alphabetical
		const providerEntries = [...map.entries()].sort(([aKey], [bKey]) => {
			const aCur = cur && aKey === cur.provider ? -1 : 0;
			const bCur = cur && bKey === cur.provider ? -1 : 0;
			if (aCur !== bCur) return aCur - bCur;
			return aKey.localeCompare(bKey);
		});

		// Favorites and Hidden are cross-provider lists pulled from saved keys
		return new Map<string, Model<Api>[]>([
			[FAVORITES_CATEGORY, this.computeFavoriteModels()],
			[HIDDEN_CATEGORY, this.computeHiddenModels()],
			...providerEntries,
			[ALL_CATEGORY, this.computeAllModels()],
		]);
	}

	private computeFavoriteModels(): Model<Api>[] {
		return this.sortModels(
			this.opts.allModels.filter(
				(m) => this.favorites.has(modelKey(m)) && !this.hidden.has(modelKey(m)),
			),
		);
	}

	private computeHiddenModels(): Model<Api>[] {
		return this.sortModels(this.opts.allModels.filter((m) => this.hidden.has(modelKey(m))));
	}

	private sortModels(models: Model<Api>[]): Model<Api>[] {
		const cur = this.opts.currentModel;
		return [...models].sort((a, b) => {
			const aCur = cur && a.id === cur.id && a.provider === cur.provider ? -1 : 0;
			const bCur = cur && b.id === cur.id && b.provider === cur.provider ? -1 : 0;
			if (aCur !== bCur) return aCur - bCur;
			return a.name.localeCompare(b.name);
		});
	}

	private computeAllModels(): Model<Api>[] {
		return this.sortModels([...this.opts.allModels]);
	}

	// ── favorites toggle ────────────────────────────────────────────────

	private toggleFavorite(): void {
		const selected = this.filteredRows[this.rowIndex];
		if (!selected) return;

		const key = modelKey(selected);
		if (this.favorites.has(key)) this.favorites.delete(key);
		else this.favorites.add(key);
		saveFavorites(this.favorites);

		this.refreshCategories();
	}

	// ── hidden toggle ────────────────────────────────────────────────────

	private toggleHidden(): void {
		const selected = this.filteredRows[this.rowIndex];
		if (!selected) return;

		const key = modelKey(selected);
		if (this.hidden.has(key)) this.hidden.delete(key);
		else this.hidden.add(key);
		saveHidden(this.hidden);

		this.refreshCategories();
	}

	private refreshCategories(): void {
		const currentCategory = this.categories[this.catIndex] ?? FAVORITES_CATEGORY;
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		this.catIndex = Math.max(0, this.categories.indexOf(currentCategory));
		this.applyFilter();
	}

	// ── filtering ────────────────────────────────────────────────────────

	private applyFilter(): void {
		const catKey = this.categories[this.catIndex] ?? "";
		const source = this.byCategory.get(catKey) ?? [];
		const query = (this.searchTerms.get(catKey) ?? "").toLowerCase().trim();

		if (!query) {
			this.filteredRows = source;
		} else {
			this.filteredRows = source.filter(
				(m) =>
					m.name.toLowerCase().includes(query) ||
					m.id.toLowerCase().includes(query),
			);
		}
		// Clamp row selection
		this.rowIndex = Math.min(this.rowIndex, Math.max(0, this.filteredRows.length - 1));
	}

	private switchCategory(delta: number): void {
		// Save current search term for this category before leaving
		const oldKey = this.categories[this.catIndex] ?? "";
		this.searchTerms.set(oldKey, this.searchInput.getValue());

		this.catIndex =
			(this.catIndex + delta + this.categories.length) % this.categories.length;

		// Restore search term for new category
		const newKey = this.categories[this.catIndex] ?? "";
		const saved = this.searchTerms.get(newKey) ?? "";
		this.searchInput.setValue(saved);

		this.rowIndex = 0;
		this.applyFilter();
	}

	// ── input handling ───────────────────────────────────────────────────

	handleInput(data: string): void {
		// ↑ / ↓ — navigate the list with wraparound
		if (matchesKey(data, Key.up)) {
			this.rowIndex =
				this.rowIndex === 0
					? this.filteredRows.length - 1
					: this.rowIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.rowIndex =
				this.rowIndex === this.filteredRows.length - 1
					? 0
					: this.rowIndex + 1;
			return;
		}

		// Ctrl+F — toggle favorite for the selected row
		if (matchesKey(data, Key.ctrl("f"))) {
			this.toggleFavorite();
			return;
		}

		// Ctrl+H — toggle hidden for the selected row
		if (matchesKey(data, Key.ctrl("h"))) {
			this.toggleHidden();
			return;
		}

		// Tab / Shift+Tab — switch category
		if (matchesKey(data, Key.tab)) {
			this.switchCategory(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.switchCategory(-1);
			return;
		}

		// ← at start of empty field — switch category left
		if (matchesKey(data, Key.left) && this.searchInput.getValue() === "") {
			this.switchCategory(-1);
			return;
		}
		// → at end of empty field — switch category right
		if (matchesKey(data, Key.right) && this.searchInput.getValue() === "") {
			this.switchCategory(1);
			return;
		}

		// Everything else (including ← / → when field has text) → Input
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();

		if (before !== after) {
			// Update stored term and refilter
			const catKey = this.categories[this.catIndex] ?? "";
			this.searchTerms.set(catKey, after);
			this.rowIndex = 0;
			this.applyFilter();
		}
	}

	// ── rendering ────────────────────────────────────────────────────────

	render(width: number, theme: any): string[] {
		const lines: string[] = [];

		// ── tab bar ──────────────────────────────────────────────────────
		lines.push(this.renderTabs(width, theme));

		// ── search field ─────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const prompt = theme.fg("muted", "  Search: ");
		const promptW = visibleWidth("  Search: ");
		const inputLines = this.searchInput.render(width - promptW);
		lines.push(prompt + (inputLines[0] ?? ""));

		// ── divider ──────────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));

		// ── model list ───────────────────────────────────────────────────
		const MAX_VISIBLE = 10;
		const half = Math.floor(MAX_VISIBLE / 2);
		const rows = this.filteredRows;
		const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - MAX_VISIBLE));
		const visible = rows.slice(start, start + MAX_VISIBLE);

		if (rows.length === 0) {
			const query = this.searchInput.getValue();
			const catKey = this.categories[this.catIndex] ?? "";
			let msg: string;
			if (query) {
				msg = `  No models match "${query}"`;
			} else if (catKey === FAVORITES_CATEGORY) {
				msg = "  No favorites yet — press Ctrl+F on any model to add";
			} else if (catKey === HIDDEN_CATEGORY) {
				msg = "  No hidden models yet — press Ctrl+H on any model to hide";
			} else {
				msg = "  No models in this category";
			}
			lines.push(theme.fg("muted", msg));
		} else {
			const catKey = this.categories[this.catIndex] ?? "";
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const isSelected = absIdx === this.rowIndex;
				const isCurrent =
					this.opts.currentModel?.id === model.id &&
					this.opts.currentModel?.provider === model.provider;
				const isFavorite = this.favorites.has(modelKey(model));
				const isHidden = this.hidden.has(modelKey(model));
				const showProvider = catKey === FAVORITES_CATEGORY || catKey === HIDDEN_CATEGORY;
				lines.push(this.renderRow(model, isSelected, isCurrent, isFavorite, isHidden, showProvider, width, theme));
			}
			if (rows.length > MAX_VISIBLE) {
				const shown = `${start + 1}–${Math.min(start + MAX_VISIBLE, rows.length)} of ${rows.length}`;
				lines.push(theme.fg("dim", "  " + shown));
			}
		}

		// ── help bar ─────────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const help = "↑↓ nav  ·  Tab/← → category  ·  enter select  ·  Ctrl+F fav  ·  Ctrl+H hide  ·  esc";
		lines.push(theme.fg("dim", truncateToWidth("  " + help, width)));

		return lines;
	}

	private renderTabs(width: number, theme: any): string {
		const total = this.categories.length;
		const active = this.catIndex;
		const ARROW_W = 4; // "◀ " + " ▶"
		const SEP_W = 1;   // "│"
		const availForTabs = width - ARROW_W;

		let lo = active;
		let hi = active;
		let used = visibleWidth(` ${providerLabel(this.categories[active]!)} `);

		while (true) {
			let expanded = false;
			if (hi + 1 < total) {
				const w = SEP_W + visibleWidth(` ${providerLabel(this.categories[hi + 1]!)} `);
				if (used + w <= availForTabs) { hi++; used += w; expanded = true; }
			}
			if (lo - 1 >= 0) {
				const w = SEP_W + visibleWidth(` ${providerLabel(this.categories[lo - 1]!)} `);
				if (used + w <= availForTabs) { lo--; used += w; expanded = true; }
			}
			if (!expanded) break;
		}

		const segments: string[] = [];
		for (let i = lo; i <= hi; i++) {
			const label = ` ${providerLabel(this.categories[i]!)} `;
			segments.push(
				i === active
					? theme.fg("accent", theme.bold(label))
					: theme.fg("muted", label),
			);
		}

		const tabPart = segments.join(theme.fg("dim", "│"));
		const leftPart = lo > 0 ? theme.fg("dim", "◀ ") : "  ";
		const rightPart = hi < total - 1 ? theme.fg("dim", " ▶") : "  ";

		return truncateToWidth(leftPart + tabPart + rightPart, width);
	}

	private renderRow(
		model: Model<Api>,
		isSelected: boolean,
		isCurrent: boolean,
		isFavorite: boolean,
		isHidden: boolean,
		showProvider: boolean,
		width: number,
		theme: any,
	): string {
		const prefix = isSelected ? "▶ " : "  ";
		const ctxStr = fmtCtx(model.contextWindow);
		const tags: string[] = [];
		if (model.reasoning) tags.push("thinking");
		if (model.input.includes("image")) tags.push("vision");
		const provider = showProvider ? `${providerLabel(model.provider)}  ` : "";
		const right = `${provider}${ctxStr}  ${tags.join(" ")}`;

		const favMark = isFavorite ? " ★" : "";
		const hiddenMark = isHidden ? " ◌" : "";
		const curMark = isCurrent ? " ●" : "";
		const marks = favMark + hiddenMark + curMark;
		const nameAvail = width - visibleWidth(prefix) - visibleWidth(right) - visibleWidth(marks) - 2;
		const nameTrunc = truncateToWidth(model.name, Math.max(nameAvail, 10));
		const gap = " ".repeat(
			Math.max(0, width - visibleWidth(prefix + nameTrunc + marks) - visibleWidth(right)),
		);

		if (isSelected) {
			return (
				theme.fg("accent", prefix + nameTrunc + marks) +
				gap +
				theme.fg("accent", theme.bold(right))
			);
		} else if (isCurrent) {
			return (
				theme.fg("success", prefix + nameTrunc + marks) +
				gap +
				theme.fg("muted", right)
			);
		} else {
			return (
				theme.fg("text", prefix + nameTrunc + marks) +
				gap +
				theme.fg("dim", right)
			);
		}
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

// ─── extension ──────────────────────────────────────────────────────────────

export default function modelPickerExtension(pi: ExtensionAPI) {
	async function openPicker(ctx: ExtensionContext) {
		// Same logic as /model: refresh from disk, then only models with auth configured
		ctx.modelRegistry.refresh();
		const allModels = ctx.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			ctx.ui.notify("No models available", "warning");
			return;
		}

		const selected = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
			const picker = new ModelPickerComponent({
				allModels,
				currentModel: ctx.model ?? undefined,
				onSelect: (m) => done(m),
				onCancel: () => done(null),
			});

			// Give the picker focus so the embedded Input gets IME cursor
			picker.focusedState = true;

			const header = new Container();
			header.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			header.addChild(new Text(theme.fg("accent", theme.bold("  Select Model")), 0, 0));

			const footer = new DynamicBorder((s: string) => theme.fg("accent", s));

			return {
				// Implement Focusable so pi propagates focus to the Input's cursor
				focused: true,

				render(width: number): string[] {
					return [
						...header.render(width),
						...picker.render(width, theme),
						...footer.render(width),
					];
				},
				invalidate() {
					header.invalidate();
					picker.invalidate();
				},
				handleInput(data: string) {
					picker.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;

		const success = await pi.setModel(selected);
		if (!success) {
			ctx.ui.notify(`No API key for ${selected.provider}/${selected.id}`, "error");
		} else {
			ctx.ui.notify(`Model: ${selected.name}`, "success");
		}
	}

	// /model is a reserved built-in — use /models instead
	pi.registerCommand("models", {
		description: "Select model by provider category with search (Tab/← → switch, ↑↓ navigate)",
		handler: async (_args, ctx) => {
			await openPicker(ctx);
		},
	});

	// Keyboard shortcut
	pi.registerShortcut("ctrl+shift+m", {
		description: "Open categorized model picker",
		handler: async (ctx) => {
			await openPicker(ctx);
		},
	});
}
