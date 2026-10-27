// OAuth 2.0 Client ID (Web application) from Google Cloud Console.
// It's public by design — no client secret is used. See README for setup.
export const CLIENT_ID = '524937705179-sgdkotspakf6qmna5id1cd9f0c8f54rm.apps.googleusercontent.com';

// Calendar that new blocks are saved to (matched by name, case-insensitive).
export const TARGET_CALENDAR_NAME = 'Time Blocking';

// Default duration (minutes) for a new row when the start time is set.
export const DEFAULT_DURATION = 60;

// Default duration (minutes) for a block created by dragging a task onto the timeline.
export const TASK_DURATION = 30;

// Calendar that tasks dragged from the task board are saved to (matched by name, case-insensitive).
export const TASKS_CALENDAR_NAME = 'Tasks';

// Iron Log's Firebase project, read once by "Import from Iron Log" in the Fitness section.
// Firebase web config is public by design; access is limited by the database rules to your own account.
export const IRON_LOG_FIREBASE = {
  apiKey: 'AIzaSyCjFSCgqRqHIae23iy72-E7hJy9c-ktsls',
  authDomain: 'iron-log-3c398.firebaseapp.com',
  databaseURL: 'https://iron-log-3c398-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'iron-log-3c398',
  appId: '1:457944842806:web:1018c44e54874fc1820e97',
};
