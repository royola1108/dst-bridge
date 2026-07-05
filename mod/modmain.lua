local _G = GLOBAL
local BRIDGE_URL = GetModConfigData("bridge_url")
local POLL_INTERVAL = GetModConfigData("poll_interval")
local PERCEPTION_RADIUS = GetModConfigData("perception_radius")
local AGENT_USERID = GetModConfigData("agent_userid")

-- Only run on server
if not _G.TheNet:GetIsServer() then return end

local Http = require("bridge_http")
local Perception = require("bridge_perception")
local Actions = require("bridge_actions")
local Events = require("bridge_events")

local seq = 0
local agentPlayer = nil
local agentUserId = "AI_AGENT"
local eventsRegistered = false
local aiSpawned = false

-- Spawn an AI companion NPC near the portal
local function SpawnAICompanion()
    if aiSpawned then return end

    -- Find the multiplayer portal
    local portal = nil
    local px, py, pz = 0, 0, 0
    for _, ent in pairs(_G.Ents) do
        if ent.prefab == "multiplayer_portal" and ent.entity:IsVisible() then
            portal = ent
            break
        end
    end

    if portal then
        px, py, pz = portal.Transform:GetWorldPosition()
    else
        -- Fallback: world origin
        px, py, pz = 0, 0, 0
    end

    -- Spawn a Wilson near the portal
    local aiChar = _G.SpawnPrefab("wilson")
    if aiChar then
        -- Place near portal (offset a bit so they don't overlap)
        aiChar.Transform:SetPosition(px + 3, py, pz + 3)

        -- Mark as AI agent
        aiChar:AddTag("dst_bridge_ai")
        aiChar.userid = agentUserId

        -- Auto-respawn on death (AI companion can't die permanently)
        aiChar:ListenForEvent("death", function(inst)
            inst:DoTaskInTime(3, function()
                if inst.components.health then
                    inst.components.health:SetInvincible(true)
                end
                if inst:HasTag("playerghost") then
                    -- Resurrect
                    local respawn = _G.SpawnPrefab("resurrectionstone")
                    if respawn then
                        respawn.Transform:SetPosition(inst.Transform:GetWorldPosition())
                        respawn.AnimState:PlayAnimation("idle")
                        inst:PushEvent("respawnfromghost")
                    end
                end
                -- Remove invincible after respawn
                inst:DoTaskInTime(5, function()
                    if inst.components.health then
                        inst.components.health:SetInvincible(false)
                    end
                end)
            end)
            print("[dst-bridge] AI companion died, auto-respawning...")
        end)

        -- Give it god mode initially so it doesn't die before AI starts playing
        if aiChar.components.health then
            aiChar.components.health:SetInvincible(true)
            -- Remove god mode after 30 seconds
            aiChar:DoTaskInTime(30, function()
                if aiChar.components.health then
                    aiChar.components.health:SetInvincible(false)
                end
                print("[dst-bridge] AI companion god mode expired")
            end)
        end

        print("[dst-bridge] AI companion spawned (Wilson) near portal at (" .. px .. "," .. pz .. ")")
        aiSpawned = true
        return aiChar
    end

    print("[dst-bridge] Failed to spawn AI companion")
    return nil
end

-- Find the AI player to control
local function FindAgentPlayer()
    -- Look for our AI companion
    for _, ent in pairs(_G.Ents) do
        if ent:HasTag("dst_bridge_ai") and ent.entity:IsValid() then
            return ent, agentUserId
        end
    end

    -- If not spawned yet, try to spawn
    if not aiSpawned then
        local ai = SpawnAICompanion()
        if ai then
            return ai, agentUserId
        end
    end

    return nil, nil
end

-- Main tick: upload state + get commands
local function Tick()
    if not agentPlayer or not agentPlayer.entity:IsValid() then
        agentPlayer, agentUserId = FindAgentPlayer()
        if not agentPlayer then return end

        -- Register events after finding the player
        if not eventsRegistered then
            Events.Register(agentPlayer, BRIDGE_URL, agentUserId)
            eventsRegistered = true
            print("[dst-bridge] agent player found: " .. (agentPlayer.name or agentUserId))
        end
    end

    seq = seq + 1

    -- 1. Gather state
    local state = Perception.Snapshot(agentPlayer, PERCEPTION_RADIUS)

    -- 1b. Check for boss nearby (push as event if found)
    if state.nearby then
        for _, ent in ipairs(state.nearby) do
            if ent.isBoss then
                local bossData = _G.json.encode({
                    ts = _G.GetTime(),
                    playerUserId = agentUserId,
                    kind = "boss_nearby",
                    data = { prefab = ent.prefab, guid = ent.guid, distance = ent.distance },
                })
                TheSim:QueryServer(BRIDGE_URL .. "/event", function() end, "POST", bossData)
                break
            end
        end
    end

    -- 2. Collect pending action results
    local executingResults = Actions.GetPendingResults()

    -- 3. POST /tick (upload state + get commands in one round trip)
    local tickData = _G.json.encode({
        seq = seq,
        ts = _G.GetTime(),
        playerUserId = agentUserId,
        state = state,
        executingResults = executingResults,
    })
    print("[dst-bridge] tick " .. seq .. " json encoded, posting to " .. BRIDGE_URL .. "/tick")

    Http.Post(BRIDGE_URL .. "/tick", tickData, function(responseText, success, code)
        print("[dst-bridge] tick " .. seq .. " response: success=" .. tostring(success) .. " code=" .. tostring(code))
        if not success or code ~= 200 then return end

        local resp = _G.json.decode(responseText)
        if not resp or not resp.commands then return end

        -- 4. Execute each command
        for _, cmd in ipairs(resp.commands) do
            Actions.Execute(agentPlayer, cmd)
        end
    end)
end

-- Start periodic tick when world loads
AddPrefabPostInit("world", function(inst)
    inst:DoPeriodicTask(POLL_INTERVAL, Tick)
    print("[dst-bridge] started, polling " .. BRIDGE_URL .. " every " .. POLL_INTERVAL .. "s")
end)

-- Hook ALL players' talker to capture human player chat (not just AI Wilson)
-- Player-typed chat goes through Networking_Say (not talker:Say which is character voice lines)
local _Networking_Say = _G.Networking_Say
_G.Networking_Say = function(...)
    local args = { ... }
    -- Networking_Say(clientid, userid, playername, prefab, message, colour, isemoji, isnn, ...)
    local userid = args[2]
    local playerName = args[3] or userid
    local message = args[5]
    if message and message ~= "" then
        local eventData = _G.json.encode({
            ts = _G.GetTime(),
            playerUserId = "AI_AGENT",
            kind = "chat",
            data = { message = message, from = playerName },
        })
        TheSim:QueryServer(
            BRIDGE_URL .. "/event",
            function() end,
            "POST",
            eventData
        )
    end
    return _Networking_Say(userid, message, ...)
end
print("[dst-bridge] chat capture via Networking_Say hook installed")
