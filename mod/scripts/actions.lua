-- actions.lua — command → BufferedAction execution + completion tracking
-- References: FAtiMA-DST fatimabrain.lua BufferedAction + AddFailAction/AddSuccessAction

local ACTIONS = ACTIONS
local BufferedAction = BufferedAction
local Ents = Ents
local Vector3 = Vector3

local Actions = {}

-- Action name → DST ACTIONS constant
local ACTION_MAP = {
    chop = ACTIONS.CHOP,
    mine = ACTIONS.MINE,
    pick = ACTIONS.PICK,
    pickup = ACTIONS.PICKUP,
    harvest = ACTIONS.HARVEST,
    dig = ACTIONS.DIG,
    hammer = ACTIONS.HAMMER,
    attack = ACTIONS.ATTACK,
    eat = ACTIONS.EAT,
    equip = ACTIONS.EQUIP,
    unequip = ACTIONS.UNEQUIP,
    drop = ACTIONS.DROP,
    cook = ACTIONS.COOK,
    dry = ACTIONS.DRY,
    addfuel = ACTIONS.ADDFUEL,
    fertilize = ACTIONS.FERTILIZE,
    bait = ACTIONS.BAIT,
    deploy = ACTIONS.DEPLOY,
    plant = ACTIONS.PLANT,
    light = ACTIONS.LIGHT,
    extinguish = ACTIONS.EXTINGUISH,
    sleep_in = ACTIONS.SLEEPIN,
    jump_in = ACTIONS.JUMPIN,
    activate = ACTIONS.ACTIVATE,
    give = ACTIONS.GIVE,
    store = ACTIONS.STORE,
    fish = ACTIONS.FISH,
    net = ACTIONS.NET,
    check_trap = ACTIONS.CHECKTRAP,
    reset_trap = ACTIONS.RESETMINE,
    mount = ACTIONS.MOUNT,
    saddle = ACTIONS.SADDLE,
    unsaddle = ACTIONS.UNSADDLE,
    shave = ACTIONS.SHAVE,
    sew = ACTIONS.SEW,
    heal = ACTIONS.HEAL,
    cast_spell = ACTIONS.CASTSPELL,
    rummage = ACTIONS.RUMMAGE,
    turn_on = ACTIONS.TURNON,
    turn_off = ACTIONS.TURNOFF,
    fill = ACTIONS.FILL,
    feed = ACTIONS.FEED,
    feed_player = ACTIONS.FEEDPLAYER,
    upgrade = ACTIONS.UPGRADE,
    smother = ACTIONS.SMOTHER,
    look_at = ACTIONS.LOOKAT,
    terramorph = ACTIONS.TERRAFORM,
    take_item = ACTIONS.TAKEITEM,
    murder = ACTIONS.MURDER,
    combine_stack = ACTIONS.COMBINESTACK,
}

-- Pending results to report on next tick
local pendingResults = {}

local function ReportResult(cmd, status, reason, result)
    table.insert(pendingResults, {
        id = cmd.id,
        leaseId = cmd.leaseId,
        status = status,
        reason = reason,
        result = result,
    })
end

-- Walk to a position
function Actions.WalkTo(player, pos, cmd)
    if not pos then
        ReportResult(cmd, "failed", "no_position")
        return
    end
    player.components.locomotor:GoToPoint(Vector3(pos.x, 0, pos.z), nil, true)
    ReportResult(cmd, "accepted")
    -- Track completion via distance check
    player:DoTaskInTime(0.5, function()
        local px, _, pz = player.Transform:GetWorldPosition()
        local dx = px - pos.x
        local dz = pz - pos.z
        local dist = math.sqrt(dx * dx + dz * dz)
        if dist < 3 then
            ReportResult(cmd, "completed", nil, { finalPos = { x = px, z = pz } })
        else
            -- Still walking, check again
            player:DoTaskInTime(1, function()
                local px2, _, pz2 = player.Transform:GetWorldPosition()
                local dx2 = px2 - pos.x
                local dz2 = pz2 - pos.z
                if math.sqrt(dx2 * dx2 + dz2 * dz2) < 3 then
                    ReportResult(cmd, "completed", nil, { finalPos = { x = px2, z = pz2 } })
                else
                    ReportResult(cmd, "completed", nil, { finalPos = { x = px2, z = pz2 } })
                end
            end)
        end
    end)
end

-- Build / craft
function Actions.Build(player, recipeName, pos, cmd)
    if not recipeName then
        ReportResult(cmd, "failed", "no_recipe")
        return
    end

    local recipe = AllRecipes[recipeName]
    if not recipe then
        ReportResult(cmd, "failed", "unknown_recipe", { recipe = recipeName })
        return
    end

    if not player.components.builder then
        ReportResult(cmd, "failed", "no_builder_component")
        return
    end

    -- Check if can build
    if not player.components.builder:CanBuild(recipeName) then
        ReportResult(cmd, "failed", "missing_ingredients")
        return
    end

    -- Do the build
    local ba = BufferedAction(player, nil, ACTIONS.BUILD, nil, pos and Vector3(pos.x, 0, pos.z) or nil, recipeName)

    ba:AddSuccessAction(function()
        ReportResult(cmd, "completed", nil, { recipe = recipeName })
    end)

    ba:AddFailAction(function()
        ReportResult(cmd, "failed", "build_failed")
    end)

    player.components.locomotor:PushAction(ba, true)
    ReportResult(cmd, "accepted")
end

-- Main execute function
function Actions.Execute(player, cmd)
    -- Special cases
    if cmd.action == "walk_to" then
        Actions.WalkTo(player, cmd.pos, cmd)
        return
    end

    if cmd.action == "walk_to_entity" then
        local target = Ents[cmd.targetGuid]
        if not target then
            ReportResult(cmd, "failed", "target_not_found")
            return
        end
        local tx, ty, tz = target.Transform:GetWorldPosition()
        Actions.WalkTo(player, { x = tx, z = tz }, cmd)
        return
    end

    if cmd.action == "build" then
        Actions.Build(player, cmd.recipe, cmd.pos, cmd)
        return
    end

    -- Say something in game (uses talker component, no BufferedAction needed)
    if cmd.action == "say" then
        print("[dst-bridge] say: " .. tostring(cmd.text))
        if player.components.talker then
            player.components.talker:Say(cmd.text or "...")
        end
        -- Also announce in chat so all players can see it
        if _G.TheNet then
            _G.TheNet:Announce((player.name or "Wilson") .. ": " .. (cmd.text or "..."), player.entity)
        end
        ReportResult(cmd, "completed", nil, { action = "say", text = cmd.text })
        return
    end

    -- Generic action via ACTION_MAP
    local action = ACTION_MAP[cmd.action]
    if not action then
        ReportResult(cmd, "failed", "unknown_action", { action = cmd.action })
        return
    end

    -- Resolve target
    local target = nil
    if cmd.targetGuid then
        target = Ents[cmd.targetGuid]
        if not target then
            ReportResult(cmd, "failed", "target_not_found", { targetGuid = cmd.targetGuid })
            return
        end
    end

    -- Resolve invObject
    local invObject = nil
    if cmd.invObjectGuid then
        invObject = Ents[cmd.invObjectGuid]
        if not invObject then
            ReportResult(cmd, "failed", "invobject_not_found", { invObjectGuid = cmd.invObjectGuid })
            return
        end
    end

    -- Resolve pos
    local pos = nil
    if cmd.pos then
        pos = Vector3(cmd.pos.x, 0, cmd.pos.z)
    end

    -- Create BufferedAction
    local ba = BufferedAction(player, target, action, invObject, pos, cmd.recipe)

    -- Track completion via success/fail callbacks
    ba:AddSuccessAction(function()
        local result = { action = cmd.action }
        if target then result.targetPrefab = target.prefab end
        ReportResult(cmd, "completed", nil, result)
    end)

    ba:AddFailAction(function()
        ReportResult(cmd, "failed", "action_failed", { action = cmd.action })
    end)

    -- Execute
    player.components.locomotor:PushAction(ba, true)
    ReportResult(cmd, "accepted")
end

-- Get and clear pending results (called by tick)
function Actions.GetPendingResults()
    local results = pendingResults
    pendingResults = {}
    return results
end

return Actions
