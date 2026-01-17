import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	TFile,
	TFolder,
	requestUrl,
	normalizePath,
} from "obsidian";

interface OSSUploaderSettings {
	accessKeyId: string;
	accessKeySecret: string;
	bucket: string;
	endpoint: string;
	prefix: string;
	attachmentFolder: string;
	keepLocalFile: boolean;
	autoSyncEnabled: boolean;
	autoSyncInterval: number; // minutes, 0 = disabled
	fileTypes: string; // comma-separated extensions
}

const DEFAULT_SETTINGS: OSSUploaderSettings = {
	accessKeyId: "",
	accessKeySecret: "",
	bucket: "",
	endpoint: "oss-cn-guangzhou.aliyuncs.com",
	prefix: "notes_assets",
	attachmentFolder: "assets",
	keepLocalFile: false,
	autoSyncEnabled: false,
	autoSyncInterval: 1,
	fileTypes: "png,jpg,jpeg,gif,webp,svg,pdf,docx,xlsx,pptx",
};

// Image link patterns
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const WIKI_IMAGE_RE = /!\[\[([^\]]+)\]\]/g;

export default class OSSUploaderPlugin extends Plugin {
	settings: OSSUploaderSettings;
	autoSyncIntervalId: number | null = null;
	statusNotice: Notice | null = null;

	async onload() {
		await this.loadSettings();

		// Add ribbon icon
		this.addRibbonIcon("upload-cloud", "Upload attachments to OSS", async () => {
			await this.uploadAllAttachments();
		});

		// Add command
		this.addCommand({
			id: "upload-attachments",
			name: "Upload all attachments to OSS",
			callback: async () => {
				await this.uploadAllAttachments();
			},
		});

		this.addCommand({
			id: "upload-current-file-attachments",
			name: "Upload current file attachments to OSS",
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					await this.uploadFileAttachments(activeFile);
				} else {
					new Notice("No active file");
				}
			},
		});

		// Add settings tab
		this.addSettingTab(new OSSUploaderSettingTab(this.app, this));

		// Start auto-sync if enabled
		this.setupAutoSync();
	}

	onunload() {
		this.clearAutoSync();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.setupAutoSync();
	}

	setupAutoSync() {
		this.clearAutoSync();
		if (this.settings.autoSyncEnabled && this.settings.autoSyncInterval > 0) {
			const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
			this.autoSyncIntervalId = window.setInterval(async () => {
				await this.uploadAllAttachments(true); // silent mode
			}, intervalMs);
			this.registerInterval(this.autoSyncIntervalId);
		}
	}

	clearAutoSync() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	updateStatus(message: string) {
		if (this.statusNotice) {
			this.statusNotice.hide();
		}
		this.statusNotice = new Notice(message, 0); // 0 = don't auto-hide
	}

	hideStatus() {
		if (this.statusNotice) {
			this.statusNotice.hide();
			this.statusNotice = null;
		}
	}

	/**
	 * Upload all attachments in the configured folder
	 */
	async uploadAllAttachments(silent = false) {
		if (!this.validateSettings()) {
			if (!silent) new Notice("Please configure OSS settings first");
			return;
		}

		const attachmentFolder = this.app.vault.getAbstractFileByPath(
			this.settings.attachmentFolder
		);
		if (!attachmentFolder || !(attachmentFolder instanceof TFolder)) {
			if (!silent) new Notice(`Attachment folder "${this.settings.attachmentFolder}" not found`);
			return;
		}

		const allowedExts = this.settings.fileTypes
			.split(",")
			.map((e) => e.trim().toLowerCase());

		const archiveFolder = `${this.settings.attachmentFolder}/archive`;

		const allFiles = this.app.vault.getFiles().filter((f) =>
			f.path.startsWith(this.settings.attachmentFolder + "/") &&
			!f.path.startsWith(archiveFolder + "/")
		);

		const files = allFiles.filter((f) => {
			const ext = f.extension.toLowerCase();
			return allowedExts.includes(ext);
		});

		// Separate referenced and unreferenced files
		const referencedFiles: TFile[] = [];
		const unreferencedFiles: TFile[] = [];

		for (const f of files) {
			if (this.isFileReferenced(f)) {
				referencedFiles.push(f);
			} else {
				unreferencedFiles.push(f);
			}
		}

		// Move unreferenced files to archive folder
		if (unreferencedFiles.length > 0) {
			await this.moveToArchive(unreferencedFiles, archiveFolder);
			if (!silent) {
				new Notice(`Moved ${unreferencedFiles.length} unreferenced files to archive`);
			}
		}

		if (referencedFiles.length === 0) {
			if (!silent) new Notice("No referenced attachments to upload");
			return;
		}

		let uploaded = 0;
		let failed = 0;
		let replaced = 0;
		const total = referencedFiles.length;

		for (let i = 0; i < referencedFiles.length; i++) {
			const file = referencedFiles[i];
			if (!silent) {
				this.updateStatus(`Uploading (${i + 1}/${total}): ${file.name}`);
			}

			try {
				const ossUrl = await this.uploadFile(file);
				if (ossUrl) {
					const count = await this.replaceLinksInVault(file, ossUrl);
					replaced += count;
					uploaded++;

					// Only delete local file if links were actually replaced
					if (!this.settings.keepLocalFile && count > 0) {
						await this.app.vault.delete(file);
					}
				} else {
					failed++;
				}
			} catch (e) {
				console.error(`[OSS Uploader] Failed to upload ${file.path}:`, e);
				failed++;
			}
		}

		this.hideStatus();
		if (!silent) {
			const msg = `Uploaded ${uploaded}/${total}` +
				(failed > 0 ? `, failed ${failed}` : "") +
				`, replaced ${replaced} links`;
			new Notice(msg);
			console.log(`[OSS Uploader] ${msg}`);
		}
	}

	/**
	 * Upload attachments referenced in a specific file
	 */
	async uploadFileAttachments(noteFile: TFile) {
		if (!this.validateSettings()) {
			new Notice("Please configure OSS settings first");
			return;
		}

		const content = await this.app.vault.read(noteFile);
		const localLinks = this.extractLocalLinks(content);

		if (localLinks.length === 0) {
			new Notice("No local attachments found in this file");
			return;
		}

		let uploaded = 0;
		let failed = 0;
		let newContent = content;
		const total = localLinks.length;

		const filesToDelete: TFile[] = [];

		for (let i = 0; i < localLinks.length; i++) {
			const link = localLinks[i];
			this.updateStatus(`Uploading (${i + 1}/${total}): ${link.path}`);

			const file = this.app.vault.getAbstractFileByPath(link.path);
			if (file && file instanceof TFile) {
				try {
					const ossUrl = await this.uploadFile(file);
					if (ossUrl) {
						// Replace the entire original link syntax with new OSS URL
						// Handle both encoded and non-encoded paths
						const originalEncoded = link.original;
						const originalDecoded = decodeURIComponent(link.original);
						const beforeReplace = newContent;

						// Try to replace both versions
						if (newContent.includes(originalEncoded)) {
							newContent = newContent.split(originalEncoded).join(
								originalEncoded.replace(/\([^)]+\)/, `(${ossUrl})`)
							);
						}
						if (originalEncoded !== originalDecoded && newContent.includes(originalDecoded)) {
							newContent = newContent.split(originalDecoded).join(
								originalDecoded.replace(/\([^)]+\)/, `(${ossUrl})`)
							);
						}

						// Only mark for deletion if replacement actually happened
						const replaced = newContent !== beforeReplace;
						if (replaced) {
							uploaded++;
							if (!this.settings.keepLocalFile) {
								filesToDelete.push(file);
							}
						} else {
							console.error(`[OSS Uploader] Link replacement failed: ${file.path}`);
							failed++;
						}
					} else {
						failed++;
					}
				} catch (e) {
					console.error(`Failed to upload ${file.path}:`, e);
					failed++;
				}
			} else {
				console.warn(`File not found: ${link.path}`);
				failed++;
			}
		}

		// Only save and delete after all replacements are confirmed
		if (newContent !== content) {
			await this.app.vault.modify(noteFile, newContent);

			// Now safe to delete local files
			for (const file of filesToDelete) {
				await this.app.vault.delete(file);
			}
		}

		this.hideStatus();
		const msg = `Uploaded ${uploaded}/${total}` + (failed > 0 ? `, failed ${failed}` : "");
		new Notice(msg);
		console.log(`[OSS Uploader] ${msg}`);
	}

	/**
	 * Extract local attachment links from content
	 */
	extractLocalLinks(content: string): Array<{ original: string; path: string }> {
		const links: Array<{ original: string; path: string }> = [];

		// Markdown image syntax: ![alt](path)
		let match;
		const mdRe = new RegExp(MD_IMAGE_RE.source, "g");
		while ((match = mdRe.exec(content)) !== null) {
			const path = match[2];
			if (!path.startsWith("http://") && !path.startsWith("https://")) {
				const normalizedPath = normalizePath(decodeURIComponent(path));
				links.push({ original: match[0], path: normalizedPath });
			}
		}

		// Wiki image syntax: ![[path]]
		const wikiRe = new RegExp(WIKI_IMAGE_RE.source, "g");
		while ((match = wikiRe.exec(content)) !== null) {
			const path = match[1].split("|")[0]; // Remove alias
			const normalizedPath = normalizePath(path);
			links.push({ original: match[0], path: normalizedPath });
		}

		return links;
	}

	/**
	 * Replace local links with OSS URL in all notes
	 */
	async replaceLinksInVault(file: TFile, ossUrl: string): Promise<number> {
		const mdFiles = this.app.vault.getMarkdownFiles();
		let count = 0;

		for (const mdFile of mdFiles) {
			const content = await this.app.vault.read(mdFile);

			// Build patterns to match this file
			const fileName = file.name;
			const filePath = file.path;
			const encodedFileName = encodeURIComponent(fileName);
			const encodedPath = encodeURIComponent(filePath).replace(/%2F/g, "/");

			// Patterns to replace (both encoded and non-encoded versions)
			const patterns = [
				// Direct paths
				filePath,
				fileName,
				encodedPath,
				encodedFileName,
				// With ../ prefix
				`../${filePath}`,
				`../${encodedPath}`,
				// With assets/ variations
				`../assets/${fileName}`,
				`../assets/${encodedFileName}`,
				`assets/${fileName}`,
				`assets/${encodedFileName}`,
				// Just the filename for wiki links
				fileName.replace(/\.[^.]+$/, ""), // without extension
			];

			let newContent = content;
			for (const pattern of patterns) {
				if (!pattern) continue;

				// Markdown: ![...](pattern)
				const mdPattern = new RegExp(
					`(!\\[[^\\]]*\\]\\()${escapeRegExp(pattern)}(\\))`,
					"g"
				);
				newContent = newContent.replace(mdPattern, `$1${ossUrl}$2`);

				// Wiki: ![[pattern]] or ![[pattern|alias]]
				const wikiPattern = new RegExp(
					`(!\\[\\[)${escapeRegExp(pattern)}(\\|[^\\]]*)?\\]\\]`,
					"g"
				);
				newContent = newContent.replace(wikiPattern, `$1${ossUrl}$2]]`);
			}

			if (newContent !== content) {
				await this.app.vault.modify(mdFile, newContent);
				count++;
			}
		}

		return count;
	}

	/**
	 * Upload a single file to OSS
	 */
	async uploadFile(file: TFile): Promise<string | null> {
		const data = await this.app.vault.readBinary(file);
		const ext = file.extension.toLowerCase();

		// Generate filename: {ext}-{timestamp}.{ext}
		// Using timestamp avoids special character issues in original filename
		const timestamp = this.formatTimestamp(new Date());
		const objectKey = `${this.settings.prefix}/${ext}-${timestamp}.${ext}`;

		// URL encode the object key for the request URL (but not for signature)
		const encodedObjectKey = objectKey
			.split("/")
			.map((part) => encodeURIComponent(part))
			.join("/");

		const contentType = this.getContentType(ext);
		const dateStr = new Date().toUTCString();

		// Build signature (reference: roam_image_fix.py upload_image function)
		// Note: Content-MD5 is optional, we skip it to avoid crypto issues
		// Signature uses non-encoded objectKey
		const canonicalResource = `/${this.settings.bucket}/${objectKey}`;
		const stringToSign = [
			"PUT",
			"", // Content-MD5 (empty)
			contentType,
			dateStr,
			canonicalResource,
		].join("\n");

		const signature = await this.hmacSha1Base64(
			this.settings.accessKeySecret,
			stringToSign
		);

		const host = `${this.settings.bucket}.${this.settings.endpoint}`;
		// Use encoded object key in URL
		const url = `https://${host}/${encodedObjectKey}`;

		const headers = {
			"Content-Type": contentType,
			"Date": dateStr,
			"Authorization": `OSS ${this.settings.accessKeyId}:${signature}`,
		};

		try {
			const response = await requestUrl({
				url,
				method: "PUT",
				body: data,
				headers,
				throw: false,
			});

			if (response.status === 200) {
				return url;
			} else {
				console.error(`[OSS Uploader] Upload failed for ${file.name}`);
				console.error(`[OSS Uploader] Status: ${response.status}`);
				console.error(`[OSS Uploader] Response: ${response.text}`);
				console.error(`[OSS Uploader] Request URL: ${url}`);
				console.error(`[OSS Uploader] Request Headers:`, JSON.stringify(headers, null, 2));
				console.error(`[OSS Uploader] StringToSign:`, JSON.stringify(stringToSign));
				console.error(`[OSS Uploader] Signature: ${signature}`);
				new Notice(`Upload failed: ${response.status} - ${file.name}`);
				return null;
			}
		} catch (e) {
			console.error(`[OSS Uploader] Upload error for ${file.name}`);
			console.error(`[OSS Uploader] Error:`, e);
			console.error(`[OSS Uploader] Request URL: ${url}`);
			console.error(`[OSS Uploader] Request Headers:`, JSON.stringify(headers, null, 2));
			console.error(`[OSS Uploader] StringToSign:`, JSON.stringify(stringToSign));
			new Notice(`Upload error: ${file.name}`);
			return null;
		}
	}

	validateSettings(): boolean {
		return !!(
			this.settings.accessKeyId &&
			this.settings.accessKeySecret &&
			this.settings.bucket &&
			this.settings.endpoint &&
			this.settings.prefix
		);
	}

	/**
	 * Move unreferenced files to archive folder
	 */
	async moveToArchive(files: TFile[], archiveFolder: string): Promise<void> {
		// Ensure archive folder exists
		const folderExists = this.app.vault.getAbstractFileByPath(archiveFolder);
		if (!folderExists) {
			await this.app.vault.createFolder(archiveFolder);
		}

		for (const file of files) {
			const newPath = `${archiveFolder}/${file.name}`;
			try {
				await this.app.vault.rename(file, newPath);
			} catch (e) {
				console.error(`[OSS Uploader] Failed to move ${file.path} to archive:`, e);
			}
		}
	}

	/**
	 * Check if a file is referenced in any markdown note
	 */
	isFileReferenced(file: TFile): boolean {
		const mdFiles = this.app.vault.getMarkdownFiles();
		const fileName = file.name;
		const fileNameNoExt = fileName.replace(/\.[^.]+$/, "");
		const encodedFileName = encodeURIComponent(fileName);

		// Exact patterns to match
		const exactPatterns = [
			fileName,
			fileNameNoExt,
			encodedFileName,
		];

		for (const mdFile of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(mdFile);
			if (cache) {
				// Check embeds (images, etc.)
				if (cache.embeds) {
					for (const embed of cache.embeds) {
						const link = embed.link;
						// Check if link ends with filename or matches exactly
						if (exactPatterns.some(p =>
							link === p ||
							link.endsWith(p) ||
							link.endsWith(`/${p}`) ||
							decodeURIComponent(link) === p ||
							decodeURIComponent(link).endsWith(p)
						)) {
							return true;
						}
					}
				}
				// Check links
				if (cache.links) {
					for (const linkItem of cache.links) {
						const link = linkItem.link;
						if (exactPatterns.some(p =>
							link === p ||
							link.endsWith(p) ||
							link.endsWith(`/${p}`) ||
							decodeURIComponent(link) === p ||
							decodeURIComponent(link).endsWith(p)
						)) {
							return true;
						}
					}
				}
			}
		}

		return false;
	}

	formatTimestamp(date: Date): string {
		const pad = (n: number) => n.toString().padStart(2, "0");
		return (
			date.getFullYear().toString() +
			pad(date.getMonth() + 1) +
			pad(date.getDate()) +
			"-" +
			pad(date.getHours()) +
			pad(date.getMinutes()) +
			pad(date.getSeconds())
		);
	}

	getContentType(ext: string): string {
		const types: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			svg: "image/svg+xml",
			pdf: "application/pdf",
			docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		};
		return types[ext] || "application/octet-stream";
	}

	async hmacSha1Base64(key: string, message: string): Promise<string> {
		const encoder = new TextEncoder();
		const keyData = encoder.encode(key);
		const messageData = encoder.encode(message);

		const cryptoKey = await crypto.subtle.importKey(
			"raw",
			keyData,
			{ name: "HMAC", hash: "SHA-1" },
			false,
			["sign"]
		);

		const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
		return btoa(String.fromCharCode(...new Uint8Array(signature)));
	}
}

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class OSSUploaderSettingTab extends PluginSettingTab {
	plugin: OSSUploaderPlugin;

	constructor(app: App, plugin: OSSUploaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "OSS Uploader Settings" });

		// OSS Configuration
		containerEl.createEl("h3", { text: "OSS Configuration" });

		new Setting(containerEl)
			.setName("Access Key ID")
			.setDesc("Aliyun OSS Access Key ID")
			.addText((text) =>
				text
					.setPlaceholder("Enter Access Key ID")
					.setValue(this.plugin.settings.accessKeyId)
					.onChange(async (value) => {
						this.plugin.settings.accessKeyId = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Access Key Secret")
			.setDesc("Aliyun OSS Access Key Secret")
			.addText((text) => {
				text
					.setPlaceholder("Enter Access Key Secret")
					.setValue(this.plugin.settings.accessKeySecret)
					.onChange(async (value) => {
						this.plugin.settings.accessKeySecret = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Bucket")
			.setDesc("OSS Bucket name")
			.addText((text) =>
				text
					.setPlaceholder("e.g., my-bucket")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Endpoint")
			.setDesc("OSS Endpoint (without bucket name)")
			.addText((text) =>
				text
					.setPlaceholder("e.g., oss-cn-guangzhou.aliyuncs.com")
					.setValue(this.plugin.settings.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.endpoint = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Prefix")
			.setDesc("Object key prefix/folder in OSS")
			.addText((text) =>
				text
					.setPlaceholder("e.g., notes_assets")
					.setValue(this.plugin.settings.prefix)
					.onChange(async (value) => {
						this.plugin.settings.prefix = value;
						await this.plugin.saveSettings();
					})
			);

		// Upload Settings
		containerEl.createEl("h3", { text: "Upload Settings" });

		new Setting(containerEl)
			.setName("Attachment Folder")
			.setDesc("Local folder containing attachments to upload")
			.addText((text) =>
				text
					.setPlaceholder("e.g., assets")
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("File Types")
			.setDesc("Comma-separated list of file extensions to upload")
			.addText((text) =>
				text
					.setPlaceholder("png,jpg,jpeg,gif,pdf")
					.setValue(this.plugin.settings.fileTypes)
					.onChange(async (value) => {
						this.plugin.settings.fileTypes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Keep Local Files")
			.setDesc("Keep local files after uploading to OSS")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.keepLocalFile)
					.onChange(async (value) => {
						this.plugin.settings.keepLocalFile = value;
						await this.plugin.saveSettings();
					})
			);

		// Auto Sync Settings
		containerEl.createEl("h3", { text: "Auto Sync" });

		new Setting(containerEl)
			.setName("Enable Auto Sync")
			.setDesc("Automatically upload new attachments periodically")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync Interval (minutes)")
			.setDesc("How often to check for new attachments (0 to disable)")
			.addText((text) =>
				text
					.setPlaceholder("1")
					.setValue(this.plugin.settings.autoSyncInterval.toString())
					.onChange(async (value) => {
						const num = parseInt(value) || 0;
						this.plugin.settings.autoSyncInterval = Math.max(0, num);
						await this.plugin.saveSettings();
					})
			);

		// Manual Actions
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Upload All Attachments")
			.setDesc("Manually trigger upload of all attachments in the configured folder")
			.addButton((button) =>
				button.setButtonText("Upload Now").onClick(async () => {
					await this.plugin.uploadAllAttachments();
				})
			);
	}
}
