import * as db from "./db.js";
import * as drive from "./drive.js";

// ─── State ───────────────────────────────────────────────────────────────────

let currentView = "home";
let activeSession = null; // { session, exercises: [sessionExercise & exerciseName] }

// ─── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  await db.openDB();

  // Restore Google Client ID if saved
  const savedClientId = localStorage.getItem("gClientId");
  if (savedClientId) {
    drive.setClientId(savedClientId);
    try {
      await drive.initDrive();
    } catch {
      // not fatal — user can sign in from settings
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

  renderNav();
  navigate("home");
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigate(view) {
  currentView = view;
  renderNav();
  renderView();
}

function renderNav() {
  const tabs = [
    { id: "home",     icon: "🏠", label: "Home" },
    { id: "routines", icon: "📋", label: "Routines" },
    { id: "log",      icon: "📅", label: "Log" },
    { id: "settings", icon: "⚙️",  label: "Settings" },
  ];

  document.getElementById("nav").innerHTML = tabs
    .map(
      (t) => `<button class="${currentView === t.id ? "active" : ""}" onclick="app.navigate('${t.id}')">
        <span class="icon">${t.icon}</span>${t.label}
      </button>`
    )
    .join("");
}

function renderView() {
  const main = document.getElementById("main");
  const hdr  = document.getElementById("page-title");

  switch (currentView) {
  case "home":     hdr.textContent = "Workout";   renderHome(main);     break;
  case "workout":  hdr.textContent = "Active";    renderWorkout(main);  break;
  case "routines": hdr.textContent = "Routines";  renderRoutines(main); break;
  case "log":      hdr.textContent = "History";   renderLog(main);      break;
  case "settings": hdr.textContent = "Settings";  renderSettings(main); break;
  case "exercise-history": hdr.textContent = "Progress"; renderExerciseHistory(main); break;
  }
}

// ─── Home ─────────────────────────────────────────────────────────────────────

async function renderHome(el) {
  const routineList = await db.routines.list();

  let html = "";

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
    await db.sessionExercises.save({
      sessionId,
      exerciseId: re.exerciseId,
      exerciseName: re.exerciseName,
      sets: re.defaultSets,
      reps: re.defaultReps,
      weight: re.defaultWeight,
      completed: false,
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
  return { session, exercises: exes };
}

async function renderWorkout(el) {
  if (!activeSession) {
    el.innerHTML = "<div class=\"empty\">No active workout. Start one from Home.</div>";
    return;
  }

  const exes = activeSession.exercises;
  const done = exes.filter((e) => e.completed).length;

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <div style="font-weight:700;font-size:1.05rem">${esc(activeSession.session.routineName || "Workout")}</div>
        <div class="muted" style="font-size:.85rem">${done}/${exes.length} exercises done</div>
      </div>
      <button class="btn btn-green btn-sm" onclick="app.finishWorkout()">Finish</button>
    </div>
    <div id="ex-list">`;

  for (const ex of exes) {
    html += renderExRow(ex);
  }

  html += `</div>
    <div style="margin-top:16px">
      <button class="btn btn-ghost btn-sm btn-full" onclick="app.showAddExerciseToSession()">+ Add Exercise</button>
    </div>`;

  el.innerHTML = html;
}

function renderExRow(ex) {
  return `<div class="ex-row" id="ex-${ex.id}">
    <button class="ex-check ${ex.completed ? "done" : ""}"
      onclick="app.toggleExercise(${ex.id})">${ex.completed ? "✓" : ""}</button>
    <div>
      <div class="ex-name">${esc(ex.exerciseName)}</div>
      <div class="ex-meta" id="meta-${ex.id}">${ex.sets}×${ex.reps} @ ${ex.weight} lbs</div>
    </div>
    <button class="ex-edit-btn" onclick="app.toggleInlineEdit(${ex.id})">Edit</button>
  </div>
  <div class="inline-edit hidden" id="edit-${ex.id}">
    <div class="field">
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
    </div>
    <div style="grid-column:1/-1;display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" onclick="app.saveInlineEdit(${ex.id})">Save</button>
      <button class="btn btn-ghost btn-sm" onclick="app.toggleInlineEdit(${ex.id})">Cancel</button>
      <button class="btn btn-danger btn-sm" style="margin-left:auto" onclick="app.removeFromSession(${ex.id})">Remove</button>
    </div>
  </div>`;
}

function toggleInlineEdit(exId) {
  const el = document.getElementById(`edit-${exId}`);
  el.classList.toggle("hidden");
}

async function toggleExercise(exId) {
  const ex = activeSession.exercises.find((e) => e.id === exId);
  if (!ex) { return; }
  ex.completed = !ex.completed;
  await db.sessionExercises.save(ex);

  // Re-render just this row
  const row = document.getElementById(`ex-${exId}`);
  const check = row.querySelector(".ex-check");
  check.classList.toggle("done", ex.completed);
  check.textContent = ex.completed ? "✓" : "";
}

async function saveInlineEdit(exId) {
  const ex = activeSession.exercises.find((e) => e.id === exId);
  if (!ex) { return; }
  ex.sets   = parseInt(document.getElementById(`sets-${exId}`).value, 10) || ex.sets;
  ex.reps   = parseInt(document.getElementById(`reps-${exId}`).value, 10) || ex.reps;
  ex.weight = parseFloat(document.getElementById(`weight-${exId}`).value) || ex.weight;
  await db.sessionExercises.save(ex);

  document.getElementById(`meta-${exId}`).textContent = `${ex.sets}×${ex.reps} @ ${ex.weight} lbs`;
  toggleInlineEdit(exId);
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

async function finishWorkout() {
  if (!activeSession) { return; }
  const total = activeSession.exercises.length;
  const done  = activeSession.exercises.filter((e) => e.completed).length;
  if (done < total && !confirm(`Only ${done}/${total} exercises completed. Finish anyway?`)) { return; }

  activeSession.session.completedAt = new Date().toISOString();
  await db.sessions.save(activeSession.session);
  activeSession = null;
  navigate("home");

  if (drive.isSignedIn()) {
    try {
      const data = await db.exportAll();
      await drive.backupToDrive(data);
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
    const id = await db.sessionExercises.save({
      sessionId: activeSession.session.id,
      exerciseId: ex.id,
      exerciseName: ex.name,
      sets: 3,
      reps: 10,
      weight: 0,
      completed: false,
      orderIndex: idx,
    });
    const saved = await db.sessionExercises.get(id);
    activeSession.exercises.push(saved);
    const list = document.getElementById("ex-list");
    list.insertAdjacentHTML("beforeend", renderExRow(saved));
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
  const chevron = document.getElementById(`routine-chevron-${id}`);
  const open    = expandedRoutines.has(id);
  body.style.display    = open ? "block" : "none";
  chevron.style.transform = open ? "rotate(180deg)" : "";
}

async function renderRoutines(el) {
  const list = await db.routines.list();

  let html = "<button class=\"btn btn-primary btn-full\" style=\"margin-bottom:16px\" onclick=\"app.showRoutineModal()\">+ New Routine</button>";

  if (list.length === 0) {
    html += "<div class=\"empty\">No routines yet.</div>";
  } else {
    for (const r of list) {
      const exes = await db.routineExercises.listForRoutine(r.id);
      exes.sort((a, b) => a.orderIndex - b.orderIndex);
      const open = expandedRoutines.has(r.id);
      html += `<div class="card" style="padding-bottom:${open ? "var(--gap)" : "0"}">
        <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding-bottom:${open ? "var(--gap)" : "0"}"
             onclick="app.toggleRoutine(${r.id})">
          <div>
            <div class="card-title" style="margin:0">${esc(r.name)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="muted" style="font-size:.8rem">${exes.length} exercise${exes.length !== 1 ? "s" : ""}</span>
            <span id="routine-chevron-${r.id}" style="color:var(--muted);transition:transform .2s;display:inline-block${open ? ";transform:rotate(180deg)" : ""}">▾</span>
          </div>
        </div>
        <div id="routine-body-${r.id}" style="display:${open ? "block" : "none"}">
          ${r.notes ? `<div class="muted" style="font-size:.85rem;margin-bottom:10px">${esc(r.notes)}</div>` : ""}
          <div style="margin-bottom:10px;border-top:1px solid var(--border)">
            ${exes.length === 0
    ? "<div class='muted' style='font-size:.85rem;padding:10px 0'>No exercises yet</div>"
    : exes.map((e) => `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div>
                  <div>${esc(e.exerciseName)}</div>
                  <div class="muted" style="font-size:.8rem">${e.defaultSets}×${e.defaultReps} @ ${e.defaultWeight} lbs</div>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                  <button class="btn btn-ghost btn-sm" onclick="app.showRoutineExerciseModal(${e.id})">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="app.removeRoutineExercise(${e.id})">✕</button>
                </div>
              </div>`).join("")}
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" onclick="app.showAddExerciseToRoutine(${r.id})">+ Add Exercise</button>
            <button class="btn btn-ghost btn-sm" onclick="app.showRoutineModal(${r.id})">Edit Routine</button>
            <button class="btn btn-danger btn-sm" onclick="app.deleteRoutine(${r.id})">Delete</button>
          </div>
        </div>
      </div>`;
    }
  }

  // Exercises section
  const allExercises = await db.exercises.list();
  allExercises.sort((a, b) => a.name.localeCompare(b.name));

  html += `<div class="section-title">Exercises</div>
    <button class="btn btn-ghost btn-full" style="margin-bottom:12px" onclick="app.showExerciseModal()">+ New Exercise</button>`;

  if (allExercises.length === 0) {
    html += "<div class=\"empty\">No exercises yet.</div>";
  } else {
    html += "<div class=\"card\">";
    for (const e of allExercises) {
      html += `<div class="session-row">
        <div>
          <div style="font-weight:600">${esc(e.name)}</div>
          ${e.muscleGroup ? `<div class="muted" style="font-size:.8rem">${esc(e.muscleGroup)}</div>` : ""}
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="app.showExerciseModal(${e.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="app.deleteExercise(${e.id})">Delete</button>
        </div>
      </div>`;
    }
    html += "</div>";
  }

  el.innerHTML = html;
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
    modal.innerHTML = `
      <div class="modal-title">${exerciseId ? "Edit Exercise" : "New Exercise"}</div>
      <div class="field"><label>Name</label><input type="text" id="m-ex-name" value="${esc(e ? e.name : "")}"></div>
      <div class="field"><label>Muscle group (optional)</label><input type="text" id="m-ex-muscle" value="${esc(e ? e.muscleGroup || "" : "")}"></div>
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
  try {
    const record = { name, muscleGroup };
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

  db.routineExercises.get(routineExerciseId).then((re) => {
    modal.innerHTML = `
      <div class="modal-title">${esc(re.exerciseName)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="field">
          <label>Sets</label>
          <input type="number" id="m-re-sets" value="${re.defaultSets}" min="1">
        </div>
        <div class="field">
          <label>Reps</label>
          <input type="number" id="m-re-reps" value="${re.defaultReps}" min="1">
        </div>
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
    re.defaultReps   = parseInt(document.getElementById("m-re-reps").value, 10)   || re.defaultReps;
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

// Add exercise to a routine
function showAddExerciseToRoutine(routineId) {
  showExercisePicker((ex) => showAddExerciseDefaults(routineId, ex));
}

function showAddExerciseDefaults(routineId, ex) {
  const modal = document.getElementById("modal");
  const backdrop = document.getElementById("modal-backdrop");

  modal.innerHTML = `
    <div class="modal-title">${esc(ex.name)}</div>
    <div class="muted" style="margin-bottom:16px;font-size:.85rem">Set defaults for this routine</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
      <div class="field">
        <label>Sets</label>
        <input type="number" id="m-add-sets" value="3" min="1">
      </div>
      <div class="field">
        <label>Reps</label>
        <input type="number" id="m-add-reps" value="10" min="1">
      </div>
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
    await db.routineExercises.save({
      routineId,
      exerciseId,
      exerciseName,
      defaultSets:   parseInt(document.getElementById("m-add-sets").value, 10)   || 3,
      defaultReps:   parseInt(document.getElementById("m-add-reps").value, 10)   || 10,
      defaultWeight: parseFloat(document.getElementById("m-add-weight").value)   || 0,
      orderIndex: existing.length,
    });
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
        <button class="btn btn-ghost btn-sm" onclick="app.viewSession(${s.id})">View</button>
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
    ${exes.map((e) => `<div class="session-row">
      <div>
        <div style="font-weight:600">${esc(e.exerciseName)}</div>
        <div class="muted" style="font-size:.85rem">${e.sets}×${e.reps} @ ${e.weight} lbs</div>
      </div>
      ${e.completed ? "<span class='success-text'>✓</span>" : "<span class='muted'>–</span>"}
    </div>`).join("")}
    <div style="margin-top:16px">
      <button class="btn btn-ghost btn-sm" onclick="app.closeModal()">Close</button>
    </div>`;
  backdrop.classList.remove("hidden");
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
    html += `<div class="session-row">
      <span class="muted">${date}</span>
      <span>${se.sets}×${se.reps} @ <strong>${se.weight} lbs</strong></span>
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

  el.innerHTML = `
    <div class="section-title">Google Drive Backup</div>
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

    <div class="section-title">Local Backup</div>
    <div class="card">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="app.exportJSON()">Download JSON</button>
        <button class="btn btn-ghost btn-sm" onclick="app.triggerImport()">Import JSON</button>
      </div>
      <input type="file" id="import-file" accept=".json" style="display:none" onchange="app.importJSON(this)">
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
    toast("Signed in to Google");
    navigate("settings");
  } catch (err) {
    toast("Sign-in failed: " + err.message);
  }
}

function driveSignOut() {
  drive.signOut();
  toast("Signed out");
  navigate("settings");
}

async function driveBackup() {
  try {
    const data = await db.exportAll();
    await drive.backupToDrive(data);
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
    activeSession = null;
    toast("Restored from Drive");
    navigate("home");
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
    navigate("home");
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
  if (toastTimer) { clearTimeout(toastTimer); }
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ─── Expose to HTML ───────────────────────────────────────────────────────────

window.app = {
  navigate,
  startWorkout,
  finishWorkout,
  toggleExercise,
  toggleInlineEdit,
  saveInlineEdit,
  removeFromSession,
  showAddExerciseToSession,
  toggleRoutine,
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
  showExerciseHistory,
  saveClientId,
  driveSignIn,
  driveSignOut,
  driveBackup,
  driveRestore,
  exportJSON,
  triggerImport,
  importJSON,
};

boot();
