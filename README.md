# @xsj/dsh-rewind

[English](./README_EN.md) | 简体中文

DSH（[DeepSeek Harness](https://github.com/deepseek-ai)）会话回退插件。永久 bundle 插件：宿主机半 + Web 客户端半，零依赖、零构建步骤。桌面端与 `dsh web` 使用同一份代码、同一套安装方式。

## 功能

- 每条用户消息的操作行（复制图标旁）出现 **↺ 回退** 图标。点击后：
  - 若模型正在思考/输出，**立即打断**当前回合；
  - 该消息及其后的所有内容在聊天视图中隐藏（如同从未发生）；
  - 该消息文本自动填入输入框，**未发送、可编辑**；
  - 该消息携带的**图片也会重新挂回输入框**（客户端按会话凭据从日志读回原始字节，走官方草稿附件入档流程，自动套用图片数量/大小限制）；
  - 下一次发送时，模型只看到截断后的历史（回退点之前）+ 新消息。
- 回退待发送期间：
  - 输入框上方出现提示横幅；
  - **发送按钮左侧出现 ✕「取消回溯」**：点击后恢复被隐藏的消息，草稿保持不变，不发送任何内容。
- 发送后（回退生效）：被隐藏的消息永远不再出现在聊天视图，也不再进入模型上下文。
- 仅用户消息可回退；DSH（助手）消息没有回退入口（Host 侧强制校验事件类型）。

## 版本兼容性

| 插件版本 | DSH | 状态 |
| --- | --- | --- |
| 2.5.0 | 0.2.1-rc.2 | 当前版本，桌面端与 `dsh web` 均已适配 |
| ≤ 2.4.0 | 0.1.x | 不支持 0.2.x |

0.2.x 改写了客户端渲染与消息派生两处契约，旧版在这条线上会表现为「回退按钮整个消失」：用户气泡的文本渲染器从 `primitives.projectUserText` 迁移到 `conversation.chat.user.content` 工厂槽，行组件的 props 也不再提供 `inputActions`。2.5.0 按新契约重写客户端，并把模型侧截断改为官方 surface 替换（见「实现要点」）。安装时若还想留在 0.1.x，请使用 2.4.0。

## 安装

```powershell
# 桌面端（profile 名为 desktop）：
dsh plugin --profile desktop add <本仓库目录的绝对路径>

# dsh web（profile 名为 web）：
dsh plugin --profile web add <本仓库目录的绝对路径>

# 安装后重启 DSH 进程 / 桌面应用，并刷新页面
```

该命令会把包登记进 profile（`~/.dsh/profiles/<name>/package.json` 的
`dependencies` + `dsh.profile.bundles`），profile 启动时合并本包的
`cordis.patch.yml` 插入宿主机插件行，Web 客户端扫描自动加载 `lib/client.js`。
桌面端与 `dsh web` 共用这一套加载机制，因此两条线只需换 `--profile`。

## 卸载

```powershell
dsh plugin --profile desktop remove @xsj/dsh-rewind
# 重启 DSH。会话日志中的回退记录无害保留（见「日志与可恢复性」）。
```

## 实现要点

- **模型侧截断**：回退生效时向会话日志追加一条**空内容 `developer/message`**，其
  `surfaceOp` 为 `replace`，替换从回退点一直到 surface 末尾的节点，并按要求在
  `sourceEventSeqs` 中列出被遮蔽的全部节点。空内容的 developer 消息不派生任何模型消息，
  因此模型看到的是截断后的历史，而日志里一条消息都没少。
  - 不修改 `deriveMessages()`，也不写自定义事件类型：截断是日志自身的一部分，重放日志即可
    恢复（重启、fork、插件重载都不需要额外对账）。
  - 每次替换都会递增 surface 的 `replaceGeneration`，宿主据此开启新的消息序列并重新下发
    系统提示，请求头一致性由宿主自身维护。
- **打断**：mark 时若代理正在运行，`agent.cancel({ kind: 'user' }, { keepInbox: true })`
  中断当前回合；排队消息保留，随后从截断点继续。
- **生效点**：`agent/pre-step` 瀑布中，待回退会话一旦有新输入消息进入步骤即提交替换；
  新消息在此之后追加，不受影响。
- **UI 隐藏**：纯 DOM 实现——聊天行带 `data-chat-flow-key`，客户端按行打 seq 戳并由
  MutationObserver 驱动，对隐藏行内联 `display:none`；不依赖宿主 store 内部形状，
  取消/切换会话即还原，不改动任何既有渲染器。
  - 只有 `user` / `steering` 行由本插件渲染、能打上 seq；模型输出、工具调用、context 等行
    按 DOM 顺序从**前一条已标记行**继承判定（前导无证据的行才回退到后方证据）。
  - 隐藏状态写的是活动 DOM，故驱动卸载时只释放带本插件标记的行。
- **回退图标**：以优先级 `-1` 接管 `conversation.chat.node` 的 `user`/`steering`
  渲染器（槽位系统的原生遮蔽机制）。气泡本身交给官方
  `conversation.chat.user.content` 工厂槽渲染，因此 @引用、会话 chip、图片、文件卡片
  始终由外壳负责，插件只多出 ↺ 按钮。
- **草稿与图片回填**：草稿经 `ctx.conversation.input.for(scope).setDraft()` 写入（与命令面板
  同一入口），服务不可用时回退到编辑器的 DOM 写入；图片经会话凭据
  `session.readAttachment()` 读回字节，再由 `createDrafts()` + `addAttachments()` 进入
  官方草稿附件登记，配额与预览均由外壳负责。
- **状态**：待发送的回退只存在于 Host 内存（草稿不跨进程，因此无需持久化）；已提交的回退
  区间由日志中的替换事件在启动时推导，插件不写任何私有记录。

## 安全说明

- 三个端点（`mark` / `cancel` / `state`）注册在 dsh 的 Web 服务器上，**遵循 dsh 自身的
  本地信任模型**：`dsh web` 与桌面端默认只监听本机回环地址，因此端点仅本机可达、不经
  dsh 的 API 鉴权层。若你把 dsh web 绑定到对外地址（如 `0.0.0.0`），这些端点会随之外露
  ——此时请自行在网络层（防火墙 / 反向代理鉴权）加以限制。
- 图片读取不经过本插件：客户端用当前会话的凭据调用宿主的 `readAttachment`，授权范围与
  聊天记录一致（只能读到本会话引用过的附件）。
- 请求体上限 64 KB；`seq` 必须是安全非负整数；目标必须是 `user/message` 且当前仍在模型
  可见的 surface 上。
- 插件不收集、不上报任何数据；所有状态都留在本地会话日志中。

## 日志与可恢复性

- 会话日志（append-only 事件流）**从不删除任何原始消息**。
- 回退生效只追加一条空内容 `developer/message`（`surfaceOp: replace`），不写入任何未知
  事件类型，因此日志在 0.2.x 的读取端始终可打开。
- 进程重启后打开会话，surface 回放会重建同样的截断：模型侧与 UI 侧的隐藏状态跨重启一致。
- 「轨迹」视图不渲染被替换的副本，回退点之后的行在轨迹里仍按原始事件存在；审计请直接查看
  会话日志。

## 已知限制

- 回退目标必须仍在模型可见的 surface 上。若该消息已被压缩（compaction）遮蔽，回退会被
  拒绝并提示，而不是在发送时才失败。
- 回退本身不做文件还原（工作区文件不在本插件职责内）。
- 待发送的回退不跨进程：重启 DSH 后草稿仍在输入框里，但「待发送」状态不会恢复（这与设计
  一致——草稿本身是唯一的载体）。

## 移植

本插件无任何 npm 依赖：Host 半只用 Node 内置模块与注入服务，Client 半经
`window.__ModuleLoader__` 从外壳的冻结模块表取 `react` /
`@deepseek-ai/dsh-client-ui-primitives`。克隆本仓库到任意机器后按「安装」一节操作即可。

## 测试

```powershell
node test/hiding.test.mjs          # 行隐藏判定（纯 DOM 逻辑）
node test/client-smoke.test.mjs    # 客户端在 0.2.1 契约下的注册与渲染
# Host 半需要真实的 @deepseek-ai/dsh-session（指向其 lib/index.js，例如源码仓库的
# packages/core/session/lib/index.js，或任意 node_modules 安装）：
$env:DSH_SESSION_MODULE="<path>/lib/index.js"; node test/host.test.mjs
```

## License

[MIT](./LICENSE)
