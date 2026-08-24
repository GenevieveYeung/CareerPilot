# Troubleshooting

## The browser does not open

Run `Open CareerPilot.bat` from the repository root. It locates the repository relative to the launcher, reuses a healthy local server, waits for `/api/health`, and then opens `http://127.0.0.1:8420/`.

## Materials are missing

Open the local settings file at `%LOCALAPPDATA%\CareerPilot\config\settings.json` and check `materials_root`. Do not edit historical application snapshot paths by hand. Use the Materials page to choose a folder and rescan it.

## Setup fails

Install a current Node.js LTS release and run `setup.bat` again. Setup does not modify the repository's private materials.
