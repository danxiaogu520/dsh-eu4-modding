# DSH EU4 Modding

将 [ParadoxCode](https://github.com/danxiaogu520/ParadoxCode) 的语言分析能力接入 DeepSeek Harness，支持 agent 查询已有定义、查规则和作用域、验证草稿、评估改动影响，再用 DSH 文件工具完成修改。

插件直接连接外部 `paradoxcode` stdio LSP，不依赖 ParadoxCodeMCP 或 VS Code。解析器、EU4 规则与分析引擎仍由 ParadoxCode 提供。

## 快速开始

要求 Node.js 22.19+、提供 `tools` 和 `systemPrompt` 服务的 DSH profile。插件默认自动下载 ParadoxCode 语言服务器，无需先安装 Rust 或 VS Code。已用 DSH SDK **0.2.0-rc.2** 和官方 ParadoxCode **0.5.2** 验证。

在已有可用 DSH `web` profile 的环境中，从 [GitHub Releases](https://github.com/danxiaogu520/dsh-eu4-modding/releases/latest) 下载对应版本的 `dsh-eu4-modding-<version>.tgz`，无需解压，然后安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-eu4-modding-<version>.tgz
```

进入要编辑的 Mod 目录并启动 DSH，然后直接告诉 agent 你的需求：

```bash
cd /path/to/your-mod
dsh web
```

例如：“检查这个 Mod 的事件和本地化错误”，或“给这个 Mod 新增一个加声望的决议，先验证草稿”。安装后自动挂载工具和工作流提示，**无需填写 YAML、服务器路径、Mod 路径或原版索引路径**。已有终端 profile 时可将 `web` 换为 `tui`。

默认会自动下载语言服务器、识别当前 Mod，并让 ParadoxCode 查找本机 EU4 安装、复用或构建原版索引。首次下载和首次原版索引可能需要几分钟，完成后复用缓存。没有安装游戏也可以查内置规则、分析 Mod 和验证草稿；缺少原版数据的限制会保留在分析结果中。

从 Mod 的子目录启动会找到最近的 Mod 根目录；从只有一个 Mod 的父目录启动会选择该 Mod。父目录中有多个 Mod 时，agent 需要根据你的需求选择一个。你也可以直接告诉 agent Mod 的路径，由它在工具参数中指定，无需修改插件配置。

已有 ParadoxCode VS Code 项目时，插件会直接读取工作区的 `.vscode/settings.json`：依赖、游戏位置、原版索引和分析设置可以继续用同一份配置。文件支持 JSONC 注释和尾随逗号，无需运行 VS Code。

插件当前通过 GitHub Release 分发。安装包已编译，普通 npm 依赖由 DSH 安装流程处理；ParadoxCode 在首次调用工具时下载。首次安装和首次下载服务端需要联网。

后续发布到 npm 后，也可以按包名安装：

```bash
dsh plugin --profile web add dsh-eu4-modding
```

## 可选配置与服务器缓存

默认设置已经可以直接使用。[配置示例](examples/cordis.patch.yml) 仅在固定工作区、固定服务器版本或指定特殊游戏位置时使用，将其追加到 `$DSH_HOME/profiles/web/cordis.patch.yml` 即可。本包声明了 `dsh.bundle.patch`，安装后自动挂载插件；也可作为普通 Cordis 插件通过 `ctx.plugin` 加载。

默认 `serverPath: auto`、`serverVersion: latest`：首次调用工具时查询 [ParadoxCode 最新稳定 Release](https://github.com/danxiaogu520/ParadoxCode/releases/latest)，按系统和架构下载服务器及 `.sha256` 文件，验证 SHA-256 后解压缓存。支持 Linux glibc x64/arm64、macOS x64/arm64、Windows x64；其他平台可配置本地服务器。npm 安装和插件挂载时不下载。

每次重新加载插件时检查最新稳定版，运行中的会话保持同一版本。已缓存的版本不会重复下载；GitHub API 限流或暂时不可用时，`latest` 优先使用已校验缓存；缺少 latest 指针也会检查同平台的兼容版本。真正冷启动时尝试 GitHub 网页的 Release 重定向，再回退到随插件声明的已测试版本 0.5.2，`paradoxcode_workspace` 的 `server.warning` 会说明原因。回退会明确显示实际版本及“最新状态未确认”。首次使用仍需联网。设置 `GH_TOKEN` 或 `GITHUB_TOKEN` 可认证 API 请求；认证头不会转发到资源下载域名。固定 `serverVersion: '0.5.2'` 可避免随上游更新；缓存存在时完全不联网。缓存中的可执行文件在使用前会重新核对 SHA-256，下载、校验或解压失败不会执行未验证的文件。

默认缓存目录为 Linux `$XDG_CACHE_HOME/dsh-eu4-modding/paradoxcode`（未设置时 `~/.cache/...`）、macOS `~/Library/Caches/dsh-eu4-modding/paradoxcode`、Windows `%LOCALAPPDATA%/dsh-eu4-modding/paradoxcode`。可用 `serverCacheDirectory` 指定其他可写目录。网络受限时可延长 `downloadTimeoutMs`，或手动下载并配置本地路径。

已有服务器时，设置 `serverPath: /absolute/path/to/paradoxcode`；若已加入 PATH，设置 `serverPath: paradoxcode`。这两种方式均跳过自动下载，`serverVersion` 不控制本地程序版本。发布二进制可从 [ParadoxCode Releases](https://github.com/danxiaogu520/ParadoxCode/releases) 获取；从源码构建：

```bash
cargo build --locked --release -p pdc --bin paradoxcode
```

使用本地程序时，`serverPath` 应指向 `paradoxcode` 本体，程序启动时没有子命令。不要填 `paradoxcode-mcp` 或 VS Code 扩展路径。

## 配置

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `serverPath` | `auto` | 自动下载；也可指定本地程序路径或 PATH 名称，带目录的相对路径按插件启动时的 cwd 解析 |
| `serverVersion` | `latest` | 最新稳定版或固定版本，如 `0.5.2`；仅自动下载模式生效 |
| `serverCacheDirectory` | 空 | 空时使用系统用户缓存目录；可指定其他可写目录 |
| `downloadTimeoutMs` | `300000` | 查询 Release、下载和安装的总期限，1000–600000 ms；独立于 LSP 请求期限 |
| `workspace` | 空 | 空时从 DSH 会话目录识别 Mod 根目录；工具也可通过 `workspace` 单独选择 Mod |
| `vanillaMode` | 共享设置，缺省 `auto` | 自动发现本机游戏并复用/构建原版索引；`cacheOnly` 仅用已有索引，`disabled` 跳过原版数据 |
| `gameDirectory` | 共享设置，缺省空 | 本地 EU4 安装目录 |
| `vanillaIndexCache` | 共享设置，缺省空 | 本地原版索引路径 |
| `dependencies` | 共享设置，缺省 `[]` | 覆盖共享依赖列表；`{id, path, index?}` 按低到高优先级排列，显式 `[]` 清空依赖 |
| `preferredLocalisationLanguages` | 共享设置，缺省 `[english]` | 本地化语言优先级 |
| `timeoutMs` | `300000` | 单次 LSP 请求与初始化索引等待期限，1000–600000 ms |
| `maxWorkspaces` | `3` | 最多 1–16 个语言服务器进程，超限回收最近最少使用的空闲会话 |
| `maxOutputChars` | `24000` | 原生工具的紧凑文本预算；超限时显示摘要与 `paradoxcode_result` 读取入口，PTC 保留完整 JSON |
| `autoRefresh` | `true` | 监听 Mod 变更，并按工具实际变更路径标记相关工作区；已知文件通过 LSP 文件变更通知刷新 |

共享依赖、游戏与索引的相对路径以 `.vscode` 所属工作区目录为基准，和 VS Code 相同；DSH 显式依赖路径以选定 Mod 根目录为基准。DSH 0.2.0 使用会话创建时的 `cwd`；存在新版 `workingDirectory` 服务时使用实时会话目录。自动识别依据 ParadoxCode 工作区设置、`descriptor.mod` 或常见 Mod 文件布局，仅检查祖先和直接子目录。显式配置或工具参数中的 `workspace` 始终优先。新建空目录保持为工作区，便于从零创建 Mod。

服务器按需启动，工具注册不要求已有游戏数据。首次调用等待 `pdc/ready`，之后复用已索引会话。查询前会刷新脏索引；已知文件通过 LSP 文件通知更新，目录或未知变更才全量刷新。工具执行前后比较已声明路径的时间戳，读文件不会因工具名称而触发刷新；监听不可用时，仅对调用所在工作区保守刷新。监听失败会在工作区结果中提供原因，此时用 `paradoxcode_refresh` 同步外部改动。自动监听覆盖项目 Mod；依赖 Mod 的外部修改应主动刷新。

## 与 VS Code 共享依赖和配置

工作区 `.vscode/settings.json` 可以沿用 ParadoxCode 的原生格式：

```jsonc
{
  // Dependencies: lower priority first, higher priority last.
  "paradoxcode.dependencies": [
    { "id": "base", "path": "../base-mod" },
    { "id": "expansion", "path": "../expansion-mod", "index": "../indexes/expansion.pdcindex" }
  ],
  "paradoxcode.vanilla.mode": "auto",
  "paradoxcode.localisation.preferredLanguages": ["english"]
}
```

优先级为 **DSH 显式配置 > VS Code 工作区设置 > 插件默认值**。显式空依赖列表会覆盖共享列表。复用的设置还包括 `modDirectory`、`gameDirectory`、`vanillaIndexCache`、扫描排除、诊断配置和性能配置；`paradoxcode.modDirectory` 可选择工作区中的 Mod 子目录。服务器下载和进程启动参数由 DSH 插件配置控制。

每次工具调用都会重新读取共享分析设置；相关值改变后，关闭旧服务器并按新配置重新索引。编辑器字体等无关设置不会触发服务器重启。解析失败会报告文件和行号，避免继续使用过时配置。`paradoxcode_workspace.configuration` 显示配置文件、依赖来源和实际加载列表。

新增 `paradoxcode_dependencies` 工具，可直接向 agent 说“查看依赖链”“添加这个依赖 Mod”“把依赖链同步给 VS Code”：

| action | 行为 |
| --- | --- |
| `inspect` | 显示显式依赖、递归依赖链、加载顺序、问题和当前文件的 `baseHash`，不启动语言服务器 |
| `add` | 追加 `dependencies` 到共享列表，默认在已有依赖之后，优先级更高 |
| `remove` | 按 `id` 删除显式依赖；若它仍被其它 Mod 引用，依赖链预览中仍会出现 |
| `set` | 用 `dependencies` 替换共享列表，`[]` 清空 |
| `sync` | 展开并去重依赖链，把完整顺序写回共享列表，使 DSH 和 VS Code 加载相同依赖 |

所有保存操作需要最近一次 `inspect` 返回的 `baseHash`。只编辑 `paradoxcode.dependencies`，保留其它设置、注释、BOM 和换行格式；依赖数组内的注释会移到数组开头，内容保留。文件已被其它工具修改时拒绝覆盖。修改后的共享设置会在下一次分析调用时生效，VS Code 由扩展的设置变化监听重新加载。

依赖链来自各依赖 Mod 自己的 `.vscode/settings.json`，相对路径按各自目录解释。会检查循环、重复身份、目录重叠和优先级矛盾；多个链路引用同一个 Mod 时去重，前置依赖先加载。存在离线缓存依赖时，保留其索引配置和链覆盖限制；无法读取完整链时不执行 `sync`。

**普通分析只加载共享文件中的显式列表**，与 ParadoxCode 0.5.2 的 VS Code 扩展保持一致。需要补齐间接依赖时先 `inspect`，再按用户要求 `sync`，不在查询时悄悄改写配置。若 DSH 已显式覆盖 `dependencies`，共享配置仍可查看，但保存操作会提示先移除覆盖。

当前共享范围是工作区 `.vscode/settings.json`；不读取 VS Code 用户全局设置或 `.code-workspace` 文件。路径请使用字面绝对路径或工作区相对路径，和 ParadoxCode VS Code 的原生设置一样，不展开 `${workspaceFolder}` 等变量。

## 工具

所有工具均接受可选的 `workspace`，返回 `{workspace, result}` 结构，可由 DSH 原生工具调用或 PTC 使用。

| 工具 | 能力 |
| --- | --- |
| `paradoxcode_result` | 按 token 与字符偏移完整读取超预算结果；不重新分析，字符偏移为 UTF-16 |
| `paradoxcode_query` | 0.5.2+ 的规则、定义、本地化、全文及定义引用分页，保留 revision/snapshot 和覆盖限制 |
| `paradoxcode_workspace` | 根目录、规则身份、索引修订、文件数量、扫描覆盖、同步状态及服务器来源/版本/缓存回退信息 |
| `paradoxcode_dependencies` | 共享 VS Code 配置的依赖链检查、添加/删除/替换及展开同步 |
| `paradoxcode_rules` | 按 context/key/scope 查询有效键、值形状和作用域 |
| `paradoxcode_search` | 搜索事件、任务、决议、国家标签、scripted effects/triggers 等定义 |
| `paradoxcode_symbol_references` | 按精确名称查定义与使用位置，评估修改影响 |
| `paradoxcode_localisation` | 精确键、键前缀/子串或显示文本查询，返回生效版本和语言 |
| `paradoxcode_diagnostics` | 磁盘文件诊断；支持文件、脚本/本地化、严重性、诊断码和行范围筛选，以及文件内诊断分页 |
| `paradoxcode_validate_text` | 1–16 个草稿联合验证；逐文件计数，无文件写入，每文件 4 MiB、合计 16 MiB |
| `paradoxcode_document` | hover/completion/definition/references/symbols，支持临时草稿 |
| `paradoxcode_rename_preview` | 冲突感知重命名预览、LSP WorkspaceEdit、文件哈希与可写性 |
| `paradoxcode_format_preview` | 保守格式化预览、TextEdits、格式化文本与原内容哈希 |
| `paradoxcode_mission_preview` | 任务树布局、前置关系与布局问题的语义数据 |
| `paradoxcode_transcode_preview` | 中文本地化/脚本编码与解码预览，保留拒绝和损坏信息 |
| `paradoxcode_refresh` | 显式重建工作区索引，等待提交后返回扫描结果 |

## Agentic modding 流程

插件会注册一段工作流提示，引导 agent：

1. 用 `paradoxcode_workspace` 确认 Mod、依赖、原版索引和覆盖范围。
2. 查现有定义、键值规则与作用域；修改定义前查引用。
3. 把相关草稿一起交给 `paradoxcode_validate_text` 联合校验，根据 `UnknownKey`、`InvalidValue`、`WrongScope`、`UnknownLocalisationKey` 等代码修复。
4. 用 DSH 文件工具落盘；刷新索引并诊断改动文件。重命名先检查预览中的可写性和 SHA-256，应用时再次核对文件内容，再刷新验证。
5. 先指定改动 `files`。检查整个 Mod 时，文件页使用 `nextOffset`；每一文件页先用 `snapshot` + `nextDiagnosticOffset` 读完诊断明细，再换下一文件页。`counts` 是该文件页/草稿批次的未筛选总数，`filteredCounts` 是筛选后总数，`pageCounts` 是当前明细页数。逐文件也有同样计数；`diagnostics: []` 配合 `diagnosticsComplete: false` 表示明细未全部展示。
6. 超预算原生输出会给出 `retrieval.token`，调用 `paradoxcode_result`，按其 `nextOffset` 拼接 `chunk`，完成后解析 JSON。token 仅属于当前工作区，会在变更、刷新、回收或重启后失效。
7. 查询分页与诊断分页分别处理。原有规则、本地化、符号搜索和按名称查引用工具，在服务端声明 `pdcQueryPagination` 时接受 `offset` + `revision`；0.5.2 可用 `paradoxcode_query`，沿服务器返回的 `nextOffset`、`revision`、`snapshot` 继续。保留组内 `matchCount` 和 `limitations`，不能把受限组视为完整引用清单。光标 completion/references 使用插件返回的 `snapshot` 与 `nextOffset`。

工具参数示例：

```json
{"workspace":"/mods/my-mod","context":"effect","key":"add_prestige","scope":"country"}
```

上例用于 `paradoxcode_rules`。验证草稿：

```json
{"files":[{"path":"common/scripted_effects/my_effects.txt","text":"my_effect = { add_prestige = 5 }\n"}]}
```

查询草稿补全：

```json
{"action":"completion","path":"common/scripted_effects/new.txt","text":"new_effect = { add_ }","line":1,"character":19}
```

输入光标使用 **1 起始行号、0 起始 UTF-16 列号**；原始 LSP range 保持 **0 起始**。诊断另外提供 1 起始 `line` 供阅读。格式化和重命名的编辑 range 也保留 LSP 坐标。

## 能力边界

- **ParadoxCode 0.5.2 兼容性。** 既有 `pdc/*` 查询继续可用，插件直接连接 stdio LSP，不受 MCP 拆分影响。转码统一处理完整文件，包括注释、标识符和字符串，已删除仅处理引号内容的参数。转码服务端须声明 `pdcWholeFileTranscode` 能力；旧版服务端会收到明确的升级提示。合法的已有转义序列会保留，损坏序列或无法编码的字符拒绝整次转换。`latest` 会跟随未来稳定版，固定版本适合需要复现结果的工作区。
- **草稿联合分析。** 插件先打开整个草稿批次，再在共同覆盖层上执行 `pdc/textDiagnostics`。本批其它文件的新定义参与引用解析。成功、错误或取消后都会关闭所有临时文档，并等待原工作区恢复；恢复失败则回收该服务器。关联文件落盘后仍需磁盘诊断。
- **分析预览不落盘。** 不写 Mod 脚本、不应用 WorkspaceEdit，也拒绝服务器要求客户端执行编辑的请求。依赖管理工具的显式保存操作仅写共享 `.vscode/settings.json`；Mod 源文件修改继续由 DSH 的既有工具完成。
- **保持原始分析信息。** 分页、匹配歧义、扫描问题、LSP 错误码与冲突信息均保留。原生显示超限会输出有效 JSON 摘要，优先保留计数、续页信息和逐文件摘要；完整 JSON 可由 PTC 或 `paradoxcode_result` 读取。摘要自身超预算时会明确报告省略的文件摘要数量。后端自身的结果数量与本地化预览上限仍适用。
- **编码不做有损猜测。** 文档光标查询要求 UTF-8；非 UTF-8 文件可做磁盘诊断或使用编码预览检查。转换返回十六进制 `bytes`，不要直接将十六进制字符串当正文写入。先检查 `eligible`、`refused`、`broken`、`damagedAt` 等后端信息。
- **语义数据优先。** 任务树工具提供关系与布局数据，不集成 VS Code 的纹理界面。分析结果不替代游戏内测试。
- **工作区隔离。** 文档操作限制在索引根目录，草稿覆盖限制在当前 Mod；多 agent 调用串行处理，临时文档在请求结束后关闭。取消或查询超时先发送协作取消，并在有界宽限期内等待响应；服务端响应后保留服务器。初始化失败、传输损坏或取消未响应时回收当前工作区服务器，下次调用重新启动。插件卸载会关闭监听器和所有服务器。

## 开发与验证

源码开发支持 npm 和 pnpm 默认隔离布局；仓库同时提供锁文件，CI 检查 Node 22/24 两个版本、两种包管理器和打包消费者类型。先编译，再安装本地目录：

```bash
npm ci
npm run build
dsh plugin --profile web add /absolute/path/to/dsh-eu4-modding
```

```bash
npm ci
npm run check
npm test
npm run check:package
npm run docs:agents
PARADOXCODE_TEST_SERVER=/absolute/path/to/paradoxcode npm run test:integration
# Verify automatic download plus the real 0.5.2 protocol (requires network on first run):
PARADOXCODE_TEST_SERVER=auto PARADOXCODE_TEST_VERSION=0.5.2 PARADOXCODE_TEST_CACHE=/tmp/dsh-paradoxcode-test-cache npm run test:integration
npm pack
```

普通测试使用假 LSP 子进程和真实 Cordis/DSH 工具注册器，覆盖帧解析、Unicode、取消、超时、错误码、插件卸载、参数校验、会话目录、草稿隔离、路径边界、LRU 回收与显示截断。下载器测试模拟 GitHub 响应，覆盖平台选择、tar.gz/ZIP 解压、SHA-256 校验、缓存升级与离线回退、异常压缩包、取消和超时。开箱使用测试覆盖默认安装、Mod 根目录识别、多个 Mod 的选择与显式路径优先级。端到端测试使用真实语言服务器及临时 Mod，覆盖默认自动游戏发现、所有工具、草稿不落盘、磁盘刷新、任务树及 0.5.2 中文编码/解码与注释保留，无需游戏安装。未设置 `PARADOXCODE_TEST_SERVER` 时端到端测试显示 skipped。

协议依据：[ParadoxCode LSP 接入指南](https://github.com/danxiaogu520/ParadoxCode/blob/main/crates/pdc/README.md)、[DSH 工具 SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/tools)。MIT 许可；不分发游戏文件或原版索引。

## 服务端修复与发布

`patches/paradoxcode-fixes.patch` 包含 ParadoxCode 0.5.2 开发源码（基准提交 `eae304594f5c987fa9723d12f46854e2861449ca`）上的隐藏事件 option 条件要求、原查询接口分页、根身份和扫描明细修复，以及全文转码实现和回归测试。插件兼容官方 0.5.2；这些服务端增强需要应用补丁后的服务器或包含同样能力的正式新版本。补丁未发布时，不会伪称官方 0.5.2 已经具有这些能力。

```bash
git -C /path/to/ParadoxCode checkout --detach eae304594f5c987fa9723d12f46854e2861449ca
git -C /path/to/ParadoxCode apply /path/to/dsh-eu4-modding/patches/paradoxcode-fixes.patch
cargo build --locked --release --manifest-path /path/to/ParadoxCode/Cargo.toml -p pdc --bin paradoxcode
```

将 `serverPath` 指向构建出的程序。隐藏事件修复在解析后的事件结构上处理，只放宽 `hidden = yes` 事件的 option 最低数量；可见事件、其它必填项和其它 Cardinality 仍保留检查。

共享配置字段的 schema 描述明确标注“继承及最终缺省值”，工作区 `configuration` 同时返回 `inheritedDefaults` 与实际 `effective` 值。它们不使用会把未配置误存成显式覆盖的 schema 默认值。`AGENTS.md` 和 `examples/AGENTS.md` 由真实工具注册清单及工作流生成，防止工具名再次漂移。

插件发布工作流先检查、测试并验证打包消费者，再创建/上传 `.tgz` 和 SHA-256；标签必须匹配 package.json。npm 发布是同一验证产物的可选手动步骤，需要配置 NPM_TOKEN。发布流程不会覆盖既有同名 Release 资产。
