# Targz Pen Plotter Control — Project Guide

## Repo

- GitHub: **TarGz/TargzPenPlotterCtrl** (renamed from `Targz-OpenBuilds-CONTROL`)
- Electron app. `index.js` is the main process, `app/` is served over HTTP by Express (port 3000 by default), `app/index.html` is the renderer entry.
- Downstream fork of `OpenBuilds/OpenBuilds-CONTROL` — legacy jQuery + Metro4 UI is still loaded, and the new "Command Deck" (CD) UI in `app/css/commanddeck.css` + `app/js/commanddeck.js` sits on top of it.

## Renderer constraints

- Node `require()` does NOT reliably resolve repo-root modules like `version.js` from renderer scripts, because the page is served via `http://localhost:3000/` (not `file://`). Use the `/api/version` endpoint instead (see `index.js`). Any version/changelog UI must fetch from there, never `require('../../version.js')`.
- Metro4 mutates DOM at load. Legacy sliders like `#jro`, `#fro`, `#tro` live off-screen at the bottom of `app/index.html` specifically so Metro4 can initialise them. Don't remove those stubs.

## Issue-driven workflow

- When user report a but using the BUG: bug description , append it with a short rewriting to the BUGS.md file in the current repo
- When USER ask for a feature  FEATURE: feature request description , append it with a short rewriting to the FEATURES-REQUEST.md file in the current repo
- Only commit when I ask
- USER is the one who tests — anything VISUAL is his to judge; Claude says what to test and what to check
- Any claude.md file, versioning ,etc Append AFTER the user validate the new behavoir of the app
- Never mention Claude Code in commits
- Never add Co-Authored-By lines to commits
- **Don't start the dev server, open a browser, or run browser tests — I do that.** Verify
  what can be verified headlessly (`node --check`, node harnesses for Rapier and opentype.js,
  both of which run fine outside a browser), then hand over with a concrete test list.


## BUG.md file template
# Bugs

This file tracks known bugs in the repo. Keep it up to date so any agent working on the code (Claude Code, etc.) knows the current state before making changes.

## How to use this file

- Add a new entry under **Open** when you find a bug.
- Keep descriptions short but precise and short, very close from the USER prompt, One title on short descritpion 100 char MAX
- Remove the entry once implemented — it's recorded in `version.js` and the commit, not here.

---

## Open

### Short title of the bug
100 char MAX



# FEATURES-REQUEST.md template

This file tracks feature requests in the repo. Keep it up to date so any agent working on the code (Claude Code, etc.) knows what's planned before making changes.

## How to use this file

- Add a new entry under **Open** when you think of a feature.
- Remove the entry once implemented — it's recorded in `version.js` and the commit, not here.
- Keep descriptions short but precise and short, very close from the USER prompt, One title on short descritpion 100 char MAX

---

## Open

<!-- Duplicate the block above for each new request -->
### Short title of the bug
100 char MAX


### Rules

1. **One issue per commit.** Do not batch fixes across issues into a single commit unless the user explicitly asks for it.
2. **Tag the issue in the commit.** Use `Fixes TarGz/TargzPenPlotterCtrl#N` (for bugs) or `Closes TarGz/TargzPenPlotterCtrl#N` (for features / enhancements) in the commit body. **Always use the full `owner/repo#N` form** — bare `#N` resolves against the upstream fork root (`OpenBuilds/OpenBuilds-CONTROL`), not this repo. One verb per line if multiple issues are legitimately inseparable.
3. **Pause for review between fixes.** After committing one issue's fix, stop and let the user test it before starting the next. The user will say "next" or name the next issue. Don't proactively chain through multiple issues without a pause — some fixes need hardware verification.
4. **Don't push automatically.** Committing is fine when the user asks; pushing to `origin` requires explicit authorization.

## Commit / version conventions

Every commit bumps `version.js` + `package.json` per semver. CHANGELOG entry in `version.js` leads with `Fix #N —` / `Closes #N —` prefixes so the history matches GitHub issue numbers.

- **XX** (Major) — breaking changes, architectural overhauls
- **YY** (Minor) — new features, non-breaking enhancements
- **ZZ** (Patch) — bug fixes, small tweaks

Commit subject pattern: `vX.Y.Z - short summary`. Body lists `Fixes TarGz/TargzPenPlotterCtrl#N` / `Closes TarGz/TargzPenPlotterCtrl#N` on their own lines.

Never mention Claude Code in commits. Never add `Co-Authored-By` lines.

## Development guidelines

- Only commit when the user asks.
- Don't add features, refactor, or introduce abstractions beyond what the task requires.
- Don't add error handling, fallbacks, or validation for scenarios that can't happen.
- Default to no comments. Only explain the non-obvious *why* (a hidden constraint, an invariant, a workaround).
- Prefer editing existing files to creating new ones.
- The Launch preview panel is not a valid way to test this UI — the app depends on Electron + Metro4 being fully loaded, which the preview doesn't provide. Verify in the actual Electron window.
