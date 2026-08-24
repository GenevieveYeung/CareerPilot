# CareerPilot

CareerPilot 是一个本地优先的个人求职管理工具，用来集中管理岗位、申请时间线、截止日期、简历版本、个人资料和提醒。

CareerPilot 当前仓库只包含程序代码、文档和 synthetic 测试资料。真实简历、申请记录、个人资料、日志和凭据保存在仓库之外。

## 功能范围

- 岗位管理与去重
- 统一的 Application tracking
- OA、Interview、Offer 和 Rejection 时间线
- Deadline 与 Calendar
- Resume Version 管理
- 同一份 Resume Version 的 DOCX + PDF 独立配对
- Profile 与 Work Authorization 资料
- Search Prompt workflow
- Reminder
- Browser-assisted application workflow：表单检查、自动填充、材料上传和人工 Review gate

搜索模板由 CareerPilot 生成 Prompt，再由用户交给 Codex 执行实际搜索；CareerPilot 不会在后台假装自动浏览。申请自动化也不会绕过 Login、CAPTCHA、OTP 或最终 Submit 确认。

## Inspiration / Project History

CareerPilot evolved from earlier personal job-search workflows and experiments, including ApplyPilot and JobHutBot. Those workflow ideas informed parts of the application tracking and browser-assisted application design.

演进关系可以概括为：

```text
ApplyPilot  → earlier workflow / browser-assisted application experiments
JobHutBot   → local job tracking / application management iteration
CareerPilot → current consolidated product
```

CareerPilot 是当前 active product，不代表任何旧项目的官方 fork 或官方关联。

## Quick Start

要求：Windows、Node.js 20 或更新版本。

```text
git clone <repository-url>
cd CareerPilot
setup.bat
Open CareerPilot.bat
```

首次运行时：

1. `setup.bat` 检查 Node.js 并创建本地运行目录。
2. CareerPilot 默认使用 `%LOCALAPPDATA%\CareerPilot` 保存用户资料、运行状态、缓存和日志。
3. 用户可以接受默认 Materials folder，也可以选择现有的求职材料文件夹。
4. 如果检测到旧版本地数据，系统会先询问是否导入；不会自动删除旧数据。
5. 完成设置后，用 `Open CareerPilot.bat` 启动工作台。

## 基本工作流

### 岗位

在“岗位”中查看或手动添加职位。搜索请求会保存条件、来源和结果状态；实际网页搜索、职位验证和去重由用户在 Codex 中执行。

### 申请

一条岗位申请会一直保留在“我的申请”中。已投递、在线测评、面试、Offer 和拒绝是同一条 Application 的阶段或过滤视图，不是不同记录。

### 简历

一份 Resume Version 可以包含两个独立文件槽位：

```text
Editable Word   sample_resume.docx
Submission PDF  sample_resume.pdf
```

支持以下组合：

- 只上传 Word；
- 只上传 PDF；
- 同时上传 Word 和 PDF；
- 之后独立添加或更换 Word；
- 之后独立添加或更换 PDF。

Word 只能进入 DOCX 槽位，PDF 只能进入 PDF 槽位。已提交申请的实际上传文件会作为历史 Snapshot 保存，不会因以后更新 Resume Library 而改变。

### 搜索模板

“搜索模板”保存地区、毕业年份、岗位方向、公司类型、行业、关键词、排除词和来源。用户可以生成、复制和修改 Search Prompt，再交给 Codex 执行。

### 提醒

提醒入口位于“我的 → 提醒设置”。SMTP 授权码只保存在 Windows 安全凭据存储中，不会写入 Git、Excel、普通 JSON、日志或前端响应。README 和示例配置不包含任何真实邮箱或 secret。

### Application Automation

浏览器辅助流程遵循：

```text
Auto Fill → Review → User-confirmed Submit
```

Login、CAPTCHA 和 OTP 需要人工接管；CareerPilot 不绕过网站安全措施，也不会自动点击最终提交。

## First Run 与本地数据

默认用户数据目录：

```text
%LOCALAPPDATA%\CareerPilot
```

求职材料目录可以单独指定，例如：

```text
D:\CareerMaterials
```

材料目录不要求位于 repository 内。迁移时 CareerPilot 保留文件哈希、Resume Version 关联和历史提交 Snapshot；移动文件前应先完成备份和验证。

## Privacy / Security

不要把以下内容提交到 public GitHub：

- 真实 Resume、DOCX、PDF、Cover Letter 或 Submitted Snapshot；
- Profile、联系方式、签证/工作许可资料和 Application history；
- 本地 Master Data、CSV tracker、数据库、日志或截图；
- SMTP authorization code、密码、Token、Cookie、Session 或 OTP；
- 包含真实本地路径、账号名或个人文件名的配置和文档。

`.gitignore` 只是第一层防护。公开仓库前仍必须检查 tracked files、staged diff、binary files 和完整 Git history。旧历史若曾包含私人数据，必须先清理历史或使用新的干净仓库。

## Project Structure

```text
CareerPilot/
├── app/                    # 预留的应用分层入口
├── config/                 # 默认配置与示例配置
├── core/                   # 状态、路径、资料、提醒和服务逻辑
├── dashboard/              # 本地 Web UI 与 API server
├── docs/                   # 架构、首次运行、安全和迁移文档
├── scripts/                # setup、migration、maintenance 脚本
├── tests/                  # 测试代码与 synthetic fixtures
├── Open CareerPilot.bat    # 动态定位仓库并启动服务
├── setup.bat               # 首次运行初始化
├── AGENTS.md               # 当前项目协作规则
├── SKILL.md                # 求职工作流与安全边界
└── README.md               # 用户入口文档
```

私人数据、运行时状态、缓存、日志、材料和外部 archive 不属于 active repository architecture。

## 开发说明

修改项目之前请先阅读：

1. `README.md`：用户功能和运行方式；
2. `AGENTS.md`：项目级操作规则；
3. `SKILL.md`：求职数据、安全和自动化边界。

运行基础回归：

```text
npm run test:regression
```

核心 JSON runtime 不依赖 Excel package；Excel 是本地镜像/下载能力。若要启用 Excel 镜像，需要在目标环境提供对应的可选 artifact dependency。

## License

MIT License，详见 `LICENSE`。
