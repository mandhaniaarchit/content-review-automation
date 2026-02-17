# Content Review Automation

Automated pipeline that connects **Google Sheets**, **Google Drive**, and **Notion** to streamline marketing content review.

## How It Works

1. **Marketer** adds a row to the Feedback Sheet (Google Sheets) and uploads media to the corresponding Google Drive folder
2. **Script** detects the new row within ~1 minute, matches it to the uploaded media file, and creates a review card in a Notion database with embedded media
3. **Reviewer** opens Notion on any device (phone, iPad, computer), views the content, and fills in Feedback, IG Handles to Tag, and Caption Choice
4. **Script** syncs the review back to the Google Sheet every 5 minutes — feedback is written to the sheet and the chosen caption is highlighted in green

## Architecture

```
Google Sheets (Feedback Sheet)
    ├── Reel Update tab
    ├── Post Update tab
    └── Carousel Update tab
         │
         ▼  (Google Apps Script - time triggers)
         │
Google Drive ◄── Media files (Reels/, Posts/, Carousels/)
         │
         ▼
Notion Database (Content Review)
    ├── Name, Content Type, Review Status
    ├── Feedback, IG Handles to Tag, Caption Choice
    ├── Embedded media from Drive
    └── Sheet Tab, Sheet Row (for sync-back)
```

## Setup

### Prerequisites
- Google account with access to the Feedback Sheet and Drive folders
- Notion account with an internal integration

### 1. Create a Notion Integration
- Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
- Create a new integration with read/write access
- Copy the API key

### 2. Create the Notion Database
Create a database with these properties:

| Property | Type |
|---|---|
| Name | Title |
| Content Type | Select (Reel, Post, Carousel) |
| Review Status | Select (Needs Review, Reviewed, Synced) |
| Date Added | Text |
| Feedback | Text |
| IG Handles to Tag | Text |
| Caption Choice | Select (Not chosen yet, Caption 1, Caption 2) |
| Sheet Tab | Text |
| Sheet Row | Number |

Share the database with your integration via the "..." menu > Connections.

### 3. Configure the Script
Update the `CONFIG` section in `Code.gs` with:
- `NOTION_API_KEY` — your integration's API key
- `NOTION_DATABASE_ID` — from the Notion database URL
- `DRIVE_FOLDERS` — Google Drive folder IDs for each content type

### 4. Deploy to Google Apps Script
1. Open the Feedback Sheet in Google Sheets
2. Go to **Extensions > Apps Script**
3. Delete default code, paste contents of `Code.gs`
4. Save (Ctrl+S)
5. Select `setupTriggers` from the function dropdown and run it
6. Authorize the required permissions when prompted

## Key Functions

| Function | Purpose | Trigger |
|---|---|---|
| `checkForNewContent()` | Detects new rows with media and creates Notion pages | Every 1 minute |
| `syncNotionToSheets()` | Syncs reviewed feedback from Notion back to the sheet | Every 5 minutes |
| `setupTriggers()` | Creates the time-based triggers | Run manually once |
| `resetTracking()` | Clears tracking data (use to reprocess all rows) | Run manually if needed |

## Deduplication

The script prevents duplicate Notion entries using two layers:
1. **Serial number tracking** — tracks processed items by their unique ID (e.g., "Reel Update::reel 71") stored in Script Properties
2. **Notion query check** — before creating a page, queries the Notion database to verify the item doesn't already exist

## Media Matching

Files in Drive are matched to sheet rows by serial number. For a row with serial number "Reel 71", the script looks for files containing "reel 71" in the filename (case-insensitive, supports spaces, underscores, and hyphens). If no matching file is found, the row is skipped and retried on the next run.

## License

MIT
