/* =====================================================================
   SmartLux GL3D  -  compact, dependency-free WebGL2 engine
   PBR (GGX) shading, cascaded-style shadow map, planar wet-road
   reflections, MSAA HDR pipeline, bloom, ACES tone-mapping.
===================================================================== */
(function (global) {
'use strict';

const MAXL = 24;
const SHADOW_RES = 2048;

/* ------------------------------ math ------------------------------ */
const V = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: a => Math.hypot(a[0], a[1], a[2]),
    norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
};

const M = {
    ident() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    mul(a, b) {
        const o = new Float32Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            o[c * 4 + r] = s;
        }
        return o;
    },
    persp(fov, asp, n, f) {
        const t = 1 / Math.tan(fov / 2), o = new Float32Array(16);
        o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
        return o;
    },
    ortho(l, r, b, t, n, f) {
        const o = M.ident();
        o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
        o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n);
        return o;
    },
    lookAt(e, c, u) {
        const z = V.norm(V.sub(e, c)), x = V.norm(V.cross(u, z)), y = V.cross(z, x);
        return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -V.dot(x, e), -V.dot(y, e), -V.dot(z, e), 1]);
    },
    trans(x, y, z) { const o = M.ident(); o[12] = x; o[13] = y; o[14] = z; return o; },
    scale(x, y, z) { const o = M.ident(); o[0] = x; o[5] = y; o[10] = z; return o; },
    rotX(a) { const o = M.ident(), c = Math.cos(a), s = Math.sin(a); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; },
    rotY(a) { const o = M.ident(), c = Math.cos(a), s = Math.sin(a); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; },
    rotZ(a) { const o = M.ident(), c = Math.cos(a), s = Math.sin(a); o[0] = c; o[1] = s; o[4] = -s; o[5] = c; return o; },
    // compose  T * Ry * Rx * Rz * S
    trs(p, ry = 0, s = 1, rx = 0, rz = 0) {
        let m = M.trans(p[0], p[1], p[2]);
        if (ry) m = M.mul(m, M.rotY(ry));
        if (rx) m = M.mul(m, M.rotX(rx));
        if (rz) m = M.mul(m, M.rotZ(rz));
        if (s !== 1) m = M.mul(m, Array.isArray(s) ? M.scale(s[0], s[1], s[2]) : M.scale(s, s, s));
        return m;
    },
    // inverse-transpose of upper 3x3 (column-major mat3)
    nmat(m) {
        const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
        const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
        const det = a * A + b * B + c * C || 1;
        const id = 1 / det;
        // cofactor matrix / det == inverse transpose
        return new Float32Array([
            A * id, B * id, C * id,
            -(b * i - c * h) * id, (a * i - c * g) * id, -(a * h - b * g) * id,
            (b * f - c * e) * id, -(a * f - c * d) * id, (a * e - b * d) * id
        ]);
    },
    // matrix mapping local (0,0,0)->p0 and unit +Y -> direction p0->p1 (length preserved when scaleLen)
    alignY(p0, p1, rad = 1, scaleLen = true) {
        const y = V.sub(p1, p0), len = V.len(y), yn = V.mul(y, 1 / (len || 1));
        const t = Math.abs(yn[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
        const x = V.norm(V.cross(t, yn)), z = V.cross(yn, x);
        const yy = scaleLen ? y : yn;
        return new Float32Array([x[0] * rad, x[1] * rad, x[2] * rad, 0, yy[0], yy[1], yy[2], 0,
            z[0] * rad, z[1] * rad, z[2] * rad, 0, p0[0], p0[1], p0[2], 1]);
    }
};

/* --------------------------- geometry ----------------------------- */
class G {
    constructor() { this.p = []; this.n = []; this.u = []; this.m = []; this.i = []; }
    get vc() { return this.p.length / 3; }
    v(x, y, z, nx, ny, nz, u = 0, v = 0, m = 0) {
        this.p.push(x, y, z); this.n.push(nx, ny, nz); this.u.push(u, v); this.m.push(m);
        return this.vc - 1;
    }
    t(a, b, c) { this.i.push(a, b, c); }
    q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
    setMat(m) { this.m.fill(m); return this; }
    add(g, mat, matId) {
        const o = this.vc, nm = mat ? M.nmat(mat) : null;
        for (let k = 0; k < g.vc; k++) {
            let x = g.p[k * 3], y = g.p[k * 3 + 1], z = g.p[k * 3 + 2];
            let nx = g.n[k * 3], ny = g.n[k * 3 + 1], nz = g.n[k * 3 + 2];
            if (mat) {
                const X = mat[0] * x + mat[4] * y + mat[8] * z + mat[12];
                const Y = mat[1] * x + mat[5] * y + mat[9] * z + mat[13];
                const Z = mat[2] * x + mat[6] * y + mat[10] * z + mat[14];
                const NX = nm[0] * nx + nm[3] * ny + nm[6] * nz;
                const NY = nm[1] * nx + nm[4] * ny + nm[7] * nz;
                const NZ = nm[2] * nx + nm[5] * ny + nm[8] * nz;
                const l = Math.hypot(NX, NY, NZ) || 1;
                x = X; y = Y; z = Z; nx = NX / l; ny = NY / l; nz = NZ / l;
            }
            this.p.push(x, y, z); this.n.push(nx, ny, nz);
            this.u.push(g.u[k * 2], g.u[k * 2 + 1]);
            this.m.push(matId !== undefined ? matId : g.m[k]);
        }
        for (let k = 0; k < g.i.length; k++) this.i.push(g.i[k] + o);
        return this;
    }
    // make triangle winding agree with vertex normals
    finish() {
        const p = this.p, n = this.n, ix = this.i;
        for (let k = 0; k < ix.length; k += 3) {
            const a = ix[k] * 3, b = ix[k + 1] * 3, c = ix[k + 2] * 3;
            const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
            const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
            const gn = V.cross(e1, e2);
            const d = gn[0] * (n[a] + n[b] + n[c]) + gn[1] * (n[a + 1] + n[b + 1] + n[c + 1]) + gn[2] * (n[a + 2] + n[b + 2] + n[c + 2]);
            if (d < 0) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; }
        }
        return this;
    }
}

function face(g, nrm, c, ul, vl, m) {
    const o = g.vc;
    g.v(c[0][0], c[0][1], c[0][2], nrm[0], nrm[1], nrm[2], 0, 0, m);
    g.v(c[1][0], c[1][1], c[1][2], nrm[0], nrm[1], nrm[2], ul, 0, m);
    g.v(c[2][0], c[2][1], c[2][2], nrm[0], nrm[1], nrm[2], ul, vl, m);
    g.v(c[3][0], c[3][1], c[3][2], nrm[0], nrm[1], nrm[2], 0, vl, m);
    g.q(o, o + 1, o + 2, o + 3);
}

function box(w, h, d, m = 0) {
    const g = new G(), x = w / 2, y = h / 2, z = d / 2;
    face(g, [0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], w, h, m);
    face(g, [0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]], w, h, m);
    face(g, [1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]], d, h, m);
    face(g, [-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]], d, h, m);
    face(g, [0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]], w, d, m);
    face(g, [0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], w, d, m);
    return g;
}

// flat quad in XZ plane, centred, normal +Y, uv 0..1
function plane(w, d, m = 0, uvScale = 0) {
    const g = new G(), x = w / 2, z = d / 2;
    const uu = uvScale ? w * uvScale : 1, vv = uvScale ? d * uvScale : 1;
    g.v(-x, 0, z, 0, 1, 0, 0, 0, m); g.v(x, 0, z, 0, 1, 0, uu, 0, m);
    g.v(x, 0, -z, 0, 1, 0, uu, vv, m); g.v(-x, 0, -z, 0, 1, 0, 0, vv, m);
    g.q(0, 1, 2, 3);
    return g;
}

// profile listed from TOP (axis) -> outward -> down -> back to axis.  pts: [r,y,sharp]
function lathe(profile, seg = 24, m = 0) {
    const g = new G(), n = profile.length, sn = [];
    for (let k = 0; k < n - 1; k++) {
        const dr = profile[k + 1][0] - profile[k][0], dy = profile[k + 1][1] - profile[k][1];
        const l = Math.hypot(dr, dy) || 1;
        sn.push([-dy / l, dr / l]);
    }
    const avg = (a, b) => { const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
    for (let k = 0; k < n - 1; k++) {
        const a = profile[k], b = profile[k + 1];
        const na = (k > 0 && !a[2]) ? avg(sn[k - 1], sn[k]) : sn[k];
        const nb = (k < n - 2 && !b[2]) ? avg(sn[k], sn[k + 1]) : sn[k];
        const base = g.vc;
        for (let j = 0; j <= seg; j++) {
            const th = j / seg * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
            g.v(a[0] * c, a[1], a[0] * s, na[0] * c, na[1], na[0] * s, j / seg, a[1], m);
            g.v(b[0] * c, b[1], b[0] * s, nb[0] * c, nb[1], nb[0] * s, j / seg, b[1], m);
        }
        for (let j = 0; j < seg; j++) { const i = base + j * 2; g.t(i, i + 1, i + 3); g.t(i, i + 3, i + 2); }
    }
    return g.finish();
}

function cylinder(r0, r1, h, seg = 20, m = 0, caps = true) {
    const pr = [];
    if (caps) pr.push([0, h / 2, 1]);
    pr.push([r1, h / 2, 1], [r0, -h / 2, 1]);
    if (caps) pr.push([0, -h / 2, 1]);
    return lathe(pr, seg, m);
}

function sphere(r, ws = 20, hs = 14, m = 0) {
    const pr = [];
    for (let k = 0; k <= hs; k++) {
        const a = k / hs * Math.PI;
        pr.push([Math.max(Math.sin(a) * r, k === 0 || k === hs ? 0 : 1e-4), Math.cos(a) * r, 0]);
    }
    return lathe(pr, ws, m);
}

// capsule along +Y from y=0 to y=len
function capsule(r0, r1, len, seg = 12, m = 0) {
    const pr = [], hs = 5;
    for (let k = 0; k <= hs; k++) { const a = k / hs * Math.PI / 2; pr.push([Math.max(Math.sin(a) * r1, k ? 1e-4 : 0), len + Math.cos(a) * r1 * 0.9, 0]); }
    for (let k = 0; k <= hs; k++) { const a = Math.PI / 2 + k / hs * Math.PI / 2; pr.push([Math.max(Math.sin(a) * r0, k === hs ? 0 : 1e-4), Math.cos(a) * r0 * 0.9, 0]); }
    return lathe(pr, seg, m);
}

// limb between two points (tapered capsule, exact length)
function limb(p0, p1, r0, r1, seg = 10, m = 0) {
    const len = V.len(V.sub(p1, p0));
    const out = new G();
    out.add(capsule(r0, r1, len, seg, m), M.alignY(p0, p1, 1, false));
    return out;
}

// sweep a circle along a polyline
function tube(path, radius, seg = 10, m = 0) {
    const g = new G(), n = path.length;
    const rf = typeof radius === 'function' ? radius : () => radius;
    let prevN = null;
    const rings = [];
    for (let i = 0; i < n; i++) {
        const a = path[Math.max(i - 1, 0)], b = path[Math.min(i + 1, n - 1)];
        const t = V.norm(V.sub(b, a));
        let nn;
        if (!prevN) { nn = Math.abs(t[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0]; nn = V.norm(V.cross(t, V.cross(nn, t))); }
        else { nn = V.norm(V.sub(prevN, V.mul(t, V.dot(prevN, t)))); }
        prevN = nn;
        const bb = V.cross(t, nn);
        rings.push({ n: nn, b: bb, c: path[i], r: rf(i / (n - 1)) });
    }
    for (let i = 0; i < n; i++) {
        const R = rings[i];
        for (let j = 0; j <= seg; j++) {
            const th = j / seg * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
            const dn = [R.n[0] * c + R.b[0] * s, R.n[1] * c + R.b[1] * s, R.n[2] * c + R.b[2] * s];
            g.v(R.c[0] + dn[0] * R.r, R.c[1] + dn[1] * R.r, R.c[2] + dn[2] * R.r, dn[0], dn[1], dn[2], j / seg, i / (n - 1), m);
        }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) {
        const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
        g.t(a, c, d); g.t(a, d, b);
    }
    return g.finish();
}

/* ------------------------------ GLSL ------------------------------ */
const NOISE = `
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3=fract(p3*.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float a=.5,s=0.; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+17.1; a*=.5; } return s; }
`;

const VS_MESH = `#version 300 es
layout(location=0) in vec3 a_pos; layout(location=1) in vec3 a_nrm; layout(location=2) in vec2 a_uv; layout(location=3) in float a_mat;
uniform mat4 u_vp; uniform mat4 u_model; uniform mat3 u_nmat;
out vec3 v_wp; out vec3 v_n; out vec3 v_on; out vec2 v_uv; out float v_mat; out vec3 v_op;
void main(){
  vec4 wp=u_model*vec4(a_pos,1.);
  v_wp=wp.xyz; v_n=normalize(u_nmat*a_nrm); v_on=a_nrm; v_uv=a_uv; v_mat=a_mat; v_op=a_pos;
  gl_Position=u_vp*wp;
}`;

const FS_MESH = `#version 300 es
precision highp float; precision highp sampler2DShadow;
in vec3 v_wp; in vec3 v_n; in vec3 v_on; in vec2 v_uv; in float v_mat; in vec3 v_op;
out vec4 o_col;
#define MAXL ${MAXL}
uniform vec3 u_eye; uniform int u_mirror; uniform float u_time;
uniform vec3 u_keyDir, u_keyCol, u_skyTop, u_skyHor, u_gnd, u_fogCol, u_ambMin;
uniform float u_ambI, u_envI, u_fogDen, u_night, u_wet;
uniform mat4 u_shadowVP; uniform sampler2DShadow u_shadow; uniform sampler2D u_refl; uniform vec2 u_res; uniform float u_shadowOn;
uniform vec4 u_L0[MAXL]; uniform vec4 u_L1[MAXL]; uniform vec4 u_L2[MAXL]; uniform int u_nl;
uniform int u_mode; uniform vec3 u_albedo, u_emis, u_accent; uniform float u_metal, u_rough, u_alpha;
uniform vec4 u_car; uniform vec4 u_gaps; uniform vec4 u_misc;
${NOISE}
const float PI=3.14159265;

vec3 envSky(vec3 d){
  float h=clamp(d.y,-1.,1.);
  vec3 sky=mix(u_skyHor,u_skyTop,pow(clamp(h,0.,1.),0.5));
  float sd=max(dot(d,u_keyDir),0.);
  sky+=u_keyCol*(pow(sd,300.)*0.6+pow(sd,12.)*0.035);
  return mix(u_gnd*1.2+u_ambMin, sky, smoothstep(-0.06,0.05,h));
}
vec3 hemi(vec3 n){
  vec3 top=u_skyTop*0.55+u_skyHor*0.45;
  return mix(u_gnd, top, n.y*0.5+0.5)+u_ambMin;
}
vec3 brdf(vec3 N,vec3 V,vec3 L,vec3 alb,float met,float r,vec3 F0){
  vec3 H=normalize(V+L);
  float NL=max(dot(N,L),0.), NV=max(dot(N,V),1e-3), NH=max(dot(N,H),0.), VH=max(dot(V,H),0.);
  float a=r*r, a2=a*a, dd=NH*NH*(a2-1.)+1.;
  float D=a2/(PI*dd*dd+1e-5);
  float k=(r+1.)*(r+1.)/8.;
  float G=(NL/(NL*(1.-k)+k))*(NV/(NV*(1.-k)+k));
  vec3 F=F0+(1.-F0)*pow(1.-VH,5.);
  vec3 spec=D*G*F/(4.*NL*NV+1e-3);
  vec3 kd=(1.-F)*(1.-met);
  return kd*alb/PI+spec;
}
vec3 lightsum(vec3 P,vec3 N,vec3 V,vec3 alb,float met,float r,vec3 F0){
  vec3 Lo=vec3(0.);
  for(int i=0;i<MAXL;i++){
    if(i>=u_nl) break;
    vec4 a=u_L0[i], b=u_L1[i], c=u_L2[i];
    vec3 L=a.xyz-P; float d2=dot(L,L); float d=sqrt(d2); L/=d;
    float w=clamp(1.-pow(d/a.w,4.),0.,1.); w*=w;
    float cd=dot(-L,b.xyz);
    float cone=smoothstep(c.w,mix(c.w,1.,0.3),cd);
    float att=w*pow(max(cd,0.),b.w)*cone/(d2+0.6);
    float NL=max(dot(N,L),0.);
    if(att*NL<1e-6) continue;
    Lo+=brdf(N,V,L,alb,met,r,F0)*c.rgb*att*NL;
  }
  return Lo;
}
float shadowTerm(vec3 P,vec3 N){
  if(u_shadowOn<0.5) return 1.;
  vec4 sp=u_shadowVP*vec4(P+N*0.07,1.);
  vec3 c=sp.xyz/sp.w*0.5+0.5;
  if(c.x<0.||c.x>1.||c.y<0.||c.y>1.||c.z>1.) return 1.;
  float s=0., ts=1./${SHADOW_RES}.;
  for(int i=0;i<9;i++){
    vec2 o=vec2(float(i%3)-1.,float(i/3)-1.)*ts*1.6;
    s+=texture(u_shadow,vec3(c.xy+o,c.z-0.0006));
  }
  s/=9.;
  vec2 e=min(c.xy,1.-c.xy);
  return mix(1.,s,smoothstep(0.,0.06,min(e.x,e.y)));
}

void main(){
  if(u_mode==20){ // blob contact shadow
    vec2 q=v_uv*2.-1.; float r=pow(pow(abs(q.x),3.)+pow(abs(q.y),3.),1./3.);
    o_col=vec4(0.,0.,0.,smoothstep(1.,0.25,r)*u_alpha); return;
  }
  vec3 N=normalize(v_n); if(!gl_FrontFacing) N=-N;
  vec3 V=normalize(u_eye-v_wp);
  float dist=length(u_eye-v_wp);
  vec3 alb=u_albedo, emis=u_emis; float met=u_metal, rough=u_rough, ao=1., coat=0., refl=0.;
  vec3 P=v_wp;
  float night=u_night;
  vec3 extraRefl=vec3(0.);
  bool glass=false;

  if(u_mode==1){ /* asphalt */
    vec2 q=P.xz;
    float n1=fbm(q*1.3), n2=vnoise(q*14.), n3=vnoise(q*70.), n4=vnoise(q*260.);
    vec3 base=vec3(0.050,0.052,0.056)*(0.7+0.7*n1)+vec3(0.030)*(n2-.5)+vec3(0.04)*(n3-.5)*0.7+vec3(0.05)*step(0.93,n4)*.6;
    float lane=abs(abs(q.y)-2.0);
    float wp=exp(-pow((lane-0.82)/0.30,2.));
    base*=1.-0.22*wp;
    // patches / cracks
    float patchM=smoothstep(0.62,0.66,fbm(q*0.22+3.));
    base=mix(base,base*0.62,patchM);
    float crack=smoothstep(0.012,0.0,abs(fbm(q*2.6)-0.5)-0.002);
    base*=1.-0.5*crack;
    // paint
    float wear=0.55+0.45*vnoise(q*9.);
    float paint=0.;
    float dashed=step(mod(q.x+1.5,6.),3.)*step(abs(q.y),0.075);
    float edgeL=step(abs(abs(q.y)-3.78),0.065);
    float zebra=step(abs(q.x),2.4)*step(abs(q.y),3.5)*step(mod(q.y+0.5,1.),0.5)*step(0.4,abs(abs(q.y)-0.0));
    float stopL=step(abs(abs(q.x)-3.4),0.22)*step(0.2,q.y*sign(q.x)*-1.)*0.;
    paint=max(max(dashed,edgeL),zebra)*wear;
    alb=mix(base,vec3(0.62,0.62,0.58),paint);
    // manhole
    float mh=smoothstep(0.42,0.40,length(q-vec2(-14.,-1.6)));
    alb=mix(alb,vec3(0.025),mh);
    met=0.; rough=mix(0.93,0.58,wp*0.6);
    float pud=smoothstep(0.52,0.66,fbm(q*0.35+7.));
    float wetness=clamp(u_wet*(0.35+0.9*pud),0.,1.);
    rough=mix(rough,0.14+0.2*n2,wetness*(1.-paint*0.7));
    alb*=1.-0.35*wetness;
    // micro bump
    vec2 g=vec2(vnoise(q*55.+1.3)-vnoise(q*55.-1.3),vnoise(q*55.+vec2(0.,1.3))-vnoise(q*55.-vec2(0.,1.3)));
    N=normalize(N+vec3(g.x,0.,g.y)*mix(0.35,0.05,wetness));
    refl=wetness;
  } else if(u_mode==2){ /* concrete / pavers */
    vec2 q=P.xz; float top=step(0.6,N.y);
    vec2 cell=q/0.6; vec2 f=abs(fract(cell+0.5)-0.5);
    float gl=smoothstep(0.012,0.0,min(f.x,f.y)*0.6)*top;
    float n=fbm(q*3.)*0.5+vnoise(q*40.)*0.3;
    vec3 base=u_albedo*(0.75+0.5*n);
    float tileTone=hash12(floor(cell))*0.18;
    base*=0.92+tileTone;
    alb=base*(1.-0.55*gl);
    rough=0.88;
    float wetness=clamp(u_wet*0.5*smoothstep(0.5,0.8,fbm(q*0.5)),0.,1.);
    rough=mix(rough,0.35,wetness); alb*=1.-0.25*wetness;
  } else if(u_mode==3){ /* building facade */
    float seed=floor(v_mat+0.5); /* varying is interpolated: round so hashes stay stable per building */
    float u=v_uv.x, h=v_uv.y;
    float rh=hash12(vec2(seed,1.7));
    vec3 wall=mix(vec3(0.30,0.28,0.26),vec3(0.55,0.50,0.44),rh);
    wall=mix(wall,vec3(0.40,0.32,0.28),step(0.7,hash12(vec2(seed,9.1)))*0.9);
    wall=mix(wall,vec3(0.22,0.26,0.30),step(0.85,hash12(vec2(seed,4.4))));
    float top=step(0.7,N.y);
    float fh=3.4, fw=3.0;
    vec2 cid=vec2(floor(u/fw),floor(h/fh));
    vec2 cu=vec2(fract(u/fw),fract(h/fh));
    float win=step(0.16,cu.x)*step(cu.x,0.84)*step(0.28,cu.y)*step(cu.y,0.86)*(1.-top)*step(0.001,1.-abs(N.y));
    float ground=step(h,4.2);
    // storefront band
    if(ground>0.5){ win=step(0.08,cu.x)*step(cu.x,0.92)*step(0.1,h)*step(h,3.5)*(1.-top); }
    float nz=fbm(vec2(u,h)*1.7);
    alb=wall*(0.8+0.4*nz);
    alb*=1.-0.12*smoothstep(3.4,0.,fract(h/fh)*fh)*0.5;
    rough=0.85; met=0.;
    if(top>0.5){ alb=vec3(0.09)*(0.7+nz); }
    if(win>0.5){
      float lit=step(0.62,hash12(cid+seed*3.1));
      if(ground>0.5) lit=step(0.2,hash12(cid+seed*1.3));
      vec3 warm=mix(vec3(1.0,0.72,0.38),vec3(0.75,0.85,1.0),step(0.75,hash12(cid+seed*7.7)));
      if(ground>0.5) warm=mix(vec3(1.0,0.82,0.55),vec3(0.9,1.0,0.95),step(0.6,hash12(cid+seed*2.2)));
      float inten=(ground>0.5?0.75:0.7)*(0.55+hash12(cid+seed*5.5));
      emis=warm*inten*lit*night;
      alb=vec3(0.02,0.03,0.04); met=0.; rough=0.08;
      glass=true;
    }
    // distance filtering: collapse the window grid into its average colour
    // once cells approach pixel size (kills moire / sparkle on far facades)
    float ff=smoothstep(0.08,0.34,max(fwidth(u/fw),fwidth(h/fh)));
    if(ff>0.){
      vec3 wallA=(top>0.5)?alb:wall*(0.8+0.4*nz);
      vec3 farAlb=mix(wallA,vec3(0.05,0.06,0.08),0.32*(1.-top));
      vec3 farEm=vec3(0.95,0.62,0.34)*(ground>0.5?0.55:0.17)*night*(1.-top);
      alb=mix(alb,farAlb,ff); emis=mix(emis,farEm,ff); rough=mix(rough,0.7,ff);
      if(ff>0.5) glass=false;
    }
    // sign strip on ground floor
    if(ground>0.5 && h>3.55 && h<4.15 && top<0.5){
      float sg=hash12(vec2(floor(u/9.),seed));
      vec3 sc=mix(vec3(0.9,0.2,0.15),vec3(0.1,0.5,0.9),step(0.5,sg)); sc=mix(sc,vec3(0.95,0.7,0.1),step(0.8,sg));
      alb=sc*0.2; emis=sc*0.9*night;
    }
    ao=0.75+0.25*smoothstep(0.,6.,h);
  } else if(u_mode==4){ /* grass */
    float n=fbm(P.xz*2.4), n2=vnoise(P.xz*28.);
    alb=mix(vec3(0.035,0.09,0.02),vec3(0.07,0.15,0.03),n)*(0.8+0.5*n2);
    rough=0.95; met=0.;
  } else if(u_mode==5){ /* foliage */
    float tone=v_mat;
    float n=vnoise(P.xz*6.+P.y*3.), n2=vnoise(P.xy*9.+P.z*5.);
    alb=mix(vec3(0.03,0.09,0.015),vec3(0.10,0.20,0.03),tone)*(0.7+0.6*n);
    alb=mix(alb,vec3(0.16,0.22,0.04),smoothstep(0.7,1.,n2)*0.35);
    rough=0.7; met=0.;
    N=normalize(N+(vec3(n,n2,vnoise(P.zx*7.))-0.5)*0.9);
    ao=0.55+0.45*smoothstep(0.,1.,clamp((P.y-2.2)/4.,0.,1.));
  } else if(u_mode==6){ /* car body (paint / glass / trim / chrome) */
    vec3 on=normalize(v_on);
    float mt=v_mat;
    if(mt>0.5 && mt<1.5){ glass=true; alb=vec3(0.008,0.011,0.014); met=0.; rough=0.035; }
    else if(mt>1.5 && mt<2.5){ alb=vec3(0.012); met=0.; rough=0.55; }
    else if(mt>2.5 && mt<3.5){ alb=vec3(0.85,0.86,0.88); met=1.; rough=0.12; }
    else {
      // paint
      vec3 base=u_albedo;
      float fl=hash13(floor(v_op*900.));
      base*=1.+0.25*(fl-0.5)*u_misc.w;
      alb=base; met=0.0; rough=0.32; coat=1.;
      float side=step(0.65,abs(on.z)), topF=step(0.7,on.y), frontF=step(0.55,on.x), rearF=step(0.55,-on.x);
      // door / hood / trunk shut lines
      float gl=0.;
      float sy=smoothstep(u_car.z+0.05,u_car.z,v_op.y)*step(0.3,v_op.y);
      gl+= side*sy*(smoothstep(0.006,0.0015,abs(v_op.x-u_gaps.x))+smoothstep(0.006,0.0015,abs(v_op.x-u_gaps.y))+smoothstep(0.006,0.0015,abs(v_op.x-u_gaps.z)));
      gl+= topF*(smoothstep(0.006,0.0015,abs(v_op.x-u_gaps.w)));
      alb*=1.-0.9*clamp(gl,0.,1.);
      // wheel arches
      float ar=0.;
      for(int k=0;k<2;k++){
        float ax=k==0?u_car.x:u_car.y;
        float dd=length(vec2(v_op.x-ax,v_op.y-u_misc.x));
        ar=max(ar,smoothstep(u_car.w+0.012,u_car.w-0.012,dd)*step(v_op.y,u_misc.x+0.1));
        float lip=smoothstep(u_car.w+0.05,u_car.w+0.03,dd)*step(v_op.y,u_misc.x+0.05)*step(0.3,abs(on.z));
        alb=mix(alb,vec3(0.012),lip*0.9);
      }
      alb=mix(alb,vec3(0.006),ar*step(0.3,abs(on.z))); coat*=1.-ar;
      // front grille / lower intake
      if(frontF>0.5){
        float gy=smoothstep(u_misc.y-0.02,u_misc.y,v_op.y)*smoothstep(u_misc.z+0.02,u_misc.z,v_op.y)*step(abs(v_op.z),u_misc.w*0.0+u_car.z*0.0+0.62);
        float slat=0.5+0.5*sin(v_op.y*120.);
        float low=smoothstep(u_misc.y-0.05,u_misc.y-0.09,v_op.y)*step(v_op.y,u_misc.y)*step(abs(v_op.z),0.7)*step(0.18,v_op.y);
        alb=mix(alb,vec3(0.006)*(0.6+0.8*slat),max(gy,low)*0.97); coat*=1.-max(gy,low);
        rough=mix(rough,0.5,max(gy,low));
      }
      if(rearF>0.5){
        float by=smoothstep(0.34,0.3,v_op.y)*step(0.18,v_op.y);
        alb=mix(alb,vec3(0.01),by*0.95); coat*=1.-by;
      }
      // lower sill trim
      float sill=smoothstep(0.36,0.30,v_op.y)*step(0.55,abs(on.z))*step(0.16,v_op.y);
      alb=mix(alb,vec3(0.012),sill); coat*=1.-sill;
      // commercial body ribbing / stripe (trucks)
      if(u_misc.w<0.0){
        float rib=0.5+0.5*sin(v_op.x*60.);
        alb*=0.9+0.1*rib;
      }
    }
    // paint orange-peel
    N=normalize(N+0.004*(vec3(vnoise(v_op.xy*400.),vnoise(v_op.yz*400.),vnoise(v_op.zx*400.))-0.5));
  } else if(u_mode==7){ /* lamp lens + emissive hardware: albedo dark, emis uniform */
    // plain
  } else if(u_mode==8){ /* tire rubber */
    float n=vnoise(vec2(atan(v_op.y,v_op.z)*24.,v_op.x*180.));
    alb=vec3(0.012)*(0.6+0.8*n); rough=0.85; met=0.;
  } else if(u_mode==9){ /* galvanised metal w/ brushed streak */
    float s=vnoise(vec2(v_op.y*2.,atan(v_op.z,v_op.x)*30.));
    alb=u_albedo*(0.9+0.2*s); met=u_metal; rough=u_rough+0.1*s;
  }

  vec3 F0=mix(vec3(0.04),alb,met);
  float NV=max(dot(N,V),0.);
  vec3 col=vec3(0.);

  // key light (sun / moon)
  float sh=shadowTerm(P,v_n);
  float NLk=max(dot(N,u_keyDir),0.);
  col+=brdf(N,V,u_keyDir,alb,met,rough,F0)*u_keyCol*NLk*sh;
  // ambient
  vec3 amb=hemi(N);
  col+=(1.-met)*alb*amb*u_ambI*ao;
  // env specular
  vec3 R=reflect(-V,N);
  float fr=pow(1.-NV,5.);
  vec3 Fe=F0+(max(vec3(1.-rough),F0)-F0)*fr;
  vec3 envc=mix(envSky(R),amb*1.1,rough*rough);
  float horizonOcc=smoothstep(-0.1,0.3,R.y)*0.7+0.3;
  col+=envc*Fe*u_envI*ao*mix(1.,horizonOcc,0.5);
  // local lights
  col+=lightsum(P,N,V,alb,met,max(rough,0.045),F0);

  // clearcoat on paint
  if(coat>0.5){
    float Fc=0.04+0.96*fr;
    col*=1.-Fc*0.9;
    col+=envSky(R)*Fc*u_envI*(0.55+0.45*horizonOcc);
    col+=lightsum(P,N,V,vec3(0.),0.,0.1,vec3(0.04));
    col+=brdf(N,V,u_keyDir,vec3(0.),0.,0.1,vec3(0.04))*u_keyCol*NLk*sh;
  }
  if(glass){
    float Fg=0.06+0.94*fr;
    col+=envSky(R)*Fg*u_envI*1.35;
    col+=lightsum(P,N,V,vec3(0.),0.,0.05,vec3(0.06));
  }

  // wet road planar reflection
  if(u_mode==1 && refl>0.001){
    vec2 uv=gl_FragCoord.xy/u_res;
    float rr=rough;
    vec2 pert=(vec2(vnoise(P.xz*22.)-0.5,vnoise(P.xz*22.+9.)-0.5))*0.012*(0.3+rr*2.);
    vec3 acc=vec3(0.); float wsum=0.;
    for(int i=-4;i<=4;i++){
      float k=float(i);
      float w=exp(-k*k*0.12);
      vec2 o=vec2(k*0.0012,k*0.0042*(0.3+rr*3.0));
      acc+=texture(u_refl,clamp(uv+pert+o,0.001,0.999)).rgb*w; wsum+=w;
    }
    acc/=wsum;
    float Fr=0.03+0.97*pow(1.-NV,5.);
    float k=refl*(1.-rr)*(0.35+0.65*Fr*2.2);
    col+=acc*clamp(k,0.,0.92);
  }
  col+=emis;

  // fog
  float f=1.-exp(-pow(dist*u_fogDen,2.));
  f=clamp(f,0.,1.);
  col=mix(col,u_fogCol,f);
  o_col=vec4(col,u_alpha);
}`;

const VS_FULL = `#version 300 es
out vec2 v_uv;
void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.-1.,0.,1.); }`;

const FS_SKY = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o_col;
uniform mat3 u_camRot; uniform float u_tanH, u_asp; uniform int u_mirror; uniform float u_time;
uniform vec3 u_skyTop, u_skyHor, u_fogCol, u_keyDir, u_keyCol, u_sunDir, u_sunCol, u_moonDir, u_moonCol;
uniform float u_night, u_cloud, u_fogDen;
${NOISE}
void main(){
  vec2 nd=v_uv*2.-1.;
  vec3 rv=vec3(nd.x*u_asp*u_tanH, nd.y*u_tanH, -1.);
  vec3 d=normalize(u_camRot*rv);
  if(u_mirror==1) d.y=-d.y;
  float h=d.y;
  vec3 sky=mix(u_skyHor,u_skyTop,pow(clamp(h,0.,1.),0.42));
  // horizon haze band
  sky=mix(sky,u_fogCol,exp(-max(h,0.)*9.)*0.55);
  // sun
  float sd=max(dot(d,u_sunDir),0.);
  sky+=u_sunCol*(pow(sd,900.)*60.+pow(sd,60.)*0.9+pow(sd,6.)*0.12);
  // moon disc with maria
  float md=dot(d,u_moonDir);
  if(md>0.9990){
    vec3 t=normalize(cross(u_moonDir,vec3(0.,1.,0.))), b=cross(u_moonDir,t);
    vec2 q=vec2(dot(d,t),dot(d,b))/0.0225;
    float disc=smoothstep(1.,0.93,length(q));
    float m=fbm(q*2.2+4.)*0.8+fbm(q*7.)*0.25;
    float lit=0.62+0.38*smoothstep(0.35,0.6,m);
    float lim=0.8+0.2*sqrt(max(1.-dot(q,q),0.));
    sky=mix(sky,vec3(0.82,0.84,0.88)*lit*lim*2.2,disc);
  }
  sky+=u_moonCol*(pow(max(md,0.),70.)*0.9+pow(max(md,0.),10.)*0.1);
  // stars
  if(h>0.0 && u_night>0.01){
    vec3 p=d*260.; vec3 ci=floor(p); float hs=hash13(ci);
    vec3 fp=fract(p)-0.5; float st=smoothstep(0.55,0.,length(fp))*step(0.992,hs);
    float tw=0.6+0.4*sin(u_time*(1.5+hs*5.)+hs*40.);
    float mag=pow(fract(hs*91.7),3.)*3.+0.4;
    vec3 sc=mix(vec3(0.7,0.8,1.),vec3(1.,0.85,0.7),fract(hs*13.3));
    sky+=sc*st*tw*mag*u_night*smoothstep(0.,0.25,h)*(1.-u_cloud*0.5);
  }
  // clouds
  if(h>0.015){
    vec2 cp=d.xz/(h+0.12)*0.9+vec2(u_time*0.004,u_time*0.0015);
    float c=fbm(cp*1.3)*1.0+fbm(cp*3.1+5.)*0.35;
    float cov=smoothstep(0.62-u_cloud*0.34,0.95-u_cloud*0.25,c);
    cov*=smoothstep(0.015,0.18,h);
    vec3 cc=mix(u_skyHor*1.05+vec3(0.04),vec3(1.),(1.-u_night)*0.55)*(0.55+0.5*smoothstep(0.4,0.9,c));
    cc+=u_sunCol*0.18*pow(max(dot(d,u_sunDir),0.),4.);
    cc+=u_moonCol*0.15*pow(max(dot(d,u_moonDir),0.),4.);
    sky=mix(sky,cc,cov*0.78);
  }
  // below horizon -> fog colour
  sky=mix(u_fogCol*0.9,sky,smoothstep(-0.03,0.02,h));
  // dense fog hides sky
  float fogK=clamp(u_fogDen*70.,0.,1.);
  sky=mix(sky,u_fogCol,fogK*smoothstep(0.9,0.0,h)*0.9);
  o_col=vec4(sky,1.);
}`;

const VS_GLOW = `#version 300 es
uniform mat4 u_vp; uniform vec3 u_pos, u_right, u_up; uniform vec2 u_size; uniform vec3 u_eye;
out vec2 v_q;
void main(){
  vec2 q=vec2(float(gl_VertexID&1)*2.-1., float((gl_VertexID>>1)&1)*2.-1.);
  v_q=q;
  vec3 toEye=normalize(u_eye-u_pos);
  vec3 p=u_pos+toEye*0.35+u_right*q.x*u_size.x+u_up*q.y*u_size.y;
  gl_Position=u_vp*vec4(p,1.);
}`;
const FS_GLOW = `#version 300 es
precision highp float; in vec2 v_q; out vec4 o_col; uniform vec3 u_col; uniform float u_core;
void main(){
  float r=length(v_q); if(r>1.) discard;
  float g=pow(1.-r,2.6)*0.9+pow(1.-r,9.)*2.2;
  float streak=pow(max(1.-abs(v_q.y)*5.,0.),3.)*pow(1.-abs(v_q.x),2.)*0.35*u_core;
  o_col=vec4(u_col*(g+streak),1.);
}`;

const VS_CONE = `#version 300 es
layout(location=0) in vec3 a_pos; layout(location=1) in vec3 a_nrm;
uniform mat4 u_vp; uniform mat4 u_model; uniform mat3 u_nmat;
out vec3 v_wp; out vec3 v_n; out float v_h;
void main(){ vec4 wp=u_model*vec4(a_pos,1.); v_wp=wp.xyz; v_n=normalize(u_nmat*a_nrm); v_h=-a_pos.y; gl_Position=u_vp*wp; }`;
const FS_CONE = `#version 300 es
precision highp float; in vec3 v_wp; in vec3 v_n; in float v_h; out vec4 o_col;
uniform vec3 u_eye; uniform vec3 u_col; uniform float u_int;
void main(){
  vec3 V=normalize(u_eye-v_wp); float ndv=abs(dot(normalize(v_n),V));
  float edge=pow(ndv,1.4);
  float a=edge*u_int*(1.-v_h*0.55)*smoothstep(1.,0.88,v_h)*smoothstep(0.,0.03,v_h);
  o_col=vec4(u_col*a,1.);
}`;

const VS_DEPTH = `#version 300 es
layout(location=0) in vec3 a_pos; uniform mat4 u_vp; uniform mat4 u_model;
void main(){ gl_Position=u_vp*u_model*vec4(a_pos,1.); }`;
const FS_DEPTH = `#version 300 es
precision highp float; void main(){}`;

const FS_BRIGHT = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o_col; uniform sampler2D u_tex; uniform vec2 u_texel; uniform float u_thr;
void main(){
  vec3 c=vec3(0.);
  c+=texture(u_tex,v_uv+u_texel*vec2(-1.,-1.)).rgb; c+=texture(u_tex,v_uv+u_texel*vec2(1.,-1.)).rgb;
  c+=texture(u_tex,v_uv+u_texel*vec2(-1.,1.)).rgb;  c+=texture(u_tex,v_uv+u_texel*vec2(1.,1.)).rgb;
  c*=0.25;
  float l=max(c.r,max(c.g,c.b));
  float k=max(l-u_thr,0.)/max(l,1e-4);
  o_col=vec4(c*k,1.);
}`;
const FS_DOWN = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o_col; uniform sampler2D u_tex; uniform vec2 u_texel;
void main(){
  vec3 c=texture(u_tex,v_uv).rgb*0.5;
  c+=texture(u_tex,v_uv+u_texel*vec2(-1.,-1.)).rgb*0.125; c+=texture(u_tex,v_uv+u_texel*vec2(1.,-1.)).rgb*0.125;
  c+=texture(u_tex,v_uv+u_texel*vec2(-1.,1.)).rgb*0.125;  c+=texture(u_tex,v_uv+u_texel*vec2(1.,1.)).rgb*0.125;
  o_col=vec4(c,1.);
}`;
const FS_BLUR = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o_col; uniform sampler2D u_tex; uniform vec2 u_dir;
void main(){
  vec3 c=texture(u_tex,v_uv).rgb*0.227027;
  c+=texture(u_tex,v_uv+u_dir*1.3846).rgb*0.316216; c+=texture(u_tex,v_uv-u_dir*1.3846).rgb*0.316216;
  c+=texture(u_tex,v_uv+u_dir*3.2308).rgb*0.070270; c+=texture(u_tex,v_uv-u_dir*3.2308).rgb*0.070270;
  o_col=vec4(c,1.);
}`;
const FS_COMP = `#version 300 es
precision highp float; in vec2 v_uv; out vec4 o_col;
uniform sampler2D u_hdr; uniform sampler2D u_b0,u_b1,u_b2,u_b3,u_b4; uniform float u_exp, u_bloom, u_time; uniform vec2 u_res;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.,1.); }
float h12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
void main(){
  vec2 c=v_uv-0.5;
  float ca=dot(c,c)*0.0016;
  vec3 col;
  col.r=texture(u_hdr,v_uv+c*ca*2.).r; col.g=texture(u_hdr,v_uv).g; col.b=texture(u_hdr,v_uv-c*ca*2.).b;
  vec3 b=texture(u_b0,v_uv).rgb*0.9+texture(u_b1,v_uv).rgb*0.8+texture(u_b2,v_uv).rgb*0.8+texture(u_b3,v_uv).rgb*0.9+texture(u_b4,v_uv).rgb*1.1;
  col+=b*u_bloom;
  col*=u_exp;
  col=aces(col);
  // subtle cool shadows / warm highlights grade
  float l=dot(col,vec3(0.299,0.587,0.114));
  col=mix(col,col*vec3(0.96,0.99,1.05),1.-smoothstep(0.,0.5,l));
  col=pow(col,vec3(1./2.2));
  float vig=smoothstep(0.95,0.25,length(c*vec2(1.,0.9)));
  col*=mix(0.72,1.,vig);
  col+=(h12(gl_FragCoord.xy+fract(u_time)*100.)-0.5)*0.022;
  o_col=vec4(col,1.);
}`;

/* ---------------------------- renderer ---------------------------- */
class Renderer {
    constructor(canvas) {
        const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
        if (!gl) throw new Error('WebGL2 unsupported');
        this.gl = gl; this.canvas = canvas;
        this.hasFloat = !!gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('EXT_color_buffer_half_float');
        gl.getExtension('OES_texture_float_linear');
        this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
        if (!this.hasFloat) throw new Error('Float render targets unsupported');
        this.progs = {};
        this.progs.mesh = this.prog(VS_MESH, FS_MESH);
        this.progs.sky = this.prog(VS_FULL, FS_SKY);
        this.progs.glow = this.prog(VS_GLOW, FS_GLOW);
        this.progs.cone = this.prog(VS_CONE, FS_CONE);
        this.progs.depth = this.prog(VS_DEPTH, FS_DEPTH);
        this.progs.bright = this.prog(VS_FULL, FS_BRIGHT);
        this.progs.down = this.prog(VS_FULL, FS_DOWN);
        this.progs.blur = this.prog(VS_FULL, FS_BLUR);
        this.progs.comp = this.prog(VS_FULL, FS_COMP);
        this.emptyVao = gl.createVertexArray();
        this.dummyTex = this.tex2D(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        this.w = 0; this.h = 0;
        this.initShadow();
        this.size = [0, 0];
    }
    prog(vs, fs) {
        const gl = this.gl;
        const mk = (type, src) => {
            const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(s);
                const ln = (log.match(/ERROR: \d+:(\d+)/) || [])[1];
                let ctx = '';
                if (ln) { const L = src.split('\n'); ctx = '\n>> ' + L.slice(Math.max(0, ln - 3), +ln + 1).join('\n>> '); }
                throw new Error('Shader compile: ' + log + ctx);
            }
            return s;
        };
        const p = gl.createProgram();
        gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
        return { p, loc: {} };
    }
    L(pr, n) {
        if (!(n in pr.loc)) pr.loc[n] = this.gl.getUniformLocation(pr.p, n);
        return pr.loc[n];
    }
    u1f(pr, n, v) { const l = this.L(pr, n); if (l) this.gl.uniform1f(l, v); }
    u1i(pr, n, v) { const l = this.L(pr, n); if (l) this.gl.uniform1i(l, v); }
    u2f(pr, n, a, b) { const l = this.L(pr, n); if (l) this.gl.uniform2f(l, a, b); }
    u3(pr, n, v) { const l = this.L(pr, n); if (l) this.gl.uniform3f(l, v[0], v[1], v[2]); }
    u4(pr, n, v) { const l = this.L(pr, n); if (l) this.gl.uniform4f(l, v[0], v[1], v[2], v[3]); }
    um4(pr, n, m) { const l = this.L(pr, n); if (l) this.gl.uniformMatrix4fv(l, false, m); }
    um3(pr, n, m) { const l = this.L(pr, n); if (l) this.gl.uniformMatrix3fv(l, false, m); }
    u4v(pr, n, arr) { const l = this.L(pr, n); if (l) this.gl.uniform4fv(l, arr); }

    tex2D(w, h, ifmt, fmt, type, data, linear = true) {
        const gl = this.gl, t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    mesh(g) {
        const gl = this.gl;
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const n = g.vc, buf = new Float32Array(n * 9);
        for (let i = 0; i < n; i++) {
            buf[i * 9] = g.p[i * 3]; buf[i * 9 + 1] = g.p[i * 3 + 1]; buf[i * 9 + 2] = g.p[i * 3 + 2];
            buf[i * 9 + 3] = g.n[i * 3]; buf[i * 9 + 4] = g.n[i * 3 + 1]; buf[i * 9 + 5] = g.n[i * 3 + 2];
            buf[i * 9 + 6] = g.u[i * 2]; buf[i * 9 + 7] = g.u[i * 2 + 1]; buf[i * 9 + 8] = g.m[i];
        }
        const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 24);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 36, 32);
        const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(g.i), gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        return { vao, count: g.i.length };
    }

    initShadow() {
        const gl = this.gl;
        this.shadowTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_RES, SHADOW_RES, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        this.shadowFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
        gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    rtTex(w, h) {
        const gl = this.gl;
        return this.tex2D(Math.max(1, w), Math.max(1, h), gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null);
    }
    fboTex(tex, depth, w, h) {
        const gl = this.gl, f = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        let rb = null;
        if (depth) {
            rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
        }
        return { f, rb };
    }

    resize(w, h) {
        const gl = this.gl;
        w = Math.max(2, Math.floor(w)); h = Math.max(2, Math.floor(h));
        if (w === this.w && h === this.h) return;
        this.w = w; this.h = h;
        this.canvas.width = w; this.canvas.height = h;
        // free old
        (this._del || []).forEach(o => { try { o() } catch (e) { } });
        this._del = [];
        const del = fn => this._del.push(fn);
        // HDR resolve target
        this.hdrTex = this.rtTex(w, h);
        const hd = this.fboTex(this.hdrTex, true, w, h); this.hdrFbo = hd.f;
        del(() => { gl.deleteTexture(this.hdrTex); gl.deleteFramebuffer(hd.f); gl.deleteRenderbuffer(hd.rb); });
        // MSAA
        this.msFbo = null;
        try {
            const maxS = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
            if (maxS >= 2) {
                const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
                const c = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, c);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, maxS, gl.RGBA16F, w, h);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c);
                const d = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, d);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, maxS, gl.DEPTH_COMPONENT24, w, h);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
                if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) this.msFbo = f;
                del(() => { gl.deleteFramebuffer(f); gl.deleteRenderbuffer(c); gl.deleteRenderbuffer(d); });
            }
        } catch (e) { this.msFbo = null; }
        // reflection target (half-res)
        const rw = Math.max(2, w >> 1), rh = Math.max(2, h >> 1);
        this.rw = rw; this.rh = rh;
        this.reflTex = this.rtTex(rw, rh);
        const rf = this.fboTex(this.reflTex, true, rw, rh); this.reflFbo = rf.f;
        del(() => { gl.deleteTexture(this.reflTex); gl.deleteFramebuffer(rf.f); gl.deleteRenderbuffer(rf.rb); });
        // bloom chain
        this.bloom = [];
        for (let i = 0; i < 5; i++) {
            const bw = Math.max(2, w >> (i + 1)), bh = Math.max(2, h >> (i + 1));
            const a = this.rtTex(bw, bh), b = this.rtTex(bw, bh);
            const fa = this.fboTex(a, false), fb = this.fboTex(b, false);
            this.bloom.push({ w: bw, h: bh, a, b, fa: fa.f, fb: fb.f });
            del(() => { gl.deleteTexture(a); gl.deleteTexture(b); gl.deleteFramebuffer(fa.f); gl.deleteFramebuffer(fb.f); });
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /* ---- draw helpers ---- */
    setCommon(pr, f, pass) {
        const R = this, e = f.env;
        R.u3(pr, 'u_eye', pass.eye);
        R.u1i(pr, 'u_mirror', pass.mirror ? 1 : 0);
        R.u1f(pr, 'u_time', f.time);
        R.u3(pr, 'u_keyDir', e.keyDir); R.u3(pr, 'u_keyCol', e.keyCol);
        R.u3(pr, 'u_skyTop', e.skyTop); R.u3(pr, 'u_skyHor', e.skyHor); R.u3(pr, 'u_gnd', e.gnd);
        R.u3(pr, 'u_fogCol', e.fogCol); R.u3(pr, 'u_ambMin', e.ambMin);
        R.u1f(pr, 'u_ambI', e.ambI); R.u1f(pr, 'u_envI', e.envI); R.u1f(pr, 'u_fogDen', e.fogDen);
        R.u1f(pr, 'u_night', e.night); R.u1f(pr, 'u_wet', e.wet);
        R.um4(pr, 'u_shadowVP', f.shadowVP); R.u1f(pr, 'u_shadowOn', e.shadowOn);
        R.u2f(pr, 'u_res', pass.resW, pass.resH);
        R.u1i(pr, 'u_nl', f.nLights);
        R.u4v(pr, 'u_L0', f.L0); R.u4v(pr, 'u_L1', f.L1); R.u4v(pr, 'u_L2', f.L2);
        R.u1i(pr, 'u_shadow', 0); R.u1i(pr, 'u_refl', 1);
        R.um4(pr, 'u_vp', pass.vp);
    }
    drawItem(pr, it, parentM) {
        const gl = this.gl, m = it.mat, mdl = it.model;
        this.um4(pr, 'u_model', mdl); this.um3(pr, 'u_nmat', M.nmat(mdl));
        this.u1i(pr, 'u_mode', m.mode || 0);
        this.u3(pr, 'u_albedo', m.albedo || [0.5, 0.5, 0.5]);
        this.u3(pr, 'u_emis', m.emis || [0, 0, 0]);
        this.u3(pr, 'u_accent', m.accent || [1, 1, 1]);
        this.u1f(pr, 'u_metal', m.metal || 0); this.u1f(pr, 'u_rough', m.rough === undefined ? 0.6 : m.rough);
        this.u1f(pr, 'u_alpha', m.alpha === undefined ? 1 : m.alpha);
        this.u4(pr, 'u_car', m.car || [0, 0, 0, 0]);
        this.u4(pr, 'u_gaps', m.gaps || [99, 99, 99, 99]);
        this.u4(pr, 'u_misc', m.misc || [0, 0, 0, 0]);
        gl.bindVertexArray(it.mesh.vao);
        gl.drawElements(gl.TRIANGLES, it.mesh.count, gl.UNSIGNED_INT, 0);
    }
    drawGlow(g, f, pass) {
        const gl = this.gl, pr = this.progs.glow;
        this.u3(pr, 'u_pos', g.pos); this.u2f(pr, 'u_size', g.size, g.size * (g.aspect || 1));
        this.u3(pr, 'u_col', g.col); this.u1f(pr, 'u_core', g.core === undefined ? 1 : g.core);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    renderPass(f, pass, items, opts) {
        const gl = this.gl, R = this;
        // sky
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
        let pr = this.progs.sky; gl.useProgram(pr.p);
        const e = f.env, c = pass.camRot;
        gl.uniformMatrix3fv(R.L(pr, 'u_camRot'), false, c);
        R.u1f(pr, 'u_tanH', Math.tan(f.cam.fov / 2)); R.u1f(pr, 'u_asp', pass.resW / pass.resH);
        R.u1i(pr, 'u_mirror', pass.mirror ? 1 : 0); R.u1f(pr, 'u_time', f.time);
        R.u3(pr, 'u_skyTop', e.skyTop); R.u3(pr, 'u_skyHor', e.skyHor); R.u3(pr, 'u_fogCol', e.fogCol);
        R.u3(pr, 'u_keyDir', e.keyDir); R.u3(pr, 'u_keyCol', e.keyCol);
        R.u3(pr, 'u_sunDir', e.sunDir); R.u3(pr, 'u_sunCol', e.sunCol);
        R.u3(pr, 'u_moonDir', e.moonDir); R.u3(pr, 'u_moonCol', e.moonCol);
        R.u1f(pr, 'u_night', e.starNight); R.u1f(pr, 'u_cloud', e.cloud); R.u1f(pr, 'u_fogDen', e.fogDen);
        gl.bindVertexArray(this.emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3);

        // opaque
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(pass.mirror ? gl.CW : gl.CCW);
        pr = this.progs.mesh; gl.useProgram(pr.p);
        this.setCommon(pr, f, pass);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, pass.mirror ? this.dummyTex : this.reflTex);
        for (const it of items) {
            if (!it.visible) continue;
            if (pass.mirror && it.mat.noRefl) continue;
            if (it.mat.mode === 20) continue;
            if (it.mat.alpha !== undefined && it.mat.alpha < 1) continue;
            if (it.mat.twoSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
            this.drawItem(pr, it);
        }
        gl.enable(gl.CULL_FACE);
        // blobs / transparent
        if (!pass.mirror) {
            gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
            gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -2);
            for (const it of items) if (it.visible && it.mat.mode === 20) { gl.disable(gl.CULL_FACE); this.drawItem(pr, it); }
            gl.disable(gl.POLYGON_OFFSET_FILL);
        }
        // additive: cones + glows
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        if (!pass.mirror && f.cones.length) {
            pr = this.progs.cone; gl.useProgram(pr.p);
            R.um4(pr, 'u_vp', pass.vp); R.u3(pr, 'u_eye', pass.eye);
            for (const cn of f.cones) {
                if (cn.int < 0.002) continue;
                R.um4(pr, 'u_model', cn.model); R.um3(pr, 'u_nmat', M.nmat(cn.model));
                R.u3(pr, 'u_col', cn.col); R.u1f(pr, 'u_int', cn.int);
                gl.bindVertexArray(cn.mesh.vao); gl.drawElements(gl.TRIANGLES, cn.mesh.count, gl.UNSIGNED_INT, 0);
            }
        }
        pr = this.progs.glow; gl.useProgram(pr.p);
        R.um4(pr, 'u_vp', pass.vp); R.u3(pr, 'u_eye', f.cam.eye);
        R.u3(pr, 'u_right', f.camRight); R.u3(pr, 'u_up', f.camUp);
        gl.bindVertexArray(this.emptyVao);
        for (const g of f.glows) { if (g.size > 0.01) this.drawGlow(g, f, pass); }
        gl.disable(gl.BLEND); gl.depthMask(true); gl.frontFace(gl.CCW);
    }

    render(f) {
        const gl = this.gl, R = this, w = this.w, h = this.h;
        const asp = w / h;
        const view = M.lookAt(f.cam.eye, f.cam.target, [0, 1, 0]);
        const proj = M.persp(f.cam.fov, asp, f.cam.near, f.cam.far);
        const vp = M.mul(proj, view);
        const camRot = new Float32Array([view[0], view[4], view[8], view[1], view[5], view[9], view[2], view[6], view[10]]);
        f.camRight = [view[0], view[4], view[8]]; f.camUp = [view[1], view[5], view[9]];

        // ---- shadow pass ----
        if (f.env.shadowOn > 0.5) {
            const S = f.shadowSize, c = f.shadowCenter, ld = f.env.keyDir;
            const lv = M.lookAt([c[0] + ld[0] * 120, c[1] + ld[1] * 120, c[2] + ld[2] * 120], c, Math.abs(ld[1]) > 0.97 ? [0, 0, 1] : [0, 1, 0]);
            const lp = M.ortho(-S, S, -S, S, 5, 260);
            f.shadowVP = M.mul(lp, lv);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
            gl.viewport(0, 0, SHADOW_RES, SHADOW_RES);
            gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
            gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
            gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.5, 4);
            const pr = this.progs.depth; gl.useProgram(pr.p); R.um4(pr, 'u_vp', f.shadowVP);
            for (const it of f.items) {
                if (!it.visible || !it.mat.shadow) continue;
                R.um4(pr, 'u_model', it.model);
                gl.bindVertexArray(it.mesh.vao); gl.drawElements(gl.TRIANGLES, it.mesh.count, gl.UNSIGNED_INT, 0);
            }
            gl.disable(gl.POLYGON_OFFSET_FILL); gl.cullFace(gl.BACK);
        } else { f.shadowVP = M.ident(); }

        // ---- planar reflection pass ----
        if (f.env.wet > 0.02) {
            const S = M.scale(1, -1, 1);
            const vpR = M.mul(proj, M.mul(view, S));
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.reflFbo);
            gl.viewport(0, 0, this.rw, this.rh);
            gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.renderPass(f, { vp: vpR, eye: [f.cam.eye[0], -f.cam.eye[1], f.cam.eye[2]], camRot, mirror: true, resW: this.rw, resH: this.rh }, f.items, {});
        }

        // ---- main pass ----
        const target = this.msFbo || this.hdrFbo;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.renderPass(f, { vp, eye: f.cam.eye, camRot, mirror: false, resW: w, resH: h }, f.items, {});
        if (this.msFbo) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.hdrFbo);
            gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        }

        // ---- bloom ----
        gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
        gl.bindVertexArray(this.emptyVao);
        let src = this.hdrTex, sw = w, sh = h;
        for (let i = 0; i < 5; i++) {
            const B = this.bloom[i];
            gl.bindFramebuffer(gl.FRAMEBUFFER, B.fa); gl.viewport(0, 0, B.w, B.h);
            const pr = i === 0 ? this.progs.bright : this.progs.down;
            gl.useProgram(pr.p);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); R.u1i(pr, 'u_tex', 0);
            R.u2f(pr, 'u_texel', 1 / sw, 1 / sh); if (i === 0) R.u1f(pr, 'u_thr', f.env.bloomThr);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            // blur H: a -> b, V: b -> a
            const bp = this.progs.blur; gl.useProgram(bp.p); R.u1i(bp, 'u_tex', 0);
            gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb); gl.bindTexture(gl.TEXTURE_2D, B.a);
            R.u2f(bp, 'u_dir', 1 / B.w, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindFramebuffer(gl.FRAMEBUFFER, B.fa); gl.bindTexture(gl.TEXTURE_2D, B.b);
            R.u2f(bp, 'u_dir', 0, 1 / B.h); gl.drawArrays(gl.TRIANGLES, 0, 3);
            src = B.a; sw = B.w; sh = B.h;
        }
        // ---- composite ----
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
        const cp = this.progs.comp; gl.useProgram(cp.p);
        const texs = [this.hdrTex, ...this.bloom.map(b => b.a)];
        const names = ['u_hdr', 'u_b0', 'u_b1', 'u_b2', 'u_b3', 'u_b4'];
        texs.forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); R.u1i(cp, names[i], i); });
        R.u1f(cp, 'u_exp', f.env.exposure); R.u1f(cp, 'u_bloom', f.env.bloom); R.u1f(cp, 'u_time', f.time);
        R.u2f(cp, 'u_res', w, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // leave texture units clean
        gl.activeTexture(gl.TEXTURE0);
    }
}

global.GL3D = { Renderer, G, M, V, box, plane, lathe, cylinder, sphere, capsule, limb, tube, MAXL };
})(window);
