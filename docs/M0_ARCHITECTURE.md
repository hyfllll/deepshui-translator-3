# M0 架构基线

## 目标

M0 为 3.0 建立可复现、可隔离和可验证的基础。后续阶段只能在本文件锁定的安全边界和数据契约上扩展。

## 公开发布边界

公开仓库只包含 3.0 的源码、文档、测试和构建配置。依赖目录、构建产物、测试 profile、PDF、SQLite 数据库、迁移备份、本地配置与凭证均由 `.gitignore` 排除，不属于发布内容。

## 运行隔离

- appId：`com.deepshui.translator3`
- productName：`DeepShui Translator 3`
- userData：`%APPDATA%\deepshui-translator-3`
- sessionData：`%TEMP%\deepshui-translator-3-session`
- Session partition：`persist:deepshui-translator-3`
- 缓存、日志和 crash dump 均位于 3.0 独立目录

启动时会断言这些路径，任何意外指向 2.0 的路径都会阻止启动。

## 页面与 PDF 安全边界

渲染页面和 PDF 都使用 `app://local`，不再使用 `file://`、`appdoc://` 或通配 CORS。

- 静态资源只允许从 `renderer/` 读取，并阻止目录穿越。
- CSP 禁止外部脚本、对象、表单和跨页面嵌入。
- PDF URL 为 `app://local/document/<random-token>`。
- 主进程只保存 token 的 SHA-256，不保存明文 token。
- token 绑定 WebContents、Session partition、document、generation、允许方法和有效期。
- 仅允许 GET/HEAD；切换文档、导航、renderer 崩溃或窗口关闭时撤销。
- Range 和 HEAD 响应由主进程处理，支持 PDF.js 按需读取。

## 启动兼容策略

个人桌面版固定使用 `sandbox: false` 与 Chromium `no-sandbox` 启动，以避免当前 Windows 主机上沙盒/GPU 子进程启动失败阻断阅读。其余边界保持：`contextIsolation: true`、`nodeIntegration: false`、导航/弹窗/权限全拒绝和 IPC 白名单。

## 数据库和回退

当前 schema 为 2。每次从既有 schema 升级前会执行 WAL checkpoint，并在 `userData/backups/` 保存带应用版本、schema 版本和 SHA-256 的备份，保留最近 3 份。

高于程序最大支持版本的数据库拒绝启动，不执行隐式降级。恢复操作必须先保存当前数据库，再原子替换经哈希验证的版本化备份。

## 版本边界

3.0 按全新个人资料库运行，不提供 2.0 数据迁移：

- 不扫描或打开 2.0 的数据库和用户目录。
- 不读取、复制或转换 2.0 的文档记录、阅读进度与凭证。
- PDF 仅由用户通过引用、复制或拖放明确加入 3.0。
- 3.0 的安装、使用和删除都不修改 2.0。

## M0 验证结果

- 自动化测试：M0 基线 11 项通过。
- npm audit：0 个已知漏洞。
- 源基线：54 个文件哈希通过。
- 实际 PDF 冒烟：2 页 PDF 成功生成画布和文本层。
- 默认兼容模式启动：通过。
