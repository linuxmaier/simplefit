import * as db from "./db.js";
import * as drive from "./drive.js";

// ─── State ───────────────────────────────────────────────────────────────────

let currentMode = "exercise"; // "exercise" | "nutrition" | "health"
let currentView = "home";
let activeSession = null; // { session, exercises: [sessionExercise & exerciseName] }
let activeTimer = null; // { exId, setNum, remaining, intervalId }
let viewingMetricId = null; // active metric in health-metric detail view

const DRIVE_LAST_BACKUP_KEY = "driveLastBackup";
const CURRENT_MODE_KEY = "currentMode";

// ─── Modes ───────────────────────────────────────────────────────────────────

const MODES = [
  { id: "exercise",  label: "Exercise"  },
  { id: "nutrition", label: "Nutrition" },
  { id: "health",    label: "Health"    },
];

function tabsForMode(mode) {
  switch (mode) {
  case "exercise":
    return [
      { id: "home",     icon: "home",      label: "Home" },
      { id: "routines", icon: "dumbbell",  label: "Routines" },
      { id: "log",      icon: "history",   label: "Log" },
      { id: "settings", icon: "settings",  label: "Settings" },
    ];
  case "health":
    return [
      { id: "health-today",   icon: "heart-pulse", label: "Today" },
      { id: "health-metrics", icon: "activity",    label: "Metrics" },
      { id: "settings",       icon: "settings",    label: "Settings" },
    ];
  case "nutrition":
    return [
      { id: "nutrition-home", icon: "utensils", label: "Food" },
      { id: "settings",       icon: "settings", label: "Settings" },
    ];
  default:
    return [];
  }
}

function defaultViewForMode(mode) {
  return tabsForMode(mode)[0].id;
}

function setMode(mode) {
  if (mode === currentMode) { return; }
  currentMode = mode;
  localStorage.setItem(CURRENT_MODE_KEY, mode);
  navigate(defaultViewForMode(mode));
}

function renderModeSwitcher() {
  const host = document.getElementById("mode-switcher");
  if (!host) { return; }
  host.innerHTML = MODES.map((m) => `
    <button class="seg-btn ${currentMode === m.id ? "active" : ""}" role="tab" aria-selected="${currentMode === m.id}" onclick="app.setMode('${m.id}')">${m.label}</button>
  `).join("");
}

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  // Apply saved theme before first render (default: light)
  const savedTheme = localStorage.getItem("appTheme") || "light";
  if (savedTheme === "dark") {
    document.documentElement.dataset.theme = "dark";
  }

  // Restore last-used mode
  const savedMode = localStorage.getItem(CURRENT_MODE_KEY);
  if (savedMode && MODES.some((m) => m.id === savedMode)) {
    currentMode = savedMode;
  }

  await db.openDB();

  // Restore Google Client ID and saved token if available
  const savedClientId = localStorage.getItem("gClientId");
  if (savedClientId) {
    drive.setClientId(savedClientId);
    // initDrive restores the saved token immediately if still valid.
    // We defer the GIS-dependent call until google is loaded.
    const tryInit = async () => {
      try {
        const signedIn = await drive.initDrive();
        if (signedIn) {
          localStorage.removeItem("driveReconnectNeeded");
        } else {
          localStorage.setItem("driveReconnectNeeded", "1");
        }
      } catch {
        localStorage.setItem("driveReconnectNeeded", "1");
      }
    };

    if (window.google) {
      await tryInit();
    } else {
      // GIS not loaded yet — wait for it then init in the background
      const interval = setInterval(async () => {
        if (window.google) {
          clearInterval(interval);
          await tryInit();
          // Re-render home to update the reconnect banner if needed
          if (currentView === "home") { renderView(); }
        }
      }, 100);
    }
  }

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // Check for in-progress session
  const allSessions = await db.sessions.list();
  const open = allSessions.find((s) => !s.completedAt);
  if (open) {
    activeSession = await loadActiveSession(open.id);
  }

  // If signed in to Drive, check whether Drive has a newer backup
  if (drive.isSignedIn()) {
    await checkDriveOnOpen();
  }

  renderModeSwitcher();
  renderNav();
  renderHeaderIcons();
  navigate(defaultViewForMode(currentMode));
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigate(view) {
  currentView = view;
  renderModeSwitcher();
  renderNav();
  renderHeaderIcons();
  renderView();
}

function renderNav() {
  const tabs = tabsForMode(currentMode);

  document.getElementById("nav").innerHTML = tabs
    .map(
      (t) => `<button class="${currentView === t.id ? "active" : ""}" onclick="app.navigate('${t.id}')">
        <i data-lucide="${t.icon}"></i>${t.label}
      </button>`
    )
    .join("");

  if (window.lucide) { lucide.createIcons(); }
}

function renderHeaderIcons() {
  const reconnectNeeded = localStorage.getItem("driveReconnectNeeded");
  const clientConfigured = localStorage.getItem("gClientId");
  const signedIn = drive.isSignedIn();

  const cloud = document.getElementById("header-cloud");
  if (clientConfigured) {
    if (signedIn) {
      cloud.innerHTML = "<i data-lucide=\"cloud\"></i>";
    } else if (reconnectNeeded) {
      cloud.innerHTML = "<i data-lucide=\"cloud-off\"></i>";
    } else {
      cloud.innerHTML = "<i data-lucide=\"cloud\"></i>";
    }
  } else {
    cloud.innerHTML = "";
  }

  const toggle = document.getElementById("theme-toggle");
  const isDark = document.documentElement.dataset.theme === "dark";
  toggle.innerHTML = isDark ? "<i data-lucide=\"sun\"></i>" : "<i data-lucide=\"moon\"></i>";

  if (window.lucide) { lucide.createIcons(); }
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme === "dark";
  const next = isDark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("appTheme", next);
  renderHeaderIcons();
}

function renderView() {
  const main = document.getElementById("main");

  switch (currentView) {
  case "home":             renderHome(main);              break;
  case "workout":          renderWorkout(main);           break;
  case "routines":         renderRoutines(main);          break;
  case "log":              renderLog(main);               break;
  case "settings":         renderSettings(main);          break;
  case "exercise-history": renderExerciseHistory(main);   break;
  case "edit-session":     renderEditSession(main);       break;
  case "health-today":     renderHealthToday(main);       break;
  case "health-metrics":   renderHealthMetrics(main);     break;
  case "health-metric":    renderHealthMetricDetail(main); break;
  case "nutrition-home":   renderNutritionHome(main);     break;
  }
}

// ─── Home ─────────────────────────────────────────────────────────────────────

async function renderHome(el) {
  const routineList = await db.routines.list();

  let html = "";

  if (localStorage.getItem("driveReconnectNeeded") && localStorage.getItem("gClientId")) {
    html += `<div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;border-left:4px solid var(--warn)">
      <span style="font-weight:600">Drive disconnected</span>
      <button class="btn btn-warn btn-sm" onclick="app.reconnectDrive()">Reconnect</button>
    </div>`;
  }

  if (activeSession) {
    html += `<div class="card">
      <div class="card-title">⚡ Workout in progress</div>
      <p class="muted" style="margin-bottom:12px">${activeSession.session.routineName || "Custom"}</p>
      <button class="btn btn-primary btn-full" onclick="app.navigate('workout')">Resume Workout</button>
    </div>`;
  }

  html += "<div class=\"section-title\">Start a Routine</div>";

  if (routineList.length === 0) {
    html += "<div class=\"empty\">No routines yet. Go to Routines to create one.</div>";
  } else {
    html += routineList
      .map(
        (r) => `<div class="card" style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="card-title" style="margin:0">${esc(r.name)}</div>
            ${r.notes ? `<div class="muted" style="font-size:.85rem">${esc(r.notes)}</div>` : ""}
          </div>
          <button class="btn btn-primary btn-sm" onclick="app.startWorkout(${r.id})">Start</button>
        </div>`
      )
      .join("");
  }

  el.innerHTML = html;
}

// ─── Workout ──────────────────────────────────────────────────────────────────

async function startWorkout(routineId) {
  if (activeSession) {
    if (!confirm("You have a workout in progress. Abandon it and start a new one?")) { return; }
    await db.sessions.delete(activeSession.session.id);
    const exes = await db.sessionExercises.listForSession(activeSession.session.id);
    for (const ex of exes) {
      await db.sessionExercises.delete(ex.id);
    }
  }

  const routine = await db.routines.get(routineId);
  const routineExList = await db.routineExercises.listForRoutine(routineId);
  routineExList.sort((a, b) => a.orderIndex - b.orderIndex);

  const sessionId = await db.sessions.save({
    routineId,
    routineName: routine.name,
    date: todayStr(),
    completedAt: null,
  });

  for (const [i, re] of routineExList.entries()) {
    const masterEx = await db.exercises.get(re.exerciseId);
    const type = masterEx?.type || "weight";
    await db.sessionExercises.save({
      sessionId,
      exerciseId: re.exerciseId,
      exerciseName: re.exerciseName,
      type,
      sets: re.defaultSets,
      reps: type === "weight" ? re.defaultReps : 0,
      weight: re.defaultWeight,
      duration: type === "timed" ? (re.defaultDuration || 60) : null,
      setsCompleted: 0,
      completed: false,
      routineExerciseId: re.id,
      orderIndex: i,
    });
  }

  activeSession = await loadActiveSession(sessionId);
  navigate("workout");
}

async function loadActiveSession(sessionId) {
  const session = await db.sessions.get(sessionId);
  const exes = await db.sessionExercises.listForSession(sessionId);
  exes.sort((a, b) => a.orderIndex - b.orderIndex);
  for (const ex of exes) {
    normalizeSessionExercise(ex);
  }
  return { session, exercises: exes };
}

function normalizeSessionExercise(se) {
  if (se.setsCompleted === undefined) {
    se.setsCompleted = se.completed ? se.sets : 0;
  }
  se.type = se.type || "weight";
  se.duration = se.duration ?? null;
  se.routineExerciseId = se.routineExerciseId ?? null;
  se.completed = se.setsCompleted >= se.sets;
}

async function renderWorkout(el) {
  if (!activeSession) {
    el.innerHTML = "<div class=\"empty\">No active workout. Start one from Home.</div>";
    return;
  }

  const exes = activeSession.exercises;
  const done = exes.filter((e) => e.setsCompleted >= e.sets).length;

  const allExercises = await db.exercises.list();
  const notesById = Object.fromEntries(allExercises.map((e) => [e.id, e.notes || ""]));

  const hasTimedExercises = exes.some((e) => (e.type || "weight") === "timed");
  const notifBanner = hasTimedExercises && !notificationsEnabled()
    ? "<div class=\"notif-banner\">Enable notifications in <a href=\"#\" onclick=\"app.navigate('settings');return false;\">Settings</a> to be alerted when sets complete.</div>"
    : "";

  let html = `
    ${notifBanner}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <div style="font-weight:700;font-size:1.05rem">${esc(activeSession.session.routineName || "Workout")}</div>
        <div class="muted" style="font-size:.85rem">${done}/${exes.length} exercises done</div>
      </div>
      <button class="btn btn-green btn-sm" onclick="app.finishWorkout()">Finish</button>
    </div>
    <div id="ex-list">`;

  for (const ex of exes) {
    html += renderExRow(ex, notesById[ex.exerciseId] || "");
  }

  html += `</div>
    <div style="margin-top:16px">
      <button class="btn btn-ghost btn-sm btn-full" onclick="app.showAddExerciseToSession()">+ Add Exercise</button>
    </div>`;

  el.innerHTML = html;
}

function renderExRow(ex, notes = "") {
  const type = ex.type || "weight";
  const metaText = formatExMeta(ex);
  const setBar = renderSetBar(ex);
  const timerBtn = type === "timed"
    ? (activeTimer && activeTimer.exId === ex.id
      ? `<div class="timer-active" id="timer-${ex.id}">
          <span class="timer-display" id="timer-display-${ex.id}">${formatDuration(activeTimer.remaining)}</span>
          <button class="btn btn-danger btn-sm" onclick="app.stopTimer()">Stop</button>
        </div>`
      : `<button class="btn btn-ghost btn-sm" onclick="app.startTimer(${ex.id})">Start</button>`)
    : "";

  const editFields = type === "timed"
    ? `<div class="field">
        <label>Sets</label>
        <input type="number" id="sets-${ex.id}" value="${ex.sets}" min="1">
      </div>
      <div class="field">
        <label>Duration (sec)</label>
        <input type="number" id="dur-${ex.id}" value="${ex.duration || 60}" min="1">
      </div>
      <div class="field">
        <label>Weight (lbs)</label>
        <input type="number" id="weight-${ex.id}" value="${ex.weight}" min="0" step="2.5">
      </div>`
    : `<div class="field">
        <label>Sets</label>
        <input type="number" id="sets-${ex.id}" value="${ex.sets}" min="1">
      </div>
      <div class="field">
        <label>Reps</label>
        <input type="number" id="reps-${ex.id}" value="${ex.reps}" min="1">
      </div>
      <div class="field">
        <label>Weight (lbs)</label>
        <input type="number" id="weight-${ex.id}" value="${ex.weight}" min="0" step="2.5">
      </div>`;

  return `<div class="ex-row" id="ex-${ex.id}">
    <div>
      <div class="ex-name">${esc(ex.exerciseName)}</div>
      <div class="ex-meta" id="meta-${ex.id}">${metaText}</div>
      ${notes ? `<div class="muted" style="font-size:.78rem;margin-top:2px">${esc(notes)}</div>` : ""}
    </div>
    <div class="ex-actions">
      ${timerBtn}
      <button class="ex-edit-btn" onclick="app.toggleInlineEdit(${ex.id})">Edit</button>
    </div>
    ${setBar}
  </div>
  <div class="inline-edit hidden" id="edit-${ex.id}">
    ${editFields}
    <div style="grid-column:1/-1;display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" onclick="app.saveInlineEdit(${ex.id})">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="app.toggleInlineEdit(${ex.id})">Cancel</button>
      <button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="app.removeFromSession(${ex.id})">Remove</button>
    </div>
  </div>`;
}

function formatExMeta(ex) {
  const type = ex.type || "weight";
  if (type === "timed") {
    const dur = formatDuration(ex.duration || 0);
    const weightPart = ex.weight ? ` @ ${ex.weight} lbs` : "";
    return `${ex.sets} × ${dur}${weightPart}`;
  }
  return `${ex.sets}×${ex.reps} @ ${ex.weight} lbs`;
}

function renderSetBar(ex) {
  let segs = "";
  for (let i = 1; i <= ex.sets; i++) {
    segs += `<button class="set-seg${i <= ex.setsCompleted ? " done" : ""}" onclick="app.tapSet(${ex.id}, ${i})"></button>`;
  }
  return `<div class="set-bar" id="setbar-${ex.id}">${segs}</div>`;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) { return "0:00"; }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function toggleInlineEdit(exId) {
  const el = document.getElementById(`edit-${exId}`);
  el.classList.toggle("hidden");
}

async function tapSet(exId, setNum) {
  const ex = activeSession.exercises.find((e) => e.id === exId);
  if (!ex) { return; }
  ex.setsCompleted = (setNum === ex.setsCompleted) ? setNum - 1 : setNum;
  ex.completed = ex.setsCompleted >= ex.sets;
  await db.sessionExercises.save(ex);

  // Update set bar segments
  const bar = document.getElementById(`setbar-${exId}`);
  if (bar) {
    const segs = bar.querySelectorAll(".set-seg");
    segs.forEach((seg, i) => seg.classList.toggle("done", i < ex.setsCompleted));
  }

  // Update header done count
  updateWorkoutDoneCount();
}

function updateWorkoutDoneCount() {
  if (!activeSession) { return; }
  const exes = activeSession.exercises;
  const done = exes.filter((e) => e.setsCompleted >= e.sets).length;
  const counter = document.querySelector("#main .muted");
  if (counter && counter.textContent.includes("exercises done")) {
    counter.textContent = `${done}/${exes.length} exercises done`;
  }
}

async function saveInlineEdit(exId) {
  const ex = activeSession.exercises.find((e) => e.id === exId);
  if (!ex) { return; }
  const type = ex.type || "weight";
  const oldSets = ex.sets;
  ex.sets   = parseInt(document.getElementById(`sets-${exId}`).value, 10) || ex.sets;
  if (type === "timed") {
    ex.duration = parseInt(document.getElementById(`dur-${exId}`).value, 10) || ex.duration;
  } else {
    ex.reps = parseInt(document.getElementById(`reps-${exId}`).value, 10) || ex.reps;
  }
  ex.weight = parseFloat(document.getElementById(`weight-${exId}`).value) ?? ex.weight;
  // Clamp setsCompleted if sets decreased
  if (ex.setsCompleted > ex.sets) { ex.setsCompleted = ex.sets; }
  ex.completed = ex.setsCompleted >= ex.sets;
  await db.sessionExercises.save(ex);

  document.getElementById(`meta-${exId}`).textContent = formatExMeta(ex);
  // Re-render set bar if sets count changed
  if (oldSets !== ex.sets) {
    const bar = document.getElementById(`setbar-${exId}`);
    if (bar) { bar.outerHTML = renderSetBar(ex); }
  }
  toggleInlineEdit(exId);
  updateWorkoutDoneCount();

  // Offer to update routine defaults
  if (ex.routineExerciseId) {
    try {
      const re = await db.routineExercises.get(ex.routineExerciseId);
      if (re) {
        const changed = type === "timed"
          ? (ex.sets !== re.defaultSets || ex.duration !== (re.defaultDuration || 60) || ex.weight !== re.defaultWeight)
          : (ex.sets !== re.defaultSets || ex.reps !== re.defaultReps || ex.weight !== re.defaultWeight);
        if (changed) {
          actionToast(
            `Update routine defaults? <button class="btn btn-primary btn-sm" style="margin-left:8px" onclick="app.updateDefaults(${ex.id},${re.id})">Yes</button><button class="btn btn-ghost btn-sm" style="margin-left:4px" onclick="app.dismissToast()">No</button>`
          );
          return;
        }
      }
    } catch { /* routine exercise may have been deleted */ }
  }
  toast("Saved");
}

async function removeFromSession(exId) {
  await db.sessionExercises.delete(exId);
  activeSession.exercises = activeSession.exercises.filter((e) => e.id !== exId);
  const row = document.getElementById(`ex-${exId}`);
  const edit = document.getElementById(`edit-${exId}`);
  row.remove();
  if (edit) { edit.remove(); }
}

// ─── Timer ──────────────────────────────────────────────────────────────────

function startTimer(exId) {
  const ex = activeSession.exercises.find((e) => e.id === exId);
  if (!ex || !ex.duration) { return; }
  // Cancel existing timer if any
  if (activeTimer) { clearInterval(activeTimer.intervalId); }

  const setNum = ex.setsCompleted + 1;
  activeTimer = { exId, setNum, remaining: ex.duration, intervalId: null };

  activeTimer.intervalId = setInterval(() => {
    activeTimer.remaining--;
    const display = document.getElementById(`timer-display-${exId}`);
    if (display) { display.textContent = formatDuration(activeTimer.remaining); }
    if (activeTimer.remaining <= 0) {
      clearInterval(activeTimer.intervalId);
      const completedSetNum = activeTimer.setNum;
      activeTimer = null;
      // Swap Stop → Start first so the UI is never left stuck if playAlert throws
      const timerEl = document.getElementById(`timer-${exId}`);
      if (timerEl) {
        timerEl.outerHTML = `<button class="btn btn-ghost btn-sm" onclick="app.startTimer(${exId})">Start</button>`;
      }
      tapSet(exId, completedSetNum);
      playAlert(ex.exerciseName);
    }
  }, 1000);

  // Update UI to show timer
  const row = document.getElementById(`ex-${exId}`);
  if (row) {
    const actionsEl = row.querySelector(".ex-actions");
    if (actionsEl) {
      const startBtn = actionsEl.querySelector(".btn");
      if (startBtn && startBtn.textContent.trim() === "Start") {
        startBtn.outerHTML = `<div class="timer-active" id="timer-${exId}">
          <span class="timer-display" id="timer-display-${exId}">${formatDuration(activeTimer.remaining)}</span>
          <button class="btn btn-danger btn-sm" onclick="app.stopTimer()">Stop</button>
        </div>`;
      }
    }
  }
}

function stopTimer() {
  if (!activeTimer) { return; }
  const exId = activeTimer.exId;
  clearInterval(activeTimer.intervalId);
  activeTimer = null;
  // Re-render timer area
  const row = document.getElementById(`ex-${exId}`);
  if (row) {
    const timerEl = document.getElementById(`timer-${exId}`);
    if (timerEl) {
      timerEl.outerHTML = `<button class="btn btn-ghost btn-sm" onclick="app.startTimer(${exId})">Start</button>`;
    }
  }
}

function notificationsEnabled() {
  return typeof Notification !== "undefined"
    && Notification.permission === "granted"
    && localStorage.getItem("notificationsEnabled") === "true";
}

async function requestNotificationPermission() {
  if (typeof Notification === "undefined") {
    toast("Notifications not supported in this browser");
    return;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    localStorage.setItem("notificationsEnabled", "true");
    toast("Notifications enabled");
  } else {
    localStorage.removeItem("notificationsEnabled");
    toast("Notification permission denied");
  }
  navigate("settings");
}

function disableNotifications() {
  localStorage.removeItem("notificationsEnabled");
  toast("Notifications disabled");
  navigate("settings");
}

async function playAlert(exerciseName) {
  if (navigator.vibrate) { navigator.vibrate([200, 100, 200]); }
  if (!notificationsEnabled()) { return; }
  const title = "Set complete";
  const opts = {
    body: exerciseName ? `${exerciseName} — time's up!` : "Timer finished",
    icon: "./icon.svg",
    silent: false,
  };
  // Prefer ServiceWorkerRegistration.showNotification — required on Android / iOS PWA,
  // where `new Notification()` throws. Fall back to the constructor on platforms
  // without a service worker.
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
      return;
    }
    new Notification(title, opts);
  } catch { /* best-effort */ }
}

// ─── Update routine defaults ────────────────────────────────────────────────

async function updateDefaults(sessionExId, routineExId) {
  try {
    const ex = activeSession.exercises.find((e) => e.id === sessionExId);
    const re = await db.routineExercises.get(routineExId);
    if (!ex || !re) { toast("Error updating defaults"); return; }
    re.defaultSets = ex.sets;
    re.defaultWeight = ex.weight;
    if ((ex.type || "weight") === "timed") {
      re.defaultDuration = ex.duration;
    } else {
      re.defaultReps = ex.reps;
    }
    await db.routineExercises.save(re);
    toast("Defaults updated");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function dismissToast() {
  const el = document.getElementById("toast");
  el.classList.remove("show");
  if (toastTimer) { clearTimeout(toastTimer); }
}

async function finishWorkout() {
  if (!activeSession) { return; }
  const total = activeSession.exercises.length;
  const done  = activeSession.exercises.filter((e) => e.setsCompleted >= e.sets).length;
  if (done < total && !confirm(`Only ${done}/${total} exercises completed. Finish anyway?`)) { return; }
  // Clear any running timer
  if (activeTimer) { clearInterval(activeTimer.intervalId); activeTimer = null; }

  activeSession.session.completedAt = new Date().toISOString();
  await db.sessions.save(activeSession.session);
  activeSession = null;
  navigate("home");

  if (drive.isSignedIn()) {
    try {
      const data = await db.exportAll();
      await drive.backupToDrive(data);
      localStorage.setItem(DRIVE_LAST_BACKUP_KEY, new Date().toISOString());
      toast("Workout saved & backed up to Drive");
    } catch {
      toast("Workout saved (Drive backup failed)");
    }
  } else {
    toast("Workout saved locally!");
  }
}

// Add exercise to existing session
function showAddExerciseToSession() {
  showExercisePicker(async (ex) => {
    const idx = activeSession.exercises.length;
    const type = ex.type || "weight";
    const id = await db.sessionExercises.save({
      sessionId: activeSession.session.id,
      exerciseId: ex.id,
      exerciseName: ex.name,
      type,
      sets: 3,
      reps: type === "weight" ? 10 : 0,
      weight: 0,
      duration: type === "timed" ? 60 : null,
      setsCompleted: 0,
      completed: false,
      routineExerciseId: null,
      orderIndex: idx,
    });
    const saved = await db.sessionExercises.get(id);
    normalizeSessionExercise(saved);
    activeSession.exercises.push(saved);
    const list = document.getElementById("ex-list");
    list.insertAdjacentHTML("beforeend", renderExRow(saved, ex.notes || ""));
  });
}

// ─── Routines ─────────────────────────────────────────────────────────────────

const expandedRoutines = new Set();

function toggleRoutine(id) {
  if (expandedRoutines.has(id)) {
    expandedRoutines.delete(id);
  } else {
    expandedRoutines.add(id);
  }
  const body    = document.getElementById(`routine-body-${id}`);
  const header  = document.getElementById(`routine-header-${id}`);
  const chevron = document.getElementById(`routine-chevron-${id}`);
  const open    = expandedRoutines.has(id);
  body.style.display       = open ? "block" : "none";
  header.style.marginBottom  = open ? "var(--gap)" : "";
  chevron.style.transform  = open ? "rotate(180deg)" : "";
}

async function renderRoutines(el) {
  const list = await db.routines.list();

  let html = "<button class=\"btn btn-primary btn-full\" style=\"margin-bottom:16px\" onclick=\"app.showRoutineModal()\">+ New Routine</button>";

  const allExercisesList = await db.exercises.list();
  const exerciseTypeById = Object.fromEntries(allExercisesList.map((e) => [e.id, e.type || "weight"]));

  if (list.length === 0) {
    html += "<div class=\"empty\">No routines yet.</div>";
  } else {
    for (const r of list) {
      const exes = await db.routineExercises.listForRoutine(r.id);
      exes.sort((a, b) => a.orderIndex - b.orderIndex);
      const open = expandedRoutines.has(r.id);
      html += `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;${open ? "margin-bottom:var(--gap)" : ""}" id="routine-header-${r.id}"
             onclick="app.toggleRoutine(${r.id})">
          <div class="card-title" style="margin:0">${esc(r.name)}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="muted" style="font-size:.8rem">${exes.length} exercise${exes.length !== 1 ? "s" : ""}</span>
            <i data-lucide="chevron-down" id="routine-chevron-${r.id}" style="width:16px;height:16px;stroke:var(--muted);transition:transform .2s;display:inline-block${open ? ";transform:rotate(180deg)" : ""}"></i>
          </div>
        </div>
        <div id="routine-body-${r.id}" style="display:${open ? "block" : "none"}">
          ${r.notes ? `<div class="muted" style="font-size:.85rem;margin-bottom:10px">${esc(r.notes)}</div>` : ""}
          <div style="margin-bottom:10px;border-top:1px solid var(--border)">
            ${exes.length === 0
    ? "<div class='muted' style='font-size:.85rem;padding:10px 0'>No exercises yet</div>"
    : exes.map((e) => {
      const exType = exerciseTypeById[e.exerciseId] || "weight";
      const meta = exType === "timed"
        ? `${e.defaultSets} × ${formatDuration(e.defaultDuration || 60)}${e.defaultWeight ? ` @ ${e.defaultWeight} lbs` : ""}`
        : `${e.defaultSets}×${e.defaultReps} @ ${e.defaultWeight} lbs`;
      return `<div style="border-bottom:1px solid var(--border)">
                <div style="padding:8px 0;display:flex;justify-content:space-between;align-items:center;gap:8px">
                  <div>
                    <div>${esc(e.exerciseName)}</div>
                    <div class="muted" style="font-size:.8rem">${meta}</div>
                  </div>
                  <button class="menu-btn" onclick="app.routineExerciseMenu(${e.id})">⋮</button>
                </div>
                <div class="inline-actions hidden" id="menu-re-${e.id}">
                  <button class="btn btn-ghost btn-sm" onclick="app.showRoutineExerciseModal(${e.id})">Edit defaults</button>
                  <button class="btn btn-danger btn-sm" onclick="app.removeRoutineExercise(${e.id})">Remove</button>
                </div>
              </div>`;
    }).join("")}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <button class="btn btn-ghost btn-sm" onclick="app.showAddExerciseToRoutine(${r.id})">+ Add Exercise</button>
            <button class="menu-btn" onclick="app.routineMenu(${r.id})">⋮</button>
          </div>
          <div class="inline-actions hidden" id="menu-routine-${r.id}">
            <button class="btn btn-ghost btn-sm" onclick="app.showRoutineModal(${r.id})">Edit Routine</button>
            <button class="btn btn-danger btn-sm" onclick="app.deleteRoutine(${r.id})">Delete Routine</button>
          </div>
        </div>
      </div>`;
    }
  }

  // Exercises section
  const allExercises = allExercisesList.slice().sort((a, b) => a.name.localeCompare(b.name));

  html += `<div class="section-title">Exercises</div>
    <button class="btn btn-ghost btn-full" style="margin-bottom:12px" onclick="app.showExerciseModal()">+ New Exercise</button>`;

  if (allExercises.length === 0) {
    html += "<div class=\"empty\">No exercises yet.</div>";
  } else {
    html += "<div class=\"card\">";
    for (const e of allExercises) {
      html += `<div class="session-row" style="flex-wrap:wrap">
        <div style="flex:1">
          <div style="font-weight:600">${esc(e.name)}</div>
          ${e.muscleGroup ? `<div class="muted" style="font-size:.8rem">${esc(e.muscleGroup)}</div>` : ""}
          ${e.notes ? `<div class="muted" style="font-size:.8rem;margin-top:2px">${esc(e.notes)}</div>` : ""}
        </div>
        <button class="menu-btn" onclick="app.exerciseMenu(${e.id})">⋮</button>
        <div class="inline-actions hidden" id="menu-exercise-${e.id}" style="width:100%">
          <button class="btn btn-ghost btn-sm" onclick="app.showExerciseModal(${e.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="app.deleteExercise(${e.id})">Delete</button>
        </div>
      </div>`;
    }
    html += "</div>";
  }

  el.innerHTML = html;
  if (window.lucide) { lucide.createIcons(); }
}

// Modal state for routine editing
let editingRoutineId = null;

function showRoutineModal(routineId = null) {
  editingRoutineId = routineId;
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");

  (routineId ? db.routines.get(routineId) : Promise.resolve(null)).then((r) => {
    modal.innerHTML = `
      <div class="modal-title">${routineId ? "Edit Routine" : "New Routine"}</div>
      <div class="field"><label>Name</label><input type="text" id="m-routine-name" value="${esc(r ? r.name : "")}"></div>
      <div class="field"><label>Notes (optional)</label><textarea id="m-routine-notes">${esc(r ? r.notes || "" : "")}</textarea></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="app.saveRoutine()">Save</button>
        <button class="btn btn-ghost" onclick="app.closeModal()">Cancel</button>
      </div>`;
    backdrop.classList.remove("hidden");
  });
}

async function saveRoutine() {
  const name = document.getElementById("m-routine-name").value.trim();
  if (!name) { toast("Name required"); return; }
  const notes = document.getElementById("m-routine-notes").value.trim();
  try {
    const record = { name, notes };
    if (editingRoutineId) { record.id = editingRoutineId; }
    await db.routines.save(record);
    closeModal();
    navigate("routines");
  } catch (err) {
    toast("Error saving routine: " + err.message);
  }
}

async function deleteRoutine(id) {
  if (!confirm("Delete this routine?")) { return; }
  // Remove its exercises too
  const exes = await db.routineExercises.listForRoutine(id);
  for (const ex of exes) { await db.routineExercises.delete(ex.id); }
  await db.routines.delete(id);
  navigate("routines");
}

// Exercise create/edit modal

let editingExerciseId = null;

function showExerciseModal(exerciseId = null) {
  editingExerciseId = exerciseId;
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");

  (exerciseId ? db.exercises.get(exerciseId) : Promise.resolve(null)).then((e) => {
    const type = e ? (e.type || "weight") : "weight";
    modal.innerHTML = `
      <div class="modal-title">${exerciseId ? "Edit Exercise" : "New Exercise"}</div>
      <div class="field"><label>Name</label><input type="text" id="m-ex-name" value="${esc(e ? e.name : "")}"></div>
      <div class="field"><label>Muscle group (optional)</label><input type="text" id="m-ex-muscle" value="${esc(e ? e.muscleGroup || "" : "")}"></div>
      <div class="field">
        <label>Type</label>
        <select id="m-ex-type">
          <option value="weight"${type === "weight" ? " selected" : ""}>Weight / Reps</option>
          <option value="timed"${type === "timed" ? " selected" : ""}>Timed (duration)</option>
        </select>
      </div>
      <div class="field"><label>Notes (optional)</label><textarea id="m-ex-notes" placeholder="Form tips, cues, equipment notes…">${esc(e ? e.notes || "" : "")}</textarea></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="app.saveExercise()">Save</button>
        <button class="btn btn-ghost" onclick="app.closeModal()">Cancel</button>
      </div>`;
    backdrop.classList.remove("hidden");
  });
}

async function saveExercise() {
  const name = document.getElementById("m-ex-name").value.trim();
  if (!name) { toast("Name required"); return; }
  const muscleGroup = document.getElementById("m-ex-muscle").value.trim();
  const type = document.getElementById("m-ex-type").value;
  const notes = document.getElementById("m-ex-notes").value.trim();
  try {
    const record = { name, muscleGroup, type, notes };
    if (editingExerciseId) { record.id = editingExerciseId; }
    await db.exercises.save(record);
    closeModal();
    navigate("routines");
  } catch (err) {
    const msg = err.name === "ConstraintError"
      ? "An exercise with that name already exists"
      : "Error saving exercise: " + err.message;
    toast(msg);
  }
}

async function deleteExercise(id) {
  if (!confirm("Delete this exercise? Its history will be lost.")) { return; }
  await db.exercises.delete(id);
  navigate("routines");
}

// Edit routine exercise defaults

function showRoutineExerciseModal(routineExerciseId) {
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");

  db.routineExercises.get(routineExerciseId).then(async (re) => {
    const masterEx = await db.exercises.get(re.exerciseId);
    const type = masterEx?.type || "weight";
    const midField = type === "timed"
      ? `<div class="field">
          <label>Duration (sec)</label>
          <input type="number" id="m-re-dur" value="${re.defaultDuration || 60}" min="1">
        </div>`
      : `<div class="field">
          <label>Reps</label>
          <input type="number" id="m-re-reps" value="${re.defaultReps}" min="1">
        </div>`;
    modal.innerHTML = `
      <div class="modal-title">${esc(re.exerciseName)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="field">
          <label>Sets</label>
          <input type="number" id="m-re-sets" value="${re.defaultSets}" min="1">
        </div>
        ${midField}
        <div class="field">
          <label>Weight (lbs)</label>
          <input type="number" id="m-re-weight" value="${re.defaultWeight}" min="0" step="2.5">
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="app.saveRoutineExercise(${routineExerciseId})">Save</button>
        <button class="btn btn-ghost" onclick="app.closeModal()">Cancel</button>
      </div>`;
    backdrop.classList.remove("hidden");
  });
}

async function saveRoutineExercise(routineExerciseId) {
  try {
    const re = await db.routineExercises.get(routineExerciseId);
    re.defaultSets   = parseInt(document.getElementById("m-re-sets").value, 10)   || re.defaultSets;
    const durEl = document.getElementById("m-re-dur");
    const repsEl = document.getElementById("m-re-reps");
    if (durEl) {
      re.defaultDuration = parseInt(durEl.value, 10) || re.defaultDuration || 60;
    }
    if (repsEl) {
      re.defaultReps = parseInt(repsEl.value, 10) || re.defaultReps;
    }
    re.defaultWeight = parseFloat(document.getElementById("m-re-weight").value)    ?? re.defaultWeight;
    await db.routineExercises.save(re);
    closeModal();
    navigate("routines");
  } catch (err) {
    toast("Error saving: " + err.message);
  }
}

async function removeRoutineExercise(routineExerciseId) {
  if (!confirm("Remove this exercise from the routine?")) { return; }
  await db.routineExercises.delete(routineExerciseId);
  navigate("routines");
}

// ─── Context menus ───────────────────────────────────────────────────────────

let openMenuId = null;

function toggleMenu(menuId) {
  if (openMenuId && openMenuId !== menuId) {
    const prev = document.getElementById(`menu-${openMenuId}`);
    if (prev) { prev.classList.add("hidden"); }
  }
  const el = document.getElementById(`menu-${menuId}`);
  if (!el) { return; }
  const opening = el.classList.contains("hidden");
  el.classList.toggle("hidden");
  openMenuId = opening ? menuId : null;
}

function routineMenu(routineId) {
  toggleMenu(`routine-${routineId}`);
}

function routineExerciseMenu(routineExerciseId) {
  toggleMenu(`re-${routineExerciseId}`);
}

function exerciseMenu(exerciseId) {
  toggleMenu(`exercise-${exerciseId}`);
}

// Add exercise to a routine
function showAddExerciseToRoutine(routineId) {
  showExercisePicker((ex) => showAddExerciseDefaults(routineId, ex));
}

function showAddExerciseDefaults(routineId, ex) {
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");
  const type = ex.type || "weight";
  const midField = type === "timed"
    ? `<div class="field">
        <label>Duration (sec)</label>
        <input type="number" id="m-add-dur" value="60" min="1">
      </div>`
    : `<div class="field">
        <label>Reps</label>
        <input type="number" id="m-add-reps" value="10" min="1">
      </div>`;

  modal.innerHTML = `
    <div class="modal-title">${esc(ex.name)}</div>
    <div class="muted" style="margin-bottom:16px;font-size:.85rem">Set defaults for this routine</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
      <div class="field">
        <label>Sets</label>
        <input type="number" id="m-add-sets" value="3" min="1">
      </div>
      ${midField}
      <div class="field">
        <label>Weight (lbs)</label>
        <input type="number" id="m-add-weight" value="0" min="0" step="2.5">
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" onclick="app.confirmAddExerciseToRoutine(${routineId}, ${ex.id}, '${esc(ex.name)}')">Add</button>
      <button class="btn btn-ghost" onclick="app.closeModal()">Cancel</button>
    </div>`;
  backdrop.classList.remove("hidden");
}

async function confirmAddExerciseToRoutine(routineId, exerciseId, exerciseName) {
  try {
    const existing = await db.routineExercises.listForRoutine(routineId);
    const durEl = document.getElementById("m-add-dur");
    const repsEl = document.getElementById("m-add-reps");
    const record = {
      routineId,
      exerciseId,
      exerciseName,
      defaultSets:   parseInt(document.getElementById("m-add-sets").value, 10)   || 3,
      defaultReps:   repsEl ? (parseInt(repsEl.value, 10) || 10) : 0,
      defaultWeight: parseFloat(document.getElementById("m-add-weight").value)   || 0,
      defaultDuration: durEl ? (parseInt(durEl.value, 10) || 60) : null,
      orderIndex: existing.length,
    };
    await db.routineExercises.save(record);
    closeModal();
    navigate("routines");
  } catch (err) {
    toast("Error adding exercise: " + err.message);
  }
}

// ─── Exercise picker modal ────────────────────────────────────────────────────

let pickerCallback = null;

async function showExercisePicker(callback) {
  pickerCallback = callback;
  const all = await db.exercises.list();
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");

  let listHtml = "";
  if (all.length === 0) {
    listHtml = "<div class=\"empty\">No exercises. Create one below.</div>";
  } else {
    listHtml = all
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `<div class="session-row" style="cursor:pointer" onclick="app.pickerSelect(${e.id})">
        <span>${esc(e.name)}</span>
        ${e.muscleGroup ? `<span class="pill">${esc(e.muscleGroup)}</span>` : ""}
      </div>`)
      .join("");
  }

  modal.innerHTML = `
    <div class="modal-title">Select Exercise</div>
    <div id="picker-list">${listHtml}</div>
    <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:16px">
      <div class="field"><label>Or create new</label><input type="text" id="new-ex-name" placeholder="Exercise name"></div>
      <div class="field"><label>Muscle group (optional)</label><input type="text" id="new-ex-muscle" placeholder="e.g. Chest, Back, Legs"></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="app.pickerCreate()">Create & Select</button>
        <button class="btn btn-ghost btn-sm" onclick="app.closeModal()">Cancel</button>
      </div>
    </div>`;
  backdrop.classList.remove("hidden");
}

async function pickerSelect(exerciseId) {
  const ex = await db.exercises.get(exerciseId);
  const cb = pickerCallback;
  closeModal();
  if (cb) { cb(ex); }
}

async function pickerCreate() {
  const name = document.getElementById("new-ex-name").value.trim();
  if (!name) { toast("Name required"); return; }
  const muscleGroup = document.getElementById("new-ex-muscle").value.trim();
  try {
    const id = await db.exercises.save({ name, muscleGroup });
    const ex = await db.exercises.get(id);
    const cb = pickerCallback;
    closeModal();
    if (cb) { cb(ex); }
  } catch (err) {
    toast("Error saving exercise: " + err.message);
  }
}

// ─── Session Log ──────────────────────────────────────────────────────────────

async function renderLog(el) {
  const allSessions = await db.sessions.list();
  const completed = allSessions
    .filter((s) => s.completedAt)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  let html = "<div class=\"section-title\">Past Workouts</div>";

  if (completed.length === 0) {
    html += "<div class=\"empty\">No completed workouts yet.</div>";
  } else {
    html += "<div class=\"card\">";
    for (const s of completed) {
      const exes = await db.sessionExercises.listForSession(s.id);
      const doneCount = exes.filter((e) => e.completed).length;
      const date = new Date(s.completedAt).toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
      html += `<div class="session-row">
        <div>
          <div style="font-weight:600">${esc(s.routineName || "Workout")}</div>
          <div class="muted" style="font-size:.85rem">${date} · ${doneCount}/${exes.length} exercises</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="app.viewSession(${s.id})">View</button>
          <button class="btn btn-ghost btn-sm" onclick="app.navigateEditSession(${s.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="app.deleteSession(${s.id})">Delete</button>
        </div>
      </div>`;
    }
    html += "</div>";
  }

  // Exercise history quick-access
  const allExercises = await db.exercises.list();
  if (allExercises.length > 0) {
    html += `<div class="section-title">Exercise Progress</div>
      <div class="card">
        ${allExercises.sort((a, b) => a.name.localeCompare(b.name)).map((e) =>
    `<div class="session-row" style="cursor:pointer" onclick="app.showExerciseHistory(${e.id})">
          <span>${esc(e.name)}</span>
          ${e.muscleGroup ? `<span class="pill">${esc(e.muscleGroup)}</span>` : ""}
        </div>`).join("")}
      </div>`;
  }

  el.innerHTML = html;
}

async function viewSession(sessionId) {
  const session = await db.sessions.get(sessionId);
  const exes = await db.sessionExercises.listForSession(sessionId);
  exes.sort((a, b) => a.orderIndex - b.orderIndex);

  const date = new Date(session.completedAt).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");

  modal.innerHTML = `
    <div class="modal-title">${esc(session.routineName || "Workout")}</div>
    <div class="muted" style="margin-bottom:16px">${date}</div>
    ${exes.map((e) => {
    const meta = (e.type || "weight") === "timed"
      ? `${e.sets} × ${formatDuration(e.duration || 0)}${e.weight ? ` @ ${e.weight} lbs` : ""}`
      : `${e.sets}×${e.reps} @ ${e.weight} lbs`;
    return `<div class="session-row">
      <div>
        <div style="font-weight:600">${esc(e.exerciseName)}</div>
        <div class="muted" style="font-size:.85rem">${meta}</div>
      </div>
      ${e.completed ? "<span class='success-text'>✓</span>" : "<span class='muted'>–</span>"}
    </div>`;
  }).join("")}
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-ghost btn-sm" onclick="app.closeModal()">Close</button>
      <button class="btn btn-ghost btn-sm" onclick="app.closeModal();app.navigateEditSession(${sessionId})">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="app.closeModal();app.deleteSession(${sessionId})">Delete</button>
    </div>`;
  backdrop.classList.remove("hidden");
}

async function deleteSession(sessionId) {
  if (!confirm("Delete this workout session? This cannot be undone.")) { return; }
  const exes = await db.sessionExercises.listForSession(sessionId);
  for (const ex of exes) { await db.sessionExercises.delete(ex.id); }
  await db.sessions.delete(sessionId);
  toast("Session deleted");
  navigate("log");
}

// ─── Edit Session ─────────────────────────────────────────────────────────────

let editingSessionId = null;

function navigateEditSession(sessionId) {
  editingSessionId = sessionId;
  navigate("edit-session");
}

async function renderEditSession(el) {
  const session = await db.sessions.get(editingSessionId);
  const exes = await db.sessionExercises.listForSession(editingSessionId);
  exes.sort((a, b) => a.orderIndex - b.orderIndex);

  const date = new Date(session.completedAt).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });

  let html = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <button class="btn btn-ghost btn-sm" onclick="app.navigate('log')">← Back</button>
      <div>
        <div style="font-weight:700">${esc(session.routineName || "Workout")}</div>
        <div class="muted" style="font-size:.85rem">${date}</div>
      </div>
    </div>`;

  for (const ex of exes) {
    const exType = ex.type || "weight";
    const midField = exType === "timed"
      ? `<div class="field">
          <label>Duration (sec)</label>
          <input type="number" id="se-dur-${ex.id}" value="${ex.duration || 60}" min="1">
        </div>`
      : `<div class="field">
          <label>Reps</label>
          <input type="number" id="se-reps-${ex.id}" value="${ex.reps}" min="1">
        </div>`;
    html += `<div class="card" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-weight:600">${esc(ex.exerciseName)}</div>
        <button class="ex-check ${ex.completed ? "done" : ""}" id="se-check-${ex.id}"
          onclick="app.toggleSessionExercise(${ex.id})">${ex.completed ? "✓" : ""}</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div class="field">
          <label>Sets</label>
          <input type="number" id="se-sets-${ex.id}" value="${ex.sets}" min="1">
        </div>
        ${midField}
        <div class="field">
          <label>Weight (lbs)</label>
          <input type="number" id="se-weight-${ex.id}" value="${ex.weight}" min="0" step="2.5">
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="app.saveSessionExerciseEdit(${ex.id})">Save</button>
    </div>`;
  }

  el.innerHTML = html;
}

async function toggleSessionExercise(seId) {
  try {
    const se = await db.sessionExercises.get(seId);
    se.completed = !se.completed;
    await db.sessionExercises.save(se);
    const btn = document.getElementById(`se-check-${seId}`);
    btn.classList.toggle("done", se.completed);
    btn.textContent = se.completed ? "✓" : "";
  } catch (err) {
    toast("Error: " + err.message);
  }
}

async function saveSessionExerciseEdit(seId) {
  try {
    const se = await db.sessionExercises.get(seId);
    se.sets   = parseInt(document.getElementById(`se-sets-${seId}`).value, 10)   || se.sets;
    const durEl = document.getElementById(`se-dur-${seId}`);
    const repsEl = document.getElementById(`se-reps-${seId}`);
    if (durEl) { se.duration = parseInt(durEl.value, 10) || se.duration; }
    if (repsEl) { se.reps = parseInt(repsEl.value, 10) || se.reps; }
    se.weight = parseFloat(document.getElementById(`se-weight-${seId}`).value)   ?? se.weight;
    await db.sessionExercises.save(se);
    toast("Saved");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

// ─── Exercise History ─────────────────────────────────────────────────────────

let historyExerciseId = null;

async function showExerciseHistory(exerciseId) {
  historyExerciseId = exerciseId;
  navigate("exercise-history");
}

async function renderExerciseHistory(el) {
  const ex = await db.exercises.get(historyExerciseId);
  const allSessionEx = await db.sessionExercises.listForExercise(historyExerciseId);

  // Join with session dates
  const withDates = [];
  for (const se of allSessionEx) {
    const session = await db.sessions.get(se.sessionId);
    if (session && session.completedAt) {
      withDates.push({ ...se, completedAt: session.completedAt });
    }
  }
  withDates.sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));

  let html = `<div style="margin-bottom:16px">
    <button class="btn btn-ghost btn-sm" onclick="app.navigate('log')">← Back</button>
  </div>
  <div class="card-title">${esc(ex.name)}</div>`;

  if (withDates.length === 0) {
    html += "<div class=\"empty\">No history yet for this exercise.</div>";
    el.innerHTML = html;
    return;
  }

  // Simple text chart placeholder — draw with canvas after insert
  html += "<div class=\"chart-wrap\"><canvas id=\"hist-chart\" height=\"180\"></canvas></div>";

  html += "<div class=\"section-title\">Sessions</div><div class=\"card\">";
  for (const se of [...withDates].reverse()) {
    const date = new Date(se.completedAt).toLocaleDateString("en-US", {
      month: "short", day: "numeric",
    });
    const seType = se.type || "weight";
    const meta = seType === "timed"
      ? `${se.sets} × ${formatDuration(se.duration || 0)}${se.weight ? ` @ <strong>${se.weight} lbs</strong>` : ""}`
      : `${se.sets}×${se.reps} @ <strong>${se.weight} lbs</strong>`;
    html += `<div class="session-row">
      <span class="muted">${date}</span>
      <span>${meta}</span>
    </div>`;
  }
  html += "</div>";

  el.innerHTML = html;

  // Draw weight-over-time chart
  drawChart(
    document.getElementById("hist-chart"),
    withDates.map((d) => new Date(d.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })),
    withDates.map((d) => d.weight),
    "Weight (lbs)"
  );
}

function drawChart(canvas, labels, values, yLabel) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth;
  const H = 180;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + "px";
  canvas.style.height = H + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const pad = { top: 16, right: 16, bottom: 40, left: 50 };
  const w = W - pad.left - pad.right;
  const h = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  if (values.length === 0) { return; }

  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const xStep = values.length > 1 ? w / (values.length - 1) : w / 2;

  // Grid lines
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + h - (i / 4) * h;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();

    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(minV + (range * i) / 4), pad.left - 6, y + 4);
  }

  // X labels (show up to 6)
  const step = Math.ceil(labels.length / 6);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "10px system-ui";
  ctx.textAlign = "center";
  for (let i = 0; i < labels.length; i += step) {
    const x = pad.left + i * xStep;
    ctx.fillText(labels[i], x, H - pad.bottom + 16);
  }

  // Line
  ctx.beginPath();
  ctx.strokeStyle = "#6366f1";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  for (let i = 0; i < values.length; i++) {
    const x = pad.left + i * xStep;
    const y = pad.top + h - ((values[i] - minV) / range) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Dots
  ctx.fillStyle = "#6366f1";
  for (let i = 0; i < values.length; i++) {
    const x = pad.left + i * xStep;
    const y = pad.top + h - ((values[i] - minV) / range) * h;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Y label
  ctx.save();
  ctx.translate(12, pad.top + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function renderSettings(el) {
  const savedId = localStorage.getItem("gClientId") || "";
  const signedIn = drive.isSignedIn();
  const lastBackup = signedIn ? await drive.getLastBackupTime() : null;
  const lastBackupStr = lastBackup
    ? new Date(lastBackup).toLocaleString()
    : "Never";

  const notifSupported = typeof Notification !== "undefined";
  const notifPermission = notifSupported ? Notification.permission : "unsupported";
  const notifOn = notificationsEnabled();

  let notifCard;
  if (!notifSupported) {
    notifCard = "<div class=\"muted\" style=\"font-size:.85rem\">Notifications are not supported in this browser.</div>";
  } else if (notifPermission === "denied") {
    notifCard = "<div class=\"muted\" style=\"font-size:.85rem\">Notification permission was denied. To enable, update site permissions in your browser settings.</div>";
  } else if (notifOn) {
    notifCard = `
      <div style="font-size:.9rem;margin-bottom:12px">Notifications are <strong>enabled</strong>. You'll receive an alert when a timed set completes.</div>
      <button class="btn btn-ghost btn-sm" onclick="app.disableNotifications()">Disable Notifications</button>`;
  } else {
    notifCard = `
      <div style="font-size:.9rem;margin-bottom:12px">Enable notifications to be alerted when a timed set completes — even if the screen is off.</div>
      <button class="btn btn-primary btn-sm" onclick="app.requestNotificationPermission()">Enable Notifications</button>`;
  }

  el.innerHTML = `
    <div class="settings-section">
      <div class="section-title">App · Google Drive Backup</div>
      <div class="card">
        <div class="field">
          <label>Google OAuth Client ID</label>
          <input type="text" id="client-id-input" value="${esc(savedId)}" placeholder="123....apps.googleusercontent.com">
        </div>
        <button class="btn btn-primary btn-sm" onclick="app.saveClientId()">Save Client ID</button>

        <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          ${signedIn
    ? "<button class=\"btn btn-ghost btn-sm\" onclick=\"app.driveSignOut()\">Sign Out of Google</button>"
    : "<button class=\"btn btn-primary btn-sm\" onclick=\"app.driveSignIn()\">Sign in to Google</button>"}
          <button class="btn btn-green btn-sm" onclick="app.driveBackup()" ${signedIn ? "" : "disabled"}>Backup Now</button>
          <button class="btn btn-ghost btn-sm" onclick="app.driveRestore()" ${signedIn ? "" : "disabled"}>Restore from Drive</button>
        </div>
        <div class="muted" style="font-size:.85rem;margin-top:12px">Last backup: ${lastBackupStr}</div>
      </div>

      <div class="section-title">App · Local Backup</div>
      <div class="card">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="app.exportJSON()">Download JSON</button>
          <button class="btn btn-ghost btn-sm" onclick="app.triggerImport()">Import JSON</button>
        </div>
        <input type="file" id="import-file" accept=".json" style="display:none" onchange="app.importJSON(this)">
      </div>
    </div>

    <div class="settings-section">
      <div class="section-title">Exercise · Notifications</div>
      <div class="card">${notifCard}</div>
    </div>

    <div class="settings-section">
      <div class="section-title">Health</div>
      <div class="card">
        <div class="muted" style="font-size:.9rem">Manage metrics and add readings from the Metrics and Today tabs in Health mode.</div>
      </div>
    </div>`;
}

async function saveClientId() {
  const id = document.getElementById("client-id-input").value.trim();
  localStorage.setItem("gClientId", id);
  drive.setClientId(id);
  try {
    await drive.initDrive();
    toast("Client ID saved");
  } catch (err) {
    toast("Saved, but Drive init failed: " + err.message);
  }
}

async function driveSignIn() {
  try {
    await drive.initDrive();
    await drive.signIn();
    localStorage.removeItem("driveReconnectNeeded");
    toast("Signed in to Google");
    navigate("settings");
  } catch (err) {
    toast("Sign-in failed: " + err.message);
  }
}

async function reconnectDrive() {
  try {
    await drive.signIn();
    localStorage.removeItem("driveReconnectNeeded");
    await checkDriveOnOpen();
    navigate(defaultViewForMode(currentMode));
  } catch (err) {
    toast("Reconnect failed: " + err.message);
  }
}

function driveSignOut() {
  drive.signOut();
  localStorage.removeItem("driveReconnectNeeded");
  localStorage.removeItem(DRIVE_LAST_BACKUP_KEY);
  toast("Signed out");
  navigate("settings");
}

// Returns the completedAt timestamp of the most recent local session, or null.
async function localLastActivityTime() {
  const all = await db.sessions.list();
  const completed = all.filter((s) => s.completedAt).map((s) => s.completedAt);
  return completed.length ? completed.reduce((a, b) => (a > b ? a : b)) : null;
}

// Called on boot when signed in — prompts restore if Drive is newer than local data.
async function checkDriveOnOpen() {
  try {
    const driveTime = await drive.getDriveModifiedTime();
    if (!driveTime) { return; } // no backup on Drive yet

    const lastBackup = localStorage.getItem(DRIVE_LAST_BACKUP_KEY);
    // If Drive was modified after our last known backup from this device, another
    // device has written to it — offer to restore.
    if (!lastBackup || driveTime > lastBackup) {
      const localTime = await localLastActivityTime();
      // Only prompt if Drive is also newer than our most recent local workout
      if (!localTime || driveTime > localTime) {
        const driveDate = new Date(driveTime).toLocaleString();
        if (confirm(`A newer Drive backup exists (${driveDate}). Restore it now?\n\nChoose Cancel to keep your local data.`)) {
          await driveRestore();
        }
      }
    }
  } catch {
    // Silent — don't block the app if Drive check fails
  }
}

async function driveBackup() {
  try {
    // Warn if Drive has been updated by another device since our last backup
    const lastBackup = localStorage.getItem(DRIVE_LAST_BACKUP_KEY);
    const driveTime = await drive.getDriveModifiedTime();
    if (driveTime && (!lastBackup || driveTime > lastBackup)) {
      const driveDate = new Date(driveTime).toLocaleString();
      if (!confirm(`Drive was last updated on ${driveDate}, which may be newer than your local data. Overwrite it anyway?`)) {
        return;
      }
    }

    const data = await db.exportAll();
    await drive.backupToDrive(data);
    localStorage.setItem(DRIVE_LAST_BACKUP_KEY, new Date().toISOString());
    toast("Backed up to Drive");
    navigate("settings");
  } catch (err) {
    toast("Backup failed: " + err.message);
  }
}

async function driveRestore() {
  if (!confirm("This will overwrite all local data with the Drive backup. Continue?")) { return; }
  try {
    const data = await drive.restoreFromDrive();
    await db.importAll(data);
    localStorage.setItem(DRIVE_LAST_BACKUP_KEY, new Date().toISOString());
    activeSession = null;
    toast("Restored from Drive");
    navigate(defaultViewForMode(currentMode));
  } catch (err) {
    toast("Restore failed: " + err.message);
  }
}

async function exportJSON() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `exercise-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function triggerImport() {
  document.getElementById("import-file").click();
}

async function importJSON(input) {
  const file = input.files[0];
  if (!file) { return; }
  if (!confirm("This will overwrite all local data. Continue?")) { return; }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await db.importAll(data);
    activeSession = null;
    toast("Data imported");
    navigate(defaultViewForMode(currentMode));
  } catch (err) {
    toast("Import failed: " + err.message);
  }
}

// ─── Modal helpers ────────────────────────────────────────────────────────────

function closeModal() {
  document.getElementById("modal-backdrop").classList.add("hidden");
  pickerCallback = null;
  editingRoutineId = null;
  editingExerciseId = null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function esc(str) {
  if (!str) { return ""; }
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  el.style.pointerEvents = "none";
  if (toastTimer) { clearTimeout(toastTimer); }
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

function actionToast(html) {
  const el = document.getElementById("toast");
  el.innerHTML = html;
  el.classList.add("show");
  el.style.pointerEvents = "auto";
  if (toastTimer) { clearTimeout(toastTimer); }
  toastTimer = setTimeout(() => { el.classList.remove("show"); el.style.pointerEvents = "none"; }, 6000);
}

// ─── Health mode ─────────────────────────────────────────────────────────────

const BUILTIN_METRICS = [
  { name: "Blood Pressure", kind: "dual",     unit: "mmHg", builtin: true },
  { name: "Weight",         kind: "numeric",  unit: "lb",   builtin: true },
  { name: "Sleep",          kind: "duration", unit: "hr",   builtin: true },
];

async function ensureHealthSeeded() {
  const existing = await db.healthMetrics.list();
  if (existing.length > 0) { return; }
  for (const m of BUILTIN_METRICS) {
    await db.healthMetrics.save({ ...m });
  }
}

function todayISODate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatReadingValue(reading, metric) {
  if (metric.kind === "dual") {
    return `${reading.valueSystolic}/${reading.valueDiastolic}`;
  }
  return String(reading.value);
}

function formatDateLabel(isoDate) {
  if (!isoDate) { return ""; }
  const today = todayISODate();
  if (isoDate === today) { return "Today"; }
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yyyy = y.getFullYear();
  const mm = String(y.getMonth() + 1).padStart(2, "0");
  const dd = String(y.getDate()).padStart(2, "0");
  if (isoDate === `${yyyy}-${mm}-${dd}`) { return "Yesterday"; }
  // Show as "Apr 12" for recent, "Apr 12, 2025" otherwise
  const [yr, mo, day] = isoDate.split("-").map(Number);
  const dt = new Date(yr, mo - 1, day);
  const thisYear = new Date().getFullYear();
  const opts = yr === thisYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return dt.toLocaleDateString(undefined, opts);
}

function sortReadings(readings) {
  // Newest first by date; tiebreak by recordedAt or id
  return [...readings].sort((a, b) => {
    if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
    const at = a.recordedAt || "";
    const bt = b.recordedAt || "";
    if (at !== bt) { return at < bt ? 1 : -1; }
    return (b.id || 0) - (a.id || 0);
  });
}

async function renderHealthToday(el) {
  await ensureHealthSeeded();
  const metrics = await db.healthMetrics.list();
  metrics.sort((a, b) => (a.id || 0) - (b.id || 0));

  if (metrics.length === 0) {
    el.innerHTML = "<div class=\"empty\">No metrics yet. Add one in the Metrics tab.</div>";
    return;
  }

  const allReadings = await db.healthReadings.list();
  const byMetric = new Map();
  for (const r of allReadings) {
    if (!byMetric.has(r.metricId)) { byMetric.set(r.metricId, []); }
    byMetric.get(r.metricId).push(r);
  }

  let html = "<div class=\"section-title\">Today</div>";
  for (const m of metrics) {
    const readings = sortReadings(byMetric.get(m.id) || []);
    const latest = readings[0];
    const recent = readings.slice(1, 4);

    html += `
      <div class="card">
        <div class="metric-card-head">
          <button class="metric-name" onclick="app.viewMetric(${m.id})">${esc(m.name)}</button>
          <button class="btn btn-primary btn-sm" onclick="app.addReading(${m.id})">+ Add</button>
        </div>
        ${latest ? `
          <div class="metric-latest">${formatReadingValue(latest, m)} <span style="font-size:.85rem;color:var(--muted);font-weight:400">${esc(m.unit)}</span></div>
          <div class="metric-latest-meta">${formatDateLabel(latest.date)}${latest.notes ? " · " + esc(latest.notes) : ""}</div>
        ` : "<div class=\"muted\" style=\"font-size:.9rem;margin:8px 0 4px\">No readings yet.</div>"}
        ${recent.length > 0 ? `
          <div style="margin-top:8px">
            ${recent.map((r) => `
              <div class="reading-row">
                <span class="reading-value">${formatReadingValue(r, m)} <span class="muted" style="font-weight:400">${esc(m.unit)}</span></span>
                <span class="reading-date">${formatDateLabel(r.date)}</span>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  el.innerHTML = html;
  if (window.lucide) { lucide.createIcons(); }
}

async function renderHealthMetrics(el) {
  await ensureHealthSeeded();
  const metrics = await db.healthMetrics.list();
  metrics.sort((a, b) => (a.id || 0) - (b.id || 0));
  const allReadings = await db.healthReadings.list();
  const counts = new Map();
  for (const r of allReadings) {
    counts.set(r.metricId, (counts.get(r.metricId) || 0) + 1);
  }

  let html = `
    <div class="section-title">Metrics</div>
    <div class="card">
      <button class="btn btn-primary btn-sm btn-full" onclick="app.showMetricModal()">+ New Metric</button>
    </div>
  `;

  for (const m of metrics) {
    const count = counts.get(m.id) || 0;
    html += `
      <div class="card">
        <div class="metric-card-head">
          <div>
            <div class="card-title" style="margin-bottom:2px">${esc(m.name)}</div>
            <div class="muted" style="font-size:.8rem">${esc(m.kind)} · ${esc(m.unit)} · ${count} reading${count === 1 ? "" : "s"}${m.builtin ? " · built-in" : ""}</div>
          </div>
          <button class="menu-btn" onclick="app.metricMenu(${m.id})">⋮</button>
        </div>
        <div class="inline-actions hidden" id="menu-metric-${m.id}">
          <button class="btn btn-ghost btn-sm" onclick="app.showMetricModal(${m.id})">Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="app.viewMetric(${m.id})">View log</button>
          ${m.builtin ? "" : `<button class="btn btn-danger btn-sm" onclick="app.deleteMetric(${m.id})">Delete</button>`}
        </div>
      </div>
    `;
  }

  el.innerHTML = html;
  if (window.lucide) { lucide.createIcons(); }
}

async function renderHealthMetricDetail(el) {
  if (!viewingMetricId) {
    navigate("health-today");
    return;
  }
  const m = await db.healthMetrics.get(viewingMetricId);
  if (!m) {
    viewingMetricId = null;
    navigate("health-today");
    return;
  }
  const readings = sortReadings(await db.healthReadings.listForMetric(m.id));

  let html = `
    <div class="section-title">${esc(m.name)}</div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="muted" style="font-size:.85rem">${esc(m.kind)} · ${esc(m.unit)} · ${readings.length} reading${readings.length === 1 ? "" : "s"}</div>
        <button class="btn btn-primary btn-sm" onclick="app.addReading(${m.id})">+ Add</button>
      </div>
    </div>
  `;

  if (readings.length === 0) {
    html += "<div class=\"empty\">No readings yet.</div>";
  } else {
    html += "<div class=\"card\">";
    for (const r of readings) {
      html += `
        <div class="reading-row" style="align-items:flex-start">
          <div>
            <div class="reading-value">${formatReadingValue(r, m)} <span class="muted" style="font-weight:400">${esc(m.unit)}</span></div>
            ${r.notes ? `<div class="reading-notes">${esc(r.notes)}</div>` : ""}
          </div>
          <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px">
            <span class="reading-date">${formatDateLabel(r.date)}</span>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" onclick="app.editReading(${r.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="app.deleteReading(${r.id})">Delete</button>
            </div>
          </div>
        </div>
      `;
    }
    html += "</div>";
  }

  el.innerHTML = html;
}

function viewMetric(metricId) {
  viewingMetricId = metricId;
  navigate("health-metric");
}

function metricMenu(metricId) {
  toggleMenu(`metric-${metricId}`);
}

async function addReading(metricId) {
  const m = await db.healthMetrics.get(metricId);
  if (!m) { return; }
  showReadingModal(m, null);
}

async function editReading(readingId) {
  const r = await db.healthReadings.get(readingId);
  if (!r) { return; }
  const m = await db.healthMetrics.get(r.metricId);
  if (!m) { return; }
  showReadingModal(m, r);
}

function localTimeFromISO(isoStr) {
  const d = new Date(isoStr);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function currentLocalTime() {
  const now = new Date();
  return String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
}

function showReadingModal(metric, existing) {
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");
  const date = existing ? existing.date : todayISODate();
  const time = existing && existing.recordedAt ? localTimeFromISO(existing.recordedAt) : currentLocalTime();
  const notes = existing ? (existing.notes || "") : "";

  let valueFields;
  if (metric.kind === "dual") {
    const sys = existing ? existing.valueSystolic : 120;
    const dia = existing ? existing.valueDiastolic : 80;
    valueFields = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field">
          <label>Systolic</label>
          <input type="text" id="m-rd-sys" value="${sys}" inputmode="numeric" pattern="[0-9]*">
        </div>
        <div class="field">
          <label>Diastolic</label>
          <input type="text" id="m-rd-dia" value="${dia}" inputmode="numeric" pattern="[0-9]*">
        </div>
      </div>`;
  } else {
    const val = existing ? existing.value : "";
    valueFields = `
      <div class="field">
        <label>${esc(metric.name)} (${esc(metric.unit)})</label>
        <input type="number" id="m-rd-val" value="${val}" step="any" inputmode="decimal">
      </div>`;
  }

  modal.innerHTML = `
    <div class="modal-title">${existing ? "Edit" : "New"} ${esc(metric.name)} reading</div>
    ${valueFields}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="field">
        <label>Date</label>
        <input type="date" id="m-rd-date" value="${date}">
      </div>
      <div class="field">
        <label>Time</label>
        <input type="time" id="m-rd-time" value="${time}">
      </div>
    </div>
    <div class="field">
      <label>Notes (optional)</label>
      <input type="text" id="m-rd-notes" value="${esc(notes)}">
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="app.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="app.saveReading(${metric.id}, ${existing ? existing.id : "null"})">Save</button>
    </div>
  `;
  backdrop.classList.remove("hidden");
}

async function saveReading(metricId, readingId) {
  const m = await db.healthMetrics.get(metricId);
  if (!m) { return; }
  const date = document.getElementById("m-rd-date").value;
  const time = document.getElementById("m-rd-time").value;
  const notes = document.getElementById("m-rd-notes").value.trim();
  if (!date) { toast("Date is required"); return; }

  const recordedAt = new Date(`${date}T${time || "00:00"}:00`).toISOString();

  const record = {
    metricId,
    date,
    notes,
    source: "manual",
    recordedAt,
  };
  if (readingId) { record.id = readingId; }

  if (m.kind === "dual") {
    const sys = parseFloat(document.getElementById("m-rd-sys").value);
    const dia = parseFloat(document.getElementById("m-rd-dia").value);
    if (isNaN(sys) || isNaN(dia)) { toast("Enter both values"); return; }
    record.valueSystolic = sys;
    record.valueDiastolic = dia;
  } else {
    const val = parseFloat(document.getElementById("m-rd-val").value);
    if (isNaN(val)) { toast("Enter a value"); return; }
    record.value = val;
  }

  await db.healthReadings.save(record);
  closeModal();
  toast("Reading saved");
  renderView();
}

async function deleteReading(readingId) {
  if (!confirm("Delete this reading?")) { return; }
  await db.healthReadings.delete(readingId);
  toast("Reading deleted");
  renderView();
}

async function showMetricModal(metricId) {
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");
  const existing = metricId ? await db.healthMetrics.get(metricId) : null;
  const name = existing ? existing.name : "";
  const kind = existing ? existing.kind : "numeric";
  const unit = existing ? existing.unit : "";
  const builtin = existing && existing.builtin;

  modal.innerHTML = `
    <div class="modal-title">${existing ? "Edit" : "New"} metric</div>
    <div class="field">
      <label>Name</label>
      <input type="text" id="m-met-name" value="${esc(name)}" ${builtin ? "readonly" : ""} placeholder="e.g. Resting Heart Rate">
    </div>
    <div class="field">
      <label>Kind</label>
      <select id="m-met-kind" ${existing ? "disabled" : ""}>
        <option value="numeric"  ${kind === "numeric"  ? "selected" : ""}>Numeric (single value)</option>
        <option value="dual"     ${kind === "dual"     ? "selected" : ""}>Dual (e.g. systolic/diastolic)</option>
        <option value="duration" ${kind === "duration" ? "selected" : ""}>Duration</option>
      </select>
    </div>
    <div class="field">
      <label>Unit</label>
      <input type="text" id="m-met-unit" value="${esc(unit)}" placeholder="e.g. bpm, lb, kg, hr">
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="app.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="app.saveMetric(${existing ? existing.id : "null"})">Save</button>
    </div>
  `;
  backdrop.classList.remove("hidden");
}

async function saveMetric(metricId) {
  const name = document.getElementById("m-met-name").value.trim();
  const kind = document.getElementById("m-met-kind").value;
  const unit = document.getElementById("m-met-unit").value.trim();
  if (!name) { toast("Name is required"); return; }
  if (!unit) { toast("Unit is required"); return; }

  const record = { name, kind, unit, builtin: false };
  if (metricId) {
    const prev = await db.healthMetrics.get(metricId);
    if (prev) {
      record.id = metricId;
      record.builtin = prev.builtin || false;
      // Built-ins keep their name regardless
      if (prev.builtin) { record.name = prev.name; }
    }
  }

  try {
    await db.healthMetrics.save(record);
  } catch (err) {
    if (err && err.name === "ConstraintError") {
      toast("A metric with that name already exists");
      return;
    }
    throw err;
  }
  closeModal();
  toast("Metric saved");
  renderView();
}

async function deleteMetric(metricId) {
  const m = await db.healthMetrics.get(metricId);
  if (!m || m.builtin) { return; }
  const readings = await db.healthReadings.listForMetric(metricId);
  const msg = readings.length > 0
    ? `Delete "${m.name}" and ${readings.length} reading${readings.length === 1 ? "" : "s"}?`
    : `Delete "${m.name}"?`;
  if (!confirm(msg)) { return; }
  for (const r of readings) {
    await db.healthReadings.delete(r.id);
  }
  await db.healthMetrics.delete(metricId);
  toast("Metric deleted");
  renderView();
}

// ─── Nutrition (placeholder) ─────────────────────────────────────────────────

function renderNutritionHome(el) {
  el.innerHTML = `
    <div class="empty" style="padding-top:80px">
      <div style="font-size:2rem;margin-bottom:12px">🍎</div>
      <div style="font-weight:600;margin-bottom:6px">Nutrition tracking — coming soon</div>
      <div style="font-size:.85rem">This mode is a placeholder. Check back later.</div>
    </div>
  `;
}

// ─── Expose to HTML ───────────────────────────────────────────────────────────

window.app = {
  navigate,
  setMode,
  toggleTheme,
  startWorkout,
  finishWorkout,
  tapSet,
  toggleInlineEdit,
  saveInlineEdit,
  removeFromSession,
  showAddExerciseToSession,
  startTimer,
  stopTimer,
  updateDefaults,
  dismissToast,
  toggleRoutine,
  routineMenu,
  routineExerciseMenu,
  exerciseMenu,
  showRoutineModal,
  showAddExerciseDefaults,
  confirmAddExerciseToRoutine,
  showRoutineExerciseModal,
  saveRoutineExercise,
  removeRoutineExercise,
  showExerciseModal,
  saveExercise,
  deleteExercise,
  saveRoutine,
  deleteRoutine,
  showAddExerciseToRoutine,
  pickerSelect,
  pickerCreate,
  closeModal,
  viewSession,
  deleteSession,
  navigateEditSession,
  toggleSessionExercise,
  saveSessionExerciseEdit,
  showExerciseHistory,
  requestNotificationPermission,
  disableNotifications,
  saveClientId,
  driveSignIn,
  reconnectDrive,
  driveSignOut,
  driveBackup,
  driveRestore,
  exportJSON,
  triggerImport,
  importJSON,
  viewMetric,
  metricMenu,
  addReading,
  editReading,
  saveReading,
  deleteReading,
  showMetricModal,
  saveMetric,
  deleteMetric,
};

boot();
