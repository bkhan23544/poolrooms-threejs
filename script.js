
import * as THREE from 'three/webgpu';
import { vec2, vec3, float, positionWorld, normalWorld, cameraPosition, cameraViewMatrix, time, mix, smoothstep, fract, floor, min, max, abs, dot, normalize, pow, clamp, sin, cos, tan, exp, select, hash, uniform, texture, pass, transformDirection, fwidth, distance, length, reflect, screenUV, screenSize, vec4, convertToTexture } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const X0 = -20, X1 = 20, Z0 = -34, Z1 = 14, H = 9, WL = -0.12;
const pools = [{ cx: -7, cz: 0, w: 13, d: 9 }, { cx: -5, cz: -17, w: 16, d: 9 }];
const RAIL = 1.1, COPING = 0.45, CORNER = 1.0;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.68;
document.body.appendChild(renderer.domElement);

try { await renderer.init(); } catch (e) {
  const m = document.getElementById('msg'); m.style.display = 'flex';
  m.textContent = 'This browser cannot start WebGPU or WebGL 2. Try a recent Chrome, Edge, Safari or Firefox.'; throw e;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6b7770);
scene.fog = new THREE.FogExp2(0x6b7770, 0.007); // dark, thin atmosphere: far surfaces sink into shadow
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
camera.rotation.order = 'YXZ';
camera.position.set(8, 1.7, 10);
camera.rotation.set(-0.1, 0.53, 0); // the controls own the look from here on, so set the start pose up front
const fitFov = () => { camera.aspect = innerWidth / innerHeight; camera.fov = camera.aspect < 1 ? 88 : 70; camera.updateProjectionMatrix(); };
fitFov();

/* ---------- lighting: soft fill + bounced light that falls off from the window wall ---------- */
scene.add(new THREE.HemisphereLight(0xeaf2ed, 0xc8d3cb, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(-18, 14, 4); scene.add(sun);
const glow = exp(distance(positionWorld, vec3(X0, 7.4, positionWorld.z)).div(-12));

/* ---------- tiles (grout is anti-aliased and fades with distance: no moire) ---------- */
const tile = (uv, size, gw, base, groutCol, vary) => {
  const q = uv.div(size), g = fract(q), id = floor(q);
  const e = min(min(g.x, g.x.oneMinus()), min(g.y, g.y.oneMinus()));
  const fw = max(fwidth(q.x), fwidth(q.y));
  const m = smoothstep(float(gw), fw.mul(1.5).add(gw + 0.002), e);
  const groutAmt = m.oneMinus().mul(smoothstep(0.15, 0.5, fw).oneMinus());
  const v = hash(id.x.mul(37.7).add(id.y.mul(91.3))).sub(0.5).mul(vary).add(1);
  return { color: mix(base.mul(v), groutCol, groutAmt.mul(0.9)), mask: groutAmt.oneMinus() };
};

// ---- live planar mirrors, written from scratch ----
// Each mirror re-renders the room every frame from a camera reflected through the mirror plane, into its own
// render target. Materials then look the result up by projecting their WORLD position with that same camera,
// so the reflection is locked to the world and cannot slide with the player.
const copingMeshes = [], waterMeshes = [];
const mirrorCam = new THREE.PerspectiveCamera();
const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _s = new THREE.Vector2(), _q = new THREE.Vector3(), _r = new THREE.Vector3(), _pv = new THREE.Matrix4(), _iv = new THREE.Matrix4(), frustum = new THREE.Frustum(), wallBoxes = [];
const makeMirror = (n, c, scale) => ({ n, c, scale, w: 0, ht: 0, vp: uniform(new THREE.Matrix4()),
  rt: new THREE.RenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 }) });
const Y = new THREE.Vector3(0, 1, 0);
const floorMirror = makeMirror(Y, 0, 1.0), waterMirror = makeMirror(Y, WL, 0.75);
// walls get their own (lower-res) mirrors: left, right, back, front
const wallMirrors = [
  makeMirror(new THREE.Vector3(1, 0, 0), X0, 0.85),
  makeMirror(new THREE.Vector3(-1, 0, 0), -X1, 0.85),
  makeMirror(new THREE.Vector3(0, 0, 1), Z0, 0.85),
  makeMirror(new THREE.Vector3(0, 0, -1), -Z1, 0.85)];
const ceilMirror = makeMirror(new THREE.Vector3(0, -1, 0), -H, 0.85); // the ceiling reflects the lit room too
const uInvAspect = uniform(1), uFov = uniform(0.3);
const slab = (p, r0, lo, hi) => { // distance along a ray to one pair of room planes
  const r = select(abs(r0).lessThan(1e-4), float(1e-4), r0);
  return select(r.greaterThan(0), float(hi).sub(p).div(r), float(lo).sub(p).div(r));
};
// Blur grows with how far the reflected light has travelled (surface -> object), like drei's MeshReflectorMaterial:
// things near the surface (a ceiling next to its lights) stay crisp, distant things melt away.
const glossyRadius = (n, k) => {
  const P = positionWorld, I = normalize(P.sub(cameraPosition)), R = reflect(I, vec3(n.x, n.y, n.z));
  const t = min(min(slab(P.x, R.x, X0, X1), slab(P.y, R.y, 0, H)), slab(P.z, R.z, Z0, Z1));
  return clamp(t.mul(k).div(distance(P, cameraPosition).add(t)).mul(uFov), 0.002, 0.05);
};
const sampleMirror = (m, offset = vec2(0, 0), radius = 0, taps = 1) => {
  const clip = m.vp.mul(vec4(positionWorld, 1));
  const ndc = clip.xy.div(clip.w);
  // render-target textures are sampled with the origin at the TOP-left, so v runs opposite to NDC y
  const muv = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).add(offset);
  if (taps <= 1) return texture(m.rt.texture, muv).rgb;
  // glossy, diffuse reflection: average a rotated spiral of taps around the mirror lookup
  const rot = fract(sin(dot(screenUV, vec2(12.9898, 78.233))).mul(43758.5453)).mul(6.2832);
  let acc = vec3(0, 0, 0);
  for (let i = 0; i < taps; i++) {
    const a = rot.add(i * 2.39996), r = Math.sqrt((i + 0.5) / taps);
    const o = vec2(cos(a).mul(uInvAspect), sin(a)).mul(radius).mul(r);
    acc = acc.add(texture(m.rt.texture, muv.add(o)).rgb);
  }
  return acc.div(taps);
};
function renderMirror(m, hidden) {
  renderer.getDrawingBufferSize(_s);
  const w = Math.max(2, Math.round(_s.x * m.scale)), hh = Math.max(2, Math.round(_s.y * m.scale));
  if (w !== m.w || hh !== m.ht) { m.rt.setSize(w, hh); m.w = w; m.ht = hh; }
  uInvAspect.value = hh / w;
  _p.setFromMatrixPosition(camera.matrixWorld);
  _f.set(0, 0, -1).transformDirection(camera.matrixWorld);
  _u.set(0, 1, 0).transformDirection(camera.matrixWorld);
  mirrorCam.position.copy(_p).addScaledVector(m.n, -2 * (m.n.dot(_p) - m.c));
  _q.copy(_u).addScaledVector(m.n, -2 * m.n.dot(_u)); mirrorCam.up.copy(_q);
  _r.copy(_p).addScaledVector(_f, 10); _r.addScaledVector(m.n, -2 * (m.n.dot(_r) - m.c));
  mirrorCam.lookAt(_r);
  mirrorCam.fov = Math.min(camera.fov * 1.3, 120); mirrorCam.aspect = w / hh; mirrorCam.near = 0.05; mirrorCam.far = 200;
  uFov.value = 1 / (2 * Math.tan(THREE.MathUtils.degToRad(mirrorCam.fov) / 2));
  mirrorCam.updateProjectionMatrix(); mirrorCam.updateMatrixWorld();
  mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert();
  m.vp.value.multiplyMatrices(mirrorCam.projectionMatrix, mirrorCam.matrixWorldInverse);
  for (const o of hidden) o.visible = false; // never sample a target while drawing into it
  renderer.setRenderTarget(m.rt); renderer.render(scene, mirrorCam); renderer.setRenderTarget(null);
  for (const o of hidden) o.visible = true;
}



const viewDir = () => normalize(cameraPosition.sub(positionWorld));

const floorMat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
{
  const t = tile(positionWorld.xz, vec2(0.6, 1.2), 0.008, vec3(0.5, 0.54, 0.52), vec3(0.44, 0.48, 0.46), 0.04);
  const f = pow(clamp(viewDir().y, 0, 1).oneMinus(), 3);
  floorMat.colorNode = t.color;
  floorMat.roughnessNode = mix(0.9, 0.28, t.mask);
  floorMat.emissiveNode = sampleMirror(floorMirror, vec2(0, 0), glossyRadius(floorMirror.n, 0.08), 18).mul(mix(0.22, 0.7, f)).mul(mix(0.55, 1.0, t.mask)).add(t.color.mul(glow.mul(0.22)));
}
const wallMat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.4 });
{
  const t = tile(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y), vec2(0.16, 0.16), 0.03, vec3(0.7, 0.75, 0.72), vec3(0.55, 0.6, 0.57), 0.03);
  wallMat.colorNode = t.color;
  wallMat.roughnessNode = mix(0.7, 0.5, t.mask);
  wallMat.emissiveNode = t.color.mul(glow.mul(0.9));
}
const wallMeshes = [];
const makeWallMat = (mirror) => { // glazed tile: faint head-on, strong at grazing angles, softly blurred
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.4 });
  const t = tile(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y), vec2(0.16, 0.16), 0.03, vec3(0.7, 0.75, 0.72), vec3(0.55, 0.6, 0.57), 0.03);
  const n = vec3(mirror.n.x, mirror.n.y, mirror.n.z);
  const f = pow(clamp(dot(viewDir(), n), 0, 1).oneMinus(), 3);
  mat.colorNode = t.color.mul(0.9);
  mat.roughnessNode = mix(0.7, 0.5, t.mask);
  mat.emissiveNode = t.color.mul(glow.mul(0.8)).add(sampleMirror(mirror, vec2(0, 0), glossyRadius(mirror.n, 0.07), 12).mul(mix(0.05, 0.55, f)).mul(mix(0.5, 1.0, t.mask)));
  return mat;
};
const wallMats = wallMirrors.map(makeWallMat);
const ceilMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
ceilMat.colorNode = vec3(0.4, 0.43, 0.41);
{ // painted ceiling: soft, blurred reflection that strengthens at grazing angles
  const f = pow(clamp(dot(viewDir(), vec3(0, -1, 0)), 0, 1).oneMinus(), 3);
  ceilMat.emissiveNode = vec3(0.4, 0.43, 0.41).mul(glow.mul(0.95)).add(sampleMirror(ceilMirror, vec2(0, 0), glossyRadius(ceilMirror.n, 0.06), 12).mul(mix(0.15, 0.6, f)));
}

const basinMat = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide, roughness: 0.3, alphaTest: 0.5 });
basinMat.colorNode = vec3(0.12, 0.22, 0.22);
basinMat.opacityNode = select(cameraPosition.y.greaterThan(0), float(1), float(0)); // hidden from the mirror camera

const copingMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0, alphaTest: 0.5 });
copingMat.colorNode = vec3(0.74, 0.79, 0.76);
copingMat.opacityNode = select(cameraPosition.y.greaterThan(0), float(1), float(0)); // its underside must not appear in the mirrors
copingMat.emissiveNode = sampleMirror(floorMirror, vec2(0, 0), glossyRadius(floorMirror.n, 0.08), 8).mul(0.3).add(vec3(0.74, 0.79, 0.76).mul(glow.mul(0.15)));

const envMap = await new RGBELoader().loadAsync('monochrome_studio_02_1k.hdr');
envMap.mapping = THREE.EquirectangularReflectionMapping;

const railMat = new THREE.MeshStandardNodeMaterial({ color: 0x757575, metalness: 1, roughness: 0.22, envMap, envMapIntensity: 1 });

/* ---------- room ---------- */
const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); scene.add(m); return m; };
const L = Z1 - Z0, cz = (Z0 + Z1) / 2, W = X1 - X0;

const rrect = (S, x, y, w, h, r) => { // x,y = centre in shape space (y = -z)
  const a = x - w / 2, b = x + w / 2, c = y - h / 2, d = y + h / 2;
  S.moveTo(a + r, c); S.lineTo(b - r, c); S.quadraticCurveTo(b, c, b, c + r);
  S.lineTo(b, d - r); S.quadraticCurveTo(b, d, b - r, d); S.lineTo(a + r, d);
  S.quadraticCurveTo(a, d, a, d - r); S.lineTo(a, c + r); S.quadraticCurveTo(a, c, a + r, c); return S;
};

const fs = new THREE.Shape();
fs.moveTo(X0, -Z1).lineTo(X1, -Z1).lineTo(X1, -Z0).lineTo(X0, -Z0).lineTo(X0, -Z1);
for (const p of pools) fs.holes.push(rrect(new THREE.Path(), p.cx, -p.cz, p.w, p.d, CORNER));
const floorMesh = add(new THREE.ShapeGeometry(fs, 10).rotateX(-Math.PI / 2), floorMat, 0, 0, 0);

wallMeshes.push(add(new THREE.PlaneGeometry(L, H).rotateY(Math.PI / 2), wallMats[0], X0, H / 2, cz));
wallMeshes.push(add(new THREE.PlaneGeometry(L, H).rotateY(-Math.PI / 2), wallMats[1], X1, H / 2, cz));
wallMeshes.push(add(new THREE.PlaneGeometry(W, H), wallMats[2], 0, H / 2, Z0));
wallMeshes.push(add(new THREE.PlaneGeometry(W, H).rotateY(Math.PI), wallMats[3], 0, H / 2, Z1));
const ceilMesh = add(new THREE.PlaneGeometry(W, L).rotateX(Math.PI / 2), ceilMat, 0, H, cz);

// back ledge, arch, small lights
const ledgeMat = new THREE.MeshStandardMaterial({ color: 0xd8dfd9, roughness: 0.4 });
add(new THREE.BoxGeometry(W, 1.1, 2.2), ledgeMat, 0, 0.55, Z0 + 1.1);
const bulb = new THREE.MeshBasicNodeMaterial({ fog: false }); bulb.colorNode = vec3(3.5, 3.4, 3.0);
const bg = new THREE.BoxGeometry(0.16, 0.1, 0.05);
for (let x = -16; x <= 16; x += 4) add(bg, bulb, x, 0.35, Z0 + 2.22);
const dark = new THREE.MeshBasicMaterial({ color: 0x2a3430 });
add(new THREE.PlaneGeometry(2, 2.2), dark, -15, 2.2, Z0 + 0.02);
add(new THREE.CircleGeometry(1, 24, 0, Math.PI), dark, -15, 3.3, Z0 + 0.02);

// clerestory windows: bright, but not blown out
const winMat = new THREE.MeshBasicNodeMaterial({ fog: false }); winMat.colorNode = vec3(4.5, 4.7, 4.6);
const wg = new THREE.PlaneGeometry(2.7, 1.0).rotateY(Math.PI / 2);
for (let i = 0; i < 12; i++) add(wg, winMat, X0 + 0.02, 7.4, Z1 - 2.4 - i * 3.8);

/* ---------- water ---------- */
const waves = [[1, 0.2, 2.3, 0.9, 0.009], [-0.6, 1, 3.7, 1.3, 0.0068], [0.3, -1, 6.1, 1.9, 0.0045], [-1, -0.5, 9.5, 2.6, 0.003], [0.8, 0.9, 14, 3.4, 0.0018]];
const waveGrad = P => {
  let gx = float(0), gz = float(0);
  for (const [dx, dz, f, s, a] of waves) {
    const dir = new THREE.Vector2(dx, dz).normalize();
    const c = cos(dot(P, vec2(dir.x, dir.y)).mul(f).add(time.mul(s))).mul(a * f);
    gx = gx.add(c.mul(dir.x)); gz = gz.add(c.mul(dir.y));
  }
  return vec2(gx, gz);
};


function makeWater(p, shape) {
  const wm = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.03 });
  const P = positionWorld.xz, g = waveGrad(P);
  const nW = normalize(vec3(g.x.negate(), 1, g.y.negate()));
  wm.normalNode = normalize(transformDirection(nW, cameraViewMatrix));

  const ndv = clamp(dot(nW, viewDir()), 0, 1);
  const grazing = ndv.oneMinus();
  const fres = clamp(pow(grazing, 4).mul(0.92).add(0.04), 0, 1);
  const edge = min(abs(P.x.sub(p.cx)).oneMinus().add(p.w / 2), abs(P.y.sub(p.cz)).oneMinus().add(p.d / 2));
  // gradient: near-black teal at the shadowed rim, rich teal-to-emerald toward the middle, slow drifting light patches
  const centre = smoothstep(0.0, 5.5, edge);
  const lowN = sin(P.x.mul(0.37).add(time.mul(0.12))).mul(sin(P.y.mul(0.29).sub(time.mul(0.1)))).mul(0.5).add(0.5);
  const rim = vec3(0.004, 0.045, 0.048), teal = vec3(0.012, 0.3, 0.29), emerald = vec3(0.02, 0.4, 0.32);
  const body = mix(rim, mix(teal, emerald, lowN), clamp(centre.mul(0.85).add(lowN.mul(0.15)), 0, 1)).mul(lowN.mul(0.3).add(0.85));
  const Rv = reflect(viewDir().negate(), nW);
  const glint = pow(clamp(dot(Rv, normalize(vec3(-0.8, 0.45, -0.35))), 0, 1), 60).mul(3.5);
  wm.colorNode = vec3(0, 0.01, 0.012);
  wm.emissiveNode = sampleMirror(waterMirror, g.mul(0.3), 0.004, 6).mul(vec3(0.6, 0.9, 0.85)).mul(fres).add(body.mul(fres.oneMinus())).add(vec3(0.8, 1.0, 0.95).mul(glint));
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape, 10).rotateX(-Math.PI / 2), wm);
  mesh.position.y = WL; scene.add(mesh); waterMeshes.push(mesh);
}

/* ---------- pools: basin, coping, rails ---------- */
const up = new THREE.Vector3(0, 1, 0);
const bar = (a, b, r = 0.035) => {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), railMat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(up, d.normalize()); scene.add(m);
};
const V = (x, y, z) => new THREE.Vector3(x, y, z);

for (const p of pools) {
  const ps = rrect(new THREE.Shape(), p.cx, -p.cz, p.w, p.d, CORNER);
  add(new THREE.ExtrudeGeometry(ps, { depth: 0.6, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2).translate(0, -0.6, 0), basinMat, 0, 0, 0);
  makeWater(p, ps);
  const ring = rrect(new THREE.Shape(), p.cx, -p.cz, p.w + COPING * 2, p.d + COPING * 2, CORNER + COPING);
  ring.holes.push(rrect(new THREE.Path(), p.cx, -p.cz, p.w, p.d, CORNER));
  copingMeshes.push(add(new THREE.ExtrudeGeometry(ring, { depth: 0.04, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2), copingMat, 0, 0, 0));

  const hx = p.w / 2 + RAIL, hz = p.d / 2 + RAIL, yy = 0.98;
  const c = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const A = V(p.cx + a[0], yy, p.cz + a[1]), B = V(p.cx + b[0], yy, p.cz + b[1]);
    bar(A, B, 0.04);
    bar(V(A.x, 0.52, A.z), V(B.x, 0.52, B.z), 0.022);
    const n = Math.ceil(A.distanceTo(B) / 2.6);
    for (let k = 0; k <= n; k++) { const q = A.clone().lerp(B, k / n); bar(V(q.x, 0, q.z), V(q.x, yy, q.z), 0.038); }
  }
}

/* ---------- post: center-bulge fisheye + whisper of bloom ---------- */
const fishBulge = 0.9; // dome strength (keep under ~1.4; corners stay pinned so no edge tiling)
const post = new THREE.PostProcessing(renderer);
const sp = pass(scene, camera);
// bloom first (undistorted), then fisheye-sample the combined image so glow sticks to the lights
const preFish = convertToTexture(sp.add(bloom(sp, 0.3, 0.7, 1.0)));
post.outputNode = (() => {
  // circular coords so the bulge is a round dome, not stretched by aspect
  const aspect = screenSize.x.div(screenSize.y);
  const uv = vec2(screenUV.x.sub(0.5).mul(aspect), screenUV.y.sub(0.5));
  const r = length(uv).max(1e-4);
  const corner = length(vec2(aspect.mul(0.5), float(0.5))); // pin screen corners → no wrap/tile at edges
  const rn = r.div(corner);
  const newRn = tan(rn.mul(fishBulge)).div(tan(float(fishBulge)));
  const warped = uv.mul(newRn.div(rn));
  const fishUV = vec2(warped.x.div(aspect), warped.y).add(0.5);
  const ca = uv.mul(dot(uv, uv).mul(0.012));
  const caUV = vec2(ca.x.div(aspect), ca.y);
  const c = vec3(
    preFish.sample(fishUV.add(caUV)).r,
    preFish.sample(fishUV).g,
    preFish.sample(fishUV.sub(caUV)).b
  );
  const grain = fract(sin(dot(screenUV.add(fract(time.mul(0.37))), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(0.02);
  return vec4(c.mul(vec3(0.97, 1.0, 0.985)).add(grain), 1);
})();

/* ---------- controls ---------- */
const walkSpeed = 2; // desktop WASD walk speed (units/sec); phone still scales via joystick push
const sprintSpeed = 5; // desktop Shift sprint speed
const controls = new PointerLockControls(camera, renderer.domElement);
controls.pointerSpeed = 1.75; // 0.002 * 1.75 = the 0.0035 rad/px the drag-look used
controls.minPolarAngle = Math.PI / 2 - 1.3;
controls.maxPolarAngle = Math.PI / 2 + 1.3; // keeps the old ±1.3 rad pitch clamp
const keys = {};
addEventListener('keydown', e => keys[e.code] = true);
addEventListener('keyup', e => keys[e.code] = false);
const cv = renderer.domElement;
cv.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') controls.lock(); }); // a click captures the mouse; Esc releases it
const joy = { id: null, x0: 0, y0: 0, x: 0, y: 0 }, look = { id: null, x: 0, y: 0 };
cv.addEventListener('touchstart', e => {
  for (const t of e.changedTouches) {
    if (t.clientX < innerWidth / 2 && joy.id === null) Object.assign(joy, { id: t.identifier, x0: t.clientX, y0: t.clientY, x: 0, y: 0 });
    else if (look.id === null) Object.assign(look, { id: t.identifier, x: t.clientX, y: t.clientY });
  }
}, { passive: true });
cv.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.x = Math.max(-1, Math.min(1, (t.clientX - joy.x0) / 55)); joy.y = Math.max(-1, Math.min(1, (t.clientY - joy.y0) / 55)); }
    if (t.identifier === look.id) { camera.rotation.y -= (t.clientX - look.x) * 0.006; camera.rotation.x = Math.max(-1.3, Math.min(1.3, camera.rotation.x - (t.clientY - look.y) * 0.006)); look.x = t.clientX; look.y = t.clientY; }
  }
}, { passive: true });
const endT = e => { for (const t of e.changedTouches) { if (t.identifier === joy.id) { joy.id = null; joy.x = joy.y = 0; } if (t.identifier === look.id) look.id = null; } };
cv.addEventListener('touchend', endT); cv.addEventListener('touchcancel', endT);

const blocked = (x, z) => {
  if (x < X0 + 0.6 || x > X1 - 0.6 || z < Z0 + 3.4 || z > Z1 - 0.6) return true;
  return pools.some(p => Math.abs(x - p.cx) < p.w / 2 + RAIL + 0.35 && Math.abs(z - p.cz) < p.d / 2 + RAIL + 0.35);
};

addEventListener('resize', () => { fitFov(); renderer.setSize(innerWidth, innerHeight); });
setTimeout(() => { document.getElementById('hint').style.opacity = 0; }, 7000);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - joy.y;
  const s = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + joy.x;
  const spd = (keys.ShiftLeft ? sprintSpeed : walkSpeed) * dt;
  const yaw = camera.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const dx = (fx * f - fz * s) * spd, dz = (fz * f + fx * s) * spd;
  const p = camera.position;
  if (!blocked(p.x + dx, p.z)) p.x += dx;
  if (!blocked(p.x, p.z + dz)) p.z += dz;
  p.y = 1.7 + Math.sin(now * 0.0016) * 0.008;
  camera.updateMatrixWorld();
  renderMirror(floorMirror, [floorMesh, ...copingMeshes]);
  renderMirror(waterMirror, waterMeshes);
  _pv.multiplyMatrices(camera.projectionMatrix, _iv.copy(camera.matrixWorld).invert()); frustum.setFromProjectionMatrix(_pv);
  wallMirrors.forEach((m, i) => { // only walls currently in view get a mirror pass
    if (frustum.intersectsBox(wallBoxes[i] ||= new THREE.Box3().setFromObject(wallMeshes[i]))) renderMirror(m, [wallMeshes[i]]);
  });
  if (frustum.intersectsBox(wallBoxes.ceil ||= new THREE.Box3().setFromObject(ceilMesh))) renderMirror(ceilMirror, [ceilMesh]);
  post.render();
});
