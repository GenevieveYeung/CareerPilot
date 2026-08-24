# CareerPilot Architecture

CareerPilot is a local-first job application workspace. The repository contains program code; the current user's state, materials, logs and credentials live outside the repository.

## Runtime boundaries

```text
Repository
  ├─ dashboard/        local HTTP UI and API
  ├─ core/             state, profile, reminders and persistence services
  ├─ config/           safe defaults and examples
  ├─ scripts/          setup and migration tools
  └─ tests/            synthetic fixtures and regression tests

Windows user data
  %LOCALAPPDATA%\CareerPilot\
  ├─ config/settings.json
  ├─ data/state/careerpilot_state.json
  ├─ data/runtime/careerpilot_runtime.xlsx
  ├─ materials/        default; user may choose another folder
  ├─ logs/
  └─ secrets/          DPAPI-protected SMTP credential
```

`core/project_paths.cjs` is the single path resolver. Services must not reconstruct user-data paths from `__dirname`, the current working directory, or a machine-specific absolute path.

Existing materials may remain in a user-selected external folder. A migration records that folder in local settings rather than copying or rewriting personal files unnecessarily.

## Data flow

```text
Company → Job → Application → Application Event
Profile + Resume Library → Application
Dashboard / Calendar / Reminder → views of Application and Application Event
```

The runtime state is the hot source used by the UI. The Excel file is a local mirror/backup, not a second independently edited database.
