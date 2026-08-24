# Release readiness — 2026-08-24

## Passed

- Cold start through `Open CareerPilot.bat`.
- `/api/health` ready and frontend loads.
- Dashboard, Jobs, Applications, Calendar and My pages load.
- My tabs remain six items in one order.
- Search template load and prompt generation.
- Application detail, resume controls and timeline controls.
- Existing data counts preserved: 48 jobs, 20 applications, 97 material versions, 36 application events.
- 142 materials copied and checksum-verified outside the repository; active paths resolve.
- Word and PDF material endpoints return 200 with the correct content type.
- Save Materials Root persists to local settings and survives a cold restart.
- Browser regression: console errors 0, request failures 0, bad responses 0.

## Deliberate boundary

The JSON runtime is the hot source of truth. Excel is a local mirror/download artifact. The optional Excel artifact package is not required for the core local dashboard; if it is unavailable, the runtime remains usable and the mirror step is skipped safely.

## Publishing checklist

- Review the full Git history before making the repository public; this working tree previously contained private CSVs in older commits.
- Keep `%LOCALAPPDATA%\CareerPilot`, the configured Materials Root and the external archive outside Git.
- Do not commit `.env`, credentials, screenshots, application records or real resume files.
