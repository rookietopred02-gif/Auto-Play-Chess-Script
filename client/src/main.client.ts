import Rayfield from "libs/Rayfield"
import CoreGui from "utils/CoreGui"
import findOrCreateInstance from "utils/findOrCreateInstance"
import destroyErrorLogging from "utils/destoryErrorLogging"
import Board from "utils/LuaFuncs/board"
import { Highlighter } from "utils/Highlighter"
import findBestMove from "utils/findBestMove"
import remoteAutoplay from "utils/remoteAutoplay"
import { StarterGui } from "@rbxts/services"
import { ensure_executor_functions_access, queue_on_teleport } from "libs/Unc"

interface RuntimeConfig {
    __CHESS_SOLVER_URL?: string
    __CHESS_SOLVER_RETRIES?: number
}

const runtimeConfig = _G as RuntimeConfig
const solverEndpoint = runtimeConfig.__CHESS_SOLVER_URL ?? "http://127.0.0.1:3000"
const solverRetries = math.max(runtimeConfig.__CHESS_SOLVER_RETRIES ?? 1, 0)

const notiBindableFunc = new Instance("BindableFunction")
notiBindableFunc.OnInvoke = (buttonName: string) => {
    if (buttonName === "Join")
        game.GetService("TeleportService").Teleport(6222531507)
}

if (game.PlaceId !== 6222531507) {
    StarterGui.SetCore("SendNotification", {
        Title: "Wrong Game",
        Text: "This script is not meant for this game, press the Join button to join it",
        Button1: "Join",
        Duration: 10,
        Callback: notiBindableFunc,
    })
}

// init
Highlighter.destroyAll() // clear all old highlights
destroyErrorLogging() // this remote reports client errors (we don't want that)
findOrCreateInstance(CoreGui, "HighlightStorage", "Folder") // create highlight storage

const window = Rayfield.CreateWindow({
    Name: "Chess",
    LoadingTitle: "Chess ♟️",
    LoadingSubtitle: "By Haloxx",

    DisableBuildWarnings: true,
    DisableRayfieldPrompts: true,

    ConfigurationSaving: {
        Enabled: true,
        FolderName: "keplerHaloxx-Chess",
        FileName: "chess-script-config",
    },
})

const board = new Board()
const [listenerReady, listenerMessage] = remoteAutoplay.startMatchIdListener()
let isCalculating = false
let autoPlayMethod: "Remote Event" | "Mouse API" = "Remote Event"

const getCurrentMatchIdText = () => {
    const currentMatchId = remoteAutoplay.getCurrentMatchId(board)
    if (currentMatchId === undefined) {
        return "Current Match ID: unknown"
    }

    return `Current Match ID: ${currentMatchId}`
}

function bestMove(): boolean {
    if (isCalculating) {
        return false
    }

    if (!Board.gameInProgress()) {
        setBotStatus("Idle")
        setBotOutputContent("game not in progress")
        return false
    }

    isCalculating = true
    setBotStatus("Calculating")

    const maxThinkTimeMs = math.max(
        math.floor(thinkTimeSlider.CurrentValue * 1000),
        10
    )

    const [callSucceeded, outputOrError] = pcall(() =>
        findBestMove(
            board,
            depthSlider.CurrentValue,
            maxThinkTimeMs,
            disregardTimeToggle.CurrentValue,
            {
                endpoint: solverEndpoint,
                retries: solverRetries,
            }
        )
    )

    if (!callSucceeded) {
        setBotStatus("Error!")
        setBotOutputContent(`unexpected error (${outputOrError})`)
        isCalculating = false
        return false
    }

    const output = outputOrError as [boolean, string, Instance?, Instance?]

    if (output[0] === false) {
        // has errored
        setBotStatus("Error!")
        setBotOutputContent(output[1])
        isCalculating = false
        return false
    }

    new Highlighter(output[2]!) // piece
    new Highlighter(output[3]!) // place

    let botMessage = `Received: ${output[1]}`

    if (autoPlayToggle.CurrentValue) {
        const [didPlay, playMessage] = remoteAutoplay.execute(
            output[1],
            board,
            autoPlayMethod,
            {
                fromTarget: output[2],
                toTarget: output[3],
            }
        )

        if (didPlay) {
            botMessage = `${botMessage} | AutoPlay(${autoPlayMethod}): ${playMessage}`
        } else {
            botMessage = `${botMessage} | AutoPlay Error(${autoPlayMethod}): ${playMessage}`
        }
    }

    setBotOutputContent(botMessage)
    matchIdLabel.Set(getCurrentMatchIdText())

    // spawn a new thread to destroy all highlights once it's no longer the players turn
    task.spawn(() => {
        while (Board.gameInProgress() && board.isPlayerTurn()) {
            task.wait(0.1)
        }
        Highlighter.destroyAll()
    })

    setBotStatus("Idle")
    isCalculating = false
    return true
}

const mainTab = window.CreateTab("Main")

if (!ensure_executor_functions_access(queue_on_teleport))
    mainTab.CreateParagraph({
        Title: "Your executor probably doesn't support queue_on_teleport()",
        Content: `Do not worry that is OKAY but you will have to manually re-execute the script on rejoin.`,
    })
else
    queue_on_teleport(
        `loadstring(game:HttpGet("https://github.com/rookietopred02-gif/Auto-Play-Chess-Script/blob/main/main.lua"))()`
    )

mainTab.CreateSection("Status")

let botStatus = ""
const botStatusLabel = mainTab.CreateLabel("Status: Idle")
mainTab.CreateLabel(`Solver: ${solverEndpoint}`)
mainTab.CreateLabel(`Retry Attempts: ${solverRetries}`)
const matchIdLabel = mainTab.CreateLabel(getCurrentMatchIdText())
if (!listenerReady) {
    mainTab.CreateParagraph({
        Title: "Remote Listener",
        Content: listenerMessage,
    })
}
if (!remoteAutoplay.supportsMouseApi()) {
    mainTab.CreateParagraph({
        Title: "Mouse API",
        Content: "mouse API not supported in current executor. Auto Play (Mouse API) will fail.",
    })
}
const setBotStatus = (status: string): string => {
    const stat = `Status: ${status}`
    botStatus = stat
    botStatusLabel.Set(stat)
    return stat
}
setBotStatus("Idle")

const botOutput = mainTab.CreateParagraph({
    Title: "Bot Output",
    Content: "",
})
const setBotOutputContent = (content: string) =>
    botOutput.Set({ Title: "Bot Output", Content: content })

mainTab.CreateSection("Run")

mainTab.CreateButton({
    Name: "Run",
    Callback: bestMove,
})

const autoCalculateToggle = mainTab.CreateToggle({
    Name: "Auto Calculate",
    Flag: "AutoCalculate",
    CurrentValue: false,
    Callback: () => {},
})

const autoPlayToggle = mainTab.CreateToggle({
    Name: "Auto Play",
    Flag: "AutoPlay",
    CurrentValue: false,
    Callback: () => {
        matchIdLabel.Set(getCurrentMatchIdText())
    },
})

const autoPlayMethodDropdown = mainTab.CreateDropdown({
    Name: "Auto Play Method",
    Options: ["Remote Event", "Mouse API"],
    CurrentOption: [autoPlayMethod],
    MultipleOptions: false,
    Flag: "AutoPlayMethod",
    Callback: (options) => {
        const method = options[0]
        if (method === "Mouse API" || method === "Remote Event") {
            autoPlayMethod = method
        } else {
            autoPlayMethod = "Remote Event"
        }
    },
})
autoPlayMethodDropdown.Set([autoPlayMethod])

const mouseStepDelaySlider = mainTab.CreateSlider({
    Name: "Select/Move Delay",
    Range: [0, 1],
    Increment: 0.01,
    Suffix: "s",
    CurrentValue: 0,
    Flag: "MouseStepDelaySeconds",
    Callback: (value) => {
        remoteAutoplay.setMouseStepDelaySeconds(value)
    },
})
remoteAutoplay.setMouseStepDelaySeconds(mouseStepDelaySlider.CurrentValue)

const mouseClickDelaySlider = mainTab.CreateSlider({
    Name: "Move/Click Delay",
    Range: [0, 1],
    Increment: 0.01,
    Suffix: "s",
    CurrentValue: 0,
    Flag: "MouseClickDelaySeconds",
    Callback: (value) => {
        remoteAutoplay.setMouseClickDelaySeconds(value)
    },
})
remoteAutoplay.setMouseClickDelaySeconds(mouseClickDelaySlider.CurrentValue)

task.spawn(() => {
    // Execute once per turn while auto-calculate is enabled.
    while (true) {
        matchIdLabel.Set(getCurrentMatchIdText())

        if (
            autoCalculateToggle.CurrentValue &&
            !isCalculating &&
            Board.gameInProgress() &&
            board.isPlayerTurn()
        ) {
            bestMove()

            while (
                autoCalculateToggle.CurrentValue &&
                Board.gameInProgress() &&
                board.isPlayerTurn()
            ) {
                task.wait(0.1)
            }

            while (
                autoCalculateToggle.CurrentValue &&
                Board.gameInProgress() &&
                !board.isPlayerTurn()
            ) {
                task.wait(0.1)
            }
        }

        task.wait(0.1)
    }
})

mainTab.CreateSection("Bot Options")

// mainTab.CreateLabel("How many moves Stockfish thinks ahead")
const depthSlider = mainTab.CreateSlider({
    Name: "Depth",
    Range: [10, 100],
    Increment: 1,
    Suffix: "moves",
    CurrentValue: 17,
    Flag: "Depth",
    Callback: () => {},
})

mainTab.CreateLabel(
    "When toggled, Stockfish will not stop thinking until it has reached the desired depth"
)
const disregardTimeToggle = mainTab.CreateToggle({
    Name: "Disregard Think Time",
    CurrentValue: false,
    Flag: "DisregardThinkTime",
    Callback: () => {},
})

// mainTab.CreateLabel("Maximum amount of time Stockfish has to think")
const thinkTimeSlider = mainTab.CreateSlider({
    Name: "Think Time",
    Range: [0.01, 90],
    CurrentValue: 0.1,
    Flag: "MaxThinkTimeSeconds",
    Suffix: "s",
    Increment: 0.01,
    Callback: () => {},
})

Rayfield.LoadConfiguration()

