export const PROFILE_LOCK_DAYS = 60;
const PROFILE_LOCK_DURATION_MS = PROFILE_LOCK_DAYS * 24 * 60 * 60 * 1000;

/**
 * Profile photo is never subject to the personal-details lock.
 * Users may change their profile picture at any time via /api/profile/avatar.
 */
export function isProfileAvatarEditable() {
	return true;
}

/** End of a lock window starting at anchor (anchor + 60 elapsed days). */
export function profileEditDeadline(anchorAt: Date | null) {
	if (!anchorAt) return null;
	return new Date(anchorAt.getTime() + PROFILE_LOCK_DURATION_MS);
}

/**
 * Personal profile fields (name, country, address) stay locked for 60 days after
 * initial profile completion or the last eligible profile save.
 *
 * - Incomplete profiles stay editable until name and country are provided.
 * - Completed profiles stay locked until the deadline.
 * - After the deadline: editable again for one save, which re-arms the lock (see profile PATCH).
 *
 * Avatar is never locked.
 */
export function isProfileLocked(lastProfileEditAt: Date | null, now = new Date()) {
	if (!lastProfileEditAt) return false;
	const deadline = profileEditDeadline(lastProfileEditAt);
	if (!deadline) return false;
	return now < deadline;
}

/** Next time personal fields become editable, or null if already editable / no anchor. */
export function nextProfileEditAt(lastProfileEditAt: Date | null, now = new Date()) {
	if (!lastProfileEditAt) return null;
	const deadline = profileEditDeadline(lastProfileEditAt);
	if (!deadline) return null;
	return now < deadline ? deadline : null;
}
