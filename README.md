# DeepShui Translator 3

独立于 2.0 的个人版本地学术 PDF 翻译与阅读工作台。不包含账户、登录、云同步或跨端能力。

## 当前进度

M0、M1、M2a（舒适原文阅读 / 本地智能排版）、M2b（可选 AI 结构增强）与 M2c-1（公式/图片保真块）已经完成：

- 独立身份：`com.deepshui.translator3` / `DeepShui Translator 3`
- 独立数据：`%APPDATA%\deepshui-translator-3`
- 独立 Session：`persist:deepshui-translator-3`
- UI 与 PDF 统一通过 `app://local` 同源加载
- PDF 令牌绑定 WebContents、Session 和服务端 generation
- 个人桌面版默认采用兼容模式启动，避免 Chromium 沙盒启动失败阻断阅读
- SQLite schema 4 已锁定批注、书签、笔记、全文索引、后台任务、阅读偏好和带视觉资源的本地排版缓存结构
- 当前页书签已接入阅读器，批注接口采用 generation + revision 并发保护
- 后台任务支持幂等入队、租约、心跳、checkpoint、取消和失败重试
- 原文模式支持适合宽度、适合整页、实际大小、手动缩放、可收起/调宽翻译侧栏和专注阅读
- 智能排版默认完全本地执行：PDF 文本按版面整理为可读块，保留页码来源并可一键跳回原文
- 排版结果绑定 PDF 内容 SHA-256；原文件内容变更后不会复用旧缓存
- AI 优化仅由用户主动点击触发：只发送本地提取的文字与页码结构，不上传 PDF、页面图片或文件路径；模型只能建议布局类型，不能改写正文
- 智能排版会把明确的陈列公式和嵌入图片保存为本地保真块；公式不再依赖纯文本猜测，图片资源不会发送给 AI
- 灰色/深色主题已统一按钮、输入框、提示框和排版页的高对比度颜色
- 3.0 作为全新资料库使用，不提供 2.0 数据迁移

详细设计：

- [M0 架构基线](docs/M0_ARCHITECTURE.md)
- [M1 基础能力](docs/M1_FOUNDATION.md)
- [M2a 本地阅读与智能排版](docs/M2A_READER_REFLOW.md)
- [M2b 可选 AI 结构增强](docs/M2B_AI_STRUCTURE.md)
- [M2c 保真智能排版](docs/M2C_FIDELITY_REFLOW.md)
- [Schema 4 契约](docs/SCHEMA_CONTRACT.md)

## 开发与验证

```powershell
npm install
npm test
npm audit --omit=dev
npm start
npm run dist:win:dir
```

Windows 解包输出：

`dist\win-unpacked\DeepShui Translator 3.exe`

## 启动兼容说明

个人桌面版默认以 Chromium 兼容模式启动，不再显示沙盒失败确认框。程序仍保持 `contextIsolation: true`、`nodeIntegration: false`、受限 IPC、权限默认拒绝、禁止新窗口和导航拦截；不包含账户、云同步或外部自动上传。

## 数据边界

- 3.0 与 2.0 的用户目录、Session 和数据库完全独立。
- 3.0 不扫描、不读取也不迁移 2.0 数据或凭证。
- 个人文献通过“引用原文件”“复制到文献库”或拖入 PDF 添加。
- 3.0 可以独立删除，不影响 2.0。

## 后续阶段

- M3：可视化高亮、批注编辑、书签导航与全文搜索
- M4：笔记、导出和两套界面细化
- M5：OCR 性能/准确率门禁
- M6：失败注入、性能验证和正式 Windows 安装包

## License

MIT
