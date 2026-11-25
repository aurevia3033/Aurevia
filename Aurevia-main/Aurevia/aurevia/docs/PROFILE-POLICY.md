# Profile security policy

## Profile photo
- Users may change their profile picture **anytime**.
- Upload path: `POST /api/profile/avatar` (not subject to the personal-details lock).

## Personal details (name, country, address)
- Every account remains editable until its name and country complete the profile.
- Completing the profile starts a **60-day lock** for personal details, independent of KYC approval or account mode.
- While locked, saves return HTTP 423 and the settings form fields stay disabled.
- After the 60-day window, one edit is allowed; a successful save re-arms the 60-day lock.
- The settings page shows the next eligible edit date while locked.
- Phone number changes still require contact verification first.
- Profile changes write an audit event containing changed field names, never the submitted values.
- The additive migration seeds existing complete profiles from their verification timestamp or account creation date; it does not delete or overwrite profile data.

## Profile photos
Profile photos are stored and updated through their separate endpoint and are unaffected by the personal-details lock.
