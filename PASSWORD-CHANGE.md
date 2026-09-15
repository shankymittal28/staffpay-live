# Password change for an existing StaffPay session

Prepared from staffpay-live main 999527920638e37a02d2ae096a24b511055a585e.
Not deployed. No account password or Auth configuration has been changed.

## Use after release

Keep the existing StaffPay session signed in. Open More → Change password.
The form reads the signed-in account from Supabase, shows its email, and lets
the user enter and repeat a new password. The password is sent directly to
Supabase only after Save new password is tapped. It is never logged, placed
in a URL, or saved by application code. The browser's password manager may
offer to save it.

If Supabase requires reauthentication, the form exposes Send verification
code. Only that explicit button requests an email. The owner enters the code
in the app, then enters the new password again. There is no email request on
page load or automatic fallback. Rate limits and rejected codes remain errors.

This changes the current Auth account, not a staff account, payroll data,
owner mappings or any Supabase security setting. Other sessions for the same
account may need a new sign-in. Supabase's requirement for the old password,
if enabled, is not bypassed; that configuration needs a proper password
recovery flow instead, and the form says so.

No admin endpoint or service key is used. The only new requests are GET
/auth/v1/user, GET /auth/v1/reauthenticate, and PUT /auth/v1/user with password
and, when supplied, nonce. Session renewal reuses Staff Work's existing
renewal, including a check for a token another request already refreshed.
No logout request is made and no browser storage is cleared.

## Verification

Run `node test_account_security.js`: 21 scenarios run the shipped JavaScript
and the actual Staff Work renewal code against a synthetic Auth service and
DOM stand-in. They cover confirmation, verification codes, expired sessions,
account changes, refresh sharing, refused/unknown results, double taps, Back,
late responses, and clearing typed credentials. All pass. The app's inline
scripts and the new module also pass Node's syntax check.

These are not real-browser or live-Supabase results. A Chromium download
timed out in the preparation environment; no phone layout test or real
password change has been claimed. Before release, review at 390×844 and run
the existing owner-session browser checks. After release, the owner performs
the private password change on their own phone, then signs into Credit Review
with the new password. Never request their password, code, or session tokens.

The update consists of the More button, the isolated account-security.js
module, a small renewal-sharing guard, and a build marker. Existing business
readers and writes are unchanged. Reverting this commit removes the UI; it
does not revert any password the account holder has already changed.

## Provider references

- https://supabase.com/docs/reference/javascript/auth-updateuser
- https://supabase.com/docs/guides/auth/password-security
- https://github.com/supabase/auth/blob/master/internal/api/user.go
- https://github.com/supabase/auth/blob/master/internal/api/api.go
