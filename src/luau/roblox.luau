--!nocheck
--[[
	Roblox-flavoured layer.

	Loaded before `prelude.luau`, so it must not touch engine internals at load
	time -- but Luau resolves globals when a function *runs*, not when it is
	defined, so the service bodies below can freely call `keyboard_check`,
	`instance_find` and friends once the prelude is in.

	The prelude drives this layer through `__rbx`: it fires the frame signals,
	pumps the task scheduler, and hands over the live instance list.
]]

--=============================================================================
-- Signal
--=============================================================================

local Connection = {}
Connection.__index = Connection

function Connection.Disconnect(self)
	if not self.Connected then
		return
	end
	self.Connected = false

	local handlers = self._signal._handlers
	local index = table.find(handlers, self)
	if index then
		table.remove(handlers, index)
	end
end

Connection.disconnect = Connection.Disconnect

-- Global rather than local: `_G` is readonly in this sandbox, so assigning a
-- global directly is how the engine exposes anything to game code.
Signal = {}
Signal.__index = Signal

function Signal.new()
	return setmetatable({ _handlers = {}, _waiting = {} }, Signal)
end

function Signal.Connect(self, handler)
	if type(handler) ~= "function" then
		error("Connect expects a function", 2)
	end
	local connection = setmetatable({
		Connected = true,
		_signal = self,
		_handler = handler,
	}, Connection)
	table.insert(self._handlers, connection)
	return connection
end

--- Connect a handler that disconnects itself after the first fire.
function Signal.Once(self, handler)
	local connection
	connection = self:Connect(function(...)
		connection:Disconnect()
		handler(...)
	end)
	return connection
end

function Signal.Fire(self, ...)
	-- Iterate a copy: handlers are allowed to disconnect during dispatch.
	for _, connection in table.clone(self._handlers) do
		if connection.Connected then
			connection._handler(...)
		end
	end

	if #self._waiting > 0 then
		local waiting = self._waiting
		self._waiting = {}
		for _, thread in waiting do
			local ok, err = coroutine.resume(thread, ...)
			if not ok then
				error(err, 0)
			end
		end
	end
end

--- Yield the calling thread until this signal next fires.
function Signal.Wait(self)
	local thread = coroutine.running()
	if not thread then
		error("Signal:Wait() can only be called inside task.spawn or task.delay", 2)
	end
	table.insert(self._waiting, thread)
	return coroutine.yield()
end

function Signal.DisconnectAll(self)
	for _, connection in self._handlers do
		connection.Connected = false
	end
	table.clear(self._handlers)
	table.clear(self._waiting)
end

-- Lowercase aliases, since the rest of this engine is snake_case.
Signal.connect = Signal.Connect
Signal.once = Signal.Once
Signal.fire = Signal.Fire
Signal.wait = Signal.Wait

--=============================================================================
-- task scheduler
--=============================================================================

local clock = 0
local queue: { any } = {}

task = {}

--- Run `fn` immediately on its own thread, so it may yield.
function task.spawn(fn, ...)
	local thread = if type(fn) == "thread" then fn else coroutine.create(fn)
	local ok, err = coroutine.resume(thread, ...)
	if not ok then
		error(err, 0)
	end
	return thread
end

--- Run `fn` on the next step.
function task.defer(fn, ...)
	table.insert(queue, { at = clock, thread = coroutine.create(fn), args = table.pack(...) })
end

--- Run `fn` after `seconds`.
function task.delay(seconds, fn, ...)
	table.insert(queue, {
		at = clock + math.max(0, seconds or 0),
		thread = coroutine.create(fn),
		args = table.pack(...),
	})
end

--- Yield the current thread. Returns the seconds actually waited.
function task.wait(seconds)
	local thread = coroutine.running()
	if not thread then
		error("task.wait() can only be called inside task.spawn, task.delay or a signal handler", 2)
	end
	table.insert(queue, { at = clock + math.max(0, seconds or 0), thread = thread, resume = true })
	return coroutine.yield()
end

function task.cancel(thread)
	for index = #queue, 1, -1 do
		if queue[index].thread == thread then
			table.remove(queue, index)
		end
	end
end

wait = task.wait

--=============================================================================
-- JSON, used by DataStore and exposed through HttpService
--=============================================================================

local ESCAPES = {
	['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b",
	["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
}

local function encodeString(text: string): string
	return '"' .. (string.gsub(text, '[%c"\\]', function(char)
		return ESCAPES[char] or string.format("\\u%04x", string.byte(char))
	end)) .. '"'
end

local function isArray(value): boolean
	local count = 0
	for _ in value do
		count += 1
	end
	return count == #value
end

local function encodeValue(value): string
	local kind = type(value)

	if value == nil then
		return "null"
	elseif kind == "boolean" then
		return tostring(value)
	elseif kind == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			error("cannot encode NaN or infinity")
		end
		return if value % 1 == 0 then string.format("%d", value) else tostring(value)
	elseif kind == "string" then
		return encodeString(value)
	elseif kind == "table" then
		local parts = {}
		if isArray(value) then
			for _, item in value do
				table.insert(parts, encodeValue(item))
			end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for key, item in value do
			if type(key) ~= "string" then
				error("JSON object keys must be strings")
			end
			table.insert(parts, encodeString(key) .. ":" .. encodeValue(item))
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end

	error(`cannot encode a value of type {kind}`)
end

--[[
	Decoder returning `(ok, value, nextIndex)` rather than raising.

	It has to: `pcall` in this Luau build does not actually catch errors -- they
	propagate straight out to the host -- so a game reading back a corrupt save
	would die instead of falling back to its default.
]]
local ESCAPE_CHARS = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }

local function skipSpace(text: string, index: number): number
	while index <= #text and string.find(string.sub(text, index, index), "%s") do
		index += 1
	end
	return index
end

local function decodeValue(text: string, index: number): (boolean, any, number)
	index = skipSpace(text, index)
	if index > #text then
		return false, nil, index
	end

	local char = string.sub(text, index, index)

	if char == "{" then
		local object = {}
		index += 1
		while true do
			index = skipSpace(text, index)
			if index > #text then
				return false, nil, index
			end
			if string.sub(text, index, index) == "}" then
				return true, object, index + 1
			end

			local ok, key
			ok, key, index = decodeValue(text, index)
			if not ok or type(key) ~= "string" then
				return false, nil, index
			end

			index = skipSpace(text, index)
			if string.sub(text, index, index) ~= ":" then
				return false, nil, index
			end

			local value
			ok, value, index = decodeValue(text, index + 1)
			if not ok then
				return false, nil, index
			end
			object[key] = value

			index = skipSpace(text, index)
			if string.sub(text, index, index) == "," then
				index += 1
			end
		end
	elseif char == "[" then
		local array = {}
		index += 1
		while true do
			index = skipSpace(text, index)
			if index > #text then
				return false, nil, index
			end
			if string.sub(text, index, index) == "]" then
				return true, array, index + 1
			end

			local ok, value
			ok, value, index = decodeValue(text, index)
			if not ok then
				return false, nil, index
			end
			table.insert(array, value)

			index = skipSpace(text, index)
			if string.sub(text, index, index) == "," then
				index += 1
			end
		end
	elseif char == '"' then
		local out = {}
		index += 1
		while index <= #text do
			local c = string.sub(text, index, index)
			if c == "\\" then
				local escaped = string.sub(text, index + 1, index + 1)
				if escaped == "u" then
					local code = tonumber(string.sub(text, index + 2, index + 5), 16)
					if not code then
						return false, nil, index
					end
					table.insert(out, string.char(code % 256))
					index += 6
				else
					table.insert(out, ESCAPE_CHARS[escaped] or escaped)
					index += 2
				end
			elseif c == '"' then
				return true, table.concat(out), index + 1
			else
				table.insert(out, c)
				index += 1
			end
		end
		return false, nil, index
	elseif string.sub(text, index, index + 3) == "true" then
		return true, true, index + 4
	elseif string.sub(text, index, index + 4) == "false" then
		return true, false, index + 5
	elseif string.sub(text, index, index + 3) == "null" then
		return true, nil, index + 4
	end

	local numberText = string.match(text, "^-?%d+%.?%d*[eE]?[+-]?%d*", index)
	if numberText and tonumber(numberText) then
		return true, tonumber(numberText), index + #numberText
	end

	return false, nil, index
end

--=============================================================================
-- services
--=============================================================================

local services: { [string]: any } = {}
local heartbeat = Signal.new()
local stepped = Signal.new()
local renderStepped = Signal.new()
local inputBegan = Signal.new()
local inputEnded = Signal.new()

local function service(name: string, implementation)
	implementation.Name = name
	implementation.ClassName = name
	services[name] = implementation
	return implementation
end

RunService = service("RunService", {
	--- Fires after the step events, with the frame delta in seconds.
	Heartbeat = heartbeat,
	--- Fires before the step events.
	Stepped = stepped,
	--- Fires just before drawing.
	RenderStepped = renderStepped,
	IsRunning = function(self)
		return true
	end,
	IsClient = function(self)
		return true
	end,
	IsServer = function(self)
		return false
	end,
	IsStudio = function(self)
		return false
	end,
})

UserInputService = service("UserInputService", {
	--- Fires with an input table: { KeyCode = "left", UserInputType = "Keyboard" }
	InputBegan = inputBegan,
	InputEnded = inputEnded,
	IsKeyDown = function(self, key)
		return keyboard_check(key)
	end,
	GetMouseLocation = function(self)
		return mouse_x(), mouse_y()
	end,
	IsMouseButtonPressed = function(self, button)
		return mouse_check_button(button)
	end,
})

local storageValues: { [string]: any } = {}

ReplicatedStorage = service("ReplicatedStorage", {
	--- Fires with (key, value) whenever a stored value changes.
	Changed = Signal.new(),

	SetAttribute = function(self, key: string, value)
		storageValues[key] = value
		self.Changed:Fire(key, value)
	end,
	GetAttribute = function(self, key: string, default)
		local value = storageValues[key]
		if value == nil then
			return default
		end
		return value
	end,
	GetAttributes = function(self)
		return table.clone(storageValues)
	end,
	ClearAllAttributes = function(self)
		table.clear(storageValues)
	end,
})

-- Roblox calls these SetAttribute/GetAttribute; Set/Get read better in code.
ReplicatedStorage.Set = ReplicatedStorage.SetAttribute
ReplicatedStorage.Get = ReplicatedStorage.GetAttribute

HttpService = service("HttpService", {
	JSONEncode = function(self, value): string
		return encodeValue(value)
	end,
	JSONDecode = function(self, text: string)
		local ok, value = decodeValue(text, 1)
		if not ok then
			error("JSONDecode: that string is not valid JSON", 2)
		end
		return value
	end,
	GenerateGUID = function(self)
		return string.format(
			"%08x-%04x-%04x-%04x-%012x",
			math.random(0, 0xFFFFFFFF), math.random(0, 0xFFFF), math.random(0, 0xFFFF),
			math.random(0, 0xFFFF), math.random(0, 0xFFFFFFFF)
		)
	end,
})

--- Persisted key/value storage, backed by the host's localStorage.
local DataStore = {}
DataStore.__index = DataStore

function DataStore.SetAsync(self, key: string, value)
	__host_store_set(`{self._name}/{key}`, encodeValue(value))
	return value
end

function DataStore.GetAsync(self, key: string, default)
	local raw = __host_store_get(`{self._name}/{key}`)
	if raw == nil or raw == "" then
		return default
	end
	-- Corrupt or stale data falls back to the default rather than erroring.
	local ok, value = decodeValue(raw, 1)
	if not ok or value == nil then
		return default
	end
	return value
end

function DataStore.RemoveAsync(self, key: string)
	local previous = self:GetAsync(key)
	__host_store_set(`{self._name}/{key}`, "")
	return previous
end

function DataStore.IncrementAsync(self, key: string, delta: number?)
	local next = (self:GetAsync(key, 0) :: number) + (delta or 1)
	self:SetAsync(key, next)
	return next
end

function DataStore.UpdateAsync(self, key: string, transform)
	local next = transform(self:GetAsync(key))
	self:SetAsync(key, next)
	return next
end

local dataStores: { [string]: any } = {}

DataStoreService = service("DataStoreService", {
	GetDataStore = function(self, name: string)
		name = name or "global"
		if not dataStores[name] then
			dataStores[name] = setmetatable({ _name = name }, DataStore)
		end
		return dataStores[name]
	end,
})

--- Shared modules from the project's `scripts/` folder.
local modules: { [string]: any } = {}

ScriptService = service("ScriptService", {
	Require = function(self, name: string)
		if modules[name] == nil then
			error(`ScriptService:Require: no script named '{name}'`, 2)
		end
		return modules[name]
	end,
	FindFirstChild = function(self, name: string)
		return modules[name]
	end,
	GetScripts = function(self)
		local names = {}
		for name in modules do
			table.insert(names, name)
		end
		table.sort(names)
		return names
	end,
})

--- Roblox's `require`, resolving against `scripts/`.
function require(name: string)
	return ScriptService:Require(name)
end

-- Replaced by the prelude once it has an instance list to offer.
local instanceProvider = {
	all = function()
		return {}
	end,
	roots = function()
		return {}
	end,
	findFirst = function(name: string)
		return nil
	end,
}

Workspace = service("Workspace", {
	--- The root instances: everything not parented to another instance.
	GetChildren = function(self)
		return instanceProvider.roots()
	end,
	--- Every live instance, at any depth.
	GetDescendants = function(self)
		return instanceProvider.all()
	end,
	--- A root instance with that Name, or failing that any instance of the
	--- object called that.
	FindFirstChild = function(self, name: string)
		return instanceProvider.findFirst(name)
	end,
	CountOf = function(self, objectName: string)
		return instance_number(objectName)
	end,
	GetPartsInRegion = function(self, x1, y1, x2, y2)
		local found = {}
		for _, inst in instanceProvider.all() do
			local left, top, right, bottom = inst:bbox()
			if left < x2 and x1 < right and top < y2 and y1 < bottom then
				table.insert(found, inst)
			end
		end
		return found
	end,
})

workspace = Workspace

game = {
	Name = "game",
	GetService = function(self, name: string)
		-- An unquoted name resolves to nil, which is by far the most common
		-- way this goes wrong; say so rather than reporting "no service nil".
		if type(name) ~= "string" then
			error(
				`GetService expects the service name in quotes, like `
					.. `game:GetService("RunService") -- got {typeof(name)}`,
				2
			)
		end

		local found = services[name]
		if not found then
			local available = {}
			for key in services do
				table.insert(available, key)
			end
			table.sort(available)
			error(`GetService: no service named '{name}'. Available: {table.concat(available, ", ")}`, 2)
		end
		return found
	end,
	FindService = function(self, name: string)
		return services[name]
	end,
	GetServices = function(self)
		local names = {}
		for key in services do
			table.insert(names, key)
		end
		table.sort(names)
		return names
	end,
	Workspace = Workspace,
}

--=============================================================================
-- bridge used by the prelude
--=============================================================================

__rbx = {
	newSignal = Signal.new,

	fireStepped = function(dt: number)
		stepped:Fire(dt)
	end,
	fireHeartbeat = function(dt: number)
		heartbeat:Fire(dt)
	end,
	fireRenderStepped = function(dt: number)
		renderStepped:Fire(dt)
	end,
	fireInputBegan = function(key: string)
		inputBegan:Fire({ KeyCode = key, UserInputType = "Keyboard" })
	end,
	fireInputEnded = function(key: string)
		inputEnded:Fire({ KeyCode = key, UserInputType = "Keyboard" })
	end,

	setInstanceProvider = function(provider)
		instanceProvider = provider
	end,

	registerModule = function(name: string, value)
		modules[name] = if value == nil then true else value
	end,

	--- Resume whatever `task.wait`/`task.delay` is due.
	stepScheduler = function(dt: number)
		clock += dt
		if #queue == 0 then
			return
		end

		local ready = {}
		for index = #queue, 1, -1 do
			if queue[index].at <= clock then
				table.insert(ready, queue[index])
				table.remove(queue, index)
			end
		end

		for index = #ready, 1, -1 do
			local entry = ready[index]
			local ok, err
			if entry.resume then
				ok, err = coroutine.resume(entry.thread, dt)
			else
				ok, err = coroutine.resume(entry.thread, table.unpack(entry.args, 1, entry.args.n))
			end
			if not ok then
				error(err, 0)
			end
		end
	end,

	reset = function()
		clock = 0
		table.clear(queue)
		table.clear(storageValues)
		table.clear(modules)
		for _, signal in { heartbeat, stepped, renderStepped, inputBegan, inputEnded, ReplicatedStorage.Changed } do
			signal:DisconnectAll()
		end
	end,
}
