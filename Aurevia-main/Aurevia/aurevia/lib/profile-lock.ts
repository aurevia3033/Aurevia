export const PROFILE_LOCK_MONTHS = 2;

/**
 * Profile photo is never subject to the personal-details lock.
 * Users may change their profile picture at any time via /api/profile/avatar.
 */
export function isProfileAvatarEditable() {
	return true;
}

/** End of a lock window starting at anchor (anchor + 2 calendar months). */
export function profileEditDeadline(anchorAt: Date | null) {
	if (!anchorAt) return null;
	const year = anchorAt.getUTCFullYear();
	const month = anchorAt.getUTCMonth() + PROFILE_LOCK_MONTHS;
	const day = anchorAt.getUTCDate();
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const deadline = new Date(
		Date.UTC(
			year,
			month,
			Math.min(day, lastDay),
			anchorAt.getUTCHours(),
			anchorAt.getUTCMinutes(),
			anchorAt.getUTCSeconds(),
			anchorAt.getUTCMilliseconds(),
		),
	);
	return deadline;
}

/**
 * Personal profile fields (name, country, address) stay locked for 2 months after
 * the lock anchor (verification completed or last successful secured profile save).
 *
 * - New accounts (no verifiedAt): editable so the first post-signup profile save works.
 * - After verification / secured save: locked until the deadline.
 * - After the deadline: editable again for one save, which re-arms the lock (see profile PATCH).
 *
 * Avatar is never locked.
 */
export function isProfileLocked(verifiedAt: Date | null, now = new Date()) {
	if (!verifiedAt) return false;
	const deadline = profileEditDeadline(verifiedAt);
	if (!deadline) return false;
	return now < deadline;
}

/** Next time personal fields become editable, or null if already editable / no anchor. */
export function nextProfileEditAt(verifiedAt: Date | null, now = new Date()) {
	if (!verifiedAt) return null;
	const deadline = profileEditDeadline(verifiedAt);
	if (!deadline) return null;
	return now < deadline ? deadline : null;
}
