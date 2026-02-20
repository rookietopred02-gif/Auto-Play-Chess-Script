import {
    Debris,
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
let mouseStepDelaySeconds = 0
let mouseClickDelaySeconds = 0
let mouseAbsCoordMode: "screen" | "viewport" | undefined

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
const DEBUG_POINT_MARKER_SIZE = 0.1
const DEBUG_POINT_MARKER_LIFETIME_SECONDS = 6
const DEBUG_POINT_MARKER_WORLD_OFFSET_Y = 0
const DEBUG_POINT_MARKER_PIXEL_SIZE = 18

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

interface SampleHitPoint {
    screen: Vector3
    world: Vector3
}

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

const getDebugPointStorage = (): Folder => {
    const existing = Workspace.FindFirstChild("AutoPlayDebugPoints")
    if (existing && existing.IsA("Folder")) {
        return existing
    }

    const folder = new Instance("Folder")
    folder.Name = "AutoPlayDebugPoints"
    folder.Parent = Workspace
    return folder
}

const createDebugPointMarker = (
    worldPoint: Vector3,
    phase: ClickPhase
): void => {
    const markerColor =
        phase === "source"
            ? Color3.fromRGB(24, 255, 170)
            : Color3.fromRGB(255, 166, 46)

    const marker = new Instance("Part")
    marker.Name = phase === "source" ? "AutoPlaySourcePoint" : "AutoPlayDestinationPoint"
    marker.Shape = Enum.PartType.Ball
    marker.Material = Enum.Material.SmoothPlastic
    marker.Color = markerColor
    marker.Size = new Vector3(
        DEBUG_POINT_MARKER_SIZE,
        DEBUG_POINT_MARKER_SIZE,
        DEBUG_POINT_MARKER_SIZE
    )
    marker.Transparency = 1
    marker.Anchored = true
    marker.CanCollide = false
    marker.CanTouch = false
    marker.CanQuery = false
    marker.CastShadow = false
    marker.CFrame = new CFrame(
        worldPoint.add(new Vector3(0, DEBUG_POINT_MARKER_WORLD_OFFSET_Y, 0))
    )
    marker.Parent = getDebugPointStorage()

    const billboard = new Instance("BillboardGui")
    billboard.Name = "DebugPoint"
    billboard.AlwaysOnTop = true
    billboard.LightInfluence = 0
    billboard.ResetOnSpawn = false
    billboard.Size = UDim2.fromOffset(
        DEBUG_POINT_MARKER_PIXEL_SIZE,
        DEBUG_POINT_MARKER_PIXEL_SIZE
    )
    billboard.Parent = marker

    const dot = new Instance("Frame")
    dot.Name = "Dot"
    dot.AnchorPoint = new Vector2(0.5, 0.5)
    dot.Position = UDim2.fromScale(0.5, 0.5)
    dot.Size = UDim2.fromScale(1, 1)
    dot.BackgroundColor3 = markerColor
    dot.BorderSizePixel = 0
    dot.Parent = billboard

    const dotCorner = new Instance("UICorner")
    dotCorner.CornerRadius = new UDim(1, 0)
    dotCorner.Parent = dot

    const dotStroke = new Instance("UIStroke")
    dotStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
    dotStroke.Thickness = 2
    dotStroke.Color =
        phase === "source"
            ? Color3.fromRGB(0, 70, 50)
            : Color3.fromRGB(92, 56, 0)
    dotStroke.Parent = dot

    Debris.AddItem(marker, DEBUG_POINT_MARKER_LIFETIME_SECONDS)
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

const pickInteriorSampleHitPoint = (points: SampleHitPoint[]): SampleHitPoint => {
    if (points.size() === 1) {
        return points[0]
    }

    let centroidX = 0
    let centroidY = 0
    for (const point of points) {
        centroidX += point.screen.X
        centroidY += point.screen.Y
    }

    const pointCount = points.size()
    centroidX /= pointCount
    centroidY /= pointCount

    let bestPoint = points[0]
    let bestDistance = math.huge
    for (const point of points) {
        const deltaX = point.screen.X - centroidX
        const deltaY = point.screen.Y - centroidY
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
): [SampleHitPoint | undefined, string] => {
    if (worldPoints.size() === 0) {
        return [undefined, `${stageName}: no candidate points`]
    }

    let visibleSampleCount = 0
    const topHitPoints: SampleHitPoint[] = []
    let firstBlockingHit: string | undefined

    for (const worldPoint of worldPoints) {
        const [screenPoint, isVisible] = camera.WorldToScreenPoint(worldPoint)
        if (!isVisible) {
            continue
        }

        visibleSampleCount += 1

        const ray = camera.ScreenPointToRay(screenPoint.X, screenPoint.Y)
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
        topHitPoints.push({
            screen: new Vector3(screenPoint.X, screenPoint.Y, screenPoint.Z),
            world: hit.Position,
        })
    }

    if (topHitPoints.size() > 0) {
        const interiorPoint = pickInteriorSampleHitPoint(topHitPoints)
        return [
            interiorPoint,
            `${stageName}: ${topHitPoints.size()} visible top-hit points`,
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
): [SampleHitPoint | undefined, string] => {
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
        // Keep destination targeting on tile interior samples only.
        allowPieceSamplingFallback: false,
    }

    return [
        {
            source: sourceContext,
            destination: destinationContext,
        },
        "ok",
    ]
}

const getCurrentCursorPosition = (): Vector2 => {
    const cursor = UserInputService.GetMouseLocation()
    return new Vector2(math.round(cursor.X), math.round(cursor.Y))
}

const resolveMoveTargetFromCalculatedPoint = (
    resolvedPoint: SampleHitPoint
): [
    | {
          screenX: number
          screenY: number
          viewportX: number
          viewportY: number
      }
    | undefined,
    string,
] => {
    const fallbackX = math.round(resolvedPoint.screen.X)
    const fallbackY = math.round(resolvedPoint.screen.Y)
    const camera = Workspace.CurrentCamera
    if (camera) {
        const markerWorldPoint = resolvedPoint.world
        const [markerScreenPoint, screenVisible] =
            camera.WorldToScreenPoint(markerWorldPoint)
        const [markerViewportPoint, viewportVisible] =
            camera.WorldToViewportPoint(markerWorldPoint)
        if (screenVisible || viewportVisible) {
            return [
                {
                    screenX: math.round(markerScreenPoint.X),
                    screenY: math.round(markerScreenPoint.Y),
                    viewportX: math.round(markerViewportPoint.X),
                    viewportY: math.round(markerViewportPoint.Y),
                },
                "marker-projected",
            ]
        }
    }

    return [
        {
            screenX: fallbackX,
            screenY: fallbackY,
            viewportX: fallbackX,
            viewportY: fallbackY,
        },
        "resolved-screen-fallback",
    ]
}

const moveAbsoluteToTarget = (
    target: {
        screenX: number
        screenY: number
        viewportX: number
        viewportY: number
    }
): [boolean, string, number, number, Vector2] => {
    let cursorAfterMove = getCurrentCursorPosition()

    const tryMode = (
        mode: "screen" | "viewport"
    ): [
        boolean,
        string,
        | {
              dx: number
              dy: number
              cursor: Vector2
              score: number
          }
        | undefined,
        ("screen" | "viewport") | undefined,
    ] => {
        const commandX = mode === "viewport" ? target.viewportX : target.screenX
        const commandY = mode === "viewport" ? target.viewportY : target.screenY
        const [didMoveAbsolute, moveError] = pcall(() =>
            mousemoveabs(commandX, commandY)
        )
        if (!didMoveAbsolute) {
            return [false, `mousemoveabs failed (${moveError})`, undefined, undefined]
        }

        task.wait()
        cursorAfterMove = getCurrentCursorPosition()
        const dx = math.round(target.screenX - cursorAfterMove.X)
        const dy = math.round(target.screenY - cursorAfterMove.Y)
        return [
            true,
            `mouse moved(abs/${mode}) target=${target.screenX},${target.screenY} cmd=${commandX},${commandY} dx=${dx} dy=${dy}`,
            {
                dx,
                dy,
                cursor: cursorAfterMove,
                score: math.abs(dx) + math.abs(dy),
            },
            mode,
        ]
    }

    if (mouseAbsCoordMode === undefined) {
        const [okScreen, msgScreen, stateScreen, modeScreen] = tryMode("screen")
        const [okViewport, msgViewport, stateViewport, modeViewport] =
            tryMode("viewport")

        if (okScreen && okViewport && stateScreen && stateViewport && modeScreen) {
            if (stateViewport.score < stateScreen.score && modeViewport) {
                mouseAbsCoordMode = modeViewport
                return [
                    true,
                    msgViewport,
                    stateViewport.dx,
                    stateViewport.dy,
                    stateViewport.cursor,
                ]
            }

            mouseAbsCoordMode = modeScreen
            const [okScreen2, msgScreen2, stateScreen2] = tryMode(modeScreen)
            if (okScreen2 && stateScreen2) {
                return [
                    true,
                    msgScreen2,
                    stateScreen2.dx,
                    stateScreen2.dy,
                    stateScreen2.cursor,
                ]
            }

            return [
                true,
                msgScreen,
                stateScreen.dx,
                stateScreen.dy,
                stateScreen.cursor,
            ]
        }

        if (okScreen && stateScreen && modeScreen) {
            mouseAbsCoordMode = modeScreen
            return [
                true,
                msgScreen,
                stateScreen.dx,
                stateScreen.dy,
                stateScreen.cursor,
            ]
        }

        if (okViewport && stateViewport && modeViewport) {
            mouseAbsCoordMode = modeViewport
            return [
                true,
                msgViewport,
                stateViewport.dx,
                stateViewport.dy,
                stateViewport.cursor,
            ]
        }

        return [
            false,
            `abs move failed in both modes (screen: ${msgScreen}; viewport: ${msgViewport})`,
            0,
            0,
            cursorAfterMove,
        ]
    }

    const [ok, msg, state] = tryMode(mouseAbsCoordMode)
    if (ok && state) {
        return [true, msg, state.dx, state.dy, state.cursor]
    }

    const otherMode: "screen" | "viewport" =
        mouseAbsCoordMode === "screen" ? "viewport" : "screen"
    const [okOther, msgOther, otherState] = tryMode(otherMode)
    if (okOther && otherState) {
        mouseAbsCoordMode = otherMode
        return [true, msgOther, otherState.dx, otherState.dy, otherState.cursor]
    }

    return [false, `abs move failed (${msg}; ${msgOther})`, 0, 0, cursorAfterMove]
}

const applyClickNudge = (): [boolean, string] => {
    const [didNudgeOut, nudgeOutError] = pcall(() => mousemoverel(1, 1))
    if (!didNudgeOut) {
        return [false, `mousemoverel nudge-out failed (${nudgeOutError})`]
    }

    const [didNudgeBack, nudgeBackError] = pcall(() => mousemoverel(-1, -1))
    if (!didNudgeBack) {
        return [false, `mousemoverel nudge-back failed (${nudgeBackError})`]
    }

    return [true, "nudge ok"]
}

const clickContextCommon = (
    context: ClickResolutionContext,
    resolvedPoint: SampleHitPoint,
    pointMessage: string
): [boolean, string, Vector2 | undefined] => {
    const [target, targetSource] = resolveMoveTargetFromCalculatedPoint(resolvedPoint)
    if (!target) {
        return [false, `${context.phase} ${context.coordinate} failed (${targetSource})`, undefined]
    }
    const [didMove, moveMessage] = moveAbsoluteToTarget(target)
    if (!didMove) {
        return [false, `${context.phase} ${context.coordinate} failed (${moveMessage})`, undefined]
    }
    task.wait(0.1)
    const [didNudge, nudgeMessage] = applyClickNudge()
    if (!didNudge) {
        return [false, `${context.phase} ${context.coordinate} failed (${nudgeMessage})`, undefined]
    }
    const [didMove2, moveMessage2] = moveAbsoluteToTarget(target)
    if (!didMove2) {
        return [false, `${context.phase} ${context.coordinate} failed (${moveMessage2})`, undefined]
    }
    task.wait()
    mouse1click()

    const clickedPoint = getCurrentCursorPosition()
    return [
        true,
        `${context.button} clicked ${context.phase} ${context.coordinate} @ screen(${clickedPoint.X},${clickedPoint.Y}) world(${math.round(resolvedPoint.world.X * 100) / 100},${math.round(resolvedPoint.world.Y * 100) / 100},${math.round(resolvedPoint.world.Z * 100) / 100}) (${pointMessage}; target=${target.screenX},${target.screenY} via ${targetSource}; ${moveMessage}; ${nudgeMessage}; ${moveMessage2})`,
        clickedPoint,
    ]
}

const clickSourceContext = clickContextCommon
const clickDestinationContext = clickContextCommon

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
    if (!ensure_executor_functions_access(mousemoverel, mousemoveabs, mouse1click)) {
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

    const [sourcePoint, sourcePointMessage] = resolveTopVisibleScreenPoint(
        clickContext.source
    )
    if (!sourcePoint) {
        return [
            false,
            `${clickContext.source.phase} ${clickContext.source.coordinate} failed (${sourcePointMessage})`,
        ]
    }

    const [destinationPoint, destinationPointMessage] = resolveTopVisibleScreenPoint(
        clickContext.destination
    )
    if (!destinationPoint) {
        return [
            false,
            `${clickContext.destination.phase} ${clickContext.destination.coordinate} failed (${destinationPointMessage})`,
        ]
    }

    // Always materialize both debug points first, so the two calculated targets are visible.
    createDebugPointMarker(sourcePoint.world, "source")
    createDebugPointMarker(destinationPoint.world, "destination")

    const [didClickFrom, fromClickMessage] = clickSourceContext(
        clickContext.source,
        sourcePoint,
        sourcePointMessage
    )
    if (!didClickFrom) {
        return [false, fromClickMessage]
    }

    task.wait(math.max(mouseStepDelaySeconds, 0.1))

    const [didClickTo, toClickMessage] = clickDestinationContext(
        clickContext.destination,
        destinationPoint,
        destinationPointMessage
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
        return ensure_executor_functions_access(mousemoverel, mousemoveabs, mouse1click)
    },

    setMouseStepDelaySeconds: (seconds: number) => {
        if (type(seconds) !== "number") {
            return
        }

        mouseStepDelaySeconds = math.clamp(seconds, 0, 5)
    },

    setMouseClickDelaySeconds: (seconds: number) => {
        if (type(seconds) !== "number") {
            return
        }

        mouseClickDelaySeconds = math.clamp(seconds, 0, 5)
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
