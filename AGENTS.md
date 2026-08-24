# CareerPilot Handover Instructions

This is the primary active CareerPilot job-search workspace after migration from ApplyPilot.

Legacy identifiers such as `ApplyPilot` may remain in archived records and rollback material. `CareerPilot` is the active product identity.

- Follow `SKILL.md` and the current `docs/` instructions.
- Use `%LOCALAPPDATA%\CareerPilot\data\state\careerpilot_state.json` as the single active job universe for the product UI; the Excel file is a local mirror and CSV files are local migration/export artifacts, not a second independently edited database.
- Preserve historical rows and statuses. Do not treat migrated rows as new discoveries.
- Use the local runtime state for Applications, Application Events, Profile, Preferences, Search Templates, Trash and audit history. Preserve private evidence and migration backups outside the public repository.
- Use the local Profile, Preferences and Resume Library as the migrated source of truth.
- Verify the current official posting and complete JD before opening each application flow.
- `cohort_match_status` and `current_stage` are blank unless supported by later evidence; never infer them from historical notes.
- Legacy ApplyPilot material is archive/rollback data, not a second active database.
- Current scope remains lead finding and truthful tracking only unless the user later changes authorization; do not submit applications or modify source CVs without explicit authorization.
