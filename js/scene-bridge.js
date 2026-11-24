/* =====================================================================
   SmartLux - Scene bridge
   Connects the WebGL scene (gl3d.js + scene3d.js) to the dashboard
   state in app.js.  If WebGL2 is unavailable the original CSS scene
   stays visible (progressive enhancement).
===================================================================== */
(function () {
    'use strict';
    if (!window.Scene3D || typeof state === 'undefined') return;

    const heroHost = document.getElementById('scene3dHero');
    const simHost = document.getElementById('scene3dSim');
    if (!heroHost && !simHost) return;

    let lastType = 'car';
    let on3d = false;

    let currentHost = null;
    function enable(host) {
        if (host === currentHost) return true;          // already showing here
        const ok = Scene3D.attach(host, host === heroHost ? 'hero' : 'street');
        if (ok) currentHost = host;
        if (ok && !on3d) {
            on3d = true;
            document.documentElement.classList.add('has-3d');
        }
        return ok;
    }

    /* ---- which page is showing? re-parent the single canvas ---- */
    function syncHost() {
        const active = document.querySelector('.page.active');
        if (!active) return;
        if (active.id === 'overview' && heroHost) enable(heroHost);
        else if (active.id === 'simulation' && simHost) enable(simHost);
    }
    const mo = new MutationObserver(syncHost);
    document.querySelectorAll('.page').forEach(pg => mo.observe(pg, { attributes: true, attributeFilter: ['class'] }));

    /* ---- push dashboard state into the 3D world (10 Hz) ---- */
    function push() {
        if (!on3d) return;
        const atmo = (typeof currentSceneAtmosphere !== 'undefined') ? currentSceneAtmosphere : 'auto';
        Scene3D.setEnvironment(state.ambient, atmo === 'fog' ? 'fog' : 'auto');
        Scene3D.setPoles(state.lights, 8);
    }
    setInterval(push, 100);

    /* ---- vehicles: every dashboard dispatch launches a real 3D vehicle ---- */
    if (typeof renderVehicle === 'function') {
        const _rv = renderVehicle;
        renderVehicle = function (type) { lastType = type; return _rv.apply(this, arguments); };
    }
    if (typeof triggerVehicleDrive === 'function') {
        const _td = triggerVehicleDrive;
        triggerVehicleDrive = function () {
            if (on3d && Scene3D.supported) {
                const kind = lastType === 'pedestrian' ? 'cyclist' : lastType;
                window.__lastVehicleId = Scene3D.launch(kind, {
                    reverse: (typeof isReverseTraffic !== 'undefined') && isReverseTraffic,
                    duration: (typeof isFastSpeed !== 'undefined' && isFastSpeed) ? 5 : 9
                });
            }
            return _td.apply(this, arguments);
        };
    }

    /* ---- camera + zoom buttons (data-cam / data-cam-zoom are handled by Scene3D) ---- */
    document.querySelectorAll('.cam-bar [data-cam]').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('.cam-bar [data-cam]').forEach(x => x.classList.toggle('active', x === b));
        });
    });

    /* ---- hero time-of-day chips drive the real dashboard buttons ---- */
    document.querySelectorAll('[data-hero-env]').forEach(b => {
        b.addEventListener('click', () => {
            const target = document.getElementById(b.dataset.heroEnv);
            if (target) target.click();
            document.querySelectorAll('[data-hero-env]').forEach(x => x.classList.toggle('active', x === b));
        });
    });

    /* ---- boot: open at dusk so the lamps are already working ---- */
    if (typeof setAmbient === 'function' && state.ambient === 100) setAmbient(45, 'dusk');
    syncHost();
    // ambient traffic so the hero never looks empty
    setTimeout(() => { if (on3d) Scene3D.launch('car', { duration: 11 }); }, 1200);
    setInterval(() => {
        const a = document.querySelector('.page.active');
        if (!on3d || !a || a.id !== 'overview') return;
        const r = Math.random();
        Scene3D.launch(r > 0.8 ? 'truck' : 'car', { duration: 10 + Math.random() * 5, reverse: Math.random() > 0.5 });
    }, 5200);
})();
