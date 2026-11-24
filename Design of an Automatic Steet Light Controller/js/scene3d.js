/* =====================================================================
   SmartLux Scene3D  -  photoreal procedural street scene
   Streetlights with PIR sensors, vehicles (sedan / SUV / truck /
   cyclist), buildings, trees, wet asphalt, day-night cycle.
   Depends on gl3d.js.  Public API: window.Scene3D
===================================================================== */
(function (global) {
'use strict';
if (!global.GL3D) return;
const { Renderer, G, M, V, box, plane, lathe, cylinder, sphere, capsule, limb, tube, MAXL } = global.GL3D;

/* ------------------------------ helpers ------------------------------ */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rad = d => d * Math.PI / 180;
const srgb = c => c.map(v => Math.pow(v, 2.2));
const hex = h => srgb([(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255]);
let seed = 1337;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const rr = (a, b) => a + (b - a) * rnd();

/* layout (metres).  Road runs along X, camera side is +Z. */
const POLES = 8, SPACING = 25;
const poleX = i => (i - (POLES - 1) / 2) * SPACING;
const poleSide = i => (i % 2 === 0 ? 1 : -1);
const POLE_Z = 4.95, ARM = 2.5, LAMP_Y = 9.28;
const LANE_Z = 2.0;

/* ------------------------------ geometry ------------------------------ */
function interp(pts, x) {
    let i = 0;
    while (i < pts.length - 2 && x > pts[i + 1][0]) i++;
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    const h = p2[0] - p1[0] || 1, t = clamp((x - p1[0]) / h, 0, 1);
    const m1 = (p2[1] - p0[1]) / ((p2[0] - p0[0]) || 1) * h;
    const m2 = (p3[1] - p1[1]) / ((p3[0] - p1[0]) || 1) * h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}
const inR = (r, x) => r && x >= r[0] && x <= r[1];

// lofted car body.  local axes: +X forward, +Y up, +Z right.
function carBody(sp) {
    const N = sp.sections || 110, x0 = sp.x0, L = sp.x1 - sp.x0;
    const P = [], cabH = [], xs = [];
    for (let s = 0; s <= N; s++) {
        const u = s / N, x = x0 + L * (1 - Math.cos(Math.PI * u)) / 2;
        const yt = interp(sp.top, x), ys0 = interp(sp.belt, x), yb = interp(sp.bot, x), hw = interp(sp.wid, x);
        const ys = Math.min(ys0, yt - 0.1), cab = yt - ys;
        const gw = hw * (sp.gwA - sp.gwB * sstep(0.1, 0.4, cab));
        const R = [
            [0, yt], [gw * 0.42, yt - 0.012], [gw * 0.78, ys + cab * 0.9], [gw * 0.95, ys + cab * 0.5],
            [gw, ys + 0.012], [hw * 0.995, ys - 0.012], [hw, yb + (ys - yb) * 0.42], [hw * 0.965, yb + (ys - yb) * 0.12],
            [hw * 0.78, yb + 0.004], [0, yb]
        ];
        const ring = [];
        for (let k = 0; k < 10; k++) ring.push([x, R[k][1], R[k][0]]);
        for (let k = 8; k >= 1; k--) ring.push([x, R[k][1], -R[k][0]]);
        P.push(ring); cabH.push(cab); xs.push(x);
    }
    const K = 18;
    // smooth normals on shared grid
    const nrm = P.map(r => r.map(() => [0, 0, 0]));
    const tri = (a, b, c) => {
        const n = V.cross(V.sub(b.p, a.p), V.sub(c.p, a.p));
        [a, b, c].forEach(q => { q.n[0] += n[0]; q.n[1] += n[1]; q.n[2] += n[2]; });
    };
    const at = (s, k) => ({ p: P[s][k % K], n: nrm[s][k % K] });
    for (let s = 0; s < N; s++) for (let k = 0; k < K; k++) {
        const A = at(s, k), B = at(s, k + 1), C = at(s + 1, k + 1), D = at(s + 1, k);
        tri(A, B, C); tri(A, C, D);
    }
    const g = new G();
    const side = new Set([2, 3, 14, 15]), topS = new Set([0, 1, 16, 17]);
    for (let s = 0; s < N; s++) for (let k = 0; k < K; k++) {
        const k1 = (k + 1) % K;
        const xm = (xs[s] + xs[s + 1]) / 2, cab = (cabH[s] + cabH[s + 1]) / 2;
        let m = 0;
        if (side.has(k) && cab > 0.17 && inR(sp.side, xm) && !inR(sp.pillar, xm) && !inR(sp.pillar2, xm)) m = 1;
        if (topS.has(k) && (inR(sp.ws, xm) || inR(sp.rw, xm))) m = 1;
        const o = g.vc;
        const idx = [[s, k], [s, k1], [s + 1, k1], [s + 1, k]];
        for (const [ss, kk] of idx) {
            const p = P[ss][kk], n = V.norm(nrm[ss][kk]);
            g.v(p[0], p[1], p[2], n[0], n[1], n[2], p[0], p[1], m);
        }
        g.q(o, o + 1, o + 2, o + 3);
    }
    // caps
    for (const [s, nx] of [[0, -1], [N, 1]]) {
        let cy = 0; P[s].forEach(p => cy += p[1]); cy /= K;
        const c = g.v(P[s][0][0], cy, 0, nx, 0, 0, 0, 0, 0);
        const base = g.vc;
        P[s].forEach(p => g.v(p[0], p[1], p[2], nx, 0, 0, 0, 0, 0));
        for (let k = 0; k < K; k++) g.t(c, base + k, base + (k + 1) % K);
    }
    return g.finish();
}

function wheelParts(R, W, rimR, spokes) {
    // axis along Z after rotX; outer face +Z
    const hw = W / 2;
    const tp = [[rimR * 0.84, hw * 0.98, 1], [rimR + 0.012, hw * 0.95], [R * 0.935, hw * 1.0], [R * 0.985, hw * 0.74], [R, hw * 0.46],
        [R, -hw * 0.46], [R * 0.985, -hw * 0.74], [R * 0.935, -hw * 1.0], [rimR + 0.012, -hw * 0.95], [rimR * 0.84, -hw * 0.98, 1]];
    const rot = M.rotX(Math.PI / 2);
    const tire = new G().add(lathe(tp, 40, 0), rot).finish();
    // rim: barrel + dish + spokes
    const rim = new G();
    rim.add(lathe([[rimR, hw * 0.85, 1], [rimR, -hw * 0.85, 1], [rimR * 0.88, -hw * 0.7, 1], [rimR * 0.88, hw * 0.6, 1]], 40, 0), rot);
    const dishY = hw * 0.62;
    rim.add(lathe([[0, dishY + 0.02, 1], [rimR * 0.2, dishY + 0.025], [rimR * 0.27, dishY - 0.01, 1], [rimR * 0.9, dishY - 0.035], [rimR * 0.9, dishY - 0.07, 1], [0, dishY - 0.07, 1]], 32, 0), rot);
    for (let i = 0; i < spokes; i++) {
        const a = i / spokes * Math.PI * 2;
        const sg = new G().add(box(rimR * 0.66, 0.048, 0.034), M.mul(M.rotZ(a), M.trans(Math.cos(a) * rimR * 0.58 - Math.cos(a) * rimR * 0.58, 0, 0)));
        const m = M.mul(M.trans(0, 0, dishY + 0.012), M.mul(M.rotZ(a), M.trans(rimR * 0.58, 0, 0)));
        rim.add(box(rimR * 0.66, 0.05, 0.036), m);
    }
    const disc = new G();
    disc.add(cylinder(rimR * 0.72, rimR * 0.72, 0.028, 36), M.mul(M.trans(0, 0, hw * 0.2), rot));
    disc.add(cylinder(rimR * 0.3, rimR * 0.3, 0.07, 18), M.mul(M.trans(0, 0, hw * 0.2), rot));
    const cal = box(0.1, 0.17, 0.05);
    disc.add(cal, M.trans(rimR * 0.5, rimR * 0.25, hw * 0.34));
    return { tire, rim: rim.finish(), disc: disc.finish() };
}

function ellipsoid(rx, ry, rz, m = 0) {
    const g = sphere(1, 22, 14, m);
    return new G().add(g, M.scale(rx, ry, rz));
}

/* --------------------------- vehicle models --------------------------- */
const SPEC = {
    sedan: {
        x0: -2.425, x1: 2.425, gwA: 0.93, gwB: 0.12,
        top: [[-2.425, 0.64], [-2.37, 0.86], [-2.25, 0.97], [-1.85, 1.01], [-1.45, 1.02], [-1.15, 1.08], [-0.85, 1.22], [-0.55, 1.37], [-0.2, 1.445], [0.25, 1.455], [0.6, 1.40], [0.85, 1.25], [1.05, 1.06], [1.22, 0.985], [1.6, 0.955], [1.95, 0.90], [2.28, 0.80], [2.40, 0.70], [2.425, 0.56]],
        belt: [[-2.425, 0.55], [-2.3, 0.86], [-1.9, 0.95], [-1.2, 0.96], [0, 0.97], [1.2, 0.955], [1.9, 0.86], [2.3, 0.74], [2.425, 0.56]],
        bot: [[-2.425, 0.42], [-2.3, 0.30], [-2.05, 0.20], [-1.7, 0.175], [1.7, 0.175], [2.1, 0.21], [2.3, 0.30], [2.425, 0.40]],
        wid: [[-2.425, 0.62], [-2.35, 0.78], [-2.1, 0.89], [-1.5, 0.925], [0, 0.935], [1.5, 0.925], [2.1, 0.89], [2.35, 0.78], [2.425, 0.64]],
        side: [-1.12, 0.92], pillar: [-0.30, -0.17], ws: [0.62, 1.2], rw: [-1.4, -0.66],
        axle: [1.42, -1.42], R: 0.335, W: 0.225, rimR: 0.235, spokes: 5, track: 0.79,
        gaps: [0.80, -0.24, -1.18, 1.24], belt0: 0.97, grille: [0.34, 0.62], mirror: [0.78, 1.0, 0.99],
        head: [2.3, 0.70, 0.66], tail: [-2.4, 0.88, 0.66], plateF: [2.43, 0.44], plateR: [-2.43, 0.62], hl: 0.5, flake: 1
    },
    suv: {
        x0: -2.375, x1: 2.375, gwA: 0.94, gwB: 0.09,
        top: [[-2.375, 0.85], [-2.33, 1.12], [-2.25, 1.33], [-2.1, 1.55], [-1.9, 1.68], [-1.0, 1.72], [0.1, 1.73], [0.6, 1.68], [0.95, 1.45], [1.15, 1.22], [1.3, 1.12], [1.8, 1.08], [2.2, 1.0], [2.33, 0.9], [2.375, 0.72]],
        belt: [[-2.375, 0.8], [-2.3, 1.0], [-1.9, 1.12], [0, 1.13], [1.2, 1.1], [2.0, 1.0], [2.33, 0.82], [2.375, 0.70]],
        bot: [[-2.375, 0.50], [-2.2, 0.34], [-1.9, 0.25], [1.9, 0.25], [2.2, 0.31], [2.375, 0.47]],
        wid: [[-2.375, 0.72], [-2.3, 0.86], [-2.0, 0.95], [0, 0.975], [2.0, 0.95], [2.3, 0.86], [2.375, 0.74]],
        side: [-1.95, 0.9], pillar: [-0.28, -0.16], pillar2: [-1.12, -1.02], ws: [0.66, 1.2], rw: [-2.28, -1.98],
        axle: [1.4, -1.4], R: 0.37, W: 0.245, rimR: 0.26, spokes: 6, track: 0.82,
        gaps: [0.88, -0.22, -1.25, 1.25], belt0: 1.13, grille: [0.44, 0.80], mirror: [0.86, 1.14, 1.0],
        head: [2.28, 0.86, 0.68], tail: [-2.36, 1.0, 0.7], plateF: [2.375, 0.5], plateR: [-2.375, 0.72], hl: 0.62, flake: 1
    },
    truckCab: {
        x0: 1.6, x1: 4.0, gwA: 0.97, gwB: 0.04, sections: 90,
        top: [[1.6, 2.55], [1.64, 2.80], [1.8, 2.86], [3.25, 2.88], [3.55, 2.72], [3.85, 1.9], [3.97, 1.3], [4.0, 1.0]],
        belt: [[1.6, 1.6], [1.7, 1.68], [3.0, 1.72], [3.8, 1.5], [4.0, 1.1]],
        bot: [[1.6, 0.8], [4.0, 0.64]],
        wid: [[1.6, 1.1], [1.75, 1.19], [3.9, 1.19], [4.0, 1.04]],
        side: [2.0, 3.55], pillar: [99, 99], ws: [3.32, 3.9], rw: [99, 99]
    }
};

const MODELS = {};
function buildCar(name) {
    const sp = SPEC[name];
    const parts = [];
    const P = (mesh, local, mat, extra) => parts.push(Object.assign({ mesh, local: local || M.ident(), mat }, extra || {}));
    const body = R.mesh(carBody(sp));
    const bodyMat = { mode: 6, albedo: [0.5, 0.5, 0.5], shadow: true, car: [sp.axle[0], sp.axle[1], sp.belt0, sp.R + 0.065], misc: [sp.R, sp.grille[0], sp.grille[1], sp.flake], gaps: sp.gaps };
    P(body, null, bodyMat, { role: 'paint' });
    // wheels
    const wp = wheelParts(sp.R, sp.W, sp.rimR, sp.spokes);
    const tire = R.mesh(wp.tire), rim = R.mesh(wp.rim), disc = R.mesh(wp.disc);
    const wheels = [];
    for (const ax of sp.axle) for (const sd of [1, -1]) wheels.push({ x: ax, z: sd * (sp.track + 0.02), side: sd });
    wheels.forEach(w => {
        const dyn = v => M.mul(M.trans(w.x, sp.R, w.z), M.mul(M.rotZ(-v.dist / sp.R), w.side < 0 ? M.rotY(Math.PI) : M.ident()));
        P(tire, null, { mode: 8, shadow: true }, { dyn });
        P(rim, null, { mode: 0, albedo: [0.62, 0.63, 0.66], metal: 1, rough: 0.2, shadow: false }, { dyn });
        P(disc, null, { mode: 0, albedo: [0.3, 0.3, 0.32], metal: 0.9, rough: 0.55, shadow: false }, { dyn });
    });
    // lights
    const hz = sp.head[2], hx = sp.head[0], hy = sp.head[1];
    const headMesh = R.mesh(ellipsoid(0.22, 0.045, 0.17));
    const housing = R.mesh(ellipsoid(0.235, 0.06, 0.19));
    const drl = R.mesh(box(0.012, 0.018, 0.30));
    for (const sd of [1, -1]) {
        const loc = M.mul(M.trans(hx, hy, sd * hz), M.rotY(sd * -0.5));
        P(housing, M.mul(loc, M.trans(-0.02, 0, 0)), { mode: 0, albedo: [0.01, 0.01, 0.012], metal: 0.6, rough: 0.1, shadow: false });
        P(headMesh, M.mul(loc, M.trans(0.0, 0, 0)), { mode: 7, albedo: [0.2, 0.2, 0.2], rough: 0.05, emis: [0, 0, 0], shadow: false }, { role: 'head', k: 1 });
        P(drl, M.mul(loc, M.trans(0.1, -0.01, 0)), { mode: 7, albedo: [0.1, 0.1, 0.1], rough: 0.2, emis: [0, 0, 0], shadow: false }, { role: 'head', k: 0.35 });
    }
    const tx = sp.tail[0], ty = sp.tail[1], tz = sp.tail[2];
    const tailMesh = R.mesh(box(0.07, 0.11, 0.38));
    const tailBar = R.mesh(box(0.03, 0.026, tz * 1.1));
    for (const sd of [1, -1]) {
        P(tailMesh, M.mul(M.trans(tx + 0.02, ty, sd * tz), M.rotY(sd * 0.35)), { mode: 7, albedo: [0.15, 0.01, 0.01], rough: 0.1, emis: [0, 0, 0], shadow: false }, { role: 'tail', k: 1 });
    }
    P(tailBar, M.trans(tx + 0.03, ty + 0.01, 0), { mode: 7, albedo: [0.15, 0.01, 0.01], rough: 0.1, emis: [0, 0, 0], shadow: false }, { role: 'tail', k: 0.6 });
    // plates
    const plate = R.mesh(box(0.012, 0.112, 0.52));
    P(plate, M.trans(sp.plateF[0], sp.plateF[1], 0), { mode: 0, albedo: [0.85, 0.85, 0.8], rough: 0.5, shadow: false });
    P(plate, M.trans(sp.plateR[0], sp.plateR[1], 0), { mode: 0, albedo: [0.85, 0.82, 0.55], rough: 0.5, shadow: false });
    // mirrors
    const mir = R.mesh(ellipsoid(0.07, 0.055, 0.11));
    const stalk = R.mesh(box(0.05, 0.03, 0.12));
    for (const sd of [1, -1]) {
        const mx = sp.mirror[0], my = sp.mirror[1], mz = (sp.wid[4][1] || 0.93) * 0 + sp.mirror[2];
        P(mir, M.trans(mx - 0.02, my, sd * (mz + 0.15)), { mode: 6, albedo: [0.5, 0.5, 0.5], shadow: true, car: [0, 0, 9, 0], misc: [0, 0, 0, 0], gaps: [99, 99, 99, 99] }, { role: 'paint' });
        P(stalk, M.trans(mx, my - 0.02, sd * (mz + 0.04)), { mode: 0, albedo: [0.01, 0.01, 0.012], rough: 0.5, shadow: false });
    }
    // underbody shadow plate
    P(R.mesh(box(sp.x1 - sp.x0 - 0.6, 0.05, sp.track * 1.7)), M.trans((sp.x0 + sp.x1) / 2, 0.15, 0), { mode: 0, albedo: [0.008, 0.008, 0.008], rough: 0.9, shadow: false });
    const dims = { L: sp.x1 - sp.x0, W: sp.wid[4][1] * 2, cx: (sp.x0 + sp.x1) / 2, front: sp.x1, rear: sp.x0, headY: 0.68, headZ: hz, tailY: ty };
    return { parts, dims, kind: 'car', R: sp.R };
}

function buildTruck() {
    const parts = [];
    const P = (mesh, local, mat, extra) => parts.push(Object.assign({ mesh, local: local || M.ident(), mat }, extra || {}));
    const sp = SPEC.truckCab;
    const cab = R.mesh(carBody(sp));
    P(cab, null, { mode: 6, albedo: [0.5, 0.5, 0.5], shadow: true, car: [3.0, -9, 1.7, 0.0], misc: [0.5, 0.9, 1.34, 0.6], gaps: [3.55, 2.0, 99, 99] }, { role: 'paint' });
    // cargo box
    const cargo = R.mesh(box(5.95, 2.5, 2.46));
    P(cargo, M.trans(-1.35, 2.1, 0), { mode: 6, albedo: [0.82, 0.83, 0.85], shadow: true, car: [0, 0, 9, 0], misc: [0, 0, 0, -1], gaps: [99, 99, 99, 99] }, { role: 'fixed' });
    const stripe = R.mesh(box(5.95, 0.38, 2.5));
    P(stripe, M.trans(-1.35, 1.35, 0), { mode: 0, albedo: [0.5, 0.5, 0.5], rough: 0.5, shadow: false }, { role: 'accent' });
    // chassis + bumpers
    P(R.mesh(box(6.9, 0.22, 1.0)), M.trans(-0.5, 0.74, 0), { mode: 0, albedo: [0.02, 0.02, 0.022], rough: 0.8, shadow: true });
    P(R.mesh(box(0.28, 0.32, 2.3)), M.trans(4.05, 0.55, 0), { mode: 0, albedo: [0.06, 0.06, 0.065], metal: 0.4, rough: 0.5, shadow: true });
    P(R.mesh(box(0.16, 0.24, 2.4)), M.trans(-4.38, 0.62, 0), { mode: 0, albedo: [0.04, 0.04, 0.045], metal: 0.5, rough: 0.5, shadow: true });
    // wheels
    const R0 = 0.5, W0 = 0.3;
    const wp = wheelParts(R0, W0, 0.32, 8);
    const tire = R.mesh(wp.tire), rim = R.mesh(wp.rim), disc = R.mesh(wp.disc);
    const wlist = [[3.0, 1.05], [3.0, -1.05], [-2.6, 1.05], [-2.6, -1.05], [-3.55, 1.05], [-3.55, -1.05]];
    wlist.forEach(([x, z]) => {
        const side = Math.sign(z);
        const dyn = v => M.mul(M.trans(x, R0, z), M.mul(M.rotZ(-v.dist / R0), side < 0 ? M.rotY(Math.PI) : M.ident()));
        P(tire, null, { mode: 8, shadow: true }, { dyn });
        P(rim, null, { mode: 0, albedo: [0.6, 0.6, 0.62], metal: 1, rough: 0.3, shadow: false }, { dyn });
        P(disc, null, { mode: 0, albedo: [0.25, 0.25, 0.27], metal: 0.9, rough: 0.6, shadow: false }, { dyn });
    });
    // mudguards
    for (const x of [3.0, -3.1]) for (const sd of [1, -1]) {
        P(R.mesh(box(x > 0 ? 1.15 : 2.0, 0.06, 0.4)), M.trans(x, 1.05, sd * 1.05), { mode: 0, albedo: [0.03, 0.03, 0.03], rough: 0.7, shadow: false });
    }
    // lights
    const hl = R.mesh(box(0.05, 0.2, 0.36));
    for (const sd of [1, -1]) {
        P(hl, M.trans(4.0, 0.95, sd * 0.85), { mode: 7, albedo: [0.2, 0.2, 0.2], rough: 0.1, emis: [0, 0, 0], shadow: false }, { role: 'head', k: 1 });
        P(R.mesh(box(0.05, 0.12, 0.2)), M.trans(4.0, 0.74, sd * 0.95), { mode: 7, albedo: [0.2, 0.15, 0.05], rough: 0.1, emis: [0, 0, 0], shadow: false }, { role: 'head', k: 0.3 });
        P(R.mesh(box(0.05, 0.42, 0.14)), M.trans(-4.4, 1.15, sd * 1.12), { mode: 7, albedo: [0.15, 0.01, 0.01], rough: 0.1, emis: [0, 0, 0], shadow: false }, { role: 'tail', k: 1 });
        P(R.mesh(box(0.1, 0.55, 0.12)), M.trans(3.5, 2.05, sd * 1.5), { mode: 0, albedo: [0.01, 0.01, 0.012], rough: 0.5, shadow: false });
        P(R.mesh(box(0.06, 0.4, 0.28)), M.trans(3.5, 2.0, sd * 1.64), { mode: 0, albedo: [0.01, 0.01, 0.012], rough: 0.4, metal: 0.3, shadow: false });
    }
    P(R.mesh(box(0.012, 0.14, 0.55)), M.trans(4.19, 0.5, 0), { mode: 0, albedo: [0.85, 0.85, 0.8], rough: 0.5, shadow: false });
    P(R.mesh(box(0.012, 0.14, 0.55)), M.trans(-4.47, 0.62, 0), { mode: 0, albedo: [0.85, 0.82, 0.55], rough: 0.5, shadow: false });
    // rear door seam
    P(R.mesh(box(0.012, 2.4, 0.01)), M.trans(-4.33, 2.1, 0), { mode: 0, albedo: [0.02, 0.02, 0.02], rough: 0.6, shadow: false });
    // marker lamps along cargo top
    for (let i = -2; i <= 2; i++) P(R.mesh(box(0.06, 0.04, 0.06)), M.trans(-1.35 + i * 0.9, 3.36, 0.0), { mode: 7, albedo: [0.3, 0.15, 0.02], emis: [0, 0, 0], shadow: false }, { role: 'marker' });
    return { parts, dims: { L: 8.5, W: 2.5, cx: -0.2, front: 4.05, rear: -4.45, headY: 0.95, headZ: 0.85, tailY: 1.15 }, kind: 'truck', R: R0 };
}

function buildCyclist() {
    const parts = [], Rw = 0.34;
    const P = (mesh, local, mat, extra) => parts.push(Object.assign({ mesh, local: local || M.ident(), mat }, extra || {}));
    // wheel
    const wg = new G();
    const circ = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; circ.push([Math.cos(a) * (Rw - 0.03), Math.sin(a) * (Rw - 0.03), 0]); }
    const tireG = tube(circ, 0.03, 8, 0);
    const rimC = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * Math.PI * 2; rimC.push([Math.cos(a) * (Rw - 0.058), Math.sin(a) * (Rw - 0.058), 0]); }
    const rimG = tube(rimC, 0.012, 6, 0);
    const sp = new G();
    for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        sp.add(box(0.006, Rw - 0.06, 0.006), M.mul(M.rotZ(a - Math.PI / 2), M.trans(0, (Rw - 0.06) / 2 + 0.01, (i % 2 ? 0.012 : -0.012))));
    }
    sp.add(cylinder(0.025, 0.025, 0.1, 10), M.rotX(Math.PI / 2));
    const tireM = R.mesh(tireG), rimM = R.mesh(rimG), spM = R.mesh(sp.finish());
    for (const wx of [0.55, -0.55]) {
        const dyn = v => M.mul(M.trans(wx, Rw, 0), M.rotZ(-v.dist / Rw));
        P(tireM, null, { mode: 8, shadow: true }, { dyn });
        P(rimM, null, { mode: 0, albedo: [0.6, 0.6, 0.62], metal: 1, rough: 0.25, shadow: false }, { dyn });
        P(spM, null, { mode: 0, albedo: [0.6, 0.6, 0.62], metal: 1, rough: 0.35, shadow: false }, { dyn });
    }
    // frame (tubes)
    const frameCol = { mode: 0, albedo: [0.55, 0.04, 0.05], metal: 0.5, rough: 0.28, shadow: true };
    const T = (a, b, r) => R.mesh(tube([a, V.lerp(a, b, 0.5), b], r, 8, 0));
    const BB = [-0.02, 0.30, 0], ST = [-0.12, 0.90, 0], HT0 = [0.44, 0.64, 0], HT1 = [0.47, 0.90, 0], RH = [-0.55, Rw, 0], FH = [0.55, Rw, 0];
    P(T(BB, ST, 0.017), null, frameCol); P(T([-0.10, 0.84, 0], HT1, 0.016), null, frameCol); P(T(BB, HT0, 0.019), null, frameCol);
    P(T(BB, RH, 0.012), null, frameCol); P(T([-0.11, 0.86, 0], RH, 0.01), null, frameCol); P(T(HT0, HT1, 0.02), null, frameCol);
    for (const z of [0.05, -0.05]) { P(T([0.46, 0.68, z * 0.2], [FH[0], FH[1], z], 0.013), null, frameCol); }
    P(T([-0.55, Rw, 0.05], [-0.15, 0.86, 0], 0.008), null, frameCol);
    P(R.mesh(box(0.27, 0.05, 0.14)), M.trans(-0.14, 0.98, 0), { mode: 0, albedo: [0.02, 0.02, 0.02], rough: 0.6, shadow: true });
    P(T([-0.12, 0.90, 0], [-0.14, 0.96, 0], 0.012), null, { mode: 0, albedo: [0.7, 0.7, 0.72], metal: 1, rough: 0.3, shadow: false });
    P(T([0.47, 0.88, 0], [0.50, 1.02, 0], 0.014), null, { mode: 0, albedo: [0.02, 0.02, 0.02], rough: 0.5, shadow: false });
    P(R.mesh(tube([[0.5, 1.02, -0.22], [0.5, 1.02, 0.22]], 0.012, 8, 0)), null, { mode: 0, albedo: [0.02, 0.02, 0.02], rough: 0.5, shadow: false });
    P(R.mesh(cylinder(0.09, 0.09, 0.012, 24)), M.mul(M.trans(0, 0.30, 0.06), M.rotX(Math.PI / 2)), { mode: 0, albedo: [0.7, 0.7, 0.72], metal: 1, rough: 0.35, shadow: false }, { dyn: v => M.mul(M.trans(-0.02, 0.30, 0.06), M.mul(M.rotZ(-v.dist / Rw * 0.45), M.rotX(Math.PI / 2))) });
    // lights
    P(R.mesh(box(0.06, 0.04, 0.05)), M.trans(0.50, 1.07, 0), { mode: 7, albedo: [0.1, 0.1, 0.1], emis: [0, 0, 0], shadow: false }, { role: 'head', k: 1 });
    P(R.mesh(box(0.04, 0.05, 0.07)), M.trans(-0.27, 0.86, 0), { mode: 7, albedo: [0.1, 0.01, 0.01], emis: [0, 0, 0], shadow: false }, { role: 'tail', k: 1 });
    // rider
    const skin = hex(0xb07a5a), jacket = hex(0xf26a1b), tights = hex(0x15171c), helmet = hex(0xf2f2f2), shoe = hex(0x101010);
    const hip = [-0.13, 0.99, 0], sh = [0.24, 1.38, 0];
    const torsoLen = V.len(V.sub(sh, hip));
    const torso = R.mesh(capsule(0.14, 0.165, torsoLen, 14));
    P(torso, M.alignY(hip, sh, 1, false), { mode: 0, albedo: jacket, rough: 0.6, shadow: true });
    P(R.mesh(sphere(0.095, 16, 12)), M.trans(0.34, 1.60, 0), { mode: 0, albedo: skin, rough: 0.6, shadow: true });
    P(R.mesh(ellipsoid(0.135, 0.095, 0.115)), M.trans(0.33, 1.65, 0), { mode: 0, albedo: helmet, rough: 0.35, shadow: true });
    P(R.mesh(box(0.14, 0.012, 0.06)), M.trans(0.44, 1.65, 0), { mode: 0, albedo: [0.02, 0.02, 0.02], rough: 0.4, shadow: false });
    const thigh = R.mesh(capsule(0.075, 0.058, 0.43, 10)), shin = R.mesh(capsule(0.052, 0.04, 0.43, 10));
    const upA = R.mesh(capsule(0.048, 0.04, 0.30, 10)), foA = R.mesh(capsule(0.04, 0.034, 0.28, 10));
    const foot = R.mesh(box(0.2, 0.06, 0.09)), crank = R.mesh(box(0.17, 0.02, 0.02)), hand = R.mesh(sphere(0.04, 8, 6));
    const legState = {};
    for (const sd of [1, -1]) {
        const ph = sd > 0 ? 0 : Math.PI;
        const solve = v => {
            const th = v.dist / Rw * 0.45 + ph;
            const ped = [-0.02 + 0.17 * Math.cos(th), 0.30 + 0.17 * Math.sin(th)];
            const h2 = [hip[0], hip[1]];
            let dx = ped[0] - h2[0], dy = ped[1] - h2[1], d = Math.hypot(dx, dy);
            const a = 0.43, b = 0.43; d = Math.min(d, a + b - 0.005);
            const ca = (a * a + d * d - b * b) / (2 * a * d), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
            const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
            const kx = h2[0] + ux * a * ca + (-uy) * a * sa * -1 * -1, ky = h2[1] + uy * a * ca + ux * a * sa * -1 * -1;
            // knee in front (+x): pick perpendicular with positive x
            let px = -uy, py = ux; if (px < 0) { px = -px; py = -py; }
            const knee = [h2[0] + ux * a * ca + px * a * sa, h2[1] + uy * a * ca + py * a * sa];
            return { ped, knee, z: sd * 0.17 };
        };
        const hipP = v => [hip[0], hip[1], sd * 0.10];
        P(thigh, null, { mode: 0, albedo: tights, rough: 0.7, shadow: true }, { dyn: v => { const s = solve(v); return M.alignY(hipP(v), [s.knee[0], s.knee[1], s.z * 0.85], 1, false); } });
        P(shin, null, { mode: 0, albedo: tights, rough: 0.7, shadow: true }, { dyn: v => { const s = solve(v); return M.alignY([s.knee[0], s.knee[1], s.z * 0.85], [s.ped[0] - 0.02, s.ped[1] + 0.05, s.z], 1, false); } });
        P(foot, null, { mode: 0, albedo: shoe, rough: 0.6, shadow: false }, { dyn: v => { const s = solve(v); return M.trans(s.ped[0] + 0.03, s.ped[1] + 0.03, s.z); } });
        P(crank, null, { mode: 0, albedo: [0.7, 0.7, 0.72], metal: 1, rough: 0.35, shadow: false }, { dyn: v => { const s = solve(v); const th = v.dist / Rw * 0.45 + ph; return M.mul(M.trans((s.ped[0] - 0.02) / 2 - 0.01, (s.ped[1] + 0.3) / 2, s.z), M.rotZ(th)); } });
        // arms
        const shoulder = [0.22, 1.37, sd * 0.19], handP = [0.5, 1.03, sd * 0.21];
        const sx = shoulder, hx = handP;
        let dx = hx[0] - sx[0], dy = hx[1] - sx[1], dz = hx[2] - sx[2];
        const dd = Math.min(Math.hypot(dx, dy, dz), 0.575), a = 0.30, b = 0.28;
        const ca = (a * a + dd * dd - b * b) / (2 * a * dd), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
        const u = V.norm([dx, dy, dz]); let perp = V.norm(V.cross(u, [0, 0, sd])); if (perp[1] > 0) perp = V.mul(perp, -1);
        perp = V.norm(V.add(perp, [0, -0.3, sd * 0.9]));
        const elbow = V.add(V.add(sx, V.mul(u, a * ca)), V.mul(perp, a * sa));
        P(upA, M.alignY(sx, elbow, 1, false), { mode: 0, albedo: jacket, rough: 0.6, shadow: true });
        P(foA, M.alignY(elbow, hx, 1, false), { mode: 0, albedo: jacket, rough: 0.6, shadow: true });
        P(hand, M.trans(hx[0], hx[1], hx[2]), { mode: 0, albedo: skin, rough: 0.6, shadow: false });
    }
    // reflective strips on jacket back
    P(R.mesh(box(0.05, 0.04, 0.34)), M.trans(0.08, 1.25, 0), { mode: 0, albedo: [0.7, 0.7, 0.65], metal: 0.4, rough: 0.35, shadow: false });
    return { parts, dims: { L: 1.8, W: 0.6, cx: 0, front: 0.9, rear: -0.9, headY: 1.07, headZ: 0, tailY: 0.86 }, kind: 'cyclist', R: Rw };
}

/* --------------------------- static scene --------------------------- */
let R = null;            // renderer
const S = {
    items: [], vehicles: [], cones: [], poles: [], cam: null, goal: null, host: null, canvas: null,
    env: null, envT: null, time: 0, ready: false, atmo: 'auto', ambient: 100, preset: 'street', follow: null, lastInteract: 0, auto: false
};
const itm = (mesh, model, mat) => { const o = { mesh, model, mat: Object.assign({ shadow: true }, mat), visible: true }; S.items.push(o); return o; };

function buildStatic() {
    // ---- road & ground ----
    itm(R.mesh(plane(1000, 8)), M.ident(), { mode: 1, noRefl: true, shadow: false, albedo: [0.05, 0.05, 0.055] });
    itm(R.mesh(plane(3000, 3000)), M.trans(0, -0.06, 0), { mode: 2, noRefl: true, shadow: false, albedo: [0.05, 0.05, 0.05] });
    for (const sd of [1, -1]) {
        itm(R.mesh(box(1000, 0.16, 4.0)), M.trans(0, 0.08, sd * 6.22), { mode: 2, noRefl: true, albedo: [0.38, 0.37, 0.35], shadow: false });
        itm(R.mesh(box(1000, 0.17, 0.24)), M.trans(0, 0.085, sd * 4.12), { mode: 2, noRefl: true, albedo: [0.5, 0.5, 0.48], shadow: false });
        itm(R.mesh(plane(1000, 3.4)), M.trans(0, 0.1, sd * 9.9), { mode: 4, noRefl: true, shadow: false });
        itm(R.mesh(box(1000, 0.12, 0.14)), M.trans(0, 0.06, sd * 8.3), { mode: 2, noRefl: true, albedo: [0.45, 0.44, 0.42], shadow: false });
    }
    // ---- buildings ----
    const bg = new G();
    for (const sd of [1, -1]) {
        for (let row = 0; row < 3; row++) {
            let x = -520 + rr(0, 10);
            while (x < 520) {
                const w = rr(14, 34), d = rr(16, 26), tall = row === 0 ? rr(10, 32) : row === 1 ? rr(22, 60) : rr(40, 120);
                const z = sd * (row === 0 ? rr(12.2, 13.8) : row === 1 ? 12.2 + 28 + rr(0, 6) : 12.2 + 66 + rr(0, 14)) + sd * d / 2;
                const sid = Math.floor(rr(1, 999));
                bg.add(box(w, tall, d), M.trans(x + w / 2, tall / 2, z), sid);
                x += w + (row === 0 ? rr(2, 6) : rr(3, 10));
            }
        }
    }
    itm(R.mesh(bg), M.ident(), { mode: 3, noRefl: false, albedo: [1, 1, 1] });

    // ---- trees ----
    const trunkG = new G(), leafG = new G();
    const blob = (r, cx, cy, cz, tone) => {
        const g = sphere(1, 14, 10, tone);
        for (let k = 0; k < g.vc; k++) {
            let x = g.p[k * 3], y = g.p[k * 3 + 1], z = g.p[k * 3 + 2];
            const n = 0.78 + 0.5 * Math.abs(Math.sin(x * 5.3 + y * 3.1) * Math.cos(z * 4.7 + y * 2.3)) + 0.12 * Math.sin(x * 11 + z * 9);
            g.p[k * 3] = cx + x * r * n; g.p[k * 3 + 1] = cy + y * r * n * 0.82; g.p[k * 3 + 2] = cz + z * r * n;
            const l = Math.hypot(x, y, z) || 1; g.n[k * 3] = x / l; g.n[k * 3 + 1] = y / l; g.n[k * 3 + 2] = z / l;
        }
        leafG.add(g);
    };
    for (const sd of [1, -1]) for (let i = -9; i <= 9; i++) {
        const x = i * SPACING + SPACING * 0.5 + rr(-2, 2), z = sd * rr(9.3, 10.4);
        if (Math.abs(x) < 5) continue;
        const h = rr(3.0, 4.0), sc = rr(0.85, 1.2);
        trunkG.add(lathe([[0, h, 1], [0.07, h, 1], [0.12, h * 0.5], [0.22, 0.4], [0.3, 0.0, 1], [0, 0, 1]], 10), M.trans(x, 0.1, z));
        for (let b = 0; b < 8; b++) {
            const a = rnd() * 6.28, rd = rnd() * 1.5 * sc;
            blob(rr(1.1, 1.9) * sc, x + Math.cos(a) * rd, h + 0.8 + rnd() * 3.2 * sc, z + Math.sin(a) * rd, rnd());
        }
        blob(2.0 * sc, x, h + 2.3 * sc, z, rnd());
    }
    itm(R.mesh(trunkG.finish()), M.ident(), { mode: 0, albedo: [0.07, 0.05, 0.04], rough: 0.95 });
    itm(R.mesh(leafG), M.ident(), { mode: 5, twoSided: true });

    // ---- street furniture ----
    const benchWood = new G(), benchMetal = new G();
    benchWood.add(box(1.7, 0.05, 0.22), M.trans(0, 0.45, 0.12)); benchWood.add(box(1.7, 0.05, 0.22), M.trans(0, 0.45, -0.12));
    benchWood.add(box(1.7, 0.18, 0.04), M.mul(M.trans(0, 0.72, -0.22), M.rotX(-0.18)));
    for (const x of [-0.75, 0.75]) benchMetal.add(box(0.05, 0.45, 0.5), M.trans(x, 0.225, 0));
    const bw = R.mesh(benchWood.finish()), bm = R.mesh(benchMetal.finish());
    for (const [x, sd] of [[-31, 1], [47, -1], [-69, -1], [22, 1]]) {
        const mdl = M.mul(M.trans(x, 0.16, sd * 7.5), M.rotY(sd > 0 ? Math.PI : 0));
        itm(bw, mdl, { mode: 0, albedo: [0.2, 0.1, 0.05], rough: 0.7 });
        itm(bm, mdl, { mode: 0, albedo: [0.03, 0.03, 0.035], metal: 0.8, rough: 0.4 });
    }
    const bin = R.mesh(lathe([[0.0, 0.9, 1], [0.24, 0.9, 1], [0.26, 0.85], [0.23, 0.0], [0.0, 0.0, 1]], 18));
    for (const [x, sd] of [[-33.5, 1], [49.5, -1], [24.5, 1], [-6, -1], [8, 1]]) itm(bin, M.trans(x, 0.16, sd * 7.9), { mode: 0, albedo: [0.04, 0.14, 0.09], metal: 0.5, rough: 0.5 });
    const hyd = R.mesh(lathe([[0, 0.72, 1], [0.07, 0.72, 1], [0.1, 0.65], [0.09, 0.5], [0.12, 0.2], [0.14, 0.0, 1], [0, 0, 1]], 14));
    for (const [x, sd] of [[-15, 1], [37.5, -1]]) itm(hyd, M.trans(x, 0.16, sd * 7.9), { mode: 0, albedo: [0.55, 0.03, 0.02], metal: 0.4, rough: 0.35 });
    // crosswalk signs
    const signPole = R.mesh(cylinder(0.04, 0.04, 2.6, 8));
    const signBoard = new G(); signBoard.add(box(0.6, 0.6, 0.03), M.trans(0, 0, 0));
    const sb = R.mesh(signBoard.finish());
    const sw = R.mesh(box(0.42, 0.42, 0.034));
    for (const [x, sd] of [[-3.4, 1], [3.4, -1]]) {
        itm(signPole, M.trans(x, 1.46, sd * 7.1), { mode: 0, albedo: [0.4, 0.4, 0.42], metal: 0.9, rough: 0.4 });
        itm(sb, M.mul(M.trans(x, 2.9, sd * 7.1), M.rotY(sd > 0 ? 0 : Math.PI)), { mode: 0, albedo: [0.02, 0.18, 0.7], rough: 0.4, metal: 0.3 });
        itm(sw, M.mul(M.trans(x, 2.9, sd * 7.1 + sd * 0.002), M.rotY(sd > 0 ? 0 : Math.PI)), { mode: 0, albedo: [0.9, 0.9, 0.9], rough: 0.4, emis: [0, 0, 0] });
    }
    // bollards
    const bol = R.mesh(lathe([[0, 0.8, 1], [0.05, 0.8, 1], [0.06, 0.78], [0.06, 0.0, 1], [0, 0, 1]], 10));
    for (const sd of [1, -1]) for (let i = 0; i < 6; i++) itm(bol, M.trans(-6 + i * 2.4, 0.16, sd * 4.55), { mode: 0, albedo: [0.7, 0.55, 0.05], rough: 0.5, metal: 0.3 });

    // ---- streetlights ----
    buildPoles();
}

function buildPoles() {
    const poleG = new G(), headG = new G();
    // base + shaft
    poleG.add(lathe([[0, 0.55, 1], [0.11, 0.55, 1], [0.135, 0.5], [0.2, 0.08], [0.23, 0.07, 1], [0.23, 0, 1], [0, 0, 1]], 20), M.trans(0, 0.16, 0));
    poleG.add(lathe([[0, 8.2, 1], [0.062, 8.2, 1], [0.07, 7.9], [0.095, 3.0], [0.135, 0.5, 1], [0, 0.5, 1]], 18), M.trans(0, 0.16, 0));
    poleG.add(box(0.15, 0.55, 0.03), M.trans(0, 1.6, 0.12));
    // arm
    const path = [];
    for (let i = 0; i <= 28; i++) { const t = i / 28; path.push([0, 8.3 + 1.0 * (1 - Math.pow(1 - t, 2.2)), -ARM * Math.pow(t, 1.35)]); }
    poleG.add(tube(path, t => lerp(0.062, 0.036, t), 10, 0));
    poleG.add(tube([[0, 7.3, 0], [0, 8.0, -0.6], [0, 8.75, -ARM * 0.46]], 0.018, 6, 0));
    // luminaire housing: superellipse loft along Z
    const sec = 16, ringN = 24, hl = 0.55, hwid = 0.2, htop = 0.085, hbot = 0.03, e = 2.8;
    const pos = [];
    for (let s = 0; s <= sec; s++) {
        const u = s / sec * 2 - 1, tap = Math.pow(Math.max(1 - Math.pow(Math.abs(u), 4.5), 0), 0.42);
        const wmul = tap * (u < 0 ? 1 : 1 - 0.22 * u * u), z = u * hl;
        const ring = [];
        for (let k = 0; k < ringN; k++) {
            const a = k / ringN * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
            const x = hwid * wmul * Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
            const y = (sn > 0 ? htop : hbot) * tap * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / e) + (sn > 0 ? 0.0 : 0);
            ring.push([x, y, z]);
        }
        pos.push(ring);
    }
    const hg = new G();
    for (let s = 0; s < sec; s++) for (let k = 0; k < ringN; k++) {
        const k1 = (k + 1) % ringN;
        const a = pos[s][k], b = pos[s][k1], c = pos[s + 1][k1], d = pos[s + 1][k];
        const n = V.norm(V.cross(V.sub(b, a), V.sub(d, a)));
        const o = hg.vc;
        [a, b, c, d].forEach((p, i) => {
            // approx normal: radial in xy
            const nn = V.norm([p[0] / (hwid + 1e-3), p[1] / (p[1] > 0 ? htop : hbot), (p[2] / hl) * 0.15]);
            hg.v(p[0], p[1], p[2], nn[0], nn[1], nn[2], 0, 0, 0);
        });
        hg.q(o, o + 1, o + 2, o + 3);
    }
    headG.add(hg.finish());
    // cooling fins + photocell + PIR dome + sensor housing
    for (let i = -4; i <= 4; i++) headG.add(box(0.26, 0.012, 0.018), M.trans(0, htop - 0.006, i * 0.085));
    headG.add(cylinder(0.034, 0.034, 0.05, 12), M.trans(0, htop + 0.02, 0.12));
    headG.add(sphere(0.055, 14, 10), M.mul(M.trans(0, -0.065, 0.31), M.scale(1, 0.8, 1)));
    headG.add(box(0.1, 0.03, 0.1), M.trans(0, -0.04, 0.31));
    // mount bracket
    headG.add(cylinder(0.04, 0.04, 0.14, 10), M.mul(M.trans(0, 0.0, -hl - 0.0), M.rotX(Math.PI / 2)));
    const poleM = R.mesh(poleG.finish()), headM = R.mesh(headG.finish());
    const lensM = R.mesh(box(0.34, 0.01, 0.78)), ledM = R.mesh(sphere(0.022, 8, 6));
    const coneM = R.mesh(lathe([[0, 0, 1], [1, -1, 1]], 28));
    S.coneMesh = coneM;
    for (let i = 0; i < POLES; i++) {
        const sd = poleSide(i), x = poleX(i);
        const base = M.mul(M.trans(x, 0, sd * POLE_Z), M.rotY(sd > 0 ? 0 : Math.PI));
        itm(poleM, base, { mode: 9, albedo: [0.075, 0.08, 0.085], metal: 0.55, rough: 0.5 });
        const hc = [0, LAMP_Y - 0.02 + 0.02, -ARM - 0.18];
        const hloc = M.mul(base, M.mul(M.trans(0, 9.33, -ARM - 0.2), M.rotX(0.035)));
        itm(headM, hloc, { mode: 9, albedo: [0.5, 0.52, 0.55], metal: 0.65, rough: 0.38 });
        const lens = itm(lensM, M.mul(hloc, M.trans(0, -0.036, 0.0)), { mode: 7, albedo: [0.4, 0.4, 0.4], rough: 0.1, emis: [0, 0, 0], shadow: false });
        const led = itm(ledM, M.mul(hloc, M.trans(0, -0.066, 0.352)), { mode: 7, albedo: [0.1, 0.1, 0.1], rough: 0.2, emis: [0, 0, 0], shadow: false });
        const wp = [x, LAMP_Y + 0.0, sd * (POLE_Z - ARM - 0.2)];
        S.poles.push({ i, x, side: sd, pos: wp, lens, led, level: 0, target: 0, pir: 0, fault: false, motion: false, ledPhase: i * 0.37 });
    }
}

/* ---------------------------- environment ---------------------------- */
const SKY = [ // elevation deg, top, horizon  (linear)
    [60, [0.10, 0.27, 0.62], [0.50, 0.66, 0.86]], [25, [0.13, 0.30, 0.64], [0.62, 0.72, 0.86]],
    [10, [0.16, 0.27, 0.52], [0.90, 0.68, 0.48]], [1, [0.10, 0.15, 0.34], [0.95, 0.42, 0.20]],
    [-5, [0.03, 0.05, 0.16], [0.40, 0.19, 0.22]], [-12, [0.012, 0.022, 0.07], [0.10, 0.10, 0.18]],
    [-30, [0.004, 0.008, 0.026], [0.025, 0.035, 0.07]]
];
function skyAt(e) {
    for (let i = 0; i < SKY.length - 1; i++) {
        const a = SKY[i], b = SKY[i + 1];
        if (e <= a[0] && e >= b[0]) { const t = (a[0] - e) / (a[0] - b[0]); return [lerp3(a[1], b[1], t), lerp3(a[2], b[2], t)]; }
    }
    return e > SKY[0][0] ? [SKY[0][1], SKY[0][2]] : [SKY[SKY.length - 1][1], SKY[SKY.length - 1][2]];
}
function elevationFor(a) { // ambient 0..1 -> sun elevation deg
    const T = [[1, 62], [0.75, 36], [0.55, 10], [0.45, -1.5], [0.3, -9], [0.15, -17], [0, -30]];
    for (let i = 0; i < T.length - 1; i++) {
        if (a <= T[i][0] && a >= T[i + 1][0]) return lerp(T[i][1], T[i + 1][1], (T[i][0] - a) / (T[i][0] - T[i + 1][0]));
    }
    return a > 1 ? 62 : -30;
}
function computeEnv(ambient, atmo) {
    const a = clamp(ambient / 100, 0, 1);
    let e = elevationFor(a);
    const az = rad(52);
    const sunDir = V.norm([Math.cos(rad(e)) * Math.cos(az), Math.sin(rad(e)), Math.cos(rad(e)) * Math.sin(az)]);
    const maz = rad(212), mel = rad(40);
    const moonDir = V.norm([Math.cos(mel) * Math.cos(maz), Math.sin(mel), Math.cos(mel) * Math.sin(maz)]);
    const dayK = sstep(-6, 12, e), nightK = 1 - sstep(-14, 0, e);
    const [top, hor] = skyAt(e);
    const fog = atmo === 'fog' ? 1 : 0;
    const sunI = 3.3 * sstep(-3, 14, e);
    const sunC = lerp3([1.0, 0.55, 0.28], [1.0, 0.96, 0.88], sstep(3, 32, e));
    const sunCol = V.mul(sunC, sunI);
    const moonI = 0.42 * nightK;
    const moonCol = V.mul([0.5, 0.62, 1.0], moonI);
    const keyW = sunI + moonI + 1e-4;
    const keyDir = V.norm(V.add(V.mul(sunDir, sunI), V.mul(moonDir, moonI)));
    const keyCol = V.add(sunCol, moonCol);
    let skyTop = top, skyHor = hor;
    let fogCol = lerp3(hor, [0.55, 0.56, 0.6], 0.15);
    const fogDen = fog ? 0.0125 : lerp(0.0026, 0.0018, dayK);
    if (fog) {
        const fc = lerp3([0.085, 0.09, 0.11], [0.6, 0.62, 0.66], dayK);
        fogCol = lerp3(fc, hor, 0.1);
        skyTop = lerp3(top, fogCol, 0.75); skyHor = lerp3(hor, fogCol, 0.9);
    }
    return {
        sunDir, sunCol: V.mul(sunC, sunI * 0.5), moonDir, moonCol: V.mul(moonCol, 0.5), keyDir, keyCol,
        skyTop, skyHor, fogCol, fogDen,
        gnd: V.add(V.mul([0.20, 0.19, 0.17], dayK * (0.2 + 0.8 * sstep(-2, 30, e))), [0.004, 0.0045, 0.007]),
        ambMin: V.mul([0.012, 0.014, 0.024], nightK * (fog ? 1.8 : 1)),
        ambI: 1.0, envI: 1.0, night: sstep(5, -7, e), starNight: sstep(-6, -14, e) * (fog ? 0.15 : 1),
        wet: fog ? 0.9 : lerp(0.58, 0.14, dayK),
        cloud: fog ? 0.95 : lerp(0.35, 0.5, dayK),
        exposure: lerp(1.75, 0.92, dayK) * (fog ? 1.15 : 1),
        bloom: lerp(0.34, 0.1, dayK) * (fog ? 1.6 : 1), bloomThr: lerp(0.85, 2.4, dayK),
        shadowOn: 1, elev: e, dayK, nightK, fogAmt: fog
    };
}
function mixEnv(c, t, k) {
    if (!c) return JSON.parse(JSON.stringify(t));
    const o = {};
    for (const key in t) {
        const a = c[key], b = t[key];
        if (Array.isArray(b)) o[key] = [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
        else o[key] = lerp(a, b, k);
    }
    // direction vectors must be re-normalised
    ['sunDir', 'moonDir', 'keyDir'].forEach(n => { o[n] = V.norm(o[n]); });
    return o;
}

/* ----------------------------- vehicles ----------------------------- */
const PAINTS = [
    hex(0xe9eaec), hex(0x1b1d22), hex(0x0f2a66), hex(0x8e1017), hex(0x8b9096), hex(0x0f3a2a), hex(0xc4561a), hex(0x2e5a8c), hex(0x5a1f3a)
];
function getModel(type) {
    if (!MODELS[type]) MODELS[type] = type === 'truck' ? buildTruck() : type === 'cyclist' ? buildCyclist() : buildCar(type);
    return MODELS[type];
}
const blobMesh = () => S._blob || (S._blob = R.mesh(plane(1, 1, 0)));

function launch(type, opts = {}) {
    if (!S.ready) return null;
    let model = type === 'truck' ? 'truck' : (type === 'pedestrian' || type === 'cyclist') ? 'cyclist' : (rnd() > 0.45 ? 'sedan' : 'suv');
    if (type === 'car' && opts.model) model = opts.model;
    const M0 = getModel(model);
    const dir = opts.reverse ? -1 : 1;
    const duration = opts.duration || 9;
    let speed = 200 / duration; // metres per second across the pole span
    if (model === 'truck') speed *= 0.78; if (model === 'cyclist') speed *= 0.3;
    const lane = model === 'cyclist' ? 3.2 : LANE_Z;
    const z = -dir * lane;                // keep-left traffic
    const paint = model === 'truck' ? hex(0xf0f0f2) : (opts.paint || PAINTS[Math.floor(rnd() * PAINTS.length)]);
    const accent = PAINTS[2 + Math.floor(rnd() * 4)];
    const v = {
        type: model, x: -dir * 215, z, dir, speed, dist: 0, parts: [], items: [], id: ++S.vid, model: M0, light: 0, paint,
        spawned: S.time
    };
    for (const p of M0.parts) {
        const mat = Object.assign({}, p.mat);
        if (p.role === 'paint') mat.albedo = paint;
        if (p.role === 'accent') mat.albedo = accent;
        if (model === 'truck' && p.role === 'paint') mat.albedo = hex(0xe9ecef);
        const item = { mesh: p.mesh, model: M.ident(), mat, visible: true };
        v.parts.push({ p, item }); v.items.push(item);
    }
    v.blob = { mesh: blobMesh(), model: M.ident(), mat: { mode: 20, alpha: 0.6, shadow: false }, visible: true };
    v.items.push(v.blob);
    S.vehicles.push(v);
    while (S.vehicles.length > 6) S.vehicles.shift();
    if (S.preset === 'chase') S.follow = v;
    return v.id;
}
S.vid = 0;

function updateVehicles(dt) {
    const env = S.env;
    const lightsOn = clamp(env.nightK * 1.1 + env.fogAmt, 0, 1);
    for (let i = S.vehicles.length - 1; i >= 0; i--) {
        const v = S.vehicles[i];
        v.x += v.dir * v.speed * dt; v.dist += v.speed * dt;
        if (Math.abs(v.x) > 222) { S.vehicles.splice(i, 1); if (S.follow === v) S.follow = null; continue; }
        v.light += (lightsOn - v.light) * Math.min(1, dt * 6);
        const bob = Math.sin(S.time * 7 + v.id) * 0.002;
        const yaw = v.dir > 0 ? 0 : Math.PI;
        const base = M.mul(M.trans(v.x, bob, v.z), M.rotY(yaw));
        for (const { p, item } of v.parts) {
            const local = p.dyn ? p.dyn(v) : p.local;
            item.model = M.mul(base, local);
            if (p.role === 'head') {
                const e = (v.light * 4.2 + (1 - v.light) * 0.28) * p.k;
                item.mat.emis = [e, e * 0.96, e * 0.88];
            } else if (p.role === 'tail') {
                const e = (0.5 + v.light * 1.7) * p.k;
                item.mat.emis = [e * 1.0, e * 0.06, e * 0.03];
            } else if (p.role === 'marker') {
                const e = 0.2 + v.light * 0.8; item.mat.emis = [e, e * 0.45, 0.02];
            }
        }
        const d = v.model.dims;
        v.blob.model = M.mul(base, M.mul(M.trans(d.cx, 0.012, 0), M.scale(d.L * 1.06, 1, d.W * 1.2)));
        v.blob.mat.alpha = lerp(0.5, 0.7, env.nightK);
    }
}

/* ------------------------------ camera ------------------------------ */
const PRESETS = {
    street: { eye: [114, 2.35, 3.1], target: [-60, 4.2, -1.2], fov: 38 },
    overview: { eye: [44, 33, 52], target: [4, 2, -2], fov: 38 },
    profile: { eye: [-6, 3.6, 19], target: [-4, 3.3, 0], fov: 40 },
    hero: { eye: [98, 3.4, 4.2], target: [-30, 5.6, -1.5], fov: 33 },
    chase: { eye: [0, 3, 8], target: [0, 1, 0], fov: 46 }
};
function setPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    S.preset = name; S.follow = null;
    S.goal = { eye: p.eye.slice(), target: p.target.slice(), fov: p.fov };
    S.auto = (name === 'hero');
    if (name === 'chase') S.follow = S.vehicles[S.vehicles.length - 1] || null;
    document.querySelectorAll('[data-cam]').forEach(b => b.classList.toggle('active', b.dataset.cam === name));
}
function updateCamera(dt) {
    const g = S.goal, c = S.cam;
    if (S.preset === 'chase') {
        const v = S.follow && S.vehicles.includes(S.follow) ? S.follow : (S.vehicles[S.vehicles.length - 1] || null);
        if (v) {
            const d = v.dir, back = (v.type === 'truck' ? 15 : v.type === 'cyclist' ? 5 : 9.5);
            g.eye = [v.x - d * back, v.type === 'truck' ? 4.8 : 2.7, v.z + (v.z > 0 ? 3.4 : -3.4) * 0.8 + (S.userYaw || 0)];
            g.target = [v.x + d * 7, 1.1, v.z * 0.6];
        }
    }
    const k = 1 - Math.exp(-dt * (S.preset === 'chase' ? 5.5 : 2.4));
    for (let i = 0; i < 3; i++) { c.eye[i] += (g.eye[i] - c.eye[i]) * k; c.target[i] += (g.target[i] - c.target[i]) * k; }
    c.fov += (g.fov - c.fov) * k;
}
function bindInput(canvas) {
    let drag = null;
    canvas.style.touchAction = 'pan-y';
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; });
    canvas.addEventListener('pointerup', e => { drag = null; canvas.style.cursor = 'grab'; });
    canvas.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
        S.lastInteract = S.time; S.auto = false;
        const g = S.goal, off = V.sub(g.eye, g.target), d = V.len(off);
        let yaw = Math.atan2(off[0], off[2]) - dx * 0.0052;
        let pit = Math.asin(clamp(off[1] / d, -1, 1)) + dy * 0.0042;
        pit = clamp(pit, rad(1.5), rad(80));
        g.eye = [g.target[0] + d * Math.cos(pit) * Math.sin(yaw), g.target[1] + d * Math.sin(pit), g.target[2] + d * Math.cos(pit) * Math.cos(yaw)];
        S.cam.eye = g.eye.slice(); // immediate response while dragging
    });
    canvas.addEventListener('wheel', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const g = S.goal, off = V.sub(g.eye, g.target), d = clamp(V.len(off) * (1 + e.deltaY * 0.0016), 4, 220);
        const n = V.norm(off); g.eye = V.add(g.target, V.mul(n, d));
        S.lastInteract = S.time; S.auto = false;
    }, { passive: false });
    canvas.style.cursor = 'grab';
}
global.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-cam]');
    if (b) setPreset(b.dataset.cam);
    const z = e.target.closest && e.target.closest('[data-cam-zoom]');
    if (z && S.goal) {
        const g = S.goal, off = V.sub(g.eye, g.target), d = clamp(V.len(off) * (z.dataset.camZoom === 'in' ? 0.78 : 1.28), 4, 220);
        g.eye = V.add(g.target, V.mul(V.norm(off), d)); S.auto = false;
    }
});

/* ------------------------------ frame ------------------------------ */
function frameLights() {
    const L0 = new Float32Array(MAXL * 4), L1 = new Float32Array(MAXL * 4), L2 = new Float32Array(MAXL * 4);
    let n = 0;
    const warm = [1.0, 0.86, 0.66];
    for (const p of S.poles) {
        if (p.level < 0.004 || n >= MAXL) continue;
        const I = 520 * p.level * (S.env.fogAmt ? 1.15 : 1);
        L0.set([p.pos[0], p.pos[1] - 0.1, p.pos[2], 46], n * 4);
        L1.set([0, -1, p.side * 0.06, 2.3], n * 4);
        L2.set([warm[0] * I, warm[1] * I, warm[2] * I, Math.cos(rad(78))], n * 4);
        n++;
    }
    const lightsOn = S.env.nightK * 1.1 + S.env.fogAmt;
    for (const v of S.vehicles) {
        if (n >= MAXL - 1) break;
        const d = v.model.dims, c = Math.min(v.light, 1);
        if (c < 0.02) continue;
        const f = [v.dir, 0, 0];
        const hp = [v.x + v.dir * (d.front - 0.1), d.headY, v.z];
        const isCyc = v.type === 'cyclist';
        L0.set([hp[0], hp[1], hp[2], isCyc ? 30 : 75], n * 4);
        const fd = V.norm([v.dir, isCyc ? -0.12 : -0.05, 0]);
        L1.set([fd[0], fd[1], fd[2], isCyc ? 12 : 9], n * 4);
        const I = (isCyc ? 120 : 1500) * c;
        L2.set([I, I * 0.96, I * 0.9, Math.cos(rad(isCyc ? 40 : 55))], n * 4);
        n++;
        const tp = [v.x + v.dir * (d.rear - 0.15), d.tailY, v.z];
        L0.set([tp[0], tp[1], tp[2], 8], n * 4);
        L1.set([-v.dir, -0.05, 0, 1.5], n * 4);
        L2.set([14 * c, 0.5 * c, 0.3 * c, Math.cos(rad(80))], n * 4);
        n++;
    }
    return { L0, L1, L2, n };
}
function frameGlowsCones(env) {
    const glows = [], cones = [];
    const fog = env.fogAmt, scat = 0.05 + 0.34 * fog;
    for (const p of S.poles) {
        if (p.level < 0.01) continue;
        const l = p.level;
        const sz = 0.9 + 1.5 * l + 1.8 * fog * l;
        glows.push({ pos: [p.pos[0], p.pos[1] - 0.04, p.pos[2]], size: sz, col: [1.0 * 0.5 * l, 0.82 * 0.5 * l, 0.58 * 0.5 * l], core: 0.4 });
        if (fog > 0.01 || env.nightK > 0.3) glows.push({ pos: [p.pos[0], p.pos[1] - 0.04, p.pos[2]], size: sz * 3.0, col: [0.18 * l * (0.3 + fog * 2.5), 0.14 * l * (0.3 + fog * 2.5), 0.09 * l * (0.3 + fog * 2.5)], core: 0 });
        const R0 = 5.6 + 3.2 * l;
        cones.push({
            mesh: S.coneMesh, model: M.mul(M.trans(p.pos[0], p.pos[1] - 0.05, p.pos[2]), M.scale(R0, p.pos[1] - 0.05, R0)),
            col: [1.0, 0.8, 0.52], int: scat * (0.08 + 0.45 * l * l) * (0.5 + 0.5 * env.nightK)
        });
    }
    for (const v of S.vehicles) {
        const d = v.model.dims, c = Math.min(v.light, 1);
        const isCyc = v.type === 'cyclist';
        for (const sd of isCyc ? [0] : [1, -1]) {
            const hp = [v.x + v.dir * (d.front + 0.02), d.headY, v.z + sd * d.headZ * 0.95];
            glows.push({ pos: hp, size: (isCyc ? 0.5 : 0.85) * (0.3 + c), col: [1.0 * c * 0.9 + 0.1, 0.96 * c * 0.9 + 0.1, 0.85 * c * 0.9 + 0.1].map(x => x * (isCyc ? 0.8 : 1.1)), core: 0.8 });
            const tp = [v.x + v.dir * (d.rear - 0.03), d.tailY, v.z + sd * d.headZ * 0.95];
            glows.push({ pos: tp, size: 0.5 + 0.2 * c, col: [1.2 * (0.4 + c), 0.05 * (0.4 + c), 0.03 * (0.4 + c)], core: 0.5 });
        }
        if (c > 0.05 && !isCyc) {
            const apex = [v.x + v.dir * (d.front - 0.1), d.headY, v.z];
            const len = 38;
            cones.push({
                mesh: S.coneMesh, model: M.alignY(apex, [apex[0] - v.dir * len, apex[1] - 0.6, apex[2]], 5.0, true),
                col: [1.0, 0.95, 0.85], int: c * (0.025 + 0.2 * fog)
            });
        }
    }
    return { glows, cones };
}

function render(dt) {
    const env = S.env;
    updateCamera(dt);
    updateVehicles(dt);
    // poles
    for (const p of S.poles) {
        p.level += (p.target - p.level) * Math.min(1, dt * 7);
        const l = p.level;
        p.lens.mat.emis = [6.5 * l, 5.4 * l, 3.9 * l];
        p.lens.mat.albedo = [0.3 + 0.4 * l, 0.3 + 0.4 * l, 0.3 + 0.3 * l];
        // PIR status LED
        const blink = (Math.sin(S.time * 2.2 + p.ledPhase) > 0.93) ? 1 : 0;
        if (p.fault) p.led.mat.emis = [(Math.sin(S.time * 7) > 0 ? 3.2 : 0.1), 0.05, 0.02];
        else if (p.motion) p.led.mat.emis = [3.4, 0.12, 0.05];
        else if (env.nightK > 0.2 || p.level > 0.05) p.led.mat.emis = [0.05 + 0.1 * blink, 1.4 * blink + 0.12, 0.35 * blink + 0.03];
        else p.led.mat.emis = [0.0, 0.05, 0.02];
    }
    const lt = frameLights();
    const gc = frameGlowsCones(env);
    const cam = S.cam;
    let eye = cam.eye.slice(), target = cam.target.slice();
    if (S.auto) {
        const t = S.time;
        eye = [eye[0] + Math.sin(t * 0.07) * 10, eye[1] + Math.sin(t * 0.11) * 0.25, eye[2] + Math.sin(t * 0.09) * 0.9];
        target = [target[0] + Math.sin(t * 0.05) * 6, target[1], target[2]];
    }
    const dist = V.len(V.sub(eye, target));
    const items = S.items.slice();
    for (const v of S.vehicles) for (const it of v.items) items.push(it);
    const f = {
        cam: { eye, target, fov: rad(cam.fov), near: 0.3, far: 2500 },
        env, time: S.time, items, nLights: lt.n, L0: lt.L0, L1: lt.L1, L2: lt.L2, glows: gc.glows, cones: gc.cones,
        shadowCenter: [target[0], 0, target[2]], shadowSize: clamp(dist * 0.6, 22, 78)
    };
    // when the camera looks far down the street, centre the shadow volume closer to the camera
    if (S.preset === 'street' || S.preset === 'hero') f.shadowCenter = [eye[0] - 28, 0, 0];
    R.render(f);
}

/* ------------------------------ loop ------------------------------ */
let last = 0, raf = 0, ro = null;
function visible() {
    const h = S.host;
    return h && h.isConnected && document.visibilityState === 'visible' && h.clientWidth > 40 && h.clientHeight > 40 && h.offsetParent !== null;
}
function size() {
    const h = S.host; if (!h) return;
    const dpr = Math.min(global.devicePixelRatio || 1, S.maxDpr || 1.5);
    const w = Math.round(h.clientWidth * dpr), ht = Math.round(h.clientHeight * dpr);
    if (S.canvas.width !== w || S.canvas.height !== ht) R.resize(w, ht);
}
function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (!S.ready) return;
    const dt = Math.min((ts - last) / 1000, 0.06); last = ts;
    if (!visible()) return;
    S.time += dt;
    size();
    // environment easing
    S.envT = computeEnv(S.ambient, S.atmo);
    S.env = mixEnv(S.env, S.envT, 1 - Math.exp(-dt * 2.6));
    try { render(dt); } catch (e) { console.error('Scene3D render error', e); cancelAnimationFrame(raf); S.ready = false; }
}

/* ------------------------------ API ------------------------------ */
const API = {
    supported: false,
    init() {
        if (S.ready) return true;
        try {
            const canvas = document.createElement('canvas');
            canvas.className = 'scene3d-canvas';
            R = new Renderer(canvas);
            S.canvas = canvas;
            global.__R = R;
            buildStatic();
            S.cam = { eye: PRESETS.street.eye.slice(), target: PRESETS.street.target.slice(), fov: PRESETS.street.fov };
            S.goal = { eye: PRESETS.street.eye.slice(), target: PRESETS.street.target.slice(), fov: PRESETS.street.fov };
            S.envT = computeEnv(S.ambient, S.atmo); S.env = mixEnv(null, S.envT, 1);
            bindInput(canvas);
            S.ready = true; API.supported = true;
            if (!raf) raf = requestAnimationFrame(loop);
            return true;
        } catch (e) {
            console.warn('Scene3D unavailable:', e);
            API.error = e.message; API.supported = false; return false;
        }
    },
    attach(host, preset) {
        if (!S.ready && !API.init()) {
            if (host && !host.querySelector('.scene3d-fallback')) {
                const d = document.createElement('div'); d.className = 'scene3d-fallback';
                d.textContent = '3D view needs WebGL2 and floating-point render targets. Try a current Chrome, Edge, Firefox or Safari.';
                host.prepend(d);
            }
            return false;
        }
        S.host = host;
        if (host) { host.prepend(S.canvas); if (preset) setPreset(preset); size(); }
        return true;
    },
    setEnvironment(ambient, atmosphere) {
        S.ambient = ambient; S.atmo = atmosphere === 'fog' ? 'fog' : 'auto';
    },
    setPoles(lights, poleCount) {
        if (!S.ready) return;
        const total = lights.length;
        S.poles.forEach((p, i) => {
            const idx = Math.min(Math.floor(i * (total / POLES)), total - 1);
            const l = lights[idx];
            p.fault = !!l.fault; p.motion = !!l.motion;
            p.target = (l.on && !l.fault) ? clamp(l.brightness / 100, 0, 1) : 0;
        });
    },
    launch, setPreset,
    vehicles() { return S.vehicles.map(v => ({ id: v.id, x: v.x, type: v.type, dir: v.dir, pole: v.x / SPACING + (POLES - 1) / 2 })); },
    get poleCount() { return POLES; },
    poleSpacing: SPACING,
    _state: S
};
global.Scene3D = API;
})(window);
