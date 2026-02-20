local mod = {
	pieces = {
		["Pawn"] = "p",
		["Knight"] = "n",
		["Bishop"] = "b",
		["Rook"] = "r",
		["Queen"] = "q",
		["King"] = "k",
	},
}
mod.__index = mod

local lplayer = game:GetService("Players").LocalPlayer

---@return any[]
function mod.getClient()
	for _, v in pairs(getreg()) do
		if type(v) == "function" and not iscclosure(v) then
			for _, v in pairs(debug.getupvalues(v)) do
				if type(v) == "table" and v.processRound then
					return v
				end
			end
		end
	end
end

---@return Instance | nil
function mod.getPiece(tile)
	local rayOrigin
	local boardRoot = game:GetService("Workspace"):FindFirstChild("Board")
	if not boardRoot then
		return nil
	end

	local boardTile = boardRoot:FindFirstChild(tile)
	if not boardTile then
		return nil
	end

	if boardTile.ClassName == "Model" then
		if boardTile:FindFirstChild("Meshes/tile_a") then
			rayOrigin = boardTile["Meshes/tile_a"].Position
		else
			local tilePart = boardTile:FindFirstChild("Tile")
			if not tilePart then
				return nil
			end
			rayOrigin = tilePart.Position
		end
	else
		rayOrigin = boardTile.Position
	end

	local rayDirection = Vector3.new(0, 10, 0)

	local raycastResult = workspace:Raycast(rayOrigin, rayDirection)

	if raycastResult ~= nil then
		return raycastResult.Instance.Parent
	end

	return nil
end

function mod.gameInProgress()
	return #game:GetService("Workspace").Board:GetChildren() > 0
end

function mod.new()
	local self = setmetatable({}, mod)
	self.client = self.getClient()
	self.cachedBoardRef = nil

	return self
end

local function findPieceAtPosition(pieceList, x, y)
	if type(pieceList) ~= "table" then
		return nil
	end

	for _, pieceData in pairs(pieceList) do
		if pieceData and pieceData.position then
			local pieceX, pieceY = pieceData.position[1], pieceData.position[2]
			if pieceX == x and pieceY == y then
				return pieceData
			end
		end
	end

	return nil
end

local function countPieces(pieceList)
	if type(pieceList) ~= "table" then
		return 0
	end

	local total = 0
	for _, pieceData in pairs(pieceList) do
		if pieceData and pieceData.position and pieceData.object then
			total += 1
		end
	end

	return total
end

local function hasKing(pieceList)
	if type(pieceList) ~= "table" then
		return false
	end

	for _, pieceData in pairs(pieceList) do
		if pieceData and pieceData.object and pieceData.object.Name == "King" then
			return true
		end
	end

	return false
end

local function isUsableBoardState(boardState)
	if type(boardState) ~= "table" then
		return false
	end
	if not boardState.tiles or not boardState.players then
		return false
	end
	if type(boardState.whitePieces) ~= "table" or type(boardState.blackPieces) ~= "table" then
		return false
	end
	if countPieces(boardState.whitePieces) == 0 or countPieces(boardState.blackPieces) == 0 then
		return false
	end
	if not hasKing(boardState.whitePieces) or not hasKing(boardState.blackPieces) then
		return false
	end

	return true
end

---@return any[] | nil
function mod:getBoard()
	if not self.client or type(self.client.processRound) ~= "function" then
		self.client = self.getClient()
	end

	if not self.client or type(self.client.processRound) ~= "function" then
		return nil
	end

	if isUsableBoardState(self.cachedBoardRef) then
		return self.cachedBoardRef
	end

	for _, v in pairs(debug.getupvalues(self.client.processRound)) do
		if isUsableBoardState(v) then
			self.cachedBoardRef = v
			return v
		end
	end

	self.cachedBoardRef = nil
	return nil
end

---@return any[] | nil
function mod:getRawMatch()
	return self:getBoard()
end

---@return any[] | nil
function mod:getPieceDataAt(x, y)
	local board = self:getBoard()
	if not board then
		return nil
	end

	local whitePiece = findPieceAtPosition(board.whitePieces, x, y)
	if whitePiece then
		return whitePiece
	end

	return findPieceAtPosition(board.blackPieces, x, y)
end

---@return boolean
function mod:isBotMatch()
	local board = self:getBoard()

	if not board or not board.players then
		return false
	end
	if board.players[false] == lplayer and board.players[true] == lplayer then
		return true
	end

	return false
end

---@return "w" | "b" | nil
function mod:getLocalTeam()
	local board = self:getBoard()
	if not board or not board.players then
		return nil
	end
	-- Bot match detection
	if self:isBotMatch() then
		return "w"
	end

	for i, v in pairs(board.players) do
		if v == lplayer then
			-- If the index is true, they are white
			if i then
				return "w"
			else
				return "b"
			end
		end
	end

	return nil
end

---@return boolean
function mod:isPlayerTurn()
	local team = self:getLocalTeam()
	if not team then
		return false
	end

	local guiName = if team == "w" then "White" else "Black"
	local playerGui = lplayer:FindFirstChild("PlayerGui")
	local gameStatus = if playerGui then playerGui:FindFirstChild("GameStatus") else nil
	local teamGui = if gameStatus then gameStatus:FindFirstChild(guiName) else nil

	if teamGui and teamGui.Visible then
		return true
	end

	return false
end

---Check if we're able to run without desyncing
---@return boolean
function mod:willCauseDesync()
	local board = self:getBoard()

	if not board then
		return false
	end

	local state, _ = pcall(function()
		if self:isBotMatch() then
			return board.activeTeam == false
		end
	end)

	if not state then
		return false
	end

	if not board.players then
		return true
	end

	for i, v in pairs(board.players) do
		if v == lplayer then
			-- If the index is true, they are white
			return not (board.activeTeam == i)
		end
	end

	return true
end

---Converts awful format of board table to a sensible one
---@return any[] | nil
function mod:createBoard()
	local board = self:getBoard()
	if not board then
		return nil
	end

	local newBoard = {}
	for _, v in pairs(board.whitePieces) do
		if v and v.position then
			local x, y = v.position[1], v.position[2]
			if not newBoard[x] then
				newBoard[x] = {}
			end
			newBoard[x][y] = string.upper(self.pieces[v.object.Name])
		end
	end
	for _, v in pairs(board.blackPieces) do
		if v and v.position then
			local x, y = v.position[1], v.position[2]
			if not newBoard[x] then
				newBoard[x] = {}
			end
			newBoard[x][y] = self.pieces[v.object.Name]
		end
	end

	return newBoard
end

---@return string | nil
function mod:board2fen()
	local board = self:createBoard()
	if not board then
		return nil
	end

	local result = ""
	local boardPieces = board
	for y = 8, 1, -1 do
		local empty = 0
		for x = 8, 1, -1 do
			if not boardPieces[x] then
				boardPieces[x] = {}
			end
			local piece = boardPieces[x][y]
			if piece then
				if empty > 0 then
					result = result .. tostring(empty)
					empty = 0
				end
				result = result .. piece
			else
				empty += 1
			end
		end
		if empty > 0 then
			result = result .. tostring(empty)
		end
		if not (y == 1) then
			result = result .. "/"
		end
	end
	if result == "8/8/8/8/8/8/8/8" then
		return nil
	end
	if not string.find(result, "K", 1, true) or not string.find(result, "k", 1, true) then
		return nil
	end

	local team = self:getLocalTeam()
	if not team then
		return nil
	end

	result = result .. " " .. team
	return result
end

return mod
