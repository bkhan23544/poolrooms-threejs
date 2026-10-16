
import * as THREE from 'three/webgpu';
import { vec2, vec3, float, positionWorld, normalWorld, cameraPosition, cameraViewMatrix, time, mix, smoothstep, fract, floor, min, max, abs, dot, normalize, pow, clamp, sin, cos, tan, exp, select, hash, uniform, texture, pass, transformDirection, fwidth, distance, length, reflect, refract, screenUV, screenSize, vec4, convertToTexture } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';

window.__ld(30, 'Starting renderer'); // the module only runs once three.js itself has arrived

const X0 = -20, X1 = 20, Z0 = -34, Z1 = 14, H = 9, WL = -0.12;
const pools = [{ cx: -7, cz: 0, w: 13, d: 9 }, { cx: -5, cz: -17, w: 16, d: 9 }];
const POOL_DEPTH = 3.5; // basin geometry is built at this depth; the Pool depth slider rescales it live
// live-tweakable values, driven by the controls panel (see the end of the file)
const U = {
  waterDarken: uniform(0.75), seeThrough: uniform(0.75), murk: uniform(1), reflect: uniform(1), waves: uniform(1), glint: uniform(1),
  depth: uniform(POOL_DEPTH), ao: uniform(1), blink: uniform(0), bulge: uniform(0.9), ca: uniform(0.012), grain: uniform(0.02),
};
const RAIL = 1.1, COPING = 0.45, CORNER = 1.0;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.68;
document.body.appendChild(renderer.domElement);

try { await renderer.init(); window.__ld(50, 'Loading environment'); } catch (e) {
  window.__ldHide();
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
const hemi = new THREE.HemisphereLight(0xeaf2ed, 0xc8d3cb, 1.15); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(-18, 14, 4); scene.add(sun);
hemi.layers.enable(1); sun.layers.enable(1); // layer 1 = what the refraction pass sees (the basins + their light)
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

// ---- ambient occlusion, computed analytically ----
// The room is boxes, rounded rectangles and rails, so contact darkening comes straight from distances to them:
// free, stable, no screen-space noise or halos. Strength lives in U.ao (0 = off, 1 = full).
const sdRBox = (q2, cx, cz, hx, hz, r) => { // signed distance to a rounded rectangle in xz
  const q = abs(q2.sub(vec2(cx, cz))).sub(vec2(hx - r, hz - r));
  return length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(r);
};
const occl = (d, radius, darkest) => mix(float(darkest), float(1), smoothstep(0, radius, d)); // 1 = open, darkest = in the crease
const finishAO = a => mix(float(1), a, U.ao);
const PW = positionWorld;
const aoFloor = (() => {
  let a = occl(min(min(PW.x.sub(X0), float(X1).sub(PW.x)), min(PW.z.sub(Z0 + 2.2), float(Z1).sub(PW.z))), 1.4, 0.5); // walls + back ledge
  for (const p of pools) {
    a = a.mul(occl(sdRBox(PW.xz, p.cx, p.cz, p.w / 2 + COPING, p.d / 2 + COPING, CORNER + COPING), 0.18, 0.75)); // coping lip
    a = a.mul(occl(abs(sdRBox(PW.xz, p.cx, p.cz, p.w / 2 + RAIL, p.d / 2 + RAIL, 0.001)), 0.4, 0.78)); // under the rails
  }
  return finishAO(a);
})();
const aoWall = xWall => { // xWall: wall faces along x (left/right), else back/front
  const side = xWall ? min(PW.z.sub(Z0), float(Z1).sub(PW.z)) : min(PW.x.sub(X0), float(X1).sub(PW.x));
  return finishAO(occl(PW.y, 1.3, 0.55).mul(occl(float(H).sub(PW.y), 1.3, 0.6)).mul(occl(side, 1.3, 0.6)));
};
const aoCeil = finishAO(occl(min(min(PW.x.sub(X0), float(X1).sub(PW.x)), min(PW.z.sub(Z0), float(Z1).sub(PW.z))), 1.6, 0.55));
const aoBasin = (() => {
  let inside = float(-1e3);
  for (const p of pools) inside = max(inside, sdRBox(PW.xz, p.cx, p.cz, p.w / 2, p.d / 2, CORNER).negate());
  return finishAO(occl(PW.y.add(U.depth), 1.0, 0.45).mul(occl(inside, 0.9, 0.55)));
})();

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



// refraction: ONLY the pool basins (layer 1), seen from the main camera. Water looks it up by projecting the point
// where its refracted ray meets the basin, so you see the bent pool bottom. Rails, coping etc. are left out on
// purpose: they're above the water, so they must never show up "through" it.
const refrCam = new THREE.PerspectiveCamera();
const refr = { scale: 0.75, w: 0, ht: 0, vp: uniform(new THREE.Matrix4()), rt: new THREE.RenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 }) };
function renderRefraction() {
  renderer.getDrawingBufferSize(_s);
  const w = Math.max(2, Math.round(_s.x * refr.scale)), hh = Math.max(2, Math.round(_s.y * refr.scale));
  if (w !== refr.w || hh !== refr.ht) { refr.rt.setSize(w, hh); refr.w = w; refr.ht = hh; }
  refr.vp.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  refrCam.copy(camera); refrCam.layers.set(1);
  renderer.setRenderTarget(refr.rt); renderer.render(scene, refrCam); renderer.setRenderTarget(null);
}
const projUV = (vp, wp) => {
  const clip = vp.mul(vec4(wp, 1)), ndc = clip.xy.div(clip.w);
  return clamp(vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)), 0.001, 0.999);
};

const viewDir = () => normalize(cameraPosition.sub(positionWorld));

const floorMat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
{
  const t = tile(positionWorld.xz, vec2(0.6, 1.2), 0.008, vec3(0.5, 0.54, 0.52), vec3(0.44, 0.48, 0.46), 0.04);
  const f = pow(clamp(viewDir().y, 0, 1).oneMinus(), 3);
  floorMat.colorNode = t.color;
  floorMat.roughnessNode = mix(0.9, 0.28, t.mask);
  floorMat.emissiveNode = sampleMirror(floorMirror, vec2(0, 0), glossyRadius(floorMirror.n, 0.08), 18).mul(mix(0.22, 0.7, f)).mul(mix(0.55, 1.0, t.mask)).add(t.color.mul(glow.mul(0.22)));
}
floorMat.aoNode = aoFloor; floorMat.emissiveNode = floorMat.emissiveNode.mul(aoFloor);
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
  const a = aoWall(mirror.n.x !== 0);
  mat.aoNode = a;
  mat.emissiveNode = t.color.mul(glow.mul(0.8).mul(a)).add(sampleMirror(mirror, vec2(0, 0), glossyRadius(mirror.n, 0.07), 12).mul(mix(0.05, 0.55, f)).mul(mix(0.5, 1.0, t.mask)));
  return mat;
};
const wallMats = wallMirrors.map(makeWallMat);
const ceilMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
ceilMat.colorNode = vec3(0.4, 0.43, 0.41);
{ // painted ceiling: soft, blurred reflection that strengthens at grazing angles
  const f = pow(clamp(dot(viewDir(), vec3(0, -1, 0)), 0, 1).oneMinus(), 3);
  ceilMat.aoNode = aoCeil;
  ceilMat.emissiveNode = vec3(0.4, 0.43, 0.41).mul(glow.mul(0.95).mul(aoCeil)).add(sampleMirror(ceilMirror, vec2(0, 0), glossyRadius(ceilMirror.n, 0.06), 12).mul(mix(0.15, 0.6, f)));
}

const basinMat = new THREE.MeshStandardNodeMaterial({ side: THREE.BackSide, roughness: 0.3, alphaTest: 0.5 });
{ // pale pool tile (floor uses xz, walls x+z/y) with drifting caustics, so you can see into the water
  const flr = smoothstep(0.5, 0.8, abs(normalWorld.y));
  const tuv = mix(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y), positionWorld.xz, flr);
  const t = tile(tuv, vec2(0.25, 0.25), 0.03, vec3(0.42, 0.62, 0.6), vec3(0.24, 0.36, 0.35), 0.05);
  const cx = positionWorld.x.mul(2.1), cz = positionWorld.z.mul(2.1);
  const web = abs(sin(cx.add(sin(cz.mul(0.8).add(time.mul(0.7))).mul(1.6))).add(sin(cz.mul(1.1).add(sin(cx.mul(0.7).sub(time.mul(0.6))).mul(1.6))))).mul(0.5);
  const caustic = pow(web.oneMinus(), 5).mul(flr.mul(0.7).add(0.3));
  basinMat.colorNode = t.color;
  basinMat.aoNode = aoBasin;
  basinMat.emissiveNode = t.color.mul(glow.mul(0.35).mul(aoBasin)).add(vec3(0.55, 0.75, 0.7).mul(caustic).mul(0.35));
}
basinMat.opacityNode = select(cameraPosition.y.greaterThan(0), float(1), float(0)); // hidden from the mirror camera

const copingMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0, alphaTest: 0.5 });
copingMat.colorNode = vec3(0.74, 0.79, 0.76);
copingMat.opacityNode = select(cameraPosition.y.greaterThan(0), float(1), float(0)); // its underside must not appear in the mirrors
copingMat.emissiveNode = sampleMirror(floorMirror, vec2(0, 0), glossyRadius(floorMirror.n, 0.08), 8).mul(0.3).add(vec3(0.74, 0.79, 0.76).mul(glow.mul(0.15)));

const envMap = await new RGBELoader().loadAsync('monochrome_studio_02_1k.hdr');
envMap.mapping = THREE.EquirectangularReflectionMapping;
window.__ld(70, 'Building room');

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
  return vec2(gx, gz).mul(U.waves);
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
  const glint = pow(clamp(dot(Rv, normalize(vec3(-0.8, 0.45, -0.35))), 0, 1), 60).mul(3.5).mul(U.glint);
  // refraction (water IOR 1.33): bend the view ray at the wavy surface, follow it to the basin floor,
  // and read that point back from the refraction target. Light is absorbed along the path, red first.
  const T = refract(viewDir().negate(), nW, 1 / 1.33);
  const pathLen = U.depth.add(WL).div(max(T.y.negate(), 0.2));
  const hit0 = positionWorld.add(T.mul(pathLen)); // keep it inside the basin (a ray leaving it would hit a wall first)
  const hit = vec3(clamp(hit0.x, p.cx - p.w / 2 + 0.02, p.cx + p.w / 2 - 0.02), hit0.y, clamp(hit0.z, p.cz - p.d / 2 + 0.02, p.cz + p.d / 2 - 0.02));
  const uvS = projUV(refr.vp, positionWorld), dUV = projUV(refr.vp, hit).sub(uvS);
  const seen = vec3( // a hint of dispersion: each channel bends a touch differently
    texture(refr.rt.texture, uvS.add(dUV.mul(1.05))).r,
    texture(refr.rt.texture, uvS.add(dUV)).g,
    texture(refr.rt.texture, uvS.add(dUV.mul(0.95))).b);
  // keep what's seen through the water no brighter than the old teal body, so the reflections keep their contrast
  const absorb = exp(vec3(0.6, 0.15, 0.2).mul(U.murk).mul(pathLen).negate());
  const vis = absorb.g.mul(U.seeThrough);
  const under = mix(body, seen.mul(vec3(0.3, 0.7, 0.65)).mul(absorb.div(absorb.g.max(1e-3))), vis).mul(U.waterDarken);
  wm.colorNode = vec3(0, 0.01, 0.012);
  wm.emissiveNode = sampleMirror(waterMirror, g.mul(0.3), 0.004, 6).mul(vec3(0.6, 0.9, 0.85)).mul(U.reflect).mul(fres).add(under.mul(fres.oneMinus())).add(vec3(0.8, 1.0, 0.95).mul(glint));
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

const basinMeshes = [];
for (const p of pools) {
  const ps = rrect(new THREE.Shape(), p.cx, -p.cz, p.w, p.d, CORNER);
  const basin = add(new THREE.ExtrudeGeometry(ps, { depth: POOL_DEPTH, bevelEnabled: false, curveSegments: 10 }).rotateX(-Math.PI / 2).translate(0, -POOL_DEPTH, 0), basinMat, 0, 0, 0);
  basin.layers.enable(1); basinMeshes.push(basin);
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
const post = new THREE.PostProcessing(renderer);
const sp = pass(scene, camera);
// bloom first (undistorted), then fisheye-sample the combined image so glow sticks to the lights
const bloomPass = bloom(sp, 0.3, 0.7, 1.0);
const preFish = convertToTexture(sp.add(bloomPass));
post.outputNode = (() => {
  // circular coords so the bulge is a round dome, not stretched by aspect
  const aspect = screenSize.x.div(screenSize.y);
  const uv = vec2(screenUV.x.sub(0.5).mul(aspect), screenUV.y.sub(0.5));
  const r = length(uv).max(1e-4);
  const corner = length(vec2(aspect.mul(0.5), float(0.5))); // pin screen corners → no wrap/tile at edges
  const rn = r.div(corner);
  const newRn = tan(rn.mul(U.bulge.max(0.01))).div(tan(U.bulge.max(0.01)));
  const warped = uv.mul(newRn.div(rn));
  const fishUV = vec2(warped.x.div(aspect), warped.y).add(0.5);
  const ca = uv.mul(dot(uv, uv).mul(U.ca));
  const caUV = vec2(ca.x.div(aspect), ca.y);
  const c = vec3(
    preFish.sample(fishUV.add(caUV)).r,
    preFish.sample(fishUV).g,
    preFish.sample(fishUV.sub(caUV)).b
  );
  const grain = fract(sin(dot(screenUV.add(fract(time.mul(0.37))), vec2(12.9898, 78.233))).mul(43758.5453)).sub(0.5).mul(U.grain);
  // eyelids: two curved lids meet in the middle as U.blink goes 0 -> 1, with a soft shadowed edge
  const lidEdge = mix(float(0.75), float(-0.06), U.blink);
  const lx = uv.x.div(aspect.mul(0.5)); // -1..1 across the screen whatever the aspect
  const lidY = abs(uv.y).add(lx.mul(lx).mul(0.12));
  const lids = smoothstep(lidEdge, lidEdge.sub(0.09), lidY);
  return vec4(c.mul(vec3(0.97, 1.0, 0.985)).mul(lids).add(grain.mul(lids)), 1);
})();

/* ---------- controls ---------- */
const move = { walkSpeed: 2, sprintSpeed: 5 }; // desktop WASD / Shift sprint (units/sec); phone scales via joystick push
const controls = new PointerLockControls(camera, renderer.domElement);
controls.pointerSpeed = 1.75; // 0.002 * 1.75 = the 0.0035 rad/px the drag-look used
controls.minPolarAngle = Math.PI / 2 - 1.3;
controls.maxPolarAngle = Math.PI / 2 + 1.3; // keeps the old ±1.3 rad pitch clamp
const keys = {};
addEventListener('keydown', e => { if (e.target.closest?.('.lil-gui')) return; keys[e.code] = true; if (e.code === 'KeyG') gui._hidden ? gui.show() : gui.hide(); if (e.code === 'KeyM') { sound.muted = !sound.muted; applyVolumes(); gui.controllersRecursive().forEach(c => c.updateDisplay()); } });
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

/* ---------- head bob, eye blinks ---------- */
const bob = { strength: 1, roll: true, phase: 0, amt: 0, step: 0 };
const blinkCfg = { enabled: true, every: 4.5, t0: -1, next: performance.now() + 3000, double: false };
function updateBlink(now) {
  if (!blinkCfg.enabled) { U.blink.value = 0; return; }
  if (blinkCfg.t0 < 0 && now >= blinkCfg.next) blinkCfg.t0 = now;
  if (blinkCfg.t0 < 0) return;
  const t = now - blinkCfg.t0; // close fast, hold a beat, open a little slower
  const v = t < 75 ? t / 75 : t < 115 ? 1 : t < 300 ? 1 - (t - 115) / 185 : 0;
  U.blink.value = v * v * (3 - 2 * v);
  if (t >= 300) {
    blinkCfg.t0 = -1;
    const again = !blinkCfg.double && Math.random() < 0.18; // now and then, a quick double blink
    blinkCfg.double = again;
    blinkCfg.next = now + (again ? 140 : blinkCfg.every * 1000 * (0.45 + Math.random() * 1.1));
  }
}

/* ---------- sound: Pixabay recordings in sounds/ (see sounds/CREDITS.txt), played through Web Audio ---------- */
// barefoot steps on tile (10 variations), pool water, and cave drips; footsteps and
// drips also go through a long synthetic hall reverb so they ring around the tiles like the room does
const sound = { master: 0.8, steps: 0.9, ambience: 0.6, water: 0.15, muted: false, ctx: null, buf: {} };
const SND = { step: 10, drip: 6 };
function initAudio() {
  if (sound.ctx) { if (sound.ctx.state !== 'running') sound.ctx.resume(); return; }
  const ctx = sound.ctx = new AudioContext();
  const master = sound.masterGain = ctx.createGain(); master.connect(ctx.destination);
  const ir = ctx.createBuffer(2, ctx.sampleRate * 3.8, ctx.sampleRate); // big tiled hall: long, bright tail
  for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / ctx.sampleRate; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t / 3.8, 2.2) * (t < 0.012 ? t / 0.012 : 1); } }
  const verb = ctx.createConvolver(); verb.buffer = ir;
  const wet = ctx.createGain(); wet.gain.value = 0.45; verb.connect(wet); wet.connect(master);
  sound.verb = verb;
  sound.stepBus = ctx.createGain(); sound.stepBus.connect(master); sound.stepBus.connect(verb);
  sound.ambBus = ctx.createGain(); sound.ambBus.connect(master); // the ambience recordings already carry their room
  sound.dripBus = ctx.createGain(); sound.dripBus.gain.value = 0.35; sound.dripBus.connect(sound.ambBus); sound.dripBus.connect(verb);
  applyVolumes();
  const load = async name => sound.buf[name] = await ctx.decodeAudioData(await (await fetch('sounds/' + name + '.mp3')).arrayBuffer());
  const names = ['ambience_water'];
  for (const [k, n] of Object.entries(SND)) for (let i = 1; i <= n; i++) names.push(k + i);
  Promise.all(names.map(n => load(n).catch(e => console.warn('sound', n, e)))).then(() => {
    const loop = (name, gain) => { const b = sound.buf[name]; if (!b) return;
      const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = b; src.loop = true;
      g.gain.setValueAtTime(0, ctx.currentTime); g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 2.5); // fade in
      src.connect(g); g.connect(sound.ambBus); src.start(0, Math.random() * b.duration); return g; };
    sound.waterGain = loop('ambience_water', sound.water);
    const drip = () => {
      const b = sound.buf['drip' + (1 + Math.floor(Math.random() * SND.drip))];
      if (b) { const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
        src.buffer = b; src.playbackRate.value = 0.8 + Math.random() * 0.45; g.gain.value = 0.35 + Math.random() * 0.65; pan.pan.value = Math.random() * 1.6 - 0.8;
        src.connect(g); g.connect(pan); pan.connect(sound.dripBus); src.start(); }
      setTimeout(drip, 2000 + Math.random() * 7000);
    };
    setTimeout(drip, 2500);
  });
}
function applyVolumes() {
  if (!sound.ctx) return;
  const t = sound.ctx.currentTime;
  sound.masterGain.gain.setTargetAtTime(sound.muted ? 0 : sound.master, t, 0.05);
  sound.stepBus.gain.setTargetAtTime(sound.steps, t, 0.05);
  sound.ambBus.gain.setTargetAtTime(sound.ambience, t, 0.05);
  if (sound.waterGain) sound.waterGain.gain.setTargetAtTime(sound.water, t, 0.05);
}
let lastStep = 0;
function footstep(loud, side) {
  const ctx = sound.ctx; if (!ctx || ctx.state !== 'running') return;
  let k; do k = 1 + Math.floor(Math.random() * SND.step); while (k === lastStep && SND.step > 1); lastStep = k; // never the same sample twice in a row
  const b = sound.buf['step' + k]; if (!b) return;
  const src = ctx.createBufferSource(), g = ctx.createGain(), pan = ctx.createStereoPanner();
  src.buffer = b; src.playbackRate.value = (loud > 1 ? 1.06 : 0.97) + Math.random() * 0.08; // slight pitch variety
  g.gain.value = (0.8 + Math.random() * 0.3) * loud; pan.pan.value = side * 0.15;
  src.connect(g); g.connect(pan); pan.connect(sound.stepBus); src.start();
}
// start screen: the Enter click is the user gesture browsers require for sound (and for capturing the mouse)
let started = false;
window.__onStart = () => {
  started = true;
  initAudio();
  gui.show();
  if (!matchMedia('(pointer: coarse)').matches) controls.lock();
  setTimeout(() => document.getElementById('hint').style.opacity = 0, 7000);
};
// browsers only allow audio after a user gesture
for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, initAudio, { passive: true });

addEventListener('resize', () => { fitFov(); renderer.setSize(innerWidth, innerHeight); });

let last = performance.now(), frames = 0;
window.__ld(88, 'Warming shaders');
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
  const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - joy.y;
  const s = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + joy.x;
  const go = started ? 1 : 0; // no walking behind the start screen
  const spd = go * (keys.ShiftLeft || keys.ShiftRight ? move.sprintSpeed : move.walkSpeed) * dt;
  const yaw = camera.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const dx = (fx * f - fz * s) * spd, dz = (fz * f + fx * s) * spd;
  const p = camera.position;
  const ox = p.x, oz = p.z;
  if (!blocked(p.x + dx, p.z)) p.x += dx;
  if (!blocked(p.x, p.z + dz)) p.z += dz;
  // head bob: driven by distance actually travelled (so walking into a wall doesn't bob); a footfall at each dip
  const moved = Math.hypot(p.x - ox, p.z - oz), speed = moved / Math.max(dt, 1e-4);
  const sprinting = speed > (move.walkSpeed + move.sprintSpeed) / 2;
  const stride = sprinting ? 0.95 : 0.72;
  bob.phase += moved / stride * Math.PI;
  bob.amt += ((speed > 0.2 ? 1 : 0) - bob.amt) * Math.min(1, dt * 8);
  const amp = (sprinting ? 0.065 : 0.04) * bob.strength;
  const stepNo = Math.floor(bob.phase / Math.PI);
  if (stepNo !== bob.step) { bob.step = stepNo; if (speed > 0.2) footstep(sprinting ? 1.25 : 0.85, stepNo % 2 ? 1 : -1); }
  p.y = 1.7 + Math.sin(now * 0.0016) * 0.008 + (Math.abs(Math.sin(bob.phase)) - 0.6) * amp * bob.amt;
  camera.rotation.z = bob.roll ? Math.sin(bob.phase) * 0.006 * bob.strength * bob.amt * (sprinting ? 1.5 : 1) : 0;
  updateBlink(now);
  camera.updateMatrixWorld();
  renderMirror(floorMirror, [floorMesh, ...copingMeshes]);
  renderMirror(waterMirror, waterMeshes);
  _pv.multiplyMatrices(camera.projectionMatrix, _iv.copy(camera.matrixWorld).invert()); frustum.setFromProjectionMatrix(_pv);
  wallMirrors.forEach((m, i) => { // only walls currently in view get a mirror pass
    if (frustum.intersectsBox(wallBoxes[i] ||= new THREE.Box3().setFromObject(wallMeshes[i]))) renderMirror(m, [wallMeshes[i]]);
  });
  if (frustum.intersectsBox(wallBoxes.ceil ||= new THREE.Box3().setFromObject(ceilMesh))) renderMirror(ceilMirror, [ceilMesh]);
  renderRefraction();
  post.render();
  // two frames in: the node materials are compiled and the canvas is actually showing the room
  if (++frames === 2) window.__ldDone(); // shows the Enter button on the start screen
});

/* ---------- controls panel (G toggles it) ---------- */
const gui = new GUI({ title: 'Controls  (G to hide)' });
if (innerWidth < 700) gui.close();
gui.hide(); // appears once the start screen is dismissed
const slider = (folder, obj, key, min, max, step, name) => folder.add(obj, key, min, max, step).name(name);
const u = (folder, k, min, max, step, name) => slider(folder, U[k], 'value', min, max, step, name);
const fW = gui.addFolder('Water');
u(fW, 'waterDarken', 0.2, 1.5, 0.01, 'Brightness');
u(fW, 'seeThrough', 0, 1, 0.01, 'See-through');
u(fW, 'murk', 0, 3, 0.01, 'Murkiness');
u(fW, 'reflect', 0, 2, 0.01, 'Reflection');
u(fW, 'waves', 0, 3, 0.01, 'Wave height');
u(fW, 'glint', 0, 3, 0.01, 'Sun glints');
const depthCtl = { depth: POOL_DEPTH };
slider(fW, depthCtl, 'depth', 0.5, 8, 0.1, 'Pool depth').onChange(v => {
  U.depth.value = v; for (const b of basinMeshes) b.scale.y = v / POOL_DEPTH; // basin top stays at the deck
});
const fL = gui.addFolder('Lighting');
slider(fL, renderer, 'toneMappingExposure', 0.2, 1.5, 0.01, 'Exposure');
slider(fL, hemi, 'intensity', 0, 3, 0.01, 'Ambient light');
slider(fL, sun, 'intensity', 0, 3, 0.01, 'Sun');
slider(fL, scene.fog, 'density', 0, 0.04, 0.001, 'Fog');
u(fL, 'ao', 0, 1.5, 0.01, 'Ambient occlusion');
const fP = gui.addFolder('Post effects');
slider(fP, bloomPass.strength, 'value', 0, 2, 0.01, 'Bloom');
slider(fP, bloomPass.threshold, 'value', 0, 2, 0.01, 'Bloom threshold');
u(fP, 'bulge', 0, 1.4, 0.01, 'Fisheye');
u(fP, 'ca', 0, 0.05, 0.001, 'Colour fringing');
u(fP, 'grain', 0, 0.1, 0.001, 'Film grain');
const fM = gui.addFolder('Movement');
slider(fM, move, 'walkSpeed', 0.5, 10, 0.1, 'Walk speed');
slider(fM, move, 'sprintSpeed', 1, 20, 0.1, 'Sprint speed');
slider(fM, controls, 'pointerSpeed', 0.2, 5, 0.05, 'Mouse sensitivity');
slider(fM, bob, 'strength', 0, 3, 0.05, 'Head bob');
fM.add(bob, 'roll').name('Head sway');
const fE = gui.addFolder('Eyes');
fE.add(blinkCfg, 'enabled').name('Blinking');
slider(fE, blinkCfg, 'every', 1, 15, 0.5, 'Avg seconds between');
fE.add({ blink: () => { blinkCfg.t0 = -1; blinkCfg.next = 0; } }, 'blink').name('Blink now');
const fS = gui.addFolder('Sound');
fS.add(sound, 'muted').name('Mute (M)').onChange(applyVolumes);
slider(fS, sound, 'master', 0, 1, 0.01, 'Master').onChange(applyVolumes);
slider(fS, sound, 'steps', 0, 2, 0.01, 'Footsteps').onChange(applyVolumes);
slider(fS, sound, 'ambience', 0, 2, 0.01, 'Ambience').onChange(applyVolumes);
slider(fS, sound, 'water', 0, 1, 0.01, 'Water').onChange(applyVolumes);
const fQ = gui.addFolder('Quality');
const q = { refraction: refr.scale };
slider(fQ, q, 'refraction', 0.25, 1, 0.05, 'Refraction res').onChange(v => refr.scale = v);
slider(fQ, { pr: renderer.getPixelRatio() }, 'pr', 0.5, 2, 0.05, 'Pixel ratio').onChange(v => renderer.setPixelRatio(v));
gui.add({ reset: () => gui.reset() }, 'reset').name('Reset all');
fP.close(); fM.close(); fE.close(); fQ.close();
