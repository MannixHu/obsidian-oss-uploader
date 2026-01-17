# OSS Uploader for Obsidian

**English | [中文](./README.md)**

An Obsidian plugin that uploads local attachments to Aliyun OSS and automatically replaces links in your notes.

## Features

- **Batch Upload** - Upload all attachments in a configured folder with one click
- **Auto Link Replacement** - Automatically replaces local links with OSS URLs in all notes
- **Smart File Detection** - Only uploads files that are actually referenced in notes
- **Archive Unreferenced** - Moves unreferenced files to an archive folder instead of uploading
- **Auto Sync** - Optionally auto-upload new attachments at configurable intervals
- **Progress Display** - Shows real-time upload progress
- **Multiple File Types** - Supports images (PNG, JPG, GIF, WebP, SVG) and documents (PDF, DOCX, XLSX, PPTX)
- **Safe Deletion** - Only deletes local files after confirming successful link replacement

## Installation

### Manual Installation

1. Download `main.js` and `manifest.json` from the releases
2. Create a folder `oss-uploader` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into the folder
4. Enable the plugin in Obsidian settings

### Build from Source

```bash
# Clone the repository
git clone https://github.com/MannixHu/obsidian-oss-uploader.git

# Install dependencies
npm install

# Build
npm run build

# Copy to your vault
cp main.js manifest.json /path/to/vault/.obsidian/plugins/oss-uploader/
```

## Configuration

### OSS Settings

| Setting | Description |
|---------|-------------|
| Access Key ID | Your Aliyun OSS Access Key ID |
| Access Key Secret | Your Aliyun OSS Access Key Secret |
| Bucket | OSS Bucket name |
| Endpoint | OSS Endpoint (e.g., `oss-cn-guangzhou.aliyuncs.com`) |
| Prefix | Object key prefix/folder in OSS |

### Upload Settings

| Setting | Description |
|---------|-------------|
| Attachment Folder | Local folder containing attachments (e.g., `assets`) |
| File Types | Comma-separated extensions (e.g., `png,jpg,pdf`) |
| Keep Local Files | Keep local files after upload |

### Auto Sync

| Setting | Description |
|---------|-------------|
| Enable Auto Sync | Automatically upload new attachments |
| Sync Interval | Check interval in minutes |

## Usage

### Upload All Attachments

- Click the cloud upload icon in the ribbon, or
- Use command palette: `Upload all attachments to OSS`

### Upload Current File Attachments

- Use command palette: `Upload current file attachments to OSS`

## How It Works

### Upload Process

```
1. Scan attachment folder
   │
2. Check file references
   ├─ Referenced files → Upload queue
   └─ Unreferenced files → Archive folder
   │
3. For each file in upload queue:
   ├─ Generate unique OSS key (ext-timestamp.ext)
   ├─ Upload to Aliyun OSS
   ├─ Replace links in all markdown files
   └─ Delete local file (if configured)
```

### Link Replacement

The plugin handles multiple link formats:

| Before | After |
|--------|-------|
| `![](assets/image.png)` | `![](https://bucket.oss.aliyuncs.com/prefix/png-20260117.png)` |
| `![[image.png]]` | `![[https://bucket.oss.aliyuncs.com/prefix/png-20260117.png]]` |
| `![alt](../assets/image%20name.png)` | `![alt](https://bucket.oss.aliyuncs.com/prefix/png-20260117.png)` |

### Security

- Uses HMAC-SHA1 signature for OSS authentication
- Access keys are stored locally in Obsidian plugin data
- No third-party servers involved

## Archive Folder

Unreferenced files are automatically moved to `{attachmentFolder}/archive/` instead of being uploaded. This helps you:

- Identify orphaned attachments
- Clean up unused files safely
- Avoid uploading unnecessary files

## Troubleshooting

### Upload Failed

1. Check your OSS credentials in settings
2. Verify bucket name and endpoint are correct
3. Check console (Ctrl+Shift+I) for detailed error logs

### Links Not Replaced

- Ensure the file is actually referenced in a note
- Check if file path contains special characters
- View console logs for replacement details

## License

MIT License

## Author

Mannix
