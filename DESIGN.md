# DST Agent Runtime — 饥荒联机版 AI 接入设计文档

> 让 AI 玩 Don't Starve Together，不需要 OCR，不需要截图识别。
> 三层架构：Claude 策略层 + DeepSeek 应变层 + Bridge 确定性执行层。
> CLI 输出紧凑文本省 token，参考 Disco Engine 模式。

---

## 1. 一句话

DST mod 做出站 HTTP 上报状态，Bridge Server 做 agent runtime（缓存状态 + 执行 macro-action + 紧急应变），Claude 通过 `dst` CLI 下高层目标，DeepSeek 在 Bridge 内部处理秒级紧急决策。

---

## 2. 三层架构

### 2.1 为什么不直接让 LLM 微操

DST 是实时游戏。如果 LLM 每 2 秒做一次 `walk → chop → pickup → check`，会有三个问题：

1. **太贵** — 每分钟 30 次调用，Claude 每次几千 token
2. **太慢** — LLM 响应 2-5 秒，角色在等待中可能被打死
3. **太碎** — LLM 不该关心"走到哪棵树旁边"，该关心"收集 20 根木头"

### 2.2 三层分工

```
Layer 3: Claude (策略层, 贵, 慢, 几分钟一次)
  "天黑前建好营地，先收集 20 木头"
  dst goal "gather logs 20"
  dst goal "build campfire"
  dst situation        ← 汇总状态 + 正在做什么 + 需要注意什么
  dst interrupt        ← 紧急叫停

Layer 2: Bridge Server (agent runtime, 本地, 毫秒级)
  ├── Macro Executor    ← 确定性行为循环：找树→装备→砍→捡→计数→达标/失败
  ├── Reflex Engine     ← 紧急事件 → 问 DeepSeek 或执行规则 → 自动应变
  ├── Command Lifecycle ← queued→leased→executing→done/fail/timeout
  ├── State Model       ← 世界状态缓存 + 新鲜度检查
  └── Event Log         ← 事件历史

Layer 2.5: DeepSeek (应变层, 便宜, 快, 秒级)
  Bridge 遇到意外/紧急 → 调 DeepSeek API → 秒回决策 → Bridge 执行
  "HP 80 被蜘蛛打，手里有斧头，附近3m有火堆，打还是跑？" → "跑向火堆"

Layer 1: DST Mod (传感器 + 执行器, Lua, 尽量傻)
  感知 → POST /tick → 拉命令 → 执行 BufferedAction → 上报结果
```

### 2.3 成本对比

| 方案 | Claude 调用 | DeepSeek 调用 | 一小时成本 |
|---|---|---|---|
| 纯 Claude 微操 | ~1800 次 | 0 | 高 |
| Claude 策略 + 纯规则应变 | ~10 次 | 0 | 最低但不灵活 |
| **Claude 策略 + DeepSeek 应变** | **~10 次** | **~60 次** | **极低** |

Claude 只管几分钟一次的高层目标，DeepSeek 补"纯规则太死板"和"Claude 太贵"之间的空档。

---

## 3. 为什么是 Skill CLI 而不是 MCP

### 3.1 Disco Engine 已验证的模式

Disco Engine 双入口：REST API + CLI（`disco` 命令）。CLI 调 REST API，SKILL.md 教 Claude 用 CLI。**Skill CLI 更省 token**，因为输出是定制紧凑文本而非 JSON。

### 3.2 Token 对比

```
# MCP 返回 JSON (~1000 tokens)
{"connected":true,"player":{"health":150,"hunger":120,...},"world":{...}}

# CLI 返回文本 (~200 tokens)
HP:150/150 Hgr:120/150 San:180/200 Day5 Autumn dusk
Nearby: tree#12345 7m R[chop] sapling#12346 3m FL[pick]
Inv: axe(x80) logx15 cutgrassx8
```

**5 倍差距**。DST 是准实时游戏，调用频繁，差距累积巨大。

### 3.3 配置成本

| | MCP | Skill CLI |
|---|---|---|
| 需要 `claude mcp add` | 是 | **否** |
| 需要 MCP server 进程 | 是 | **否** |
| Claude 发现方式 | MCP 连接 | Claude Code 读 SKILL.md 自动发现 |

MCP 以后作为可选入口加回来，MVP 阶段只做 CLI。

---

## 4. DST 的约束

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

**结论**: DST mod 只能做出站 HTTP。Bridge Server 做中间人。

---

## 5. 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Claude (策略层)                                        │
│  读 SKILL.md 学会 dst 命令，几分钟下一次目标                       │
│                                                                 │
│  dst situation          ← "你在哪，在做什么，需要注意什么"          │
│  dst goal "gather logs 20"  ← 高层目标                            │
│  dst goal "survive-night"    ← 高层目标                           │
│  dst goal "build science_machine"                              │
│  dst interrupt          ← 紧急叫停                               │
│  dst state / dst nearby  ← 低层调试 (也可以用)                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │ bash → dst CLI → POST /api/*
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Bridge Server (agent runtime, Node.js, :3002)          │
│                                                                 │
│  ├── CLI API (给 Claude, 返回紧凑文本)                            │
│  │   POST /api/situation   → 汇总状态 + 当前目标 + 进度 + 警报    │
│  │   POST /api/goal        → 接受高层目标, 分解为 macro-action    │
│  │   POST /api/interrupt   → 中断当前目标 + 清空队列              │
│  │   POST /api/state       → 低层状态快照                         │
│  │   POST /api/nearby      → 低层附近实体                         │
│  │   POST /api/inventory   → 低层背包                             │
│  │   POST /api/events      → 低层事件                             │
│  │   POST /api/status      → bridge 连接状态                      │
│  │   POST /api/queue       → 命令队列                             │
│  │   POST /api/do          → 低层直接动作 (调试用)                │
│  │                                                             │
│  ├── Macro Executor (确定性行为循环)                              │
│  │   goal "gather logs 20"                                     │
│  │     → 循环: 找最近树 → walk_to → chop → pickup → 计数          │
│  │     → 达标 20: done (通知 Claude)                             │
│  │     → 失败 (天黑/被攻击/斧头断): interrupt + 通知              │
│  │     → 中断条件检查: 夜晚来临→暂停→reflex                       │
│  │                                                             │
│  ├── Reflex Engine (紧急应变)                                    │
│  │   事件触发 (attacked/night/hunger_critical/freeze)           │
│  │     → 优先级 1: 确定性规则 (有火把→装备; 有营火→跑过去)        │
│  │     → 优先级 2: DeepSeek API (规则搞不定时)                   │
│  │     → 优先级 3: 通知 Claude (不紧急的情况)                    │
│  │                                                             │
│  ├── Command Lifecycle Manager                                  │
│  │   queued → leased → executing → done/fail/timeout            │
│  │   lease 超时自动回收 (DST mod 崩了不丢命令)                   │
│  │   stateSeq 新鲜度检查 (过旧命令拒绝)                          │
│  │                                                             │
│  ├── State Cache (in-memory)                                    │
│  │   currentState    最新一次 /tick 的状态                       │
│  │   currentGoal     当前高层目标 + 进度                         │
│  │   commandQueue    待执行低层命令                              │
│  │   eventLog        最近 100 条事件                            │
│  │   actionResults   命令执行结果                               │
│  │                                                             │
│  ├── DeepSeek Client (应变 LLM)                                 │
│  │   紧急事件 → 构造 prompt (状态+附近+背包) → 调 API → 解析动作  │
│  │   system prompt: "你是饥荒生存 AI，快速决策，输出一个 action" │
│  │                                                             │
│  └── DST Internal API (给 DST mod, 返回 JSON)                    │
│      POST /tick          ← 上传状态 + 返回待执行命令 (合并)       │
│      POST /result        ← 上报命令执行结果 (ack)                │
│      POST /event         ← 上报即时事件                          │
│      GET  /config        → 拉取配置                              │
│                                                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP (TheSim:QueryServer)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: DST Mod (Lua, 在游戏进程内, 尽量傻)                     │
│                                                                 │
│  ├── modmain.lua    入口：初始化、定时器                          │
│  ├── scripts/                                                    │
│  │   ├── perception.lua 感知：枚举实体、读组件、组装 JSON         │
│  │   ├── actions.lua    执行：命令 → BufferedAction + 完成判定    │
│  │   ├── events.lua     监听：游戏事件 → 即时上报                 │
│  │   └── http.lua       通信：TheSim:QueryServer 封装            │
│  │                                                             │
│  工作循环 (DoPeriodicTask, 每 2 秒):                             │
│    1. perception() → 组装状态 JSON                               │
│    2. POST /tick (上传状态, 同时拿回命令)                         │
│    3. 对每条命令 → lease → execute → POST /result (ack)          │
│                                                                 │
│  事件 (即时, 不等周期):                                          │
│    ListenForEvent → POST /event                                 │
└─────────────────────────────────────────────────────────────────┘
```

**数据流**:
- DST → Bridge: JSON（`POST /tick`，状态+命令合并）
- Bridge → CLI: **紧凑文本**（省 token）
- Bridge → DeepSeek: JSON prompt（紧急应变）
- Bridge → DST: JSON（命令队列，lease 模式）

---

## 6. `/tick` 协议（合并状态上报 + 命令拉取）

### 6.1 为什么合并

原来是 `POST /state` + `GET /commands` 两次 HTTP。合并成 `POST /tick` 一次完成：
- 少一次 HTTP 往返
- 状态和命令绑定同一个 seq，原子性更好
- lease 过期计算更简单

### 6.2 POST /tick

**Request (DST mod → Bridge):**
```json
{
  "seq": 42,
  "ts": 1779815359,
  "playerUserId": "KU_xxx",
  "state": {
    "player": {
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
  },
  "executingResults": [
    { "id": "cmd-038", "status": "completed", "action": "chop",
      "result": { "itemsGained": [{ "prefab": "log", "count": 2 }] } }
  ]
}
```

**Response (Bridge → DST mod):**
```json
{
  "ok": true,
  "ackSeq": 42,
  "commands": [
    {
      "id": "cmd-039",
      "action": "chop",
      "targetGuid": 12346,
      "invObjectGuid": null,
      "pos": null,
      "recipe": null,
      "leaseId": "lease-001",
      "leaseTimeoutMs": 15000,
      "stateSeq": 42
    }
  ],
  "config": {
    "pollInterval": 2.0,
    "perceptionRadius": 20
  }
}
```

如果队列空：
```json
{ "ok": true, "ackSeq": 42, "commands": [] }
```

### 6.3 playerUserId 贯穿协议

从第一天就在每个请求里带 `playerUserId`，为多玩家/多世界预留：

- `/tick` request 带 `playerUserId`
- `/api/*` 端点可选带 `playerUserId`（MVP 单玩家用默认）
- Bridge 内部按 `playerUserId` 隔离状态缓存（MVP 只有一个 slot）

---

## 7. 命令生命周期

### 7.1 状态机

```
queued ──(DST mod /tick 拉取)──→ leased ──(开始执行)──→ executing
   │                                 │                       │
   │                            (lease 超时)              (完成/失败)
   │                                 ↓                       ↓
   │                             queued/failed          done/fail
   │
   (interrupt/cancel)
   ↓
cancelled
```

### 7.2 Lease 机制

DST mod 从 `/tick` 拿到命令后，命令进入 `leased` 状态。如果 DST mod 在 `leaseTimeoutMs`（默认 15 秒）内没 `POST /result` ack，Bridge 自动将命令标记为 `timeout`（可配置自动回队列或标记失败）。

**防丢**: 如果 DST mod 崩了 / HTTP 回调失败 / 游戏 tick 中断，命令不会丢。超时后 Bridge 可以重新派发或通知上层。

### 7.3 两阶段结果

`PushAction` 只代表"动作被游戏接受"，不代表"砍完树/捡到东西"。结果分两层：

| 阶段 | 含义 | 谁设置 |
|---|---|---|
| `accepted` | DST mod 收到命令，开始执行 | DST mod 在 `/tick` 下一个周期报告 |
| `executing` | 正在执行（走向目标/砍树中） | DST mod |
| `completed` | 动作完成，附结果 | DST mod |
| `failed` | 动作失败，附原因 | DST mod |
| `timeout` | lease 超时 | Bridge |

DST mod 在 `/tick` 的 `executingResults` 字段里上报上一轮命令的状态变化。

### 7.4 stateSeq 新鲜度检查

每条命令带 `stateSeq`（基于哪个状态快照生成的）。Bridge macro-executor 生成命令时记录 seq，DST mod 执行前可选检查：如果游戏状态已经变了太多（比如目标实体已不在附近），可以拒绝执行并上报 `stale_state`。

---

## 8. Reflex Engine（紧急应变）

### 8.1 触发条件

Bridge 收到 DST mod 的 `POST /event` 后，按事件类型检查是否需要 reflex：

| 事件 | Reflex? | 紧急度 |
|---|---|---|
| `attacked` | 是 | 高 — 秒级 |
| `night` | 是 | 高 — 需要光 |
| `health_critical` (HP<30) | 是 | 高 |
| `hunger_critical` (hunger<30) | 是 | 中 |
| `freeze_warning` | 是 | 高 |
| `overheat_warning` | 是 | 高 |
| `dusk` | 规则 | 中 — 提醒 Claude |
| `killed` | 否 | 低 — 记录 |
| `death` | 特殊 | — 通知 Claude |
| `boss_nearby` | 规则 | 中 — 提醒 Claude |

### 8.2 应变决策优先级

```
事件触发
  ↓
1. 确定性规则 (即时, 0ms)
   - night + 手里有 torch → equip torch
   - night + 附近有 campfire → walk_to campfire
   - attacked + HP<30 → walk away from attacker
   - freeze + 附近有 fire → walk_to fire
   ↓ (规则搞不定)
2. DeepSeek API (快, ~1-2s)
   构造 prompt: 状态 + 附近实体 + 背包 + 事件
   "你是饥荒生存AI，1秒内决策，输出一个action JSON"
   解析回复 → 排队执行
   ↓ (DeepSeek 也搞不定或超时)
3. 通知 Claude (异步)
   记录事件 + "reflex_failed" → 等下次 dst situation 时 Claude 看到
```

### 8.3 DeepSeek Reflex Prompt 模板

```
System: 你是饥荒联机版的生存AI。你必须在1秒内做出一个动作决策。
只输出一个JSON，不要解释。格式:
{"action":"walk_to","pos":{"x":0,"z":0}}
或 {"action":"equip","invObjectGuid":12345}
或 {"action":"attack","targetGuid":12345}
或 {"action":"build","recipe":"campfire"}

User: 
紧急事件: 被蜘蛛攻击，HP 80/150
当前状态: Day3 Autumn night, 有torch(60u), 有axe(80u equip)
位置: (120,-340) 在黑暗中
附近:
  #999 spider 3m F [atk] hp:50
  #12351 campfire 5m R [addfuel] fuel:10/180
  #12352 tree 8m L [chop]
背包: logx5 cutgrassx3 twigsx2 flintx1
可选: 装备torch获得光源 / 跑向营火 / 攻击蜘蛛
```

DeepSeek 回复示例：
```json
{"action":"equip","invObjectGuid":<torch GUID>}
```

Bridge 解析后排队执行，不需要等 Claude。

### 8.4 Reflex 不阻塞 Macro

如果 macro-executor 正在执行 `goal "gather logs 20"`，reflex 触发时：
1. 暂停 macro（标记 `paused`）
2. 执行 reflex 动作
3. reflex 完成后恢复 macro（标记 `resumed`）
4. 如果 reflex 导致状态大变（如被追杀跑了很远），macro 判定是否需要中断并通知 Claude

---

## 9. Macro-Action 框架

### 9.1 内置 macro-action

| macro | 输入 | 行为循环 | 完成条件 | 中断条件 |
|---|---|---|---|---|
| `gather` | prefab, count | 找最近目标→walk→action→pickup→计数 | 达到 count | 天黑/被攻击/材料没了 |
| `survive_night` | — | 建火/加燃料/待在火旁 | 天亮 | — |
| `build` | recipe[, pos] | 检查材料→不够则 gather→够了 build | 建造完成 | 材料永远凑不齐 |
| `craft` | recipe | 同 build（便携物品） | 制作完成 | — |
| `explore` | direction | 朝方向走→定期检查 nearby | 发现新资源点 | 天黑/危险 |
| `return_to_base` | — | 走回营火/科学机器位置 | 到达 | 被阻挡 |
| `fight` | targetGuid | 走向目标→攻击→走位→重复 | 目标死亡 | HP<50 |

### 9.2 Macro Executor 核心逻辑

```javascript
class MacroExecutor {
  constructor(stateCache, cmdQueue, reflexEngine) {
    this.current = null;  // { goal, steps, stepIndex, status, progress }
  }

  start(goal) {
    this.current = { goal, status: 'running', progress: {}, steps: this.plan(goal) };
    this.executeNextStep();
  }

  executeNextStep() {
    if (!this.current || this.current.status !== 'running') return;
    const step = this.current.steps[this.current.stepIndex];
    if (!step) { this.complete('done'); return; }

    // 检查中断条件
    if (this.checkInterrupt()) { this.pause(); return; }

    // 生成低层命令
    const cmd = this.generateCommand(step);
    cmdQueue.enqueue(cmd);
    // 等命令完成后继续
    cmd.onComplete = (result) => this.onStepComplete(step, result);
  }

  onStepComplete(step, result) {
    if (result.status === 'completed') {
      this.updateProgress(step, result);
      this.current.stepIndex++;
      this.executeNextStep();
    } else if (result.status === 'failed') {
      this.handleStepFailure(step, result);
    }
  }

  pause() { this.current.status = 'paused'; }
  resume() { this.current.status = 'running'; this.executeNextStep(); }
  interrupt() { this.current = null; cmdQueue.cancelAll(); }
  complete(status) { /* 通知 Claude */ }
}
```

### 9.3 `gather logs 20` 分解示例

```
goal: gather logs 20

Step 1: check_inventory → logs: 5 → need 15 more
Step 2: check_equipped → hands: axe ✓
  (if no axe → sub-goal: craft axe → gather materials → craft → equip)
Step 3: find_nearest tree → #12345 at 7m
Step 4: walk_to #12345
Step 5: chop #12345 → logs +2 → total 7
Step 6: pickup logs on ground → total 9
Step 7: find_next tree → #12352 at 10m
Step 8: walk → chop → pickup → total 11
...
Step N: total >= 20 → done! 通知 Claude
```

如果中间天黑了 → reflex 暂停 macro → 执行 survive_night → 天亮恢复 macro。

---

## 10. `dst` CLI 命令清单

### 10.1 高层命令（给 Claude 策略层用）

```bash
dst situation              # 汇总：状态 + 正在做什么 + 进度 + 警报
dst goal "gather logs 20"  # 下目标：收集20根木头
dst goal "survive-night"   # 下目标：熬过今晚
dst goal "build science_machine"
dst interrupt              # 中断当前目标 + 清空队列
dst goals                  # 查看当前目标 + 历史
```

### 10.2 低层命令（调试/精细控制用）

```bash
dst state              # 状态快照
dst nearby             # 附近实体
dst nearby tree        # 只看树
dst nearby --action chop
dst inv                # 背包 + 装备
dst events             # 最近事件
dst events --since 5   # seq 5 之后的事件
dst chop 12345         # 直接砍
dst walk 200 -300      # 直接走
dst build campfire     # 直接建
dst equip 12350        # 直接装备
dst eat 12351          # 直接吃
dst cancel             # 清空队列
dst queue              # 查看队列
dst status             # bridge 状态
dst help               # 帮助
```

### 10.3 输出格式（紧凑文本）

#### `dst situation`
```
=== SITUATION ===
HP:150/150 Hgr:120/150 San:180/200
Day5 Autumn dusk(2/12) — NIGHT IN ~2 MIN, BUILD FIRE NOW
Pos:(120,-340) Light:yes

Goal: gather logs 20
  Progress: 12/20 logs collected
  Status: running (chopping tree #12352, 60% done)
  Next: find next tree after this one

Alerts:
  ⚠ dusk started — macro will auto-pause for survive-night when night falls
  ⚠ axe at 20% durability, will break soon

Events (last 60s):
  [killed] rabbit 30s ago
  [dusk] phase:day→dusk 10s ago
```

Claude 看 `dst situation` 就够了，不用 `dst state` + `dst nearby` + `dst events` + `dst queue` 调四遍。**一个命令拿全貌，极省 token。**

#### `dst goal "gather logs 20"`
```
✓ goal accepted: gather logs 20
  current logs: 5, need 15 more
  plan: find tree → chop → pickup → repeat
  axe equipped ✓
  starting execution...
```

#### `dst goal "survive-night"`
```
✓ goal accepted: survive-night
  phase: dusk (night in ~2 min)
  plan: build campfire → stay near fire → wait for dawn
  materials: logx5 cutgrassx8 (campfire needs logx2 cutgrassx3) ✓
  starting execution...
```

#### `dst interrupt`
```
✓ interrupted: gather logs 20 (was at 12/20)
  3 queued commands cancelled
  current action: aborted
```

#### `dst goals`
```
Goals:
  [active] gather logs 20 — running (12/20)
  [done]   craft axe — completed 3m ago
  [failed] explore north — interrupted by night (8m ago)
```

#### `dst state` (低层，同之前)
```
HP:150/150 Hgr:120/150 San:180/200 Temp:25C Wet:0
Day5 Autumn dusk(2/12) Moon:new Rain:no Snow:no
Pos:(120,-340) Light:yes Busy:yes Ghost:no
Equip:axe Hands:axe Head:- Body:-
Inv[8]: axe(80u) logx15 cutgrassx8 flintx3 twigsx2 berriesx5 torch(60u)
Recipes[can]: campfire torch
Recipes[need]: axe(+2twigs) spear(+1rope)
```

#### `dst nearby` (低层，同之前)
```
Nearby[15] r=20:
  #12345 tree     7.1m FR  [chop] tall
  #12346 sapling   3.5m FL  [pick] 
  #12347 rabbit   12.0m R   [atk,pickup] 
  #12351 campfire  2.0m F   [addfuel] fuel:45/180
```

---

## 11. REST API 协议

### 11.1 DST mod → Bridge（内部通信，JSON）

#### POST /tick

见第 6 节。合并状态上报 + 命令拉取。

#### POST /result

DST mod 上报命令最终结果（ack lease）。

**Request:**
```json
{ "id": "cmd-039", "leaseId": "lease-001", "playerUserId": "KU_xxx",
  "status": "completed", "action": "chop",
  "result": { "itemsGained": [{ "prefab": "log", "count": 2 }] } }
```

失败：
```json
{ "id": "cmd-039", "leaseId": "lease-001", "playerUserId": "KU_xxx",
  "status": "failed", "reason": "target_not_found", "message": "Entity 12346 no longer exists" }
```

**Response:**
```json
{ "ok": true }
```

#### POST /event

即时事件（不等 tick 周期）。

```json
{ "ts": 1779815359, "playerUserId": "KU_xxx",
  "kind": "attacked",
  "data": { "attackerPrefab": "hound", "damage": 20, "healthAfter": 130 } }
```

事件类型：

| kind | 触发 | data | Reflex? |
|---|---|---|---|
| `attacked` | 被攻击 | attackerPrefab, damage, healthAfter | **是** |
| `killed` | 杀死实体 | targetPrefab | 否 |
| `death` | 玩家死亡 | cause, killerPrefab | 通知 Claude |
| `respawn` | 复活 | — | 否 |
| `health_critical` | HP < 30 | health | **是** |
| `hunger_critical` | hunger < 30 | hunger | **是** |
| `sanity_low` | 理智 < 30 | sanity | 规则提醒 |
| `dusk` | 黄昏开始 | — | 规则提醒 |
| `night` | 夜晚开始 | — | **是** |
| `dawn` | 天亮 | — | 否 |
| `freeze_warning` | 开始冻结 | temperature | **是** |
| `overheat_warning` | 过热 | temperature | **是** |
| `new_recipe` | 解锁配方 | recipe | 否 |
| `boss_nearby` | boss 靠近 | bossPrefab, distance | 规则提醒 |

> **注意**: DST 中 hunger 越低越危险（0 = 饿死）。`hunger_critical` 触发条件是 `hunger < 30`，不是 `> 140`。

#### GET /config

```json
{
  "pollInterval": 2.0,
  "perceptionRadius": 20,
  "maxNearbyEntities": 30,
  "enableEvents": true,
  "leaseTimeoutMs": 15000
}
```

### 11.2 CLI → Bridge（Claude 用的 API，返回紧凑文本）

#### POST /api/situation
**Input:** `{ "playerUserId": "KU_xxx" }` (可选)
**Output:** 紧凑文本（见 10.3 的 `dst situation` 输出）

#### POST /api/goal
**Input:**
```json
{ "goal": "gather logs 20", "playerUserId": "KU_xxx" }
```
**Output:**
```
✓ goal accepted: gather logs 20
  ...
```

#### POST /api/interrupt
**Input:** `{ "playerUserId": "KU_xxx" }`
**Output:**
```
✓ interrupted: gather logs 20 (was at 12/20)
  ...
```

#### POST /api/goals
**Input:** `{ "playerUserId": "KU_xxx" }`
**Output:** 紧凑文本（见 10.3 的 `dst goals`）

#### POST /api/state, /api/nearby, /api/inventory, /api/events, /api/status, /api/queue, /api/do
同之前设计，返回紧凑文本。

---

## 12. 动作词汇表

### 12.1 CLI 低层动作命令

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
| `dst attack GUID` | attack | targetGuid | 攻击 |
| `dst eat GUID` | eat | targetGuid | 吃 |
| `dst equip GUID` | equip | invObjectGuid | 装备 |
| `dst unequip SLOT` | unequip | targetGuid | 卸下 |
| `dst drop GUID` | drop | invObjectGuid | 丢 |
| `dst build RECIPE [X Z]` | build | recipe, pos? | 建造/制作 |
| `dst cook INVGUID TARGETGUID` | cook | invObjectGuid, targetGuid | 烹饪 |
| `dst addfuel INVGUID TARGETGUID` | addfuel | invObjectGuid, targetGuid | 加燃料 |
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
| `dst fish GUID` | fish | targetGuid | 钓鱼 |
| `dst net GUID` | net | targetGuid | 捕虫 |
| `dst mount GUID` | mount | targetGuid | 骑乘 |

### 12.2 动作参数格式（内部 JSON）

```json
{
  "id": "cmd-039",
  "action": "chop",
  "targetGuid": 12345,
  "invObjectGuid": null,
  "pos": null,
  "recipe": null,
  "leaseId": "lease-001",
  "leaseTimeoutMs": 15000,
  "stateSeq": 42
}
```

---

## 13. 状态感知 Schema

（同之前设计，略缩——完整 schema 见 Git 历史）

### player
```json
{ "userid":"KU_xxx", "name":"Wilson", "prefab":"wilson",
  "health":150, "maxHealth":150, "hunger":120, "maxHunger":150,
  "sanity":180, "maxSanity":200, "moisture":0, "temperature":25,
  "isFreezing":false, "isOverheating":false,
  "pos":{"x":120.5,"y":0,"z":-340.2}, "facing":1.57,
  "isBusy":false, "currentAction":null,
  "inLight":true, "isGhost":false }
```

### world
```json
{ "cycle":5, "phase":"day", "season":"autumn",
  "seasonProgress":0.35, "remainingDaysInSeason":10,
  "isRaining":false, "isSnowing":false,
  "moonPhase":"new", "isCave":false }
```

### nearby 实体
```json
{ "guid":12345, "prefab":"tree", "name":"Evergreen",
  "pos":{"x":125,"y":0,"z":-335},
  "distance":7.1, "bearing":"front-right",
  "actions":["chop"],
  "state":{"growthStage":"tall","isBurning":false,"isStump":false} }
```

`state` 因 prefab 而异：

| prefab 类型 | state 字段 |
|---|---|
| tree | growthStage, isBurning, isStump |
| plant | picked, isWilted |
| rock | workedAmount, maxWork |
| animal | isSleeping, isFleeing, health |
| monster | health, isAttacking, targetIsPlayer |
| building | isOn, fuelLevel, fuelMax |
| food | freshness (0-1), isSpoiled |

---

## 14. DST Mod 文件结构

```
dst-bridge/
├── modinfo.lua
├── modmain.lua
├── scripts/
│   ├── perception.lua
│   ├── actions.lua
│   ├── events.lua
│   └── http.lua
```

### 14.1 modmain.lua 核心逻辑（修正版）

```lua
local _G = GLOBAL
local BRIDGE_URL = GetModConfigData("bridge_url")
local POLL_INTERVAL = GetModConfigData("poll_interval")
local PERCEPTION_RADIUS = GetModConfigData("perception_radius")
local AGENT_USERID = GetModConfigData("agent_userid")

if not _G.TheNet:GetIsServer() then return end

local Perception = require("perception")
local Actions = require("actions")
local Events = require("events")
local Http = require("http")

local seq = 0
local agentPlayer = nil
local eventsRegistered = false

local function FindAgentPlayer()
    if AGENT_USERID ~= "" then
        for _, v in ipairs(_G.TheNet:GetClientTable()) do
            if v.userid == AGENT_USERID then
                return _G.ThePlayer or nil  -- 需要通过 userid 找实体
            end
        end
    end
    -- 默认用第一个玩家
    for _, v in ipairs(_G.TheNet:GetClientTable()) do
        return v.userid
    end
end

local function Tick()
    if not agentPlayer then
        agentPlayer = FindAgentPlayer()
        if not agentPlayer then return end
        -- ⬇ 修正: 找到玩家后才注册事件
        if not eventsRegistered then
            Events.Register(agentPlayer, BRIDGE_URL)
            eventsRegistered = true
        end
    end

    seq = seq + 1
    local state = Perception.Snapshot(agentPlayer, PERCEPTION_RADIUS)
    local tickData = {
        seq = seq,
        ts = _G.GetTime(),
        playerUserId = agentPlayer.userid,
        state = state,
        executingResults = Actions.GetPendingResults(),
    }

    -- 合并: 上传状态 + 拿命令 (一次 HTTP)
    Http.Post(BRIDGE_URL .. "/tick", tickData, function(resp)
        for _, cmd in ipairs(resp.commands or {}) do
            Actions.Execute(agentPlayer, cmd)  -- lease → execute
        end
    end)
end

AddPrefabPostInit("world", function(inst)
    inst:DoPeriodicTask(POLL_INTERVAL, Tick)
end)
```

> **修正**: `Events.Register` 移到 `FindAgentPlayer()` 成功之后，不再在 agentPlayer 为 nil 时注册。

### 14.2 actions.lua 核心逻辑（修正版）

```lua
local Actions = {}
local ACTION_MAP = {
    chop = _G.ACTIONS.CHOP, mine = _G.ACTIONS.MINE,
    pick = _G.ACTIONS.PICK, pickup = _G.ACTIONS.PICKUP,
    harvest = _G.ACTIONS.HARVEST, dig = _G.ACTIONS.DIG,
    attack = _G.ACTIONS.ATTACK, eat = _G.ACTIONS.EAT,
    equip = _G.ACTIONS.EQUIP, build = _G.ACTIONS.BUILD,
    -- ... 完整映射
}

local pendingResults = {}

function Actions.Execute(player, cmd)
    local action = ACTION_MAP[cmd.action]
    if not action then
        Actions.ReportResult(cmd, "failed", "unknown_action")
        return
    end

    local target = cmd.targetGuid and _G.Ents[cmd.targetGuid]
    local invObject = cmd.invObjectGuid and _G.Ents[cmd.invObjectGuid]
    local pos = cmd.pos and _G.Vector3(cmd.pos.x, 0, cmd.pos.z)

    if cmd.targetGuid and not target then
        Actions.ReportResult(cmd, "failed", "target_not_found")
        return
    end

    -- 特殊处理
    if cmd.action == "walk_to" then
        Actions.WalkTo(player, pos, cmd)
        return
    end
    if cmd.action == "build" then
        Actions.Build(player, cmd.recipe, pos, cmd)
        return
    end

    -- 通用 BufferedAction
    local ba = _G.BufferedAction(player, target, action, invObject, pos, cmd.recipe)

    -- ⬇ 修正: 只报 accepted, 不报 completed
    -- completed/failed 在动作真正结束后的回调里报
    player.components.locomotor:PushAction(ba, true)

    -- 记录待跟踪的命令
    table.insert(pendingResults, {
        id = cmd.id,
        leaseId = cmd.leaseId,
        action = cmd.action,
        status = "accepted",
        startTime = _G.GetTime(),
    })

    -- 监听动作完成 (通过 stategraph 事件或定时检查)
    player:DoTaskInTime(0.5, function()
        Actions.CheckCompletion(player, cmd)
    end)
end

function Actions.ReportResult(cmd, status, reason, result)
    -- 在下一个 tick 的 executingResults 里带上
    table.insert(pendingResults, {
        id = cmd.id,
        leaseId = cmd.leaseId,
        status = status,
        reason = reason,
        result = result,
    })
end

function Actions.GetPendingResults()
    local results = pendingResults
    pendingResults = {}
    return results
end

function Actions.CheckCompletion(player, cmd)
    -- 检查玩家是否还在执行这个动作
    -- 如果 isBusy=false 且动作相关状态变了 → completed
    -- 超时检查 → 如果超过 leaseTimeoutMs → timeout
    -- 这部分需要根据 DST 的 stategraph 具体实现
end
```

> **修正**: `PushAction` 后不再直接返回 `ok`，而是跟踪动作直到 `completed`/`failed`，通过下一个 tick 的 `executingResults` 上报。

---

## 15. Bridge Server 结构

### 15.1 文件布局

```
dst-bridge-server/
├── package.json
├── src/
│   ├── index.js         # 入口：HTTP server
│   ├── dstRoutes.js     # DST mod 端点 (/tick, /result, /event, /config)
│   ├── cliRoutes.js     # CLI 端点 (/api/*) — 紧凑文本
│   ├── format.js        # JSON → 紧凑文本
│   ├── state.js         # 状态缓存 (按 playerUserId 隔离)
│   ├── queue.js         # 命令队列 + lease 生命周期
│   ├── macro.js         # Macro Executor
│   ├── reflex.js        # Reflex Engine + DeepSeek 调用
│   ├── deepseek.js      # DeepSeek API 客户端
│   └── config.js        # 配置
```

### 15.2 技术栈

- Node.js 18+
- 原生 `http` 模块
- DeepSeek API（`fetch` 调用，无需额外 SDK）
- 无需数据库（纯内存）
- 无需 MCP SDK

### 15.3 queue.js — 命令生命周期

```javascript
class CommandQueue {
  constructor() {
    this.commands = new Map();  // id → command + state
    this.order = [];            // queued 命令的执行顺序
    this.leases = new Map();    // leaseId → commandId
    this.maxSize = 32;
    this.leaseTimeoutMs = 15000;
  }

  enqueue(command) {
    if (this.order.length >= this.maxSize) throw new Error('Queue full');
    const cmd = { ...command, status: 'queued', enqueuedAt: Date.now() };
    this.commands.set(cmd.id, cmd);
    this.order.push(cmd.id);
    return cmd.id;
  }

  // DST mod /tick 拉取: lease 一批命令
  leaseBatch(maxCount) {
    const leased = [];
    for (const id of this.order.splice(0, maxCount)) {
      const cmd = this.commands.get(id);
      if (cmd) {
        cmd.status = 'leased';
        cmd.leaseId = 'lease-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        cmd.leasedAt = Date.now();
        cmd.leaseTimeoutMs = this.leaseTimeoutMs;
        this.leases.set(cmd.leaseId, id);
        leased.push(cmd);
      }
    }
    return leased;
  }

  // DST mod /result: ack 结果
  ack(commandId, leaseId, status, reason, result) {
    const cmd = this.commands.get(commandId);
    if (!cmd) return;
    cmd.status = status;  // completed / failed
    cmd.reason = reason;
    cmd.result = result;
    cmd.completedAt = Date.now();
    this.leases.delete(leaseId);
    // 通知 macro executor
    if (cmd.onComplete) cmd.onComplete(cmd);
  }

  // 定时检查 lease 超时
  checkTimeouts() {
    const now = Date.now();
    for (const [leaseId, cmdId] of this.leases) {
      const cmd = this.commands.get(cmdId);
      if (cmd && now - cmd.leasedAt > cmd.leaseTimeoutMs) {
        cmd.status = 'timeout';
        this.leases.delete(leaseId);
        if (cmd.onComplete) cmd.onComplete(cmd);
        // 可选: 重新入队
      }
    }
  }

  cancelAll() {
    const cancelled = [];
    for (const id of this.order) {
      const cmd = this.commands.get(id);
      if (cmd) { cmd.status = 'cancelled'; cancelled.push(id); }
    }
    this.order = [];
    return cancelled;
  }

  getQueueInfo() {
    return [...this.commands.values()]
      .filter(c => ['queued','leased','executing'].includes(c.status))
      .map(c => ({ id: c.id, action: c.action, status: c.status }));
  }
}
```

### 15.4 reflex.js — Reflex Engine

```javascript
const { callDeepSeek } = require('./deepseek');

class ReflexEngine {
  constructor(stateCache, cmdQueue, macroExecutor) {
    this.stateCache = stateCache;
    this.cmdQueue = cmdQueue;
    this.macro = macroExecutor;
    this.reflexLog = [];
  }

  async handleEvent(event) {
    const rules = this.matchRules(event);
    if (rules.deterministic) {
      // 优先级 1: 确定性规则
      for (const cmd of rules.deterministic) {
        this.cmdQueue.enqueue(cmd);
      }
      this.log(event.kind, 'rule', rules.deterministic);
    } else if (rules.needLLM) {
      // 优先级 2: DeepSeek
      this.macro.pause();
      try {
        const action = await callDeepSeek(this.buildPrompt(event));
        if (action) {
          this.cmdQueue.enqueue(action);
          this.log(event.kind, 'deepseek', action);
        }
      } catch (e) {
        this.log(event.kind, 'deepseek_failed', e.message);
      }
      this.macro.resume();
    } else {
      // 优先级 3: 只记录, 等下次 situation 时 Claude 看到
      this.log(event.kind, 'notified', null);
    }
  }

  matchRules(event) {
    const s = this.stateCache.current;
    if (!s) return {};

    switch (event.kind) {
      case 'night':
        // 有 torch → equip
        const torch = s.inventory?.find(i => i.prefab === 'torch');
        if (torch) return { deterministic: [{ action: 'equip', invObjectGuid: torch.guid }] };
        // 附近有 campfire → walk to it
        const fire = s.nearby?.find(e => e.prefab === 'campfire');
        if (fire) return { deterministic: [{ action: 'walk_to_entity', targetGuid: fire.guid }] };
        // 都没有 → 需要 DeepSeek
        return { needLLM: true };

      case 'attacked':
        if (s.player.health < 30) {
          // HP 低 → 逃跑
          return { needLLM: true };  // 需要判断往哪跑
        }
        return { needLLM: true };  // 让 DeepSeek 决定打还是跑

      case 'hunger_critical':
        const food = s.inventory?.find(i => i.actions?.includes('eat'));
        if (food) return { deterministic: [{ action: 'eat', targetGuid: food.guid }] };
        return { needLLM: true };

      case 'freeze_warning':
        const heat = s.nearby?.find(e => e.prefab === 'campfire' || e.prefab === 'firepit');
        if (heat) return { deterministic: [{ action: 'walk_to_entity', targetGuid: heat.guid }] };
        return { needLLM: true };

      default:
        return {};
    }
  }

  buildPrompt(event) {
    const s = this.stateCache.current;
    return {
      system: '你是饥荒联机版的生存AI。1秒内做出一个动作决策。只输出JSON。',
      user: `事件: ${event.kind} ${JSON.stringify(event.data)}\n状态: ${JSON.stringify(s.player)}\n附近: ${JSON.stringify(s.nearby?.slice(0, 5))}\n背包: ${JSON.stringify(s.inventory)}`,
    };
  }

  log(kind, source, data) {
    this.reflexLog.push({ ts: Date.now(), kind, source, data });
  }
}
```

### 15.5 deepseek.js

```javascript
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

async function callDeepSeek({ system, user }) {
  if (!DEEPSEEK_KEY) return null;  // 没配置 key 就跳过
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 200,
      temperature: 0.3,
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  // 尝试解析 JSON action
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { callDeepSeek };
```

### 15.6 format.js — 紧凑文本（省 token 核心）

```javascript
function formatSituation(state, goal, events, alerts) {
  if (!state) return 'DST: NOT CONNECTED';
  const p = state.player, w = state.world;
  const lines = [
    '=== SITUATION ===',
    `HP:${p.health}/${p.maxHealth} Hgr:${p.hunger}/${p.maxHunger} San:${p.sanity}/${p.maxSanity}`,
    `Day${w.cycle} ${w.season} ${w.phase}(${w.remainingDaysInSeason}/12)${alerts.phaseWarning || ''}`,
    `Pos:(${Math.round(p.pos.x)},${Math.round(p.pos.z)}) Light:${p.inLight?'yes':'no'}`,
  ];
  if (goal) {
    lines.push('', `Goal: ${goal.name}`, `  Progress: ${goal.progress}`, `  Status: ${goal.status}`);
  }
  if (alerts.items.length) {
    lines.push('', 'Alerts:');
    alerts.items.forEach(a => lines.push(`  ${a}`));
  }
  if (events.length) {
    lines.push('', `Events (last 60s):`);
    events.forEach(e => lines.push(`  [${e.kind}] ${e.summary}`));
  }
  return lines.join('\n');
}

// ... formatState, formatNearby, formatInventory 同之前
```

---

## 16. `dst` CLI 脚本

```
skills/dst-bridge/
├── SKILL.md
└── scripts/
    └── dst
```

### 16.1 CLI 高层命令

```javascript
// 在之前 CLI 基础上新增高层命令

async situation() {
  console.log(await callApi("situation", {}));
},

async goal(args) {
  const goalText = args.join(' ');
  console.log(await callApi("goal", { goal: goalText }));
},

async interrupt() {
  console.log(await callApi("interrupt", {}));
},

async goals() {
  console.log(await callApi("goals", {}));
},
```

---

## 17. SKILL.md — 饥荒生存策略

```markdown
---
name: dst-bridge
metadata:
  version: 0.2.0
  description: >-
    Play Don't Starve Together as an AI survivor. Give high-level goals via
    `dst goal`, check situation via `dst situation`, let the bridge handle
    micro-execution and emergency reflexes. Use when the user mentions
    Don't Starve Together, DST, 饥荒, or wants AI to play a survival game.
---

# Don't Starve Together · 饥荒联机版

You are an AI playing Don't Starve Together. You give high-level goals;
the bridge server handles micro-execution (walking, chopping, picking up)
and emergency reflexes (night, attacks, low health).

## How to play

### The main loop: situation → goal → wait → situation

```bash
dst situation              # what's happening? what should I worry about?
dst goal "gather logs 20"  # give a goal
dst situation              # check progress + new alerts
dst goal "build campfire"  # next goal
```

You DON'T need to micromanage. The bridge handles:
- Finding the nearest tree, walking to it, chopping, picking up logs
- Equipping tools automatically
- Emergency actions at night / under attack (via DeepSeek reflex)

You DO need to decide:
- What to gather and in what order
- When to build vs explore
- Whether to fight or flee (for non-emergencies)
- Long-term strategy (seasons, base location, tech tree)

### High-level commands

```bash
dst situation              # Full picture: state + current goal + alerts
dst goal "gather logs 20"  # Collect 20 logs (auto: find→chop→pickup→count)
dst goal "gather twigs 10"
dst goal "gather flint 5"
dst goal "gather grass 15"
dst goal "craft axe"       # Make an axe (auto: check mats→gather→craft)
dst goal "build campfire"  # Build campfire at current position
dst goal "build science_machine"
dst goal "survive-night"   # Stay alive until dawn
dst goal "explore north"   # Walk north, report what you find
dst interrupt              # Stop current goal, cancel all actions
dst goals                  # See current + past goals
```

### Low-level commands (for debugging)

```bash
dst state                  # Raw state snapshot
dst nearby                 # What's around me
dst nearby tree            # Just trees
dst inv                    # Inventory
dst events                 # Recent events
dst chop 12345             # Direct action by GUID
dst walk 200 -300          # Walk to coordinates
dst cancel                 # Clear command queue
```

### Starting a new game (first 5 days)

```bash
# Day 1: basics
dst goal "gather grass 15"     # need grass for everything
dst goal "gather twigs 10"     # need twigs for tools
dst goal "gather flint 5"      # need flint for tools
dst goal "craft axe"           # first tool!
dst goal "gather logs 20"      # wood for building
dst goal "build campfire"      # SURVIVE THE NIGHT

# Day 2-3: science + tools
dst goal "craft pickaxe"       # mine rocks
dst goal "gather rocks 15"
dst goal "gather gold 5"       # need gold for science machine
dst goal "build science_machine"  # unlock better recipes
dst goal "craft spear"         # weapon
dst goal "craft backpack"      # more inventory space

# Day 4-5: base
dst goal "build firepit"       # permanent fire
dst goal "gather logs 30"      # stockpile
dst goal "explore north"       # find resources
```

### Survival priorities

1. **Night is coming** → bridge auto-handles emergency light, but you should
   plan ahead. If `dst situation` shows dusk, make sure you have a goal to
   build/be near fire.
2. **Health < 30** → bridge reflex will try to help, but you should
   `dst goal "gather food"` or find healing items
3. **Hunger < 30** → eat food! `dst situation` will warn you
4. **Sanity < 30** → pick flowers, sleep, eat cooked food
5. **Season change coming** → prepare (winter = warm clothes, summer = cooling)

### Day/night cycle

- **Day**: gather, explore, build
- **Dusk**: bridge will warn you — start wrapping up
- **Night**: bridge reflex activates (auto light/fire). You plan next day.
- `dst situation` shows phase + time warning

### Seasons

- **Autumn** (start): mild, do everything
- **Winter**: freezing, food scarce — `dst goal "craft winterhat"`, stockpile food
- **Spring**: rain — `dst goal "craft rainhat"`, watch for lightning
- **Summer**: heat — stay near cooling sources, watch for wildfires

### Tips

- **Use `dst situation` as your main command** — it gives you everything in one call
- **Give goals, not micro-commands** — `dst goal "gather logs 20"` not 20x `dst chop`
- **Check situation after each goal completes** — things change in real-time
- **Trust the reflex engine** — if you're attacked at night, bridge handles it
- **Interrupt when needed** — `dst interrupt` if a goal is going badly
- **GUIDs are for low-level commands only** — goals handle targeting automatically

### Error handling

- `goal failed: no trees nearby` → explore first: `dst goal "explore north"`
- `goal interrupted: night fell` → bridge auto-paused, will resume at dawn or you can `dst goal "survive-night"`
- `DST: NOT CONNECTED` → game not running or mod not loaded
```

---

## 18. 安全边界

### 18.1 Bridge Server 只允许 localhost

```javascript
server.listen(3002, '127.0.0.1');
```

### 18.2 命令白名单

DST mod 只接受 ACTION_MAP 里的 action 名，不接受任意 Lua。

### 18.3 不暴露 shell

CLI 只提供结构化动作/goal，不提供 `execute_lua` / `eval`。

### 18.4 DeepSeek API Key 安全

```bash
# 通过环境变量传入，不写进代码
DEEPSEEK_API_KEY=sk-xxx node src/index.js
```

### 18.5 远程访问（可选）

Tailscale / SSH 隧道，不直接暴露端口。

---

## 19. 开发计划

### Phase 1: 低层闭环 — 感知 + 执行 + CLI (3 天)

**目标**: `dst state` → `dst nearby` → `dst chop 12345` 能跑通

1. **DST Mod** (1.5 天)
   - modinfo.lua + modmain.lua + http.lua
   - perception.lua: player 状态 + nearby 实体
   - POST /tick 上报状态
   - actions.lua: chop + walk_to + pickup (带 lease + 两阶段结果)
   - events.lua: 基础事件 (attacked/dusk/night)

2. **Bridge Server** (1 天)
   - POST /tick + POST /result + POST /event
   - state.js 状态缓存
   - queue.js 命令队列 + lease 生命周期
   - /api/* 端点 + format.js 紧凑文本
   - lease 超时检查

3. **CLI + SKILL.md** (0.5 天)
   - dst CLI: state, nearby, inv, events, chop, walk, build, cancel, status
   - SKILL.md 基础版

### Phase 2: Macro-Action + 高层命令 (2 天)

4. **Macro Executor** (1 天)
   - macro.js: goal → plan → step → execute → track → complete
   - 内置 macro: gather, craft, build, survive_night
   - /api/goal, /api/situation, /api/interrupt
   - CLI: dst goal, dst situation, dst interrupt, dst goals

5. **完善低层动作** (1 天)
   - 补全 30+ 动作映射
   - actions.lua 完成判定 (stategraph 检查)
   - 错误恢复 (卡住/目标消失)

### Phase 3: Reflex Engine + DeepSeek (2 天)

6. **Reflex Engine** (1 天)
   - reflex.js: 事件匹配 → 确定性规则 → DeepSeek → 通知
   - deepseek.js: API 客户端
   - 紧急规则: night/attacked/hunger_critical/freeze
   - macro 暂停/恢复联动

7. **联调 + 优化** (1 天)
   - 端到端: Claude → dst goal → macro → reflex → DST
   - SKILL.md 完善 (生存策略知识库)
   - 感知半径动态调整
   - playerUserId 多玩家预留

### 总计: ~1 周

> MVP 优先级：**先低层闭环（Phase 1），再高层目标（Phase 2），最后应变（Phase 3）**。
> Phase 1 结束就能 `dst chop` 砍树。Phase 2 结束就能 `dst goal "gather logs 20"`。Phase 3 结束夜里不怕死。

---

## 20. 与 Disco Engine 的关系

| 组件 | Disco Engine | DST Agent Runtime |
|---|---|---|
| 定位 | 文字游戏引擎 | **实时游戏 agent runtime** |
| 接口层 | REST + MCP + CLI | REST + CLI (MCP 以后加) |
| CLI | `disco` | `dst` (同构) |
| SKILL.md | 游戏知识 + CLI 用法 | 生存策略 + CLI 用法 |
| 状态来源 | SQLite ROM | DST mod 实时感知 |
| 动作执行 | 引擎解释器 | DST BufferedAction |
| 决策层 | LLM 直接操作 | **LLM 策略 + DeepSeek 应变 + 确定性执行** |
| 输出格式 | 紧凑文本 | 紧凑文本 |

**未来愿景**: "AI 玩游戏"通用范式 — CLI + REST + SKILL.md 不变，各游戏写适配层。DST 是第一个实时游戏适配，验证三层架构（策略/应变/执行）。

---

## 21. 已知风险和缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| DST 更新破坏 mod API | mod 不可用 | 锁定版本，mod 做版本检查 |
| TheSim:QueryServer 不稳定 | 通信中断 | 重试 + 超时，失败不崩溃 |
| 实体 GUID 不稳定 | 命令找不到目标 | stateSeq 新鲜度检查，macro 自动重新找目标 |
| LLM 决策太慢 | 角色站着不动 | macro-action 预填队列，reflex 秒级应变 |
| 角色卡住 | 无法继续 | lease 超时 + 自动 cancel + macro 重新规划 |
| 夜晚没火 | 角色死亡 | reflex night 事件 → 自动找火/装备火把 |
| DeepSeek API 不可用 | reflex 降级 | 回退到确定性规则，通知 Claude |
| VPS 内存不够 | OOM | 1GB swap 已加，不开洞穴，最小世界 |
| 命令丢了 | 动作没执行 | lease 机制 + 超时回收 + stateSeq 检查 |
