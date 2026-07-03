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
local agentUserId = nil
local eventsRegistered = false

-- Find the player to control
local function FindAgentPlayer()
    if AGENT_USERID ~= "" then
        -- Look for specific userid
        for _, v in ipairs(_G.TheNet:GetClientTable()) do
            if v.userid == AGENT_USERID then
                -- Find the actual player entity
                for _, ent in pairs(_G.Ents) do
                    if ent.userid == v.userid and ent:HasTag("player") then
                        return ent, v.userid
                    end
                end
            end
        end
    end
    -- Default: first connected player
    for _, v in ipairs(_G.TheNet:GetClientTable()) do
        for _, ent in pairs(_G.Ents) do
            if ent.userid == v.userid and ent:HasTag("player") then
                return ent, v.userid
            end
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
