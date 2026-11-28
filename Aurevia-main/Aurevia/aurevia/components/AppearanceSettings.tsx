'use client';

/**
 * Appearance & Preferences — video-inspired settings with draft → review → save.
 * Matches the polished mobile settings flow: live previews, change counter,
 * review sheet listing every pending change, and a clear "Saved" confirmation.
 */

import {useCallback, useEffect, useMemo, useState, type CSSProperties} from 'react';
import {
	Check,
	Globe,
	LoaderCircle,
	Moon,
	Sun,
	Type,
	Palette,
	Sparkles,
} from 'lucide-react';
import {useLocale} from '@/lib/i18n-context';
import {localeMeta, locales, type Locale} from '@/lib/i18n';
import {useTheme} from '@/lib/theme-context';
import {isTheme, type Theme} from '@/lib/theme-shared';
// AppearanceSettings uses the existing ThemeProvider / useTheme API.

type AccentColor = 'violet' | 'rose' | 'blue' | 'green' | 'amber' | 'forest';
type TextSize = 'sm' | 'default' | 'lg' | 'xl';
type UiStyle = 'rounded' | 'soft' | 'crisp';

type AppearanceState = {
	theme: Theme;
	accent: AccentColor;
	textSize: TextSize;
	uiStyle: UiStyle;
	locale: Locale;
};

const ACCENTS: {id: AccentColor; label: string; swatch: string}[] = [
	{id: 'forest', label: 'Forest', swatch: '#1a6b4a'},
	{id: 'violet', label: 'Violet', swatch: '#7c5cfc'},
	{id: 'rose', label: 'Rose', swatch: '#e85d8a'},
	{id: 'blue', label: 'Blue', swatch: '#3b82f6'},
	{id: 'green', label: 'Green', swatch: '#22c55e'},
	{id: 'amber', label: 'Amber', swatch: '#f59e0b'},
];

const TEXT_SIZES: {id: TextSize; label: string}[] = [
	{id: 'sm', label: 'Small'},
	{id: 'default', label: 'Default'},
	{id: 'lg', label: 'Large'},
	{id: 'xl', label: 'X-Large'},
];

const UI_STYLES: {id: UiStyle; label: string}[] = [
	{id: 'rounded', label: 'Rounded'},
	{id: 'soft', label: 'Soft'},
	{id: 'crisp', label: 'Crisp'},
];

const STORAGE_KEY = 'aurevia-appearance-prefs';

function loadLocalAppearance(): Partial<AppearanceState> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		return JSON.parse(raw) as Partial<AppearanceState>;
	} catch {
		return {};
	}
}

function applyAccent(accent: AccentColor) {
	document.documentElement.dataset.accent = accent;
}

function applyTextSize(size: TextSize) {
	document.documentElement.dataset.textSize = size;
}

function applyUiStyle(style: UiStyle) {
	document.documentElement.dataset.uiStyle = style;
}

function changeLabel(
	key: keyof AppearanceState,
	from: string | boolean,
	to: string | boolean,
): string {
	const labels: Record<string, string> = {
		theme: 'Dark mode',
		accent: 'Theme color',
		textSize: 'Text size',
		uiStyle: 'UI style',
		locale: 'Language',
	};
	const format = (v: string | boolean) => {
		if (typeof v === 'boolean') return v ? 'On' : 'Off';
		if (v === 'forest-green') return 'Dark';
		if (v === 'premium-dashboard') return 'Light';
		const accent = ACCENTS.find(a => a.id === v);
		if (accent) return accent.label;
		const size = TEXT_SIZES.find(s => s.id === v);
		if (size) return size.label;
		const style = UI_STYLES.find(s => s.id === v);
		if (style) return style.label;
		if (locales.includes(v as Locale)) return localeMeta[v as Locale].nativeName;
		return String(v);
	};
	return `${labels[key] || key}: ${format(from)} → ${format(to)}`;
}

export default function AppearanceSettings() {
	const {locale, setLocale} = useLocale();
	const themeApi = useTheme();
	const currentTheme: Theme =
		themeApi && isTheme(themeApi.theme) ? themeApi.theme : 'forest-green';

	const [saved, setSaved] = useState<AppearanceState | null>(null);
	const [draft, setDraft] = useState<AppearanceState | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [showReview, setShowReview] = useState(false);
	const [savedToast, setSavedToast] = useState(false);
	const [error, setError] = useState('');

	// Bootstrap from server + local extras
	useEffect(() => {
		let active = true;
		(async () => {
			try {
				const local = loadLocalAppearance();
				const langRes = await fetch('/api/language-preference', {cache: 'no-store'}).then(r => r.json()).catch(() => ({}));
				if (!active) return;
				const base: AppearanceState = {
					theme: currentTheme,
					accent: (local.accent as AccentColor) || 'forest',
					textSize: (local.textSize as TextSize) || 'default',
					uiStyle: (local.uiStyle as UiStyle) || 'rounded',
					locale: (locales.includes(langRes.locale) ? langRes.locale : locale) as Locale,
				};
				setSaved(base);
				setDraft({...base});
				applyAccent(base.accent);
				applyTextSize(base.textSize);
				applyUiStyle(base.uiStyle);
			} catch (e) {
				if (active) setError(e instanceof Error ? e.message : 'Unable to load preferences.');
			} finally {
				if (active) setLoading(false);
			}
		})();
		return () => {
			active = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const changes = useMemo(() => {
		if (!saved || !draft) return [] as {key: keyof AppearanceState; from: string | boolean; to: string | boolean}[];
		const keys = Object.keys(saved) as (keyof AppearanceState)[];
		return keys
			.filter(k => saved[k] !== draft[k])
			.map(k => ({key: k, from: saved[k], to: draft[k]}));
	}, [saved, draft]);

	const changeCount = changes.length;

	const updateDraft = useCallback(<K extends keyof AppearanceState>(key: K, value: AppearanceState[K]) => {
		setDraft(prev => (prev ? {...prev, [key]: value} : prev));
		// Live preview for visual prefs
		if (key === 'accent') applyAccent(value as AccentColor);
		if (key === 'textSize') applyTextSize(value as TextSize);
		if (key === 'uiStyle') applyUiStyle(value as UiStyle);
		if (key === 'theme') {
			void themeApi.selectTheme(value as Theme);
		}
		if (key === 'locale') setLocale(value as Locale);
	}, [setLocale, themeApi]);

	function discard() {
		if (!saved) return;
		setDraft({...saved});
		applyAccent(saved.accent);
		applyTextSize(saved.textSize);
		applyUiStyle(saved.uiStyle);
		if (saved.theme !== currentTheme) {
			void themeApi.selectTheme(saved.theme);
		}
		setLocale(saved.locale);
		setShowReview(false);
	}

	async function saveAll() {
		if (!draft || !saved || saving || changeCount === 0) return;
		setSaving(true);
		setError('');
		try {
			// Persist language
			if (draft.locale !== saved.locale) {
				const res = await fetch('/api/language-preference', {
					method: 'PATCH',
					headers: {'content-type': 'application/json'},
					body: JSON.stringify({locale: draft.locale}),
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(body.error || 'Unable to save language.');
				setLocale(draft.locale);
			}

			// Persist theme via existing context
			if (draft.theme !== saved.theme) {
				await themeApi.selectTheme(draft.theme);
			}

			// Local appearance extras
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					accent: draft.accent,
					textSize: draft.textSize,
					uiStyle: draft.uiStyle,
				}),
			);
			applyAccent(draft.accent);
			applyTextSize(draft.textSize);
			applyUiStyle(draft.uiStyle);

			setSaved({...draft});
			setShowReview(false);
			setSavedToast(true);
			window.setTimeout(() => setSavedToast(false), 2200);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Unable to save preferences.');
		} finally {
			setSaving(false);
		}
	}

	if (loading || !draft) {
		return (
			<section className="appearance-settings card account-panel">
				<div className="appearance-loading">
					<LoaderCircle className="spin" size={22} />
					<span>Loading preferences…</span>
				</div>
			</section>
		);
	}

	const isDark = draft.theme === 'forest-green';

	return (
		<section className="appearance-settings card account-panel" aria-labelledby="appearance-title">
			<header className="appearance-header">
				<div>
					<span className="settings-app-preferences-eyebrow">PERSONALIZATION</span>
					<h2 id="appearance-title">Make the app feel like yours</h2>
				</div>
				<Sparkles size={18} className="gold" aria-hidden />
			</header>

			{error ? <p className="appearance-error" role="alert">{error}</p> : null}

			{/* Dark mode */}
			<div className="appearance-row">
				<div className="appearance-row-label">
					<span className="appearance-icon">{isDark ? <Moon size={18} /> : <Sun size={18} />}</span>
					<div>
						<strong>Dark mode</strong>
						<small>Tap to switch the mood</small>
					</div>
				</div>
				<button
					type="button"
					className={`appearance-switch ${isDark ? 'on' : ''}`}
					role="switch"
					aria-checked={isDark}
					onClick={() =>
						updateDraft('theme', isDark ? 'premium-dashboard' : 'forest-green')
					}
				>
					<span className="appearance-switch-knob" />
				</button>
			</div>

			{/* Theme color */}
			<div className="appearance-block">
				<div className="appearance-block-title">
					<span className="appearance-icon"><Palette size={16} /></span>
					<span>Theme color</span>
					<em>{ACCENTS.find(a => a.id === draft.accent)?.label}</em>
				</div>
				<div className="appearance-swatches" role="radiogroup" aria-label="Theme color">
					{ACCENTS.map(a => (
						<button
							key={a.id}
							type="button"
							role="radio"
							aria-checked={draft.accent === a.id}
							className={`appearance-swatch ${draft.accent === a.id ? 'selected' : ''}`}
							style={{'--swatch': a.swatch} as CSSProperties}
							onClick={() => updateDraft('accent', a.id)}
							title={a.label}
						>
							{draft.accent === a.id ? <Check size={14} /> : null}
						</button>
					))}
				</div>
			</div>

			{/* Text size */}
			<div className="appearance-block">
				<div className="appearance-block-title">
					<span className="appearance-icon"><Type size={16} /></span>
					<span>Text size</span>
					<em>{TEXT_SIZES.find(s => s.id === draft.textSize)?.label}</em>
				</div>
				<div className="appearance-chip-row" role="radiogroup" aria-label="Text size">
					{TEXT_SIZES.map(s => (
						<button
							key={s.id}
							type="button"
							role="radio"
							aria-checked={draft.textSize === s.id}
							className={`appearance-chip ${draft.textSize === s.id ? 'selected' : ''}`}
							onClick={() => updateDraft('textSize', s.id)}
						>
							{s.label === 'Small' ? 'Aa' : s.label === 'Default' ? 'Aa' : s.label === 'Large' ? 'Aa' : 'Aa'}
							<span className={`appearance-chip-size size-${s.id}`}>{s.label}</span>
						</button>
					))}
				</div>
			</div>

			{/* UI style */}
			<div className="appearance-block">
				<div className="appearance-block-title">
					<span>UI style</span>
					<em>{UI_STYLES.find(s => s.id === draft.uiStyle)?.label}</em>
				</div>
				<div className="appearance-style-row" role="radiogroup" aria-label="UI style">
					{UI_STYLES.map(s => (
						<button
							key={s.id}
							type="button"
							role="radio"
							aria-checked={draft.uiStyle === s.id}
							className={`appearance-style-card style-${s.id} ${draft.uiStyle === s.id ? 'selected' : ''}`}
							onClick={() => updateDraft('uiStyle', s.id)}
						>
							<span className="appearance-style-preview" />
							<span>{s.label}</span>
						</button>
					))}
				</div>
			</div>

			{/* Language */}
			<div className="appearance-block">
				<div className="appearance-block-title">
					<span className="appearance-icon"><Globe size={16} /></span>
					<span>Language</span>
					<em>{localeMeta[draft.locale]?.nativeName}</em>
				</div>
				<div className="appearance-lang-list" role="listbox" aria-label="Language">
					{locales.slice(0, 8).map(code => (
						<button
							key={code}
							type="button"
							role="option"
							aria-selected={draft.locale === code}
							className={`appearance-lang-item ${draft.locale === code ? 'selected' : ''}`}
							onClick={() => updateDraft('locale', code)}
						>
							<span className="appearance-lang-code">{code.toUpperCase().slice(0, 2)}</span>
							<span className="appearance-lang-names">
								<strong>{localeMeta[code].nativeName}</strong>
								<small>{localeMeta[code].name}</small>
							</span>
							{draft.locale === code ? <Check size={16} className="appearance-check" /> : null}
						</button>
					))}
				</div>
			</div>

			{/* Floating change bar */}
			{changeCount > 0 ? (
				<div className="appearance-change-bar" role="status">
					<span className="appearance-change-count">{changeCount} change{changeCount === 1 ? '' : 's'}</span>
					<div className="appearance-change-actions">
						<button type="button" className="appearance-btn ghost" onClick={discard}>
							Discard
						</button>
						<button type="button" className="appearance-btn primary" onClick={() => setShowReview(true)}>
							Review
						</button>
					</div>
				</div>
			) : null}

			{/* Review sheet */}
			{showReview ? (
				<div className="appearance-review-overlay" role="dialog" aria-modal="true" aria-labelledby="review-title">
					<div className="appearance-review-sheet">
						<h3 id="review-title">Review changes</h3>
						<p className="appearance-review-sub">{changeCount} ready to apply</p>
						<ul className="appearance-review-list">
							{changes.map(c => (
								<li key={c.key}>
									<span>{changeLabel(c.key, c.from, c.to)}</span>
								</li>
							))}
						</ul>
						<button
							type="button"
							className="appearance-btn primary full"
							disabled={saving}
							onClick={() => void saveAll()}
						>
							{saving ? (
								<>
									<LoaderCircle className="spin" size={18} /> Saving…
								</>
							) : (
								'Save changes'
							)}
						</button>
						<button type="button" className="appearance-btn ghost full" onClick={() => setShowReview(false)}>
							Cancel
						</button>
					</div>
				</div>
			) : null}

			{/* Saved toast */}
			{savedToast ? (
				<div className="appearance-saved-toast" role="status">
					<span className="appearance-saved-icon"><Check size={16} /></span>
					Saved
				</div>
			) : null}
		</section>
	);
}
