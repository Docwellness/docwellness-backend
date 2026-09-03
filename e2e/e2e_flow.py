"""
DocWellness end-to-end UI test - one script, both apps, real production
backend (api.docwellness.fit).

Flow (each step is a --phase you can run in isolation once state.json exists):

  p1_signup           user app: fresh install -> sign up -> verify email OTP
                      -> onboarding -> lands on Home
  p2_request_diet     user app: request a diet plan
  p3_consult          dietician app: open the new patient -> first consultation
  p4_create_diet      dietician app: Create Diet Plan wizard (Targets ->
                      Generate -> Refine -> Timeline -> Finalize)
  p5_payment_request  dietician app: send the payment request
  p6_user_pay         user app: open payment request -> submit payment proof
  p7_confirm_payment  dietician app: confirm the payment proof
  p8_verify_diet      user app: diet plan is now visible

Usage:
  python e2e_flow.py                 # run every phase in order
  python e2e_flow.py --phase p3_consult p4_create_diet
  python e2e_flow.py --from p4_create_diet
  python e2e_flow.py --list
  python e2e_flow.py --reset         # wipe state.json + start clean

State (the generated patient's email/password/id, discovered UI facts, and
"steps that were missing and had to be added") lives in e2e/artifacts/state.json
so a later phase can pick up where an earlier one left off.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

from uidriver import Device, UiTimeout

# ------------------------------------------------------------------ config
USER_SERIAL = os.environ.get("E2E_USER_SERIAL", "emulator-5554")
DIET_SERIAL = os.environ.get("E2E_DIET_SERIAL", "emulator-5556")
USER_PKG = "fit.docwellness.app"
DIET_PKG = "fit.docdesk.app"

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(os.path.dirname(__file__), "artifacts", "state.json")

DIETICIAN_EMAIL = "dr.tejasvini.pawar@gmail.com"  # already logged in on DIET_SERIAL

# ------------------------------------------------------------------ state
def load_state() -> dict:
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as fh:
            return json.load(fh)
    return {}


def save_state(st: dict):
    st["_updated"] = datetime.now().isoformat(timespec="seconds")
    with open(STATE_PATH, "w") as fh:
        json.dump(st, fh, indent=2)


def note_gap(st: dict, phase: str, msg: str):
    """Record a step that the flow expected but the app didn't present the
    way the script assumed - surfaced in the final summary so the script
    can be tightened for next time."""
    st.setdefault("_gaps", []).append({"phase": phase, "note": msg, "at": datetime.now().isoformat(timespec="seconds")})
    save_state(st)
    print(f"  ! GAP [{phase}]: {msg}")


# ------------------------------------------------------------------ helpers
def log(msg: str):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def run_node(script: str, *args: str, timeout: int = 90) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", script, *args],
        cwd=os.path.abspath(BACKEND_DIR),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def get_signup_otp(email: str) -> str:
    # Reads the code back from the real Resend email the app just sent
    # (see scripts/e2e-get-signup-otp.js); it polls internally.
    cp = run_node("scripts/e2e-get-signup-otp.js", email, "--timeout-ms=120000", timeout=140)
    m = re.search(r"\b(\d{6,8})\b", cp.stdout or "")
    if not m:
        raise RuntimeError(f"OTP helper gave no code.\nstdout={cp.stdout!r}\nstderr={cp.stderr!r}")
    return m.group(1)


def gen_identity() -> dict:
    ts = datetime.now().strftime("%y%m%d%H%M%S")
    # The "Full name" field strips anything but [A-Za-z ], so encode the last
    # 6 timestamp digits as letters (0->a..9->j) for a unique, searchable,
    # digit-free name the dietician can look up in p3.
    suffix = "".join(chr(97 + int(c)) for c in ts[-6:]).capitalize()
    return {
        "email": f"e2e.{ts}@docwellness.fit",
        "password": "Kp9$mwztfvbr2Q",
        "name": f"Etwoe {suffix}",
        "gender": "Female",
        "weight_kg": "72",
        "height_cm": "165",
        "phone": f"98{ts[-8:]}",          # 10-digit, unique-ish
        "goal": "Weight Loss",
        "target_weight_kg": "63",
    }


# ================================================================ phases
def p1_signup(u: Device, d: Device, st: dict):
    # Always a brand-new identity: a half-finished signup leaves an
    # unconfirmed Supabase user that would make signup-request 400 on retry.
    ident = gen_identity()
    st["identity"] = ident
    st.pop("_done", None)
    save_state(st)
    log(f"signing up {ident['email']}")

    log("wiping user app to a fresh install")
    u.stop(USER_PKG)
    u.adb("shell", "pm", "clear", USER_PKG)
    u.launch(USER_PKG, wait_s=6)
    u.screenshot("01_fresh_launch")

    # AuthView - "I'm new, Sign me up"
    try:
        u.tap_desc(r"Sign me up|new,\s*Sign", timeout=40)
    except UiTimeout:
        # maybe it opened straight on Login - look for a route to signup
        u.debug_dump()
        raise

    # SignUpView
    u.wait(desc=r"Complete Sign Up", timeout=25)
    u.screenshot("02_signup_form")
    fields = u.find_all(cls="EditText")
    if len(fields) < 3:
        note_gap(st, "p1_signup", f"expected 3 EditTexts on signup, saw {len(fields)}")
    u.set_field(fields[0], ident["email"])
    u.hide_keyboard()
    fields = u.find_all(cls="EditText")
    u.set_field(fields[1], ident["password"])
    u.hide_keyboard()
    fields = u.find_all(cls="EditText")
    u.set_field(fields[2], ident["password"])
    u.hide_keyboard()
    u.screenshot("03_signup_filled")
    u.tap_desc(r"Complete Sign Up")
    time.sleep(2)
    _assert_no_form_error(u, "p1_signup", "signup form")

    # VerifySignupCodeView
    u.wait(desc=r"Verify (&|and) Continue|Verify your email", timeout=40)
    u.screenshot("04_verify_screen")
    otp = get_signup_otp(ident["email"])
    log(f"got signup OTP {otp}")
    st["signup_otp"] = otp
    save_state(st)
    code_field = u.find(cls="EditText")
    u.set_field(code_field, otp)
    u.hide_keyboard()
    u.screenshot("05_otp_entered")
    u.tap_desc(r"Verify (&|and) Continue")
    time.sleep(2)
    u.screenshot("05b_after_verify")
    _assert_no_form_error(u, "p1_signup", "OTP verification")
    for _ in range(3):
        if not u.exists(desc=r"Verify your email"):
            break
        err = u.find(desc=r"[Ii]nvalid|expired|wrong|try again")
        if err:
            raise RuntimeError(f"[p1_signup] OTP rejected: {err.label!r}")
        time.sleep(2)

    # ---- onboarding: Personal Information
    u.wait(desc=r"Personal Information", timeout=40)
    u.screenshot("06_personal_info")
    _fill_personal_info(u, d, st, ident)

    # Target weight
    u.wait(desc=r"target weight", timeout=25)
    u.screenshot("08_target_weight")
    tw = u.find(cls="EditText")
    u.set_field(tw, ident["target_weight_kg"])
    u.hide_keyboard()
    u.tap_desc(r"^Next$", exact=False)

    # Activity level - cards: Sedentary / Lightly Activity / Moderately
    # Activity / Very Active
    u.wait(desc=r"activity level", timeout=25)
    u.screenshot("09_activity")
    try:
        u.tap_desc(r"Sedentary|Lightly|Moderately", timeout=8)
    except UiTimeout:
        _pick_first_selectable(u, st, "p1_signup", "activity level")
    u.tap_desc(r"^Next$")

    # Health concerns - must tick at least one; "I don't have any of these"
    u.wait(desc=r"health concerns", timeout=25)
    u.screenshot("10_health")
    u.tap_desc(r"I don't have any of these", timeout=8)
    time.sleep(0.5)
    u.tap_desc(r"^Next$")

    # Summary -> Submit
    u.wait(desc=r"^Summary$|Personal summary|Submit", timeout=25)
    u.screenshot("11_summary")
    u.tap_desc(r"^Submit$")

    # Should land on Home
    _wait_user_home(u, st)
    u.screenshot("12_home")
    log("signup + onboarding complete, landed on Home")
    save_state(st)


def _fill_personal_info(u: Device, d: Device, st: dict, ident: dict):
    """Layout (from a live dump): row1 = Full name (EditText, full width);
    row2 = Gender dropdown (View, left) + DOB picker (View, right);
    row3 = Weight (EditText, left) + Height (EditText, right);
    row4 = phone country (View) + phone number (EditText);
    then Primary Goal dropdown (View); then Next. Descs on the EditTexts
    are empty, so they're matched positionally after the anchors."""
    nodes = u.dump()
    edits = sorted((n for n in nodes if n.cls.endswith("EditText")), key=lambda n: (n.bounds[1], n.bounds[0]))
    # edits order: name, weight, height, phone
    if len(edits) < 4:
        note_gap(st, "p1_signup", f"personal info: expected 4 EditTexts, saw {len(edits)}")

    u.set_field(edits[0], ident["name"])
    u.hide_keyboard()
    u.screenshot("06b_name_filled")

    # Gender - the dropdown View shows "Gender\n<value>" once picked
    g = u.find(desc=r"^Gender$")
    if g and ident["gender"].lower() not in g.desc.lower():
        u.tap(g)
        try:
            u.tap(u.wait(desc=rf"^{ident['gender']}$", timeout=8))
        except UiTimeout:
            note_gap(st, "p1_signup", f"gender option {ident['gender']!r} not in dropdown")
            u.back()

    # DOB - the View immediately right of Gender on the same row. Opens a
    # Material date picker whose initialDate == the max allowed (exactly 16y
    # ago), which passes the >=16 validator, so just accept it.
    g2 = u.find(desc=r"^Gender$")
    if g2:
        gx1, gy1, gx2, gy2 = g2.bounds
        u.tap_at((gx2 + 1038) // 2, (gy1 + gy2) // 2)   # right-half of the row
        time.sleep(1)
        ok = u.find(text=r"^OK$") or u.find(desc=r"^OK$") or u.find(text=r"^SAVE$")
        if ok:
            u.tap(ok)
        else:
            u.screenshot("07a_datepicker")
            note_gap(st, "p1_signup", "date picker OK not found; backing out")
            u.back()

    # Weight / Height / phone - re-dump (indices stable: still 4 EditTexts)
    u.hide_keyboard()
    edits = sorted((n for n in u.dump() if n.cls.endswith("EditText")), key=lambda n: (n.bounds[1], n.bounds[0]))
    if len(edits) >= 4:
        u.set_field(edits[1], ident["weight_kg"]); u.hide_keyboard()
        u.set_field(edits[2], ident["height_cm"]); u.hide_keyboard()
        u.set_field(edits[3], ident["phone"]); u.hide_keyboard()

    # Primary Goal
    pg = u.scroll_to(r"Primary Goal", max_swipes=4)
    if ident["goal"].lower() not in (pg.desc or "").lower():
        u.tap(pg)
        try:
            u.tap(u.wait(desc=rf"^{re.escape(ident['goal'])}$", timeout=8))
        except UiTimeout:
            note_gap(st, "p1_signup", f"goal option {ident['goal']!r} not in dropdown")
            u.back()

    u.screenshot("07_personal_info_filled")
    # sanity: BMI should have computed once weight+height are in
    if u.exists(desc=r"BMI: 0\.0|BMI: 0$"):
        note_gap(st, "p1_signup", "BMI still 0 after filling weight/height")
    u.tap_desc(r"^Next$")


def _fields_by_label(u: Device) -> dict:
    """Best-effort map of {regex-ish label: EditText Node} using nearby text."""
    nodes = u.dump()
    edits = [n for n in nodes if n.cls.endswith("EditText")]
    out = {}
    for e in edits:
        # a Flutter TextField usually carries its label in its own desc/text
        key = (e.desc or e.text or "").strip()
        if key:
            out[key] = e
    return out


def _set_labelled(u: Device, labelled: dict, pattern: str, value: str):
    for k, node in labelled.items():
        if re.search(pattern, k, re.I):
            u.set_field(node, value)
            return True
    return False


def _assert_no_form_error(u: Device, phase: str, where: str):
    nodes = u.dump()
    for n in nodes:
        lbl = n.label
        if re.search(r"must be at least|do not match|is required|Please (enter|select)|invalid|Avoid repeating|must not contain", lbl, re.I):
            u.screenshot(f"FORMERR_{phase}")
            raise RuntimeError(f"[{phase}] validation error on {where}: {lbl!r}")


def _pick_first_selectable(u: Device, st: dict, phase: str, screen: str):
    nodes = u.dump()
    clickables = [n for n in nodes if n.clickable and n.label and not re.search(r"Next|Back|Skip", n.label)]
    if clickables:
        u.tap(clickables[0])
    else:
        note_gap(st, phase, f"no selectable option found on '{screen}'")


_HOME_MARKERS = (
    r"Good (Morning|Afternoon|Evening)|Your progress|Request diet plan"
    r"|View First Consultation|GOAL JOURNEY|Videos for you"
)


def _wait_user_home(u: Device, st: dict):
    """Get the user app to the Home tab. Handles: the first-run 'About
    Doctor' / quote overlays, and the NoDietWidget 'working on your plan'
    screen that p2 leaves the app on."""
    for _ in range(8):
        u.dismiss_overlays()
        nodes = u.dump()
        labels = " ".join(n.label for n in nodes if n.label)
        if re.search(_HOME_MARKERS, labels, re.I):
            return
        back = next((n for n in nodes if re.search(r"Back to Main Screen", n.label)), None)
        if back:
            u.tap(back)
            time.sleep(2)
            continue
        # bottom nav "Home" as a fallback
        h = next((n for n in nodes if re.fullmatch(r"Home(\s*/\s*Home)?", n.label.strip())), None)
        if h:
            u.tap(h)
        time.sleep(2)
    u.wait(desc=_HOME_MARKERS, timeout=40)


# ---- later phases are stubs until p1/p2 are green -----------------------
def p2_request_diet(u: Device, d: Device, st: dict):
    ident = st["identity"]
    u.launch(USER_PKG, wait_s=5)
    _wait_user_home(u, st)
    u.screenshot("20_home_before_request")

    # Home -> "Request diet plan". Start from the top of the scroll view,
    # then walk down to the button (it's below the progress + countdown
    # cards).
    time.sleep(3)  # let the request-status card resolve
    for _ in range(5):
        u.scroll_up(0.8)
    btn = u.scroll_to(r"Request diet plan|Request Diet Plan", max_swipes=6)
    u.tap(btn)

    # MainRequestDietPlanView - every field is prefilled from onboarding
    # except "Start Date for Diet" (required, date picker, firstDate =
    # tomorrow).
    u.wait(desc=r"Request Diet Plan", timeout=25)
    time.sleep(2)  # let the form settle before locating the date field
    u.screenshot("21_request_form")

    # Start Date field is a bare unlabelled View just below the app bar and
    # above the "Personal Information" heading, with a calendar icon on the
    # right. Descs are empty, so tap it by geometry and retry a couple of
    # spots. NEVER u.back() on failure here - that leaves the whole form.
    def _picker_open() -> bool:
        return bool(u.find(text=r"^OK$") or u.find(desc=r"^OK$"))

    def _open_start_date() -> bool:
        w, _h = u.size()
        for _ in range(5):
            nodes = u.dump()
            pi = next((n for n in nodes if re.search(r"Personal Information", n.label)), None)
            top = pi.bounds[1] if pi else 430
            # widest View strictly above the Personal Information heading
            band = [n for n in nodes if n.bounds[3] <= top and n.bounds[1] > 200
                    and (n.bounds[2] - n.bounds[0]) > 800]
            band.sort(key=lambda n: n.bounds[1])
            spots = []
            if band:
                cx, cy = band[0].center
                spots.append((cx, cy))
            spots.append((w // 2, (210 + top) // 2))   # geometric fallback
            # calendar icon near top-right
            icon = next((n for n in nodes if n.cls.endswith("ImageView")
                         and 200 < n.bounds[1] and n.bounds[3] < top
                         and n.bounds[0] > w * 0.75), None)
            if icon:
                spots.append(icon.center)
            for sx, sy in spots:
                u.tap_at(sx, sy)
                time.sleep(1.4)
                if _picker_open():
                    return True
            time.sleep(1)
        return False

    if _open_start_date():
        ok = u.find(text=r"^OK$") or u.find(desc=r"^OK$")
        u.tap(ok)
        time.sleep(1)
    else:
        note_gap(st, "p2_request_diet", "could not open the start-date picker")

    u.hide_keyboard()
    u.screenshot("22_request_filled")
    u.tap_button(r"^Select Plan$", timeout=20)
    time.sleep(3)
    _assert_no_form_error(u, "p2_request_diet", "request form")

    # RequestDietPlanScreen - tier tabs (Silver default) + a "Start Silver"
    # button on the plan card.
    u.wait(desc=r"^Start Silver$|Choose Golden|Includes", timeout=25)
    u.screenshot("23_plan_tiers")
    st["plan_tier"] = "Silver"
    u.tap_button(r"^Start Silver$", timeout=15)
    time.sleep(3)

    # Should land on NoDietWidget ("No diet assigned" / waiting) or a status
    # screen.
    landed = u.wait(desc=r"No diet assigned|Waiting|request.*sent|dietician|Back to Main|Good (Morning|Afternoon|Evening)", timeout=30)
    u.screenshot("24_request_submitted")
    log(f"diet request submitted (tier Silver); landed on: {landed.label!r}")
    st["diet_requested"] = True
    save_state(st)


def _diet_open_patient(d: Device, st: dict, phase: str):
    """From anywhere in the dietician app, land on the test patient's
    profile. Assumes the app is already logged in as dr.tejasvini."""
    name = st["identity"]["name"]
    # clean restart so we're on a known screen (the app may have been left
    # mid-wizard for another patient); the login session persists.
    d.stop(DIET_PKG)
    d.launch(DIET_PKG, wait_s=8)
    d.dismiss_overlays()
    # bottom nav: Home / Patients / Diet & Exercise / Performance / Chat
    d.tap_desc(r"^Patients$", timeout=40)
    time.sleep(1)
    d.screenshot(f"{phase}_patients_list")
    # tabs: Ongoing / New / Past - a just-signed-up + requested patient is "New"
    for tab in ("New", "Ongoing"):
        t = d.find(desc=rf"^{tab}$")
        if t:
            d.tap(t)
            time.sleep(1)
            search = d.find(cls="EditText")
            if search:
                d.set_field(search, name.split()[0])  # first token is enough
                time.sleep(1.5)
            card = d.find(desc=re.escape(name)) or d.find(desc=re.escape(name.split()[0]))
            if card:
                d.tap(card)
                d.wait(desc=r"Consultation|Create Diet Plan|Start First", timeout=20)
                d.screenshot(f"{phase}_patient_profile")
                return
    d.screenshot(f"{phase}_patient_not_found")
    raise RuntimeError(f"[{phase}] could not find patient {name!r} in the dietician app")


def p3_consult(u: Device, d: Device, st: dict):
    _diet_open_patient(d, st, "p3")

    # "Start First Consultation" opens QuestionsView in a bottom sheet
    start = d.scroll_to(r"Start First Consultation", max_swipes=8)
    d.tap(start)
    d.wait(desc=r"First Consultation", timeout=20)
    d.screenshot("30_consultation_form")

    # Dev-only "magic fill" (Icons.auto_fix_high, tooltip -> content-desc).
    # Fills every dietician-editable field via 2 Groq calls (~20-40s).
    magic = d.find(desc=r"fill with AI mock data")
    if not magic:
        note_gap(st, "p3_consult", "magic-fill button not found (release build?)")
        raise RuntimeError("[p3_consult] no magic-fill button - can't fill the 16-section form by hand")

    filled = False
    for attempt in range(2):
        d.tap(magic, settle=0.3)
        log(f"magic-fill tapped (attempt {attempt + 1}); waiting for Groq")
        deadline = time.time() + 75
        while time.time() < deadline:
            time.sleep(4)
            nodes = d.dump()
            labels = " ".join(n.label for n in nodes if n.label)
            if re.search(r"Mock fill failed|does not exist|model_not_found|DioException", labels):
                note_gap(st, "p3_consult", f"magic-fill failed: {labels[:200]}")
                d.screenshot(f"31_mockfill_fail_{attempt}")
                break
            # done when the wand is no longer a spinner and some field now
            # has a real value (an EditText with non-empty text)
            if not d.exists(desc=r"Filling|Generating") and any(
                n.cls.endswith("EditText") and (n.text or "").strip() for n in nodes
            ):
                filled = True
                break
        if filled:
            break
        magic = d.find(desc=r"fill with AI mock data")

    d.screenshot("31_consultation_filled")
    if not filled:
        note_gap(st, "p3_consult", "magic-fill did not populate the form")

    # Save - button is at the very bottom of a long (16-section) form
    save = d.scroll_to(r"Save Consultation", max_swipes=45, frac=0.85)
    d.tap(save)
    time.sleep(3)
    d.screenshot("31b_after_save")
    _assert_no_form_error(d, "p3_consult", "consultation form")
    d.wait(desc=r"Create Diet Plan|First Consultation information|Consultation", timeout=25)
    d.screenshot("32_consultation_saved")
    st["consultation_done"] = True
    save_state(st)
    log("first consultation saved (patient must now consent before diet creation)")


def p3b_patient_consent(u: Device, d: Device, st: dict):
    """After the dietician saves the First Consultation, the patient must
    open it, tick consent + sign, and submit - otherwise the wizard's
    'Create Diet Plan' stays locked ('Waiting for the patient to review...')."""
    u.launch(USER_PKG, wait_s=5)
    _wait_user_home(u, st)
    for _ in range(4):
        u.scroll_up(0.8)
    btn = u.scroll_to(r"View First Consultation", max_swipes=8)
    u.tap(btn)
    u.wait(desc=r"First Consultation|Consent & Confidentiality", timeout=20)
    time.sleep(1)
    for _ in range(8):
        u.scroll_up(0.9)
    u.screenshot("33_consent_form")

    # Consent & Confidentiality is the only editable section: one CheckBox
    # ("I consent") + one EditText (signature). Everything else on this
    # screen is the dietician's answers, shown read-only.
    cb = u.find(cls="CheckBox")
    if cb:
        u.tap(cb)
        time.sleep(0.5)
    else:
        note_gap(st, "p3b_patient_consent", "consent checkbox not found")

    ed = u.find(cls="EditText")
    if ed:
        u.set_field(ed, st["identity"]["name"])
        u.hide_keyboard()
    else:
        note_gap(st, "p3b_patient_consent", "signature field not found")

    u.screenshot("34_consent_filled")
    submit = u.find(desc=r"Submit Form", cls="Button")
    u.tap(submit)
    time.sleep(4)
    _assert_no_form_error(u, "p3b_patient_consent", "consent form")
    u.dismiss_overlays()
    u.screenshot("35_consent_submitted")
    st["patient_consented"] = True
    save_state(st)
    log("patient consent submitted; dietician can now create the diet plan")


def p4_create_diet(u: Device, d: Device, st: dict):
    _diet_open_patient(d, st, "p4")
    btn = d.scroll_to(r"Create Diet Plan|Resume Diet Plan", max_swipes=10)
    d.tap(btn)
    d.wait(desc=r"Targets|Context|Create Diet Plan", timeout=25)
    d.screenshot("40_wizard_start")

    def _continue():
        """Scroll the WizardFooter into view and tap its 'Continue'."""
        for _ in range(6):
            hit = d.find(desc=r"^Continue$")
            if hit and hit.bounds[3] <= d.size()[1]:
                d.tap(hit)
                time.sleep(1.5)
                return
            d.scroll_down(0.5)
        d.screenshot("CONTINUE_FAIL")
        raise UiTimeout(f"[diet] Continue not reachable")

    # The wizard may open on a read-only Context step first.
    if d.exists(desc=r"Context summary|read-only context") and d.exists(desc=r"^Continue$"):
        _continue()

    # Targets step - needs BOTH a calorie tier AND a macro option selected
    # before Continue enables (targets_step_controller.canContinue).
    d.wait(desc=r"Gentle|Steady|Calories", timeout=20)
    d.screenshot("41_targets")
    d.tap(d.wait(desc=r"^Steady$", timeout=8))
    time.sleep(1)
    d.scroll_down(0.5)
    macro = d.find(desc=r"^Balanced$") or d.find(desc=r"Balanced")
    if macro:
        d.tap(macro)
    else:
        note_gap(st, "p4_create_diet", "no macro card to select")
    time.sleep(1)
    d.screenshot("41b_targets_selected")
    _continue()

    # Generation step - auto-runs the backend AI menu build
    log("waiting for AI menu generation (can take a minute)")
    d.wait(desc=r"Plan generated|Version 1 of the diet|Add Recipe|No slot for this selection",
           timeout=240, poll=4)
    d.screenshot("42_generated")
    _continue()

    # Refine Portions - accept the AI portions as-is
    d.wait(desc=r"Refine|portion|per day|Continue", timeout=30)
    d.screenshot("43_refine")
    _continue()

    # Timeline - accept
    d.wait(desc=r"Timeline|supplement|Continue", timeout=30)
    d.screenshot("44_timeline")
    _continue()

    # Finalize - every day-group must be within +/-5% of the calorie target
    # (shown as green checks). The plan-item flow's button is "Finalize
    # Plan" (all weeks at once); the days-array flow's is "Finalize This Week".
    d.wait(desc=r"Review & Finalize|Review the generated week|Finalize Plan", timeout=25)
    d.screenshot("45_finalize")
    fin = (d.find(desc=r"Finalize Plan") or d.find(desc=r"Finalize This Week"))
    if not fin:
        note_gap(st, "p4_create_diet", "Finalize button missing - a day-group may be outside +/-5%")
        fin = d.scroll_to(r"Finalize Plan|Finalize This Week", max_swipes=8)
    d.tap(fin)
    time.sleep(3)
    # possible confirm dialog
    conf = d.find(desc=r"^Finalize$", cls="Button") or d.find(desc=r"^Confirm$")
    if conf:
        d.tap(conf)
        time.sleep(3)
    d.wait(desc=r"Weekly Diet Plans|Send Payment Request|finalized|Week 1", timeout=30)
    d.screenshot("46_finalized")
    st["diet_finalized"] = True
    save_state(st)
    log("diet plan finalized - all weeks generated")


def p5_payment_request(u: Device, d: Device, st: dict):
    _diet_open_patient(d, st, "p5")
    # if a request was already sent, the profile shows "AWAITING PAYMENT"
    # instead of the button - treat that as already-done.
    if d.exists(desc=r"AWAITING PAYMENT|Payment Update Received"):
        log("payment already requested (AWAITING PAYMENT)")
        st["payment_requested"] = True
        save_state(st)
        return
    btn = d.scroll_to(r"Send Payment Request", max_swipes=12)
    d.tap(btn)
    time.sleep(3)  # sendPaymentRequest fires directly + shows a toast
    d.screenshot("50_after_send")
    d.wait(desc=r"AWAITING PAYMENT|Payment Request Sent|Payment Update Received|Payment Information",
           timeout=25)
    d.screenshot("51_payment_requested")
    st["payment_requested"] = True
    save_state(st)
    log("payment request sent")


def _push_test_image(dev: Device) -> str:
    """Put a JPEG in the gallery so the payment-proof image picker has
    something to pick."""
    remote = "/sdcard/Pictures/e2e_proof.jpg"
    local = os.path.join(os.path.dirname(__file__), "artifacts", "_proof.jpg")
    if not os.path.exists(local):
        # a tiny valid JPEG
        import base64
        jpg = base64.b64decode(
            "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
            "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB"
            "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8AH//Z"
        )
        with open(local, "wb") as fh:
            fh.write(jpg)
    dev.adb("push", local, remote)
    dev.adb("shell", f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{remote}")
    return remote


def p6_user_pay(u: Device, d: Device, st: dict):
    _push_test_image(u)
    u.launch(USER_PKG, wait_s=5)
    _wait_user_home(u, st)
    for _ in range(5):
        u.scroll_up(0.8)
    u.screenshot("60_home_payment_pending")

    # Home shows a "Send Payment Details" action button once
    # requestStatus == 'PaymentRequested' (see home_view.dart).
    entry = u.scroll_to(r"Send Payment Details", max_swipes=6)
    u.tap(entry)
    time.sleep(2)
    u.dismiss_overlays()
    u.screenshot("61_payment_sheet")

    # PaymentStatusSheet: (1) upload proof image, (2) paid amount, (3) Send.
    up = u.scroll_to(r"Upload payment proof", max_swipes=4)
    u.tap(up)
    time.sleep(2.5)
    u.screenshot("61a_picker")
    # Android system photo picker (multi-select): tap our pushed test image,
    # then confirm with "Done".
    pic = (u.find(desc=r"Photo taken on Sep 3")
           or u.find(desc=r"Photo taken on"))
    if pic:
        u.tap(pic)
    else:
        note_gap(st, "p6_user_pay", "test image not in picker; tapping first cell")
        u.tap_at(int(u.size()[0] * 0.16), 1180)
    time.sleep(1.5)
    for _ in range(3):
        done = u.find(desc=r"^Done$") or u.find(desc=r"^Add$")
        if done:
            u.tap(done, settle=1.5)
        else:
            w, h = u.size()
            u.tap_at(int(w * 0.86), int(h * 0.925))  # bottom-right "Done"
        time.sleep(2)
        if u.exists(desc=r"Payment Status|Upload payment proof|Subscription Amount"):
            break
    u.wait(desc=r"Payment Status|Upload payment proof|Subscription Amount", timeout=15)
    u.screenshot("61b_after_upload")

    # paid amount (the sheet's first editable field)
    amt = str(st.get("plan_amount", "1500"))
    ed = u.scroll_to(r"amount you", max_swipes=4) if u.exists(desc=r"amount you") else None
    fields = [n for n in u.dump() if n.cls.endswith("EditText")]
    if fields:
        u.set_field(fields[0], amt)
        u.hide_keyboard()
    else:
        note_gap(st, "p6_user_pay", "paid-amount field not found")
    u.screenshot("62_payment_filled")

    send = u.scroll_to(r"Send Payment Details", max_swipes=6)
    u.tap(send)
    time.sleep(4)
    _assert_no_form_error(u, "p6_user_pay", "payment sheet")
    u.dismiss_overlays()
    u.screenshot("63_payment_submitted")
    st["payment_submitted"] = True
    save_state(st)
    log("payment proof submitted")


def p7_confirm_payment(u: Device, d: Device, st: dict):
    _diet_open_patient(d, st, "p7")
    if d.exists(desc=r"FULLY PAID"):
        log("payment already confirmed (FULLY PAID)")
        st["payment_confirmed"] = True
        save_state(st)
        return
    # once the patient has submitted, the profile shows "Payment Update
    # Received" which opens the dietician PaymentStatusSheet.
    entry = d.scroll_to(r"Payment Update Received|Review Payment update", max_swipes=12)
    d.tap(entry)
    time.sleep(2)
    d.screenshot("70_payment_sheet")
    d.wait(desc=r"Confirm Payment|Confirm & Activate", timeout=20)
    confirm = d.find(desc=r"Confirm & Activate Diet Plan") or d.find(desc=r"Confirm Payment")
    d.tap(confirm)
    time.sleep(4)
    d.screenshot("71_payment_confirmed")
    d.wait(desc=r"FULLY PAID|Payment confirmed|Plan activated|Ongoing", timeout=30)
    st["payment_confirmed"] = True
    save_state(st)
    log("payment confirmed; diet plan should activate")


def p8_verify_diet(u: Device, d: Device, st: dict):
    u.launch(USER_PKG, wait_s=5)
    _wait_user_home(u, st)
    # go to Diet & Exercise
    u.tap_desc(r"Diet & Exercise", timeout=25)
    time.sleep(2)
    got = u.wait(desc=r"Diet Plan|Breakfast|Lunch|Week 1|Morning Drink", timeout=40)
    u.screenshot("80_diet_plan_visible")
    log(f"diet plan visible on the patient app: {got.label!r}")
    st["diet_received"] = True
    save_state(st)


PHASES = [
    ("p1_signup", p1_signup),
    ("p2_request_diet", p2_request_diet),
    ("p3_consult", p3_consult),
    ("p3b_patient_consent", p3b_patient_consent),
    ("p4_create_diet", p4_create_diet),
    ("p5_payment_request", p5_payment_request),
    ("p6_user_pay", p6_user_pay),
    ("p7_confirm_payment", p7_confirm_payment),
    ("p8_verify_diet", p8_verify_diet),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", nargs="+", help="run only these phases")
    ap.add_argument("--from", dest="from_phase", help="run from this phase onward")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    names = [n for n, _ in PHASES]
    if args.list:
        print("\n".join(names))
        return
    if args.reset and os.path.exists(STATE_PATH):
        os.remove(STATE_PATH)
        print("state reset")

    selected = names
    if args.phase:
        selected = args.phase
    elif args.from_phase:
        selected = names[names.index(args.from_phase):]

    run_tag = datetime.now().strftime("%Y%m%d-%H%M%S")
    u = Device(USER_SERIAL, run_tag, "user")
    d = Device(DIET_SERIAL, run_tag, "diet")
    u.prep()
    d.prep()
    st = load_state()
    st["_run_tag"] = run_tag
    st["_gaps"] = []  # gaps are per-run
    save_state(st)

    for name, fn in PHASES:
        if name not in selected:
            continue
        log(f"===== {name} =====")
        try:
            fn(u, d, st)
            st.setdefault("_done", []).append(name)
            save_state(st)
        except Exception as e:
            u.screenshot(f"FAIL_{name}")
            d.screenshot(f"FAIL_{name}")
            log(f"XXXXX {name} FAILED: {e}")
            save_state(st)
            raise

    log("done")
    if st.get("_gaps"):
        print("\n--- gaps observed (tighten the script for these) ---")
        for g in st["_gaps"]:
            print(f"  [{g['phase']}] {g['note']}")


if __name__ == "__main__":
    main()
