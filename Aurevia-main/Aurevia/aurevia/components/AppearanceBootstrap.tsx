'use client';

/**
 * Restores saved appearance preferences on every page load so Home, Dashboard,
 * Wallet, Bank, Markets, Trade, Admin, TV/Testimonials, Support, Activity,
 * Investments, and Demo/Real shells all share the same theme performance.
 * Does not alter any existing copy or route behaviour.
 */

import {useEffect} from 'react';

const STORAGE_KEY = 'aurevia-appearance-prefs';

type StoredAppearance = {
	accent?: string;
	textSize?: string;
	uiStyle?: string;
};

function applyStored() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const prefs = JSON.parse(raw) as StoredAppearance;
		const root = document.documentElement;
		if (prefs.accent) root.dataset.accent = prefs.accent;
		if (prefs.textSize) root.dataset.textSize = prefs.textSize;
		if (prefs.uiStyle) root.dataset.uiStyle = prefs.uiStyle;
	} catch {
		/* ignore corrupt storage */
	}
}

export default function AppearanceBootstrap() {
	useEffect(() => {
		applyStored();
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY) applyStored();
		};
		window.addEventListener('storage', onStorage);
		window.addEventListener('aurevia-theme-change', applyStored as EventListener);
		return () => {
			window.removeEventListener('storage', onStorage);
			window.removeEventListener('aurevia-theme-change', applyStored as EventListener);
		};
	}, []);
	return null;
}
