# Auto-Play Chess Script

Roblox chess helper for [CHESS (PlaceId 6222531507)](https://www.roblox.com/games/6222531507/CHESS).
It runs a local Stockfish server and a Rayfield client script with:

- Best-move solving from local Stockfish
- Auto Calculate (one solve per turn)
- Auto Play with two methods:
  - `Remote Event`
  - `Mouse API`
- Per-step mouse timing controls
- Match ID listener for remote autoplay
- Safer FEN handling (prevents sending empty-board FEN)

## Latest Release

- Releases page:  
  `https://github.com/rookietopred02-gif/Auto-Play-Chess-Script/releases`
- Main loader file (`main.lua`):  
  `https://github.com/rookietopred02-gif/Auto-Play-Chess-Script/releases/latest/download/main.lua?v=20260221-4`
- Windows server binary (`roblox-chess-script.exe`):  
  `https://github.com/rookietopred02-gif/Auto-Play-Chess-Script/releases/latest/download/roblox-chess-script.exe`

## Quick Start

1. Download Stockfish from `https://stockfishchess.org/download/`.
2. Download and run:
   - `roblox-chess-script.exe` from the latest release.
3. Execute this in your executor:

```lua
loadstring(game:HttpGet("https://github.com/rookietopred02-gif/Auto-Play-Chess-Script/releases/latest/download/main.lua?v=20260221-4"))()
```

## In-Game UI Controls (Rayfield)

- `Run`: single solve.
- `Auto Calculate`: auto solve on your turn.
- `Auto Play`: auto execute returned move.
- `Auto Play Method`: `Remote Event` or `Mouse API`.
- `Select/Move Delay`: delay between first click and second move click.  
  Range: `0.01` to `1.00` seconds.
- `Move/Click Delay`: delay after cursor arrives and before click.  
  Range: `0.01` to `1.00` seconds.
- `Depth`: search depth.  
  Range: `10` to `100`.
- `Think Time`: max think time per solve.  
  Range: `0.01` to `90.00` seconds.
- `Disregard Think Time`: keep searching until depth target.

## Runtime Overrides

Set these globals before loading the script:

- `_G.__CHESS_SOLVER_URL` (default: `http://127.0.0.1:3000`)
- `_G.__CHESS_SOLVER_RETRIES` (default: `1`)

Example:

```lua
_G.__CHESS_SOLVER_URL = "http://127.0.0.1:3000"
_G.__CHESS_SOLVER_RETRIES = 2
loadstring(game:HttpGet("https://github.com/rookietopred02-gif/Auto-Play-Chess-Script/releases/latest/download/main.lua?v=20260221-4"))()
```

## Notes

- Target game support is only for PlaceId `6222531507`.
- If your executor does not support `queue_on_teleport`, you must re-execute manually after teleport/rejoin.
- If a release asset returns 404 right after publish, wait a few minutes for GitHub asset propagation.

## Disclaimer

For educational purposes only. You are responsible for how you use this project.
