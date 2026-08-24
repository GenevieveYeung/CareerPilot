# CareerPilot Repository Audit

审计日期：2026-08-24
审计范围：本地工作区及 Git 根目录 `careerpilot_workspace`
审计边界：本报告生成前未移动、删除或覆盖任何文件。

## 结论摘要

- 当前 Git 根目录是 `careerpilot_workspace`；外层文件夹不是 Git repository。
- 当前目录同时包含 active source、用户私人资料、运行时数据、测试截图、迁移备份和历史数据；不适合直接作为公开 GitHub repository。
- 当前活跃服务仍有仓库内默认路径：`application_materials`、`data/private`、`logs`。
- 当前材料库约有 80 个 DOCX、61 个 PDF；运行态中有 20 条申请、48 条岗位、97 个 Resume Version、36 个事件。
- 当前已存在安全的 QQ SMTP DPAPI 目录：`%LOCALAPPDATA%\CareerPilot\secrets`；但仍保留仓库内 legacy secret fallback，需要迁移后移除运行时依赖。
- 发现的旧绝对路径主要存在于历史 CSV、迁移/审计产物和部分 active routing/application evidence；它们必须区分“历史记录”与“运行时路径”，不能盲目全局替换。

## A. ACTIVE SOURCE CODE

以下内容属于程序运行所需的当前源码，保留在 repository：

- `core/`：runtime state、Master API、profile、reminder、SMTP、runtime mirror。
- `dashboard/`：server、HTML、前端视图、导航、i18n、状态、材料/简历/申请视图。
- `dashboard/start-dashboard.*`、`dashboard/wait-dashboard.ps1`：当前启动辅助脚本。
- `scripts/`：当前 reminder worker 辅助脚本；需迁移到明确的 setup/maintenance 目录。

当前 source 仍直接从源码位置推导用户数据路径，后续统一改为 ProjectPaths。

## B. ACTIVE CONFIGURATION

- `dashboard/status_rules.json`
- `.gitignore`
- 运行时由代码读取的环境变量：`CAREERPILOT_PORT`、`CAREERPILOT_MASTER_PATH`、`CAREERPILOT_RUNTIME_STATE_PATH`、`CAREERPILOT_SNAPSHOT_CACHE_PATH`、`CAREERPILOT_SECRET_DIR` 等。
- `dashboard/*.csv` 中一部分是旧导出/同步快照，不应继续作为第二套可编辑数据库；需明确为 sample、migration input 或 local-only。

需要新增：

- `config/defaults.json`
- `config/example.settings.json`
- 用户本地配置：`%LOCALAPPDATA%\CareerPilot\config\settings.json`

## C. USER PRIVATE DATA

禁止进入公开 GitHub：

- `application_materials/`：真实 DOCX/PDF、求职信、公司材料；当前物理目录约 13 MB。
- `_control/`：candidate profile、answer bank、experience bank、resume routing、search state 等个人资料和求职规则。
- `data/private/`：CareerPilot runtime state、Master workbook、snapshot cache、private runtime artifacts。
- `dashboard/application_log.csv`、`application_queue.csv`、`job_pool.csv` 等包含个人申请历史、材料路径或个人求职事实的当前数据。
- 申请快照、简历快照、个人资料、签证/工作许可信息、联系方式及任何 SMTP 认证信息。

处理原则：保留当前用户文件的物理位置，先登记为可配置的 Materials Root；新 clone 默认使用用户数据目录，不把私人数据复制进 repository。

## D. GENERATED RUNTIME DATA

应移出 source tree，或全部由 `.gitignore` 忽略：

- `data/private/runtime/`
- `data/private/.runtime/`
- `logs/`、`debug.log`、`dashboard/debug.log`
- `audit/`、`dashboard/audit/`、截图和 Playwright 产物
- `exports/`
- `application_previews/`
- `*.inspect.ndjson`、临时 Excel 文件和运行缓存

## E. TEST / QA

当前测试和审计脚本主要位于：

- `dashboard/*e2e*`、`dashboard/*regression*`、`dashboard/*audit*`
- `audit/` 下的 resume、导航、语言、Excel 构建和回归脚本
- 根目录 `.playwright-cli/`

后续保留可复用测试源码，但测试输出、截图、真实用户 fixture 必须移到 local runtime 或改成 synthetic data。

## F. DOCUMENTATION

- 当前 active docs：`README.md`、`AGENTS.md`、`SKILL.md`、`CAREERPILOT_REBRANDING_MIGRATION_CHECKLIST.md`。
- 外层工作区 `AGENTS.md` 是本机规则，不应作为公开 CareerPilot 产品文档直接打包。
- `career_context.md` 含个人工作上下文，不应进入公开 GitHub；开发所需的通用规则应迁移到 `docs/` 或 `AGENTS.md`，个人内容保留本地。
- `_archive/references/` 和 `_archive/templates/` 主要是旧 ApplyPilot 迁移参考，需区分非敏感公开参考与含个人数据的本地归档。

## G. LEGACY / ARCHIVE

- `_archive/`：ApplyPilot 只读迁移材料、旧模板、旧审计。
- `archive/`：多轮 checkpoint、旧代码、runtime workbook 和迁移备份；其中部分包含真实个人数据，不能提交 GitHub。
- `trash/`：当前内容及用途需要逐项确认，不能在未核对前删除。
- `_archive_applypilot/`（仓库外）：本地 legacy workspace，不进入公开 repository。

历史记录可保留旧产品名，但应标注 `Legacy`；不能让 active runtime 读取这些目录。

## H. TEMPORARY / SAFE TO REMOVE AFTER VERIFICATION

候选项，但本轮审计时未删除：

- 重复的 `*.inspect.ndjson` 临时检查输出。
- 已确认不再需要的 `debug.log`、旧性能日志和重复截图。
- `tmp/` 中完成且已验证的临时文件。

删除前必须确认不属于用户材料、申请快照、可恢复备份或当前服务依赖；优先移动到本地回收/归档目录，不做不可恢复删除。

## I. UNCERTAIN — REVIEW REQUIRED

- `dashboard/*.csv` 的当前来源、编辑权和是否属于产品数据库仍需逐个标记。
- `archive/` 内的 workbook、resume backup 和 migration artifacts 是否需要保留在本机，需要建立 manifest。
- `career_context.md`、外层 `AGENTS.md`、`使用说明.md` 是否要作为私人本地文档保留，不能未经确认公开。
- `application_previews/` 中的资料路径和职位内容需要改为 local-only 或 synthetic fixtures。
- `data/private` 与 `dashboard` CSV 之间仍存在同步镜像；必须在路径迁移同时确认唯一数据源，避免生成第二套数据库。

## 运行时硬编码路径审计

已确认的 active code 风险：

1. `dashboard/server.js` 默认把材料根目录设为 `../application_materials`。
2. `dashboard/server.js` 默认把 runtime workbook/state/cache 设为 `../data/private/...`。
3. `dashboard/server.js` 把 API/performance logs 写入 `../logs`。
4. `core/master_api.mjs`、`core/runtime_state.mjs`、`core/sync_runtime_mirror.mjs` 仍从源码目录推导 `data/private` 和 `application_materials`。
5. 部分 active CSV 和 routing 记录仍保存旧机器绝对路径；它们必须通过 migration map 或配置解析，不可对历史事实做无证据改写。

## 迁移前保护清单

在任何用户数据移动前必须完成：

- runtime state / workbook / snapshot cache 完整备份；
- application、event、reminder、profile、search template、resume library 计数和 hash 清单；
- 所有 DOCX/PDF 物理文件清单；
- `old path -> new path` migration map；
- 只在验证新路径可读后更新引用；
- 失败时保留旧路径和回滚副本。

本报告只记录发现，不代表迁移已完成。

## 迁移后验证补充（2026-08-24）

审计后的实际处理：

- 新增 `core/project_paths.cjs` 作为统一路径解析器。
- runtime state、Excel mirror、cache、logs、legacy CSV 均迁移到 `%LOCALAPPDATA%\CareerPilot`；运行态不再默认从 repository 的 `data/private` 或 `logs` 读取。
- 142 个用户材料文件已逐文件 SHA-256 校验后迁移到用户配置的外部 Materials Root；原目录保留在外部 archive 作为恢复备份。
- 97 个 Resume Version 的 active 文件路径全部可读；旧材料根路径在本机运行态中为 0 次，新的 Materials Root 已写入本地设置。
- 原始申请、事件、简历版本计数保持：48 jobs、20 applications、97 material versions、36 application events。
- 已跟踪的真实 `dashboard/application_log.csv` 和 `dashboard/job_pool.csv` 已从当前 Git index 移除；用户副本保存在本机 CareerPilot legacy data。
- 公开仓库新增 `setup.bat`、`Open CareerPilot.bat`、`config/`、`docs/`、`tests/fixtures/`；启动器只从自身位置定位仓库，不依赖机器固定路径。
- 当前完整浏览器回归：health、首页、岗位、申请、日历、我的、搜索模板、申请详情均通过；Console errors、request failures、bad responses 均为空。

仍需注意：历史 archive 和旧 migration 文档可以包含旧名称或旧路径，但它们位于仓库外，不属于 active runtime。公开 Git 历史若曾经提交过私人资料，发布前仍需另行审查历史提交；本轮未改写 Git 历史。
