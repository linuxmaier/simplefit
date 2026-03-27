// Google Drive integration using GIS + Drive REST API v3
// Uses the appDataFolder scope — files are hidden from the user's Drive UI
// but persist across devices when signed into the same Google account.

const BACKUP_FILENAME = "exercise-tracker-backup.json";
const SCOPES = "https://www.googleapis.com/auth/drive.appdata";

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

// Initialize GIS token client. Returns a promise that resolves when ready.
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
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error));
          return;
        }
        accessToken = response.access_token;
        resolve(accessToken);
      },
    });

    resolve(null); // initialized but not yet signed in
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
  let metadataBlob;

  if (existing) {
    // Update existing file content only
    url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`;
    method = "PATCH";
  } else {
    // Create new file in appDataFolder
    url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    method = "POST";
  }

  const metadata = existing
    ? { modifiedTime: new Date().toISOString() }
    : {
      name: BACKUP_FILENAME,
      parents: ["appDataFolder"],
    };

  metadataBlob = new Blob([JSON.stringify(metadata)], { type: "application/json" });

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
