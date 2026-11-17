import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ------------------------------------------------------------------ сцена */
const $ = (id) => document.getElementById(id);
const canvas = $('c');
const stage = $('stage');
const labelsBox = $('labels');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.localClippingEnabled = true;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101215);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.up.set(0, 0, 1);                       // CAD-ось вверх — Z
camera.position.set(60, -80, 60);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xdde6f5, 0x2b3038, 2.0));
const key = new THREE.DirectionalLight(0xfff3e2, 1.7);
key.position.set(1, -1.4, 2.2);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9fc4ff, 0.65);
fill.position.set(-1.6, 1.2, 0.6);
scene.add(fill);

const grid = new THREE.GridHelper(200, 40, 0x333b46, 0x20262d);
grid.rotation.x = Math.PI / 2;                // в плоскость XY
scene.add(grid);

const axes = new THREE.AxesHelper(6);
axes.visible = false;
scene.add(axes);

/* срез: три независимые плоскости, сколько галочек — столько и режет */
const AXES = ['x', 'y', 'z'];
const AXIS_I = { x: 0, y: 1, z: 2 };
const AXIS_V = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const clip = { x: { on: false, t: 0.5 }, y: { on: false, t: 0.5 }, z: { on: false, t: 0.5 } };
const clipPlanes = { x: new THREE.Plane(), y: new THREE.Plane(), z: new THREE.Plane() };

/* ------------------------------------------------------------------ состояние */
const MODEL_COLOR = new THREE.Color(0xc9d3e2);
const state = {
  model: null,          // {path, geo, mesh, bbox}
  ref: null,
  mode: 'orbit',        // orbit | measure | pin | draw | move
  pending: null,        // первая точка замера
  measures: [],
  pins: [],
  strokes: [],
  compare: null,
  scaleMax: 1,
  saved: false,
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

/* ------------------------------------------------------------------ панели */
const PANELS = ['tasks', 'params', 'measure', 'notes', 'compare', 'help'];
function activate(name) {
  const app = $('app');
  app.classList.remove('no-side');            // панель снова нужна
  $('lay-panels').setAttribute('aria-pressed', 'true');
  for (const p of PANELS) {
    // одна вкладка может состоять из нескольких блоков: «Слои» — это и габариты, и срез, и поза
    document.querySelectorAll(`.panel[data-panel="${p}"]`).forEach((el) => { el.hidden = p !== name; });
  }
  document.querySelectorAll('#rail button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.panel === name));
  });
  setTimeout(resize, 0);
}
document.querySelectorAll('#rail button').forEach((b) => {
  b.onclick = () => {
    const cur = document.querySelector('.panel:not([hidden])');
    if (cur && cur.dataset.panel === b.dataset.panel) {      // повторный клик — свернуть
      $('app').classList.add('no-side');
      $('lay-panels').setAttribute('aria-pressed', 'false');
      document.querySelectorAll('#rail button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      setTimeout(resize, 0);
      return;
    }
    activate(b.dataset.panel);
  };
});

function setLayout(mode) {
  const app = $('app');
  app.classList.toggle('no-side', mode === 'stage');
  app.classList.toggle('no-dock', mode === 'stage');
  $('lay-panels').setAttribute('aria-pressed', String(mode === 'panels' || mode === 'both'));
  $('lay-dock').setAttribute('aria-pressed', String(mode === 'dock' || mode === 'both'));
  $('lay-both').setAttribute('aria-pressed', 'false');
  setTimeout(resize, 0);
}
$('lay-panels').onclick = () => setLayout('panels');
$('lay-dock').onclick = () => setLayout('dock');
$('lay-both').onclick = () => setLayout('stage');
$('dock-close').onclick = () => { $('app').classList.add('no-dock'); $('lay-dock').setAttribute('aria-pressed', 'false'); setTimeout(resize, 0); };

/* ------------------------------------------------------------------ загрузка */
const loader = new STLLoader();

function fmt(v, d = 2) { return (Math.round(v * 10 ** d) / 10 ** d).toFixed(d); }
function bboxOf(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  return { size: b.getSize(new THREE.Vector3()), center: b.getCenter(new THREE.Vector3()), box: b.clone() };
}

async function loadFile(path, role) {
  const t0 = performance.now();
  hint('открываю ' + path.split(/[\\/]/).pop() + '…');
  const res = await fetch('/api/mesh?path=' + encodeURIComponent(path));
  if (!res.ok) { hint('не смог загрузить: ' + (await res.text())); return; }
  const buf = await res.arrayBuffer();
  const geo = loader.parse(buf);
  geo.computeVertexNormals();
  setSlot(role, path, geo);
  $('build-time').textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' с';
  updateTitle();
  if (role === 'model') {
    animatePill('Разбираю');
    analyze(path);                 // п.5: разбор сетки стартует сам, кнопку жать не надо
  }
}

/* разбор сетки: тела, watertight, объём — после загрузки, без спроса */
let analyzeSeq = 0;
async function analyze(path) {
  const seq = ++analyzeSeq;
  const t0 = performance.now();
  $('analyze-out').textContent = 'разбираю сетку…';
  let data;
  try {
    const res = await fetch('/api/analyze?path=' + encodeURIComponent(path));
    data = await res.json();
  } catch (e) {
    $('analyze-out').textContent = 'разбор не вышел: ' + e.message;
    pillDone('Разбор не вышел', '');
    return;
  }
  if (seq !== analyzeSeq) return;                 // пока считали, открыли другой файл
  if (data.error) { $('analyze-out').textContent = 'разбор: ' + data.error; pillDone('Разбор не вышел', ''); return; }
  state.analyze = data;
  const sec = ((performance.now() - t0) / 1000).toFixed(1);
  const tris = Number(data.triangles || 0);
  const bodies = Number(data.bodies || 0);
  const vol = data.volume != null ? fmt(data.volume) + ' мм³' : '—';
  $('analyze-out').innerHTML =
    `сетка <b>${tris.toLocaleString('ru-RU')}</b> граней
` +
    `тел ${bodies} · ${data.watertight ? 'замкнутая' : 'с дырами'}
` +
    `объём ${vol} · площадь ${data.area != null ? fmt(data.area) + ' мм²' : '—'}
` +
    `<span class="sub">разбор ${sec} с${data.cached ? ' (из кеша)' : ''}</span>`;
  pillDone('Прочитано', tris.toLocaleString('ru-RU') + ' граней');
  $('st-tris').textContent = 'сетка ' + tris.toLocaleString('ru-RU') + ' · тел ' + bodies;
  $('explode-cap').textContent = bodies > 1
    ? `тел в файле ${bodies} — разносит их вдоль оси, видно, что с чем сходится`
    : 'тело одно — разносить нечего; зато срез и замеры работают';
  updateLayers();
}

function animatePill(text) {
  $('build-dot').className = 'dot warn';
  $('build-state').textContent = text;
  $('build-info').textContent = '…';
}
function pillDone(text, info) {
  $('build-dot').className = 'dot ok';
  $('build-state').textContent = text;
  if (info) $('build-info').textContent = info;
}

function updateTitle() {
  const base = (p) => p.split(/[\\/]/).pop();
  const m = state.model ? base(state.model.path) : null;
  const r = state.ref ? base(state.ref.path) : null;
  document.title = m ? (r ? `${m} ↔ ${r} — STL` : `${m} — STL`) : 'STL — смотрю и мерю';
}

function setSlot(role, path, geo) {
  dropSlot(role);
  const isModel = role === 'model';
  if (isModel) {
    // новая модель — старые замеры и рисунок к ней не относятся
    if (state.measures.length || state.pins.length || state.strokes.length) {
      state.measures = []; state.pins = []; state.strokes = [];
      rebuildMeasureLines(); renderMeasures(); rebuildPinDots(); renderPins(); rebuildStrokes(); renderStrokes();
      hint('новая модель — замеры, замечания и рисунок очищены');
    }
  }
  const mat = isModel
    ? new THREE.MeshStandardMaterial({ color: MODEL_COLOR.clone(), metalness: 0.15, roughness: 0.52,
        flatShading: false, vertexColors: false, wireframe: $('chk-wire').checked, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: new THREE.Color(0x3fb6ff), metalness: 0.0, roughness: 0.8,
        transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.role = role;
  scene.add(mesh);
  const info = { path, geo, mesh, mat, parts: null, ...bboxOf(geo) };
  state[role] = info;
  if (isModel) { $('chk-ghost').checked = true; }
  fitCamera();
  applyClip();
  updateLayers();
  docName();
  hint(isModel ? 'модель: ' + path.split('/').pop() : 'эталон: ' + path.split('/').pop());
  saved(false);
}

function saved(v) {
  state.saved = v;
  $('save-dot').className = 'dot ' + (v ? 'ok' : 'warn');
  $('save-text').textContent = v ? 'задача сохранена' : 'не сохранено';
}

function dropSlot(role) {
  if (role === 'ref' && gizmoOn()) gizmo.detach();
  const cur = state[role];
  if (cur) {
    scene.remove(cur.mesh);
    cur.geo.dispose();
    cur.mat.dispose();
    dropParts(role);
  }
  state[role] = null;
  state.compare = null;
  $('compare-box').classList.add('hidden');
  $('compare-empty').hidden = false;
  $('st-rms').textContent = 'дифф —';
}

function fitCamera() {
  const t = state.model || state.ref;
  if (!t) return;
  const r = Math.max(t.size.x, t.size.y, t.size.z);
  const d = r * 2.1;
  controls.target.copy(t.center);
  camera.position.set(t.center.x + d * 0.62, t.center.y - d * 0.72, t.center.z + d * 0.55);
  camera.fov = 45;
  camera.near = Math.max(r / 400, 0.01);
  camera.far = r * 60;
  camera.updateProjectionMatrix();
  controls.update();
}

function setView(kind) {
  const t = state.model || state.ref;
  if (!t) return;
  const r = Math.max(t.size.x, t.size.y, t.size.z) * 2.1;
  const c = t.center;
  const pos = {
    iso:    [c.x + r * .62, c.y - r * .72, c.z + r * .55],
    front:  [c.x,           c.y - r,        c.z],
    back:   [c.x,           c.y + r,        c.z],
    top:    [c.x,           c.y,            c.z + r],
    bottom: [c.x,           c.y,            c.z - r],
    right:  [c.x + r,       c.y,            c.z],
    left:   [c.x - r,       c.y,            c.z],
  }[kind];
  if (!pos) return;
  // по грани — «телеобъектив»: перспектива почти не искажает, грань смотрит прямо
  const narrow = kind !== 'iso';
  camera.fov = narrow ? 8 : 45;
  const k = narrow ? 8.2 : 1;
  const p2 = new THREE.Vector3(pos[0], pos[1], pos[2]).sub(c).multiplyScalar(k).add(c);
  camera.position.copy(p2);
  camera.near = Math.max(r / 400, 0.01);
  camera.far = r * 60 * k;
  camera.updateProjectionMatrix();
  controls.target.copy(c);
  controls.update();
  if (vcFaces.length) vcSync();
}
document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
$('btn-fit').onclick = () => fitCamera();

/* ------------------------------------------------------------------ пилюля и заголовки */
function buildPill() {
  const m = state.model, r = state.ref;
  if (!m) {
    $('build-dot').className = 'dot';
    $('build-state').textContent = 'Пусто';
    $('build-info').textContent = '—';
    $('st-dot').className = 'dot warn';
    $('st-tris').textContent = 'сетка —';
    return;
  }
  const tris = Math.round(m.geo.attributes.position.count / 3);
  $('build-dot').className = 'dot ok';
  $('build-state').textContent = state.analyze ? 'Прочитано' : 'Загружено';
  $('build-info').textContent = tris.toLocaleString('ru-RU') + ' граней';
  $('st-dot').className = 'dot ok';
  $('st-tris').textContent = 'сетка ' + tris.toLocaleString('ru-RU') +
    (state.analyze ? ' · тел ' + state.analyze.bodies : '');
}

function docName() {
  const m = state.model || state.ref;
  const name = m ? m.path.split(/[\\/]/).pop() : 'ничего не открыто';
  $('docname-text').textContent = name;
  $('docname-text').title = m ? m.path : '';
  $('crumb-name').textContent = name;
}

/* ------------------------------------------------------------------ задачи */
let taskCache = [];

async function refreshTasks() {
  const box = $('task-list');
  let tasks = [];
  try {
    const res = await fetch('/api/tasks');
    const data = await res.json();
    tasks = data.tasks || [];
  } catch (e) {
    box.innerHTML = '<div class="empty">список задач недоступен: ' + e.message + '</div>';
    $('tasks-count').textContent = '—';
    return;
  }
  taskCache = tasks;
  box.innerHTML = '';
  $('tasks-count').textContent = tasks.length ? String(tasks.length) : '0';
  if (!tasks.length) {
    box.innerHTML = '<div class="empty">ещё ни одной задачи. Собери замеры и замечания, напиши что поправить — и «Запустить исправление».</div>';
    return;
  }
  for (const t of tasks.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'trow' + (state.taskId === t.id ? ' on' : '');
    row.title = t.note || t.id;
    const st = t.status || 'draft';
    row.innerHTML = `<div class="l1"><span class="id">${t.id || t.file}</span>` +
      `<span class="st ${st}">${st === 'queued' ? 'в очереди' : 'черновик'}</span></div>` +
      `<div class="l2">${t.model ? t.model.split(/[\\/]/).pop() : 'без файла'}` +
      `${(t.measures || t.pins || t.strokes) ? ' · замеров ' + (t.measures || 0) + ', замеч. ' + (t.pins || 0) + ', штрихов ' + (t.strokes || 0) : ''}</div>`;
    row.onclick = () => loadTask(t.file || t.id);
    box.append(row);
  }
}

/* вернуться к сохранённой задаче: файл, замеры, замечания, рисунок, вид */
async function loadTask(file) {
  hint('открываю задачу ' + file + '…');
  const res = await fetch('/api/task?file=' + encodeURIComponent(file));
  const data = await res.json();
  if (data.error) { hint('задача не открылась: ' + data.error); return; }
  const task = data.task || {};
  state.taskId = task.id || file.replace(/\.json$/, '');

  if (task.model && task.model.path && (!state.model || state.model.path !== task.model.path)) {
    await loadFile(task.model.path, 'model');
  }
  if (task.ref && task.ref.path && (!state.ref || state.ref.path !== task.ref.path)) {
    await loadFile(task.ref.path, 'ref');
  }
  state.measures = (task.measurements || []).map((m) => ({ a: m.a, b: m.b }));
  state.pins = (task.pins || []).map((p) => ({ id: p.id, point: p.point, normal: p.normal || [0, 0, 1],
    comment: p.comment || '', camera: p.camera || { pos: camera.position.toArray(), target: controls.target.toArray() } }));
  state.strokes = (task.strokes || []).map((s) => ({ points: s.points || [] }));
  rebuildMeasureLines(); renderMeasures();
  rebuildPinDots(); renderPins();
  rebuildStrokes(); renderStrokes();
  if (task.note) $('task-note').value = task.note;
  if (task.refRot && state.ref) { state.ref.mesh.rotation.fromArray(task.refRot); updatePose(); }
  if (task.pose && state.ref && task.pose.shift) { state.ref.mesh.position.fromArray(task.pose.shift); updatePose(); }
  if (task.view && task.view.camera) {
    camera.position.fromArray(task.view.camera);
    controls.target.fromArray(task.view.target || controls.target.toArray());
    controls.update();
  }
  if (task.explode) setExplodeAxis(task.explode.axis || 'x');
  saved(true);
  $('task-out').innerHTML = `открыта задача <b>${state.taskId}</b>`;
  hint('задача открыта: ' + state.taskId);
  await refreshTasks();
}
$('tasks-refresh').onclick = refreshTasks;

function updateLayers() {
  const size = (role) => {
    const info = state[role];
    return info ? `${fmt(info.size.x)} × ${fmt(info.size.y)} × ${fmt(info.size.z)}` : '—';
  };
  $('layer-model').textContent = size('model');
  $('layer-ref').textContent = size('ref');
  $('layer-strokes').textContent = state.strokes.length ? String(state.strokes.length) : '—';

  const b = $('bbox');
  const t = state.model || state.ref;
  if (!t) { b.textContent = 'ничего не загружено'; $('st-bbox').textContent = 'габарит —'; return; }
  const bb = t.box;
  b.innerHTML = `<b>${fmt(t.size.x)} × ${fmt(t.size.y)} × ${fmt(t.size.z)}</b> мм<br>` +
    `X ${fmt(bb.min.x)} … ${fmt(bb.max.x)}<br>Y ${fmt(bb.min.y)} … ${fmt(bb.max.y)}<br>Z ${fmt(bb.min.z)} … ${fmt(bb.max.z)}`;
  $('st-bbox').textContent = `габарит ${fmt(t.size.x)} × ${fmt(t.size.y)} × ${fmt(t.size.z)}`;
}

/* ------------------------------------------------------------------ клики по сцене */
let downPos = null;

canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  if (state.mode === 'draw') { strokeStart(e); return; }
  if (state.mode === 'move' && !gizmoOn()) dragStart(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (drawing) { strokePoint(e); return; }
  if (drag) dragMove(e);
});
canvas.addEventListener('pointerup', (e) => {
  if (drawing) { strokeEnd(); downPos = null; return; }
  if (drag) { dragEnd(); downPos = null; return; }
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 4 || state.mode === 'orbit') return;   // это было вращение, не клик
  const hit = pick(e);
  if (!hit) { if (state.mode !== 'orbit') hint('мимо — кликни по самой детали'); return; }
  if (state.mode === 'measure') addMeasurePoint(hit);
  if (state.mode === 'pin') addPin(hit);
  if (state.mode === 'draw') {                 // одиночный клик — тоже штрих из одной точки
    pushUndo();
    state.strokes.push({ points: [hit.point.toArray().map((v) => +v.toFixed(3))] });
    rebuildStrokes(); renderStrokes(); updateLayers();
  }
});

function pick(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = [];
  for (const s of [state.model, state.ref]) {
    if (!s) continue;
    // после «разнести → вернуть» части остаются в памяти, но скрыты: тогда цель — целая сетка
    if (s.parts && s.parts.some((q) => q.mesh.visible)) {
      targets.push(...s.parts.filter((q) => q.mesh.visible).map((q) => q.mesh));
    } else if (s.mesh.visible) targets.push(s.mesh);
  }
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  const h = hits[0];
  return { point: h.point.clone(),
           normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 0, 1),
           role: h.object.userData.role };
}

/* ------------------------------------------------------------------ замеры */
const measureGroup = new THREE.Group();
scene.add(measureGroup);

function addMeasurePoint(hit) {
  pushUndo();
  if (!state.pending) {
    state.pending = hit.point.clone();
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x4ec9ff }));
    dot.position.copy(hit.point);
    dot.userData.temp = true;
    measureGroup.add(dot);
    hint('первая точка есть — кликни вторую');
    return;
  }
  const a = state.pending;
  const b = hit.point.clone();
  measureGroup.children.filter((c) => c.userData.temp).forEach((c) => {
    measureGroup.remove(c); c.geometry.dispose(); c.material.dispose();
  });
  state.pending = null;

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([a, b]),
    new THREE.LineBasicMaterial({ color: 0x4ec9ff }));
  measureGroup.add(line);
  const s = Math.max(0.35, Math.min(1.2, a.distanceTo(b) * 0.04));
  for (const p of [a, b]) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x9fe3ff }));
    dot.position.copy(p);
    measureGroup.add(dot);
  }
  const m = { a: a.toArray(), b: b.toArray() };
  state.measures.push(m);
  renderMeasures();
  hint('замер добавлен');
}

function renderMeasures() {
  $('m-count').textContent = state.measures.length;
  const box = $('measure-list');
  box.innerHTML = '';
  if (!state.measures.length) { box.innerHTML = '<div class="empty">пока пусто</div>'; return; }
  state.measures.forEach((m, i) => {
    const d = new THREE.Vector3(...m.a).distanceTo(new THREE.Vector3(...m.b));
    const dv = new THREE.Vector3(...m.b).sub(new THREE.Vector3(...m.a));
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="head"><span class="idx">${i + 1}</span>
        <span class="txt">${fmt(d)} мм</span>
        <button data-go="${i}" title="подлететь">◎</button>
        <button data-del="${i}">×</button></div>
      <div class="sub">Δx ${fmt(dv.x)}  Δy ${fmt(dv.y)}  Δz ${fmt(dv.z)}</div>`;
    el.querySelector('[data-go]').onclick = (ev) => {
      ev.stopPropagation();
      const p = new THREE.Vector3(...m.a).add(new THREE.Vector3(...m.b)).multiplyScalar(0.5);
      const dist = camera.position.distanceTo(controls.target);
      controls.target.copy(p);
      camera.position.copy(p).add(new THREE.Vector3(0.6, -0.7, 0.5).normalize().multiplyScalar(dist));
      controls.update();
      hint('подлетел к замеру ' + (i + 1));
    };
    el.querySelector('[data-del]').onclick = (ev) => {
      ev.stopPropagation();
      pushUndo();
      state.measures.splice(i, 1);
      rebuildMeasureLines();
      renderMeasures();
    };
    box.append(el);
  });
}

function rebuildMeasureLines() {
  [...measureGroup.children].forEach((c) => { measureGroup.remove(c); c.geometry.dispose(); c.material.dispose(); });
  for (const m of state.measures) {
    const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
    measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0x4ec9ff })));
    const s = Math.max(0.35, Math.min(1.2, a.distanceTo(b) * 0.04));
    for (const p of [a, b]) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0x9fe3ff }));
      dot.position.copy(p);
      measureGroup.add(dot);
    }
  }
}
$('measures-clear').onclick = () => {
  state.measures = [];
  state.pending = null;
  rebuildMeasureLines();
  renderMeasures();
  hint('замеры стёрты');
};

/* ------------------------------------------------------------------ замечания */
const pinGroup = new THREE.Group();
scene.add(pinGroup);

function addPin(hit) {
  pushUndo();
  const id = state.pins.length + 1;
  const pin = {
    id,
    point: hit.point.toArray(),
    normal: hit.normal.toArray(),
    comment: '',
    camera: { pos: camera.position.toArray(), target: controls.target.toArray() },
  };
  state.pins.push(pin);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0xffb84e }));
  dot.position.copy(hit.point);
  dot.userData.pinId = id;
  pinGroup.add(dot);
  renderPins(true, id);
}

function renderPins(focus = false, focusId = null) {
  $('p-count').textContent = state.pins.length;
  const box = $('pin-list');
  box.innerHTML = '';
  if (!state.pins.length) { box.innerHTML = '<div class="empty">пока пусто</div>'; return; }
  state.pins.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="head"><span class="idx">${p.id}</span>
        <span class="txt">${fmt(p.point[0])}, ${fmt(p.point[1])}, ${fmt(p.point[2])}</span>
        <button data-go="1" title="подлететь">◎</button>
        <button data-del="1">×</button></div>
      <textarea class="note" placeholder="что тут не так"></textarea>`;
    const ta = el.querySelector('textarea');
    ta.value = p.comment;
    ta.oninput = () => { p.comment = ta.value; };
    ta.onfocus = () => el.scrollIntoView({ block: 'nearest' });
    el.querySelector('[data-go]').onclick = (ev) => {
      ev.stopPropagation();
      camera.position.fromArray(p.camera.pos);
      controls.target.fromArray(p.camera.target);
      controls.update();
    };
    el.querySelector('[data-del]').onclick = (ev) => {
      ev.stopPropagation();
      state.pins = state.pins.filter((q) => q.id !== p.id);
      const dot = pinGroup.children.find((c) => c.userData.pinId === p.id);
      if (dot) { pinGroup.remove(dot); dot.geometry.dispose(); dot.material.dispose(); }
      renderPins();
    };
    box.append(el);
    if (focus && focusId === p.id) setTimeout(() => ta.focus(), 30);
  });
}
$('pins-clear').onclick = () => {
  state.pins = [];
  [...pinGroup.children].forEach((c) => { pinGroup.remove(c); c.geometry.dispose(); c.material.dispose(); });
  renderPins();
  hint('замечания стёрты');
};

/* ------------------------------------------------------------------ сравнение */
const RAMP = [
  [0.00, new THREE.Color(0x2b6cff)],
  [0.25, new THREE.Color(0x00d4ff)],
  [0.50, new THREE.Color(0x38e06b)],
  [0.75, new THREE.Color(0xffe14d)],
  [1.00, new THREE.Color(0xff4d4d)],
];
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [t0, c0] = RAMP[i], [t1, c1] = RAMP[i + 1];
    if (t <= t1) return c0.clone().lerp(c1, (t - t0) / (t1 - t0));
  }
  return RAMP[RAMP.length - 1][1].clone();
}

async function compareWithRef() {
  if (!state.model || !state.ref) { hint('сравнивать пока не с чем — работает и один файл'); activate('tasks'); return; }
  setExplode(0);
  hint('считаю расстояния…');
  $('st-dot').className = 'dot warn';
  const body = new URLSearchParams({ mine: state.model.path, ref: state.ref.path });
  const res = await fetch('/api/compare', { method: 'POST', body });
  const data = await res.json();
  if (data.error) { hint('сравнение не вышло: ' + data.error); return; }

  const raw = atob(data.distances);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const signed = new Float32Array(bytes.buffer);
  const nSample = signed.length;
  const nVert = state.model.geo.attributes.position.count;

  const abs = Array.from(signed, Math.abs);
  const p95 = data.stats.p95;
  state.scaleMax = Math.max(p95 * 1.25, 0.05);

  const colors = new Float32Array(nVert * 3);
  for (let i = 0; i < nVert; i++) {
    const s = Math.floor((i / nVert) * nSample);
    const v = abs[Math.min(nSample - 1, s)] ?? 0;
    const c = ramp(v / state.scaleMax);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  state.model.geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  state.model.mat.vertexColors = true;
  state.model.mat.color.set(0xffffff);
  state.model.mat.needsUpdate = true;

  const st = data.stats;
  state.compare = { rms: st.rms, mean: st.mean, p95: st.p95, max: st.max, n: data.n };
  $('compare-box').classList.remove('hidden');
  $('compare-empty').hidden = true;
  $('compare-stats').innerHTML =
    `отклонение по вершинам, мм\nrms <b>${fmt(st.rms, 3)}</b>   среднее ${fmt(st.mean, 3)}\n` +
    `медиана ${fmt(st.median, 3)}   p95 ${fmt(st.p95, 3)}   max ${fmt(st.max, 3)}\n` +
    `знак средней ${fmt(st.signed_mean, 3)} мм (${st.signed_mean > 0 ? 'наружу' : 'внутрь'})\n` +
    `точек ${data.n} из ${data.mine_vertices}${data.subsampled ? ' (прорежено)' : ''}, ${data.seconds} с` +
    (data.align && data.align.done
      ? `<span class="sub">позу совместил сам: было ${fmt(data.align.rms_before, 3)} мм</span>`
      : data.align && data.align.error
        ? `<span class="sub">без совмещения: ${data.align.error}</span>` : '');
  const lm = $('legend-max');
  lm.textContent = '>' + fmt(state.scaleMax, 2) + ' мм';
  lm.title = `шкала 0…${fmt(state.scaleMax, 2)} мм = p95×1.25; max по сетке ${fmt(st.max, 3)} мм — он и уходит в красный`;
  $('st-rms').textContent = 'дифф ' + fmt(st.rms, 3) + ' мм';
  $('st-dot').className = 'dot ok';
  buildPill();
  hint('раскраска по отклонению от эталона');
  activate('compare');
}

function clearCompare() {
  if (!state.model) return;
  state.model.geo.deleteAttribute('color');
  state.model.mat.vertexColors = false;
  state.model.mat.color.copy(MODEL_COLOR);
  state.model.mat.needsUpdate = true;
  state.compare = null;
  $('compare-box').classList.add('hidden');
  $('compare-empty').hidden = false;
  $('st-rms').textContent = 'дифф —';
  hint('раскраска убрана');
}

/* ------------------------------------------------------------------ задача и очередь */
async function saveTask(opts = {}) {
  const requestFix = !!opts.request_fix;
  const t = state.model || state.ref;
  if (!t) { hint('сначала открой STL'); return; }
  const payload = {
    kind: 'viewer-task',
    request_fix: requestFix,
    model: state.model ? { path: state.model.path,
      bbox: [state.model.size.x, state.model.size.y, state.model.size.z].map((v) => +v.toFixed(3)) } : null,
    ref: state.ref ? { path: state.ref.path,
      bbox: [state.ref.size.x, state.ref.size.y, state.ref.size.z].map((v) => +v.toFixed(3)) } : null,
    bbox: { size: [t.size.x, t.size.y, t.size.z].map((v) => +v.toFixed(3)),
            min: t.box.min.toArray().map((v) => +v.toFixed(3)),
            max: t.box.max.toArray().map((v) => +v.toFixed(3)) },
    analyze: state.analyze || null,
    view: { camera: camera.position.toArray().map((v) => +v.toFixed(2)),
            target: controls.target.toArray().map((v) => +v.toFixed(2)) },
    measurements: state.measures.map((m) => {
      const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
      const d = a.distanceTo(b);
      const dv = b.clone().sub(a);
      return { a: m.a.map((v) => +v.toFixed(3)), b: m.b.map((v) => +v.toFixed(3)),
               mm: +d.toFixed(3),
               dx: +dv.x.toFixed(3), dy: +dv.y.toFixed(3), dz: +dv.z.toFixed(3) };
    }),
    pins: state.pins.map((p) => ({ id: p.id,
      point: p.point.map((v) => +v.toFixed(3)),
      normal: p.normal.map((v) => +v.toFixed(3)),
      comment: p.comment,
      camera: { pos: p.camera.pos.map((v) => +v.toFixed(2)), target: p.camera.target.map((v) => +v.toFixed(2)) } })),
    strokes: state.strokes.map((s) => ({ points: s.points })),
    compare: state.compare,
    pose: state.ref ? { shift: state.ref.mesh.position.toArray().map((v) => +v.toFixed(3)) } : null,
    clip: Object.fromEntries(AXES.map((ax) => [ax, clip[ax].on ? +clip[ax].t.toFixed(3) : null])),
    explode: { axis: explode.axis, k: +explode.k.toFixed(3) },
    refRot: state.ref ? state.ref.mesh.rotation.toArray().slice(0, 3).map((v) => +v.toFixed(4)) : null,
    note: $('task-note').value,
  };
  const res = await fetch('/api/task', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.error) { $('task-out').textContent = 'ошибка: ' + data.error; hint('задача не сохранилась'); return; }
  state.taskId = data.id;
  window.__lastTask = payload;
  saved(true);
  $('task-out').innerHTML = requestFix
    ? `в очереди: <b>${data.id}</b><br>${state.pins.length} замеч. · ${state.measures.length} замеров · ${state.strokes.length} штрихов<br>скажи в чате: «посмотри задачу ${data.id}»`
    : `черновик: <b>${data.id}</b><br>в очередь не поставлен`;
  hint(requestFix ? 'задача в очереди на исправление' : 'черновик сохранён');
  await refreshTasks();
  activate('tasks');
}

/* ------------------------------------------------------------------ мелочи UI */
function hint(text) { $('hint').textContent = text; }

function setMode(mode) {
  state.mode = mode;
  controls.enabled = mode !== 'draw';          // рисование не должно вертеть камеру
  for (const m of ['orbit', 'measure', 'pin', 'draw', 'move']) {
    const el = $('mode-' + m);
    if (el) el.classList.toggle('active', m === mode);
  }
  hint(mode === 'measure' ? 'клик — точка, второй клик — расстояние'
    : mode === 'pin' ? 'клик по месту, где надо поправить'
    : mode === 'draw' ? 'веди мышью по детали — линия ляжет на поверхность'
    : mode === 'move' ? 'тяни стрелку или кольцо у эталона'
    : 'вращай: ЛКМ — поворот, колесо — зум, ПКМ/Shift — сдвиг');

  if (mode === 'move') {
    if (state.ref) { gizmo.attach(state.ref.mesh); hint('гизмо на эталоне: тяни ось, R — кольца'); }
    else hint('эталона нет — он нужен только для сравнения');
  } else {
    gizmo.detach();
  }
}

$('mode-orbit').onclick = () => setMode('orbit');
$('mode-measure').onclick = () => { setMode('measure'); activate('measure'); };
$('mode-pin').onclick = () => { setMode('pin'); activate('notes'); };
$('mode-draw').onclick = () => { setMode('draw'); activate('notes'); };
$('mode-move').onclick = () => { setMode('move'); activate('params'); };
$('btn-compare').onclick = compareWithRef;
$('btn-clear-compare').onclick = clearCompare;
$('btn-fix').onclick = () => saveTask({ request_fix: true });
$('btn-task-top').onclick = () => saveTask({ request_fix: true });
$('btn-task').onclick = () => saveTask({});
$('btn-copy').onclick = async () => {
  if (!window.__lastTask) { hint('сначала сохрани задачу или черновик'); return; }
  await navigator.clipboard.writeText(JSON.stringify(window.__lastTask, null, 2));
  hint('JSON задачи в буфере обмена');
};
$('docname').onclick = () => $('file-input').click();
$('chk-grid').onchange = (e) => { grid.visible = e.target.checked; };
$('chk-wire').onchange = (e) => {
  if (state.model) state.model.mat.wireframe = e.target.checked;
};
$('chk-axes').onchange = (e) => { axes.visible = e.target.checked; };
$('chk-ghost').onchange = (e) => {
  if (!state.ref) return;
  const ghost = e.target.checked;
  state.ref.mat.opacity = ghost ? 0.22 : 0.95;
  state.ref.mat.depthWrite = !ghost;
  state.ref.mat.needsUpdate = true;
};
$('file-input').onchange = async (e) => {
  for (const f of e.target.files) await uploadAndLoad(f);
};
$('btn-open').onclick = () => $('file-input').click();
/* файл можно бросить куда угодно в окне: панели файлов больше нет */
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  for (const f of e.dataTransfer.files) await uploadAndLoad(f);
});

async function uploadAndLoad(file) {
  hint('загружаю ' + file.name + '…');
  const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name),
    { method: 'POST', body: await file.arrayBuffer() });
  const data = await res.json();
  if (data.error) { hint('не вышло: ' + data.error); return; }
  await loadFile(data.path, state.model ? 'ref' : 'model');
}

addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveTask({ request_fix: true }); return; }
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveTask({}); return; }
  if (e.key === 'o' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('file-input').click(); return; }
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (e.key === 'y' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); redo(); return; }
  if (e.key === '1') setMode('orbit');
  if (e.key === '2') { setMode('measure'); activate('measure'); }
  if (e.key === '3') { setMode('pin'); activate('notes'); }
  if (e.key === '4') { setMode('move'); activate('params'); }
  if (e.key === '5') { setMode('draw'); activate('notes'); }
  if (e.key === 'r' || e.key === 'R') {
    const cur = document.querySelector('#gizmo-mode button.on');
    setGizmoMode(cur && cur.dataset.gmode === 'rotate' ? 'translate' : 'rotate');
    if (!gizmoOn() && state.ref) setMode('move');
  }
  if (e.key === 'f' || e.key === 'F') fitCamera();
  if (e.key === 'Escape') {
    if (drawing) { drawing = null; }
    if (state.pending) {
      state.pending = null;
      measureGroup.children.filter((c) => c.userData.temp).forEach((c) => measureGroup.remove(c));
      hint('точка отменена');
      return;
    }
    if (state.mode !== 'orbit') { setMode('orbit'); hint('вышли из режима'); }
  }
});

/* ------------------------------------------------------------------ проекции подписей */
function screenBox() {
  const t = state.model || state.ref;
  const b = t.box, r = canvas.getBoundingClientRect();
  const xs = [], ys = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
    const v = new THREE.Vector3(x, y, z).project(camera);
    xs.push(r.left + (v.x * 0.5 + 0.5) * r.width);
    ys.push(r.top + (-v.y * 0.5 + 0.5) * r.height);
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

const tmp = new THREE.Vector3();
function updateLabels() {
  labelsBox.innerHTML = '';
  const push = (p3, text, cls) => {
    tmp.copy(p3).project(camera);
    if (tmp.z > 1) return;
    const r = stage.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'lbl ' + cls;
    el.textContent = text;
    el.style.left = ((tmp.x * 0.5 + 0.5) * r.width) + 'px';
    el.style.top = ((-tmp.y * 0.5 + 0.5) * r.height) + 'px';
    labelsBox.append(el);
  };
  state.measures.forEach((m, i) => {
    const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    push(mid, `${i + 1}: ${fmt(a.distanceTo(b))}`, 'dist');
  });
  for (const p of state.pins) push(new THREE.Vector3(...p.point), String(p.id), 'pin');
}

/* ------------------------------------------------------------------ срез плоскостями */
function applyClip() {
  const t = state.model || state.ref;
  const planes = [];
  for (const ax of AXES) {
    const row = document.querySelector(`.clip-row[data-axis="${ax}"]`);
    if (!row) continue;
    const rng = row.querySelector('.clip-pos');
    const val = row.querySelector('.clip-val');
    rng.disabled = !clip[ax].on;
    clipPlanes[ax].normal.copy(AXIS_V[ax]);
    if (!clip[ax].on || !t) { val.textContent = '—'; continue; }
    const i = AXIS_I[ax];
    const lo = t.box.min.getComponent(i), hi = t.box.max.getComponent(i);
    const v = lo + (hi - lo) * clip[ax].t;
    clipPlanes[ax].constant = -v;         // режем положительную сторону: остаётся всё ниже v
    planes.push(clipPlanes[ax]);
    val.textContent = fmt(v) + ' мм';
  }
  for (const role of ['model', 'ref']) {
    const s = state[role];
    if (!s) continue;
    s.mat.clippingPlanes = planes.length ? planes : null;
    s.mat.needsUpdate = true;
  }
  return planes.length;
}

document.querySelectorAll('.clip-row[data-axis]').forEach((row) => {
  const ax = row.dataset.axis;
  row.querySelector('.clip-on').onchange = (e) => {
    pushUndo();
    clip[ax].on = e.target.checked;
    applyClip();
    hint(clip[ax].on ? `срез ${ax.toUpperCase()} включён` : `срез ${ax.toUpperCase()} снят`);
  };
  row.querySelector('.clip-pos').oninput = (e) => { clip[ax].t = +e.target.value / 1000; applyClip(); };
  row.querySelector('.clip-pos').onchange = () => pushUndo();
});

$('clip-reset').onclick = () => {
  pushUndo();
  for (const ax of AXES) { clip[ax].on = false; clip[ax].t = 0.5; }
  document.querySelectorAll('.clip-row[data-axis]').forEach((row) => {
    row.querySelector('.clip-on').checked = false;
    row.querySelector('.clip-pos').value = '500';
  });
  applyClip();
  hint('все срезы сняты');
};

/* ------------------------------------------------------------------ гизмо эталона */
const gizmo = new TransformControls(camera, canvas);
gizmo.setSize(0.75);
gizmo.setSpace('world');
gizmo.addEventListener('mouseDown', () => { controls.enabled = false; pushUndo(); });
gizmo.addEventListener('mouseUp', () => { controls.enabled = true; updatePose(); });
gizmo.addEventListener('objectChange', () => updatePose());
scene.add(gizmo.getHelper());

function gizmoOn() { return !!gizmo.object; }

function setGizmoMode(mode) {
  gizmo.setMode(mode);
  document.querySelectorAll('#gizmo-mode button').forEach((b) => b.classList.toggle('on', b.dataset.gmode === mode));
  hint(mode === 'rotate' ? 'кольца — поворот вокруг осей' : 'стрелки — сдвиг вдоль осей');
}
document.querySelectorAll('#gizmo-mode button').forEach((b) => { b.onclick = () => setGizmoMode(b.dataset.gmode); });

/* ------------------------------------------------------------------ тащим эталон мышью */
let drag = null;
const dragPlane = new THREE.Plane();
const dragHit = new THREE.Vector3();
const viewDir = new THREE.Vector3();

function dragStart(e) {
  if (!state.ref) { hint('эталон не загружен — включи его в «Файлах»'); return; }
  const hit = pick(e);
  if (!hit) { hint('возьмись за сам эталон'); return; }
  if (hit.role !== 'ref') { hint('двигать можно только эталон — он подкрашен синим'); return; }
  camera.getWorldDirection(viewDir);
  dragPlane.setFromNormalAndCoplanarPoint(viewDir.negate(), hit.point);
  drag = { grab: hit.point.clone(), pos0: state.ref.mesh.position.clone() };
  controls.enabled = false;
  pushUndo();
}

function dragMove(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (!raycaster.ray.intersectPlane(dragPlane, dragHit)) return;
  state.ref.mesh.position.copy(drag.pos0).add(dragHit.clone().sub(drag.grab));
  updatePose();
}

function dragEnd() {
  drag = null;
  controls.enabled = true;
  updatePose();
  hint('эталон подвинут');
}

function updatePose() {
  const out = $('pose-out');
  if (!out) return;
  if (!state.ref) { out.textContent = 'эталона нет'; return; }
  const p = state.ref.mesh.position;
  const d = state.ref.mesh.rotation;
  const deg = (v) => (v * 180 / Math.PI).toFixed(1);
  out.innerHTML = `сдвиг <b>${fmt(p.x)}</b> · ${fmt(p.y)} · ${fmt(p.z)} мм<br>поворот ${deg(d.x)} · ${deg(d.y)} · ${deg(d.z)}°`;
}
$('pose-reset').onclick = () => {
  if (!state.ref) { hint('эталона нет'); return; }
  pushUndo();
  state.ref.mesh.position.set(0, 0, 0);
  state.ref.mesh.rotation.set(0, 0, 0);
  updatePose();
  hint('поза эталона сброшена');
};
$('pose-snap').onclick = () => {
  if (!state.model || !state.ref) { hint('нужны и модель, и эталон'); return; }
  pushUndo();
  state.ref.mesh.position.copy(state.model.center).sub(state.ref.center);
  updatePose();
  hint('эталон приложен по центру модели');
};

/* ------------------------------------------------------------------ отмена действий */
const undoStack = [];
const redoStack = [];

function snapState() {
  return JSON.stringify({
    measures: state.measures,
    pins: state.pins.map((p) => ({ id: p.id, point: p.point, normal: p.normal, comment: p.comment, camera: p.camera })),
    strokes: state.strokes,
    explode: { axis: explode.axis, k: explode.k },
    refPos: state.ref ? state.ref.mesh.position.toArray() : null,
    refRot: state.ref ? state.ref.mesh.rotation.toArray().slice(0, 3) : null,
    clip: JSON.parse(JSON.stringify(clip)),
  });
}

function pushUndo() {
  undoStack.push(snapState());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}

function rebuildPinDots() {
  [...pinGroup.children].forEach((c) => { pinGroup.remove(c); c.geometry.dispose(); c.material.dispose(); });
  for (const p of state.pins) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xffb84e }));
    dot.position.fromArray(p.point);
    dot.userData.pinId = p.id;
    pinGroup.add(dot);
  }
}

function restoreState(json) {
  const s = JSON.parse(json);
  state.measures = s.measures || [];
  state.pins = s.pins || [];
  state.strokes = s.strokes || [];
  rebuildMeasureLines();
  renderMeasures();
  rebuildPinDots();
  renderPins();
  rebuildStrokes();
  renderStrokes();
  updateLayers();
  if (s.explode) { explode.axis = s.explode.axis || 'x'; setExplode(s.explode.k || 0); }
  if (state.ref && s.refPos) { state.ref.mesh.position.fromArray(s.refPos); updatePose(); }
  if (state.ref && s.refRot) { state.ref.mesh.rotation.fromArray(s.refRot); updatePose(); }
  if (s.clip) {
    for (const ax of AXES) {
      clip[ax].on = !!s.clip[ax].on;
      clip[ax].t = s.clip[ax].t;
      const row = document.querySelector(`.clip-row[data-axis="${ax}"]`);
      row.querySelector('.clip-on').checked = clip[ax].on;
      row.querySelector('.clip-pos').value = String(Math.round(clip[ax].t * 1000));
    }
    applyClip();
  }
}

function undo() {
  if (!undoStack.length) { hint('отменять нечего'); return; }
  redoStack.push(snapState());
  restoreState(undoStack.pop());
  hint('шаг отменён');
}

function redo() {
  if (!redoStack.length) { hint('повторять нечего'); return; }
  undoStack.push(snapState());
  restoreState(redoStack.pop());
  hint('шаг возвращён');
}

/* ------------------------------------------------------------------ видовой куб */
/* Классический CAD-куб, как в Fusion/SolidWorks: шесть подписанных граней,
   кликабельные рёбра и углы, рядом цветные оси X/Y/Z. Куб стоит на месте,
   камера куба смотрит туда же, куда основная — видно, откуда смотришь. */
const VC = 128;                       // сторона миникарты, px
const VC_S = 1.5;                     // ребро куба в сцене кубика
const VC_H = VC_S / 2;
const VC_ACC = 0xf29a38;              // акцент приложения — им же подсветка
const vcHost = $('vc-host');
const vcRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
vcRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
vcRenderer.setSize(VC, VC, false);
vcRenderer.setClearAlpha(0);
vcHost.append(vcRenderer.domElement);

const vcScene = new THREE.Scene();
const vcCam = new THREE.OrthographicCamera(-1.42, 1.42, 1.42, -1.42, 0.1, 40);

/* шесть граней: подпись словами + координата оси, как в CAD-кубиках */
const VC_SIDES = [
  { label: 'RIGHT',  axis: '+X', n: [ 1, 0, 0], up: [0, 0, 1] },
  { label: 'LEFT',   axis: '−X', n: [-1, 0, 0], up: [0, 0, 1] },
  { label: 'BACK',   axis: '+Y', n: [ 0, 1, 0], up: [0, 0, 1] },
  { label: 'FRONT',  axis: '−Y', n: [ 0,-1, 0], up: [0, 0, 1] },
  { label: 'TOP',    axis: '+Z', n: [ 0, 0, 1], up: [0, 1, 0] },
  { label: 'BOTTOM', axis: '−Z', n: [ 0, 0,-1], up: [0, 1, 0] },
];
const VC_AXIS_COLOR = { X: '#e2574c', Y: '#59b45f', Z: '#4f8fe0' };

function vcFaceTexture(label) {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = '#262b33';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(150,158,172,.42)';     // светлая нитка по ребру, как в CAD-кубике
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, s - 3, s - 3);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#dfe3ea';
  g.font = '700 58px "IBM Plex Sans", system-ui, sans-serif';
  g.fillText(label, s / 2, s / 2 + 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* тёмная подложка: швы между плитками читаются как рёбра куба */
const vcCore = new THREE.Mesh(
  new THREE.BoxGeometry(VC_S * 0.986, VC_S * 0.986, VC_S * 0.986),
  new THREE.MeshBasicMaterial({ color: 0x1d2127 }));
vcCore.raycast = () => {};
vcScene.add(vcCore);

const vcFaces = [];
for (const def of VC_SIDES) {
  const n = new THREE.Vector3(def.n[0], def.n[1], def.n[2]);
  const up = new THREE.Vector3(def.up[0], def.up[1], def.up[2]);
  const right = new THREE.Vector3().crossVectors(up, n).normalize();   // right × up = n
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(VC_S, VC_S),
    new THREE.MeshBasicMaterial({ map: vcFaceTexture(def.label) }));
  plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
  plane.position.copy(n).multiplyScalar(VC_H);
  plane.userData = { kind: 'face', n: def.n, label: def.label };
  const hl = new THREE.Mesh(
    new THREE.PlaneGeometry(VC_S * 0.99, VC_S * 0.99),
    new THREE.MeshBasicMaterial({ color: VC_ACC, transparent: true, opacity: 0.52, depthWrite: false }));
  hl.position.z = 0.005;
  hl.visible = false;
  hl.raycast = () => {};
  plane.add(hl);
  plane.userData.hl = hl;
  vcScene.add(plane);
  vcFaces.push(plane);
}

/* рёбра и углы: невидимые тела-мишени, нормаль = сумма нормалей смежных граней.
   Клик по такой мишени даёт диагональный вид (по ребру) или изометрию (по углу). */
function vcInvisible() {
  return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
}
function vcHighlight(geo, radiusScale) {
  const hl = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: VC_ACC }));
  hl.visible = false;
  hl.raycast = () => {};
  return hl;
}

const vcEdges = [];
const VC_EDGE_R = 0.085;
for (let i = 0; i < 3; i++) {
  for (let j = i + 1; j < 3; j++) {
    const k = 3 - i - j;                       // вдоль этой оси тянется ребро
    for (const si of [-1, 1]) {
      for (const sj of [-1, 1]) {
        const pos = [0, 0, 0];
        pos[i] = si * VC_H;
        pos[j] = sj * VC_H;
        const axis = [0, 0, 0];
        axis[k] = 1;
        const n = [0, 0, 0];
        n[i] = si;
        n[j] = sj;
        const hit = new THREE.Mesh(new THREE.CylinderGeometry(VC_EDGE_R, VC_EDGE_R, VC_S, 10), vcInvisible());
        hit.position.set(pos[0], pos[1], pos[2]);
        hit.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...axis));
        hit.userData = { kind: 'edge', n, label: 'ребро' };
        const hl = vcHighlight(new THREE.CylinderGeometry(VC_EDGE_R * 0.6, VC_EDGE_R * 0.6, VC_S, 10));
        hl.position.copy(hit.position);
        hl.quaternion.copy(hit.quaternion);
        hit.userData.hl = hl;
        vcScene.add(hit, hl);
        vcEdges.push(hit);
      }
    }
  }
}

const vcCorners = [];
const VC_CORNER_R = 0.15;
for (const sx of [-1, 1]) {
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const hit = new THREE.Mesh(new THREE.SphereGeometry(VC_CORNER_R, 12, 8), vcInvisible());
      hit.position.set(sx * VC_H, sy * VC_H, sz * VC_H);
      hit.userData = { kind: 'corner', n: [sx, sy, sz], label: 'угол' };
      const hl = vcHighlight(new THREE.SphereGeometry(VC_CORNER_R * 0.78, 12, 8));
      hl.position.copy(hit.position);
      hit.userData.hl = hl;
      vcScene.add(hit, hl);
      vcCorners.push(hit);
    }
  }
}

/* оси мира: X красная, Y зелёная, Z синяя и вверх — торчат за куб, как в CAD */
const VC_AXES = [
  { v: [1, 0, 0], color: 0xe2574c, label: 'X' },
  { v: [0, 1, 0], color: 0x59b45f, label: 'Y' },
  { v: [0, 0, 1], color: 0x4f8fe0, label: 'Z' },
];
const VC_AX_LEN = 1.16;
const vcAxisHits = [];
function vcAxisLabel(text, color) {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = '#' + color.toString(16).padStart(6, '0');
  g.font = '700 46px "IBM Plex Sans", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, s / 2, s / 2 + 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true }));
  sp.scale.set(0.34, 0.34, 1);
  return sp;
}
for (const a of VC_AXES) {
  const dir = new THREE.Vector3(a.v[0], a.v[1], a.v[2]);
  const mat = new THREE.MeshBasicMaterial({ color: a.color });
  // тонкая нитка, как в CAD: без стрелки-конуса, буква на конце сама показывает направление
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, VC_AX_LEN, 8), mat);
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  shaft.position.copy(dir).multiplyScalar(VC_AX_LEN / 2);
  shaft.userData = { kind: 'axis', n: a.v, label: a.label };
  const sp = vcAxisLabel(a.label, a.color);
  sp.position.copy(dir).multiplyScalar(VC_AX_LEN + 0.1);
  sp.scale.set(0.24, 0.24, 1);
  sp.raycast = () => {};
  vcScene.add(shaft, sp);
  vcAxisHits.push(shaft);
}

const vcRay = new THREE.Raycaster();
const vcPointer = new THREE.Vector2();

/* камера сцены смотрит строго по оси — кубик от этого становится плоским квадратом.
   Поэтому сам кубик отворачиваем на 11°: видна грань и две узкие полосы соседних, как в CAD. */
const VC_TILT = THREE.MathUtils.degToRad(11);
function vcTiltDir(dir) {
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  if (Math.max(ax, ay, az) < 0.985) return dir;          // камера уже под углом
  const up = az > 0.985 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  return dir.clone()
    .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(up, -VC_TILT))
    .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(right, VC_TILT));
}

function vcSync() {
  const off = new THREE.Vector3().subVectors(camera.position, controls.target);
  if (off.lengthSq() < 1e-9) return;
  off.copy(vcTiltDir(off.normalize()));
  off.multiplyScalar(6);
  vcCam.position.copy(off);
  // при взгляде вдоль Z (сверху/снизу) опорный «верх» надо менять, иначе кадр выворачивает
  vcCam.up.set(0, 0, 1);
  if (Math.abs(off.z) / off.length() > 0.985) vcCam.up.set(0, 1, 0);
  vcCam.lookAt(0, 0, 0);
  vcRenderer.render(vcScene, vcCam);
}

function lookFromNormal(n, straight) {
  const t = state.model || state.ref;
  if (!t) { hint('сначала открой STL'); return; }
  const r = Math.max(t.size.x, t.size.y, t.size.z) * 2.1;
  const dir = new THREE.Vector3(n[0], n[1], n[2]).normalize();
  // по грани — «телеобъектив» (перспектива почти не искажает); по ребру/углу — обычный обзор
  const k = straight ? 8.2 : 1;
  camera.fov = straight ? 8 : 45;
  camera.up.set(0, 0, 1);
  if (Math.abs(dir.z) > 0.985) camera.up.set(0, 1, 0);   // сверху/снизу — иначе камера кувыркается
  camera.position.copy(t.center).add(dir.multiplyScalar(r * k));
  camera.near = Math.max(r / 400, 0.01);
  camera.far = r * 60 * k;
  camera.updateProjectionMatrix();
  controls.target.copy(t.center);
  controls.update();
  vcSync();
}

/* что под курсором: сначала рёбра/углы/оси (они мельче и важнее), потом грань.
   Видимость считаем по нормали: мишени с обратной стороны куба не должны ловить клик. */
function vcPick(e) {
  const r = vcRenderer.domElement.getBoundingClientRect();
  vcPointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  vcPointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  vcRay.setFromCamera(vcPointer, vcCam);
  const toCam = new THREE.Vector3().subVectors(vcCam.position, new THREE.Vector3()).normalize();
  const facing = (n) => n[0] * toCam.x + n[1] * toCam.y + n[2] * toCam.z > 0.05;
  const near = vcRay.intersectObjects([...vcCorners, ...vcEdges, ...vcAxisHits], false)
    .filter((h) => facing(h.object.userData.n));
  if (near.length) return near[0].object;
  const fh = vcRay.intersectObjects(vcFaces, false);
  return fh.length ? fh[0].object : null;
}

let vcHovered = null;
function vcSetHover(obj) {
  if (vcHovered === obj) return;
  if (vcHovered && vcHovered.userData.hl) vcHovered.userData.hl.visible = false;
  vcHovered = obj;
  if (vcHovered && vcHovered.userData.hl) vcHovered.userData.hl.visible = true;
  vcHost.style.cursor = obj ? 'pointer' : 'grab';
  vcHost.title = obj
    ? (obj.userData.kind === 'face' ? 'вид ' + obj.userData.label
      : obj.userData.kind === 'axis' ? 'вид вдоль оси ' + obj.userData.label
      : obj.userData.kind === 'edge' ? 'диагональ по ребру'
      : 'изометрия из угла')
    : 'щелкни по грани, ребру или углу';
}

vcHost.addEventListener('pointermove', (e) => vcSetHover(vcPick(e)));
vcHost.addEventListener('pointerleave', () => vcSetHover(null));
vcHost.addEventListener('pointerup', (e) => {
  const obj = vcPick(e);
  if (!obj) return;
  const u = obj.userData;
  lookFromNormal(u.n, u.kind === 'face');
  if (u.kind === 'face') hint('вид: ' + u.label.toLowerCase());
  else if (u.kind === 'axis') hint('вид вдоль оси ' + u.label);
  else if (u.kind === 'edge') hint('вид по ребру — диагональ');
  else hint('изометрия из угла');
  vcSetHover(null);
});

$('btn-iso').onclick = () => setView('iso');

function setViewCubeOnce() { vcSync(); }

/* ------------------------------------------------------------------ разнесение сборки */
const explode = { axis: 'x', k: 0 };
const EXPLODE_GAP = 0.8;              // сколько габаритов на шаг разлёта

/* тела ищутся по связности треугольников: STL не индексирован, вершины склеиваем по координате */
function splitBodies(geo) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  const q = 1e4;
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const k = Math.round(pos.getX(i) * q) + ',' + Math.round(pos.getY(i) * q) + ',' + Math.round(pos.getZ(i) * q);
    const f = seen.get(k);
    if (f === undefined) seen.set(k, i); else union(f, i);
  }
  // вершины одного треугольника обязаны быть в одной компоненте: иначе
  // треугольник с уникальными по округлению вершинами считается отдельным телом
  for (let t = 0; t < n / 3; t++) { union(t * 3, t * 3 + 1); union(t * 3 + 1, t * 3 + 2); }

  const groups = new Map();
  for (let t = 0; t < n / 3; t++) {
    const r = find(t * 3);
    let a = groups.get(r);
    if (!a) groups.set(r, a = []);
    a.push(t);
  }
  const out = [];
  for (const tris of groups.values()) {
    const arr = new Float32Array(tris.length * 9);
    let o = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        arr[o++] = pos.getX(i); arr[o++] = pos.getY(i); arr[o++] = pos.getZ(i);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    out.push(g);
  }
  out.sort((a, b) => b.attributes.position.count - a.attributes.position.count);
  return out;
}

function dropParts(role) {
  const s = state[role];
  if (!s || !s.parts) return;
  for (const q of s.parts) { scene.remove(q.mesh); q.geo.dispose(); }
  s.parts = null;
}

function ensureParts() {
  const m = state.model;
  if (!m) return null;
  if (m.parts) return m.parts;
  const tris = m.geo.attributes.position.count / 3;
  if (tris > 700000) { hint('сетка ' + tris.toLocaleString('ru-RU') + ' граней — разнесение не потяну'); return null; }
  const t0 = performance.now();
  let geos = splitBodies(m.geo);
  if (geos.length > 60) {                       // мусорная нарезка: деталь одна, кусков тысячи
    hint('сетка не делится на тела — считаю одной деталью');
    geos.forEach((g) => g.dispose());
    return null;                                 // тело одно: разносить нечего
  }
  m.parts = geos.map((g) => {
    const mesh = new THREE.Mesh(g, m.mat);
    mesh.userData.role = 'model';
    mesh.visible = false;
    scene.add(mesh);
    return { geo: g, mesh };
  });
  const sec = ((performance.now() - t0) / 1000).toFixed(2);
  hint('тел в сетке: ' + geos.length + ' · ' + sec + ' с');
  $('explode-cap').textContent = geos.length > 1
    ? `тел ${geos.length} — разносит вдоль ${explode.axis.toUpperCase()}, видно, что с чем сходится`
    : 'тело одно — разносить нечего; срез и замеры работают как обычно';
  return m.parts;
}

function setExplode(k) {
  explode.k = Math.max(0, Math.min(1, k));
  $('explode-range').value = String(Math.round(explode.k * 1000));
  const m = state.model;
  if (!m) { $('explode-val').textContent = '—'; return; }

  const back = () => {
    if (m.parts) m.parts.forEach((q) => { q.mesh.visible = false; q.mesh.position.set(0, 0, 0); });
    m.mesh.visible = $('vis-model').checked;
  };
  if (explode.k === 0) { back(); $('explode-val').textContent = '0 мм'; return; }

  const parts = ensureParts();
  if (!parts) { back(); $('explode-val').textContent = '—'; return; }
  if (parts.length < 2) {
    back();
    $('explode-val').textContent = 'тело 1';
    $('explode-cap').textContent = 'в этом файле одно тело — разнести нечего';
    return;
  }

  m.mesh.visible = false;
  const i = AXIS_I[explode.axis];
  const lo = m.box.min.getComponent(i), hi = m.box.max.getComponent(i);
  const span = Math.max(hi - lo, 0.001);
  const n = parts.length;
  parts.forEach((q, idx) => {
    q.mesh.visible = $('vis-model').checked;
    const off = (idx - (n - 1) / 2) * span * EXPLODE_GAP * explode.k;
    q.mesh.position.set(0, 0, 0);
    q.mesh.position.setComponent(i, off);
  });
  $('explode-val').textContent = fmt(span * EXPLODE_GAP * explode.k) + ' мм';
  $('explode-cap').textContent = `тел ${n} вдоль ${explode.axis.toUpperCase()} — шаг ${fmt(span * EXPLODE_GAP * explode.k)} мм`;
}

function setExplodeAxis(axis) {
  explode.axis = axis;
  document.querySelectorAll('#explode-axis button').forEach((b) => b.classList.toggle('on', b.dataset.axis === axis));
  if (explode.k > 0) setExplode(explode.k);
}

document.querySelectorAll('#explode-axis button').forEach((b) => { b.onclick = () => setExplodeAxis(b.dataset.axis); });
$('explode-range').oninput = (e) => setExplode(+e.target.value / 1000);
$('explode-range').onchange = () => pushUndo();
$('explode-step').onclick = () => {
  const n = state.model && state.model.parts ? state.model.parts.length : 0;
  const step = n > 1 ? 1 / (n - 1) : 0.2;
  const k = Math.round((explode.k + step) * 1000) / 1000;
  setExplode(k > 1.0001 ? 0 : k);
  hint(k > 1.0001 ? 'собрал обратно' : 'шаг разнесения ' + Math.round(Math.min(k, 1) * 100) + '%');
};
$('explode-all').onclick = () => setExplode(explode.k >= 1 ? 0 : 1);
$('explode-reset').onclick = () => { pushUndo(); setExplode(0); hint('собрано'); };

/* ------------------------------------------------------------------ рисование по модели */
const strokeGroup = new THREE.Group();
scene.add(strokeGroup);
let drawing = null;
const STROKE_LIFT = 0.15;             // мм над поверхностью, чтобы линия не тонула в сетке

function liftedPoint(hit) {
  return hit.point.clone().add(hit.normal.clone().multiplyScalar(STROKE_LIFT));
}

function strokeStart(e) {
  const hit = pick(e);
  if (!hit) { hint('веди по самой детали'); return; }
  pushUndo();
  const p = liftedPoint(hit);
  drawing = { points: [p.toArray().map((v) => +v.toFixed(3))], line: null };
  const g = new THREE.BufferGeometry().setFromPoints([p, p]);
  drawing.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff5ea8 }));
  strokeGroup.add(drawing.line);
}

function strokePoint(e) {
  if (!drawing) return;
  const hit = pick(e);
  if (!hit) return;
  const p = liftedPoint(hit);
  const last = new THREE.Vector3(...drawing.points[drawing.points.length - 1]);
  if (p.distanceTo(last) < 0.22) return;          // прореживаем: иначе на каждый пиксель своя точка
  drawing.points.push(p.toArray().map((v) => +v.toFixed(3)));
  drawing.line.geometry.setFromPoints(drawing.points.map((q) => new THREE.Vector3(...q)));
}

function strokeEnd() {
  if (!drawing) return;
  const d = drawing;
  drawing = null;
  strokeGroup.remove(d.line);
  d.line.geometry.dispose();
  d.line.material.dispose();
  if (d.points.length < 2) { hint('штрих из одной точки не сохраняю'); return; }
  state.strokes.push({ points: d.points });
  rebuildStrokes();
  renderStrokes();
  updateLayers();
  hint('штрих добавлен — их ' + state.strokes.length);
}

function rebuildStrokes() {
  [...strokeGroup.children].forEach((c) => {
    strokeGroup.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  });
  for (const s of state.strokes) {
    if (!s.points || s.points.length < 2) continue;
    const g = new THREE.BufferGeometry().setFromPoints(s.points.map((q) => new THREE.Vector3(...q)));
    strokeGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff5ea8 })));
  }
  strokeGroup.visible = $('vis-strokes').checked;
}

function renderStrokes() {
  $('s-count').textContent = state.strokes.length;
  const box = $('stroke-list');
  box.innerHTML = '';
  if (!state.strokes.length) { box.innerHTML = '<div class="empty">пока пусто</div>'; return; }
  state.strokes.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="head"><span class="idx">${i + 1}</span>
        <span class="txt">штрих, ${s.points.length} точек</span>
        <button data-del="${i}">×</button></div>`;
    el.querySelector('[data-del]').onclick = (ev) => {
      ev.stopPropagation();
      pushUndo();
      state.strokes.splice(i, 1);
      rebuildStrokes();
      renderStrokes();
      updateLayers();
    };
    box.append(el);
  });
}
$('strokes-clear').onclick = () => {
  pushUndo();
  state.strokes = [];
  rebuildStrokes();
  renderStrokes();
  updateLayers();
  hint('рисунок стёрт');
};

/* ------------------------------------------------------------------ видимость слоёв */
$('vis-model').onchange = (e) => {
  const m = state.model;
  if (!m) return;
  if (m.parts && explode.k > 0) m.parts.forEach((q) => { q.mesh.visible = e.target.checked; });
  else m.mesh.visible = e.target.checked;
  hint(e.target.checked ? 'модель показываю' : 'модель спрятана');
};
$('vis-ref').onchange = (e) => {
  if (!state.ref) return;
  state.ref.mesh.visible = e.target.checked;
  hint(e.target.checked ? 'эталон показываю' : 'эталон спрятан');
};
$('vis-strokes').onchange = (e) => {
  strokeGroup.visible = e.target.checked;
  hint(e.target.checked ? 'рисунок показываю' : 'рисунок спрятан');
};

/* ------------------------------------------------------------------ облёт */
$('btn-spin').onclick = () => {
  controls.autoRotate = !controls.autoRotate;
  controls.autoRotateSpeed = 1.8;
  $('btn-spin').style.color = controls.autoRotate ? 'var(--acc)' : '';
  hint(controls.autoRotate ? 'облёт включён — само крутится' : 'облёт выключен');
};
controls.autoRotateSpeed = 1.8;

/* ------------------------------------------------------------------ цикл */
function resize() {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(stage);

function loop() {
  try {
    controls.update();
    renderer.render(scene, camera);
    updateLabels();
    vcSync();
  } catch (err) {
    // кадр не должен умирать молча: показываем причину и продолжаем крутить
    const st = document.querySelector('.status .hint') || document.querySelector('.status');
    if (st) st.textContent = 'кадр упал: ' + err.message;
    if (!loop.warned) { console.error(err); loop.warned = true; }
  }
  requestAnimationFrame(loop);
}

resize();
refreshTasks();
setMode('orbit');
renderMeasures();
renderPins();
renderStrokes();
buildPill();
updateLayers();
saved(false);
setViewCubeOnce();

/* ссылка вида ?model=path&ref=path&mode=measure — открыть сразу с сетками */
const params = new URLSearchParams(location.search);
(async () => {
  if (params.get('model')) await loadFile(params.get('model'), 'model');
  if (params.get('ref')) await loadFile(params.get('ref'), 'ref');
  if (params.get('mode')) setMode(params.get('mode'));
  if (params.get('compare') && state.model && state.ref) await compareWithRef();
  else if (params.get('panel')) activate(params.get('panel'));
  if (params.get('selftest')) await selftest();
})();

/* самопроверка в браузере: ?selftest=1 — кладёт итог в title и в подсказку */
async function selftest() {
  const out = { errors: [] };
  try {
    const t = state.model || state.ref;
    const c = t.center, r = Math.max(t.size.x, t.size.y, t.size.z) * 0.35;

    // настоящие клики мышью по канвасу: проверяем рейкаст, а не только логику
    fitCamera();
    setView('iso');
    camera.updateMatrixWorld(true);
    await new Promise((res) => setTimeout(res, 150));
    const sb = screenBox();                       // куда проецируется габарит детали
    const click = (fx, fy) => {                    // fx/fy — доля внутри этого прямоугольника
      const cx = sb.x0 + (sb.x1 - sb.x0) * fx, cy = sb.y0 + (sb.y1 - sb.y0) * fy;
      const opt = { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opt));
      canvas.dispatchEvent(new PointerEvent('pointerup', opt));
    };
    setMode('measure');
    click(0.38, 0.5);
    out.pendingAfterFirst = !!state.pending;
    click(0.62, 0.5);
    out.measures = state.measures.length;
    if (state.measures.length !== 1) out.errors.push('клик по детали не дал замера');
    else out.mm = +new THREE.Vector3(...state.measures[0].a)
      .distanceTo(new THREE.Vector3(...state.measures[0].b)).toFixed(3);

    setMode('pin');
    click(0.5, 0.42);
    if (state.pins.length !== 1) {
      addPin({ point: new THREE.Vector3(c.x, c.y, c.z + r), normal: new THREE.Vector3(0, 0, 1) });
      out.errors.push('клик не создал замечание, создал вручную');
    }
    state.pins[0].comment = 'проверка связи';
    renderPins();
    out.pins = state.pins.length;
    if (state.pins.length !== 1) out.errors.push('замечание не создалось');

    if (state.model && state.ref) {
      await compareWithRef();
      const cbox = $('compare-box');
      out.compareVisible = !cbox.classList.contains('hidden');
      out.compareText = $('compare-stats').textContent.replace(/\s+/g, ' ').slice(0, 120);
      out.vertexColors = !!state.model.geo.attributes.color;
      if (!out.compareVisible) out.errors.push('сравнение не показалось');
      if (!out.vertexColors) out.errors.push('раскраска не появилась');
    }

    const res = await fetch('/api/task', { method: 'POST', body: JSON.stringify(
      { kind: 'selftest', model: state.model ? { path: state.model.path } : null,
        ref: state.ref ? { path: state.ref.path } : null,
        measurements: state.measures.map((m) => ({ a: m.a, b: m.b })),
        pins: state.pins.map((q) => ({ id: q.id, comment: q.comment, point: q.point })),
        pose: state.ref ? state.ref.mesh.position.toArray() : null,
        clip: Object.fromEntries(AXES.map((ax) => [ax, clip[ax].on ? clip[ax].t : null])),
        note: 'самопроверка интерфейса' }) });
    const task = await res.json();
    out.taskFile = task.rel || task.error;
    if (!task.rel) out.errors.push('задача не сохранилась');

    // три плоскости: ставим все галочки, у каждой своё положение
    const rows = [...document.querySelectorAll('.clip-row[data-axis]')];
    rows.forEach((row, i) => {
      row.querySelector('.clip-on').checked = true;
      row.querySelector('.clip-on').dispatchEvent(new Event('change'));
      const rng = row.querySelector('.clip-pos');
      rng.value = String(350 + i * 120);
      rng.dispatchEvent(new Event('input'));
    });
    out.clipPlanes = (state.model.mat.clippingPlanes || []).length;
    out.clipLabels = rows.map((row) => row.dataset.axis + ':' + row.querySelector('.clip-val').textContent).join(' ');
    if (out.clipPlanes !== 3) out.errors.push('три плоскости не применились: ' + out.clipPlanes);
    rows.forEach((row) => {
      row.querySelector('.clip-on').checked = false;
      row.querySelector('.clip-on').dispatchEvent(new Event('change'));
    });
    if (state.model.mat.clippingPlanes) out.errors.push('срезы не снялись');

    // гизмо: режим «двигать» должен привязаться к эталону, поворот — попасть в позу
    if (state.ref) {
      setMode('move');
      out.gizmoAttached = gizmoOn();
      if (!out.gizmoAttached) out.errors.push('гизмо не привязалось к эталону');
      state.ref.mesh.rotation.z = Math.PI / 6;
      updatePose();
      out.poseText = $('pose-out').innerText.replace(/\s+/g, ' ').slice(0, 60);
      pushUndo();
      state.ref.mesh.rotation.set(0, 0, 0);
      updatePose();
      undo();
      out.undoRot = +(state.ref.mesh.rotation.z * 180 / Math.PI).toFixed(1);
      if (Math.abs(out.undoRot - 30) > 1.5) out.errors.push('отмена не вернула поворот: ' + out.undoRot);
      state.ref.mesh.rotation.set(0, 0, 0);
      out.gizmoMode = document.querySelector('#gizmo-mode button.on').dataset.gmode;
      setGizmoMode('rotate');
      out.gizmoModeAfter = document.querySelector('#gizmo-mode button.on').dataset.gmode;
      setGizmoMode('translate');
      setMode('orbit');
      out.gizmoDetached = !gizmoOn();
    }

    setMode('orbit');

    // ── п.1: видовой куб ────────────────────────────────────────
    const vcCanvas = vcHost.querySelector('canvas');
    out.viewcube = !!vcCanvas && vcCanvas.width > 40;
    if (!out.viewcube) out.errors.push('видовой куб не отрисовался');
    vcSync();
    const vr = vcCanvas.getBoundingClientRect();
    out.cubeCounts = { faces: vcFaces.length, edges: vcEdges.length, corners: vcCorners.length, axes: vcAxisHits.length };
    if (out.cubeCounts.faces !== 6) out.errors.push('граней у куба не шесть');
    if (out.cubeCounts.edges !== 12) out.errors.push('рёбер у куба не двенадцать');
    if (out.cubeCounts.corners !== 8) out.errors.push('углов у куба не восемь');
    if (out.cubeCounts.axes !== 3) out.errors.push('осей не три');

    // экранная точка любой вершины кубика
    const vcPoint = (v3) => {
      const p = v3.clone().project(vcCam);
      return { clientX: vr.left + (p.x + 1) / 2 * vr.width, clientY: vr.top + (1 - p.y) / 2 * vr.height };
    };
    const vcClick = (pt) => {
      vcHost.dispatchEvent(new PointerEvent('pointermove', { clientX: pt.clientX, clientY: pt.clientY, bubbles: true, pointerId: 7 }));
      vcHost.dispatchEvent(new PointerEvent('pointerup', { clientX: pt.clientX, clientY: pt.clientY, bubbles: true, pointerId: 7 }));
    };
    const vcToCam = vcCam.position.clone().normalize();
    const faceBest = vcFaces.map((f) => ({ f, d: f.userData.n[0] * vcToCam.x + f.userData.n[1] * vcToCam.y + f.userData.n[2] * vcToCam.z }))
      .sort((a, b) => b.d - a.d)[0].f;

    // клик по грани → строго по нормали и теле-режим
    const camBefore = camera.position.clone();
    vcClick(vcPoint(new THREE.Vector3(...faceBest.userData.n).multiplyScalar(VC_H)));
    out.cubeSnap = +camBefore.distanceTo(camera.position).toFixed(2);
    out.cubeFaceFov = camera.fov;
    if (out.cubeSnap < 0.01) out.errors.push('клик по грани куба не сменил вид');
    if (camera.fov !== 8) out.errors.push('грань не включила теле-режим (' + camera.fov + ')');

    // клик по углу → изометрия из этого угла
    vcSync();
    const cornerBest = vcCorners.map((c) => ({ c, d: c.userData.n[0] * vcToCam.x + c.userData.n[1] * vcToCam.y + c.userData.n[2] * vcToCam.z }))
      .sort((a, b) => b.d - a.d)[0].c;
    vcClick(vcPoint(cornerBest.position.clone().multiplyScalar(1.0)));
    out.cubeCornerFov = camera.fov;
    const cdir = [camera.position.x - controls.target.x, camera.position.y - controls.target.y, camera.position.z - controls.target.z];
    out.cubeCornerDir = cdir.map((v) => Math.sign(v)).join(',');
    out.cubeCornerWant = cornerBest.userData.n.map((v) => Math.sign(v)).join(',');
    if (camera.fov !== 45) out.errors.push('угол не включил обзор (' + camera.fov + ')');
    if (out.cubeCornerDir !== out.cubeCornerWant) out.errors.push('камера встала не в тот угол: ' + out.cubeCornerDir + ' вместо ' + out.cubeCornerWant);

    // клик по ребру → диагональ, и подсветка загорается/гаснет
    vcSync();
    const toCam2 = vcCam.position.clone().normalize();
    const edgeBest = vcEdges
      .map((e) => ({ e, d: e.userData.n[0] * toCam2.x + e.userData.n[1] * toCam2.y + e.userData.n[2] * toCam2.z }))
      .sort((a, b) => b.d - a.d)[0].e;
    const ep = vcPoint(edgeBest.position.clone());
    vcHost.dispatchEvent(new PointerEvent('pointermove', { clientX: ep.clientX, clientY: ep.clientY, bubbles: true, pointerId: 7 }));
    out.cubeHover = edgeBest.userData.hl.visible;
    if (!out.cubeHover) out.errors.push('подсветка ребра не загорается');
    vcClick(ep);
    out.cubeEdgeDir = [camera.position.x - controls.target.x, camera.position.y - controls.target.y, camera.position.z - controls.target.z].map((v) => Math.sign(v)).join(',');
    out.cubeEdgeWant = edgeBest.userData.n.map((v) => Math.sign(v)).join(',');
    if (out.cubeEdgeDir !== out.cubeEdgeWant) out.errors.push('клик по ребру встал не туда: ' + out.cubeEdgeDir);
    if (!vcFaces.every((f) => !f.userData.hl.visible)) out.errors.push('подсветка не гаснет после клика');

    // ── п.2: разнесение ─────────────────────────────────────────
    setExplode(1);
    out.explode =
      { parts: state.model && state.model.parts ? state.model.parts.length : 0,
        shown: state.model && state.model.parts ? state.model.parts.filter((q) => q.mesh.visible).length : 0,
        text: $('explode-val').textContent };
    setExplode(0);
    out.explodeBack = state.model ? state.model.mesh.visible : false;

    // ── п.4: рисование по поверхности ───────────────────────────
    setMode('draw');
    setView('iso');
    camera.updateMatrixWorld(true);
    const sb2 = screenBox();                     // после клика по кубу вид другой — мерим заново
    const st = (fx, fy) => ({ clientX: sb2.x0 + (sb2.x1 - sb2.x0) * fx, clientY: sb2.y0 + (sb2.y1 - sb2.y0) * fy });
    // на сборке из нескольких тел центр кадра бывает пустым — ищем точку с геометрией
    let hit = null;
    for (let gx = 0.15; gx <= 0.87 && !hit; gx += 0.09)
      for (let gy = 0.15; gy <= 0.87 && !hit; gy += 0.09)
        if (pick(st(gx, gy))) hit = { gx, gy };
    out.drawHit = !!hit;
    if (hit) {
      // идём от найденной точки, добавляя только те, что реально лежат на детали:
      // на мелкой детали старт «на 2% левее» уводит луч мимо поверхности
      const path = [{ gx: hit.gx, gy: hit.gy }];
      for (let k = 1; k <= 3; k++) {
        const c = { gx: hit.gx + 0.02 * k * 0.6, gy: hit.gy + 0.02 * k * 0.35 };
        if (pick(st(c.gx, c.gy))) path.push(c);
      }
      out.strokePoints = path.length;
      strokeStart(st(path[0].gx, path[0].gy));
      for (let k = 1; k < path.length; k++) strokePoint(st(path[k].gx, path[k].gy));
      strokeEnd();
    }
    out.strokes = state.strokes.length;
    out.strokeLines = strokeGroup.children.length;
    if (!out.strokes) out.errors.push('рисование не дало штриха');
    out.strokeToggleOff = (() => { const cb = $('vis-strokes'); cb.checked = false; cb.dispatchEvent(new Event('change'));
                                   const v = strokeGroup.visible; cb.checked = true; cb.dispatchEvent(new Event('change')); return v; })();
    setMode('orbit');

    // ── п.5: авто-разбор и слои ────────────────────────────────
    // разбор идёт по сети и может занять секунды (первый вызов грузит trimesh)
    for (let i = 0; i < 60 && state.model && !state.analyze; i++) await new Promise((r) => setTimeout(r, 250));
    out.analyze = state.analyze ? { tris: state.analyze.triangles, bodies: state.analyze.bodies, sec: state.analyze.seconds } : null;
    if (state.model && !state.analyze) out.errors.push('авто-разбор не пришёл');
    out.analyzeText = $('analyze-out').textContent.replace(/\s+/g, ' ').slice(0, 80);
    if (state.ref) {
      const cb = $('vis-ref');
      cb.checked = false; cb.dispatchEvent(new Event('change'));
      out.refHidden = state.ref.mesh.visible === false;
      cb.checked = true; cb.dispatchEvent(new Event('change'));
      out.refShown = state.ref.mesh.visible === true;
      if (!out.refHidden || !out.refShown) out.errors.push('переключатель эталона не работает');
    }

    // ── задачи: список и возврат ───────────────────────────────
    await refreshTasks();
    out.taskRows = document.querySelectorAll('#task-list .trow').length;

    out.labels = document.querySelectorAll('#labels .lbl').length;
    out.triangles = state.model ? state.model.geo.attributes.position.count / 3 : 0;
    out.dom = {
      rail: document.querySelectorAll('#rail button').length,
      panels: document.querySelectorAll('.panel').length,
      pill: $('build-state').textContent,
      status: $('st-bbox').textContent,
    };
  } catch (e) {
    out.errors.push('исключение: ' + e.message + ' @ ' + String((e.stack || '').split('\n')[1] || '').trim().slice(0, 110));
  }
  out.ok = out.errors.length === 0;
  window.__selftest = out;
  document.title = 'SELFTEST ' + (out.ok ? 'OK' : 'FAIL') + ' ' + JSON.stringify(out);
  if (!params.get('quiet')) hint(JSON.stringify(out));
  return out;
}

loop();

// отладка из консоли: window.__dbg.state.model.mesh и т.п.
window.__dbg = { THREE, renderer, camera, scene, controls, gizmo, clip, clipPlanes, state, applyClip,
  setGizmoMode, updateLabels, explode, setExplode, setExplodeAxis, splitBodies, strokeGroup, vcRenderer, vcSync, vcPick, vcFaces, vcEdges, vcCorners, vcCam, lookFromNormal,
  loadTask, refreshTasks, saveTask, analyze, selftest,
  setMode, setView, pick, screenBox, hint, activate, strokeStart, strokePoint, strokeEnd };
