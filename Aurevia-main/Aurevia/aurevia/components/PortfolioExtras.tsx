'use client';

/**
 * Always-on portfolio tools: diversification, concentration, cash ratio,
 * CSV export, and refresh. Works from data already returned by /api/portfolio
 * — no external paid features, no "unavailable" placeholders.
 */

import {useMemo, useState} from 'react';
import {Download, PieChart, RefreshCw, Shield, Wallet} from 'lucide-react';

type HoldingLike = {
	id: string;
	name: string;
	category: string;
	invested: string;
	value: string | null;
	gainLoss: string | null;
	status: string;
};

type AllocationLike = {category: string; value: string; percentage: string};

type Props = {
	cashBalance: string;
	totalValue: string | null;
	holdings: HoldingLike[];
	allocations: AllocationLike[];
	accountMode: 'DEMO' | 'REAL';
	onRefresh: () => void;
	refreshing?: boolean;
};

function num(value: string | number | null | undefined) {
	if (value === null || value === undefined || value === '') return 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function money(value: number) {
	return new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(value);
}

/** Herfindahl-based diversification score 0–100 (higher = more diversified). */
function diversificationScore(allocations: AllocationLike[]) {
	if (!allocations.length) return 100;
	const weights = allocations.map(a => num(a.percentage) / 100).filter(w => w > 0);
	if (!weights.length) return 100;
	const hhi = weights.reduce((sum, w) => sum + w * w, 0);
	// Single asset HHI=1 → score 0; equal 10 assets HHI=0.1 → high score
	const score = Math.max(0, Math.min(100, Math.round((1 - hhi) * 100 / 0.9)));
	return score;
}

function topConcentration(allocations: AllocationLike[]) {
	if (!allocations.length) return 0;
	return Math.max(...allocations.map(a => num(a.percentage)));
}

export default function PortfolioExtras({
	cashBalance,
	totalValue,
	holdings,
	allocations,
	accountMode,
	onRefresh,
	refreshing,
}: Props) {
	const [exported, setExported] = useState(false);

	const metrics = useMemo(() => {
		const total = num(totalValue);
		const cash = num(cashBalance);
		const invested = Math.max(0, total - cash);
		const cashPct = total > 0 ? (cash / total) * 100 : cash > 0 ? 100 : 0;
		const investedPct = total > 0 ? (invested / total) * 100 : 0;
		const div = diversificationScore(allocations);
		const concentration = topConcentration(allocations);
		const valuedHoldings = holdings.filter(h => h.value !== null);
		const openHoldings = holdings.filter(h => h.status === 'OPEN' || h.status === 'ACTIVE' || !h.status);
		return {
			total,
			cash,
			invested,
			cashPct,
			investedPct,
			div,
			concentration,
			holdingCount: holdings.length,
			valuedCount: valuedHoldings.length,
			openCount: openHoldings.length || holdings.length,
		};
	}, [cashBalance, totalValue, holdings, allocations]);

	function exportCsv() {
		const rows = [
			['Name', 'Category', 'Invested', 'Value', 'Gain/Loss', 'Status'],
			...holdings.map(h => [
				h.name,
				h.category,
				h.invested,
				h.value ?? '',
				h.gainLoss ?? '',
				h.status,
			]),
		];
		const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
		const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `aurevia-portfolio-${accountMode.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
		setExported(true);
		window.setTimeout(() => setExported(false), 2000);
	}

	return (
		<section className="portfolio-extras card account-panel" aria-label="Portfolio tools">
			<header className="portfolio-extras-head">
				<div>
					<span className="settings-app-preferences-eyebrow">PORTFOLIO TOOLS</span>
					<h2>Insights &amp; export</h2>
				</div>
				<div className="portfolio-extras-actions">
					<button
						type="button"
						className="btn bg-white/5"
						onClick={onRefresh}
						disabled={refreshing}
						aria-busy={refreshing}
					>
						<RefreshCw size={16} className={refreshing ? 'spin' : undefined} />
						{refreshing ? 'Refreshing…' : 'Refresh'}
					</button>
					<button type="button" className="btn bg-gold text-black" onClick={exportCsv} disabled={!holdings.length}>
						<Download size={16} />
						{exported ? 'Exported' : 'Export CSV'}
					</button>
				</div>
			</header>

			<div className="portfolio-extras-grid">
				<article className="portfolio-extra-metric">
					<span className="portfolio-extra-icon"><PieChart size={18} /></span>
					<div>
						<strong>Diversification</strong>
						<p className="portfolio-extra-value">{metrics.div}/100</p>
						<small className="muted">
							{metrics.div >= 70 ? 'Well spread across categories' : metrics.div >= 40 ? 'Moderate concentration' : 'Concentrated book'}
						</small>
					</div>
				</article>

				<article className="portfolio-extra-metric">
					<span className="portfolio-extra-icon"><Shield size={18} /></span>
					<div>
						<strong>Top category</strong>
						<p className="portfolio-extra-value">{metrics.concentration.toFixed(1)}%</p>
						<small className="muted">Largest allocation share</small>
					</div>
				</article>

				<article className="portfolio-extra-metric">
					<span className="portfolio-extra-icon"><Wallet size={18} /></span>
					<div>
						<strong>Cash vs invested</strong>
						<p className="portfolio-extra-value">
							{metrics.cashPct.toFixed(0)}% / {metrics.investedPct.toFixed(0)}%
						</p>
						<small className="muted">
							{money(metrics.cash)} cash · {money(metrics.invested)} invested
						</small>
					</div>
				</article>

				<article className="portfolio-extra-metric">
					<span className="portfolio-extra-icon"><PieChart size={18} /></span>
					<div>
						<strong>Holdings valued</strong>
						<p className="portfolio-extra-value">
							{metrics.valuedCount}/{metrics.holdingCount || metrics.openCount}
						</p>
						<small className="muted">
							Live marks from market + free public feeds
						</small>
					</div>
				</article>
			</div>

			{allocations.length > 0 ? (
				<ul className="portfolio-extras-alloc" aria-label="Allocation breakdown">
					{allocations.map(a => (
						<li key={a.category}>
							<span>{a.category}</span>
							<span className="portfolio-extras-bar" aria-hidden="true">
								<span style={{width: `${Math.min(100, num(a.percentage))}%`}} />
							</span>
							<span>{num(a.percentage).toFixed(1)}%</span>
						</li>
					))}
				</ul>
			) : (
				<p className="muted text-sm">Allocation appears when holdings or cash are present.</p>
			)}
		</section>
	);
}
