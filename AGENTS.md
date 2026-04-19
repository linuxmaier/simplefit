# Agent Guide — SimpleFit

> **Note:** `CLAUDE.md` is a symlink to this file (`AGENTS.md`). All edits should be made directly to `AGENTS.md`.

## Project overview

A mobile-first PWA personal health tracker hosted on GitHub Pages. No build step — vanilla ES modules served directly from `public/`. IndexedDB for local storage, Google Drive (appDataFolder) for cloud backup.

The app is organized into three **modes** (Exercise, Nutrition, Health), selected via a persistent segmented control in the header. Exercise and Health are live; Nutrition is a placeholder.

- **App name:** SimpleFit
- **Live URL:** `https://linuxmaier.github.io/simplefit/`
- **Repo:** `git@github.com:linuxmaier/simplefit.git`

## File structure

```
public/
  index.html      App shell (loads app.js as type="module")
  app.js          Main SPA — all views, state, UI logic (~2250 lines)
  db.js           IndexedDB layer — all persistence
  drive.js        Google Drive integration (GIS implicit OAuth flow)
  style.css       Light/cream mobile-first theme with dark mode (CSS custom properties)
  sw.js           Service worker — offline cache
  manifest.json   PWA manifest (name: "SimpleFit")
  icon.svg        Dumbbell SVG icon on indigo background
eslint.config.js  ESLint 9 flat config (browser globals, double quotes, semi, 2-space indent)
package.json      npm scripts: lint, lint:fix
.github/
  workflows/
    deploy.yml    lint → deploy (deploy requires lint to pass)
    lint.yml      lint on push/PR
```

## Architecture

### No build step
All `public/` files are served verbatim by GitHub Pages. **Use relative paths everywhere** — absolute paths like `/style.css` resolve to the domain root, not the `/simplefit/` subdirectory.

### SPA pattern
`app.js` renders all views imperatively into `<main id="main">` by building HTML strings and assigning to `el.innerHTML`. There is no framework.

### `window.app` — inline onclick handlers
Because views are built with HTML strings containing `onclick="app.foo()"`, all callable functions must be exported on `window.app` at the bottom of `app.js`. If you add a new function that is called from inline HTML, add it to the `window.app` object.

### Modes
Top-level mode is tracked in `currentMode` (module scope) and persisted in `localStorage["currentMode"]`. The header shows a segmented control (`#mode-switcher` → `renderModeSwitcher()`) that switches modes via `setMode(mode)`. Each mode has its own bottom-nav tab set returned by `tabsForMode(mode)`. `Settings` is a shared tab available in every mode.

Modes: `"exercise"` (default), `"health"`, `"nutrition"` (placeholder only — no DB stores).

### Views (currentView state)
| Mode | Value | Render function |
|---|---|---|
| exercise | `home` | `renderHome` |
| exercise | `workout` | `renderWorkout` |
| exercise | `routines` | `renderRoutines` |
| exercise | `log` | `renderLog` |
| exercise | `exercise-history` | `renderExerciseHistory` |
| exercise | `edit-session` | `renderEditSession` |
| health | `health-today` | `renderHealthToday` |
| health | `health-metrics` | `renderHealthMetrics` |
| health | `health-metric` | `renderHealthMetricDetail` |
| nutrition | `nutrition-home` | `renderNutritionHome` |
| all | `settings` | `renderSettings` |

Navigate with `navigate(viewName)` — sets `currentView`, re-renders mode switcher, nav and view. The page-title `<h1>` has been replaced by the mode switcher; views render their own section titles in-body.

## Data model (IndexedDB)

DB name: `exercise-tracker`, version 2. All stores use `{ keyPath: "id", autoIncrement: true }`. The `onupgradeneeded` handler uses `objectStoreNames.contains()` guards so existing data survives v1→v2 upgrades.

### v1 (Exercise) stores
| Store | Key fields | Notes |
|---|---|---|
| `routines` | id, name, notes, updatedAt | |
| `exercises` | id, name, muscleGroup, type, notes, updatedAt | unique index on `name`; `type` is `"weight"` (default) or `"timed"` |
| `routineExercises` | id, routineId, exerciseId, exerciseName, defaultSets, defaultReps, defaultWeight, defaultDuration | join table; `defaultDuration` (seconds) used for timed exercises |
| `sessions` | id, routineId, routineName, date, completedAt | open session has no `completedAt` |
| `sessionExercises` | id, sessionId, exerciseId, exerciseName, type, sets, reps, weight, duration, setsCompleted, completed, routineExerciseId | `setsCompleted` tracks per-set progress (0..sets); `duration` in seconds for timed exercises; `routineExerciseId` links back to routine defaults (null for ad-hoc) |

### v2 (Health) stores
| Store | Key fields | Notes |
|---|---|---|
| `healthMetrics` | id, name, kind, unit, builtin, updatedAt | unique index on `name`; `kind` is `"numeric"` / `"dual"` / `"duration"`; `builtin: true` means seeded (Blood Pressure, Weight, Sleep) and cannot be deleted |
| `healthReadings` | id, metricId, date (YYYY-MM-DD), recordedAt (ISO), value OR valueSystolic/valueDiastolic, notes, source, externalId | `source: "manual"` today; `externalId` reserved for future device ingestion dedup; pick `value` for numeric/duration metrics, `valueSystolic` + `valueDiastolic` for `dual` |

On first entry into Health mode, `ensureHealthSeeded()` inserts the three built-in metrics if the store is empty. Built-ins can be renamed (on non-built-ins only — built-in name is read-only in the edit modal) and their unit/kind edited, but cannot be deleted.

**Critical:** Never pass `id: undefined` to `db.*.save()` — IDB throws a DataError. Omit the `id` field entirely for new records: `{ name: "foo" }` not `{ id: undefined, name: "foo" }`.

**exercises.name is unique.** Attempting to save a duplicate name throws a ConstraintError — catch it and show a user-friendly message.

### db.js API
```js
db.routines.list()                    // → Promise<Routine[]>
db.routines.get(id)                   // → Promise<Routine>
db.routines.save(record)              // upsert — returns key
db.routines.delete(id)

db.exercises.*                        // same shape
db.routineExercises.listForRoutine(routineId)
db.routineExercises.get(id)
db.routineExercises.save(record)
db.routineExercises.delete(id)

db.sessions.list()
db.sessions.get(id)
db.sessions.save(record)
db.sessions.delete(id)

db.sessionExercises.listForSession(sessionId)
db.sessionExercises.listForExercise(exerciseId)
db.sessionExercises.save(record)
db.sessionExercises.delete(id)

db.healthMetrics.list()
db.healthMetrics.get(id)
db.healthMetrics.save(record)
db.healthMetrics.delete(id)

db.healthReadings.list()
db.healthReadings.listForMetric(metricId)
db.healthReadings.get(id)
db.healthReadings.save(record)
db.healthReadings.delete(id)

db.exportAll()   // → full backup object (all v1 + v2 stores)
db.importAll(data)  // clears all stores, then restores
```

**When adding new stores:** update both `exportAll()` and `importAll()` in `db.js` — the store list in each is hardcoded and new stores will silently be excluded from backups otherwise.

## Drive integration (drive.js)

- **Scope:** `https://www.googleapis.com/auth/drive.appdata` (appDataFolder — hidden from user's Drive UI)
- **Token persistence:** Stored in `localStorage` under key `"driveToken"` as `{ token, expiresAt }`. Loaded on boot via `loadSavedToken()` with a 60-second expiry buffer.
- **Client ID:** Stored in `localStorage` under `"gClientId"` — user enters it in Settings.
- **Backup conflict detection:** `localStorage["driveLastBackup"]` stores ISO timestamp of last backup from this device. On boot, `checkDriveOnOpen()` compares Drive's `modifiedTime` against the local last session activity time to decide whether to prompt a restore.

### drive.js API
```js
drive.setClientId(id)
drive.isConfigured()      // clientId set?
drive.isSignedIn()        // accessToken in memory?
drive.initDrive()         // → Promise<bool> (true = restored saved token)
drive.signIn()            // → Promise (opens consent popup)
drive.signOut()           // revokes token, clears localStorage
drive.silentRefresh()     // → Promise<bool>
drive.backupToDrive(jsonData)    // → Promise (multipart upload)
drive.restoreFromDrive()         // → Promise<parsedJSON>
drive.getDriveModifiedTime()     // → Promise<ISOString | null>
```

## UI patterns

### Inline ⋮ context menus
Tapping ⋮ calls `toggleMenu(menuId)` which toggles `.hidden` on the corresponding `<div class="inline-actions hidden" id="menu-{menuId}">`. Only one menu is open at a time — `openMenuId` tracks the current open menu.

Menu ID naming:
- Routine card: `menu-routine-{routineId}` → `app.routineMenu(routineId)`
- Routine exercise row: `menu-re-{routineExerciseId}` → `app.routineExerciseMenu(id)`
- Standalone exercise row: `menu-exercise-{exerciseId}` → `app.exerciseMenu(id)`

### Collapsible routine cards
`expandedRoutines` (Set) tracks which routine IDs are expanded. `toggleRoutine(id)` shows/hides `#routine-body-{id}` and flips `#routine-chevron-{id}`.

### Modals
Bottom-sheet modals: set `modal.innerHTML`, then `backdrop.classList.remove("hidden")`. Close with `closeModal()`. Active modal state: `editingRoutineId`, `editingExerciseId`, `editingSessionId`, `pickerCallback`.

**Picker callback gotcha:** `closeModal()` clears `pickerCallback`. Always capture the callback before closing: `const cb = pickerCallback; closeModal(); if (cb) { cb(result); }`

### Set progress bar
Each exercise in the active workout shows a segmented progress bar (one segment per set). Tapping a segment fills all segments up to that point (sequential fill). Tapping the last filled segment undoes it. When all segments are filled, the exercise is marked complete. Implemented via `tapSet(exId, setNum)` and rendered by `renderSetBar(ex)`.

### Exercise types
Exercises have a `type` field: `"weight"` (default, reps-based) or `"timed"` (duration-based). Timed exercises show a countdown timer with Start/Stop controls in the workout view. The timer auto-completes the current set when it reaches zero, with vibration + a system notification (if enabled). Timer state is ephemeral (`activeTimer` in module scope) — not persisted to DB.

### Notifications
Web Notifications API is used for timer completion alerts. Permission is requested from the Settings page and stored as `localStorage["notificationsEnabled"] = "true"`. `notificationsEnabled()` checks both the permission state and the localStorage flag. If a session contains timed exercises and notifications are not enabled, a banner is shown in the workout view linking to Settings. Key functions: `requestNotificationPermission()`, `disableNotifications()`, `playAlert()`. Notifications are shown via `ServiceWorkerRegistration.showNotification()` (required on Android and iOS PWA, where `new Notification()` throws), with a `new Notification()` fallback for desktop browsers without a service worker.

### Update routine defaults prompt
When a user edits sets/reps/weight/duration inline during a workout, `saveInlineEdit` compares the new values against the routine exercise defaults (via `routineExerciseId`). If they differ, an action toast appears offering to update the routine defaults. This only applies to exercises that came from a routine (not ad-hoc adds).

### Toast notifications
`toast(msg)` — 2.5 s auto-dismiss. `actionToast(html)` — HTML-capable toast with interactive buttons, 6 s auto-dismiss, pointer events enabled.

### HTML escaping
Always use `esc(str)` when interpolating user-supplied strings into HTML. Defined in app.js.

## Linting

```bash
npm run lint        # check
npm run lint:fix    # auto-fix
```

ESLint 9 flat config in `eslint.config.js`. Rules: double quotes, semicolons, 2-space indent. `google` is a readonly global (GIS). Fix all errors before pushing — the deploy workflow requires lint to pass.

## Service worker / caching

`sw.js` caches all static assets under `CACHE = "simplefit-v5"`. **Bump the cache name whenever cached assets change** — both when adding new files to the ASSETS array and when you want returning users to pick up bugfixes in cached JS/CSS. Otherwise the old service worker will serve stale files. Google API requests are passed through (not cached).

## Deployment

Push to `main` → GitHub Actions runs lint → on success, deploys `public/` to GitHub Pages. No manual steps needed.
