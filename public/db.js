// IndexedDB schema version
const DB_NAME = "exercise-tracker";
const DB_VERSION = 1;

let db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const d = e.target.result;

      // Routines: named workout plans
      const routines = d.createObjectStore("routines", { keyPath: "id", autoIncrement: true });
      routines.createIndex("name", "name", { unique: false });

      // Master exercise list
      const exercises = d.createObjectStore("exercises", { keyPath: "id", autoIncrement: true });
      exercises.createIndex("name", "name", { unique: true });

      // Exercises within a routine (with defaults)
      const routineExercises = d.createObjectStore("routineExercises", { keyPath: "id", autoIncrement: true });
      routineExercises.createIndex("routineId", "routineId");
      routineExercises.createIndex("exerciseId", "exerciseId");

      // Workout sessions
      const sessions = d.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
      sessions.createIndex("date", "date");
      sessions.createIndex("routineId", "routineId");

      // Exercises performed in a session
      const sessionExercises = d.createObjectStore("sessionExercises", { keyPath: "id", autoIncrement: true });
      sessionExercises.createIndex("sessionId", "sessionId");
      sessionExercises.createIndex("exerciseId", "exerciseId");
    };

    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

// ─── Generic helpers ────────────────────────────────────────────────────────

function tx(stores, mode = "readonly") {
  return db.transaction(stores, mode);
}

function all(store, indexName, query) {
  return new Promise((resolve, reject) => {
    const t = tx(store);
    const s = t.objectStore(store);
    const req = indexName ? s.index(indexName).getAll(query) : s.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function get(store, id) {
  return new Promise((resolve, reject) => {
    const req = tx(store).objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function put(store, record) {
  return new Promise((resolve, reject) => {
    const t = tx(store, "readwrite");
    const req = t.objectStore(store).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function remove(store, id) {
  return new Promise((resolve, reject) => {
    const t = tx(store, "readwrite");
    const req = t.objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Routines ────────────────────────────────────────────────────────────────

export const routines = {
  list: () => all("routines"),
  get: (id) => get("routines", id),
  save: (r) => put("routines", { ...r, updatedAt: new Date().toISOString() }),
  delete: (id) => remove("routines", id),
};

// ─── Exercises ───────────────────────────────────────────────────────────────

export const exercises = {
  list: () => all("exercises"),
  get: (id) => get("exercises", id),
  save: (e) => put("exercises", { ...e, updatedAt: new Date().toISOString() }),
  delete: (id) => remove("exercises", id),
};

// ─── Routine Exercises ───────────────────────────────────────────────────────

export const routineExercises = {
  listForRoutine: (routineId) => all("routineExercises", "routineId", routineId),
  get: (id) => get("routineExercises", id),
  save: (re) => put("routineExercises", re),
  delete: (id) => remove("routineExercises", id),
};

// ─── Sessions ────────────────────────────────────────────────────────────────

export const sessions = {
  list: () => all("sessions"),
  get: (id) => get("sessions", id),
  listByDate: (date) => all("sessions", "date", date),
  save: (s) => put("sessions", s),
  delete: (id) => remove("sessions", id),
};

// ─── Session Exercises ───────────────────────────────────────────────────────

export const sessionExercises = {
  listForSession: (sessionId) => all("sessionExercises", "sessionId", sessionId),
  listForExercise: (exerciseId) => all("sessionExercises", "exerciseId", exerciseId),
  get: (id) => get("sessionExercises", id),
  save: (se) => put("sessionExercises", se),
  delete: (id) => remove("sessionExercises", id),
};

// ─── Export / Import ─────────────────────────────────────────────────────────

export async function exportAll() {
  await openDB();
  const [r, e, re, s, se] = await Promise.all([
    routines.list(),
    exercises.list(),
    routineExercises.listForRoutine ? all("routineExercises") : [],
    sessions.list(),
    all("sessionExercises"),
  ]);
  return {
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    routines: r,
    exercises: e,
    routineExercises: re,
    sessions: s,
    sessionExercises: se,
  };
}

export async function importAll(data) {
  await openDB();
  const stores = ["routines", "exercises", "routineExercises", "sessions", "sessionExercises"];
  const t = db.transaction(stores, "readwrite");

  // Clear all stores first
  for (const store of stores) {
    t.objectStore(store).clear();
  }

  const records = {
    routines: data.routines || [],
    exercises: data.exercises || [],
    routineExercises: data.routineExercises || [],
    sessions: data.sessions || [],
    sessionExercises: data.sessionExercises || [],
  };

  for (const [store, rows] of Object.entries(records)) {
    const os = t.objectStore(store);
    for (const row of rows) {
      os.put(row);
    }
  }

  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
