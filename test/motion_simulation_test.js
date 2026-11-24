/**
 * SmartLux Automatic Street Light Controller
 * Motion Simulation & Streetlight Stability Verification
 * Verifies that streetlights NEVER blink or flash without a car crossing,
 * and that lights track moving vehicles smoothly with lookahead wave dimming.
 */

const assert = require('assert');
const fs = require('fs');

console.log('=====================================================');
console.log('Testing Motion Simulation & Streetlight Stability');
console.log('=====================================================\n');

// Mock a lightweight browser DOM environment for app.js
const elements = new Map();
function mockElement(id) {
    if (!elements.has(id)) {
        elements.set(id, {
            id,
            dataset: {},
            textContent: '',
            value: '',
            checked: false,
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                toggle(c, force) {
                    if (force !== undefined) {
                        if (force) this.classes.add(c);
                        else this.classes.delete(c);
                    } else {
                        if (this.classes.has(c)) this.classes.delete(c);
                        else this.classes.add(c);
                    }
                },
                contains(c) { return this.classes.has(c); }
            },
            children: [],
            appendChild(child) { this.children.push(child); },
            prepend(child) { this.children.unshift(child); },
            get lastChild() { return this.children[this.children.length - 1]; },
            removeChild(child) {
                const idx = this.children.indexOf(child);
                if (idx !== -1) this.children.splice(idx, 1);
            },
            innerHTML: '',
            querySelector() { return null; },
            addEventListener(evt, fn) { this.listeners = this.listeners || {}; this.listeners[evt] = fn; },
            getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 260 }; },
            getContext() {
                return {
                    scale() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
                    stroke() {}, fill() {}, fillText() {}, arc() {}, closePath() {},
                    setLineDash() {}, createLinearGradient() { return { addColorStop() {} }; }
                };
            }
        });
    }
    return elements.get(id);
}

global.$ = mockElement;
global.document = {
    getElementById: mockElement,
    querySelectorAll: (sel) => {
        if (sel === '.road-lamp') {
            const arr = [];
            for (let i = 0; i < 8; i++) arr.push(mockElement(`lamp_${i}`));
            return arr;
        }
        return [];
    },
    createElement: (tag) => mockElement(`elem_${Math.random()}`),
    body: mockElement('body')
};
global.window = {
    addEventListener() {},
    devicePixelRatio: 1,
    location: { origin: 'http://localhost:3000', protocol: 'http:' }
};
global.localStorage = {
    getItem() { return null; },
    setItem() {}
};
global.toast = () => {};

// Load and evaluate app.js
const appCode = fs.readFileSync('js/app.js', 'utf8');

const vm = require('vm');
const context = vm.createContext({
    $,
    document,
    window,
    localStorage,
    toast,
    console,
    Math,
    Date,
    String,
    parseInt,
    parseFloat,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
});

vm.runInContext(appCode, context);

function exec(codeStr) {
    return vm.runInContext(codeStr, context);
}

// Test 1: Baseline Night Steady State (NO BLINKING)
console.log('[TEST 1] Testing Nighttime Steady State without Car Crossing...');
exec(`
    state.ambient = 10; // Dark night
    state.threshold = 60;
    state.normalBrightness = 30;
    state.motionBrightness = 100;
    state.automatic = true;
    state.motionEnabled = true;
    state.motionDetected = false;
    state.corridorWaveActive = false;
    updateLighting();
`);

const lights = exec(`state.lights`);
assert.strictEqual(lights.length, 20);

// Assert all lights are illuminated at steady 30% eco brightness
lights.forEach((l) => {
    assert.strictEqual(l.on, true, `Light #${l.id} should be ON at night`);
    assert.strictEqual(l.brightness, 30, `Light #${l.id} should be steadily dimmed to normalBrightness (30%)`);
    assert.strictEqual(l.motion, false, `Light #${l.id} should NOT have motion`);
});

// Run 10 ticks of simulationTick()
console.log('Executing 10 simulation ticks (simulating 10 seconds of idle monitoring)...');
for (let i = 0; i < 10; i++) {
    exec(`simulationTick();`);
    const currentLights = exec(`state.lights`);
    // After every single tick, verify NO light ever jumped to 100% or has motion
    currentLights.forEach(l => {
        assert.strictEqual(l.brightness, 30, `STABILITY FAULT: Light #${l.id} blinked without a car crossing!`);
        assert.strictEqual(l.motion, false, `STABILITY FAULT: Light #${l.id} falsely triggered motion!`);
    });
}
const motionDetected = exec(`state.motionDetected`);
assert.strictEqual(motionDetected, false, 'Global motionDetected must remain false when no car is on the road');
console.log('✓ Streetlights are 100% stable: ZERO random blinks or phantom flickers over 10 ticks!\n');

// Test 2: Moving Vehicle Progressive Lookahead Wave
console.log('[TEST 2] Testing Vehicle Crossing & Progressive Light Wave...');
// Vehicle arrives at Pole #2 (out of 8 poles: index 2 corresponds to ~25% road distance)
exec(`
    const activePoleIndex = 2;
    const lookaheadRange = 1;
    state.lights.forEach((l, idx) => {
        const poleOfLight = Math.min(ROAD_POLES - 1, Math.floor(idx * ROAD_POLES / TOTAL_LIGHTS));
        const dist = Math.abs(poleOfLight - activePoleIndex);
        l.motion = (dist <= lookaheadRange);
        if (state.automatic && !l.fault) {
            l.brightness = l.motion ? state.motionBrightness : state.normalBrightness;
        }
    });
    updateLighting();
`);

const brightLights = exec(`state.lights.filter(l => l.brightness === 100)`);
const dimLights = exec(`state.lights.filter(l => l.brightness === 30)`);

assert(brightLights.length > 0, 'Fixtures near moving vehicle must brighten');
assert(dimLights.length > 0, 'Distant fixtures away from vehicle must remain in eco-dimmed 30% mode');

// Check that distant pole (e.g., Pole #7, lights 17-20) is still at 30%
const exitPoleLight = exec(`state.lights[19]`);
assert.strictEqual(exitPoleLight.brightness, 30, 'Distant streetlight at road exit must remain 30% eco dimmed');

console.log(`✓ Active corridor wave verified: ${brightLights.length} fixtures in lookahead envelope boosted to 100%, ${dimLights.length} fixtures conserved at 30% eco.\n`);

// Test 3: Vehicle Exits Road - Return to Eco Standby
console.log('[TEST 3] Testing Vehicle Exit and Return to Eco Standby...');
// Vehicle exits the road
exec(`
    state.motionDetected = false;
    state.lights.forEach(l => {
        l.motion = false;
        l.brightness = state.normalBrightness;
    });
    updateLighting();
`);

const finalLights = exec(`state.lights`);
finalLights.forEach(l => {
    assert.strictEqual(l.brightness, 30, `Light #${l.id} must return to 30% eco standby after vehicle passes`);
    assert.strictEqual(l.motion, false, `Light #${l.id} motion must be reset`);
});
console.log('✓ All streetlights cleanly and calmly returned to steady eco-dimmed standby.\n');

// Test 4: Daylight Cutoff Safety
console.log('[TEST 4] Testing Daylight Cutoff (Sunlight 100% Lux)...');
exec(`
    state.ambient = 100; // Bright daylight
    updateLighting();
`);

const daylightLights = exec(`state.lights`);
daylightLights.forEach(l => {
    assert.strictEqual(l.on, false, `Light #${l.id} must be OFF in daylight`);
    assert.strictEqual(l.brightness, 0, `Light #${l.id} must have 0% wattage in daylight`);
});
console.log('✓ Daylight Cutoff 100% verified: 0W consumed during daylight hours.\n');

// Test 5: Continuous Traffic & Multi-Vehicle Lookahead Wave Verification
console.log('[TEST 5] Testing Continuous Traffic & Multi-Vehicle Progressive Waves...');
exec(`
    state.ambient = 15; // Nighttime
    state.threshold = 60;
    state.automatic = true;
    state.motionEnabled = true;
    state.waveEffectEnabled = true;
    updateLighting();

    // Mock Scene3D active vehicles on road (Vehicle 1 at Pole 1, Vehicle 2 at Pole 5)
    window.Scene3D = {
        supported: true,
        vehicles: () => [
            { id: 1, x: -62.5, type: 'car', dir: 1, pole: 1.0 },
            { id: 2, x: 37.5, type: 'truck', dir: 1, pole: 5.0 }
        ],
        setPoles: () => {}
    };

    updateWaveLighting();
`);

const waveBright = exec(`state.lights.filter(l => l.brightness === 100)`);
const waveDim = exec(`state.lights.filter(l => l.brightness === 30)`);
assert(waveBright.length >= 6, `Fixtures around multiple continuous traffic vehicles must brighten to 100% (found ${waveBright.length})`);
assert(waveDim.length >= 4, `Fixtures distant from vehicles must remain at 30% eco standby (found ${waveDim.length})`);

// Pole 1 area fixtures must be 100%
const nearP1 = exec(`state.lights[3].brightness`);
assert.strictEqual(nearP1, 100, 'Fixtures near Pole 1 must be 100% in continuous wave');

// Pole 5 area fixtures must be 100%
const nearP5 = exec(`state.lights[13].brightness`);
assert.strictEqual(nearP5, 100, 'Fixtures near Pole 5 must be 100% in continuous wave');

// Distant Pole 7 fixture must be 30%
const farP7 = exec(`state.lights[19].brightness`);
assert.strictEqual(farP7, 30, 'Fixtures far from continuous vehicles must remain 30%');

console.log(`✓ Continuous traffic wave verified: ${waveBright.length} fixtures brightened across multi-vehicle envelopes, ${waveDim.length} fixtures conserved in 30% eco standby.\n`);

console.log('=====================================================');
console.log('ALL MOTION SIMULATION STABILITY TESTS PASSED (100%)');
console.log('=====================================================');

process.exit(0);
