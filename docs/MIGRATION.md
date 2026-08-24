# Data migration

Migration is copy-first and reversible:

- the existing runtime state and workbook are copied to `%LOCALAPPDATA%\CareerPilot\data`;
- the existing materials folder is kept in place unless the user explicitly chooses to move it;
- local `settings.json` records the configured Materials Root;
- a local `migration-map.json` records source, destination and SHA-256 checksums;
- the original repository data is not deleted by setup.

Use `scripts/migration/migrate_user_data_to_local_appdata.mjs` for a controlled migration. It refuses to overwrite an existing local settings file.

Historical application snapshots remain tied to their recorded file path and hash. A repository cleanup must not retarget them to a newer resume.
