// ==UserScript==
// @name         Warbuddy
// @namespace    https://grusmedia.no/warbuddy
// @version      0.1.46
// @description  Shows a war action queue, shared target Dibs, watched targets, and live retaliation opportunities inside Torn.
// @author       SneipLadd [2813921]
// @homepageURL  https://github.com/Grussniffer/Warbuddy
// @supportURL   https://github.com/Grussniffer/Warbuddy/issues
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/Warbuddy/main/warbuddy.meta.js
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @include      https://www.torn.com/page.php?*sid=attack*
// @include      https://torn.com/page.php?*sid=attack*
// @run-at       document-idle
// @sandbox      DOM
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      backend.grusmedia.no
// @noframes
// ==/UserScript==
