// Google Drive integration using GIS + Drive REST API v3
// Uses the appDataFolder scope — files are hidden from the user's Drive UI
// but persist across devices when signed into the same Google account.

const BACKUP_FILENAME = "exercise-tracker-backup.json";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";
const TOKEN_STORAGE_KEY = "driveToken";

let tokenClient = null;
let accessToken = null;
let clientId = null;

export function setClientId(id) {
  clientId = id;
}

export function isConfigured() {
  return !!clientId;
}

export function isSignedIn() {
  return !!accessToken;
}

// Persist token + expiry to localStorage so it survives page reloads.
function saveToken(token, expiresInSeconds) {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, expiresAt }));
}

// Load a previously saved token if it hasn't expired (with a 60 s buffer).
function loadSavedToken() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) { return null; }
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() < expiresAt - 60_000) { return token; }
  } catch {
    // ignore malformed storage
  }
  return null;
}

function clearSavedToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

// Initialize GIS token client and restore any saved token.
// Returns true if already signed in from a saved token.
export function initDrive() {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error("Google Client ID not set. Configure it in Settings."));
      return;
    }

    if (!window.google) {
      reject(new Error("Google Identity Services not loaded."));
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {}, // overridden per-call in signIn/silentRefresh
    });

    // Restore saved token if still valid
    const saved = loadSavedToken();
    if (saved) {
      accessToken = saved;
      resolve(true);
      return;
    }

    resolve(false);
  });
}

export function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error("Drive not initialized. Call initDrive() first."));
      return;
    }
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      accessToken = response.access_token;
      saveToken(accessToken, response.expires_in || 3600);
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

export function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
  }
  clearSavedToken();
}

// Attempt a silent token refresh (no popup). Resolves true if successful.
export function silentRefresh() {
  return new Promise((resolve) => {
    if (!tokenClient) { resolve(false); return; }
    tokenClient.callback = (response) => {
      if (response.error) { resolve(false); return; }
      accessToken = response.access_token;
      saveToken(accessToken, response.expires_in || 3600);
      resolve(true);
    };
    try {
      tokenClient.requestAccessToken({ prompt: "none" });
    } catch {
      resolve(false);
    }
  });
}

// Returns the Drive file's modifiedTime as an ISO string, or null.
export async function getDriveModifiedTime() {
  if (!accessToken) { return null; }
  try {
    const file = await findBackupFile();
    return file ? file.modifiedTime : null;
  } catch {
    return null;
  }
}

// Find the backup file in appDataFolder. Returns file metadata or null.
async function findBackupFile() {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D%22${encodeURIComponent(BACKUP_FILENAME)}%22&fields=files(id%2Cname%2CmodifiedTime)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`Drive list error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.files.length > 0 ? data.files[0] : null;
}

// Upload (create or update) the backup JSON to appDataFolder.
export async function backupToDrive(jsonData) {
  if (!accessToken) {
    throw new Error("Not signed in to Google Drive.");
  }

  const body = JSON.stringify(jsonData, null, 2);
  const blob = new Blob([body], { type: "application/json" });
  const existing = await findBackupFile();

  let url;
  let method;

  if (existing) {
    url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`;
    method = "PATCH";
  } else {
    url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    method = "POST";
  }

  const metadata = existing
    ? { modifiedTime: new Date().toISOString() }
    : { name: BACKUP_FILENAME, parents: ["appDataFolder"] };

  const metadataBlob = new Blob([JSON.stringify(metadata)], { type: "application/json" });
  const form = new FormData();
  form.append("metadata", metadataBlob);
  form.append("file", blob);

  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive upload error: ${res.status} — ${err}`);
  }

  return await res.json();
}

// Download and parse the backup JSON from appDataFolder.
export async function restoreFromDrive() {
  if (!accessToken) {
    throw new Error("Not signed in to Google Drive.");
  }

  const existing = await findBackupFile();
  if (!existing) {
    throw new Error("No backup found in Google Drive.");
  }

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    throw new Error(`Drive download error: ${res.status} ${res.statusText}`);
  }

  return await res.json();
}

// Returns ISO string of last backup time, or null.
export async function getLastBackupTime() {
  if (!accessToken) { return null; }
  try {
    const file = await findBackupFile();
    return file ? file.modifiedTime : null;
  } catch {
    return null;
  }
}
