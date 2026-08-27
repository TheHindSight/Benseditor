/**
 * The instance tree.
 *
 * Roblox-style parenting lives inside the VM: `child.Parent = self`,
 * `Instance.new("obj_x", parent)`, `GetChildren` / `GetDescendants` /
 * `FindFirstChild`, and a parent taking its children with it when destroyed.
 * None of it changes what a flat, never-parented world does, which is the
 * first thing checked here.
 *
 * Game code reports through `__test_report`, a JS function registered into the
 * VM, the same way `tests/api.test.mjs` does. Object scripts share one global
 * environment, so counters they bump are plain globals.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuauState } from 'luau-web';

const here = dirname(fileURLToPath(import.meta.url));
const luau = (name) => readFileSync(join(here, '..', 'src', 'luau', name), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const state = await LuauState.createAsync({
  __host_store_get: () => '',
  __host_store_set: () => {},
  __test_report: (name, ok, detail) => check(String(name), !!ok, detail == null ? '' : String(detail)),
});

await state.loadstring(luau('roblox.luau'), 'roblox.luau', true)();
const api = (await state.loadstring(luau('prelude.luau'), 'prelude.luau', true)())[0];
const g = (name) => api.get(name);

/** Compile an object module and register it, the way the host will. */
async function addObject(name, source, def = {}) {
  const module = (await state.loadstring(source, `${name}.luau`, true)())[0];
  await g('register_object')(
    name,
    module,
    def.sprite ?? null,
    def.depth ?? 0,
    def.visible ?? true,
    def.solid ?? false,
    def.persistent ?? false,
    def.parent ?? null,
    (def.blockedBy ?? []).join(','),
  );
}

const INERT = 'local obj = {}\nreturn obj\n';

/** Log every create and destroy into globals the probe can inspect. */
const LOGGED = `local obj = {}
function obj.create(self)
  LOG = LOG or {}
  table.insert(LOG, "create " .. self.name)
  LAST_PARENT = self.Parent
end
function obj.destroy(self)
  table.insert(LOG, "destroy " .. self.name)
end
return obj
`;

async function fresh(other = INERT) {
  await g('reset')();
  await addObject('obj_thing', INERT);
  await addObject('obj_sub', INERT, { parent: 'obj_thing' });
  await addObject('obj_other', other);
}

/** Run `body` as the create event of a probe object placed in a room. */
async function probe(body, placements = 'obj_probe,10,20,1,1,0') {
  await addObject('obj_probe', `local obj = {}\nfunction obj.create(self)\n${body}\nend\nreturn obj\n`);
  await g('register_room')('rm', 320, 200, 0, 16, 16, placements);
  await g('start')('rm');
}

console.log('\n=== a world that never parents is the flat world it always was ===');
await fresh();
await probe(`
  local a = instance_create(1, 1, "obj_thing")
  local b = instance_create(2, 2, "obj_other")
  __test_report("name defaults to the object name", a.name == "obj_thing", a.name)
  __test_report("Name aliases name", a.Name == "obj_thing" and b.Name == "obj_other")
  __test_report("a root's Parent is the Workspace", a.Parent == workspace)
  __test_report("an instance has no children", #a:get_children() == 0 and #a:GetChildren() == 0)
  __test_report("workspace children are every live instance", #workspace:GetChildren() == 3)
  __test_report("workspace descendants agree while flat", #workspace:GetDescendants() == 3)
  __test_report("FindFirstChild still finds by object type", workspace:FindFirstChild("obj_other") == b)
  __test_report("FindFirstChild matches descendants of a type", workspace:FindFirstChild("obj_thing") == a)
  __test_report("instance_list unaffected", #instance_list("obj_thing") == 1)
`);

console.log('\n=== parenting ===');
await fresh();
await probe(`
  local parent = instance_create(0, 0, "obj_thing")
  local child = instance_create(0, 0, "obj_other")
  child.Parent = parent
  __test_report("child reads its Parent back", child.Parent == parent)
  __test_report("parent lists the child", #parent:get_children() == 1 and parent:get_children()[1] == child)
  __test_report("GetChildren alias", parent:GetChildren()[1] == child)
  __test_report("workspace children exclude parented instances", #workspace:GetChildren() == 2)
  __test_report("workspace descendants include them", #workspace:GetDescendants() == 3)

  child.Parent = workspace
  __test_report("Parent = workspace makes it a root again", child.Parent == workspace and #parent:get_children() == 0)
  child.Parent = parent
  child.Parent = nil
  __test_report("Parent = nil also makes it a root", child.Parent == workspace and #workspace:GetChildren() == 3)

  child.Parent = parent
  child.Parent = parent
  __test_report("re-parenting to the same parent is a no-op", #parent:get_children() == 1)

  local other = instance_create(0, 0, "obj_thing")
  child.Parent = other
  __test_report("moving to another parent leaves the old one", #parent:get_children() == 0 and #other:get_children() == 1)

  child.Name = "hero"
  __test_report("Name writes name", child.name == "hero")
  __test_report("find_first_child by name", other:find_first_child("hero") == child)
  __test_report("FindFirstChild by name alias", other:FindFirstChild("hero") == child)
  __test_report("find_first_child by object type", other:find_first_child("obj_other") == child)
  __test_report("find_first_child misses", other:find_first_child("nope") == nil)
  __test_report("workspace:FindFirstChild by name only sees roots", workspace:FindFirstChild("hero") == nil)
  child.Parent = nil
  __test_report("workspace:FindFirstChild finds a named root", workspace:FindFirstChild("hero") == child)

  self.custom = 5
  __test_report("custom fields still land on the instance", rawget(self, "custom") == 5)
`);

console.log('\n=== nesting, Instance.new, order ===');
await fresh(LOGGED);
await probe(`
  LOG = {}
  local root = instance_create(100, 50, "obj_thing")
  local mid = Instance.new("obj_other", root)
  __test_report("Instance.new parents before create runs", LAST_PARENT == root)
  __test_report("Instance.new runs create", LOG[1] == "create obj_other")
  __test_report("Instance.new inherits the parent's position", mid.x == 100 and mid.y == 50)
  __test_report("Instance.new without a parent is a root", Instance.new("obj_thing").Parent == workspace)

  local leaf = Instance.new("obj_sub", mid)
  local descendants = root:get_descendants()
  __test_report("descendants walk the whole subtree", #descendants == 2)
  __test_report("descendants list parents before children", descendants[1] == mid and descendants[2] == leaf)
  __test_report("GetDescendants alias", #root:GetDescendants() == 2)
  __test_report("workspace roots are just the roots", #workspace:GetChildren() == 3)
  __test_report("workspace descendants are everything", #workspace:GetDescendants() == 5)

  local first = Instance.new("obj_other", root)
  local second = Instance.new("obj_other", root)
  first.Name = "same"
  second.Name = "same"
  __test_report("find_first_child returns the oldest match", root:find_first_child("same") == first)
  local kids = root:get_children()
  __test_report("children come oldest first", kids[1] == mid and kids[2] == first and kids[3] == second)
`);

console.log('\n=== bad parents are refused ===');
for (const [label, body] of [
  ['a cycle', 'local a = instance_create(0,0,"obj_thing"); local b = Instance.new("obj_other", a); local c = Instance.new("obj_other", b); a.Parent = c'],
  ['self-parenting', 'local a = instance_create(0,0,"obj_thing"); a.Parent = a'],
  ['a non-instance', 'local a = instance_create(0,0,"obj_thing"); a.Parent = 5'],
  ['a destroyed parent', 'local a = instance_create(0,0,"obj_thing"); local b = instance_create(0,0,"obj_thing"); a:destroy(); b.Parent = a'],
]) {
  await fresh();
  // pcall does not catch in this Luau build, so the error is observed from JS.
  let message = '';
  try {
    await probe(body);
  } catch (error) {
    message = String(error?.message ?? error);
  }
  check(`${label} is refused`, message.length > 0, 'expected an error');
}

console.log('\n=== destroy cascades ===');
await fresh(LOGGED);
await probe(`
  LOG = {}
  local root = instance_create(0, 0, "obj_other")
  root.Name = "root"
  local a = Instance.new("obj_other", root)
  a.Name = "a"
  local b = Instance.new("obj_other", a)
  b.Name = "b"
  local sibling = Instance.new("obj_other", root)
  sibling.Name = "sib"
  local loose = instance_create(0, 0, "obj_other")
  loose.Name = "loose"
  LOG = {}

  local order = {}
  for _, inst in { root, a, b, sibling } do
    inst.Destroying:Connect(function(who)
      table.insert(order, who.name)
    end)
  end

  root:destroy()
  __test_report("descendants are destroyed with their parent", a.__destroyed and b.__destroyed and sibling.__destroyed)
  __test_report("unrelated instances survive", not loose.__destroyed)
  __test_report("Destroying fires parent first, depth first", table.concat(order, ",") == "root,a,b,sib", table.concat(order, ","))
  __test_report("destroy events follow the same order", table.concat(LOG, ",") == "destroy root,destroy a,destroy b,destroy sib", table.concat(LOG, ","))
  __test_report("destroyed children leave the tree", #root:get_children() == 0)
  __test_report("destroying twice is harmless", (function() root:destroy() return true end)())

  local keep = instance_create(0, 0, "obj_thing")
  local gone = Instance.new("obj_other", keep)
  gone:destroy()
  __test_report("a destroyed child drops out of its parent's list", #keep:get_children() == 0)
  __test_report("a destroyed child has no parent", gone.Parent == workspace)
`);

console.log('\n=== surviving a room change ===');
await g('reset')();
await addObject('obj_mortal', INERT);
await addObject('obj_keeper', INERT, { persistent: true });
await addObject(
  'obj_probe',
  `local obj = {}
function obj.create(self)
  local mortal = instance_create(0, 0, "obj_mortal")
  local keeperChild = Instance.new("obj_keeper", mortal)
  keeperChild.Name = "orphan"
  local keeper = instance_create(0, 0, "obj_keeper")
  keeper.Name = "keeper"
  local mortalChild = Instance.new("obj_mortal", keeper)
  local keptChild = Instance.new("obj_keeper", keeper)
  keptChild.Name = "kept"
  room_goto("rm2")
end
return obj
`,
);
await addObject(
  'obj_checker',
  `local obj = {}
function obj.create(self)
  local orphan = workspace:FindFirstChild("orphan")
  __test_report("a persistent child of a dead parent survives as a root", orphan ~= nil and orphan.Parent == workspace)
  local keeper = workspace:FindFirstChild("keeper")
  __test_report("a persistent parent survives", keeper ~= nil)
  __test_report("its dead children are pruned", keeper ~= nil and #keeper:get_children() == 1)
  __test_report("its persistent children stay attached", keeper ~= nil and keeper:find_first_child("kept") ~= nil)
  __test_report("nothing else leaked through", #workspace:GetDescendants() == 4, tostring(#workspace:GetDescendants()))
end
return obj
`,
);
await g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_probe,0,0,1,1,0');
await g('register_room')('rm2', 320, 200, 0, 16, 16, 'obj_checker,0,0,1,1,0');
await g('start')('rm');
await g('frame')('');

console.log('\n=== rooms name their instances ===');
await fresh();
await probe(
  `
  __test_report("a six-field placement gets the object name", self.name == "obj_probe")
  local hero = workspace:FindFirstChild("hero")
  __test_report("a seven-field placement carries its name", hero ~= nil and hero.__object == "obj_thing")
  local blank = instance_list("obj_other")[1]
  __test_report("an empty seventh field means the default name", blank.name == "obj_other")
`,
  'obj_probe,10,20,1,1,0;obj_thing,1,2,1,1,0,hero;obj_other,3,4,1,1,0,',
);

console.log('\n=== reset clears the tree ===');
await fresh();
await probe(`
  local a = instance_create(0, 0, "obj_thing")
  Instance.new("obj_other", a)
`);
await fresh();
await probe(`
  __test_report("a fresh run starts with only the room's instances", #workspace:GetDescendants() == 1)
`);

console.log('\n=== the metatable stays cheap ===');
await fresh();
{
  const started = performance.now();
  await probe(`
  local count = 3000
  local first = nil
  for i = 1, count do
    local inst = instance_create(i, i, "obj_thing")
    inst.custom = i      -- first write of a new key: goes through __newindex once
    inst.custom = i + 1  -- second write: the key exists, so it is a plain rawset
    inst.x += 1
    if i > 1 then inst.Parent = first else first = inst end
  end
  __test_report("three thousand parented instances", #first:get_children() == count - 1)
`);
  const ms = performance.now() - started;
  check('3k instances created, parented and written under 500ms', ms < 500, `${ms.toFixed(0)}ms`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
