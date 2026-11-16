import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ------------------------------------------------------------------ сцена */
const canvas = document.getElementById('c');
const stage = document.getElementById('stage');
const labelsBox = document.getElementById('labels');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.up.set(0, 0, 1);                       // CAD-ось вверх — Z
camera.position.set(60, -80, 60);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xdde6f5, 0x30363f, 2.1));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1, -1.4, 2.2);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9fc4ff, 0.7);
fill.position.set(-1.6, 1.2, 0.6);
scene.add(fill);

const grid = new THREE.GridHelper(200, 40, 0x38424f, 0x262d36);
grid.rotation.x = Math.PI / 2;                // в плоскость XY
scene.add(grid);

const axes = new THREE.AxesHelper(6);
axes.visible = false;               // включается галочкой «сетка»
scene.add(axes);

/* ------------------------------------------------------------------ состояние */
const MODEL_COLOR = new THREE.Color(0xc9d3e2);
const state = {
  model: null,          // {path, geo, mesh, bbox}
  ref: null,
  mode: 'orbit',        // orbit | measure | pin
  pending: null,        // первая точка замера
  measures: [],
  pins: [],
  compare: null,
  scaleMax: 1,
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

/* ------------------------------------------------------------------ загрузка */
const loader = new STLLoader();

function fmt(v, d = 2) { return (Math.round(v * 10 ** d) / 10 ** d).toFixed(d); }
function bboxOf(geo) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  return { size: b.getSize(new THREE.Vector3()), center: b.getCenter(new THREE.Vector3()), box: b.clone() };
}

async function loadFile(path, role) {
  const res = await fetch('/api/mesh?path=' + encodeURIComponent(path));
  if (!res.ok) { hint('не смог загрузить: ' + (await res.text())); return; }
  const buf = await res.arrayBuffer();
  const geo = loader.parse(buf);
  geo.computeVertexNormals();
  setSlot(role, path, geo);
  refreshFiles();
}

function setSlot(role, path, geo) {
  dropSlot(role);
  const isModel = role === 'model';
  const mat = isModel
    ? new THREE.MeshStandardMaterial({ color: MODEL_COLOR.clone(), metalness: 0.15, roughness: 0.55,
        flatShading: false, vertexColors: false, wireframe: document.getElementById('chk-wire').checked })
    : new THREE.MeshStandardMaterial({ color: new THREE.Color(0x3fb6ff), metalness: 0.0, roughness: 0.8,
        transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.role = role;
  scene.add(mesh);
  const info = { path, geo, mesh, ...bboxOf(geo) };
  state[role] = info;
  if (isModel) document.getElementById('chk-ghost').checked = true;
  fitCamera();
  updateLayers();
  hint(isModel ? 'модель: ' + path.split('/').pop() : 'эталон: ' + path.split('/').pop());
}

function dropSlot(role) {
  const cur = state[role];
  if (cur) { scene.remove(cur.mesh); cur.geo.dispose(); cur.mesh.material.dispose(); }
  state[role] = null;
  state.compare = null;
  document.getElementById('compare-box').classList.add('hidden');
}

function fitCamera() {
  const t = state.model || state.ref;
  if (!t) return;
  const r = Math.max(t.size.x, t.size.y, t.size.z);
  const d = r * 2.1;
  controls.target.copy(t.center);
  camera.position.set(t.center.x + d * 0.62, t.center.y - d * 0.72, t.center.z + d * 0.55);
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
  const pos = { iso: [c.x + r * .62, c.y - r * .72, c.z + r * .55],
                front: [c.x, c.y - r, c.z],
                top: [c.x, c.y, c.z + r],
                right: [c.x + r, c.y, c.z] }[kind];
  camera.position.set(pos[0], pos[1], pos[2]);
  controls.target.copy(c);
  controls.update();
}

/* ------------------------------------------------------------------ список файлов */
let fileCache = [];

async function refreshFiles() {
  const res = await fetch('/api/files');
  const { files } = await res.json();
  fileCache = files;
  const box = document.getElementById('file-list');
  box.innerHTML = '';
  if (!files.length) { box.innerHTML = '<div style="color:var(--dim)">тут нет STL — перетащи файл</div>'; return; }
  for (const f of files.slice(0, 400)) {
    const row = document.createElement('div');
    row.className = 'file';
    if (state.model && state.model.path === f.path) row.classList.add('loaded-model');
    if (state.ref && state.ref.path === f.path) row.classList.add('loaded-ref');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.rel;
    name.title = f.path;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = (f.size / 1024).toFixed(0) + 'K';
    const bModel = document.createElement('button');
    bModel.textContent = 'моя';
    bModel.title = 'загрузить как мою модель';
    bModel.onclick = () => loadFile(f.path, 'model');
    const bRef = document.createElement('button');
    bRef.textContent = 'эталон';
    bRef.title = 'загрузить как эталон';
    bRef.onclick = () => loadFile(f.path, 'ref');
    row.append(name, size, bModel, bRef);
    box.append(row);
  }
}

function updateLayers() {
  const set = (role, id) => {
    const el = document.getElementById(id);
    const info = state[role];
    el.querySelector('.lsize').textContent = info
      ? `${fmt(info.size.x)} × ${fmt(info.size.y)} × ${fmt(info.size.z)} мм`
      : '—';
  };
  set('model', 'layer-model');
  set('ref', 'layer-ref');

  const b = document.getElementById('bbox');
  const t = state.model || state.ref;
  if (!t) { b.textContent = ''; return; }
  const bb = t.box;
  b.innerHTML = `габарит <b>${fmt(t.size.x)} × ${fmt(t.size.y)} × ${fmt(t.size.z)}</b> мм<br>` +
    `X ${fmt(bb.min.x)} … ${fmt(bb.max.x)}<br>Y ${fmt(bb.min.y)} … ${fmt(bb.max.y)}<br>Z ${fmt(bb.min.z)} … ${fmt(bb.max.z)}`;
}

/* ------------------------------------------------------------------ клики по сцене */
let downPos = null;

canvas.addEventListener('pointerdown', (e) => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 4 || state.mode === 'orbit') return;   // это было вращение, не клик
  const hit = pick(e);
  if (!hit) { if (state.mode !== 'orbit') hint('мимо — кликни по самой детали'); return; }
  if (state.mode === 'measure') addMeasurePoint(hit);
  if (state.mode === 'pin') addPin(hit);
});

function pick(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const targets = [state.model, state.ref].filter(Boolean).map((s) => s.mesh);
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  const h = hits[0];
  return { point: h.point.clone(), normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 0, 1),
           role: h.object.userData.role };
}

/* ------------------------------------------------------------------ замеры */
const measureGroup = new THREE.Group();
scene.add(measureGroup);

function addMeasurePoint(hit) {
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
  document.getElementById('m-count').textContent = state.measures.length;
  const box = document.getElementById('measure-list');
  box.innerHTML = '';
  state.measures.forEach((m, i) => {
    const d = new THREE.Vector3(...m.a).distanceTo(new THREE.Vector3(...m.b));
    const dv = new THREE.Vector3(...m.b).sub(new THREE.Vector3(...m.a));
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<div class="head"><span class="idx">${i + 1}</span>
        <span class="txt">${fmt(d)} мм</span>
        <button data-del="${i}">×</button></div>
      <div class="sub">Δx ${fmt(dv.x)}  Δy ${fmt(dv.y)}  Δz ${fmt(dv.z)}</div>`;
    el.querySelector('[data-del]').onclick = (ev) => {
      ev.stopPropagation();
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

/* ------------------------------------------------------------------ замечания */
const pinGroup = new THREE.Group();
scene.add(pinGroup);

function addPin(hit) {
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
  document.getElementById('p-count').textContent = state.pins.length;
  const box = document.getElementById('pin-list');
  box.innerHTML = '';
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
  if (!state.model || !state.ref) { hint('нужны обе сетки: моя и эталон'); return; }
  hint('считаю расстояния…');
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
  state.model.mesh.material.vertexColors = true;
  state.model.mesh.material.color.set(0xffffff);
  state.model.mesh.material.needsUpdate = true;

  const st = data.stats;
  const box = document.getElementById('compare-box');
  box.classList.remove('hidden');
  document.getElementById('compare-stats').innerHTML =
    `отклонение по вершинам, мм\nrms <b>${fmt(st.rms, 3)}</b>   среднее ${fmt(st.mean, 3)}\nмедиана ${fmt(st.median, 3)}   p95 ${fmt(st.p95, 3)}   max ${fmt(st.max, 3)}\n` +
    `знак средней ${fmt(st.signed_mean, 3)} мм (${st.signed_mean > 0 ? 'наружу' : 'внутрь'})\n` +
    `точек ${data.n} из ${data.mine_vertices}${data.subsampled ? ' (прорежено)' : ''}, ${data.seconds} с`;
  const lm = document.getElementById('legend-max');
  lm.textContent = '>' + fmt(state.scaleMax, 2) + ' мм';
  lm.title = `шкала 0…${fmt(state.scaleMax, 2)} мм = p95×1.25; max по сетке ${fmt(st.max, 3)} мм — он и уходит в красный`;
  hint('раскраска по отклонению от эталона');
}

function clearCompare() {
  if (!state.model) return;
  state.model.geo.deleteAttribute('color');
  state.model.mesh.material.vertexColors = false;
  state.model.mesh.material.color.copy(MODEL_COLOR);
  state.model.mesh.material.needsUpdate = true;
  document.getElementById('compare-box').classList.add('hidden');
}

/* ------------------------------------------------------------------ задача агенту */
async function saveTask() {
  const t = state.model || state.ref;
  const payload = {
    kind: 'viewer-task',
    model: state.model ? { path: state.model.path,
      bbox: [state.model.size.x, state.model.size.y, state.model.size.z].map((v) => +v.toFixed(3)) } : null,
    ref: state.ref ? { path: state.ref.path,
      bbox: [state.ref.size.x, state.ref.size.y, state.ref.size.z].map((v) => +v.toFixed(3)) } : null,
    bbox: t ? { size: [t.size.x, t.size.y, t.size.z].map((v) => +v.toFixed(3)),
                min: t.box.min.toArray().map((v) => +v.toFixed(3)),
                max: t.box.max.toArray().map((v) => +v.toFixed(3)) } : null,
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
    compare: state.compare,
    note: document.getElementById('task-note').value,
  };
  const res = await fetch('/api/task', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.error) { document.getElementById('task-out').textContent = 'ошибка: ' + data.error; return; }
  document.getElementById('task-out').innerHTML = `сохранено: <b>${data.rel}</b><br>скажи в чате: «посмотри задачу»`;
  window.__lastTask = payload;
  hint('задача записана в файл');
}

/* ------------------------------------------------------------------ мелочи UI */
function hint(text) { document.getElementById('hint').textContent = text; }

function setMode(mode) {
  state.mode = mode;
  for (const m of ['orbit', 'measure', 'pin']) {
    document.getElementById('mode-' + m).classList.toggle('active', m === mode);
  }
  controls.enableRotate = mode === 'orbit' || true;   // вращать можно всегда, клик ловим по сдвигу
  hint(mode === 'measure' ? 'клик — точка, второй клик — расстояние'
    : mode === 'pin' ? 'клик по месту, где надо поправить'
    : 'вращай: ЛКМ — поворот, колесо — зум, ПКМ/Shift — сдвиг');
}

document.getElementById('mode-orbit').onclick = () => setMode('orbit');
document.getElementById('mode-measure').onclick = () => setMode('measure');
document.getElementById('mode-pin').onclick = () => setMode('pin');
document.querySelectorAll('.view').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
document.getElementById('btn-compare').onclick = compareWithRef;
document.getElementById('btn-clear-compare').onclick = clearCompare;
document.getElementById('btn-task').onclick = saveTask;
document.getElementById('btn-copy').onclick = async () => {
  if (!window.__lastTask) { hint('сначала сохрани задачу'); return; }
  await navigator.clipboard.writeText(JSON.stringify(window.__lastTask, null, 2));
  hint('JSON задачи в буфере обмена');
};
document.getElementById('chk-grid').onchange = (e) => { grid.visible = e.target.checked; };
document.getElementById('chk-wire').onchange = (e) => {
  if (state.model) state.model.mesh.material.wireframe = e.target.checked;
};
document.getElementById('chk-ghost').onchange = (e) => {
  if (!state.ref) return;
  const ghost = e.target.checked;
  state.ref.mesh.material.opacity = ghost ? 0.22 : 0.95;
  state.ref.mesh.material.depthWrite = !ghost;
  state.ref.mesh.material.needsUpdate = true;
};
document.getElementById('file-input').onchange = async (e) => {
  for (const f of e.target.files) await uploadAndLoad(f);
};
const drop = document.getElementById('dropzone');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('hover');
  for (const f of e.dataTransfer.files) await uploadAndLoad(f);
});

async function uploadAndLoad(file) {
  hint('загружаю ' + file.name + '…');
  const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name),
    { method: 'POST', body: await file.arrayBuffer() });
  const data = await res.json();
  await loadFile(data.path, state.model ? 'ref' : 'model');
}

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === '1') setMode('orbit');
  if (e.key === '2') setMode('measure');
  if (e.key === '3') setMode('pin');
  if (e.key === 'f' || e.key === 'F') fitCamera();
  if (e.key === 'Escape' && state.pending) {
    state.pending = null;
    measureGroup.children.filter((c) => c.userData.temp).forEach((c) => measureGroup.remove(c));
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

/* ------------------------------------------------------------------ цикл */
function resize() {
  const r = stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function loop() {
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(loop);
}

resize();
refreshFiles();
setMode('orbit');

/* ссылка вида ?model=path&ref=path&mode=measure — открыть сразу с сетками */
const params = new URLSearchParams(location.search);
(async () => {
  if (params.get('model')) await loadFile(params.get('model'), 'model');
  if (params.get('ref')) await loadFile(params.get('ref'), 'ref');
  if (params.get('mode')) setMode(params.get('mode'));
  if (params.get('compare') && state.model && state.ref) await compareWithRef();
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
      const cbox = document.getElementById('compare-box');
      out.compareVisible = !cbox.classList.contains('hidden');
      out.compareText = document.getElementById('compare-stats').textContent.replace(/\s+/g, ' ').slice(0, 120);
      out.vertexColors = !!state.model.geo.attributes.color;
      if (!out.compareVisible) out.errors.push('сравнение не показалось');
      if (!out.vertexColors) out.errors.push('раскраска не появилась');
    }

    const res = await fetch('/api/task', { method: 'POST', body: JSON.stringify(
      { kind: 'selftest', model: state.model && state.model.path, ref: state.ref && state.ref.path,
        measurements: state.measures.length, pins: state.pins.map((q) => ({ id: q.id, comment: q.comment })),
        note: 'самопроверка интерфейса' }) });
    const task = await res.json();
    out.taskFile = task.rel || task.error;
    if (!task.rel) out.errors.push('задача не сохранилась');

    out.labels = document.querySelectorAll('#labels .lbl').length;
    out.triangles = state.model ? state.model.geo.attributes.position.count / 3 : 0;
  } catch (e) {
    out.errors.push('исключение: ' + e.message);
  }
  out.ok = out.errors.length === 0;
  document.title = 'SELFTEST ' + (out.ok ? 'OK' : 'FAIL') + ' ' + JSON.stringify(out);
  if (!params.get('quiet')) hint(JSON.stringify(out));
  return out;
}

loop();
