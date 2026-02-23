<template>
  <div class="sim-wrap">
    <canvas ref="canvasRef" />
    <div class="hud">
      <div class="top-bar">
        <button class="reset-btn" @click="reset">Reset</button>
        <span class="fps-badge">{{ fpsText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, shallowRef } from "vue";
import * as THREE from "three";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Antigen {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  angVel: THREE.Vector3; // axis × speed in deg/s
  occupiedBy: [number, number];
}

const enum AbState {
  Seeking,
  Docking,
  Docked,
  Undocking,
}

interface Antibody {
  pos: THREE.Vector3;
  scale: number;
  type: number; // 0 = HL (site 0), 1 = AB (site 1)
  state: AbState;
  targetIdx: number;
  targetSlot: number;
  dockT: number;
  dockOrigin: THREE.Vector3;
  rotOrigin: THREE.Quaternion;
  dockedTimer: number;
  rot: THREE.Quaternion;
  angVel: THREE.Vector3;
}

interface DockSite {
  offset: THREE.Vector3;
  rotOff: THREE.Quaternion;
  dockedScale: number;
}

// ── Simulation constants (mirror of Go sim.go) ────────────────────────────────

const NUM_ANTIGENS = 20;
const NUM_ANTIBODIES = 40;
const BOX_HALF = 100;
const AG_SPEED = 4;
const AG_ANG_SPEED = 25;
const AB_SEEK_SPEED = 5;
const AB_ANG_SPEED = 45;
const DOCK_TRIGGER_DIST = 22;
const AG_RADIUS = 10;
const AB_RADIUS = 7;
const DOCKED_DURATION = 30;
const ANIM_SPEED = 0.5;

// ── Simulation helpers ────────────────────────────────────────────────────────

function randomVel(speed: number): THREE.Vector3 {
  while (true) {
    const v = new THREE.Vector3(
      (Math.random() * 2 - 1) * speed,
      (Math.random() * 2 - 1) * speed,
      (Math.random() * 2 - 1) * speed,
    );
    if (v.length() > speed * 0.3) return v;
  }
}

function randomAngVel(speed: number): THREE.Vector3 {
  while (true) {
    const v = new THREE.Vector3(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    );
    if (v.length() > 0.3) return v.normalize().multiplyScalar(speed);
  }
}

function randomInBox(margin = 0): THREE.Vector3 {
  const h = BOX_HALF - margin;
  return new THREE.Vector3(
    (Math.random() * 2 - 1) * h,
    (Math.random() * 2 - 1) * h,
    (Math.random() * 2 - 1) * h,
  );
}

function easeInOutCubic(t: number): number {
  if (t < 0.5) return 4 * t * t * t;
  const t2 = -2 * t + 2;
  return 1 - (t2 * t2 * t2) / 2;
}

function applyAngVel(
  q: THREE.Quaternion,
  angVel: THREE.Vector3,
  dt: number,
): THREE.Quaternion {
  const speed = angVel.length();
  if (speed < 1e-6) return q.clone();
  const axis = angVel.clone().normalize();
  const angleRad = (speed * dt * Math.PI) / 180;
  const delta = new THREE.Quaternion().setFromAxisAngle(axis, angleRad);
  return q.clone().multiply(delta).normalize();
}

function resolveSphereCollision(
  posA: THREE.Vector3,
  velA: THREE.Vector3 | null,
  radA: number,
  posB: THREE.Vector3,
  velB: THREE.Vector3 | null,
  radB: number,
) {
  const dx = posB.x - posA.x,
    dy = posB.y - posA.y,
    dz = posB.z - posA.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const minDist = radA + radB;
  if (dist >= minDist || dist < 1e-6) return;
  const nx = dx / dist,
    ny = dy / dist,
    nz = dz / dist;
  const half = (minDist - dist) * 0.5;
  posA.x -= nx * half;
  posA.y -= ny * half;
  posA.z -= nz * half;
  posB.x += nx * half;
  posB.y += ny * half;
  posB.z += nz * half;
  if (!velA || !velB) return;
  const rvx = velB.x - velA.x,
    rvy = velB.y - velA.y,
    rvz = velB.z - velA.z;
  const dot = rvx * nx + rvy * ny + rvz * nz;
  if (dot >= 0) return;
  velA.x += dot * nx;
  velA.y += dot * ny;
  velA.z += dot * nz;
  velB.x -= dot * nx;
  velB.y -= dot * ny;
  velB.z -= dot * nz;
}

function newSim(): { ags: Antigen[]; abs: Antibody[] } {
  const ags: Antigen[] = Array.from({ length: NUM_ANTIGENS }, () => ({
    pos: randomInBox(AG_RADIUS + 5),
    vel: randomVel(AG_SPEED),
    rot: new THREE.Quaternion(),
    angVel: randomAngVel(AG_ANG_SPEED),
    occupiedBy: [-1, -1] as [number, number],
  }));

  const abs: Antibody[] = Array.from({ length: NUM_ANTIBODIES }, (_, i) => ({
    pos: randomInBox(AB_RADIUS + 5),
    scale: 1,
    type: i % 2,
    state: AbState.Seeking,
    targetIdx: -1,
    targetSlot: -1,
    dockT: 0,
    dockOrigin: new THREE.Vector3(),
    rotOrigin: new THREE.Quaternion(),
    dockedTimer: 0,
    rot: new THREE.Quaternion(),
    angVel: randomAngVel(AB_ANG_SPEED),
  }));

  return { ags, abs };
}

// ── Shaders (mirror of Go shaders/vertex.glsl + fragment.glsl) ───────────────

const vertexShader = /* glsl */ `
  attribute vec3 color;
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vColor;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vPosition = worldPos.xyz;
    // normalize(mat3(modelMatrix) * normal) is correct for uniform scaling
    vNormal = normalize(mat3(modelMatrix) * normal);
    vColor = color;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 lightPos;
  uniform vec3 viewPos;
  uniform vec3 tint;
  varying vec3 vPosition;
  varying vec3 vNormal;
  varying vec3 vColor;

  void main() {
    vec3 baseColor = vColor * tint;
    vec3 normal = normalize(vNormal);

    // Key light
    vec3 lightDir = normalize(lightPos - vPosition);
    float diff = max(dot(normal, lightDir), 0.0);

    // Soft fill from opposite side (PyMOL-style)
    vec3 fillDir = normalize(-lightPos);
    float fill = max(dot(normal, fillDir), 0.0) * 0.18;

    // High ambient, matte, barely-there specular
    float ambient = 0.38;
    vec3 viewDir = normalize(viewPos - vPosition);
    vec3 halfDir  = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 16.0) * 0.06;

    vec3 result = baseColor * (ambient + 0.55 * diff + fill) + vec3(spec);
    gl_FragColor = vec4(result, 1.0);
  }
`;

// ── Binary model loader ───────────────────────────────────────────────────────

interface ModelData {
  geo: THREE.BufferGeometry;
  cx: number;
  cy: number;
  cz: number;
  scale: number;
}

async function loadModel(url: string): Promise<ModelData> {
  const buf = await (await fetch(url)).arrayBuffer();
  const view = new DataView(buf);
  let off = 0;
  const vertCount = view.getUint32(off, true);
  off += 4;
  const triCount = view.getUint32(off, true);
  off += 4;
  const cx = view.getFloat32(off, true);
  off += 4;
  const cy = view.getFloat32(off, true);
  off += 4;
  const cz = view.getFloat32(off, true);
  off += 4;
  const scale = view.getFloat32(off, true);
  off += 4;
  off += 8; // padding

  const positions = new Float32Array(buf, off, vertCount * 3);
  off += vertCount * 3 * 4;
  const normals = new Float32Array(buf, off, vertCount * 3);
  off += vertCount * 3 * 4;
  const colors8 = new Uint8Array(buf, off, vertCount * 4);
  off += vertCount * 4;
  const indices = new Uint32Array(buf, off, triCount * 3);

  // Convert uint8 [0,255] → float [0,1] for Three.js color attribute
  const colors = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    colors[i * 3] = colors8[i * 4] / 255;
    colors[i * 3 + 1] = colors8[i * 4 + 1] / 255;
    colors[i * 3 + 2] = colors8[i * 4 + 2] / 255;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  return { geo, cx, cy, cz, scale };
}

// ── Vue state ─────────────────────────────────────────────────────────────────

const canvasRef = ref<HTMLCanvasElement | null>(null);
const fpsText = ref("-- FPS");
const statusLines = shallowRef<Array<{ id: number; text: string }>>([]);

const STATE_NAMES: Record<AbState, string> = {
  [AbState.Seeking]: "Seeking",
  [AbState.Docking]: "Docking",
  [AbState.Docked]: "Docked",
  [AbState.Undocking]: "Releasing",
};

// ── Three.js + sim state (plain, non-reactive) ────────────────────────────────

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let clock: THREE.Clock;
let animFrame: number;

// Shared uniforms (all meshes read from these)
let sharedUniforms: {
  lightPos: { value: THREE.Vector3 };
  viewPos: { value: THREE.Vector3 };
};

// Per-instance meshes
let agMeshes: THREE.Mesh[] = [];
let abMeshes: THREE.Mesh[] = [];

// Simulation state
let ags: Antigen[] = [];
let abs2: Antibody[] = [];
let sites: DockSite[] = [];

// Camera orbit state
let yaw = 30;
let pitch = 20;
let radius = 90;
let mouseDown = false;
let lastX = 0,
  lastY = 0;

// FPS tracking
let fpsCounter = 0;
let fpsTimer = 0;

// Status tracking
let frameCount = 0;

function reset() {
  const sim = newSim();
  ags = sim.ags;
  abs2 = sim.abs;
  // Reset mesh scales
  abMeshes.forEach((m) => m.scale.setScalar(1));
}

function buildStatusLines() {
  const lines = abs2.map((ab, j) => {
    let text = `AB${j}: ${STATE_NAMES[ab.state]}`;
    if (ab.targetIdx >= 0) text += ` → AG${ab.targetIdx} s${ab.targetSlot}`;
    return { id: j, text };
  });
  statusLines.value = lines;
}

function stepSim(dt: number) {
  // ── Antigen physics ───────────────────────────────────────────────────────
  for (const ag of ags) {
    ag.pos.addScaledVector(ag.vel, dt);
    if (ag.pos.x > BOX_HALF || ag.pos.x < -BOX_HALF) ag.vel.x = -ag.vel.x;
    if (ag.pos.y > BOX_HALF || ag.pos.y < -BOX_HALF) ag.vel.y = -ag.vel.y;
    if (ag.pos.z > BOX_HALF || ag.pos.z < -BOX_HALF) ag.vel.z = -ag.vel.z;
    ag.rot = applyAngVel(ag.rot, ag.angVel, dt);
  }

  // ── Antibody state machines ───────────────────────────────────────────────
  for (let j = 0; j < abs2.length; j++) {
    const ab = abs2[j];
    switch (ab.state) {
      case AbState.Seeking: {
        let bestAG = -1,
          bestDist = Infinity;
        for (let i = 0; i < ags.length; i++) {
          if (ags[i].occupiedBy[ab.type] !== -1) continue;
          const d = ab.pos.distanceTo(ags[i].pos);
          if (d < bestDist) {
            bestDist = d;
            bestAG = i;
          }
        }
        ab.rot = applyAngVel(ab.rot, ab.angVel, dt);
        if (bestAG >= 0) {
          const dir = ags[bestAG].pos.clone().sub(ab.pos).normalize();
          ab.pos.addScaledVector(dir, AB_SEEK_SPEED * dt);
          if (bestDist < DOCK_TRIGGER_DIST) {
            ags[bestAG].occupiedBy[ab.type] = j;
            ab.state = AbState.Docking;
            ab.targetIdx = bestAG;
            ab.targetSlot = ab.type;
            ab.dockT = 0;
            ab.dockOrigin.copy(ab.pos);
            ab.rotOrigin.copy(ab.rot);
          }
        }
        break;
      }

      case AbState.Docking: {
        ab.dockT = Math.min(ab.dockT + dt * ANIM_SPEED, 1);
        const e = easeInOutCubic(ab.dockT);
        const site = sites[ab.targetSlot];
        const ag = ags[ab.targetIdx];

        const rotOff = site.offset.clone().applyQuaternion(ag.rot);
        const dockedWorld = ag.pos.clone().add(rotOff);
        ab.pos.lerpVectors(ab.dockOrigin, dockedWorld, e);
        ab.scale = 1 + (site.dockedScale - 1) * e;

        const targetRot = ag.rot.clone().multiply(site.rotOff);
        ab.rot.slerpQuaternions(ab.rotOrigin, targetRot, e);

        if (ab.dockT >= 1) {
          ab.state = AbState.Docked;
          ab.dockedTimer = DOCKED_DURATION;
        }
        break;
      }

      case AbState.Docked: {
        const site = sites[ab.targetSlot];
        const ag = ags[ab.targetIdx];
        const rotOff = site.offset.clone().applyQuaternion(ag.rot);
        ab.pos.copy(ag.pos).add(rotOff);
        ab.rot.copy(ag.rot).multiply(site.rotOff);
        ab.scale = site.dockedScale;
        ab.dockedTimer -= dt;
        if (ab.dockedTimer <= 0) {
          ab.state = AbState.Undocking;
          ab.dockT = 1;
        }
        break;
      }

      case AbState.Undocking: {
        ab.dockT = Math.max(ab.dockT - dt * ANIM_SPEED, 0);
        const e = easeInOutCubic(ab.dockT);
        const site = sites[ab.targetSlot];
        const ag = ags[ab.targetIdx];

        const rotOff = site.offset.clone().applyQuaternion(ag.rot);
        const dockedWorld = ag.pos.clone().add(rotOff);
        const releaseDir = site.offset
          .clone()
          .normalize()
          .applyQuaternion(ag.rot);
        const releaseWorld = dockedWorld
          .clone()
          .addScaledVector(releaseDir, 20);

        ab.pos.lerpVectors(releaseWorld, dockedWorld, e);
        ab.scale = 1 + (site.dockedScale - 1) * e;
        ab.rot.copy(ag.rot).multiply(site.rotOff);

        if (ab.dockT <= 0) {
          ags[ab.targetIdx].occupiedBy[ab.targetSlot] = -1;
          ab.pos.copy(releaseWorld);
          ab.scale = 1;
          ab.state = AbState.Seeking;
          ab.targetIdx = -1;
          ab.targetSlot = -1;
          ab.angVel = randomAngVel(AB_ANG_SPEED);
        }
        break;
      }
    }
  }

  // ── Collision resolution ──────────────────────────────────────────────────
  // Antigen vs antigen
  for (let i = 0; i < ags.length; i++)
    for (let k = i + 1; k < ags.length; k++)
      resolveSphereCollision(
        ags[i].pos,
        ags[i].vel,
        AG_RADIUS,
        ags[k].pos,
        ags[k].vel,
        AG_RADIUS,
      );

  // Seeking antibody vs antigen
  for (const ab of abs2) {
    if (ab.state !== AbState.Seeking) continue;
    for (const ag of ags)
      resolveSphereCollision(
        ab.pos,
        null,
        AB_RADIUS,
        ag.pos,
        ag.vel,
        AG_RADIUS,
      );
  }

  // Seeking antibody vs seeking antibody
  for (let j = 0; j < abs2.length; j++) {
    if (abs2[j].state !== AbState.Seeking) continue;
    for (let k = j + 1; k < abs2.length; k++) {
      if (abs2[k].state !== AbState.Seeking) continue;
      resolveSphereCollision(
        abs2[j].pos,
        null,
        AB_RADIUS,
        abs2[k].pos,
        null,
        AB_RADIUS,
      );
    }
  }
}

function updateMeshes() {
  const whiteTint = new THREE.Vector3(1, 1, 1);
  const yellowTint = new THREE.Vector3(1, 0.902, 0.314); // 255,230,80 / 255

  for (let i = 0; i < ags.length; i++) {
    const mesh = agMeshes[i];
    const ag = ags[i];
    mesh.position.copy(ag.pos);
    mesh.quaternion.copy(ag.rot);
    const mat = mesh.material as THREE.ShaderMaterial;
    const occupied = ag.occupiedBy[0] !== -1 || ag.occupiedBy[1] !== -1;
    mat.uniforms.tint.value.copy(occupied ? yellowTint : whiteTint);
  }

  for (let j = 0; j < abs2.length; j++) {
    const mesh = abMeshes[j];
    const ab = abs2[j];
    mesh.position.copy(ab.pos);
    mesh.quaternion.copy(ab.rot);
    mesh.scale.setScalar(ab.scale);
  }
}

function animate() {
  animFrame = requestAnimationFrame(animate);

  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.1); // cap to avoid instability

  // FPS counter
  fpsCounter++;
  fpsTimer += rawDt;
  if (fpsTimer >= 1) {
    fpsText.value = `${fpsCounter} FPS`;
    fpsCounter = 0;
    fpsTimer = 0;
  }

  // Camera orbit
  const yr = (yaw * Math.PI) / 180;
  const pr = (pitch * Math.PI) / 180;
  camera.position.set(
    radius * Math.cos(pr) * Math.sin(yr),
    radius * Math.sin(pr),
    radius * Math.cos(pr) * Math.cos(yr),
  );
  camera.lookAt(0, 0, 0);
  sharedUniforms.viewPos.value.copy(camera.position);

  // Simulation
  stepSim(dt);
  updateMeshes();

  // Update status every 30 frames
  if (++frameCount % 30 === 0) buildStatusLines();

  renderer.render(scene, camera);
}

function makeMaterial(tint = new THREE.Vector3(1, 1, 1)): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      lightPos: sharedUniforms.lightPos,
      viewPos: sharedUniforms.viewPos,
      tint: { value: tint },
    },
    vertexShader,
    fragmentShader,
  });
}

onMounted(async () => {
  const canvas = canvasRef.value!;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x071f5e);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    45,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    2000,
  );
  clock = new THREE.Clock();

  sharedUniforms = {
    lightPos: { value: new THREE.Vector3(50, 50, 50) },
    viewPos: { value: new THREE.Vector3() },
  };

  // Load models + meta
  const [agData, abHLData, abABData, metaJson] = await Promise.all([
    loadModel("/models/ag.bin"),
    loadModel("/models/ab_hl.bin"),
    loadModel("/models/ab_ab.bin"),
    fetch("/models/meta.json").then((r) => r.json()),
  ]);

  // Compute dock sites (mirror of Go main.go siteOffset / sites logic)
  const agS = metaJson.ag.scale;
  sites = [
    {
      // HL antibody docks at site 0
      offset: new THREE.Vector3(
        (metaJson.abHL.cx - metaJson.ag.cx) * agS,
        (metaJson.abHL.cy - metaJson.ag.cy) * agS,
        (metaJson.abHL.cz - metaJson.ag.cz) * agS,
      ),
      rotOff: new THREE.Quaternion(), // identity – already oriented correctly
      dockedScale: agS / metaJson.abHL.scale,
    },
    {
      // AB antibody docks at site 1
      offset: new THREE.Vector3(
        (metaJson.abAB.cx - metaJson.ag.cx) * agS,
        (metaJson.abAB.cy - metaJson.ag.cy) * agS,
        (metaJson.abAB.cz - metaJson.ag.cz) * agS,
      ),
      rotOff: new THREE.Quaternion(),
      dockedScale: agS / metaJson.abAB.scale,
    },
  ];

  // Create antigen mesh instances (shared geometry, per-instance material)
  for (let i = 0; i < NUM_ANTIGENS; i++) {
    const mesh = new THREE.Mesh(agData.geo, makeMaterial());
    scene.add(mesh);
    agMeshes.push(mesh);
  }

  // Create antibody mesh instances
  const abGeos = [abHLData.geo, abABData.geo];
  for (let j = 0; j < NUM_ANTIBODIES; j++) {
    const mesh = new THREE.Mesh(abGeos[j % 2], makeMaterial());
    scene.add(mesh);
    abMeshes.push(mesh);
  }

  // Init simulation
  const sim = newSim();
  ags = sim.ags;
  abs2 = sim.abs;

  // Resize handling
  const resizeObserver = new ResizeObserver(() => {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(canvas);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  // Mouse events for orbit camera
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      mouseDown = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  });
  window.addEventListener("mouseup", () => {
    mouseDown = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (!mouseDown) return;
    yaw -= (e.clientX - lastX) * 0.3;
    pitch += (e.clientY - lastY) * 0.3;
    pitch = Math.max(-89, Math.min(89, pitch));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      radius += e.deltaY * 0.05;
      radius = Math.max(5, radius);
      e.preventDefault();
    },
    { passive: false },
  );

  animate();
});

onUnmounted(() => {
  cancelAnimationFrame(animFrame);
  renderer?.dispose();
});
</script>

<style scoped>
.sim-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.sim-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.hud {
  position: absolute;
  top: 0;
  left: 0;
  padding: 8px 10px;
  pointer-events: none;
  font-family: monospace;
  font-size: 13px;
  color: #c8c8c8;
  user-select: none;
}

.top-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.reset-btn {
  pointer-events: all;
  padding: 4px 12px;
  background: #1e3a7a;
  color: #d0d8f0;
  border: 1px solid #4060b0;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}
.reset-btn:hover {
  background: #2a4f9e;
}

.fps-badge {
  color: #a0b8d0;
}

.status-list {
  max-height: calc(100vh - 60px);
  overflow-y: auto;
  scrollbar-width: thin;
}

.status-line {
  line-height: 1.5;
  white-space: nowrap;
}
</style>
