# Codex Translate

Claude Code 原生 Mod：发送前检测中文输入并交给 Codex 翻译为英文；每轮结束后，只把 Claude 的最终回复交给 Codex 翻译为简体中文。输入翻译、输出翻译分别开关，Codex 模型可选择。

This native Claude Code mod translates Chinese user prompts into English and final assistant replies into Simplified Chinese using Codex CLI. Each translation includes the Claude session ID, the known transcript path, and a bounded recent conversation snapshot. Input and output translation have independent controls. The original assistant transcript remains intact.

## 使用

需要支持 Mods 的 Claude Code（开发验证版本：2.1.310）、已登录且支持 `codex exec --json` 和 `codex exec resume` 的 Codex CLI。翻译无需 npm install、Node 或构建步骤；模型目录查询另外需要 `python3` 和支持 `app-server` 的 Codex。测试使用 Node 20+。

先自行完成 `codex login`，然后在需要工作的项目目录启动：

```sh
claude --plugin-dir /data/claude-translate-mode
```

将路径换成你实际保存本插件的位置。进入会话后：

```text
/translate status
/translate show
/translate hide
/translate input off
/translate input on
/translate output off
/translate output on
/translate context off
/translate context on
/translate model
/translate models
/translate model 你的Codex模型ID
/translate model default
/translate reset
```

`model default` 沿用 Codex 自身默认模型，不硬编码模型列表；模型是否可用取决于你的 Codex 账号和 provider。命令修改在本次插件加载期间生效，重启或重新加载插件会恢复配置值。

持久设置：在 Claude `/config` 中搜索 `codex-translate`，设置 `input_translation`、`output_translation`、`codex_model`、`codex_binary` 和 `timeout_ms`，然后 `/reload-plugins`。默认输入与输出翻译都开启，超时 120 秒。

`/translate context off` 关闭上下文：每次翻译使用 `codex exec --ephemeral`，只发送翻译规则和当前待译文本，不读取/发送 Claude session ID、transcript 路径或最近对话，也不读取/修改持久 Codex 会话关联；同时禁用 Codex 的项目说明文件加载。`/translate context on` 恢复上下文与已有会话关联。持久选项是 `/config` 中的 `translation_context`，默认开启；切换只影响之后开始的翻译，不改变已经运行中的调用。关闭后不会删除旧 Codex 历史。

`/translate model` 显示当前插件选择；未显式选择时查询 Codex 的有效配置模型。`/translate models` 从 Codex app-server 的 `model/list` 读取可选 ID（包含分页），标明推荐默认项；它不是硬编码列表，也不会启动模型生成。此查询使用你当前的登录和 provider，失败时会明确提示，不把缓存或猜测当作实时列表。默认模式续接旧会话时，实际模型也可能受该会话已保存的设置影响。

输入、输出翻译期间，终端输入框上方会显示转动动画、当前翻译方向、选择的模型及上下文模式；成功、失败或取消后自动收起。Claude 的问卷占用该区域时优先显示问卷。动画使用终端 `AbovePrompt` 区域，非终端界面不保证显示。

## 对话流中的翻译

默认集成在 Claude 的对话流中：输入下方以淡色显示英文译文，最终回复下方用原生 Markdown 显示中文译文。不会自动打开侧边面板，也不逐行输出插件日志。输出按消息 ID 关联到对应回复，只在最后一个文本块后添加译文；没有捕获消息 ID 时可用 `/translate show` 查看。

**显示和模型输入分开**：中文原文只保存在本次加载的 UI 记录中。发送给 Claude 的正文完全替换为 Codex 的英文译文，不把中文原文放入正文或隐藏上下文。代码、路径、必须精确保留的中文文案等字面量可以保留中文；不额外改动附件、已有上下文或旧对话历史。输入翻译失败时阻止此次发送，避免退回中文原文。关闭输入翻译后按原样发送。

仍可用 `/translate show` 打开可选的翻译历史面板：

- 输入卡片：原始输入与英文译文对照；底层用户消息只有英文译文，原文展示不进入 Claude 上下文。
- 输出卡片：默认只展示中文回复；支持 Markdown 粗体、列表、表格和代码块，点「查看原文」展开 Claude 的原始回复。
- 「上一条 / 下一条」切换输入或输出卡片，长内容使用「上一页 / 下一页」。超长 Markdown 跨页时，跨页表格或代码块的格式可能分段显示，文字不截断。
- 只有 `/translate show` 主动打开面板。Claude 根据窗口尺寸决定将面板放在侧边还是输入框上方。关闭按钮或 `/translate hide` 隐藏面板。
- 面板保留本次插件加载期间最近最多 20 张卡片（另有总字符数量限制），重启或重载会清空 UI 历史。Claude/Codex 的对话历史与 Codex session 关联仍保留；旧消息不追溯重绘。
- `claude -p` / SDK 没有图形区域，每次输出翻译发出一条完整 `ui_log` 事件，原始 result 保持不变。

如果之前将插件复制安装到 Claude 目录，更新后重启 Claude：

```sh
cp -R /data/claude-translate-mode/{.claude-plugin,hooks,README.md} \
  ~/.claude/skills/codex-translate/
```

## 行为边界

- 开启输入翻译时，Claude 收到英文译文，原始中文只供 UI 对照。关闭输入翻译时按原样发送；翻译失败则阻止此次发送。图片、其它附件及已有上下文保持原样。
- 检测正文里的汉字，忽略 fenced code 和 inline code；包含日文假名时不当作中文。纯汉字的日文可能误判，此时关闭输入翻译。不是完整的语言识别模型。
- 使用 `turn.complete` 的 `answer`，忽略子代理、被中断的回合、错误回合和空回复。不会翻译 thinking、工具调用、工具结果或中途进度消息；有可见文字的拒绝回复也会翻译。
- **中文回复嵌在原回复下方渲染**，不会改写原始助手 transcript，不会额外触发 Claude 一轮。原回复仍会正常流式显示，不再把换行塞进单行摘要或每行加插件前缀。
- 每次调用附带真实 Claude session ID；通过 Classic hooks 捕获 Claude 提供的 transcript 路径，支持自定义 Claude 配置目录。另附最近最多 24,000 字符的用户/助手正文。首次热加载时路径可能尚未捕获，此时仍有 session ID 和正文快照。
- Codex 可按需只读访问指定历史文件。历史不存在、已清理或沙箱无法读取时依赖正文快照；不保证模型每次都主动读取文件。
- 每个 Claude session 关联一个持久 Codex session，首次翻译新建，后续输入与输出翻译通过明确的 ID 执行 `codex exec resume`（不用 `--last`）。关联存入插件的 `$.store`，重启/热重载后可恢复。不同 Claude session 分开，当前插件实例内同一 session 的调用串行执行；不支持多个 Claude 进程同时操作同一个 session。
- 改变翻译模型会继续同一 Codex session，但模型切换、服务端过期或上下文压缩仍可能使缓存失效；复用会话不保证缓存命中。历史被删除或损坏时运行 `/translate reset`，下次重新创建；不会自动对所有错误重试或静默新建会话。此命令只清除关联，不删除旧 Codex 历史。更换插件安装位置/身份可能使用独立的插件存储。
- Codex 以参数数组启动，无 shell 拼接，待译内容通过 stdin 传入；使用 `read-only` 沙箱、禁止交互审批。沿用本机 Codex 登录和 provider 配置。Claude 对话正文会发送到你配置的 Codex 模型服务，翻译会话也会保存在 Codex 本地历史中。
- 提示词要求保留代码、路径、链接、标识符及 Markdown，译文质量仍取决于模型。登录失败、模型不存在、超时或输出不完整时，输入阻止发送、输出保留 Claude 原回复，不把错误内容当成译文。

## 验证

```sh
npm test
npm run test:models
claude plugin validate .
claude plugin test .
```

Node 测试覆盖翻译流程和故障回退，Claude 原生测试检查 Mod 运行时中的命令。它们不会调用付费模型。完整的真实翻译需要在已登录的 Claude 交互会话中验证：发送中文、确认译文，再关闭输入翻译发送第二条消息，确认最终输出仍翻译。

当前受限开发环境的验证结果：Node 流程测试通过、插件静态验证通过（有未填写作者/发布元数据的提示）；原生测试器报 `its run ended without a report (exit code 0)`，模型目录查询的 app-server 子进程也提前退出，因而未完成真实 UI 和在线目录查询验证。仓库可直接本地加载，尚未配置发布市场、授权许可证和图标。

实现依据：[Claude Mods 参考](https://code.claude.com/docs/en/plugins/mods/reference)、[官方类型定义](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)、[OpenAI Codex CLI 文档](https://developers.openai.com/codex/cli/reference)。
