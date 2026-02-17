// ============================================================
// CONTENT REVIEW AUTOMATION
// Google Apps Script — paste this into your Feedback Sheet
// ============================================================
//
// This script:
// 1. Detects new rows added to any tab (Reel, Post, Carousel)
// 2. Creates a Notion page for each new item to review
// 3. Syncs your Notion feedback back to the Google Sheet
// ============================================================

// ──────────────────────────────────────────────────────
// CONFIGURATION — Fill these in during setup
// ──────────────────────────────────────────────────────
const CONFIG = {
  NOTION_API_KEY: 'YOUR_NOTION_API_KEY_HERE',       // Notion integration token (starts with ntn_)
  NOTION_DATABASE_ID: 'YOUR_DATABASE_ID_HERE',       // Notion database ID

  // Google Drive folder IDs (from the URL when you open each folder)
  DRIVE_FOLDERS: {
    'Reel Update': 'YOUR_REELS_FOLDER_ID',
    'Post Update': 'YOUR_POSTS_FOLDER_ID',
    'Carousel Update': 'YOUR_CAROUSELS_FOLDER_ID'
  },

  // Tab names in your Google Sheet
  TABS: ['Reel Update', 'Post Update', 'Carousel Update'],

  // Column mappings for each tab (0-indexed)
  COLUMNS: {
    'Reel Update': {
      sno: 0,           // A
      dateAdded: 1,      // B
      feedback: 2,       // C
      igHandles: 3,      // D
      postingStatus: 4,  // E
      datePostedIG: 5,   // F
      datePostedTT: 6,   // G
      status: 7,         // H
      caption1: 8,       // I
      caption2: 9,       // J
      hashtags: 10       // K
    },
    'Post Update': {
      sno: 0,           // A
      dateAdded: 1,      // B
      feedback: 2,       // C
      igHandles: 3,      // D
      postingStatus: 4,  // E
      datePosted: 5,     // F
      notes: 6,          // G
      statusAfter: 7,    // H
      caption1: 8,       // I
      caption2: 9        // J
    },
    'Carousel Update': {
      sno: 0,           // A
      dateAdded: 1,      // B
      feedback: 2,       // C
      igHandles: 3,      // D
      postingStatus: 4,  // E
      datePosted: 5,     // F
      notes: 6,          // G
      statusAfter: 7,    // H
      caption1: 8,       // I
      caption2: 9        // J
    }
  }
};


// ──────────────────────────────────────────────────────
// MAIN FUNCTION: Check for new content & send to Notion
// Runs every 1-5 minutes via a time-based trigger
// ──────────────────────────────────────────────────────
function checkForNewContent() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();

  CONFIG.TABS.forEach(tabName => {
    try {
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) return;

      // Track by SERIAL NUMBER (e.g. "reel 71") — not row number
      // This is robust against row insertions/deletions/reordering
      const sentKey = `sentIds_${tabName}`;
      const sentIdsStr = props.getProperty(sentKey) || '';
      const sentIds = new Set(sentIdsStr ? sentIdsStr.split('|||') : []);

      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return;

      const allData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
      let changed = false;

      for (let i = 0; i < allData.length; i++) {
        const rowData = allData[i];
        const row = i + 2; // Actual sheet row number
        const sno = String(rowData[CONFIG.COLUMNS[tabName].sno] || '').trim().toLowerCase();

        // Skip empty rows
        if (!sno || sno === '') continue;

        // Build a unique ID from tab + serial number (e.g. "Reel Update::reel 71")
        const uniqueId = `${tabName}::${sno}`;

        // Skip if already sent to Notion
        if (sentIds.has(uniqueId)) continue;

        // Check if feedback is already provided (skip permanently)
        const feedback = rowData[CONFIG.COLUMNS[tabName].feedback];
        if (feedback && feedback !== '') {
          sentIds.add(uniqueId);
          changed = true;
          continue;
        }

        // Get media files from Google Drive
        const mediaLinks = getMediaLinks(tabName, rowData[CONFIG.COLUMNS[tabName].sno]);

        // ONLY create Notion page if media was found
        if (mediaLinks.length === 0) {
          Logger.log(`No media found yet for ${sno} in ${tabName} — will retry next run`);
          continue;
        }

        // Double-check: query Notion to see if this item already exists
        if (notionPageExists(tabName, sno)) {
          Logger.log(`Notion page already exists for ${sno} in ${tabName} — marking as sent`);
          sentIds.add(uniqueId);
          changed = true;
          continue;
        }

        const contentData = extractContentData(rowData, tabName);

        // Create Notion page
        const pageId = createNotionPage(contentData, mediaLinks, tabName, row);

        if (pageId) {
          sentIds.add(uniqueId);
          changed = true;
          Logger.log(`Created Notion page for ${sno} in ${tabName}`);
        }
      }

      // Save updated tracking data
      if (changed) {
        props.setProperty(sentKey, Array.from(sentIds).join('|||'));
      }
    } catch (e) {
      Logger.log(`Error processing ${tabName}: ${e.message}`);
    }
  });
}


// ──────────────────────────────────────────────────────
// Check if a Notion page already exists for this item
// ──────────────────────────────────────────────────────
function notionPageExists(tabName, sno) {
  try {
    const url = `https://api.notion.com/v1/databases/${CONFIG.NOTION_DATABASE_ID}/query`;
    const payload = {
      filter: {
        and: [
          { property: 'Name', title: { contains: String(sno) } },
          { property: 'Sheet Tab', rich_text: { equals: tabName } }
        ]
      }
    };
    const options = {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${CONFIG.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());
    return data.results && data.results.length > 0;
  } catch (e) {
    Logger.log(`Error checking Notion for duplicates: ${e.message}`);
    return false; // If check fails, allow creation (better to duplicate than miss)
  }
}


// ──────────────────────────────────────────────────────
// Extract content data from a sheet row
// ──────────────────────────────────────────────────────
function extractContentData(rowData, tabName) {
  const cols = CONFIG.COLUMNS[tabName];

  const data = {
    sno: rowData[cols.sno] || '',
    dateAdded: rowData[cols.dateAdded] || '',
    caption1: rowData[cols.caption1] || '',
    caption2: rowData[cols.caption2] || '',
    contentType: tabName.replace(' Update', '')
  };

  // Add hashtags for Reels
  if (tabName === 'Reel Update' && cols.hashtags !== undefined) {
    data.hashtags = rowData[cols.hashtags] || '';
  }

  return data;
}


// ──────────────────────────────────────────────────────
// Get media files from Google Drive folder
// Makes files publicly viewable so they embed in Notion
// ──────────────────────────────────────────────────────
function getMediaLinks(tabName, sno) {
  const folderId = CONFIG.DRIVE_FOLDERS[tabName];
  if (!folderId || folderId.startsWith('YOUR_')) return [];

  try {
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFiles();
    const links = [];

    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName().toLowerCase();
      const snoLower = sno.toString().toLowerCase();

      // Match files that contain the content name (e.g., "Reel 1", "Post 3")
      if (fileName.includes(snoLower) || fileName.includes(snoLower.replace(' ', '_')) || fileName.includes(snoLower.replace(' ', '-'))) {
        // Make the file viewable by anyone with the link (required for Notion embeds)
        ensureFileIsShared(file);
        links.push(buildMediaInfo(file));
      }
    }

    // If no matching file found, return empty — the script will retry next run
    if (links.length === 0) {
      Logger.log(`No file matching "${sno}" found in ${tabName} folder — will retry next run`);
    }

    return links;
  } catch (e) {
    Logger.log(`Error accessing Drive folder for ${tabName}: ${e.message}`);
    return [];
  }
}


// ──────────────────────────────────────────────────────
// Ensure a Drive file is shared as "anyone with link can view"
// This is required for Notion to display the embedded media
// ──────────────────────────────────────────────────────
function ensureFileIsShared(file) {
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log(`Could not share file ${file.getName()}: ${e.message}`);
  }
}


// ──────────────────────────────────────────────────────
// Build media info object with embeddable URLs
// ──────────────────────────────────────────────────────
function buildMediaInfo(file) {
  const fileId = file.getId();
  const mimeType = file.getMimeType();
  const name = file.getName();

  // Determine media type
  let type = 'file';
  if (mimeType.startsWith('image/')) {
    type = 'image';
  } else if (mimeType.startsWith('video/')) {
    type = 'video';
  }

  // Build embeddable URLs
  // For images: direct download URL works for Notion image blocks
  // For videos: Google Drive preview URL works for Notion embed blocks
  const directUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
  const previewUrl = `https://drive.google.com/file/d/${fileId}/preview`;
  const driveUrl = file.getUrl();

  return {
    name: name,
    fileId: fileId,
    mimeType: mimeType,
    type: type,
    directUrl: directUrl,      // For images (embed directly)
    previewUrl: previewUrl,     // For videos (embed as iframe)
    driveUrl: driveUrl          // Fallback link
  };
}


// ──────────────────────────────────────────────────────
// Create a Notion page for content review
// ──────────────────────────────────────────────────────
function createNotionPage(contentData, mediaLinks, tabName, sheetRow) {
  const url = 'https://api.notion.com/v1/pages';

  // Build the Notion page payload
  const payload = {
    parent: { database_id: CONFIG.NOTION_DATABASE_ID },
    properties: {
      // Title — the content name
      'Name': {
        title: [{ text: { content: `${contentData.sno} — ${contentData.contentType}` } }]
      },
      // Content type (Reel, Post, Carousel)
      'Content Type': {
        select: { name: contentData.contentType }
      },
      // Status — starts as "Needs Review"
      'Review Status': {
        select: { name: 'Needs Review' }
      },
      // Date added
      'Date Added': {
        rich_text: [{ text: { content: contentData.dateAdded ? contentData.dateAdded.toString() : 'Not specified' } }]
      },
      // Sheet row reference (for syncing back)
      'Sheet Tab': {
        rich_text: [{ text: { content: tabName } }]
      },
      'Sheet Row': {
        number: sheetRow
      },
      // Feedback field — you fill this in
      'Feedback': {
        rich_text: [{ text: { content: '' } }]
      },
      // IG Handles — you fill this in
      'IG Handles to Tag': {
        rich_text: [{ text: { content: '' } }]
      },
      // Caption choice — you pick one
      'Caption Choice': {
        select: { name: 'Not chosen yet' }
      }
    },
    // Page body content — built dynamically below
    children: []
  };

  // ── MEDIA SECTION ──
  // Embed images/videos directly so you never leave Notion
  payload.children.push({
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ text: { content: '🎬 Content Preview' } }]
    }
  });

  if (mediaLinks.length > 0) {
    mediaLinks.forEach(media => {
      if (media.type === 'image') {
        // Embed image directly in the page
        payload.children.push({
          object: 'block',
          type: 'image',
          image: {
            type: 'external',
            external: { url: media.directUrl }
          }
        });
        // Add filename caption
        payload.children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: `📸 ${media.name}` } }],
            color: 'gray'
          }
        });
      } else if (media.type === 'video') {
        // Embed video player directly in the page
        payload.children.push({
          object: 'block',
          type: 'video',
          video: {
            type: 'external',
            external: { url: media.driveUrl }
          }
        });
        // Add filename caption
        payload.children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: `🎥 ${media.name}` } }],
            color: 'gray'
          }
        });
        // Also add an embed block as fallback (Google Drive preview player)
        payload.children.push({
          object: 'block',
          type: 'embed',
          embed: { url: media.previewUrl }
        });
      } else {
        // Other file types — embed as a bookmark
        payload.children.push({
          object: 'block',
          type: 'bookmark',
          bookmark: { url: media.driveUrl }
        });
        payload.children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: `📎 ${media.name}` } }],
            color: 'gray'
          }
        });
      }
    });
  } else {
    payload.children.push({
      object: 'block',
      type: 'callout',
      callout: {
        icon: { emoji: '⚠️' },
        rich_text: [{ text: { content: 'No media files were found automatically. The file may have a different naming convention. Check the Google Drive folder directly.' } }]
      }
    });
  }

  // ── DIVIDER ──
  payload.children.push({
    object: 'block',
    type: 'divider',
    divider: {}
  });

  // ── CAPTION OPTIONS ──
  payload.children.push(
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ text: { content: '✍️ Caption Option 1' } }]
      }
    },
    {
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [{ text: { content: contentData.caption1 || '(No caption provided)' } }]
      }
    },
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ text: { content: '✍️ Caption Option 2' } }]
      }
    },
    {
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [{ text: { content: contentData.caption2 || '(No caption provided)' } }]
      }
    }
  );

  // ── HASHTAGS (Reels only) ──
  if (contentData.hashtags) {
    payload.children.push(
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: '#️⃣ Hashtags' } }]
        }
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ text: { content: contentData.hashtags } }]
        }
      }
    );
  }

  // ── INSTRUCTIONS ──
  payload.children.push(
    {
      object: 'block',
      type: 'divider',
      divider: {}
    },
    {
      object: 'block',
      type: 'callout',
      callout: {
        icon: { emoji: '👆' },
        rich_text: [{ text: { content: 'YOUR ACTION ITEMS:\n1. Review the content above\n2. Fill in the "Feedback" property (top of page)\n3. Fill in "IG Handles to Tag"\n4. Set "Caption Choice" to Caption 1 or Caption 2\n5. Change "Review Status" to "Reviewed"\n\nYour feedback will automatically sync back to the Google Sheet!' } }]
      }
    }
  );

  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());

  const statusCode = response.getResponseCode();
  if (statusCode !== 200 && statusCode !== 201) {
    Logger.log(`Notion API error (${statusCode}): ${JSON.stringify(result)}`);
    return null;
  }

  Logger.log(`Created Notion page: ${result.id}`);
  return result.id;
}


// ──────────────────────────────────────────────────────
// SYNC BACK: Pull feedback from Notion → Google Sheets
// Runs every 5-10 minutes via a time-based trigger
// ──────────────────────────────────────────────────────
function syncNotionToSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Query Notion for pages with status "Reviewed"
  const reviewedPages = queryNotionDatabase('Reviewed');

  if (!reviewedPages || reviewedPages.length === 0) {
    Logger.log('No reviewed items to sync.');
    return;
  }

  reviewedPages.forEach(page => {
    try {
      const props = page.properties;

      const tabName = getNotionText(props['Sheet Tab']);
      const sheetRow = props['Sheet Row']?.number;
      const feedback = getNotionText(props['Feedback']);
      const igHandles = getNotionText(props['IG Handles to Tag']);
      const captionChoice = props['Caption Choice']?.select?.name || '';

      if (!tabName || !sheetRow || sheetRow < 2) {
        Logger.log(`Skipping page ${page.id} — missing or invalid tab/row reference`);
        return;
      }

      const sheet = ss.getSheetByName(tabName);
      if (!sheet) {
        Logger.log(`Tab "${tabName}" not found`);
        return;
      }

      const cols = CONFIG.COLUMNS[tabName];

      // Write feedback to column C
      if (feedback) {
        sheet.getRange(sheetRow, cols.feedback + 1).setValue(feedback);
      }

      // Write IG handles to column D
      if (igHandles) {
        sheet.getRange(sheetRow, cols.igHandles + 1).setValue(igHandles);
      }

      // Highlight the chosen caption cell in bright green
      const BRIGHT_GREEN = '#00FF00';
      if (captionChoice === 'Caption 1' && cols.caption1 !== undefined) {
        sheet.getRange(sheetRow, cols.caption1 + 1).setBackground(BRIGHT_GREEN);
      } else if (captionChoice === 'Caption 2' && cols.caption2 !== undefined) {
        sheet.getRange(sheetRow, cols.caption2 + 1).setBackground(BRIGHT_GREEN);
      }

      // Mark the "Status after Feedback" column as "Updated"
      if (cols.statusAfter !== undefined) {
        sheet.getRange(sheetRow, cols.statusAfter + 1).setValue('Updated');
      } else if (cols.status !== undefined) {
        sheet.getRange(sheetRow, cols.status + 1).setValue('Updated');
      }

      // Update Notion page status to "Synced" so it doesn't get processed again
      updateNotionPageStatus(page.id, 'Synced');

      Logger.log(`Synced feedback for row ${sheetRow} in ${tabName}`);
    } catch (e) {
      Logger.log(`Error syncing page ${page.id}: ${e.message}`);
    }
  });
}


// ──────────────────────────────────────────────────────
// Query Notion database for pages with a given status
// ──────────────────────────────────────────────────────
function queryNotionDatabase(status) {
  const url = `https://api.notion.com/v1/databases/${CONFIG.NOTION_DATABASE_ID}/query`;

  const payload = {
    filter: {
      property: 'Review Status',
      select: { equals: status }
    }
  };

  const options = {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());

  if (response.getResponseCode() !== 200) {
    Logger.log(`Notion query error: ${JSON.stringify(result)}`);
    return [];
  }

  return result.results || [];
}


// ──────────────────────────────────────────────────────
// Update a Notion page's Review Status
// ──────────────────────────────────────────────────────
function updateNotionPageStatus(pageId, newStatus) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  const payload = {
    properties: {
      'Review Status': {
        select: { name: newStatus }
      }
    }
  };

  const options = {
    method: 'patch',
    headers: {
      'Authorization': `Bearer ${CONFIG.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();
  if (statusCode !== 200) {
    Logger.log(`Failed to update Notion page ${pageId} to "${newStatus}" (HTTP ${statusCode})`);
  }
}


// ──────────────────────────────────────────────────────
// Helper: Extract text from Notion rich_text property
// ──────────────────────────────────────────────────────
function getNotionText(prop) {
  if (!prop) return '';
  if (prop.rich_text) {
    return prop.rich_text.map(t => t.plain_text).join('');
  }
  if (prop.title) {
    return prop.title.map(t => t.plain_text).join('');
  }
  return '';
}


// ──────────────────────────────────────────────────────
// SETUP: Create time-based triggers
// Run this ONCE after pasting the script
// ──────────────────────────────────────────────────────
function setupTriggers() {
  // Validate config before creating triggers
  if (CONFIG.NOTION_API_KEY.startsWith('YOUR_') || CONFIG.NOTION_DATABASE_ID.startsWith('YOUR_')) {
    Logger.log('ERROR: Please fill in your Notion API key and Database ID in the CONFIG section before running setup.');
    throw new Error('Configuration incomplete — update CONFIG at the top of the script first.');
  }

  // Remove any existing triggers first
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  // Check for new content every 1 minute
  ScriptApp.newTrigger('checkForNewContent')
    .timeBased()
    .everyMinutes(1)
    .create();

  // Sync reviewed content back to Sheets every 5 minutes
  ScriptApp.newTrigger('syncNotionToSheets')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('Triggers created successfully!');
  Logger.log('- checkForNewContent: every 1 minute');
  Logger.log('- syncNotionToSheets: every 5 minutes');
}


// ──────────────────────────────────────────────────────
// RESET: Clear tracking data (use if you want to
// reprocess all existing rows)
// ──────────────────────────────────────────────────────
function resetTracking() {
  const props = PropertiesService.getScriptProperties();
  CONFIG.TABS.forEach(tabName => {
    props.deleteProperty(`lastProcessed_${tabName}`);
    props.deleteProperty(`sentToNotion_${tabName}`);
  });
  Logger.log('Tracking data cleared. Next run will recheck all rows.');
}


// ──────────────────────────────────────────────────────
// TEST: Run a manual check (useful for debugging)
// ──────────────────────────────────────────────────────
function testCheckNewContent() {
  Logger.log('Starting manual check for new content...');
  checkForNewContent();
  Logger.log('Done. Check the Logs for details.');
}

function testSyncBack() {
  Logger.log('Starting manual sync from Notion...');
  syncNotionToSheets();
  Logger.log('Done. Check the Logs for details.');
}
