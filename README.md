# dsh-highlight-plugin

**会话内划重点：在 DSH 会话界面上选中任意语句，一键标成高亮色块（黄/绿/蓝），单独删，会话期间一直在。**

> 缘起（2026-11-09）：「在与大模型的问答过程中，我可以在会话界面上选中任意需要留意的语句，
> 将其鼠标划线以高亮标色块的方式标记为重点；每个标色块可单独手动删除，未手动删除的高亮
> 标记将一直保留在会话中，直到我主动删除为止。」→ 走插件补上。

## 它做什么

| 半 | 位置 | 干什么 |
| --- | --- | --- |
| client | 会话正文区 | 划词选中 → 浮出取色 pill（黄/绿/蓝三颗色球）→ 点色球成标 |
| client | 正文区上方的覆盖层 | 高亮色块**画**在独立覆盖层上（不碰框架 React 管的 DOM） |
| client | 色块上点击 | 弹"删除这条重点标记？"小确认框 → 删除（单独删，别的标记不受影响） |
| host | `127.0.0.1:3205`（只监听回环） | `GET/POST /highlights`、`POST /highlights/delete`，按会话存取 |

## 为什么色块是"覆盖层"而不是往消息里包 `<mark>`

会话正文是框架 React 管的 DOM：往里插 `<mark>`，框架下一次重渲染（流式输出、换会话回来、
任何 state 变化）就会把它冲掉，还会污染 React 的 reconcile。所以走 Hypothesis / 网页划词
批注那一套成熟路线：

```
文本锚定（引文 + 前后文）→ 在现 DOM 里重新定位 Range → getClientRects()
→ 在一层 position:fixed、pointer-events:none 的覆盖 div 里画色块
```

**框架 DOM 一个字节都不改**。色块被重渲染冲掉大不了重新锚定重画（MutationObserver 防抖 200ms）。

## "重渲染/刷新后还能找回那句"是怎么做到的

存的不是坐标（坐标随布局变），是**引文** `{ text, prefix, suffix }`——正文 + 前 160 字 + 后 160 字，
全部做过规范化（去零宽字符 / 空白折叠 / 小写）。重画时：

1. 收集正文区全部文本节点拼全文 + 归一化索引（norm ↔ raw 双向映射）；
2. 先拿 `prefix+text+suffix` 整段匹配——**同一句出现多次时靠上下文消歧**；
3. 退而求其次拿 `text` 裸匹配——**只有唯一命中才画**；多处命中又没上下文可分辨时
   **宁可不画**（fail-closed：画错地方比不画糟糕得多），等下次重锚。

## 持久化：按会话分文件，直到手动删除

```
~/.dsh/highlights/<encodeSegment(会话id)>.json    →  { highlights: [...] }
```

- 会话 id 沿用框架的 `session-<uuid>`（重启不变），标记跟着会话走；
- 换会话自动加载那一份（`[data-conversation-session]` DOM 属性 + `sessions.list` 快照双路认 id）；
- **跨重启也在**（要求是"会话持续期间保留"，落盘是超集，顺手把刷新/重启也保住了）；
- 只有**手动删除**才移除：删除要过 host 账本才算数，POST 失败则标记保留并明说。

## 三条安全线

1. **只认 `session-<uuid>` 形态的会话 id**（client 与 host 双重把关），目录名再过
   `encodeSegment`（抄框架 `dsh-session-persistence-jsonl` 的编码，session-delete 同款）——
   防的是拿别的字符串去拼文件路径；
2. **记录的 id / createdAt 由 host 发**（`crypto.randomUUID`），客户端给的丢弃；
   字段长度封顶（正文 2000 / 上下文 160），颜色只认三种，坏颜色 400 不落盘；
3. **锚定歧义不画**：裸匹配多处命中且无上下文可分辨 → 该标记当轮不渲染（orphan），
   数据仍在账本里，下次重锚再试。

## 交互细节

- composer（输入框）里选字**不会**弹取色 pill（contenteditable/输入类元素一律跳过）；
- **加粗/标题/段首起拖都能标**（2026-11-09 修，v1.2.x）：两类端点陷阱——
  ① 选区端点落在本元素上（`**加粗**` 在段首起拖、拖选整行标题），Chromium 记成（元素, 子索引）；
  ② 端点落在**纯空白文本节点**上（`**2026-120** **雅江隧道…**` 两个 strong 之间的空格，
  "从雅前框选"的光标会被规范化成（该空格节点, 末尾））。两类端点都不在文本节点表里，
  旧版查不到就把标色整个放弃了。现在 `resolveTextPoint` 对两类端点都回退到"所指位置
  前后最近的正文"（起点取后邻首段文本、终点取前邻末段文本），空白兄弟节点自动跳过；
- 控制台敲 `window.__DSH_HIGHLIGHT_DEBUG__.ver` 可确认当前 bundle 版本（改码后要**重启宿主**
  才生效——bundle 是启动时快照的）；
- 在插件自己的 UI 上松手/点击不会误标误删（`data-dsh-hl-ui` 标记）；
- Esc / 点击空白收起 pill 与删除弹框；滚动时 pill 收起、色块跟随（live Range 矩形重画）；
- **同句重标 = 替换不叠色**（2026-11-09 修）：同一引文再标，撤掉全部旧的（含账本里历史叠层）
  换成新色；同句同色重复点 = 无事可做。旧版只判"同颜色才跳过"，换色再标就叠一层——
  叠色删除删不完的根源；
- 点色块弹删除确认，**认得叠层**：点击处有几条重叠就明说几条，给
  [删除全部 N 条] / [只删最上一条] / [取消]；删除 POST 失败 → 整批保留 + 弹框里写明失败；
- 同一句话同颜色重复标 → 自动跳过（不叠两层）。

## 锚定范围：会话正文区优先（v1.2.4）

侧栏的会话标题经常和正文里的句子**同名**（标题就是从首条消息生成的）。全文匹配时同一句话
出现两处 → 歧义 fail-closed → orphan（2026-11-09 实测"标记创建成功但 anchored=0，着色上不去"）。
现在锚定先在会话正文区（`[data-conversation-session]`）内找，找不到再扫全文；创建引文同样
以会话内文本为源，与重锚同源自洽。

## 排障

控制台敲 `window.__DSH_HIGHLIGHT_DEBUG__`：

| 字段 | 含义 |
| --- | --- |
| `ver` | bundle 版本（改码后**必须重启宿主**才更新——bundle 是启动时快照的） |
| `sid` | 当前认到的会话 id（空 = 还没认到，会话界面没挂载或结构变了） |
| `active` | 当前会话账本里的标记数 |
| `anchored` / `orphan` | 这轮锚定成功 / 没锚定上（歧义或找不到）的条数 |
| `created` / `deleted` | 本轮成功新增 / 删除次数 |
| `fallbackCreated` | 端点解析不出时走"选区文字唯一命中"兜底成功的次数 |
| `pillNoAnchor` | 选区松手后 pill 没浮出来的次数（端点完全解析不出） |
| `lastError` | 最近一次失败的如实说明 |
| `lastFail` | 失败现场（stage: pill-gated/create-no-anchor/dup-skip/orphan + 端点形态） |

**host 半端点没起来时**看 `~/.dsh/highlights/host-boot.log`（即用户主目录下的 `.dsh/highlights/`）：
正常轨迹是 `apply 被调用 → 准备 listen → listening 事件/listen 回调触发`；
⚠️ 2026-11-09 真凶记录：**cordis 的 `ctx.effect(fn)` 会在激活时立即执行 fn，fn 的返回值才是卸载器**
——最初把"关闭函数"直接传了进去（`effect(closer)`），激活瞬间服务器被自己关掉（close 事件），
3205 永远不在（POST REFUSED、标记跨重启不保留的根源）。正确写法是 `effect(() => () => closer)`
（对齐 session-delete / archive / input-history）。

⚠️ 2026-11-09 第二个真凶记录：**引文边界空白会让严格拼接匹配永远失败**。
`normalize` 会剪掉引文首尾空白，而文档里正文与前后文之间往往有空格——
`text + suffix` 拼起来在归一化全文里永远 indexOf 不到（`对接 — 今天` vs 拼出的
`对接— 今天`）。分级①②③全部受影响，是"分级匹配加了还是 orphan"的根源。
修法（v1.2.8）：先收集正文所有出现位置，再对每个位置用**压缩形态**（去全部空白）
校验前后上下文，①两级都对取首个、②③唯一命中、④裸唯一、歧义拒画（fail-closed 不变）。

常见情形：`anchored=0 且 orphan>0` → 那句话被改过/压缩了，找不到原句（数据还在，
不丢）；`sid` 一直为空 → 会话容器的 `data-conversation-session` 属性变了（框架升级后对一下）。

## 已知边界（如实记一笔）

- 覆盖层色块不接鼠标事件（`pointer-events:none`），点色块走的是 document 捕获阶段的
  命中判定——正在选字（选区非塌陷）时点击不会触发删除弹框，不会跟选字打架；
- `mix-blend-mode: multiply` 在浅色主题下字很清楚；深色主题下是普通半透明覆盖，同样可读；
- AI 流式输出的瞬间，新锚定最多延迟 200ms（防抖节拍），属正常现象；
- 会话被压缩/编辑过导致原句找不回 → 该条标记静默不画但数据保留（删了才真没了）；
- 端口被占时插件不拖垮宿主：标色仍在本轮内存里有效，落盘会失败并如实提示。

## 自检

```bash
node smoke.mjs    # host 半真端点（临时端口 3212 + 临时存储根）+ client 半纯逻辑
```

覆盖：新增（host 发 id）/ 列表 / 删除幂等 / 会话隔离（分文件）/ 存盘真的落了盘 /
非法 sid 400 / 坏颜色 400 / 超长 400 / 未知端点 404 / OPTIONS 预检 / 客户端假 id 被丢弃；
规范化 / 归一化索引双向映射 / 锚定（唯一命中 / 上下文消歧 / 歧义拒画 / 跨段落锚回）/
引文提取封顶 / pill 真值表 / 端点判据 / 矩形合并 / 点击命中 / sid 形状校验。

## 安装 / 卸载

### 从插件市场 / GitHub 装

DSH 的插件市场（Settings → Plugins → Market）搜 `dsh-highlight`，或命令行：

```bash
dsh plugin add github:xiaoyaoguhuaxian/dsh-highlight-plugin
```

不发 npm，预构建 tgz 挂在 GitHub Release 上（`latest/download/dsh-highlight-plugin.tgz`，
文件名不带版本号，链接永不过期）。

### 开发模式（本机 link）

1. `<profile>/node_modules/dsh-highlight-plugin` → 本目录的目录链接（junction）；
2. `<profile>/package.json`：`dependencies` 加 link，`dsh.profile.bundles` 加 `"dsh-highlight-plugin"`。

卸载：从 `dsh.profile.bundles` 移除即可。改客户端代码要重启宿主（bundle 是启动时快照的）。

端口：默认 3205（`DSH_HIGHLIGHT_PORT` 可覆盖），避开既有插件的 3199/3200/3201。
