--!nocheck
-- Benseditor runtime prelude.
--
-- Loaded into every game's VM before any user script. Everything here exists to
-- keep hot per-step work on the Luau side: crossing the Python/Luau boundary
-- costs far more than the arithmetic itself, so one call that loops over every
-- instance beats one call per field.
--
-- `__instances` maps instance id -> instance table. The host adds and removes
-- entries; iteration order is never relied upon.

__instances = {}

-- Set by the host before this chunk runs; holds __index with the instance
-- methods implemented in Python (destroy, place_meeting, draw_self, ...).
__instance_meta = __instance_meta or {}

local ALARM_COUNT = 12

function __new_instance(id, object, x, y, depth, visible, solid)
	local alarms = table.create(ALARM_COUNT, -1)

	local inst = {
		__id = id,
		__object = object,

		x = x,
		y = y,
		xstart = x,
		ystart = y,
		xprevious = x,
		yprevious = y,

		hspeed = 0,
		vspeed = 0,
		gravity = 0,
		gravity_direction = 270,
		friction = 0,

		image_index = 0,
		image_speed = 1,
		image_xscale = 1,
		image_yscale = 1,
		image_angle = 0,
		image_alpha = 1,
		image_blend = 0xFFFFFF,

		visible = visible,
		depth = depth,
		solid = solid,
		alarms = alarms,
	}

	setmetatable(inst, __instance_meta)
	__instances[id] = inst
	return inst
end

function __forget(id)
	__instances[id] = nil
end

-- Built-in movement, applied to every instance once per step.
function __physics_all()
	for _, inst in __instances do
		inst.xprevious = inst.x
		inst.yprevious = inst.y

		if inst.gravity ~= 0 then
			local radians = math.rad(inst.gravity_direction)
			inst.hspeed += math.cos(radians) * inst.gravity
			inst.vspeed -= math.sin(radians) * inst.gravity
		end

		if inst.friction ~= 0 then
			local speed = math.sqrt(inst.hspeed * inst.hspeed + inst.vspeed * inst.vspeed)
			if speed > 0 then
				local scale = math.max(0, speed - inst.friction) / speed
				inst.hspeed *= scale
				inst.vspeed *= scale
			end
		end

		inst.x += inst.hspeed
		inst.y += inst.vspeed
	end
end

-- Counts every alarm down. Returns a flat {id, index, id, index, ...} array of
-- the alarms that reached zero, so the host can fire their events.
function __alarms_tick()
	local fired = {}

	for id, inst in __instances do
		local alarms = inst.alarms
		for index = 1, ALARM_COUNT do
			local value = alarms[index]
			if value >= 0 then
				value -= 1
				if value == 0 then
					alarms[index] = -1
					table.insert(fired, id)
					table.insert(fired, index)
				else
					alarms[index] = value
				end
			end
		end
	end

	return fired
end

-- Everything the host needs to draw and collide one instance, in a single call.
function __snapshot(inst)
	return inst.x,
		inst.y,
		inst.image_xscale,
		inst.image_yscale,
		inst.image_angle,
		inst.image_index,
		inst.image_alpha,
		inst.image_blend,
		inst.visible,
		inst.depth
end

function __advance_animation(inst, frame_count)
	local speed = inst.image_speed
	if speed == 0 or frame_count <= 1 then
		return false
	end

	local index = inst.image_index + speed
	if index >= frame_count or index < 0 then
		inst.image_index = index % frame_count
		return true
	end

	inst.image_index = index
	return false
end
