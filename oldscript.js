// ==UserScript==
// @name         GeoFS TAS to IAS
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Adds flight data display. Makes autopilot and instruments use IAS.
// @author       Ender267
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // =========================================================================
    // MODULE: PHYSICS & AUTOPILOT
    // =========================================================================

    const UPDATE_INTERVAL = 100;
    const SEA_LEVEL_DENSITY = 1.22; // Updated default density
    let initialized = false;

    // --- Physics Helpers ---

    function getPhysicsValues() {
        let ratio = 1.0;
        let sound = 661.47;

        if (typeof weather !== 'undefined' && weather.atmosphere) {
            const rho = weather.atmosphere.airDensityAtAltitude;
            const rho0 = window.AIR_DENSITY_SL || SEA_LEVEL_DENSITY;
            const tempK = weather.atmosphere.airTempAtAltitudeKelvin || 288.15;

            if (rho && rho0) ratio = Math.sqrt(rho / rho0);
            if (tempK) sound = 38.96785 * Math.sqrt(tempK);
        }
        return { ratio, sound };
    }

    function getCalculatedIAS() {
        try {
            if (typeof geofs === 'undefined' || !geofs.animation || !geofs.animation.values) return 0;
            const tas = geofs.animation.values.ktas;
            if (tas === undefined || tas === null) return geofs.animation.values.kias || 0;

            const { ratio } = getPhysicsValues();
            return tas * ratio;
        } catch (e) { return 0; }
    }

    // --- Core Wrapper Logic ---

    function runWithOverrides(fn, context, args) {
        if (!geofs.animation || !geofs.animation.values) return fn.apply(context, args);

        const origKias = geofs.animation.values.kias;
        const origKtas = geofs.animation.values.ktas;
        const ias = getCalculatedIAS();

        try {
            geofs.animation.values.kias = ias;
            geofs.animation.values.ktas = ias;
            return fn.apply(context, args);
        } catch (e) {
            return fn.apply(context, args);
        } finally {
            geofs.animation.values.kias = origKias;
            geofs.animation.values.ktas = origKtas;
        }
    }

    // --- Autopilot Logic Overrides ---

    function wrapAutopilot() {
        if (!geofs.autopilot) return;

        // 1. UPDATE LOOP: Forces AP to fly on IAS
        if (geofs.autopilot.update && !geofs.autopilot.update._wrapped) {
            const origUpdate = geofs.autopilot.update;
            let wasOn = false;

            geofs.autopilot.update = function(...args) {
                if (this.on && !wasOn) {
                    const currentIAS = getCalculatedIAS();
                    if (this.values) this.values.speed = currentIAS;
                    if (typeof this.targetSpeed !== 'undefined') this.targetSpeed = currentIAS;

                    const input = document.querySelector('.geofs-autopilot-speed-input');
                    if (input) input.value = Math.round(currentIAS);

                    console.log(`[GeoFS Fix] Autopilot ON. Initialized Target to IAS: ${currentIAS.toFixed(0)}`);
                }
                wasOn = this.on;
                return runWithOverrides(origUpdate, this, args);
            };
            geofs.autopilot.update._wrapped = true;
        }

        // 2. SET SPEED MODE: The Full Replacement
        // This replaces the function with a physics-corrected version.
        geofs.autopilot.setSpeedMode = function(e) {
            if (e != geofs.autopilot.speedMode) {

                // Calculate Physics Factors
                const { ratio, sound } = getPhysicsValues();
                const currentVal = geofs.autopilot.values.speed;

                if (e == "mach") {
                    // CONVERSION: Knots(IAS) -> Mach
                    // Math: Mach = (IAS / Ratio) / Sound
                    let correctMach = (currentVal / ratio) / sound;

                    // Safety check
                    if (isNaN(correctMach) || !isFinite(correctMach)) correctMach = 0;

                    geofs.autopilot.values.speed = Number(correctMach.toFixed(3)); // 3 decimals for Mach

                    // Original UI Logic
                    $(".geofs-autopilot-mach").addClass("numberValue").val(geofs.autopilot.values.speed);
                    $(".geofs-autopilot-knots").removeClass("numberValue");
                    $(".geofs-speed-mode .switchLeft").removeClass("green-pad");
                    $(".geofs-speed-mode .switchRight").addClass("green-pad");

                    console.log(`[GeoFS Fix] Mode -> Mach. IAS ${currentVal} -> M${correctMach.toFixed(3)}`);

                } else {
                    // CONVERSION: Mach -> Knots(IAS)
                    // Math: IAS = (Mach * Sound) * Ratio
                    let correctIAS = (currentVal * sound) * ratio;

                    // Safety check
                    if (isNaN(correctIAS) || !isFinite(correctIAS)) correctIAS = 0;

                    geofs.autopilot.values.speed = Math.round(correctIAS); // Int for Knots

                    // Original UI Logic
                    $(".geofs-autopilot-mach").removeClass("numberValue");
                    $(".geofs-autopilot-knots").addClass("numberValue").val(geofs.autopilot.values.speed);
                    $(".geofs-speed-mode .switchLeft").addClass("green-pad");
                    $(".geofs-speed-mode .switchRight").removeClass("green-pad");

                    console.log(`[GeoFS Fix] Mode -> Speed. M${currentVal} -> IAS ${Math.round(correctIAS)}`);
                }

                geofs.autopilot.speedMode = e;
            }
        };
    }

    function wrapInstruments() {
        const target = instruments || (geofs ? geofs.instruments : null);
        if (!target) return;

        const wrap = (obj, key) => {
            if (!obj || typeof obj[key] !== 'function' || obj[key]._wrapped) return;
            const orig = obj[key];
            obj[key] = function(...args) { return runWithOverrides(orig, this, args); };
            obj[key]._wrapped = true;
        };

        if (target.update) wrap(target, 'update');
        if (target.renderers) {
            for (let key in target.renderers) wrap(target.renderers, key);
        }
    }

    // --- UI Display ---

    function createDisplay() {
        const displayId = 'geofs-flight-data-display';
        if (document.getElementById(displayId)) return;

        const displayDiv = document.createElement('div');
        displayDiv.id = displayId;

        Object.assign(displayDiv.style, {
            position: 'fixed',
            top: '100px',
            left: '100px',
            width: '200px',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: '#0f0',
            padding: '8px',
            fontFamily: 'Consolas, monospace',
            fontSize: '12px',
            borderRadius: '4px',
            zIndex: '999999',
            cursor: 'move',
            userSelect: 'none',
            border: '1px solid #444',
            display: 'block'
        });

        displayDiv.innerHTML = `
            <div style="font-weight:bold; margin-bottom:6px; color:#fff; border-bottom:1px solid #555;">FLIGHT DATA</div>
            <div style="display:grid; grid-template-columns: 40px 1fr;">
                <div>IAS</div> <div style="text-align:right"><span id="fd-ias">---</span> kt</div>
                <div>TAS</div> <div style="text-align:right"><span id="fd-tas">---</span> kt</div>
                <div>GS</div>  <div style="text-align:right"><span id="fd-gs">---</span> kt</div>
                <div>M</div>   <div style="text-align:right"><span id="fd-mach">-.---</span></div>
                <div>Alt</div> <div style="text-align:right"><span id="fd-alt">---</span> ft</div>
            </div>
        `;
        document.body.appendChild(displayDiv);

        let isDragging = false;
        let startX, startY, initLeft, initTop;
        displayDiv.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = displayDiv.getBoundingClientRect();
            initLeft = rect.left;
            initTop = rect.top;
        });
        window.addEventListener('mousemove', (e) => {
            if (isDragging) {
                displayDiv.style.left = (initLeft + e.clientX - startX) + 'px';
                displayDiv.style.top = (initTop + e.clientY - startY) + 'px';
            }
        });
        window.addEventListener('mouseup', () => isDragging = false);
    }

    function updateDisplay() {
        if (!document.getElementById('geofs-flight-data-display')) createDisplay();

        try {
            if (!geofs.animation || !geofs.animation.values) return;

            const ias = getCalculatedIAS();
            const vals = geofs.animation.values;
            const gs = (vals.groundSpeed || 0) * 1.94384;

            const setText = (id, val, fix = 0) => {
                const el = document.getElementById(id);
                if (el) el.innerText = (typeof val === 'number') ? val.toFixed(fix) : '---';
            };

            setText('fd-ias', ias, 0);
            setText('fd-tas', vals.ktas, 0);
            setText('fd-gs', gs, 0);
            setText('fd-mach', vals.mach, 3);
            setText('fd-alt', vals.altitude, 0);

        } catch (e) {}
    }

    // --- Initialization ---

    function init() {
        if (typeof geofs === 'undefined' || !geofs.animation || !geofs.animation.values) return false;

        console.log("[GeoFS Fix] Initializing v15.0...");
        createDisplay();
        wrapAutopilot();
        wrapInstruments();
        setInterval(updateDisplay, UPDATE_INTERVAL);
        initialized = true;
        return true;
    }

    const bootInterval = setInterval(() => {
        if (init()) clearInterval(bootInterval);
    }, 1000);

})();