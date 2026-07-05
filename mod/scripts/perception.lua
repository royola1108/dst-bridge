-- perception.lua — gather game state into a JSON-serializable table
-- References: FAtiMA-DST fatimabrain.lua Entity() + Perceptions()

local MathAbs = math.abs
local MathAtan2 = math.atan
local MathSqrt = math.sqrt
local MathFloor = math.floor

local Perception = {}

-- Bearing: relative direction from player to entity
-- Returns: "front", "front-left", "front-right", "left", "right", "behind", "behind-left", "behind-right"
local function CalcBearing(player, entPos)
    local px, _, pz = player.Transform:GetWorldPosition()
    local dx = entPos.x - px
    local dz = entPos.z - pz
    if dx == 0 and dz == 0 then return "front" end

    -- Player facing (rotation in degrees, 0 = facing +Z)
    local facing = player.Transform:GetRotation() or 0
    -- Convert to radians
    local facingRad = facing * 0.0174533

    -- Entity angle relative to player (in world space)
    local entAngle = MathAtan2(dx, dz)
    -- Relative angle (entity angle minus facing)
    local rel = entAngle - facingRad
    -- Normalize to 0-360
    rel = rel % 6.28318

    -- 8 sectors, each 45 degrees
    local sector = MathFloor(rel / 0.7854) + 1
    local bearings = {
        [1] = "front",       [2] = "front-right",
        [3] = "right",       [4] = "behind-right",
        [5] = "behind",      [6] = "behind-left",
        [7] = "left",        [8] = "front-left",
    }
    return bearings[sector] or "front"
end

local function CalcDistance(x1, z1, x2, z2)
    local dx = x2 - x1
    local dz = z2 - z1
    return MathSqrt(dx * dx + dz * dz)
end

-- Available actions for an entity (based on tags + components)
local function AvailableActions(ent, player)
    local actions = {}
    if ent:HasTag("CHOP_workable") then actions[#actions+1] = "chop" end
    if ent:HasTag("MINE_workable") then actions[#actions+1] = "mine" end
    if ent:HasTag("DIG_workable") then actions[#actions+1] = "dig" end
    if ent:HasTag("HAMMER_workable") then actions[#actions+1] = "hammer" end
    if ent:HasTag("pickable") then actions[#actions+1] = "pick" end
    if ent.components.inventoryitem and ent.components.inventoryitem.canbepickedup and not ent:HasTag("heavy") then
        actions[#actions+1] = "pickup"
    end
    if ent:HasTag("readyforharvest") or (ent.components.stewer and ent.components.stewer:IsDone()) then
        actions[#actions+1] = "harvest"
    end
    if ent:HasTag("BURNABLE_fueled") then actions[#actions+1] = "addfuel" end
    if ent:HasTag("BURNABLE_fuel") then actions[#actions+1] = "fuel" end
    if ent:HasTag("cooker") then actions[#actions+1] = "cook" end
    if ent:HasTag("stewer") then actions[#actions+1] = "harvest" end
    if ent:HasTag("_equippable") then actions[#actions+1] = "equip" end
    if ent:HasTag(" sleeper") then actions[#actions+1] = "sleep_in" end
    -- Combat: anything with health that's not the player
    if ent.components.health and ent ~= player and not ent:HasTag("wall") then
        actions[#actions+1] = "attack"
    end
    -- Edible
    if ent.components.edible and player.components.eater:CanEat(ent) then
        actions[#actions+1] = "eat"
    end
    -- Light/extinguish
    if ent:HasTag("canlighter") or ent:HasTag("HASCANLIGHT") then actions[#actions+1] = "light" end
    if ent:HasTag("cansmolderer") then actions[#actions+1] = "extinguish" end
    -- Activate
    if ent:HasTag("usable") or ent:HasTag("machine") or ent:HasTag("telebase") then
        actions[#actions+1] = "activate"
    end
    -- Jump in (wormholes)
    if ent:HasTag("teleporter") then actions[#actions+1] = "jump_in" end
    -- Container
    if ent.components.container then actions[#actions+1] = "rummage" end
    -- Store
    if ent.components.container and not ent:HasTag("heavy") then
        -- can store items into it
    end

    if #actions == 0 then return nil end
    return actions
end

-- Entity-specific state
local function EntityState(ent, player)
    local s = {}

    -- Tree growth
    if ent:HasTag("CHOP_workable") then
        if ent:HasTag("short") then s.growthStage = "short"
        elseif ent:HasTag("normal") then s.growthStage = "normal"
        elseif ent:HasTag("tall") then s.growthStage = "tall" end
        if ent:HasTag("burning") or ent:HasTag("fire") then s.isBurning = true end
        if ent:HasTag("stump") then s.isStump = true end
    end

    -- Plants
    if ent:HasTag("pickable") then
        if ent.components.pickable then
            s.picked = not ent.components.pickable:CanBePicked()
        end
        if ent:HasTag("wilted") then s.isWilted = true end
    end

    -- Fuel level
    if ent:HasTag("BURNABLE_fueled") and ent.components.fueled then
        s.fuelLevel = MathFloor(ent.components.fueled.currentfuel or 0)
        s.fuelMax = MathFloor(ent.components.fueled.maxfuel or 0)
    end

    -- Health (for creatures/monsters)
    if ent.components.health then
        s.health = MathFloor(ent.components.health.currenthealth)
    end

    -- Sleeping/fleeing
    if ent:HasTag("sleeping") then s.isSleeping = true end
    if ent:HasTag("scarytoprey") then s.isFleeing = true end

    -- Attacking
    if ent.components.combat and ent.components.combat.target == player then
        s.isAttacking = true
        s.targetIsPlayer = true
    end

    -- Stack size
    if ent.components.stackable then
        s.stackSize = ent.components.stackable:StackSize()
    end

    -- Freshness
    if ent.components.perishable then
        s.freshness = ent.components.perishable:GetPercent()
        if s.freshness <= 0 then s.isSpoiled = true end
    end

    -- Workable progress
    if ent.components.workable then
        s.workedAmount = ent.components.workable.workleft or 0
    end

    local count = 0
    for _ in pairs(s) do count = count + 1 end
    if count == 0 then return nil end
    return s
end

-- Gather nearby entities
function Perception.NearbyEntities(player, radius)
    local px, py, pz = player.Transform:GetWorldPosition()
    local TAGS = nil
    local EXCLUDE_TAGS = {"INLIMBO", "NOCLICK", "CLASSIFIED", "FX", "player"}
    local ONE_OF_TAGS = nil
    local ents = TheSim:FindEntities(px, py, pz, radius, TAGS, EXCLUDE_TAGS, ONE_OF_TAGS)

    local result = {}
    for _, ent in ipairs(ents) do
        if ent ~= player and not ent:HasTag("INLIMBO") then
            local ex, ey, ez = ent.Transform:GetWorldPosition()
            local dist = CalcDistance(px, pz, ex, ez)
            local actions = AvailableActions(ent, player)
            -- Include entities with actions, items, light sources, or structures
            local hasLight = ent:HasTag("campfire") or ent:HasTag("fire") or
                             ent.prefab == "campfire" or ent.prefab == "firepit" or
                             ent.prefab == "torchfire" or ent.prefab == "coldfire"
            if actions or ent.components.inventoryitem or ent:HasTag("epic") or hasLight then
                table.insert(result, {
                    guid = ent.GUID,
                    prefab = ent.prefab,
                    name = ent.name or ent.prefab,
                    pos = { x = ex, y = ey, z = ez },
                    distance = MathFloor(dist * 10) / 10,
                    bearing = CalcBearing(player, { x = ex, y = ey, z = ez }),
                    actions = actions,
                    isBoss = ent:HasTag("epic"),
                    state = EntityState(ent, player),
                })
            end
        end
    end

    -- Sort by distance
    table.sort(result, function(a, b) return a.distance < b.distance end)

    -- Limit count
    local max = 30
    if #result > max then
        for i = max + 1, #result do result[i] = nil end
    end

    return result
end

-- Player state
function Perception.PlayerState(player)
    local px, py, pz = player.Transform:GetWorldPosition()
    local health = player.components.health
    local hunger = player.components.hunger
    local sanity = player.components.sanity

    return {
        userid = player.userid or "",
        name = player.name or "",
        prefab = player.prefab or "",
        health = health and MathFloor(health.currenthealth) or 0,
        maxHealth = health and MathFloor(health.maxhealth) or 0,
        hunger = hunger and MathFloor(hunger.current) or 0,
        maxHunger = hunger and MathFloor(hunger.max) or 0,
        sanity = sanity and MathFloor(sanity.current) or 0,
        maxSanity = sanity and MathFloor(sanity.max) or 0,
        moisture = player.GetMoisture and MathFloor(player:GetMoisture()) or 0,
        temperature = player.GetTemperature and MathFloor(player:GetTemperature()) or 0,
        isFreezing = player.IsFreezing and player:IsFreezing() or false,
        isOverheating = player.IsOverheating and player:IsOverheating() or false,
        pos = { x = px, y = py, z = pz },
        facing = player.Transform:GetRotation() or 0,
        isBusy = player.sg:HasStateTag("busy") or player.sg:HasStateTag("doing") or false,
        currentAction = nil,
        inLight = player.LightWatcher and player.LightWatcher:IsInLight() or false,
        isGhost = player:HasTag("playerghost"),
    }
end

-- World state
function Perception.WorldState()
    local w = TheWorld
    local s = w.state
    return {
        cycle = s.cycles + 1,
        phase = s.phase,
        season = s.season,
        seasonProgress = s.seasonprogress,
        remainingDaysInSeason = s.remainingdaysinseason or 0,
        isRaining = w.issnowing and false or (s.israining or false),
        isSnowing = s.issnowing or false,
        moonPhase = s.moonphase,
        isCave = w:HasTag("cave") or false,
    }
end

-- Inventory
function Perception.Inventory(player)
    local result = {}
    if not player.components.inventory then return result end

    local slot = 1
    for k, item in pairs(player.components.inventory.itemslots) do
        local entry = {
            slot = slot,
            guid = item.GUID,
            prefab = item.prefab,
            name = item.name or item.prefab,
            stackSize = item.components.stackable and item.components.stackable:StackSize() or 1,
            equipSlot = nil,
            uses = nil,
            maxUses = nil,
            freshness = nil,
            isSpoiled = false,
        }
        -- Check equipped
        for eslot, eitem in pairs(player.components.inventory.equipslots) do
            if eitem == item then entry.equipSlot = eslot end
        end
        -- Durability/uses
        if item.components.finiteuses then
            entry.uses = MathFloor(item.components.finiteuses.current or 0)
            entry.maxUses = MathFloor(item.components.finiteuses.total or 0)
        end
        -- Freshness
        if item.components.perishable then
            entry.freshness = item.components.perishable:GetPercent()
            if entry.freshness <= 0 then entry.isSpoiled = true end
        end
        table.insert(result, entry)
        slot = slot + 1
    end

    return result
end

-- Equipped items
function Perception.Equipped(player)
    local result = { hands = nil, head = nil, body = nil }
    if not player.components.inventory then return result end

    for slot, item in pairs(player.components.inventory.equipslots) do
        local entry = {
            prefab = item.prefab,
            name = item.name or item.prefab,
            uses = nil,
        }
        if item.components.finiteuses then
            entry.uses = MathFloor(item.components.finiteuses:GetUses())
        end
        if slot == "hands" then result.hands = entry
        elseif slot == "head" then result.head = entry
        elseif slot == "body" then result.body = entry end
    end

    return result
end

-- Available recipes (can build + close to can build)
function Perception.Recipes(player)
    local result = {}
    if not player.components.builder then return result end

    for _, recipe in pairs(AllRecipes) do
        -- Skip tech-locked recipes for now (need science machine)
        local canBuild = player.components.builder:CanBuild(recipe.name)
        -- Only include if can build or close to it
        if canBuild then
            local ingredients = {}
            if recipe.ingredients then
                for _, ing in ipairs(recipe.ingredients) do
                    local have = player.components.inventory and
                        player.components.inventory:Has(ing.type, 1) or 0
                    -- Count total
                    local totalCount = 0
                    if player.components.inventory then
                        for _, item in pairs(player.components.inventory.itemslots) do
                            if item.prefab == ing.type then
                                totalCount = totalCount + (item.components.stackable and item.components.stackable:StackSize() or 1)
                            end
                        end
                    end
                    table.insert(ingredients, {
                        item = ing.type,
                        need = ing.amount,
                        have = totalCount,
                    })
                end
            end
            table.insert(result, {
                recipe = recipe.name,
                name = recipe.name,
                canBuild = canBuild,
                ingredients = ingredients,
            })
            if #result >= 15 then break end
        end
    end

    return result
end

-- Full snapshot
-- Find nearby human players (for follow/awareness)
function Perception.NearbyPlayers(player, radius)
    local px, py, pz = player.Transform:GetWorldPosition()
    local result = {}
    local allPlayers = GLOBAL.AllPlayers or {}
    for _, p in pairs(allPlayers) do
        if p ~= player and not p:HasTag("dst_bridge_ai") and p.entity:IsValid() then
            local ex, ey, ez = p.Transform:GetWorldPosition()
            local dist = CalcDistance(px, pz, ex, ez)
            if dist <= radius then
                table.insert(result, {
                    name = p.name or "player",
                    prefab = p.prefab or "",
                    guid = p.GUID,
                    pos = { x = ex, y = ey, z = ez },
                    distance = MathFloor(dist * 10) / 10,
                })
            end
        end
    end
    return result
end

function Perception.Snapshot(player, radius)
    return {
        player = Perception.PlayerState(player),
        world = Perception.WorldState(),
        nearby = Perception.NearbyEntities(player, radius),
        players = Perception.NearbyPlayers(player, radius * 3),
        inventory = Perception.Inventory(player),
        equipped = Perception.Equipped(player),
        recipes = Perception.Recipes(player),
    }
end

return Perception
