# DST Bridge — 饥荒联机版 AI 接入设计文档

> 让 LLM 通过 `dst` CLI 玩 Don't Starve Together，不需要 OCR，不需要截图识别。
> 架构参考 Disco Engine：REST API + Skill CLI，输出紧凑文本省 token。

---

## 1. 一句话

DST mod 做出站 HTTP 把游戏状态发给 Bridge Server，Claude 通过 `dst` CLI 读状态 + 发命令，DST mod 轮询拉取命令并通过 BufferedAction 执行。

---

## 2. 为什么是 Skill CLI 而不是 MCP

### 2.1 Disco Engine 已验证的模式

Disco Engine 双入口：REST API（`/api/<tool>`，返回纯文本）+ MCP（`/mcp`，返回 JSON）。`disco` CLI 调 REST API，SKILL.md 教 Claude 用 CLI。

**实测结论**: Skill CLI 路径更省 token，因为输出是定制紧凑文本而非 JSON。

### 2.2 Token 对比

同样一次"读取状态"：

```
# MCP 返回 JSON (~1000 tokens)
{"connected":true,"player":{"health":150,"maxHealth":150,"hunger":120,"maxHunger":150,...},"world":{...}}

# CLI 返回文本 (~200 tokens)
HP:150/150 Hgr:120/150 San:180/200 Day5 Autumn dusk
Pos:(120,-340) Light:yes Busy:no
Nearby: tree#12345 7m R[chop] sapling#12346 3m FL[pick] rabbit#12347 12m R[atk]
Inv: axe(x80) logx15 cutgrassx8 flintx3 twigsx2
Equip: axe
Recipes: campfire[✓] axe[✗ need twigs]
```

DST 是准实时游戏，每 2 秒一次状态读取。100 次调用累计：MCP ~100K tokens，CLI ~20K tokens。**5 倍差距**。

### 2.3 配置成本

| | MCP | Skill CLI |
|---|---|---|
| 需要 `claude mcp add` | 是 | **否** |
| 需要 MCP server 进程 | 是 | **否** |
| Claude 发现方式 | MCP 连接 | Claude Code 读 SKILL.md 自动发现 |
| Bridge Server 复杂度 | REST + MCP 两套 | **只 REST 一套** |

MCP 作为可选入口以后加回来（跟 Disco Engine 一样），但 MVP 阶段只做 CLI。

---

## 3. DST 的约束

| 能力 | 支持？ | 说明 |
|---|---|---|
| 官方 mod API | 是 | Lua 脚本，完整的游戏内部访问 |
| 枚举附近实体 | 是 | `TheSim:FindEntities(x, y, z, radius)` |
| 读取组件 | 是 | `ent.components.health.currenthealth` 等 |
| 执行动作 | 是 | `BufferedAction(player, target, action, invobject, pos)` |
| 监听事件 | 是 | `inst:ListenForEvent("healthdelta", fn)` |
| 出站 HTTP | 是 | `TheSim:QueryServer(url, callback, "POST", data)` |
| 监听端口 | **否** | 沙盒环境，不能起 HTTP server |
| 写本地文件 | **受限** | 只能写特定保存目录，不适合实时 IPC |

**结论**: DST mod 只能做出站 HTTP。Bridge Server 做中间人，CLI 调 Bridge Server 的 REST API。

---

## 4. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│  Claude (Claude Code / 任何 LLM agent)                    │
│  读 SKILL.md 学会 `dst` 命令                               │
│  bash: dst state → dst chop 12345 → dst state ...        │
└──────────────────────────┬───────────────────────────────┘
                           │ bash 调 dst CLI
                           │ (dst CLI 内部调 REST API)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  dst CLI (Node.js 脚本, 在 PATH 里)                        │
│  dst state / dst nearby / dst chop / dst build ...       │
│  读 ~/.dst-bridge.json 获取 server URL                     │
│  POST http://localhost:3001/api/<tool>                    │
│  输出紧凑文本                                              │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP (localhost)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Bridge Server (Node.js, localhost:3001)                  │
│                                                          │
│  ├── REST API (一套, 给 CLI 和 DST mod 共用)               │
│  │                                                      │
│  │   给 DST mod (内部上报):                               │
│  │   POST /state     ← DST mod 上报游戏状态               │
│  │   GET  /commands  → DST mod 拉取待执行命令              │
│  │   POST /result    ← DST mod 上报命令执行结果            │
│  │   POST /event     ← DST mod 上报即时事件               │
│  │   GET  /config    → DST mod 拉取配置                   │
│  │                                                      │
│  │   给 CLI (Claude 调):                                  │
│  │   POST /api/state      → 紧凑文本状态                   │
│  │   POST /api/nearby     → 紧凑文本附近实体               │
│  │   POST /api/inventory  → 紧凑文本背包                   │
│  │   POST /api/events     → 紧凑文本事件                   │
│  │   POST /api/do         → 排队动作                      │
│  │   POST /api/queue      → 查看/管理命令队列              │
│  │   POST /api/status     → bridge 连接状态               │
│  │                                                      │
│  ├── 状态缓存 (in-memory)                                 │
│  │   currentState    最新一次 /state 的内容                │
│  │   commandQueue    待执行命令队列                        │
│  │   eventLog        最近 100 条事件                      │
│  │   actionResults   命令执行结果                         │
│  │                                                      │
│  └── 配置                                                │
│      port: 3001                                         │
│      pollInterval: 2s (可调)                             │
│      maxQueueSize: 32                                   │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP (TheSim:QueryServer)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  DST Mod (Lua, 在游戏进程内运行)                           │
│                                                          │
│  ├── modmain.lua    入口：初始化、配置、定时器              │
│  ├── scripts/                                             │
│  │   ├── perception.lua 感知：枚举实体、读组件、组装 JSON   │
│  │   ├── actions.lua    执行：命令 → BufferedAction        │
│  │   ├── events.lua     监听：游戏事件 → 即时上报          │
│  │   └── http.lua       通信：TheSim:QueryServer 封装     │
│  │                                                      │
│  工作循环 (DoPeriodicTask, 每 2 秒):                      │
│    1. perception() → 组装状态 JSON                        │
│    2. POST /state                                        │
│    3. GET /commands                                      │
│    4. 对每条命令 → actions.execute(cmd)                   │
│    5. POST /result                                       │
└──────────────────────────────────────────────────────────┘
```

**数据流**:
- DST → Bridge Server: JSON（DST mod 内部组装，结构化）
- Bridge Server → CLI: **紧凑文本**（省 token 的关键）
- CLI → Bridge Server: JSON（命令参数）
- Bridge Server → DST: JSON（命令队列）

Bridge Server 做格式转换：DST 上报的 JSON → CLI 输出的紧凑文本。

---

## 5. `dst` CLI 命令清单

### 5.1 命令总览

```bash
dst state              # 一行状态快照
dst nearby             # 附近实体列表
dst nearby tree        # 只看树
dst nearby --action chop  # 只看可砍的
dst inv                # 背包 + 装备
dst events             # 最近事件
dst events --since 5   # seq 5 之后的事件
dst chop 12345         # 砍 GUID 12345
dst mine 12346         # 挖矿
dst pick 12347         # 采摘
dst pickup 12348       # 拾取
dst attack 12349       # 攻击
dst eat 12350          # 吃
dst equip 12350        # 装备
dst unequip hands      # 卸下手部
dst build campfire     # 建造
dst build axe          # 制作
dst walk 200 -300      # 走到坐标
dst walkto 12345       # 走到实体旁
dst cook 12350 12351   # 在 12351 上烹饪 12350
dst addfuel 12352 12353 # 给 12353 加燃料 12352
dst sleep 12354        # 在 12354 睡觉
dst cancel             # 取消队列 + 中断当前动作
dst queue              # 查看命令队列
dst status             # bridge 连接状态
dst help               # 帮助
```

### 5.2 输出格式（紧凑文本，省 token）

#### `dst state`
```
HP:150/150 Hgr:120/150 San:180/200 Temp:25C Wet:0
Day5 Autumn dusk(2/12) Moon:new Rain:no Snow:no
Pos:(120,-340) Light:yes Busy:no Ghost:no
Equip:axe Hands:axe Head:- Body:-
Inv[8]: axe(80u) logx15 cutgrassx8 flintx3 twigsx2 berriesx5 torch(60u)
Recipes[can]: campfire torch
Recipes[need]: axe(+2twigs) spear(+1rope)
```

解析：
- `HP:150/150` — 当前/最大血量
- `Hgr:120/150` — 饥饿值
- `San:180/200` — 理智
- `Temp:25C` — 温度
- `Wet:0` — 潮湿度
- `Day5 Autumn dusk(2/12)` — 第5天，秋天，黄昏，当前第2天/共12天
- `Pos:(120,-340)` — 坐标
- `Light:yes` — 在光亮中
- `Busy:no` — 是否正在执行动作
- `Equip` / `Hands` / `Head` / `Body` — 装备槽
- `Inv[8]:` — 背包8格，`axe(80u)` = 斧头剩余80耐久，`logx15` = 15个木头
- `Recipes[can]` — 材料够可以做的
- `Recipes[need]` — 差一点材料的

#### `dst nearby`
```
Nearby[15] r=20:
  #12345 tree     7.1m FR  [chop] tall
  #12346 sapling   3.5m FL  [pick] 
  #12347 rabbit   12.0m R   [atk,pickup] 
  #12348 flint     1.2m F   [pickup] x3
  #12349 boulder   8.5m BR  [mine] 
  #12350 spider    9.0m B   [atk] hp:50
  #12351 campfire  2.0m F   [addfuel] fuel:45/180
```

解析：
- `#12345` — GUID（动作命令用这个）
- `tree` — prefab
- `7.1m` — 距离
- `FR` — 方位（Front-Right）
- `[chop]` — 可执行动作
- `tall` — 实体状态（树的大小）

方位缩写：`F`=前 `B`=后 `L`=左 `R`=右 `FL`=前左 `FR`=前右 `BL`=后左 `BR`=后右

#### `dst nearby tree`
```
Nearby[tree] 3 found:
  #12345 tree     7.1m FR  [chop] tall
  #12352 tree    10.3m L   [chop] normal
  #12353 tree    15.2m BL  [chop] short
```

#### `dst nearby --action chop`
```
Nearby[choppable] 4 found:
  #12345 tree     7.1m FR  [chop] tall
  #12352 tree    10.3m L   [chop] normal
  #12353 tree    15.2m BL  [chop] short
  #12349 boulder  8.5m BR  [mine] 
```

#### `dst inv`
```
Inventory[8/15]:
  [1] axe       x1  (80/100u)  equip:hands
  [2] log       x15
  [3] cutgrass  x8
  [4] flint     x3
  [5] twigs     x2
  [6] berries   x5  fresh:0.8
  [7] torch     x1  (60/100u)
  [8] (empty)
Equipped:
  hands: axe(80u)
  head:  -
  body:  -
Backpack: (none)
```

#### `dst events`
```
Events[3] last 60s:
  #1 [attacked] hound dmg:20 hp:150→130  12s ago
  #2 [killed]   rabbit                     8s ago
  #3 [dusk]     phase:day→dusk             3s ago
```

#### `dst events --since 1`
```
Events since #1:
  #2 [killed]   rabbit                     8s ago
  #3 [dusk]     phase:day→dusk             3s ago
```

#### `dst chop 12345`
```
✓ queued: chop #12345 (tree, 7.1m FR)
  id=cmd-001 wait~2s for DST to pick up
```

#### `dst build campfire`
```
✓ queued: build campfire at current pos
  id=cmd-002 materials: logx2 cutgrassx3 (have: 15,8)
```

#### `dst build campfire 200 -300`
```
✓ queued: build campfire at (200,-300)
  id=cmd-003 materials: logx2 cutgrassx3 (have: 15,8)
```

#### `dst cancel`
```
✓ cancelled 3 queued commands
  current action: aborted
```

#### `dst queue`
```
Queue[2]:
  cmd-002 [build campfire]      queued
  cmd-003 [chop #12345]         executing (walking to target)
```

#### `dst status`
```
Bridge: localhost:3001
DST:    connected (last state 1s ago)
Queue:  2 pending, 1 executing
Uptime: 3600s  cmds processed: 150
```

DST 未连接时：
```
Bridge: localhost:3001
DST:    NOT CONNECTED (last state 45s ago)
  → Is the DST mod running? Is the game hosting a world?
```

---

## 6. REST API 协议

### 6.1 DST mod → Bridge Server（内部通信）

这些端点只给 DST mod 用，返回 JSON。

#### POST /state

DST mod 上报当前游戏状态。

**Request (JSON):**
```json
{
  "seq": 42,
  "ts": 1779815359,
  "player": {
    "userid": "KU_xxx",
    "name": "Wilson",
    "prefab": "wilson",
    "health": 150, "maxHealth": 150,
    "hunger": 120, "maxHunger": 150,
    "sanity": 180, "maxSanity": 200,
    "moisture": 0, "temperature": 25,
    "isFreezing": false, "isOverheating": false,
    "pos": { "x": 120.5, "y": 0, "z": -340.2 },
    "facing": 1.57,
    "isBusy": false, "currentAction": null,
    "inLight": true, "isGhost": false
  },
  "world": {
    "cycle": 5, "phase": "day", "season": "autumn",
    "seasonProgress": 0.35, "remainingDaysInSeason": 10,
    "isRaining": false, "isSnowing": false,
    "moonPhase": "new", "isCave": false
  },
  "nearby": [
    {
      "guid": 12345, "prefab": "tree", "name": "Evergreen",
      "pos": { "x": 125, "y": 0, "z": -335 },
      "distance": 7.1, "bearing": "front-right",
      "actions": ["chop"],
      "state": { "growthStage": "tall", "isBurning": false, "isStump": false }
    }
  ],
  "inventory": [
    { "slot": 1, "guid": 12350, "prefab": "axe", "name": "Axe",
      "stackSize": 1, "equipSlot": "hands", "uses": 80, "maxUses": 100 }
  ],
  "equipped": {
    "hands": { "prefab": "axe", "name": "Axe", "uses": 80 },
    "head": null, "body": null
  },
  "recipes": [
    { "recipe": "campfire", "name": "Campfire", "canBuild": true,
      "ingredients": [{ "item": "log", "need": 2, "have": 15 }] }
  ]
}
```

**Response:**
```json
{ "ok": true, "commandsWaiting": 3 }
```

#### GET /commands

DST mod 拉取待执行命令，返回队列并清空。

**Response:**
```json
{
  "commands": [
    { "id": "cmd-001", "action": "chop", "targetGuid": 12345, "invObjectGuid": null, "pos": null, "recipe": null }
  ]
}
```

#### POST /result

**Request:**
```json
{ "id": "cmd-001", "status": "ok", "action": "chop", "result": { "itemsGained": [{ "prefab": "log", "count": 2 }] } }
```

失败：
```json
{ "id": "cmd-001", "status": "fail", "reason": "target_not_found", "message": "Entity 12345 no longer exists" }
```

#### POST /event

即时事件（不等 2 秒周期）。

```json
{ "ts": 1779815359, "kind": "attacked", "data": { "attackerPrefab": "hound", "damage": 20, "healthAfter": 130 } }
```

事件类型：

| kind | 触发 | data |
|---|---|---|
| `attacked` | 被攻击 | attackerPrefab, damage, healthAfter |
| `killed` | 杀死实体 | targetPrefab |
| `death` | 玩家死亡 | cause, killerPrefab |
| `respawn` | 复活 | — |
| `health_critical` | HP < 30 | health |
| `hunger_critical` | 饥饿 > 140 | hunger |
| `sanity_low` | 理智 < 30 | sanity |
| `dusk` | 黄昏开始 | — |
| `night` | 夜晚开始 | — |
| `dawn` | 天亮 | — |
| `freeze_warning` | 开始冻结 | temperature |
| `overheat_warning` | 过热 | temperature |
| `new_recipe` | 解锁配方 | recipe |
| `boss_nearby` | boss 靠近 | bossPrefab, distance |

#### GET /config

**Response:**
```json
{
  "pollInterval": 2.0,
  "perceptionRadius": 20,
  "maxNearbyEntities": 30,
  "enableEvents": true
}
```

### 6.2 CLI → Bridge Server（Claude 用的 API）

这些端点返回**紧凑文本**，不是 JSON。CLI 直接输出。

#### POST /api/state
**Input:** `{}` （空 JSON）
**Output:** 紧凑文本（见 5.2 的 `dst state` 输出格式）

#### POST /api/nearby
**Input:**
```json
{ "filterPrefab": "tree", "filterAction": null, "maxCount": 20 }
```
**Output:** 紧凑文本（见 5.2 的 `dst nearby` 输出格式）

#### POST /api/inventory
**Input:** `{}`
**Output:** 紧凑文本（见 5.2 的 `dst inv` 输出格式）

#### POST /api/events
**Input:**
```json
{ "since": 1, "limit": 20 }
```
**Output:** 紧凑文本（见 5.2 的 `dst events` 输出格式）

#### POST /api/do
**Input:**
```json
{
  "action": "chop",
  "targetGuid": 12345,
  "invObjectGuid": null,
  "pos": null,
  "recipe": null
}
```
**Output:**
```
✓ queued: chop #12345 (tree, 7.1m FR)
  id=cmd-001 wait~2s for DST to pick up
```

#### POST /api/queue
**Input:** `{ "action": "list" }` 或 `{ "action": "cancel" }`
**Output:** 紧凑文本（见 5.2 的 `dst queue` / `dst cancel` 输出格式）

#### POST /api/status
**Input:** `{}`
**Output:** 紧凑文本（见 5.2 的 `dst status` 输出格式）

---

## 7. 动作词汇表

所有动作映射到 DST 的 `BufferedAction`。参考 FAtiMA-DST。

### 7.1 CLI 动作命令 → 内部 action 名

CLI 做了语义化封装，比直接传 action 名更自然：

| CLI 命令 | action | 参数 | 说明 |
|---|---|---|---|
| `dst walk X Z` | walk_to | pos | 走到坐标 |
| `dst walkto GUID` | walk_to_entity | targetGuid | 走到实体旁 |
| `dst chop GUID` | chop | targetGuid | 砍树 |
| `dst mine GUID` | mine | targetGuid | 挖矿 |
| `dst pick GUID` | pick | targetGuid | 采摘 |
| `dst pickup GUID` | pickup | targetGuid | 拾取 |
| `dst harvest GUID` | harvest | targetGuid | 收获 |
| `dst dig GUID` | dig | targetGuid | 挖掘 |
| `dst hammer GUID` | hammer | targetGuid | 拆除 |
| `dst fish GUID` | fish | targetGuid | 钓鱼 |
| `dst attack GUID` | attack | targetGuid | 攻击 |
| `dst eat GUID` | eat | targetGuid | 吃 |
| `dst equip GUID` | equip | invObjectGuid | 装备 |
| `dst unequip SLOT` | unequip | targetGuid | 卸下（hands/head/body） |
| `dst drop GUID` | drop | invObjectGuid | 丢 |
| `dst build RECIPE [X Z]` | build | recipe, pos? | 建造/制作 |
| `dst cook INVGUID TARGETGUID` | cook | invObjectGuid, targetGuid | 烹饪 |
| `dst dry INVGUID TARGETGUID` | dry | invObjectGuid, targetGuid | 晾肉 |
| `dst addfuel INVGUID TARGETGUID` | addfuel | invObjectGuid, targetGuid | 加燃料 |
| `dst fertilize INVGUID TARGETGUID` | fertilize | invObjectGuid, targetGuid | 施肥 |
| `dst light GUID` | light | targetGuid | 点火 |
| `dst extinguish GUID` | extinguish | targetGuid | 灭火 |
| `dst sleep GUID` | sleep_in | targetGuid | 睡觉 |
| `dst activate GUID` | activate | targetGuid | 交互/开关 |
| `dst jumpin GUID` | jump_in | targetGuid | 跳虫洞 |
| `dst give INVGUID TARGETGUID` | give | invObjectGuid, targetGuid | 给 NPC |
| `dst store INVGUID TARGETGUID` | store | invObjectGuid, targetGuid | 存入容器 |
| `dst deploy INVGUID X Z` | deploy | invObjectGuid, pos | 部署 |
| `dst plant INVGUID TARGETGUID` | plant | invObjectGuid, targetGuid | 种植 |
| `dst heal INVGUID TARGETGUID` | heal | invObjectGuid, targetGuid | 治疗 |
| `dst sew INVGUID TARGETGUID` | sew | invObjectGuid, targetGuid | 缝补 |
| `dst mount GUID` | mount | targetGuid | 骑乘 |
| `dst rummage GUID` | rummage | targetGuid | 翻容器 |
| `dst net GUID` | net | targetGuid | 捕虫 |
| `dst checktrap GUID` | check_trap | targetGuid | 检查陷阱 |
| `dst resettrap GUID` | reset_trap | targetGuid | 重置陷阱 |
| `dst bait INVGUID TARGETGUID` | bait | invObjectGuid, targetGuid | 放诱饵 |
| `dst feed INVGUID TARGETGUID` | feed | invObjectGuid, targetGuid | 喂食 |
| `dst fill INVGUID TARGETGUID` | fill | invObjectGuid, targetGuid | 装水 |
| `dst turnon GUID` | turn_on | targetGuid | 开启 |
| `dst turnoff GUID` | turn_off | targetGuid | 关闭 |
| `dst upgrade INVGUID TARGETGUID` | upgrade | invObjectGuid, targetGuid | 升级 |
| `dst cast INVGUID TARGETGUID` | cast_spell | invObjectGuid, targetGuid | 施法 |

### 7.2 动作参数格式（内部 JSON）

CLI 转换后的内部格式：

```json
{
  "action": "chop",
  "targetGuid": 12345,
  "invObjectGuid": null,
  "pos": null,
  "recipe": null
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `action` | string | 动作名 |
| `targetGuid` | number \| null | 目标实体 GUID |
| `invObjectGuid` | number \| null | 背包物品 GUID |
| `pos` | `{x, z}` \| null | 目标坐标 |
| `recipe` | string \| null | 配方名（build 用） |

---

## 8. 状态感知详细 Schema

DST mod 上报到 Bridge Server 的 JSON 结构。Bridge Server 负责转成紧凑文本给 CLI。

### 8.1 player

```json
{
  "userid": "KU_xxx", "name": "Wilson", "prefab": "wilson",
  "health": 150, "maxHealth": 150,
  "hunger": 120, "maxHunger": 150,
  "sanity": 180, "maxSanity": 200,
  "moisture": 0, "temperature": 25,
  "isFreezing": false, "isOverheating": false,
  "pos": { "x": 120.5, "y": 0, "z": -340.2 },
  "facing": 1.57,
  "isBusy": false, "currentAction": null,
  "inLight": true, "isGhost": false
}
```

### 8.2 world

```json
{
  "cycle": 5, "phase": "day", "season": "autumn",
  "seasonProgress": 0.35, "remainingDaysInSeason": 10,
  "isRaining": false, "isSnowing": false,
  "moonPhase": "new", "isCave": false
}
```

### 8.3 nearby 实体

```json
{
  "guid": 12345, "prefab": "tree", "name": "Evergreen",
  "pos": { "x": 125, "y": 0, "z": -335 },
  "distance": 7.1, "bearing": "front-right",
  "actions": ["chop"],
  "state": { "growthStage": "tall", "isBurning": false, "isStump": false }
}
```

`bearing`: `front` / `front-left` / `front-right` / `left` / `right` / `behind` / `behind-left` / `behind-right`

`state` 因 prefab 而异：

| prefab 类型 | state 字段 |
|---|---|
| tree | growthStage (short/normal/tall), isBurning, isStump |
| plant (grass/sapling/berry) | picked, isWilted |
| rock/boulder | workedAmount, maxWork |
| animal | isSleeping, isFleeing, health |
| monster | health, isAttacking, targetIsPlayer |
| building | isOn, fuelLevel, fuelMax (if fueled) |
| container | isOpen, isFull |
| food | freshness (0-1), isSpoiled |
| item (ground) | stackSize, freshness |

### 8.4 inventory

```json
[
  { "slot": 1, "guid": 12350, "prefab": "axe", "name": "Axe",
    "stackSize": 1, "equipSlot": "hands", "uses": 80, "maxUses": 100,
    "freshness": null, "isSpoiled": false }
]
```

### 8.5 equipped

```json
{
  "hands": { "prefab": "axe", "name": "Axe", "uses": 80 },
  "head": null, "body": null
}
```

### 8.6 recipes

只返回可建造 + 接近可建造的：

```json
[
  { "recipe": "campfire", "name": "Campfire", "canBuild": true,
    "ingredients": [{ "item": "log", "need": 2, "have": 15 }] },
  { "recipe": "axe", "name": "Axe", "canBuild": false,
    "ingredients": [{ "item": "twigs", "need": 2, "have": 0 }] }
]
```

---

## 9. DST Mod 文件结构

```
dst-bridge/
├── modinfo.lua          # mod 元数据
├── modmain.lua          # 入口：加载模块、定时器、事件注册
├── scripts/
│   ├── perception.lua   # 感知：枚举实体、读组件、组装 JSON
│   ├── actions.lua      # 执行：命令 → BufferedAction
│   ├── events.lua       # 监听：游戏事件 → 即时上报
│   └── http.lua         # 通信：TheSim:QueryServer 封装
```

### 9.1 modinfo.lua

```lua
name = "DST Bridge"
description = "AI Bridge - lets an external AI agent play DST via CLI"
author = "royola"
version = "0.1.0"
api_version = 10

dst_compatible = true
dont_starve_compatible = false
reign_of_giants_compatible = false
all_clients_require_mod = false
client_only_mod = false

configuration_options = {
    {
        name = "bridge_url",
        label = "Bridge Server URL",
        options = { {description = "localhost:3001", data = "http://127.0.0.1:3001"} },
        default = "http://127.0.0.1:3001",
    },
    {
        name = "poll_interval",
        label = "Poll Interval (seconds)",
        options = {
            {description = "1s", data = 1}, {description = "2s", data = 2},
            {description = "3s", data = 3}, {description = "5s", data = 5},
        },
        default = 2,
    },
    {
        name = "perception_radius",
        label = "Perception Radius",
        options = { {description = "15", data = 15}, {description = "20", data = 20}, {description = "30", data = 30} },
        default = 20,
    },
    {
        name = "agent_userid",
        label = "Agent Player Userid",
        options = { {description = "auto (first player)", data = ""} },
        default = "",
    },
}
```

### 9.2 modmain.lua 核心逻辑

```lua
local _G = GLOBAL
local BRIDGE_URL = GetModConfigData("bridge_url")
local POLL_INTERVAL = GetModConfigData("poll_interval")
local PERCEPTION_RADIUS = GetModConfigData("perception_radius")

if not _G.TheNet:GetIsServer() then return end

local Perception = require("perception")
local Actions = require("actions")
local Events = require("events")
local Http = require("http")

local seq = 0
local agentPlayer = nil

local function FindAgentPlayer()
    -- 配置了 userid 找对应玩家，否则用第一个
end

local function Tick()
    if not agentPlayer then
        agentPlayer = FindAgentPlayer()
        if not agentPlayer then return end
    end

    seq = seq + 1
    local state = Perception.Snapshot(agentPlayer, PERCEPTION_RADIUS)
    state.seq = seq
    state.ts = _G.GetTime()

    Http.Post(BRIDGE_URL .. "/state", state, function()
        Http.Get(BRIDGE_URL .. "/commands", function(cmdResp)
            for _, cmd in ipairs(cmdResp.commands or {}) do
                local result = Actions.Execute(agentPlayer, cmd)
                Http.Post(BRIDGE_URL .. "/result", result)
            end
        end)
    end)
end

Events.Register(agentPlayer, BRIDGE_URL)

AddPrefabPostInit("world", function(inst)
    inst:DoPeriodicTask(POLL_INTERVAL, Tick)
end)
```

### 9.3 actions.lua 核心

```lua
local Actions = {}

local ACTION_MAP = {
    chop = _G.ACTIONS.CHOP, mine = _G.ACTIONS.MINE,
    pick = _G.ACTIONS.PICK, pickup = _G.ACTIONS.PICKUP,
    harvest = _G.ACTIONS.HARVEST, dig = _G.ACTIONS.DIG,
    hammer = _G.ACTIONS.HAMMER, attack = _G.ACTIONS.ATTACK,
    eat = _G.ACTIONS.EAT, equip = _G.ACTIONS.EQUIP,
    -- ... 完整映射见动作词汇表
}

function Actions.Execute(player, cmd)
    local action = ACTION_MAP[cmd.action]
    if not action then
        return { id = cmd.id, status = "fail", reason = "unknown_action" }
    end

    local target = cmd.targetGuid and _G.Ents[cmd.targetGuid]
    local invObject = cmd.invObjectGuid and _G.Ents[cmd.invObjectGuid]
    local pos = cmd.pos and _G.Vector3(cmd.pos.x, 0, cmd.pos.z)

    if cmd.action == "walk_to" then
        return Actions.WalkTo(player, pos, cmd.id)
    end
    if cmd.action == "build" then
        return Actions.Build(player, cmd.recipe, pos, cmd.id)
    end

    local ba = _G.BufferedAction(player, target, action, invObject, pos, cmd.recipe)
    player.components.locomotor:PushAction(ba, true)
    return { id = cmd.id, status = "ok", action = cmd.action }
end
```

---

## 10. Bridge Server 结构

### 10.1 文件布局

```
dst-bridge-server/
├── package.json
├── src/
│   ├── index.js       # 入口：HTTP server
│   ├── dstRoutes.js   # DST mod 端点 (/state, /commands, /result, /event)
│   ├── cliRoutes.js   # CLI 端点 (/api/*) — 负责格式化紧凑文本
│   ├── format.js      # JSON → 紧凑文本 格式化函数
│   ├── state.js       # 状态缓存
│   ├── queue.js       # 命令队列
│   └── config.js      # 配置
```

### 10.2 技术栈

- Node.js 18+
- 原生 `http` 模块（无需 Express，跟 Disco Engine 一样轻量）
- 无需数据库（纯内存）
- 无需 MCP SDK

### 10.3 format.js — 紧凑文本格式化（省 token 的核心）

```javascript
function formatState(state) {
  if (!state) return 'DST: NOT CONNECTED';
  const p = state.player, w = state.world;
  return [
    `HP:${p.health}/${p.maxHealth} Hgr:${p.hunger}/${p.maxHunger} San:${p.sanity}/${p.maxSanity} Temp:${p.temperature}C Wet:${p.moisture}`,
    `Day${w.cycle} ${w.season} ${w.phase}(${w.remainingDaysInSeason}/${12}) Moon:${w.moonPhase} Rain:${w.isRaining?'yes':'no'}`,
    `Pos:(${Math.round(p.pos.x)},${Math.round(p.pos.z)}) Light:${p.inLight?'yes':'no'} Busy:${p.isBusy?'yes':'no'} Ghost:${p.isGhost?'yes':'no'}`,
    `Equip:${p.equipped?.hands?.prefab||'-'} Head:${p.equipped?.head?.prefab||'-'} Body:${p.equipped?.body?.prefab||'-'}`,
    formatInventory(state.inventory),
    formatRecipes(state.recipes),
  ].join('\n');
}

function formatNearby(entities, filter) {
  let list = entities;
  if (filter?.prefab) list = list.filter(e => e.prefab === filter.prefab);
  if (filter?.action) list = list.filter(e => e.actions.includes(filter.action));
  list = list.slice(0, filter?.maxCount || 20);
  const bearingShort = { 'front':'F','front-left':'FL','front-right':'FR','left':'L','right':'R','behind':'B','behind-left':'BL','behind-right':'BR' };
  const lines = list.map(e =>
    `  #${e.guid} ${e.prefab.padEnd(10)} ${e.distance.toFixed(1)}m ${bearingShort[e.bearing]||'?'}  [${e.actions.join(',')}] ${formatEntityState(e)}`
  );
  return `Nearby[${filter?.prefab || filter?.action || 'all'}] ${list.length} found:\n` + lines.join('\n');
}

function formatInventory(inv) {
  const items = inv.map(i => {
    const uses = i.uses != null ? `(${i.uses}u)` : '';
    const stack = i.stackSize > 1 ? `x${i.stackSize}` : '';
    const fresh = i.freshness != null && i.freshness < 1 ? ` fresh:${i.freshness.toFixed(1)}` : '';
    return `  [${i.slot}] ${i.prefab.padEnd(10)} ${stack}${uses}${fresh}`;
  });
  return `Inv[${inv.length}]:\n` + items.join('\n');
}

// ... 其他格式化函数
```

### 10.4 state.js + queue.js

跟之前一样，纯内存缓存。见前版设计文档 9.3/9.4。

---

## 11. `dst` CLI 脚本

参考 Disco Engine 的 `disco` 脚本，Node.js 单文件。

```
skills/dst-bridge/
├── SKILL.md            # 教 Claude 用 dst 命令 + 饥荒生存策略
└── scripts/
    └── dst             # CLI 脚本 (Node.js, 无 shebang 依赖)
```

### 11.1 dst CLI 核心逻辑

```javascript
#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_FILE = path.join(os.homedir(), ".dst-bridge.json");
const DEFAULT_SERVER = "http://127.0.0.1:3001";

function getServer() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")); return c.server || DEFAULT_SERVER; }
  catch { return DEFAULT_SERVER; }
}

async function callApi(tool, args = {}) {
  const server = getServer();
  const res = await fetch(`${server}/api/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}

const commands = {
  async state() { console.log(await callApi("state")); },
  async nearby(args) {
    const opts = {};
    const first = args[0];
    if (first && first.startsWith("--action")) opts.filterAction = args[1];
    else if (first && !first.startsWith("-")) opts.filterPrefab = first;
    console.log(await callApi("nearby", opts));
  },
  async inv() { console.log(await callApi("inventory")); },
  async events(args) {
    const opts = {};
    if (args[0] === "--since") opts.since = parseInt(args[1]);
    console.log(await callApi("events", opts));
  },

  async chop(args) { console.log(await callApi("do", { action: "chop", targetGuid: parseInt(args[0]) })); },
  async mine(args) { console.log(await callApi("do", { action: "mine", targetGuid: parseInt(args[0]) })); },
  async pick(args) { console.log(await callApi("do", { action: "pick", targetGuid: parseInt(args[0]) })); },
  async pickup(args) { console.log(await callApi("do", { action: "pickup", targetGuid: parseInt(args[0]) })); },
  async harvest(args) { console.log(await callApi("do", { action: "harvest", targetGuid: parseInt(args[0]) })); },
  async attack(args) { console.log(await callApi("do", { action: "attack", targetGuid: parseInt(args[0]) })); },
  async eat(args) { console.log(await callApi("do", { action: "eat", targetGuid: parseInt(args[0]) })); },
  async equip(args) { console.log(await callApi("do", { action: "equip", invObjectGuid: parseInt(args[0]) })); },
  async unequip(args) { console.log(await callApi("do", { action: "unequip", targetGuid: args[0] })); },
  async drop(args) { console.log(await callApi("do", { action: "drop", invObjectGuid: parseInt(args[0]) })); },

  async build(args) {
    const recipe = args[0];
    const pos = args[1] && args[2] ? { x: parseFloat(args[1]), z: parseFloat(args[2]) } : null;
    console.log(await callApi("do", { action: "build", recipe, pos }));
  },
  async walk(args) {
    console.log(await callApi("do", { action: "walk_to", pos: { x: parseFloat(args[0]), z: parseFloat(args[1]) } }));
  },
  async walkto(args) {
    console.log(await callApi("do", { action: "walk_to_entity", targetGuid: parseInt(args[0]) }));
  },
  async cook(args) {
    console.log(await callApi("do", { action: "cook", invObjectGuid: parseInt(args[0]), targetGuid: parseInt(args[1]) }));
  },
  async addfuel(args) {
    console.log(await callApi("do", { action: "addfuel", invObjectGuid: parseInt(args[0]), targetGuid: parseInt(args[1]) }));
  },
  async sleep(args) { console.log(await callApi("do", { action: "sleep_in", targetGuid: parseInt(args[0]) })); },
  async light(args) { console.log(await callApi("do", { action: "light", targetGuid: parseInt(args[0]) })); },
  async activate(args) { console.log(await callApi("do", { action: "activate", targetGuid: parseInt(args[0]) })); },

  async cancel() { console.log(await callApi("queue", { action: "cancel" })); },
  async queue() { console.log(await callApi("queue", { action: "list" })); },
  async status() { console.log(await callApi("status")); },

  async server(args) {
    if (args[0]) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ server: args[0] }));
      console.log(`Server set to ${args[0]}`);
    } else {
      console.log(`Server: ${getServer()}`);
    }
  },

  async help() {
    console.log(`
dst — play Don't Starve Together via AI bridge

  dst state                 Current state (HP/hunger/sanity/season/pos/inventory)
  dst nearby [prefab]       Nearby entities (filter: dst nearby tree)
    --action ACTION          Filter by action: dst nearby --action chop
  dst inv                   Inventory + equipment
  dst events [--since N]    Recent events
  dst queue                 View command queue
  dst cancel                Cancel all queued + abort current action
  dst status                Bridge connection status

Actions (target by GUID from 'dst nearby'):
  dst chop GUID             dst mine GUID        dst pick GUID
  dst pickup GUID           dst harvest GUID     dst dig GUID
  dst hammer GUID           dst attack GUID      dst eat GUID
  dst equip GUID            dst unequip hands    dst drop GUID
  dst build RECIPE [X Z]    dst cook INVGUID TARGETGUID
  dst walk X Z              dst walkto GUID      dst sleep GUID
  dst addfuel INVGUID TARGETGUID
  dst light GUID            dst activate GUID    dst extinguish GUID

Setup:
  dst server [URL]          Set/get bridge server URL (default: localhost:3001)
  dst help                  This message

Server: ${getServer()}
`);
  },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { await commands.help(); return; }
  const fn = commands[cmd];
  if (!fn) { console.error(`Unknown: ${cmd}. Run 'dst help'.`); process.exit(1); }
  try { await fn(args); } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}
main();
```

---

## 12. SKILL.md — 饥荒生存策略

```markdown
---
name: dst-bridge
metadata:
  version: 0.1.0
  description: >-
    Play Don't Starve Together as an AI survivor. Gather resources, craft tools,
    build a base, survive the night, and don't starve. Use this skill whenever
    the user mentions Don't Starve Together, DST, 饥荒, or wants an AI to play
    a survival game.
---

# Don't Starve Together · 饥荒联机版

You are an AI playing Don't Starve Together. You survive by gathering resources,
crafting tools, building shelter, and making it through each night.

## How to play

The game runs locally. You interact via the `dst` CLI.

### The main loop

```bash
dst state          # read current situation
dst nearby         # see what's around you
dst chop 12345     # do something
dst state          # check what changed
```

**Read → Decide → Act → Read again.** The game is real-time, so things change
between your commands. Always check state before acting.

### Starting a new game

First days priority:
1. `dst nearby --action pick` — find grass, twigs, flint
2. `dst pick <GUID>` — gather cutgrass and twigs (need 3 grass + 3 twigs for axe)
3. `dst build axe` — craft an axe
4. `dst equip <GUID>` — equip the axe
5. `dst nearby tree` — find trees
6. `dst chop <GUID>` — chop trees for logs
7. Before dusk: `dst build campfire` — you NEED light at night

### Survival priorities (highest first)

1. **Night is coming** → you MUST have a fire before dark, or you die
   - Check `dst state` for phase. If `dusk`, build a fire NOW
   - `dst build campfire` at your current position
2. **Health < 30** → find food or healing
   - `dst nearby --action eat` or `dst nearby berries`
   - `dst eat <GUID>`
3. **Hunger > 130** → find food immediately
   - Berries, carrots, rabbits, cooked food
4. **Sanity < 30** → pick flowers, sleep, or eat cooked food
5. **Freezing** → build a fire, get warm
6. **Under attack** → fight back or run
   - `dst attack <GUID>` to fight
   - `dst walk <X> <Z>` to flee

### Day/night cycle

- **Day**: gather resources, explore, build
- **Dusk**: prepare for night — build/fuel fire, eat, craft
- **Night**: stay near fire, plan next day, cook food
- Phases show in `dst state` output: `Day5 Autumn dusk(2/12)`

### Seasons

- **Autumn** (default start): mild, do everything
- **Winter**: freezing, need warm clothes, food scarce, build thermal stone
- **Spring**: lots of rain, need raincoat/umbrella, lightning
- **Summer**: overheating, wildfires, need ice cream/thermal stone

### Key recipes (early game)

| Recipe | Materials | Priority |
|---|---|---|
| axe | 1 flint + 2 twigs | First — need to chop trees |
| pickaxe | 2 flint + 2 twigs | Second — need to mine rocks |
| campfire | 2 logs + 3 cutgrass | Every night |
| torch | 2 cutgrass + 2 logs | Emergency light |
| spear | 1 rope + 1 flint + 2 twigs | Combat |
| backpack | 4 twigs + 6 cutgrass + 1 rope | More inventory |
| science machine | 1 log + 1 gold + 4 stone | Unlock better recipes |
| rope | 3 cutgrass | Crafting material |

### Tips

- **Always check `dst state` before acting** — your situation changes in real-time
- **GUIDs change** — entities might disappear between commands, check `dst nearby` again
- **Night kills** — Charlie (the night monster) attacks in darkness. Always have light.
- **Don't starve** — keep hunger below 100. Cook food at a fire for more hunger restoration.
- **Save materials** — don't waste logs on unnecessary things early on
- **Explore** — `dst walk X Z` to move around, then `dst nearby` to find new resources

### Error handling

- `target_not_found` — entity disappeared, check `dst nearby` for fresh GUIDs
- `DST: NOT CONNECTED` — game not running or mod not loaded
- Command stuck in `executing` — action taking time (walking long distance), use `dst cancel` if needed
```

---

## 13. 安全边界

### 13.1 Bridge Server 只允许 localhost

```javascript
server.listen(3001, '127.0.0.1');
```

### 13.2 命令白名单

DST mod 只接受预定义的 action 名（ACTION_MAP），不接受任意 Lua 代码。

### 13.3 不暴露 shell

CLI 只提供结构化动作命令，不提供 `execute_lua` / `run_command` / `eval`。

### 13.4 远程访问（可选未来）

如果需要从 VPS 远程控制本地 DST：
- Tailscale / ZeroTier / SSH 隧道
- 或参考 Slay Bridge 的 relay 架构

---

## 14. 开发计划

### Phase 1: MVP — 能感知 + 能砍树 (3 天)

1. **DST Mod 基础** (1 天)
   - modinfo.lua + modmain.lua + http.lua
   - 基础感知 (player 状态 + nearby 实体)
   - 定时上报状态到 Bridge Server

2. **Bridge Server 基础** (1 天)
   - REST endpoints (POST /state, GET /commands, POST /result)
   - 状态缓存
   - /api/* 端点 + format.js 紧凑文本格式化

3. **CLI + 动作执行** (1 天)
   - dst CLI 脚本 (state, nearby, chop, walk)
   - actions.lua: chop + walk_to + pickup
   - SKILL.md
   - 端到端联调：`dst state` → `dst nearby` → `dst chop 12345`

### Phase 2: 完整动作 + 事件 (2 天)

4. **完整动作词汇表** (1 天)
   - 所有 50+ 动作
   - build / equip / eat / cook 等
   - CLI 命令完善

5. **事件系统** (1 天)
   - events.lua: 受伤/击杀/死亡/昼夜切换
   - POST /event → /api/events
   - `dst events` 命令

### Phase 3: 生存策略 + 优化 (2 天)

6. **SKILL.md 完善** (1 天)
   - 饥荒生存知识库
   - 决策循环模板
   - 自动生存策略

7. **优化** (1 天)
   - 感知半径动态调整
   - 命令队列优先级
   - 错误恢复
   - 多 player 支持

### 总计: ~1 周

---

## 15. 与 Disco Engine 的关系

| 组件 | Disco Engine | DST Bridge |
|---|---|---|
| 接口层 | REST API + MCP + CLI | **REST API + CLI** (MCP 以后加) |
| CLI 脚本 | `disco` (Node.js) | `dst` (Node.js, 同构) |
| SKILL.md | 游戏知识 + CLI 用法 | 生存策略 + CLI 用法 |
| 状态来源 | SQLite ROM | DST mod 实时感知 |
| 动作执行 | 引擎解释器 | DST BufferedAction |
| 多 player | token = playerId | userid = playerId |
| 输出格式 | 紧凑文本 | 紧凑文本（同理念） |

**未来愿景**: Disco Engine 模式成为通用"AI 玩游戏"范式 — 文字游戏用 ROM，饥荒用 DST mod，其他游戏写对应适配层。CLI + REST + SKILL.md 三件套不变，AI agent 不需要知道底层差异。

---

## 16. 已知风险和缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| DST 更新破坏 mod API | mod 不可用 | 锁定 DST 版本，mod 做版本检查 |
| TheSim:QueryServer 不稳定 | 通信中断 | 加重试 + 超时，失败不崩溃 |
| 实体 GUID 不稳定 | 命令找不到目标 | 每次状态上报刷新 GUID，命令用最新 GUID |
| LLM 决策太慢 | 角色站着不动 | 命令队列预填多个动作 |
| 角色卡住 | 无法继续 | 超时检测 + 自动 cancel + 重新感知 |
| 夜晚没火 | 角色死亡 | 事件系统 dusk 告警 + SKILL.md 强调 |
