# Time Block

A small static web app for adding time blocks to Google Calendar in batches. You enter several blocks, the app checks them against your calendars and flags conflicts, and it saves the blocks straight into your **Time Blocking** calendar. There is no backend and no Apps Script: the app runs entirely in your browser and is hosted on GitHub Pages.

- **Batch entry.** Type blocks into a grid. Pressing <kbd>Enter</kbd> adds a new row that starts when the previous block ends.
- **Conflict check.** New blocks are checked against your primary calendar, Time Blocking, and any other calendars you tick. Blocks also overlap-check each other. Events marked Free, events you declined, and all-day events are ignored (you can switch on all-day events).
- **Recurring blocks.** Set Repeat to Daily, Weekdays or Weekly (pick the days), with an optional end date. A recurring block is saved as one real repeating event, so in Google Calendar you can edit or delete "this / following / all events". Every occurrence is conflict-checked: through the end date if there is one, otherwise over the next 4 weeks.
- **Saves to Time Blocking.** Saved blocks are real Google Calendar events, so they sync to every device. You never pick the calendar by hand, and there's an **Undo** after each save.
- **Week and day view.** The calendar opens in the week view (Monday–Sunday) and takes the right two thirds of the screen on desktop, next to the block list. Switch to Day above the calendar; `#view=day` in the URL opens the day view directly. In the week view you can also drag a new one-off block to another day.
- **Day agenda.** The panel shows your existing events and the new blocks side by side, including Time Blocking events you've hidden in Google Calendar. Like Google Calendar, drag on an empty slot to draw a block, drag a new block to move it, or drag its bottom edge to change its length (15-minute steps). Click an empty slot for a 1-hour block.
- **Task board.** The left panel has four lanes: Backlog, Waiting, Doing and Done. Done is collapsed until you click it. Drag cards between lanes. Waiting cards show who you're waiting on and how long you've been waiting, which turns amber after a week. Drag a task onto the calendar to schedule it as a 1-hour block that saves to your **Tasks** calendar. Tasks are stored only in this browser.
- **Bookmarkable.** Use `…/#date=tomorrow` (or `today`, `mon`, `+2`, `2026-10-01`) to open straight into planning a given day. Unsaved rows are kept as a draft in your browser.

## Keeping blocks out of the month view

Google Calendar has no setting to hide a calendar only in the month view. The usual workflow is to **untick "Time Blocking"** in Google Calendar's sidebar when you look at the month, and tick it again for day or week views. This app still checks against Time Blocking while it's hidden, because hiding a calendar only affects what Google Calendar displays; the events remain available through the API. The agenda panel here always shows those blocks too.

## One-time setup (~5 minutes)

### 1. Google Cloud: OAuth Client ID
1. Go to <https://console.cloud.google.com/> and create a project (e.g. "Time Block").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**. Fill in the app name and your email.
   - **Data access → Add or remove scopes**: add these two (paste them into *Manually add scopes* if they aren't listed; the Calendar API must be enabled first):
     ```
     https://www.googleapis.com/auth/calendar.events
     https://www.googleapis.com/auth/calendar.calendarlist.readonly
     ```
   - **Audience → Test users**: add your own Google account. For personal use you can leave the app in *Testing*, and no verification is needed.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `https://<your-github-username>.github.io`
     - `http://localhost:8080` (for local testing)
   - No redirect URIs are needed.
5. Copy the Client ID into [`config.js`](config.js):
   ```js
   export const CLIENT_ID = '1234567890-abc.apps.googleusercontent.com';
   ```
   A Client ID is public by design, so it's safe to commit. The app uses no client secret.

### 2. Google Calendar
Make sure you have a calendar named **Time Blocking**. You can use a different name by changing `TARGET_CALENDAR_NAME` in `config.js`, or by picking another calendar under ⚙ in the app. Scheduled tasks go to a calendar named **Tasks** (`TASKS_CALENDAR_NAME`).

### 3. GitHub Pages
1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment**: Source *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` and bookmark it. Optionally, also bookmark `…/#date=tomorrow` for evening planning.

## Keyboard

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Go to the next row, or add a new row after the last one |
| <kbd>Shift+Enter</kbd> | Go to the previous row |
| <kbd>Backspace</kbd> on an empty title | Remove the row |
| <kbd>Ctrl/⌘+Enter</kbd> | Check conflicts; if everything is already checked, save |
| <kbd>Alt+←/→</kbd> | Change the planning date |

## Local development

```bash
python -m http.server 8080
```

Open <http://localhost:8080>. Unit tests for the parsing and conflict logic:

```bash
node --test
```

## Privacy

Your Google access token stays in this browser tab's `sessionStorage` and expires after about an hour. The page talks only to Google's APIs. Drafts and settings are saved in your browser's `localStorage`. The app has no server of its own.
