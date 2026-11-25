# Profile security policy

## Profile photo
- Users may change their profile picture **anytime**.
- Upload path: `POST /api/profile/avatar` (not subject to the personal-details lock).

## Personal details (name, country, address)
- After account creation, the profile is editable so the first completion save works.
- Once verification is approved, personal details are secured with a **2-month lock**.
- While locked, saves return HTTP 423 and the settings form fields stay disabled.
- After the 2-month window, one edit is allowed; a successful save re-arms the 2-month lock automatically for security.
- Phone number changes still require contact verification first.

## Existing copy
Lock messages already in the UI are preserved (verified details locked / contact support).
