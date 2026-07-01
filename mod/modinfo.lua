name = "DST Bridge"
description = "AI Bridge — lets an external AI agent play DST via CLI"
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
        options = {
            {description = "localhost:3002", data = "http://127.0.0.1:3002"},
        },
        default = "http://127.0.0.1:3002",
    },
    {
        name = "poll_interval",
        label = "Poll Interval (seconds)",
        options = {
            {description = "1s", data = 1},
            {description = "2s", data = 2},
            {description = "3s", data = 3},
            {description = "5s", data = 5},
        },
        default = 2,
    },
    {
        name = "perception_radius",
        label = "Perception Radius",
        options = {
            {description = "15", data = 15},
            {description = "20", data = 20},
            {description = "30", data = 30},
        },
        default = 20,
    },
    {
        name = "agent_userid",
        label = "Agent Player Userid",
        options = {
            {description = "auto (first player)", data = ""},
        },
        default = "",
    },
}
