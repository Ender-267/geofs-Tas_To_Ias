// ==UserScript==
// @name         GeoFS js injector
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Inject a custom geofs.js
// @author       You
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    let replacementDone = false;

    function replaceGeoFSScript() {
        if (replacementDone) return;

        // Find the specific script element with data-deferredsrc containing /js/geofs.js
        const script = document.querySelector('script[data-deferredsrc*="/js/geofs.js"]');

        if (script && !replacementDone) {
            const originalSrc = script.getAttribute('data-deferredsrc');
            console.log('Found and replacing deferred script:', originalSrc);
            script.setAttribute('data-deferredsrc', 'https://cdn.jsdelivr.net/gh/Ender-267/geofs-Tas_To_Ias/geofs.js');
            console.log('Successfully replaced with custom script');
            replacementDone = true;
        }
    }

    // Method 3: MutationObserver as backup
    const observer = new MutationObserver(function(mutations) {
        if (!replacementDone) {
            replaceGeoFSScript();
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
})();