"""
Roblox-flavoured layer.

Loaded before `prelude.py`, so it must not touch engine internals at load
time -- but Python resolves globals when a function *runs*, not when it is
defined, so the service bodies below can freely call `keyboard_check`,
`instance_find` and friends once the prelude is in.

The prelude drives this layer through `__rbx`: it fires the frame signals,
pumps the task scheduler, and hands over the live instance list.

Both files run in the interpreter's `__main__` globals, so everything defined
here is a plain global, exactly as in the Luau version. Names starting with an
underscore are private helpers and state -- the Python spelling of `local`.
"""

import json as _json
import random as _random

import __host

# =============================================================================
# Signal
# =============================================================================


def _generator_probe():
    yield None


# What an `async def` returns when called, and what the scheduler drives.
# Generators are the same type in MicroPython, so a `yield`-based worker is
# driven identically.
_COROUTINE = type(_generator_probe())


def _pack_values(args):
    """Luau resumes a waiting thread with every fired value; Python's `send`
    takes one, so several become a tuple and none becomes None."""
    if len(args) == 1:
        return args[0]
    if not args:
        return None
    return args


def _run_handler(handler, args):
    """Call a handler; if it is `async def`, drive the coroutine it returns."""
    result = handler(*args)
    if type(result) is _COROUTINE:
        _resume(result, None)


class _Connection:
    def __init__(self, signal, handler):
        self.Connected = True
        self._signal = signal
        self._handler = handler

    def Disconnect(self):
        if not self.Connected:
            return
        self.Connected = False

        handlers = self._signal._handlers
        if self in handlers:
            handlers.remove(self)

    disconnect = Disconnect


class _SignalWait:
    """What `Signal.Wait()` returns. `await`ing it parks the coroutine on the
    signal; the next `Fire` resumes it with the fired values."""

    def __init__(self, signal):
        self.signal = signal

    def __await__(self):
        return (yield self)

    __iter__ = __await__


class Signal:
    def __init__(self):
        self._handlers = []
        self._waiting = []

    @staticmethod
    def new():
        return Signal()

    def Connect(self, handler):
        if not callable(handler):
            raise TypeError("Connect expects a function")
        connection = _Connection(self, handler)
        self._handlers.append(connection)
        return connection

    def Once(self, handler):
        """Connect a handler that disconnects itself after the first fire."""

        def once(*args):
            connection.Disconnect()
            _run_handler(handler, args)

        connection = self.Connect(once)
        return connection

    def Fire(self, *args):
        handlers = self._handlers
        if handlers:
            # Iterate a copy: handlers are allowed to disconnect during dispatch.
            for connection in list(handlers):
                if connection.Connected:
                    _run_handler(connection._handler, args)

        if self._waiting:
            waiting = self._waiting
            self._waiting = []
            value = _pack_values(args)
            for thread in waiting:
                _resume(thread, value)

    def Wait(self):
        """Yield the calling coroutine until this signal next fires.

        Only meaningful as `await signal.Wait()` inside an `async def` run by
        `task.spawn`, `task.delay` or a signal handler; a plain call does nothing.
        """
        return _SignalWait(self)

    def DisconnectAll(self):
        for connection in self._handlers:
            connection.Connected = False
        self._handlers.clear()
        self._waiting.clear()

    # Lowercase aliases, since the rest of this engine is snake_case.
    connect = Connect
    once = Once
    fire = Fire
    wait = Wait


# =============================================================================
# task scheduler
# =============================================================================

_clock = 0.0
_queue = []


class _Entry:
    """One scheduled wake-up: a parked coroutine to resume, or a function to call."""

    def __init__(self, at, thread, fn, args, resume):
        self.at = at
        self.thread = thread
        self.fn = fn
        self.args = args
        self.resume = resume


class _Wait:
    """What `task.wait()` returns. `await`ing it parks the coroutine until the
    scheduler's clock passes `seconds`; resuming hands back the frame delta."""

    def __init__(self, seconds):
        self.seconds = seconds

    def __await__(self):
        return (yield self)

    __iter__ = __await__


def _resume(thread, value):
    """Drive a coroutine until it next parks, then park it where it asks."""
    try:
        marker = thread.send(value)
    except StopIteration:
        return
    kind = type(marker)
    if kind is _Wait:
        _queue.append(_Entry(_clock + marker.seconds, thread, None, None, True))
    elif kind is _SignalWait:
        marker.signal._waiting.append(thread)
    # Anything else is a bare `yield`, which nothing ever resumes -- the same
    # fate as a bare coroutine.yield() in Luau.


def _start(fn, args):
    """Run `fn` now; if it is `async def` (or already a coroutine), drive it.
    Returns the coroutine so it can be cancelled, or None for a plain function."""
    if type(fn) is _COROUTINE:
        _resume(fn, None)
        return fn
    result = fn(*args)
    if type(result) is _COROUTINE:
        _resume(result, None)
        return result
    return None


class _Task:
    def spawn(self, fn, *args):
        """Run `fn` immediately on its own thread, so it may `await task.wait()`."""
        return _start(fn, args)

    def defer(self, fn, *args):
        """Run `fn` on the next step."""
        _queue.append(_Entry(_clock, None, fn, args, False))

    def delay(self, seconds, fn, *args):
        """Run `fn` after `seconds`."""
        _queue.append(_Entry(_clock + max(0, seconds or 0), None, fn, args, False))

    def wait(self, seconds=None):
        """Yield the current coroutine: `await task.wait(1)`. Returns the seconds
        actually waited (the delta of the frame that resumed it)."""
        return _Wait(max(0, seconds or 0))

    def cancel(self, thread):
        for index in range(len(_queue) - 1, -1, -1):
            if _queue[index].thread is thread:
                del _queue[index]


task = _Task()

wait = task.wait

# =============================================================================
# JSON, used by DataStore and exposed through HttpService
# =============================================================================

_ESCAPES = {
    '"': '\\"', "\\": "\\\\", "\b": "\\b",
    "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t",
}

_INFINITY = float("inf")


def _encode_string(text):
    out = ['"']
    for char in text:
        escaped = _ESCAPES.get(char)
        if escaped is not None:
            out.append(escaped)
        else:
            code = ord(char)
            if code < 32 or code == 127:
                out.append("\\u%04x" % code)
            else:
                out.append(char)
    out.append('"')
    return "".join(out)


def _encode_value(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value == _INFINITY or value == -_INFINITY:
            raise ValueError("cannot encode NaN or infinity")
        return "%d" % value if value % 1 == 0 else str(value)
    if isinstance(value, str):
        return _encode_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join([_encode_value(item) for item in value]) + "]"
    if isinstance(value, dict):
        parts = []
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("JSON object keys must be strings")
            parts.append(_encode_string(key) + ":" + _encode_value(item))
        return "{" + ",".join(parts) + "}"

    raise TypeError("cannot encode a value of type " + type(value).__name__)


def _decode_value(text):
    """Returns (ok, value) rather than raising: a game reading back a corrupt
    save falls back to its default instead of dying."""
    try:
        return True, _json.loads(text)
    except Exception:
        return False, None


# =============================================================================
# services
# =============================================================================

_services = {}
_heartbeat = Signal()
_stepped = Signal()
_render_stepped = Signal()
_input_began = Signal()
_input_ended = Signal()


def _service(name, implementation):
    implementation.Name = name
    implementation.ClassName = name
    _services[name] = implementation
    return implementation


class _RunService:
    def __init__(self):
        # Fires after the step events, with the frame delta in seconds.
        self.Heartbeat = _heartbeat
        # Fires before the step events.
        self.Stepped = _stepped
        # Fires just before drawing.
        self.RenderStepped = _render_stepped

    def IsRunning(self):
        return True

    def IsClient(self):
        return True

    def IsServer(self):
        return False

    def IsStudio(self):
        return False


RunService = _service("RunService", _RunService())


class _InputObject:
    """What InputBegan/InputEnded fire with: `input.KeyCode`, `input.UserInputType`."""

    def __init__(self, key, kind):
        self.KeyCode = key
        self.UserInputType = kind

    def __getitem__(self, key):
        return getattr(self, key)


class _UserInputService:
    def __init__(self):
        # Fires with an input object: KeyCode = "left", UserInputType = "Keyboard"
        self.InputBegan = _input_began
        self.InputEnded = _input_ended

    def IsKeyDown(self, key):
        return keyboard_check(key)

    def GetMouseLocation(self):
        return mouse_x(), mouse_y()

    def IsMouseButtonPressed(self, button):
        return mouse_check_button(button)


UserInputService = _service("UserInputService", _UserInputService())

_storage_values = {}


class _ReplicatedStorage:
    def __init__(self):
        # Fires with (key, value) whenever a stored value changes.
        self.Changed = Signal()

    def SetAttribute(self, key, value):
        _storage_values[key] = value
        self.Changed.Fire(key, value)

    def GetAttribute(self, key, default=None):
        value = _storage_values.get(key)
        if value is None:
            return default
        return value

    def GetAttributes(self):
        return dict(_storage_values)

    def ClearAllAttributes(self):
        _storage_values.clear()

    # Roblox calls these SetAttribute/GetAttribute; Set/Get read better in code.
    Set = SetAttribute
    Get = GetAttribute


ReplicatedStorage = _service("ReplicatedStorage", _ReplicatedStorage())


class _HttpService:
    def JSONEncode(self, value):
        return _encode_value(value)

    def JSONDecode(self, text):
        ok, value = _decode_value(text)
        if not ok:
            raise ValueError("JSONDecode: that string is not valid JSON")
        return value

    def GenerateGUID(self):
        bits = _random.getrandbits
        return "%08x-%04x-%04x-%04x-%012x" % (
            bits(32), bits(16), bits(16), bits(16), (bits(32) << 16) | bits(16),
        )


HttpService = _service("HttpService", _HttpService())


class _DataStore:
    """Persisted key/value storage, backed by the host's localStorage."""

    def __init__(self, name):
        self._name = name

    def SetAsync(self, key, value):
        __host.store_set("%s/%s" % (self._name, key), _encode_value(value))
        return value

    def GetAsync(self, key, default=None):
        raw = __host.store_get("%s/%s" % (self._name, key))
        if raw is None or raw == "":
            return default
        # Corrupt or stale data falls back to the default rather than erroring.
        ok, value = _decode_value(raw)
        if not ok or value is None:
            return default
        return value

    def RemoveAsync(self, key):
        previous = self.GetAsync(key)
        __host.store_set("%s/%s" % (self._name, key), "")
        return previous

    def IncrementAsync(self, key, delta=None):
        following = self.GetAsync(key, 0) + (1 if delta is None else delta)
        self.SetAsync(key, following)
        return following

    def UpdateAsync(self, key, transform):
        following = transform(self.GetAsync(key))
        self.SetAsync(key, following)
        return following


_data_stores = {}


class _DataStoreService:
    def GetDataStore(self, name=None):
        name = name or "global"
        store = _data_stores.get(name)
        if store is None:
            store = _DataStore(name)
            _data_stores[name] = store
        return store


DataStoreService = _service("DataStoreService", _DataStoreService())

# Shared modules from the project's `scripts/` folder.
_modules = {}


class _ScriptService:
    def Require(self, name):
        module = _modules.get(name)
        if module is None:
            raise ValueError("ScriptService.Require: no script named '%s'" % name)
        return module

    def FindFirstChild(self, name):
        return _modules.get(name)

    def GetScripts(self):
        return sorted(_modules)


ScriptService = _service("ScriptService", _ScriptService())


def require(name):
    """Roblox's `require`, resolving against `scripts/`."""
    return ScriptService.Require(name)


class _EmptyProvider:
    """Replaced by the prelude once it has an instance list to offer."""

    def all(self):
        return []

    def roots(self):
        return []

    def findFirst(self, name):
        return None


_instance_provider = _EmptyProvider()


class _Workspace:
    def GetChildren(self):
        """The root instances: everything not parented to another instance."""
        return _instance_provider.roots()

    def GetDescendants(self):
        """Every live instance, at any depth."""
        return _instance_provider.all()

    def FindFirstChild(self, name):
        """A root instance with that Name, or failing that any instance of the
        object called that."""
        return _instance_provider.findFirst(name)

    def CountOf(self, objectName):
        return instance_number(objectName)

    def GetPartsInRegion(self, x1, y1, x2, y2):
        found = []
        for inst in _instance_provider.all():
            left, top, right, bottom = inst.bbox()
            if left < x2 and x1 < right and top < y2 and y1 < bottom:
                found.append(inst)
        return found


Workspace = _service("Workspace", _Workspace())

workspace = Workspace


class _Game:
    def __init__(self):
        self.Name = "game"
        self.Workspace = Workspace

    def GetService(self, name):
        # An unquoted name is a NameError long before it gets here in Python,
        # but a non-string still deserves a clearer message than "no service".
        if not isinstance(name, str):
            raise TypeError(
                "GetService expects the service name in quotes, like "
                'game.GetService("RunService") -- got ' + type(name).__name__
            )

        found = _services.get(name)
        if found is None:
            raise ValueError(
                "GetService: no service named '%s'. Available: %s" % (name, ", ".join(sorted(_services)))
            )
        return found

    def FindService(self, name):
        return _services.get(name)

    def GetServices(self):
        return sorted(_services)


game = _Game()

# =============================================================================
# bridge used by the prelude
# =============================================================================


class _Bridge:
    def newSignal(self):
        return Signal()

    def fireStepped(self, dt):
        _stepped.Fire(dt)

    def fireHeartbeat(self, dt):
        _heartbeat.Fire(dt)

    def fireRenderStepped(self, dt):
        _render_stepped.Fire(dt)

    def fireInputBegan(self, key):
        _input_began.Fire(_InputObject(key, "Keyboard"))

    def fireInputEnded(self, key):
        _input_ended.Fire(_InputObject(key, "Keyboard"))

    def setInstanceProvider(self, provider):
        global _instance_provider
        _instance_provider = provider

    def registerModule(self, name, value):
        _modules[name] = True if value is None else value

    def stepScheduler(self, dt):
        """Resume whatever `task.wait`/`task.delay` is due."""
        global _clock
        _clock += dt
        if not _queue:
            return

        ready = []
        remaining = []
        for entry in _queue:
            if entry.at <= _clock:
                ready.append(entry)
            else:
                remaining.append(entry)
        _queue[:] = remaining

        for entry in ready:
            if entry.resume:
                _resume(entry.thread, dt)
            else:
                _start(entry.fn, entry.args)

    def reset(self):
        global _clock
        _clock = 0.0
        _queue.clear()
        _storage_values.clear()
        _modules.clear()
        for signal in (_heartbeat, _stepped, _render_stepped, _input_began, _input_ended, ReplicatedStorage.Changed):
            signal.DisconnectAll()


__rbx = _Bridge()
