/**
 * Canonical platform routes for navigation alignment and e2e checks.
 * Keep in sync with app/ page tree and Nav links.
 */
export const USER_ROUTES = [
	{path: '/', label: 'Home'},
	{path: '/login', label: 'Login'},
	{path: '/register', label: 'Register'},
	{path: '/dashboard', label: 'Dashboard'},
	{path: '/markets', label: 'Markets'},
	{path: '/trade', label: 'Trade'},
	{path: '/portfolio', label: 'Portfolio'},
	{path: '/wallet', label: 'Wallet'},
	{path: '/wallet/transactions', label: 'Wallet transactions'},
	{path: '/wallet/convert', label: 'Convert'},
	{path: '/bank', label: 'Bank'},
	{path: '/investments', label: 'Investments'},
	{path: '/orders', label: 'Orders'},
	{path: '/activity', label: 'Activity'},
	{path: '/settings', label: 'Settings'},
	{path: '/support', label: 'Support'},
	{path: '/notifications', label: 'Notifications'},
	{path: '/kyc', label: 'Verification'},
	{path: '/tier', label: 'Tier'},
	{path: '/cards', label: 'Cards'},
	{path: '/community', label: 'Community'},
	{path: '/news', label: 'News'},
	{path: '/stories', label: 'Stories'},
	{path: '/client-stories', label: 'Client stories'},
	{path: '/education', label: 'Education'},
	{path: '/broadcasts', label: 'Broadcasts'},
	{path: '/tax-services', label: 'Tax services'},
	{path: '/about', label: 'About'},
	{path: '/about-me', label: 'About me'},
	{path: '/terms', label: 'Terms'},
	{path: '/privacy', label: 'Privacy'},
	{path: '/risk-disclosure', label: 'Risk disclosure'},
	{path: '/legal-centre', label: 'Legal centre'},
] as const;

export const ADMIN_ROUTES = [
	{path: '/admin/login', label: 'Admin login'},
	{path: '/admin', label: 'Admin home'},
	{path: '/admin/users', label: 'Users'},
	{path: '/admin/markets', label: 'Admin markets'},
	{path: '/admin/support', label: 'Admin support'},
	{path: '/admin/kyc', label: 'Admin KYC'},
	{path: '/admin/bank', label: 'Admin bank'},
	{path: '/admin/investments', label: 'Admin investments'},
	{path: '/admin/settings', label: 'Admin settings'},
] as const;

export const MARKET_API_ROUTES = [
	'/api/live-markets',
	'/api/market/free-quote',
	'/api/health/market',
	'/api/portfolio',
] as const;
