import {
    Players,
    ReplicatedStorage,
    UserInputService,
    Workspace,
} from "@rbxts/services"
import {
    ensure_executor_functions_access,
    mouse1click,
    mousemoveabs,
    mousemoverel,
} from "libs/Unc"
import Board from "./LuaFuncs/board"
import getPosFromResult from "./getPosFromResult"

type AutoPlayMethod = "Remote Event" | "Mouse API"
interface AutoPlayTargets {
    fromTarget?: Instance
    toTarget?: Instance
}
type MovePosition = [number, number] & {
    moveOnly?: boolean
    doubleStep?: number
}

interface StartGamePayload {
    id?: unknown
}

interface RemoteAutoplayApi {
    startMatchIdListener: () => [boolean, string]
    getCurrentMatchId: (board?: Board) => number | undefined
    supportsMouseApi: () => boolean
    setMouseStepDelaySeconds: (seconds: number) => void
    setMouseClickDelaySeconds: (seconds: number) => void
    execute: (
        move: string,
        board: Board,
        method: AutoPlayMethod,
        targets?: AutoPlayTargets
    ) => [boolean, string]
}

let lastMatchId: number | undefined
let hasStartedListener = false
let lastInjectedMousePosition: Vector2 | undefined
let mouseStepDelaySeconds = 0.2
let mouseClickDelaySeconds = 0.05

const getConnectionsFolder = (): Folder | undefined => {
    const connections = ReplicatedStorage.FindFirstChild("Connections")
    if (!connections || !connections.IsA("Folder")) {
        return undefined
    }

    return connections
}

const parseNumber = (value: unknown): number | undefined => {
    if (type(value) !== "number") {
        return undefined
    }

    return value as number
}

const updateMatchIdFromBoard = (board?: Board): number | undefined => {
    if (!board) {
        return lastMatchId
    }

    const rawMatch = board.getRawMatch()
    if (!rawMatch) {
        return lastMatchId
    }

    const boardMatchId = parseNumber((rawMatch as { id?: unknown }).id)
    if (boardMatchId !== undefined) {
        lastMatchId = boardMatchId
    }

    return lastMatchId
}

const resolveDoubleStep = (pieceData: unknown): number => {
    if (type(pieceData) !== "table") {
        return 0
    }

    const piece = pieceData as {
        doubleStep?: unknown
        doublestep?: unknown
        position?: (unknown[] & { doubleStep?: unknown; doublestep?: unknown })
    }

    const directDoubleStep =
        parseNumber(piece.doubleStep) ?? parseNumber(piece.doublestep)
    if (directDoubleStep !== undefined) {
        return directDoubleStep
    }

    const position = piece.position
    if (position && type(position) === "table") {
        const positionDoubleStep =
            parseNumber(position.doubleStep) ??
            parseNumber(position.doublestep) ??
            parseNumber(position[2])

        if (positionDoubleStep !== undefined) {
            return positionDoubleStep
        }
    }

    return 0
}

const getPieceName = (pieceData: unknown): string | undefined => {
    if (type(pieceData) !== "table") {
        return undefined
    }

    const piece = pieceData as { object?: Instance }
    const pieceObject = piece.object
    if (!pieceObject) {
        return undefined
    }

    return pieceObject.Name
}

const getMovePieceEvent = (): RemoteEvent | undefined => {
    const connections = getConnectionsFolder()
    if (!connections) {
        return undefined
    }

    const movePiece = connections.FindFirstChild("MovePiece")
    if (!movePiece || !movePiece.IsA("RemoteEvent")) {
        return undefined
    }

    return movePiece
}

const getTileInstance = (x: number, y: number): Instance | undefined => {
    const boardRoot = Workspace.FindFirstChild("Board")
    if (!boardRoot) {
        return undefined
    }

    return boardRoot.FindFirstChild(`${x},${y}`)
}

const findFirstBasePart = (target: Instance): BasePart | undefined => {
    if (target.IsA("BasePart")) {
        return target
    }

    const descendants = target.GetDescendants()
    for (const descendant of descendants) {
        if (descendant.IsA("BasePart")) {
            return descendant
        }
    }

    return undefined
}

const getInstanceWorldPosition = (target: Instance): Vector3 | undefined => {
    if (target.IsA("Attachment")) {
        return target.WorldPosition
    }

    if (target.IsA("BasePart")) {
        return target.Position
    }

    if (target.IsA("Model")) {
        const primaryPart = target.PrimaryPart
        if (primaryPart) {
            return primaryPart.Position
        }

        const meshesFolder = target.FindFirstChild("Meshes")
        const meshTile = meshesFolder?.FindFirstChild("tile_a")
        if (meshTile && meshTile.IsA("BasePart")) {
            return meshTile.Position
        }

        const tilePart = target.FindFirstChild("Tile")
        if (tilePart && tilePart.IsA("BasePart")) {
            return tilePart.Position
        }

        const firstPart = findFirstBasePart(target)
        if (firstPart) {
            return firstPart.Position
        }

        const [canReadBoundingBox, modelCFrameOrError] = pcall(() => {
            const [modelCFrame] = target.GetBoundingBox()
            return modelCFrame
        })
        if (canReadBoundingBox) {
            return (modelCFrameOrError as CFrame).Position
        }

        return undefined
    }

    const nestedPart = findFirstBasePart(target)
    if (nestedPart) {
        return nestedPart.Position
    }

    return undefined
}

const CLICK_RAY_DISTANCE = 2048
const TILE_SAMPLE_GRID_HIGH = 11
const TILE_SAMPLE_MARGIN = 0.08
const TILE_SAMPLE_HEIGHT_OFFSET = 0.08
const RELATIVE_MOVE_MAX_STEP_PIXELS = 120
const RELATIVE_MOVE_STEP_DELAY_SECONDS = 0.008
const RELATIVE_MOVE_ARRIVAL_TOLERANCE_PIXELS = 2
const RELATIVE_MOVE_ARRIVAL_MAX_POLLS = 40
const RELATIVE_MOVE_ARRIVAL_POLL_DELAY_SECONDS = 0.01
const RELATIVE_MOVE_RETRY_ATTEMPTS = 2

type ClickPhase = "source" | "destination"

interface ClickResolutionContext {
    phase: ClickPhase
    coordinate: string
    tile: Instance
    tilePart: BasePart
    piece?: Instance
    button: "left" | "right"
    allowedHits: Instance[]
    allowPieceSamplingFallback: boolean
}

interface MoveClickContext {
    source: ClickResolutionContext
    destination: ClickResolutionContext
}

type MouseMoveMode = "absolute" | "relative"

const addUniquePoint = (points: Vector3[], point: Vector3 | undefined): void => {
    if (!point) {
        return
    }

    for (const existing of points) {
        if (existing.sub(point).Magnitude < 0.001) {
            return
        }
    }

    points.push(point)
}

const worldPointFromOffset = (base: CFrame, offset: Vector3): Vector3 => {
    return base.Position.add(base.RightVector.mul(offset.X))
        .add(base.UpVector.mul(offset.Y))
        .add(base.LookVector.mul(offset.Z))
}

const addPartSamplePoints = (points: Vector3[], part: BasePart): void => {
    const half = part.Size.mul(0.5)
    const xOffset = math.max(half.X * 0.4, 0.05)
    const yOffset = math.max(half.Y * 0.9, 0.05)
    const zOffset = math.max(half.Z * 0.4, 0.05)

    const offsets = [
        new Vector3(0, yOffset, 0),
        new Vector3(0, 0, 0),
        new Vector3(xOffset, yOffset * 0.75, 0),
        new Vector3(-xOffset, yOffset * 0.75, 0),
        new Vector3(0, yOffset * 0.75, zOffset),
        new Vector3(0, yOffset * 0.75, -zOffset),
    ]

    for (const offset of offsets) {
        addUniquePoint(points, worldPointFromOffset(part.CFrame, offset))
    }
}

const resolveTileBasePart = (tile: Instance): BasePart | undefined => {
    if (tile.IsA("BasePart")) {
        return tile
    }

    if (tile.IsA("Model")) {
        const meshTile = tile.FindFirstChild("Meshes/tile_a")
        if (meshTile && meshTile.IsA("BasePart")) {
            return meshTile
        }

        const tilePart = tile.FindFirstChild("Tile")
        if (tilePart && tilePart.IsA("BasePart")) {
            return tilePart
        }

        if (tile.PrimaryPart) {
            return tile.PrimaryPart
        }
    }

    return findFirstBasePart(tile)
}

const pushUniqueInstance = (instances: Instance[], candidate?: Instance): void => {
    if (!candidate) {
        return
    }

    for (const existing of instances) {
        if (existing === candidate) {
            return
        }
    }

    instances.push(candidate)
}

const isAllowedTopHit = (hit: Instance, allowed: Instance[]): boolean => {
    for (const allowedInstance of allowed) {
        if (hit === allowedInstance || hit.IsDescendantOf(allowedInstance)) {
            return true
        }
    }

    return false
}

const generateTileTopSamples = (part: BasePart, density: "high"): Vector3[] => {
    const points: Array<{ point: Vector3; distanceToCenter: number }> = []
    const gridSize = density === "high" ? TILE_SAMPLE_GRID_HIGH : TILE_SAMPLE_GRID_HIGH
    const normalizedRange = 1 - TILE_SAMPLE_MARGIN * 2
    const topOffsetY = part.Size.Y * 0.5 + TILE_SAMPLE_HEIGHT_OFFSET

    for (let gridX = 0; gridX < gridSize; gridX++) {
        const normalizedX =
            TILE_SAMPLE_MARGIN + (gridX / (gridSize - 1)) * normalizedRange
        const localX = (normalizedX - 0.5) * part.Size.X

        for (let gridZ = 0; gridZ < gridSize; gridZ++) {
            const normalizedZ =
                TILE_SAMPLE_MARGIN + (gridZ / (gridSize - 1)) * normalizedRange
            const localZ = (normalizedZ - 0.5) * part.Size.Z
            const centerDistanceSq =
                (normalizedX - 0.5) ** 2 + (normalizedZ - 0.5) ** 2

            points.push({
                point: worldPointFromOffset(
                    part.CFrame,
                    new Vector3(localX, topOffsetY, localZ)
                ),
                distanceToCenter: centerDistanceSq,
            })
        }
    }

    points.sort((a, b) => a.distanceToCenter < b.distanceToCenter)

    const orderedPoints: Vector3[] = []
    for (const entry of points) {
        orderedPoints.push(entry.point)
    }

    return orderedPoints
}

const getModelBoundingBox = (target: Model): [CFrame, Vector3] | undefined => {
    const [hasBoundingBox, resultOrError] = pcall(() => {
        const [cframe, size] = target.GetBoundingBox()
        return [cframe, size] as [CFrame, Vector3]
    })
    if (!hasBoundingBox) {
        return undefined
    }

    return resultOrError as [CFrame, Vector3]
}

const addBoundingBoxSamplePoints = (
    points: Vector3[],
    boundingBox: [CFrame, Vector3]
): void => {
    const [boxCFrame, boxSize] = boundingBox
    const half = boxSize.mul(0.5)
    const xOffset = math.max(half.X * 0.45, 0.05)
    const yOffset = math.max(half.Y * 0.95, 0.05)
    const zOffset = math.max(half.Z * 0.45, 0.05)

    const offsets = [
        new Vector3(0, yOffset, 0),
        new Vector3(0, 0, 0),
        new Vector3(xOffset, yOffset * 0.7, zOffset),
        new Vector3(-xOffset, yOffset * 0.7, zOffset),
        new Vector3(xOffset, yOffset * 0.7, -zOffset),
        new Vector3(-xOffset, yOffset * 0.7, -zOffset),
    ]

    for (const offset of offsets) {
        addUniquePoint(points, worldPointFromOffset(boxCFrame, offset))
    }
}

const generatePieceSurfaceSamples = (target: Instance): Vector3[] => {
    const points: Vector3[] = []
    addUniquePoint(points, getInstanceWorldPosition(target))

    if (target.IsA("Attachment")) {
        addUniquePoint(points, target.WorldPosition.add(new Vector3(0, 0.05, 0)))
        return points
    }

    if (target.IsA("BasePart")) {
        addPartSamplePoints(points, target)
        return points
    }

    if (target.IsA("Model")) {
        const primaryPart = target.PrimaryPart
        if (primaryPart) {
            addPartSamplePoints(points, primaryPart)
        }

        const boundingBox = getModelBoundingBox(target)
        if (boundingBox) {
            addBoundingBoxSamplePoints(points, boundingBox)
        }

        let sampledParts = 0
        for (const descendant of target.GetDescendants()) {
            if (!descendant.IsA("BasePart")) {
                continue
            }

            addPartSamplePoints(points, descendant)
            sampledParts += 1

            if (sampledParts >= 6) {
                break
            }
        }

        return points
    }

    const fallbackPart = findFirstBasePart(target)
    if (fallbackPart) {
        addPartSamplePoints(points, fallbackPart)
    }

    return points
}

const buildClickRaycastParams = (): RaycastParams => {
    const raycastParams = new RaycastParams()
    raycastParams.FilterType = Enum.RaycastFilterType.Exclude
    raycastParams.IgnoreWater = true

    const ignoreList: Instance[] = []
    const localCharacter = Players.LocalPlayer.Character
    if (localCharacter) {
        ignoreList.push(localCharacter)
    }

    raycastParams.FilterDescendantsInstances = ignoreList
    return raycastParams
}

const pickInteriorViewportPoint = (points: Vector3[]): Vector3 => {
    if (points.size() === 1) {
        return points[0]
    }

    let centroidX = 0
    let centroidY = 0
    for (const point of points) {
        centroidX += point.X
        centroidY += point.Y
    }

    const pointCount = points.size()
    centroidX /= pointCount
    centroidY /= pointCount

    let bestPoint = points[0]
    let bestDistance = math.huge
    for (const point of points) {
        const deltaX = point.X - centroidX
        const deltaY = point.Y - centroidY
        const distance = deltaX * deltaX + deltaY * deltaY
        if (distance < bestDistance) {
            bestDistance = distance
            bestPoint = point
        }
    }

    return bestPoint
}

const resolveTopVisiblePointFromSamples = (
    camera: Camera,
    worldPoints: Vector3[],
    allowedHits: Instance[],
    raycastParams: RaycastParams,
    stageName: string
): [Vector3 | undefined, string] => {
    if (worldPoints.size() === 0) {
        return [undefined, `${stageName}: no candidate points`]
    }

    let visibleSampleCount = 0
    const topHitViewportPoints: Vector3[] = []
    let firstBlockingHit: string | undefined

    for (const worldPoint of worldPoints) {
        const [viewportPoint, isVisible] = camera.WorldToViewportPoint(worldPoint)
        if (!isVisible) {
            continue
        }

        visibleSampleCount += 1

        const ray = camera.ViewportPointToRay(viewportPoint.X, viewportPoint.Y)
        const hit = Workspace.Raycast(
            ray.Origin,
            ray.Direction.mul(CLICK_RAY_DISTANCE),
            raycastParams
        )

        if (!hit || !hit.Instance) {
            continue
        }

        if (!isAllowedTopHit(hit.Instance, allowedHits)) {
            if (!firstBlockingHit) {
                firstBlockingHit = hit.Instance.GetFullName()
            }
            continue
        }
        topHitViewportPoints.push(
            new Vector3(viewportPoint.X, viewportPoint.Y, viewportPoint.Z)
        )
    }

    if (topHitViewportPoints.size() > 0) {
        const interiorPoint = pickInteriorViewportPoint(topHitViewportPoints)
        return [
            interiorPoint,
            `${stageName}: ${topHitViewportPoints.size()} visible top-hit points`,
        ]
    }

    if (visibleSampleCount === 0) {
        return [undefined, `${stageName}: no visible sample point`]
    }

    if (firstBlockingHit) {
        return [undefined, `${stageName}: blocked by ${firstBlockingHit}`]
    }

    return [undefined, `${stageName}: no topmost hit`]
}

const resolveTopVisibleScreenPoint = (
    context: ClickResolutionContext
): [Vector3 | undefined, string] => {
    const camera = Workspace.CurrentCamera
    if (!camera) {
        return [undefined, `${context.phase} ${context.coordinate}: no current camera`]
    }

    const raycastParams = buildClickRaycastParams()
    const tileStage = `${context.phase} ${context.coordinate} tile-sampling`
    const tileSamples = generateTileTopSamples(context.tilePart, "high")
    const [tileScreenPoint, tileReason] = resolveTopVisiblePointFromSamples(
        camera,
        tileSamples,
        context.allowedHits,
        raycastParams,
        tileStage
    )
    if (tileScreenPoint) {
        return [tileScreenPoint, tileReason]
    }

    if (!context.allowPieceSamplingFallback || !context.piece) {
        return [undefined, `${context.phase} ${context.coordinate}: ${tileReason}`]
    }

    const pieceSamples = generatePieceSurfaceSamples(context.piece)
    const pieceStage = `${context.phase} ${context.coordinate} piece-sampling`
    const [pieceScreenPoint, pieceReason] = resolveTopVisiblePointFromSamples(
        camera,
        pieceSamples,
        context.allowedHits,
        raycastParams,
        pieceStage
    )
    if (pieceScreenPoint) {
        return [pieceScreenPoint, pieceReason]
    }

    return [
        undefined,
        `${context.phase} ${context.coordinate}: ${tileReason}; ${pieceReason}`,
    ]
}

const buildClickContext = (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    targets?: AutoPlayTargets
): [MoveClickContext | undefined, string] => {
    const sourceCoordinate = `${fromX},${fromY}`
    const sourceTile = getTileInstance(fromX, fromY)
    if (!sourceTile) {
        return [undefined, `source ${sourceCoordinate}: tile not found`]
    }

    const sourceTilePart = resolveTileBasePart(sourceTile)
    if (!sourceTilePart) {
        return [undefined, `source ${sourceCoordinate}: tile base part not found`]
    }

    const sourcePiece = targets?.fromTarget ?? Board.getPiece(sourceCoordinate)
    if (!sourcePiece) {
        return [undefined, `source ${sourceCoordinate}: piece not found`]
    }

    const sourceAllowedHits: Instance[] = []
    pushUniqueInstance(sourceAllowedHits, sourcePiece)
    pushUniqueInstance(sourceAllowedHits, sourceTile)

    const destinationCoordinate = `${toX},${toY}`
    const destinationTile = getTileInstance(toX, toY) ?? targets?.toTarget
    if (!destinationTile) {
        return [undefined, `destination ${destinationCoordinate}: tile not found`]
    }

    const destinationTilePart = resolveTileBasePart(destinationTile)
    if (!destinationTilePart) {
        return [
            undefined,
            `destination ${destinationCoordinate}: tile base part not found`,
        ]
    }

    const destinationPiece = Board.getPiece(destinationCoordinate)
    const destinationAllowedHits: Instance[] = []
    if (destinationPiece) {
        pushUniqueInstance(destinationAllowedHits, destinationPiece)
    }
    pushUniqueInstance(destinationAllowedHits, destinationTile)

    const sourceContext: ClickResolutionContext = {
        phase: "source",
        coordinate: sourceCoordinate,
        tile: sourceTile,
        tilePart: sourceTilePart,
        piece: sourcePiece,
        button: "left",
        allowedHits: sourceAllowedHits,
        allowPieceSamplingFallback: true,
    }

    const destinationContext: ClickResolutionContext = {
        phase: "destination",
        coordinate: destinationCoordinate,
        tile: destinationTile,
        tilePart: destinationTilePart,
        piece: destinationPiece,
        button: "left",
        allowedHits: destinationAllowedHits,
        allowPieceSamplingFallback: destinationPiece !== undefined,
    }

    return [
        {
            source: sourceContext,
            destination: destinationContext,
        },
        "ok",
    ]
}

const moveRelativeChunked = (
    deltaX: number,
    deltaY: number
): [boolean, string] => {
    let remainingX = deltaX
    let remainingY = deltaY

    while (remainingX !== 0 || remainingY !== 0) {
        const stepX =
            math.abs(remainingX) > RELATIVE_MOVE_MAX_STEP_PIXELS
                ? RELATIVE_MOVE_MAX_STEP_PIXELS * math.sign(remainingX)
                : remainingX
        const stepY =
            math.abs(remainingY) > RELATIVE_MOVE_MAX_STEP_PIXELS
                ? RELATIVE_MOVE_MAX_STEP_PIXELS * math.sign(remainingY)
                : remainingY

        const [didMoveStep, stepError] = pcall(() => mousemoverel(stepX, stepY))
        if (!didMoveStep) {
            return [false, `mousemoverel failed (${stepError})`]
        }

        remainingX -= stepX
        remainingY -= stepY
        task.wait(RELATIVE_MOVE_STEP_DELAY_SECONDS)
    }

    return [true, "mouse moved(rel) by chunked delta"]
}

const getCursorOffsetToTarget = (
    targetX: number,
    targetY: number
): [number, number] => {
    const cursor = UserInputService.GetMouseLocation()
    const offsetX = targetX - math.floor(cursor.X)
    const offsetY = targetY - math.floor(cursor.Y)
    return [offsetX, offsetY]
}

const waitCursorArrival = (targetX: number, targetY: number): [boolean, number, number] => {
    let finalOffsetX = 0
    let finalOffsetY = 0

    for (let i = 0; i < RELATIVE_MOVE_ARRIVAL_MAX_POLLS; i++) {
        const [offsetX, offsetY] = getCursorOffsetToTarget(targetX, targetY)
        finalOffsetX = offsetX
        finalOffsetY = offsetY

        if (
            math.abs(offsetX) <= RELATIVE_MOVE_ARRIVAL_TOLERANCE_PIXELS &&
            math.abs(offsetY) <= RELATIVE_MOVE_ARRIVAL_TOLERANCE_PIXELS
        ) {
            return [true, offsetX, offsetY]
        }

        task.wait(RELATIVE_MOVE_ARRIVAL_POLL_DELAY_SECONDS)
    }

    return [false, finalOffsetX, finalOffsetY]
}

const moveMouseToScreen = (
    screenPosition: Vector3,
    moveMode: MouseMoveMode,
    relativeAnchor?: Vector2
): [boolean, string] => {
    const targetX = math.floor(screenPosition.X)
    const targetY = math.floor(screenPosition.Y)

    if (moveMode === "absolute") {
        if (!ensure_executor_functions_access(mousemoveabs)) {
            return [false, "mousemoveabs is not supported by current executor"]
        }

        const [didMoveAbsolute, absoluteError] = pcall(() =>
            mousemoveabs(targetX, targetY)
        )
        if (!didMoveAbsolute) {
            return [false, `mousemoveabs failed (${absoluteError})`]
        }

        lastInjectedMousePosition = new Vector2(targetX, targetY)
        task.wait(0.02)
        return [true, `mouse moved(abs) to ${targetX},${targetY}`]
    }

    if (!ensure_executor_functions_access(mousemoverel)) {
        return [false, "mousemoverel is not supported by current executor"]
    }

    const anchor =
        relativeAnchor ?? lastInjectedMousePosition ?? UserInputService.GetMouseLocation()
    let deltaX = targetX - math.floor(anchor.X)
    let deltaY = targetY - math.floor(anchor.Y)

    for (let attempt = 0; attempt <= RELATIVE_MOVE_RETRY_ATTEMPTS; attempt++) {
        const [didMoveRelative, moveError] = moveRelativeChunked(deltaX, deltaY)
        if (!didMoveRelative) {
            return [false, `${moveError}`]
        }

        const [arrived, offsetX, offsetY] = waitCursorArrival(targetX, targetY)
        if (arrived) {
            task.wait(0.02)
            lastInjectedMousePosition = new Vector2(targetX, targetY)
            return [true, `mouse moved(rel) to ${targetX},${targetY}`]
        }

        if (attempt >= RELATIVE_MOVE_RETRY_ATTEMPTS) {
            return [
                false,
                `mousemoverel not settled (dx=${offsetX}, dy=${offsetY})`,
            ]
        }

        deltaX = offsetX
        deltaY = offsetY
    }

    return [false, "mousemoverel not settled (unknown)"]
}

const clickContextViaMouseApi = (
    context: ClickResolutionContext,
    relativeAnchor?: Vector2
): [boolean, string, Vector2 | undefined] => {
    const [screenPosition, pointMessage] = resolveTopVisibleScreenPoint(context)
    if (!screenPosition) {
        return [
            false,
            `${context.phase} ${context.coordinate} failed (${pointMessage})`,
            undefined,
        ]
    }

    const moveMode: MouseMoveMode =
        context.phase === "source" ? "absolute" : "relative"
    const [didMove, moveMessage] = moveMouseToScreen(
        screenPosition,
        moveMode,
        relativeAnchor
    )
    if (!didMove) {
        return [
            false,
            `${context.phase} ${context.coordinate} failed (${moveMessage})`,
            undefined,
        ]
    }

    task.wait(mouseClickDelaySeconds)

    const [didClick, clickError] = pcall(() => {
        mouse1click()
    })

    if (!didClick) {
        return [
            false,
            `${context.phase} ${context.coordinate} click failed (${clickError})`,
            undefined,
        ]
    }

    task.wait(0.03)
    const clickedPoint = new Vector2(
        math.floor(screenPosition.X),
        math.floor(screenPosition.Y)
    )
    return [
        true,
        `${context.button} clicked ${context.phase} ${context.coordinate} @ screen(${math.floor(screenPosition.X)},${math.floor(screenPosition.Y)}) (${pointMessage})`,
        clickedPoint,
    ]
}

const executeRemoteEvent = (move: string, board: Board): [boolean, string] => {
    const movePieceEvent = getMovePieceEvent()
    if (!movePieceEvent) {
        return [false, "MovePiece remote not found"]
    }

    const matchId = updateMatchIdFromBoard(board)
    if (matchId === undefined) {
        return [false, "invalid match id"]
    }

    const [fromX, fromY, toX, toY] = getPosFromResult(move)
    const fromPosition = [fromX, fromY] as MovePosition
    const toPosition = [toX, toY] as MovePosition

    const pieceData = board.getPieceDataAt(fromX, fromY)
    const pieceName = getPieceName(pieceData)
    const isPawn = pieceName === "Pawn"

    if (isPawn) {
        toPosition.doubleStep = resolveDoubleStep(pieceData)

        if (fromX === toX) {
            toPosition.moveOnly = true
        }
    }

    const [fired, errorMessage] = pcall(() =>
        movePieceEvent.FireServer(matchId, fromPosition, toPosition, {})
    )
    if (!fired) {
        return [false, `failed to fire MovePiece (${errorMessage})`]
    }

    return [true, `remote sent: id=${matchId}, move=${move}`]
}

const executeMouseApi = (
    move: string,
    _board: Board,
    targets?: AutoPlayTargets
): [boolean, string] => {
    if (!ensure_executor_functions_access(mousemoveabs, mousemoverel, mouse1click)) {
        return [false, "mouse API is not supported by current executor"]
    }

    const [fromX, fromY, toX, toY] = getPosFromResult(move)
    const [clickContext, contextMessage] = buildClickContext(
        fromX,
        fromY,
        toX,
        toY,
        targets
    )
    if (!clickContext) {
        return [false, contextMessage]
    }

    const [didClickFrom, fromClickMessage, fromClickedPoint] =
        clickContextViaMouseApi(clickContext.source)
    if (!didClickFrom) {
        return [false, fromClickMessage]
    }

    task.wait(mouseStepDelaySeconds)

    const [didClickTo, toClickMessage] = clickContextViaMouseApi(
        clickContext.destination,
        fromClickedPoint
    )
    if (!didClickTo) {
        return [false, toClickMessage]
    }

    return [
        true,
        `mouse move sent: ${move} (${fromClickMessage}; ${toClickMessage})`,
    ]
}

const api: RemoteAutoplayApi = {
    startMatchIdListener: (): [boolean, string] => {
        if (hasStartedListener) {
            return [true, "start game listener already active"]
        }

        const connections = getConnectionsFolder()
        if (!connections) {
            return [false, "Connections folder not found"]
        }

        const startGame = connections.FindFirstChild("StartGame")
        if (!startGame || !startGame.IsA("RemoteEvent")) {
            return [false, "StartGame remote not found"]
        }

        startGame.OnClientEvent.Connect((payload: unknown) => {
            if (type(payload) !== "table") {
                return
            }

            const id = parseNumber((payload as StartGamePayload).id)
            if (id !== undefined) {
                lastMatchId = id
            }
        })

        hasStartedListener = true
        return [true, "start game listener connected"]
    },

    getCurrentMatchId: (board?: Board): number | undefined => {
        return updateMatchIdFromBoard(board)
    },

    supportsMouseApi: (): boolean => {
        return ensure_executor_functions_access(
            mousemoveabs,
            mousemoverel,
            mouse1click
        )
    },

    setMouseStepDelaySeconds: (seconds: number) => {
        if (type(seconds) !== "number") {
            return
        }

        mouseStepDelaySeconds = math.clamp(seconds, 0.01, 5)
    },

    setMouseClickDelaySeconds: (seconds: number) => {
        if (type(seconds) !== "number") {
            return
        }

        mouseClickDelaySeconds = math.clamp(seconds, 0.01, 5)
    },

    execute: (
        move: string,
        board: Board,
        method: AutoPlayMethod,
        targets?: AutoPlayTargets
    ): [boolean, string] => {
        if (method === "Mouse API") {
            return executeMouseApi(move, board, targets)
        }

        return executeRemoteEvent(move, board)
    },
}

export = api
