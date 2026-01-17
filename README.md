# OSS Uploader for Obsidian

**[English](./README_EN.md) | 中文**

一个 Obsidian 插件，将本地附件上传到阿里云 OSS 并自动替换笔记中的链接。

## 功能特点

- **批量上传** - 一键上传配置文件夹中的所有附件
- **自动替换链接** - 自动将所有笔记中的本地链接替换为 OSS URL
- **智能文件检测** - 仅上传被笔记实际引用的文件
- **归档未引用文件** - 将未引用的文件移动到归档文件夹而非上传
- **自动同步** - 可选按配置间隔自动上传新附件
- **进度显示** - 实时显示上传进度
- **多文件类型** - 支持图片（PNG、JPG、GIF、WebP、SVG）和文档（PDF、DOCX、XLSX、PPTX）
- **安全删除** - 仅在确认链接替换成功后才删除本地文件

## 安装

### 手动安装

1. 从 releases 下载 `main.js` 和 `manifest.json`
2. 在你的 vault 的 `.obsidian/plugins/` 目录下创建 `oss-uploader` 文件夹
3. 将下载的文件复制到该文件夹
4. 在 Obsidian 设置中启用插件

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/MannixHu/obsidian-oss-uploader.git

# 安装依赖
npm install

# 构建
npm run build

# 复制到你的 vault
cp main.js manifest.json /path/to/vault/.obsidian/plugins/oss-uploader/
```

## 配置

### OSS 设置

| 设置项 | 说明 |
|--------|------|
| Access Key ID | 阿里云 OSS Access Key ID |
| Access Key Secret | 阿里云 OSS Access Key Secret |
| Bucket | OSS Bucket 名称 |
| Endpoint | OSS 端点（如 `oss-cn-guangzhou.aliyuncs.com`） |
| Prefix | OSS 中的对象键前缀/文件夹 |

### 上传设置

| 设置项 | 说明 |
|--------|------|
| 附件文件夹 | 包含附件的本地文件夹（如 `assets`） |
| 文件类型 | 逗号分隔的扩展名（如 `png,jpg,pdf`） |
| 保留本地文件 | 上传后是否保留本地文件 |

### 自动同步

| 设置项 | 说明 |
|--------|------|
| 启用自动同步 | 自动上传新附件 |
| 同步间隔 | 检查间隔（分钟） |

## 使用方法

### 上传所有附件

- 点击侧边栏的云上传图标，或
- 使用命令面板：`Upload all attachments to OSS`

### 上传当前文件附件

- 使用命令面板：`Upload current file attachments to OSS`

## 工作原理

### 上传流程

```
1. 扫描附件文件夹
   │
2. 检查文件引用
   ├─ 被引用的文件 → 上传队列
   └─ 未引用的文件 → 归档文件夹
   │
3. 对上传队列中的每个文件：
   ├─ 生成唯一 OSS 键名 (ext-timestamp.ext)
   ├─ 上传到阿里云 OSS
   ├─ 替换所有 markdown 文件中的链接
   └─ 删除本地文件（如已配置）
```

### 链接替换

插件处理多种链接格式：

| 替换前 | 替换后 |
|--------|-------|
| `![](assets/image.png)` | `![](https://bucket.oss.aliyuncs.com/prefix/png-20260117.png)` |
| `![[image.png]]` | `![[https://bucket.oss.aliyuncs.com/prefix/png-20260117.png]]` |
| `![alt](../assets/image%20name.png)` | `![alt](https://bucket.oss.aliyuncs.com/prefix/png-20260117.png)` |

### 安全性

- 使用 HMAC-SHA1 签名进行 OSS 认证
- Access Key 本地存储在 Obsidian 插件数据中
- 不涉及第三方服务器

## 归档文件夹

未被引用的文件会自动移动到 `{attachmentFolder}/archive/` 而非上传。这可以帮助你：

- 识别孤立的附件
- 安全清理未使用的文件
- 避免上传不必要的文件

## 故障排除

### 上传失败

1. 检查设置中的 OSS 凭证
2. 验证 bucket 名称和 endpoint 是否正确
3. 查看控制台（Ctrl+Shift+I）获取详细错误日志

### 链接未替换

- 确保文件实际被笔记引用
- 检查文件路径是否包含特殊字符
- 查看控制台日志了解替换详情

## 许可证

MIT License

## 作者

Mannix
