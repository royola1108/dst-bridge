-- events.lua — listen for game events → POST /event to bridge
-- References: FAtiMA-DST fatimabrain.lua event listeners

local _G = GLOBAL
local Events = {}

function Events.Register(player, bridgeUrl, playerUserId)
    local function postEvent(kind, data)
        local eventData = _G.json.encode({
            ts = _G.GetTime(),
            playerUserId = playerUserId,
            kind = kind,
            data = data,
        })
        _G.TheSim:QueryServer(
            bridgeUrl .. "/event",
            function() end,
            "POST",
            eventData
        )
    end

    -- Combat events
    player:ListenForEvent("attacked", function(inst, data)
        postEvent("attacked", {
            attackerGuid = data.attacker and data.attacker.GUID or nil,
            attackerPrefab = data.attacker and data.attacker.prefab or "unknown",
            damage = data.damage or 0,
            healthAfter = inst.components.health and math.floor(inst.components.health.currenthealth) or 0,
        })
    end)

    player:ListenForEvent("killed", function(inst, data)
        postEvent("killed", {
            targetGuid = data.victim and data.victim.GUID or nil,
            targetPrefab = data.victim and data.victim.prefab or "unknown",
        })
    end)

    player:ListenForEvent("death", function(inst, data)
        postEvent("death", {
            cause = data.cause or "unknown",
            killerPrefab = data.afflicter and data.afflicter.prefab or nil,
        })
    end)

    player:ListenForEvent("onhitother", function(inst, data)
        postEvent("hit_other", {
            targetGuid = data.target and data.target.GUID or nil,
            targetPrefab = data.target and data.target.prefab or nil,
            damage = data.damage or 0,
        })
    end)

    -- Health critical
    player:ListenForEvent("healthdelta", function(inst, data)
        local hp = inst.components.health and math.floor(inst.components.health.currenthealth) or 0
        if hp < 30 then
            postEvent("health_critical", { health = hp })
        end
    end)

    -- Hunger critical (hunger goes DOWN in DST, 0 = starving)
    player:ListenForEvent("hungerdelta", function(inst, data)
        local hunger = inst.components.hunger and math.floor(inst.components.hunger.current) or 0
        if hunger < 30 then
            postEvent("hunger_critical", { hunger = hunger })
        end
    end)

    -- Sanity low
    player:ListenForEvent("sanitydelta", function(inst, data)
        local sanity = inst.components.sanity and math.floor(inst.components.sanity.current) or 0
        if sanity < 30 then
            postEvent("sanity_low", { sanity = sanity })
        end
    end)

    -- Light/dark
    player:ListenForEvent("enterdark", function()
        postEvent("enter_dark", {})
    end)

    player:ListenForEvent("enterlight", function()
        postEvent("enter_light", {})
    end)

    -- World state changes (phase, season, etc.)
    player:WatchWorldState("phase", function(inst, phase)
        postEvent("phase_changed", { phase = phase })
        if phase == "dusk" then
            postEvent("dusk", {})
        elseif phase == "night" then
            postEvent("night", {})
        elseif phase == "day" then
            postEvent("dawn", {})
        end
    end)

    player:WatchWorldState("season", function(inst, season)
        postEvent("season_changed", { season = season })
    end)

    player:WatchWorldState("israining", function(inst, israining)
        if israining then postEvent("rain_started", {}) end
    end)

    player:WatchWorldState("issnowing", function(inst, issnowing)
        if issnowing then postEvent("snow_started", {}) end
    end)

    -- Temperature warnings
    player:ListenForEvent("startfreezing", function()
        postEvent("freeze_warning", { temperature = player:GetTemperature() })
    end)

    player:ListenForEvent("startoverheating", function()
        postEvent("overheat_warning", { temperature = player:GetTemperature() })
    end)

    -- Respawn
    player:ListenForEvent("respawnfromghost", function()
        postEvent("respawn", {})
    end)

    print("[dst-bridge] events registered for " .. (player.name or "player"))
end

return Events
