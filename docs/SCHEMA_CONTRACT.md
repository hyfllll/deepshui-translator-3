# Schema 4 契约

## 主数据

- `documents` 与 `document_locations`：文档身份由内容 SHA-256 决定。
- `reading_progress`：服务端 generation 与 revision；写入必须携带当前 generation 和 baseRevision。
- `annotations`：PDF 用户坐标有序 quads、页面旋转/CropBox、文本上下文、提取器指纹、锚定状态、CAS revision 和 tombstone。
- `bookmarks`：使用 `WHERE deleted_at IS NULL` 的 partial unique index 保证每页仅一个活跃书签。
- `notes` / `note_annotations`：复合外键确保笔记与批注属于同一文档。

## 派生数据与搜索

- `document_pages`：绑定 source content hash、extractor version 和 normalization version。
- `index_outbox`：主数据事务与索引更新之间的可靠交接。
- `index_generations`：新索引构建完成后再切换唯一 active generation。
- `document_search_unicode` 与 `document_search_trigram`：M3 基准测试后确定查询合并策略。

## 后台任务

`jobs` 包含唯一 idempotency key、输入版本、优先级、租约、心跳、重试次数、取消标志、checkpoint 和错误码。页面产物与 checkpoint 必须在同一事务提交。

## 本地阅读与智能排版

- `reader_preferences`：每篇文献保存原文/排版视图、缩放方式、翻译侧栏宽度及收起状态、专注模式。更新必须携带当前阅读 session generation。
- `reflow_documents`：记录与当前 PDF 内容 SHA-256 绑定的本地排版版本、提取器版本、阅读块数量和状态。
- `reflow_blocks`：保存块类型、原文页码范围、可选归一化矩形、纯文本内容、置信度和本地提取元数据；Schema 4 增加 `figure`、`table`、`formula-image` 以及受限 PNG/JPEG/WebP 二进制、像素尺寸。单资源最多 5 MB，单篇文档最多 80 MB；同一文献的一个排版 revision 是原子替换的。
- 写入排版结果时会再次比较内容 SHA-256 与 generation；取消、失效或内容不匹配的任务不会发布部分结果。

## 保留表

Schema 4 中的 `import_runs` 和 `import_items` 为早期契约保留表。当前产品不提供 2.0 数据迁移，也没有服务、IPC 或界面会读写这些表；保留它们只是为了避免破坏已创建的数据库。
