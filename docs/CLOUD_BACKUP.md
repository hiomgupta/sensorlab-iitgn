# Optional Google sign-in and Firebase backup

The default build remains offline-only: no Firebase SDK, configuration, remote
requests, or relaxed Content Security Policy are shipped. Its Profile panel explains
that backup is not configured. A separate, explicitly configured build adds Google
sign-in and Cloud Firestore backup. Nothing needs a server to record locally.

## Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), create a new
   project. Analytics is not needed. Register a **Web app**.
2. In **Authentication > Sign-in method**, enable **Google** and configure the
   required support email. In **Authentication > Settings > Authorized domains**,
   add your HTTPS hosting domain. Add `localhost` explicitly for local testing;
   new projects do not necessarily authorize it by default.
3. Create **Cloud Firestore** in **production mode**, choosing an appropriate
   region. Never use open/test-mode rules for real user data.
4. Deploy [firestore.rules](../firestore.rules) before allowing sign-in:

   ```powershell
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules --project YOUR_PROJECT_ID
   ```

   The CLI prompts are for the project owner. No administrator credentials belong
   in this repository, browser, or chat. Alternatively paste the supplied rules
   into the Firestore console and publish them.

5. Copy **only these four public Web app configuration values** into
   `firebase-config.local.json` at the repository root (this file is gitignored):

   ```json
   {
     "apiKey": "YOUR_PUBLIC_FIREBASE_WEB_API_KEY",
     "authDomain": "YOUR_PROJECT_ID.firebaseapp.com",
     "projectId": "YOUR_PROJECT_ID",
     "appId": "YOUR_FIREBASE_WEB_APP_ID"
   }
   ```

   Use the Firebase-provided `firebaseapp.com` auth domain. Custom auth domains are
   not supported by this build configuration. The web API key identifies a project;
   it is not an authorization secret. Firestore rules enforce per-user access.
   Do not supply service-account JSON, private keys, database secrets, or passwords.

6. Install dependencies and build the opt-in edition:

   ```powershell
   npm.cmd ci
   npm.cmd run build -- --cloud-config .\firebase-config.local.json
   npm.cmd run serve
   ```

   Open `http://localhost:8080` for development, or deploy the contents of `dist`
   to an HTTPS static host for production. Google popup sign-in does not work from
   `file://`. Root-source development remains offline-only; use the built edition
   to test cloud features. Running `npm.cmd run build` without the flag restores
   the strict offline-only edition.

## Profile and connected history

**Profile** replaces the old Cloud entry in the header. Its always-visible label
distinguishes signed-in, signed-out, offline sign-in, remembered-account/sign-in-needed,
and local-only states. A remembered account is never presented as an active login.
The panel brings together account identity, Google sign-in/account switching/sign-out,
cloud backup state and Sync now, local recording counts, and the three most recent
recordings. **View all history** opens the existing History view; selecting a recent
recording goes directly to its readings, annotations and export tools. The top-bar
History shortcut remains available.

Recording counts include all accounts stored in this browser, not a downloaded cloud
library. Per-session labels distinguish local-only, pending backup, another account's
backup, and a completed backup. Local storage or backup errors are shown explicitly.
Profile photos are not loaded; initials keep the UI usable offline without contacting
image hosts.

The grouping follows [NN/g's visibility and recognition guidance](https://www.nngroup.com/articles/ten-usability-heuristics/)
and the separation of account/sync states illustrated by
[OneDrive's status indicators](https://support.microsoft.com/en-gb/onedrive/what-do-the-onedrive-icons-mean?nochrome=true).
It is a compact native dialog rather than a new dashboard or recording workflow.

## Account and offline behavior

- The **Profile** panel's Google sign-in enables automatic profile backup and
  backup of new completed recordings, including stored readings and annotations.
- The browser remembers the last account. New offline recordings are assigned
  to that account **atomically with their local session header**. They upload only
  when that same account is authenticated online again.
- Old recordings, imported recordings, and recordings made before sign-in remain
  unassigned. **History > Upload** asks for explicit confirmation before assigning
  them to the current account. Existing ownership cannot be changed to another
  account. Account IDs/backup acknowledgements are not carried through imports.
- **Sign out** clears the remembered account for future recordings. It does not
  reassign or delete existing recordings. On shared computers, also sign out before
  another person records. Google/Firebase authentication persists in the browser;
  offline operation is not protection from other users of that browser profile.
- Uploads pause during recording. Completed sessions upload after Stop, or after
  an interrupted recording is recovered in History. Local saving is never dependent
  on Firebase availability. Corrupt or missing chunks block backup explicitly.
- On reconnect, pending data retries automatically while the app is open. Failures
  appear in Profile's Cloud backup section and the event log, with retries between 30 seconds and
  five minutes. **Sync now** retries immediately. Browser online status is only a
  hint; a working authenticated Firebase request is required to acknowledge backup.
  Requests without an acknowledgement time out after 30 seconds and remain pending;
  an SDK request already in flight may still finish, so retries use the same IDs.
- Closing the app stops uploads. Reopening it resumes unacknowledged backups.
  The service worker caches the entire app, including the local Firebase bundle,
  but does not proxy cross-origin Firebase or Google requests.
- Deleting local history deletes **only local copies**. It does not delete completed
  or in-flight cloud copies or sign you out. No cloud download/restore or cloud
  deletion UI is included in this feature; data can be inspected in Firebase console.
  Keep CSV/JSON/ZIP exports as independent backups.

## Data layout and reliability

```text
users/{firebaseUid}                                  Google profile
users/{firebaseUid}/sessions/{sessionId}              completed backup manifest
users/{firebaseUid}/sessions/{sessionId}/parts/{id}   snapshot JSON fragments
```

Profile fields are UID, email, display name, photo URL, email verification,
provider, account creation time, and last cloud sign-in timestamp. Photos are not
fetched by SensorLab's UI. Each user's rules deny unauthenticated and cross-account
access; all other database paths are denied.

Parts contain the original session metadata, columnar chunks, and annotations.
Each payload is at most 180,000 **UTF-8 bytes**, comfortably below Firestore's 1 MiB
document limit. Reassemble each group by `kind` and `sourceId`, ordering fragments
by `partNo`, concatenate their `payload` strings, then parse JSON. The manifest
records document, reading, and annotation counts.

Document IDs are deterministic; retrying writes the same parts without duplicate
readings. The completion manifest is written **last**, and the local acknowledgement
is written only after Firebase acknowledges it. Interrupted uploads may leave parts
without a manifest; those are incomplete, not confirmed backups. Upload retries
overwrite them. A request already in flight at sign-out may finish under its
original owner's rules; no later parts are sent for that account after the switch
is observed. Cloud copies are never silently substituted for local data.

Firestore usage is billed per document operation and storage. Configure usage
monitoring/budget alerts and an appropriate retention policy before lab deployment.
Rules isolate accounts but do not provide rate limiting or enforce storage quotas.

## Validation and first live acceptance test

Run the focused tests and default offline checks:

```powershell
node --test test\unit\cloud-sync.test.js test\unit\storage.test.js
npm.cmd run lint
npm.cmd run build
npm.cmd run audit:offline
npm.cmd run test:e2e
node test\e2e\cloud-smoke.mjs
```

The strict offline audit and existing E2E network assertions target the **default
build**, not the intentionally network-enabled cloud edition. Automated sync tests
use a fake backend and real IndexedDB interfaces; they do not prove live project
configuration, Google popup sign-in, deployed Firestore rules, or billing settings.
The cloud smoke test builds an isolated fake-config edition in `build/test-app`,
verifies offline behavior in Chrome with remote requests blocked, and removes that
test edition afterward. It does not overwrite the configured `dist` app.

Before using a configured project with real data:

1. Sign in with Google on the authorized hosting domain. Confirm the profile under
   `users/{uid}` and a completed recording manifest with correct counts.
2. Go offline, record and stop, close/reopen the app, reconnect, and verify all rows
   and annotations are backed up once. Interrupt a recording and recover it first.
3. Sign out, create a recording, and sign in as a different test account. Verify the
   unassigned recording is not uploaded until explicitly selected, and that old
   owned recordings never upload to the other account.
4. In Firestore's Rules Playground, verify reads/writes are denied when unauthenticated
   and when authenticated as a different UID for both profile and parts paths.
5. Block Firebase access, verify an explicit error and continued local recording,
   restore access, and verify automatic retry and manifest completion.

There is no Firebase project configured by default. Project creation, authorization
and live acceptance require the owner's Firebase console access.
