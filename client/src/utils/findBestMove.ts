import { HttpService, Workspace } from "@rbxts/services"
import HttpGet from "./HttpGet"
import Board from "./LuaFuncs/board"
import getPosFromResult from "./getPosFromResult"

interface MoveJsonData {
    success: boolean
    result: string
}

interface FindBestMoveOptions {
    endpoint?: string
    retries?: number
}

const getStableFen = (
    board: Board,
    attempts = 40,
    waitSeconds = 0.05
): string | undefined => {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const fen = board.board2fen()
        if (fen && fen !== "8/8/8/8/8/8/8/8 w" && fen !== "8/8/8/8/8/8/8/8 b") {
            return fen
        }
        task.wait(waitSeconds)
    }

    return undefined
}

/**
 * Does a ton of checks and gets the best move
 */
export = (
    board: Board,
    depth: number,
    maxThinkTime: number,
    disregardThinkTime: boolean,
    options?: FindBestMoveOptions
): [boolean, string, Instance?, Instance?] => {
    if (!board.isPlayerTurn()) return [false, "not your turn"]

    if (board.willCauseDesync()) {
        // Keep compatibility with previous behavior: this check is advisory only.
        warn("board sync check reported a potential desync risk")
    }

    const fen = getStableFen(board)
    if (!fen) {
        return [false, "board not ready (fen unavailable)"]
    }

    const endpoint = options?.endpoint ?? "http://127.0.0.1:3000"
    const [requestSucceeded, response] = HttpGet(
        `${endpoint}/api/solve?fen=${HttpService.UrlEncode(fen)}&depth=${depth}&max_think_time=${maxThinkTime}&disregard_think_time=${disregardThinkTime}`,
        {
            retries: options?.retries ?? 1,
        }
    )

    if (!requestSucceeded) {
        return [false, `no response from server (${response})`]
    }

    const [decodeSucceeded, decodedOrError] = pcall(() =>
        HttpService.JSONDecode(response)
    )

    if (!decodeSucceeded) {
        return [false, `invalid server response (${decodedOrError})`]
    }

    const data = decodedOrError as Partial<MoveJsonData>
    const successValue = data.success
    const resultValue = data.result

    if (type(successValue) !== "boolean" || type(resultValue) !== "string") {
        return [false, "invalid server payload"]
    }

    const success = successValue as boolean
    const move = resultValue as string

    if (move.size() === 0) {
        return [false, "invalid server payload"]
    }

    if (!success) {
        return [false, move]
    }

    if (!string.match(move, "^[a-h][1-8][a-h][1-8]$")) {
        return [false, `invalid move format (${move})`]
    }

    const [x1, y1, x2, y2] = getPosFromResult(move)

    const pieceToMove = Board.getPiece(tostring(x1 + "," + y1))
    if (!pieceToMove) {
        return [false, "no piece to move"]
    }

    const placeToMove = Workspace.FindFirstChild("Board")?.FindFirstChild(
        tostring(x2 + "," + y2)
    )
    if (!placeToMove) {
        return [false, "no place to move to"]
    }

    return [true, move, pieceToMove, placeToMove]
}
