(function(){

const GITHUB_OWNER = 'Simply-Vanilla';
const GITHUB_REPO = '50th';
const GITHUB_BRANCH = 'main';
const CROPS_FILE = 'crops.json';
const PENDING_KEY = 'pendingCrops';
const PENDING_DIRTY_KEY = 'pendingCropsDirtyKeys';

let cropsCache = null;
let dirtyKeys = new Set();
let editMode = false;
let onSavedCallback = null;

let cropper = null;
let currentKey = null;
let currentYear = null;
let sameForBoth = true;
let squareLock = false;
let activeTab = 'grid';
let cropData = { grid: null, timeline: null };
let adjust = { brightness: 100, contrast: 100, saturation: 100, rotate: 0 };
let originalSrc = null;
let originalImgEl = null;
let originalImgReady = null;
let rotateBakeTimer = null;

// ---------------------------------------------------------------------
// Data loading / local batching / publishing
// ---------------------------------------------------------------------

async function loadCrops(){
    if(cropsCache) return cropsCache;

    let serverCrops = {};
    try {
        // `cache: 'no-store'` only stops the browser's own cache from being
        // used - it does nothing about GitHub Pages' CDN, which caches by
        // URL independent of that header. A timestamp query string forces a
        // real cache miss all the way to origin every time.
        const res = await fetch(`${CROPS_FILE}?t=${Date.now()}`, { cache: 'no-store' });
        serverCrops = res.ok ? await res.json() : {};
    } catch(e){
        serverCrops = {};
    }

    const pendingRaw = sessionStorage.getItem(PENDING_KEY);
    if(pendingRaw){
        try {
            cropsCache = JSON.parse(pendingRaw);
            const dirtyRaw = sessionStorage.getItem(PENDING_DIRTY_KEY);
            dirtyKeys = new Set(dirtyRaw ? JSON.parse(dirtyRaw) : []);
        } catch(e){
            cropsCache = serverCrops;
            dirtyKeys = new Set();
        }
    } else {
        cropsCache = serverCrops;
        dirtyKeys = new Set();
    }

    return cropsCache;
}

function persistPending(){
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(cropsCache));
    sessionStorage.setItem(PENDING_DIRTY_KEY, JSON.stringify(Array.from(dirtyKeys)));
}

function clearPending(){
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_DIRTY_KEY);
}

function markDirty(key){
    dirtyKeys.add(key);
    persistPending();
    updatePublishButton();
}

function getToken(){
    return sessionStorage.getItem('ghToken') || '';
}

function setToken(t){
    if(t) sessionStorage.setItem('ghToken', t);
    else sessionStorage.removeItem('ghToken');
}

function toBase64Utf8(str){
    return btoa(unescape(encodeURIComponent(str)));
}

async function fetchCurrentSha(token){
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CROPS_FILE}?ref=${GITHUB_BRANCH}`;
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if(res.status === 404) return null;
    if(!res.ok) throw new Error(`GitHub API error (${res.status}) reading current file`);
    const data = await res.json();
    return data.sha;
}

async function saveCropsToGitHub(updatedCrops, message){
    const token = getToken();
    if(!token) throw new Error('No GitHub token set.');

    const sha = await fetchCurrentSha(token);

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${CROPS_FILE}`;
    const body = {
        message: message || 'Update photo crops',
        content: toBase64Utf8(JSON.stringify(updatedCrops, null, 2)),
        branch: GITHUB_BRANCH
    };
    if(sha) body.sha = sha;

    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if(!res.ok){
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `GitHub API error (${res.status})`);
    }

    return res.json();
}

async function fetchFileSha(path){
    const token = getToken();
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if(res.status === 404) return null;
    if(!res.ok) throw new Error(`GitHub API error (${res.status}) looking up ${path}`);
    const data = await res.json();
    return data.sha;
}

async function deleteFileFromGitHub(path, sha, message){
    const token = getToken();
    if(!token) throw new Error('No GitHub token set.');

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
    const res = await fetch(url, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, sha, branch: GITHUB_BRANCH })
    });

    if(!res.ok){
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `GitHub API error (${res.status})`);
    }

    return res.json();
}

async function uploadPhotoBytes(path, base64Content, message){
    const token = getToken();
    if(!token) throw new Error('No GitHub token set.');

    const sha = await fetchFileSha(path);
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
    const body = { message, content: base64Content, branch: GITHUB_BRANCH };
    if(sha) body.sha = sha;

    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if(!res.ok){
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `GitHub API error (${res.status})`);
    }

    return res.json();
}

async function publishChanges(){
    if(dirtyKeys.size === 0) return;
    if(!getToken()){ openTokenModal(); return; }

    const btn = document.getElementById('ctPublishBtn');
    btn.disabled = true;
    const count = dirtyKeys.size;
    btn.textContent = 'Publishing…';

    try {
        await saveCropsToGitHub(cropsCache, `Update ${count} photo crop${count === 1 ? '' : 's'}`);
        dirtyKeys.clear();
        clearPending();
        btn.textContent = 'Published ✓';
        setTimeout(updatePublishButton, 1400);
    } catch(e){
        btn.textContent = 'Publish failed — retry';
        alert('Publish failed: ' + e.message);
    } finally {
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Applying a saved crop to an <img> inside a sized wrapper
// ---------------------------------------------------------------------

function applyCrop(imgEl, wrapperEl, crop){
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    if(!nw || !nh) return false;
    const W = wrapperEl.clientWidth, H = wrapperEl.clientHeight;
    if(W <= 0 || H <= 0) return false;

    const cropPxW = crop.w * nw;
    const cropPxH = crop.h * nh;
    if(cropPxW <= 0 || cropPxH <= 0) return false;

    const s = Math.max(W / cropPxW, H / cropPxH);

    imgEl.style.position = 'absolute';
    imgEl.style.maxWidth = 'none';
    imgEl.style.maxHeight = 'none';
    imgEl.style.width = (nw * s) + 'px';
    imgEl.style.height = (nh * s) + 'px';
    imgEl.style.left = ((W - cropPxW * s) / 2 - crop.x * nw * s) + 'px';
    imgEl.style.top = ((H - cropPxH * s) / 2 - crop.y * nh * s) + 'px';

    return true;
}

function getYearPhotoNumber(crops, year){
    return (crops._yearPhoto && crops._yearPhoto[year]) || 1;
}

// Builds a photo's URL with a cache-busting version query string when one has
// been stamped (see handleSave) - without this, editing a photo whose crop
// key already exists on the page would keep showing the old cached bytes
// indefinitely, since the filename itself never changes.
function photoUrl(crops, key){
    const ver = crops._photoVersion && crops._photoVersion[key];
    return `photos/${key}.jpg` + (ver ? `?v=${ver}` : '');
}

// Sizes wrapperEl to the largest box of the crop's aspect ratio that fits
// within maxW x maxH (a "contain" fit), then positions the image inside it
// via applyCrop. Used by the lightbox, where the target box isn't fixed
// ahead of time the way a grid cell or timeline row is.
function applyCropFit(imgEl, wrapperEl, crop, maxW, maxH){
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    if(!nw || !nh) return false;

    const cropPxW = crop.w * nw;
    const cropPxH = crop.h * nh;
    if(cropPxW <= 0 || cropPxH <= 0) return false;

    const cropAspect = cropPxW / cropPxH;
    let w = maxW, h = w / cropAspect;
    if(h > maxH){ h = maxH; w = h * cropAspect; }

    wrapperEl.style.width = w + 'px';
    wrapperEl.style.height = h + 'px';

    return applyCrop(imgEl, wrapperEl, crop);
}

function getYearOrder(crops, year, availableNums){
    const stored = (crops._yearOrder && crops._yearOrder[String(year)]) || [];
    const validStored = stored.filter(n => availableNums.includes(n));
    const missing = availableNums.filter(n => !validStored.includes(n)).sort((a, b) => a - b);
    return validStored.concat(missing);
}

async function setYearOrder(year, order){
    const crops = await loadCrops();
    const natural = order.slice().sort((a, b) => a - b);
    const isNatural = order.every((v, i) => v === natural[i]);

    if(!crops._yearOrder) crops._yearOrder = {};
    if(isNatural){
        delete crops._yearOrder[String(year)];
        if(Object.keys(crops._yearOrder).length === 0) delete crops._yearOrder;
    } else {
        crops._yearOrder[String(year)] = order;
    }
    markDirty(`_yearOrder:${year}`);
}

// ---------------------------------------------------------------------
// Injected UI: styles + markup
// ---------------------------------------------------------------------

function injectStyles(){
    const style = document.createElement('style');
    style.textContent = `
.ct-edit-toggle{
    position:fixed;
    top:80px;
    left:24px;
    z-index:100;
    width:44px;
    height:44px;
    border:none;
    border-radius:50%;
    display:flex;
    align-items:center;
    justify-content:center;
    background:var(--control-bg);
    backdrop-filter:blur(6px);
    box-shadow:0 6px 20px rgba(0,0,0,.08);
    font-size:16px;
    cursor:pointer;
    color:var(--control-text);
    transition:background-color .3s ease, color .3s ease, transform .2s ease, opacity .2s ease;
}
.ct-edit-toggle:hover{ transform:scale(1.08); }
.ct-edit-toggle.ct-active{ background:#c9a227; color:#1a1a1a; }

body.ct-edit-mode .photo,
body.ct-edit-mode .photo-box.has-photo{
    outline:2px dashed var(--muted);
    outline-offset:2px;
    cursor:crosshair;
}

body.ct-edit-mode .photo{
    cursor:grab;
}

.ct-dragging{
    opacity:.35;
}

body.ct-modal-active .theme-toggle,
body.ct-modal-active .height-control,
body.ct-modal-active .size-control,
body.ct-modal-active .ct-edit-toggle{
    opacity:0;
    pointer-events:none;
}

.ct-overlay, .ct-token-overlay{
    position:fixed;
    inset:0;
    z-index:400;
    display:none;
    align-items:center;
    justify-content:center;
    padding:30px 20px;
    background:rgba(0,0,0,.85);
}
.ct-overlay.open, .ct-token-overlay.open{ display:flex; }

.ct-modal{
    position:relative;
    width:min(560px,94vw);
    max-height:90vh;
    overflow-y:auto;
    background:var(--bg);
    color:var(--text);
    border-radius:10px;
    padding:28px;
    box-shadow:0 30px 70px rgba(0,0,0,.5);
}

.ct-close{
    position:absolute;
    top:14px;
    right:14px;
    width:32px;
    height:32px;
    border:none;
    border-radius:50%;
    background:rgba(128,128,128,.2);
    color:var(--text);
    font-size:20px;
    line-height:1;
    cursor:pointer;
}

.ct-title{
    font-family:"Cormorant Garamond",serif;
    font-weight:400;
    font-size:24px;
    margin-bottom:16px;
    padding-right:30px;
}

.ct-checks{
    display:flex;
    flex-wrap:wrap;
    gap:6px 20px;
    margin-bottom:14px;
}

.ct-check{
    display:flex;
    align-items:center;
    gap:8px;
    font-size:13px;
    color:var(--muted);
    cursor:pointer;
}

.ct-tabs{
    display:flex;
    gap:8px;
    margin-bottom:14px;
}

.ct-tab{
    flex:1;
    padding:8px 10px;
    border:1px solid var(--border);
    background:transparent;
    color:var(--muted);
    border-radius:6px;
    font-size:12px;
    letter-spacing:1px;
    text-transform:uppercase;
    cursor:pointer;
}

.ct-tab.active{
    border-color:var(--heading);
    color:var(--heading);
}

.ct-grid-photo{
    display:flex;
    align-items:center;
    gap:8px;
    font-size:12px;
    color:var(--muted);
    margin-bottom:14px;
    padding:10px 12px;
    border:1px solid var(--border);
    border-radius:6px;
    cursor:pointer;
}

.ct-mode-label{
    font-size:11px;
    letter-spacing:.08em;
    text-transform:uppercase;
    color:var(--muted);
    margin-bottom:10px;
}

.ct-cropper-wrap{
    --ct-filter:none;
    max-height:55vh;
    margin-bottom:16px;
    background:#000;
    border-radius:6px;
    overflow:hidden;
}

.ct-cropper-wrap img{
    display:block;
    max-width:100%;
}

.ct-cropper-wrap .cropper-canvas img,
.ct-cropper-wrap .cropper-view-box img{
    filter:var(--ct-filter);
}

.ct-adjust{
    display:flex;
    flex-direction:column;
    gap:10px;
    margin-bottom:16px;
}

.ct-adjust-row{
    display:grid;
    grid-template-columns:88px 1fr 44px;
    align-items:center;
    gap:10px;
    font-size:12px;
    color:var(--muted);
}

.ct-adjust-row input[type=range]{
    width:100%;
    accent-color:#c9a227;
}

.ct-adjust-val{
    text-align:right;
    font-variant-numeric:tabular-nums;
}

.ct-adjust-reset{
    align-self:flex-end;
    background:none;
    border:none;
    color:var(--muted);
    font-size:11px;
    text-decoration:underline;
    cursor:pointer;
    padding:0;
}

.ct-actions{
    display:flex;
    align-items:center;
    justify-content:flex-end;
    gap:10px;
}

.ct-actions-spacer{
    flex:1;
}

.ct-btn{
    padding:10px 18px;
    border-radius:6px;
    border:1px solid var(--border);
    background:transparent;
    color:var(--text);
    font-size:13px;
    letter-spacing:.5px;
    cursor:pointer;
}

.ct-btn-primary{
    background:var(--heading);
    color:var(--bg);
    border-color:var(--heading);
}

.ct-btn-primary:disabled{ opacity:.6; cursor:default; }

.ct-btn-danger{
    color:#b3432f;
    border-color:#b3432f;
    background:transparent;
}

.ct-btn-danger:hover{
    background:#b3432f;
    color:#fff;
}

.ct-btn-danger:disabled{ opacity:.6; cursor:default; }

.ct-status{
    margin-top:12px;
    font-size:13px;
    color:var(--muted);
    text-align:right;
}

.ct-change-token{
    display:block;
    margin-top:14px;
    font-size:11px;
    color:var(--muted);
    text-decoration:underline;
    cursor:pointer;
    text-align:right;
}

.ct-help{
    font-size:13px;
    color:var(--muted);
    line-height:1.6;
    margin-bottom:16px;
}

.ct-token-input{
    width:100%;
    padding:10px 12px;
    border-radius:6px;
    border:1px solid var(--border);
    background:transparent;
    color:var(--text);
    font-size:14px;
    margin-bottom:16px;
}

.ct-publish-btn{
    position:fixed;
    bottom:28px;
    left:50%;
    transform:translateX(-50%);
    z-index:250;
    display:none;
    padding:13px 26px;
    border:none;
    border-radius:30px;
    background:#c9a227;
    color:#1a1a1a;
    font-size:12px;
    letter-spacing:1.5px;
    text-transform:uppercase;
    cursor:pointer;
    box-shadow:0 12px 32px rgba(0,0,0,.35);
}

.ct-publish-btn:disabled{ opacity:.7; cursor:default; }

@media(max-width:900px){
.ct-edit-toggle{
    top:60px;
    left:14px;
    width:38px;
    height:38px;
    font-size:14px;
}
.ct-publish-btn{
    bottom:16px;
    padding:11px 20px;
    font-size:11px;
}
}
`;
    document.head.appendChild(style);
}

function injectMarkup(){
    const wrap = document.createElement('div');
    wrap.innerHTML = `
<button class="ct-edit-toggle" id="ctEditToggle" aria-label="Toggle photo editing" title="Edit photo crops">&#9998;</button>

<button class="ct-publish-btn" id="ctPublishBtn" type="button"></button>

<div class="ct-overlay" id="ctOverlay">
  <div class="ct-modal">
    <button class="ct-close" id="ctClose" aria-label="Close">&times;</button>
    <div class="ct-title" id="ctTitle">Edit Crop</div>

    <label class="ct-grid-photo">
      <input type="checkbox" id="ctGridPhotoToggle">
      <span>Use this photo as the Grid View photo for <strong id="ctGridPhotoYear"></strong></span>
    </label>

    <div class="ct-checks" id="ctSameRow">
      <label class="ct-check">
        <input type="checkbox" id="ctSameToggle">
        Use the same crop for both views
      </label>
      <label class="ct-check">
        <input type="checkbox" id="ctSquareToggle">
        Square crop
      </label>
    </div>

    <div class="ct-tabs" id="ctTabs" style="display:none;">
      <button class="ct-tab active" data-target="grid" type="button">Grid View</button>
      <button class="ct-tab" data-target="timeline" type="button">Timeline View</button>
    </div>

    <div class="ct-mode-label" id="ctModeLabel"></div>

    <div class="ct-cropper-wrap">
      <img id="ctImage" src="" alt="">
    </div>

    <div class="ct-adjust">
      <label class="ct-adjust-row">
        <span>Brightness</span>
        <input type="range" id="ctBrightness" min="50" max="150" value="100">
        <span class="ct-adjust-val" id="ctBrightnessVal">100%</span>
      </label>
      <label class="ct-adjust-row">
        <span>Contrast</span>
        <input type="range" id="ctContrast" min="50" max="150" value="100">
        <span class="ct-adjust-val" id="ctContrastVal">100%</span>
      </label>
      <label class="ct-adjust-row">
        <span>Saturation</span>
        <input type="range" id="ctSaturation" min="0" max="200" value="100">
        <span class="ct-adjust-val" id="ctSaturationVal">100%</span>
      </label>
      <label class="ct-adjust-row">
        <span>Straighten</span>
        <input type="range" id="ctRotate" min="-45" max="45" value="0" step="0.5">
        <span class="ct-adjust-val" id="ctRotateVal">0&deg;</span>
      </label>
      <button class="ct-adjust-reset" id="ctAdjustReset" type="button">Reset adjustments</button>
    </div>

    <div class="ct-actions">
      <button class="ct-btn ct-btn-danger" id="ctDeleteBtn" type="button">Delete Photo</button>
      <div class="ct-actions-spacer"></div>
      <button class="ct-btn" id="ctResetBtn" type="button">Reset Crop</button>
      <button class="ct-btn ct-btn-primary" id="ctSaveBtn" type="button">Save</button>
    </div>

    <div class="ct-status" id="ctStatus"></div>
    <div class="ct-change-token" id="ctChangeToken">Change GitHub token</div>
  </div>
</div>

<div class="ct-token-overlay" id="ctTokenOverlay">
  <div class="ct-modal">
    <button class="ct-close" id="ctTokenClose" aria-label="Close">&times;</button>
    <div class="ct-title">Connect GitHub</div>
    <p class="ct-help">
      Paste a GitHub personal access token with write access to
      ${GITHUB_OWNER}/${GITHUB_REPO}. Use a fine-grained token scoped
      to just this repo with "Contents: Read and write" permission.
      It's stored only in this browser tab's session and is never
      saved to the repo or sent anywhere except api.github.com.
    </p>
    <input type="password" id="ctTokenInput" class="ct-token-input" placeholder="github_pat_...">
    <div class="ct-actions">
      <button class="ct-btn" id="ctTokenCancel" type="button">Cancel</button>
      <button class="ct-btn ct-btn-primary" id="ctTokenSave" type="button">Connect</button>
    </div>
  </div>
</div>
`;
    while(wrap.firstChild) document.body.appendChild(wrap.firstChild);
}

// ---------------------------------------------------------------------
// Crop editor behavior
// ---------------------------------------------------------------------

function clamp01(v){ return Math.max(0, Math.min(1, v)); }

function rectsEqual(a, b){
    if(!a || !b) return false;
    return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001 &&
           Math.abs(a.w - b.w) < 0.001 && Math.abs(a.h - b.h) < 0.001;
}

function isGridPhoto(){
    return document.getElementById('ctGridPhotoToggle').checked;
}

function defaultAdjust(){
    return { brightness: 100, contrast: 100, saturation: 100, rotate: 0 };
}

function isAdjustDefault(a){
    return a.brightness === 100 && a.contrast === 100 && a.saturation === 100 && Math.abs(a.rotate) < 0.01;
}

function filterCss(a){
    return `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%)`;
}

function rotatedCanvasSize(w, h, deg){
    const rad = deg * Math.PI / 180;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    return { w: Math.round(w * cos + h * sin), h: Math.round(w * sin + h * cos) };
}

// Canvas ctx.filter (used for a CSS-filter-based bake) is unreliable across
// real-world browsers/webviews - some silently no-op it rather than erroring,
// which would produce a "successful" save with unchanged pixels. Applying
// brightness/contrast/saturation as plain per-pixel math via
// getImageData/putImageData works everywhere Canvas 2D does.
function applyAdjustPixels(ctx, w, h, a){
    if(a.brightness === 100 && a.contrast === 100 && a.saturation === 100) return;
    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const bf = a.brightness / 100;
    const cf = a.contrast / 100;
    const sf = a.saturation / 100;
    for(let i = 0; i < d.length; i += 4){
        let r = d[i] * bf, g = d[i + 1] * bf, b = d[i + 2] * bf;
        r = (r - 128) * cf + 128;
        g = (g - 128) * cf + 128;
        b = (b - 128) * cf + 128;
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = gray + (r - gray) * sf;
        g = gray + (g - gray) * sf;
        b = gray + (b - gray) * sf;
        d[i] = Math.max(0, Math.min(255, r));
        d[i + 1] = Math.max(0, Math.min(255, g));
        d[i + 2] = Math.max(0, Math.min(255, b));
    }
    ctx.putImageData(imgData, 0, 0);
}

// Draws imgEl onto an offscreen canvas rotated by a.rotate degrees (enlarging
// the canvas to fit the rotated bounds, exposed corners filled white), with
// brightness/contrast/saturation baked in via applyAdjustPixels when
// includeFilter is true. Used both for the live "straighten" working image
// (rotate only) and the final full-quality bake uploaded on Save.
function bakeCanvas(imgEl, a, includeFilter){
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    const rad = a.rotate * Math.PI / 180;
    const size = rotatedCanvasSize(nw, nh, a.rotate);
    const canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.translate(size.w / 2, size.h / 2);
    ctx.rotate(rad);
    ctx.drawImage(imgEl, -nw / 2, -nh / 2, nw, nh);
    if(includeFilter) applyAdjustPixels(ctx, size.w, size.h, a);
    return canvas;
}

function updateFilterPreview(){
    const wrap = document.querySelector('.ct-cropper-wrap');
    if(wrap) wrap.style.setProperty('--ct-filter', filterCss(adjust));
}

function syncAdjustSliders(){
    document.getElementById('ctBrightness').value = adjust.brightness;
    document.getElementById('ctContrast').value = adjust.contrast;
    document.getElementById('ctSaturation').value = adjust.saturation;
    document.getElementById('ctRotate').value = adjust.rotate;
    document.getElementById('ctBrightnessVal').textContent = adjust.brightness + '%';
    document.getElementById('ctContrastVal').textContent = adjust.contrast + '%';
    document.getElementById('ctSaturationVal').textContent = adjust.saturation + '%';
    document.getElementById('ctRotateVal').textContent = adjust.rotate + '°';
}

// Rotating changes the image's pixel dimensions (enlarged bounding box), so
// any in-progress crop selection is invalidated - drop it and let the user
// re-frame against the new geometry rather than silently misapplying stale
// coordinates.
async function rebuildGeometry(){
    const img = document.getElementById('ctImage');
    if(Math.abs(adjust.rotate) < 0.01){
        img.onload = () => initCropper();
        img.src = originalSrc;
        return;
    }
    await originalImgReady;
    cropData = { grid: null, timeline: null };
    const canvas = bakeCanvas(originalImgEl, { ...adjust, brightness: 100, contrast: 100, saturation: 100 }, false);
    img.onload = () => initCropper({ restoreExisting: false });
    img.src = canvas.toDataURL('image/png');
}

function canvasToBase64Jpeg(canvas, quality){
    return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

// Refreshes any on-page <img> already showing this photo so an uploaded
// pixel adjustment is visible immediately, without waiting on browser cache
// expiry or a full reload.
function cacheBustPhoto(key){
    const suffix = `photos/${key}.jpg`;
    document.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || '';
        if(src.split('?')[0].endsWith(suffix)){
            img.src = suffix + '?ct=' + Date.now();
        }
    });
}

// Grid View always renders into a square cell, so any crop that will be
// saved into the "grid" slot must itself be square - otherwise grid.html's
// cover-fit math and the editor's own aspect-locked Cropper box each
// reconcile the mismatch differently, and the two visibly disagree. That
// applies to the dedicated Grid tab, and to "same for both" mode (since
// that single rect gets saved into "grid" too) - but the independent
// Timeline tab is free-form, same as a non-grid-designated photo.
function currentAspect(){
    if(squareLock) return 1;
    if(!isGridPhoto()) return NaN;
    if(sameForBoth) return 1;
    return activeTab === 'grid' ? 1 : NaN;
}

function captureCurrentRect(){
    if(!cropper) return null;
    const img = document.getElementById('ctImage');
    const data = cropper.getData(true);
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if(!nw || !nh) return null;
    return {
        x: clamp01(data.x / nw),
        y: clamp01(data.y / nh),
        w: clamp01(data.width / nw),
        h: clamp01(data.height / nh)
    };
}

function captureIntoCropData(){
    const rect = captureCurrentRect();
    if(!rect) return;
    if(!isGridPhoto()) cropData.timeline = rect;
    else if(sameForBoth) cropData.grid = rect;
    else cropData[activeTab] = rect;
}

function initCropper(opts){
    const restoreExisting = !opts || opts.restoreExisting !== false;
    if(cropper){ cropper.destroy(); cropper = null; }
    const img = document.getElementById('ctImage');
    cropper = new Cropper(img, {
        aspectRatio: currentAspect(),
        viewMode: 1,
        autoCropArea: 0.9,
        background: false,
        ready(){
            if(!restoreExisting) return;
            let existingRect;
            if(!isGridPhoto()) existingRect = cropData.timeline;
            else existingRect = sameForBoth ? (cropData.grid || cropData.timeline) : cropData[activeTab];
            if(existingRect){
                const nw = img.naturalWidth, nh = img.naturalHeight;
                cropper.setData({
                    x: existingRect.x * nw,
                    y: existingRect.y * nh,
                    width: existingRect.w * nw,
                    height: existingRect.h * nh
                });
            }
        }
    });
}

function setActiveTab(tab){
    captureIntoCropData();
    activeTab = tab;
    document.querySelectorAll('.ct-tab').forEach(b => b.classList.toggle('active', b.dataset.target === tab));
    initCropper();
}

function updateGridPhotoUI(){
    const gridPhoto = isGridPhoto();
    const sameRow = document.getElementById('ctSameRow');
    const modeLabel = document.getElementById('ctModeLabel');

    if(!gridPhoto){
        sameRow.style.display = 'none';
        document.getElementById('ctTabs').style.display = 'none';
        modeLabel.textContent = 'Timeline View Crop';
        modeLabel.style.display = 'block';
    } else {
        sameRow.style.display = 'flex';
        if(sameForBoth){
            document.getElementById('ctTabs').style.display = 'none';
            modeLabel.style.display = 'none';
        } else {
            document.getElementById('ctTabs').style.display = 'flex';
            modeLabel.style.display = 'none';
        }
    }
}

async function openEditor(key, src, year){
    currentKey = key;
    currentYear = year != null ? String(year) : String(key).split('-')[0];

    adjust = defaultAdjust();
    originalSrc = src;
    originalImgEl = new Image();
    originalImgReady = new Promise(resolve => {
        originalImgEl.onload = resolve;
        originalImgEl.onerror = resolve;
    });
    originalImgEl.src = src;

    const crops = await loadCrops();
    const existing = crops[key] || {};
    cropData = {
        grid: existing.grid || null,
        timeline: existing.timeline || null
    };
    sameForBoth = !!(existing.grid && existing.timeline && rectsEqual(existing.grid, existing.timeline));
    squareLock = false;

    document.getElementById('ctSameToggle').checked = sameForBoth;
    document.getElementById('ctSquareToggle').checked = false;
    document.getElementById('ctTitle').textContent = `Edit Crop — ${key}`;
    document.getElementById('ctStatus').textContent = '';
    syncAdjustSliders();
    updateFilterPreview();
    activeTab = 'grid';
    document.querySelectorAll('.ct-tab').forEach(b => b.classList.toggle('active', b.dataset.target === 'grid'));

    const num = parseInt(String(key).split('-')[1], 10);
    const designatedNum = getYearPhotoNumber(crops, currentYear);
    document.getElementById('ctGridPhotoToggle').checked = designatedNum === num;
    document.getElementById('ctGridPhotoYear').textContent = currentYear;
    updateGridPhotoUI();

    const img = document.getElementById('ctImage');
    img.onload = () => initCropper();
    img.src = src;

    document.getElementById('ctOverlay').classList.add('open');
    document.body.classList.add('ct-modal-active');
    document.body.style.overflow = 'hidden';
}

function closeEditor(){
    if(cropper){ cropper.destroy(); cropper = null; }
    document.getElementById('ctOverlay').classList.remove('open');
    document.body.classList.remove('ct-modal-active');
    document.body.style.overflow = '';
}

async function handleSave(){
    const statusEl = document.getElementById('ctStatus');
    const saveBtn = document.getElementById('ctSaveBtn');
    const crops = await loadCrops();

    if(!isAdjustDefault(adjust)){
        if(!getToken()){ openTokenModal(); return; }
        saveBtn.disabled = true;
        statusEl.textContent = 'Uploading adjusted photo…';
        try {
            await originalImgReady;
            const canvas = bakeCanvas(originalImgEl, adjust, true);
            const base64 = canvasToBase64Jpeg(canvas, 0.92);
            await uploadPhotoBytes(`photos/${currentKey}.jpg`, base64, `Adjust photo ${currentKey}.jpg`);
            cacheBustPhoto(currentKey);

            // photos/{key}.jpg is a static filename that's reused across edits,
            // so the browser (and any CDN in front of GitHub Pages) will happily
            // keep serving a stale cached copy on future page loads unless the
            // <img> URL itself changes. Stamp a version into crops.json - which
            // already gets published alongside this edit - so index.html/grid.html
            // can append it as a cache-busting query string.
            if(!crops._photoVersion) crops._photoVersion = {};
            crops._photoVersion[currentKey] = Date.now();
            markDirty(`_photoVersion:${currentKey}`);
        } catch(e){
            statusEl.textContent = 'Photo upload failed: ' + e.message;
            saveBtn.disabled = false;
            return;
        }
        saveBtn.disabled = false;
    }

    const rect = captureCurrentRect();
    if(!rect) return;

    const useAsGridPhoto = isGridPhoto();
    const existingEntry = crops[currentKey] || {};

    let finalGrid = existingEntry.grid || null;
    let finalTimeline;

    if(!useAsGridPhoto){
        // Only the timeline crop is editable in this mode - leave any
        // existing grid crop (from before the checkbox was unchecked) alone.
        finalTimeline = rect;
    } else {
        cropData[activeTab] = rect;
        if(sameForBoth){
            finalGrid = rect;
            finalTimeline = rect;
        } else {
            finalGrid = cropData.grid || rect;
            finalTimeline = cropData.timeline || rect;
        }
    }

    crops[currentKey] = { grid: finalGrid, timeline: finalTimeline };
    markDirty(currentKey);

    const num = parseInt(String(currentKey).split('-')[1], 10);
    if(!crops._yearPhoto) crops._yearPhoto = {};
    const prevDesignated = crops._yearPhoto[currentYear];
    let yearPhotoChanged = false;
    if(useAsGridPhoto){
        if(num === 1){
            if(currentYear in crops._yearPhoto){ delete crops._yearPhoto[currentYear]; yearPhotoChanged = true; }
        } else if(prevDesignated !== num){
            crops._yearPhoto[currentYear] = num;
            yearPhotoChanged = true;
        }
    } else if(prevDesignated === num){
        delete crops._yearPhoto[currentYear];
        yearPhotoChanged = true;
    }
    if(Object.keys(crops._yearPhoto).length === 0) delete crops._yearPhoto;
    if(yearPhotoChanged) markDirty(`_yearPhoto:${currentYear}`);

    document.getElementById('ctStatus').textContent = 'Saved locally — click Publish when you’re ready.';
    if(onSavedCallback) onSavedCallback(currentKey);
    setTimeout(closeEditor, 500);
}

async function handleReset(){
    const crops = await loadCrops();
    delete crops[currentKey];
    markDirty(currentKey);

    document.getElementById('ctStatus').textContent = 'Reset locally — click Publish when you’re ready.';
    if(onSavedCallback) onSavedCallback(currentKey);
    setTimeout(closeEditor, 500);
}

async function handleDelete(){
    if(!getToken()){ openTokenModal(); return; }

    const path = `photos/${currentKey}.jpg`;
    const confirmed = confirm(`Delete ${path} from GitHub? This permanently removes the file and can't be undone.`);
    if(!confirmed) return;

    const statusEl = document.getElementById('ctStatus');
    const deleteBtn = document.getElementById('ctDeleteBtn');
    statusEl.textContent = 'Deleting…';
    deleteBtn.disabled = true;

    try {
        const sha = await fetchFileSha(path);
        if(sha == null) throw new Error('File not found on GitHub - it may already be deleted.');
        await deleteFileFromGitHub(path, sha, `Delete photo ${currentKey}.jpg`);

        const crops = await loadCrops();
        delete crops[currentKey];
        const num = parseInt(String(currentKey).split('-')[1], 10);
        if(crops._yearPhoto && crops._yearPhoto[currentYear] === num){
            delete crops._yearPhoto[currentYear];
            if(Object.keys(crops._yearPhoto).length === 0) delete crops._yearPhoto;
        }
        markDirty(currentKey);
        await publishChanges();

        statusEl.textContent = 'Deleted ✓';
        if(onSavedCallback) onSavedCallback(currentKey);
        setTimeout(closeEditor, 700);
    } catch(e){
        statusEl.textContent = 'Delete failed: ' + e.message;
    } finally {
        deleteBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------
// Token modal
// ---------------------------------------------------------------------

function openTokenModal(){
    document.getElementById('ctTokenInput').value = getToken();
    document.getElementById('ctTokenOverlay').classList.add('open');
    document.body.classList.add('ct-modal-active');
}

function closeTokenModal(){
    document.getElementById('ctTokenOverlay').classList.remove('open');
    if(!document.getElementById('ctOverlay').classList.contains('open')){
        document.body.classList.remove('ct-modal-active');
    }
}

function updateEditToggleAppearance(){
    const btn = document.getElementById('ctEditToggle');
    btn.classList.toggle('ct-active', editMode);
    btn.title = editMode ? 'Exit photo editing' : 'Edit photo crops';
}

function updatePublishButton(){
    const btn = document.getElementById('ctPublishBtn');
    if(dirtyKeys.size > 0){
        btn.style.display = 'block';
        btn.textContent = `Publish ${dirtyKeys.size} Change${dirtyKeys.size === 1 ? '' : 's'}`;
    } else {
        btn.style.display = 'none';
    }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function wireEvents(){
    document.getElementById('ctEditToggle').addEventListener('click', () => {
        if(!getToken()){
            openTokenModal();
            return;
        }
        editMode = !editMode;
        updateEditToggleAppearance();
        document.body.classList.toggle('ct-edit-mode', editMode);
    });

    document.getElementById('ctPublishBtn').addEventListener('click', publishChanges);

    document.getElementById('ctClose').addEventListener('click', closeEditor);
    document.getElementById('ctOverlay').addEventListener('click', e => {
        if(e.target.id === 'ctOverlay') closeEditor();
    });

    document.getElementById('ctSameToggle').addEventListener('change', e => {
        captureIntoCropData();
        sameForBoth = e.target.checked;
        updateGridPhotoUI();
        initCropper();
    });

    document.getElementById('ctSquareToggle').addEventListener('change', e => {
        captureIntoCropData();
        squareLock = e.target.checked;
        initCropper();
    });

    document.getElementById('ctGridPhotoToggle').addEventListener('change', () => {
        captureIntoCropData();
        updateGridPhotoUI();
        initCropper();
    });

    document.querySelectorAll('.ct-tab').forEach(btn => {
        btn.addEventListener('click', () => setActiveTab(btn.dataset.target));
    });

    document.getElementById('ctBrightness').addEventListener('input', e => {
        adjust.brightness = parseInt(e.target.value, 10);
        document.getElementById('ctBrightnessVal').textContent = adjust.brightness + '%';
        updateFilterPreview();
    });
    document.getElementById('ctContrast').addEventListener('input', e => {
        adjust.contrast = parseInt(e.target.value, 10);
        document.getElementById('ctContrastVal').textContent = adjust.contrast + '%';
        updateFilterPreview();
    });
    document.getElementById('ctSaturation').addEventListener('input', e => {
        adjust.saturation = parseInt(e.target.value, 10);
        document.getElementById('ctSaturationVal').textContent = adjust.saturation + '%';
        updateFilterPreview();
    });
    document.getElementById('ctRotate').addEventListener('input', e => {
        adjust.rotate = parseFloat(e.target.value);
        document.getElementById('ctRotateVal').textContent = adjust.rotate + '°';
        clearTimeout(rotateBakeTimer);
        rotateBakeTimer = setTimeout(rebuildGeometry, 120);
    });
    document.getElementById('ctAdjustReset').addEventListener('click', () => {
        adjust = defaultAdjust();
        syncAdjustSliders();
        updateFilterPreview();
        rebuildGeometry();
    });

    document.getElementById('ctSaveBtn').addEventListener('click', handleSave);
    document.getElementById('ctResetBtn').addEventListener('click', handleReset);
    document.getElementById('ctDeleteBtn').addEventListener('click', handleDelete);
    document.getElementById('ctChangeToken').addEventListener('click', openTokenModal);

    document.getElementById('ctTokenSave').addEventListener('click', () => {
        setToken(document.getElementById('ctTokenInput').value.trim());
        closeTokenModal();
    });
    document.getElementById('ctTokenCancel').addEventListener('click', closeTokenModal);
    document.getElementById('ctTokenClose').addEventListener('click', closeTokenModal);
    document.getElementById('ctTokenOverlay').addEventListener('click', e => {
        if(e.target.id === 'ctTokenOverlay') closeTokenModal();
    });

    document.addEventListener('keydown', e => {
        if(e.key !== 'Escape') return;
        closeEditor();
        closeTokenModal();
    });

    window.addEventListener('beforeunload', e => {
        if(dirtyKeys.size === 0) return;
        e.preventDefault();
        e.returnValue = '';
    });
}

async function init(){
    injectStyles();
    injectMarkup();
    wireEvents();
    await loadCrops();
    updatePublishButton();
}

window.CropTools = {
    init,
    loadCrops,
    applyCrop,
    applyCropFit,
    getYearPhotoNumber,
    getYearOrder,
    setYearOrder,
    photoUrl,
    isEditMode: () => editMode,
    onSaved: cb => { onSavedCallback = cb; },
    openEditor
};

})();
