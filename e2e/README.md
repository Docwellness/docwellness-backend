# DocWellness end-to-end UI test

One script drives **both** apps on **two emulators** through the whole
new-patient journey against the **production** backend (`api.docwellness.fit`):

```
p1_signup            user app: fresh install → sign up → email OTP → onboarding → Home
p2_request_diet      user app: request a diet plan (Silver tier)
p3_consult           dietician app: open the new patient → first consultation (magic-fill via Groq)
p3b_patient_consent  user app: review the consultation → tick consent + sign → submit
p4_create_diet       dietician app: 5-step wizard (Targets → Generate → Refine → Timeline → Finalize)
p5_payment_request   dietician app: send the payment request
p6_user_pay          user app: upload payment proof image + amount → send
p7_confirm_payment   dietician app: Confirm & Activate Diet Plan → FULLY PAID
p8_verify_diet       user app: the finalised diet plan is now visible on Diet & Exercise
```

All 9 phases were verified passing individually (2026-09-03) against prod,
building up patient `e2e.260903134741@docwellness.fit`. A full `--reset` run
executes them in sequence.

## Prerequisites

- Two Android emulators running:
  - `emulator-5554` — **user** app (`fit.docwellness.app`) installed
  - `emulator-5556` — **dietician** app (`fit.docdesk.app`) installed **and
    already logged in** as `dr.tejasvini.pawar@gmail.com`
    (the script does not log the dietician in; it reuses the session)
- Both apps built in **debug** mode (`flutter run` / `run-prod.ps1`) — p3 uses
  the debug-only "magic fill" button on the consultation form.
- Node + the backend repo checked out next to this folder (`../docwellness-backend`)
  with a working `.env` (used only for `RESEND_API_KEY`, to read the signup OTP
  back out of the sent email).
- Python 3 with `pip install` nothing extra — the driver is stdlib + `adb`.

Override emulator serials with `E2E_USER_SERIAL` / `E2E_DIET_SERIAL`.

## Run

```bash
python e2e_flow.py                    # every phase, in order
python e2e_flow.py --phase p3_consult # just one (needs artifacts/state.json from p1/p2)
python e2e_flow.py --from p4_create_diet
python e2e_flow.py --list
python e2e_flow.py --reset            # wipe state.json and start clean
```

- Every step screenshots into `artifacts/` (`<runtag>__<app>__NN_label.png`).
- `artifacts/state.json` carries the generated patient's email / password /
  name between phases, plus a `_gaps` list of places where the app didn't match
  what the script assumed (so the script can be tightened).

## How it works

- **`uidriver.py`** — a small `adb` + `uiautomator dump` UI driver. `uiautomator2`
  / Appium are unusable here (their instrumentation stub crashes on the
  emulators' Android build), but plain `uiautomator dump` works and Flutter
  exposes its semantics tree as Android `content-desc`, so elements are found
  by description and tapped at their bounds centre.
- **`../docwellness-backend/scripts/e2e-get-signup-otp.js`** — reads the signup
  verification code back from Resend (the app's email provider). Regenerating
  the code via Supabase admin does **not** work: prod's Supabase project differs
  from the one in the local `.env`, and `generateLink` only returns a
  `verifyOtp`-valid code on the very first call anyway.
- Device hygiene handled in `Device.prep()`: disables the Android 14+
  stylus-handwriting popup that otherwise eats the first `input text` into a
  field; keeps the screen awake.

## Test data / cleanup

Each `p1` run creates a **real** patient on prod (Supabase identity + Mongo
profile + diet-plan request + …). Clean them up with
`scripts/e2e-cleanup.js` in the backend (see its header), or delete through
the dietician app. Test emails are always `e2e.<timestamp>@docwellness.fit`.

## Known gaps / TODO

See `_gaps` in the latest `artifacts/state.json` after a run. Phases p4–p8
are the least battle-tested (the diet wizard's live AI generation + ±5%
finalize constraint, and the two-way payment flow).
