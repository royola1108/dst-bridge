-- http.lua — TheSim:QueryServer wrapper
-- DST's only outbound HTTP method

local _G = GLOBAL

local Http = {}

-- POST to bridge server
-- data: pre-encoded JSON string
function Http.Post(url, data, callback)
    _G.TheSim:QueryServer(
        url,
        function(response, isSuccessful, resultCode)
            if callback then
                callback(response, isSuccessful, resultCode)
            end
        end,
        "POST",
        data
    )
end

-- GET from bridge server
function Http.Get(url, callback)
    _G.TheSim:QueryServer(
        url,
        function(response, isSuccessful, resultCode)
            if callback then
                callback(response, isSuccessful, resultCode)
            end
        end,
        "GET"
    )
end

return Http
