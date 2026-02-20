export = (result: string): LuaTuple<[number, number, number, number]> => {
    if (result.size() !== 4) {
        error(`invalid stockfish move length: ${result}`)
    }

    const fileToX = (file: string): number => {
        const bytes = string.byte(file)
        const byteValue = bytes[0]

        if (byteValue < 97 || byteValue > 104) {
            error(`invalid file value in stockfish move: ${result}`)
        }

        return 9 - (byteValue - 96)
    }

    const rankToY = (rank: string): number => {
        const parsedRank = tonumber(rank)
        if (parsedRank === undefined || parsedRank < 1 || parsedRank > 8) {
            error(`invalid rank value in stockfish move: ${result}`)
        }
        return parsedRank
    }

    const x1 = fileToX(string.sub(result, 1, 1))
    const y1 = rankToY(string.sub(result, 2, 2))

    const x2 = fileToX(string.sub(result, 3, 3))
    const y2 = rankToY(string.sub(result, 4, 4))

    return [x1, y1, x2, y2] as LuaTuple<[number, number, number, number]>
}
