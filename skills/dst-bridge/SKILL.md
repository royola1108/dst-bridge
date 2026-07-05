---
name: dst-bridge
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

### The main loop: read → decide → act → read

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
3. **Hunger < 30** → find food immediately
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
- Phases show in `dst state` output: `Day5 autumn dusk(10/12)`

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
- **Don't starve** — keep hunger above 30. Cook food at a fire for more hunger restoration.
- **Save materials** — don't waste logs on unnecessary things early on
- **Explore** — `dst walk X Z` to move around, then `dst nearby` to find new resources

### Error handling

- `target_not_found` — entity disappeared, check `dst nearby` for fresh GUIDs
- `DST: NOT CONNECTED` — game not running or mod not loaded
- Command stuck in `executing` — action taking time (walking long distance), use `dst cancel` if needed
