---
name: careerpilot
description: "A reusable job application workflow for Codex and other AI agents. Use when a user wants to set up or run an AI-assisted job search system: collecting a candidate profile, creating an application dashboard, defining screening and resume-routing rules, strict-copy tailoring from a user-approved resume library, finding and ranking job leads, applying to jobs within explicit safety boundaries, recording outcomes, triaging blockers, or iterating a job application workflow."
---

# CareerPilot

CareerPilot is a job application operating workflow for AI agents. It helps users turn job searching into a repeatable system: profile, dashboard, screening rules, resume strategy, application execution, blocker triage, and follow-up.

## Canonical layout (fixed)

This workspace is operated as CareerPilot. These locations are authoritative:

- `dashboard/` — active frontend, backend and API code only.
- `%LOCALAPPDATA%\CareerPilot\data\` — live job, application, event, profile and reminder state.
- User-selected Materials Root — source and application-ready resumes/materials.
- `%LOCALAPPDATA%\CareerPilot\logs\` — local operational logs.
- External archive — legacy copies, private backups and historical audits; read-only.

Fixed operating rules:

1. Never create a second live tracker outside the CareerPilot runtime state.
2. Never copy candidate facts or private materials into the public repository.
3. Every application attempt gets exactly one Application record and a traceable event/snapshot.
4. Search by company plus job URL or requisition ID before adding a row; update an existing row instead of duplicating it.
5. Missing links, dates, materials, or eligibility facts remain blank or `Needs user`; never infer them.
6. `Submitted` requires explicit user confirmation or visible employer confirmation.
7. Do not move, rename, overwrite, or delete original application materials.
8. Treat the external archive as read-only history and never write new applications there.
9. Any row with `current_validity` starting with `Expired` or `Expired /` is historical only: exclude it from active pending lists and calendar views, and never recommend applying from it.
10. Any open follow-up linked to an expired row must be hidden from the calendar; do not create a new follow-up for it.

When an older instruction conflicts with this section, this section controls file location and record format.

## Core Contract 

Optimize for truthful, traceable, interview-generating applications, not blind volume.

Treat setup as an agent-led onboarding flow, not a user homework packet. Ask only for the minimum information needed to start safely, create drafts/templates for the user, then iterate after the first trial run.

Before searching or applying, make sure the user has:

1. A candidate profile.
2. A dashboard or workbook for tracking outcomes.
3. Application screening rules.
4. A resume strategy.
5. Clear safety boundaries for browser automation and form answers.

If any source is missing, initialize it first. Do not guess identity, legal, work authorization, compensation, current employment, sponsorship, relocation, or other high-impact facts.

## Workflow

### 1. Initialize the System

Read `docs/FIRST_RUN.md` and `docs/ARCHITECTURE.md` when:

- The user is installing CareerPilot for the first time.
- The user asks to create a profile, dashboard, rules, templates, or GitHub-ready setup.
- The user has not provided enough information for safe applications.

Use the safe examples in `config/` and `tests/fixtures/`; create user-owned files only under the local CareerPilot data root:

- `candidate_profile.template.json`
- `application_rules.template.md`
- `resume_routing.template.md`
- `answer_bank.template.md`
- `experience_bank.template.md`
- `dashboard-template/*.csv`

### 2. Confirm the Company and Research the Opening

When the user names a specific company (or you're evaluating one you found), work it one company at a time:

- Check whether the company already has a row in `job_pool`. If not, add one (role family, target city, etc.) before doing anything else — every company you touch should be traceable in the dashboard.
- Confirm whether the target class/届 recruiting cycle is actually open, not just "the company has a careers page." Search the company's own official site/campus portal first for the specific application entry point (not just the homepage). Cross-check with a general web search to corroborate posting dates and see if the role is still live.
- Watch for the "internship confirmed, full-time not confirmed" trap and the "届/year label doesn't match the actual eligibility window" trap — both have burned real trials. Don't mark a role as confirmed-open on a hedge-word search summary; write down the actual eligibility text.
- Write findings back into `job_pool` immediately (job_url, next_action, notes, and a status update if warranted) — don't hold research in your head until the end of the session.
- If you add a structured status column to `job_pool` for tracking a specific recurring question (e.g. whether a hiring cycle is confirmed open), set it explicitly every time you finish checking a row rather than leaving the dashboard to infer it from free-text `notes` — notes-based regex guessing quietly rots into false positives once notes get detailed. A stale structured column means the dashboard won't reflect what you just learned, even after a refresh.

### 3. Screen Before Applying

Prioritize jobs by freshness, fit, feasibility, and conversion likelihood. Default to fresh jobs from the last 24 hours, then 48 hours if needed.

Skip or defer roles that violate the user's rules, are clearly overleveled, are closed or duplicate, require unsupported work authorization, need missing materials, or involve long account-heavy flows with weak fit.

### 4. Shortlist Specific Positions and Let the User Choose

Once a company's opening is confirmed, don't jump straight to filling out a form. Find the *specific* postings that match the user's target role families (search the portal by keyword — job categories on a careers site often don't literally say "supply chain" even when a matching role exists) and present a short list: title, one-line fit summary, level/eligibility, location, and whether it's full-time campus recruiting (not an internship or a stale prior-cycle posting).

If a company limits applicants to one or two total submissions in the cycle, say so before the user picks — it changes the decision. Let the user pick which posting to pursue; only proceed on your own initiative if the user has already named the exact posting.

### 5. Match Experience to the Role

Before touching the application, decide which of the candidate's experiences to actually feature for this specific posting — this is a separate decision from which resume file to use.

- Check the user's local experience/profile records for the target role family's candidate pool; never place those facts in a public fixture.
- Read this posting's actual JD and pick 2-4 experiences from that candidate pool that best fit it — favor `强` matches, but a `中` match that happens to hit something the JD specifically calls out can outrank a `强` match that doesn't. If the JD emphasizes something the whole pool underrepresents, pull in a different experience from the full inventory instead of forcing a weak fit.
- **Before using them, tell the user which experiences (internships and projects) were selected for this application and why.** Keep it short (a list of names + one-line reasoning), but always surface it as a checkpoint — don't silently pick and move on.
- Use the selected 2-4 experiences — not the full inventory — when answering resume-adjacent free-text fields: "relevant experience/project" custom questions, self-evaluation/cover-letter fields (synthesize personality + the selected experiences + this specific company/role fit; don't dump a generic bio), and Precision-mode resume content selection/order. Approved resume bullets remain verbatim under STRICT COPY MODE.
- After submitting, note which experiences were actually used in the local Application record — this lets a later application to a similar role or company reuse the same reasoning instead of re-deriving it.
- Same truthfulness rule as everywhere else: under STRICT COPY MODE, select and order complete approved content only; never invent, exaggerate, stretch, or rewrite an experience to make it look like a better fit. If nothing in the bank fits well, say so and use the closest honest match.

### 6. Route the Resume Strategy

Use the user's chosen strategy:

- Precision mode: screen for high-fit jobs first, then tailor resume/materials before applying.
- Volume mode: use prebuilt resume variants by role family and move quickly.

Default to Volume mode unless the user explicitly asks for Precision. Individual high-fit roles can be promoted from Volume to Precision.

Never fabricate experience, credentials, degrees, employers, dates, work authorization, or portfolio artifacts.

### 6A. HARD REQUIREMENT — Approved Resume Library / STRICT COPY MODE

This rule overrides any older instruction that permits an agent to rewrite, polish, paraphrase, shorten, expand, keyword-align, or otherwise improve an approved resume bullet. For any custom resume, the default operation is **SELECT + COPY + REORDER + COMBINE**, never rewrite.

The user's **Approved Resume Library** (resumes the user has explicitly marked as satisfied/approved) is the only primary content source for tailored resumes. A raw folder scan, draft, half-finished file, automatically generated file, unconfirmed version, or archived/obsolete file is not an approved source merely because it exists. If approval status is unknown, treat the material as unapproved and ask the user or use an already-approved alternative.

In default **STRICT COPY MODE**:

- Copy every selected bullet or block in full, verbatim, from one identifiable approved source. Never splice fragments from different bullets or sources.
- Do not paraphrase, polish, shorten, expand, change verbs, replace synonyms, merge bullets, split bullets, rewrite metrics, add ATS keywords, optimize grammar, or optimize style.
- Do not invent bullets, facts, skills, metrics, tools, responsibilities, projects, dates, credentials, or outcomes. Skills may only be selected, removed, or reordered from approved skills/facts.
- Allowed operations are selecting relevant complete blocks, deleting irrelevant approved content, reordering complete blocks/bullets, swapping a complete project or experience block, and combining complete blocks from multiple approved resumes.
- If the JD has no direct match in the Approved Resume Library, say so and use the closest honest approved content only; never create a new claim to fill the gap.

One-page handling must not be solved by rewriting. For an exactly one-page A4 resume, remove lower-priority approved bullets/projects, use an existing shorter approved variant, reduce the number of complete approved blocks, or adjust permitted spacing while preserving the chosen template. If the page has spare space, add only another relevant approved block or leave the space blank.

Keep **content reference** and **format template** separate. A resume can be approved for content, format, or both. When a user selects a DOCX format template, copy that DOCX first and perform selection/reordering inside the copy; do not recreate the layout in a new document. Preserve page geometry, typography, margins, section order, spacing, bullet style, header, footer, tab stops, and visual hierarchy unless the user explicitly authorizes a redesign.

Every generated resume is a **Draft** until the user explicitly marks it as “加入满意简历” / approved. It must never be promoted automatically. Generate a Source Report recording the target job, format template, each selected experience/project/bullet, its exact source file, and `Copied verbatim: YES/NO`. In STRICT COPY MODE, every selected content item must be `YES`; if any item cannot be traced, stop and ask rather than silently generating it.

Material rules:

- Use only confirmed facts and approved source-CV content. A detailed master CV may help locate a fact, but it is not an approved content source unless the user explicitly approves it.
- Default draft CV filename: `<Candidate Name>_CV_<Company>_<Role>_Draft.docx`; application-ready PDF may use the corresponding company/role name. Do not hide the Draft state from the user.
- Default cover-letter filename: `<Candidate Name>_Cover_Letter_<Company>.pdf`.
- Deliver application-ready CVs and cover letters as PDF by default. Keep an editable DOCX working copy for a draft when needed; do not overwrite source files.
- CV and cover letter must each fit on exactly one page unless the user explicitly requests otherwise. Render the DOCX to PDF and verify exactly one A4 page, readable/selectable text, no clipping or overflow, and preserved template formatting before presenting it.
- Cover letters remain a separate writing task; do not treat a drafted cover letter as permission to rewrite approved resume bullets.

For finance, AI/ML, data, graduate/MT, or hybrid roles, choose the most relevant approved resume(s) and complete approved blocks; do not borrow or rewrite unsupported material. Before generating a draft, report the selected approved sources and why. After generating, report the Source Report and keep the result in Draft status for the user's wording edits and approval.

### 7. Fill Out the Application

Read `docs/SECURITY.md` before operating browser-based applications or ATS flows.

Prefer uploading the resume first and letting the ATS auto-parse it — it's less error-prone than hand-typing education/experience. Fill only from the user's local Profile, Resume Library and Answer Bank. Stop and ask the user (don't guess) for anything on the `never_guess` list or anything the form surfaces that isn't backed by the résumé or profile.

Stop or hand off for CAPTCHA, Cloudflare, anti-bot checks, login or 2FA, unclear legal/identity questions, missing files, payment prompts, permission prompts, or anything that would require bypassing a site control.

### 8. Preview, User Confirms, Submit

Before the final submit click, show the user a summary (company, role, resume version, the internship/project experiences selected in step 5, key answers, compensation figures). **Do not click final submit until the user explicitly says to** — a preview screen is not consent. After submitting, look for real confirmation evidence (success text, a thank-you/confirmation URL, a candidate ID) before recording anything as `Submitted`.

### 9. Sync Everything — Dashboard and Profile

Every job lead or attempt must end in one of these states:

- `Submitted`: explicit confirmation was seen.
- `Skipped`: not worth applying, with reason.
- `Blocked`: automation could not proceed, with blocker and next step.
- `Needs user`: user must provide a missing high-impact fact, complete CAPTCHA/login/upload, answer a sensitive question, or make a required judgment before the agent can decide.
- `Pending`: selected for later action because it appears worth reviewing or applying after known prerequisites are satisfied.

Count only confirmed submissions. Saved jobs, trackers, autofill badges, or "quick apply" labels do not count.

For a first trial or demo run, default to lead finding only: find, screen and classify without opening real application flows or submitting anything. Record only synthetic test data in public fixtures.

For a real submission, update the local Application record, Application Event timeline and submitted-resume snapshot, and ask before writing any newly confirmed stable fact back to the local Profile.

When recording a submission, preserve the official URL and evidence in the local Application record; do not copy private application history into public fixtures.

### 10. Learn From Blockers

After each run, summarize blockers and convert repeated issues into rules. CareerPilot should improve through use: address matching, dropdown handling, resume upload checks, account/session checks, and ATS-specific lessons belong in the dashboard and rules.

## Safety

Read `docs/SECURITY.md` when the user asks about automation limits, CAPTCHA, email verification, account login, privacy, public sharing, or what should not be included in a repo.

Do not publish or copy private resumes, phone numbers, emails, addresses, immigration documents, application history, browser sessions, cookies, OTPs, or user-specific secrets into a public CareerPilot package.
