(function(){

const GITHUB_OWNER = 'Simply-Vanilla';
const GITHUB_REPO = '50th';
const GITHUB_BRANCH = 'main';
const CROPS_FILE = 'crops.json';

let cropsCache = null;
let editMode = false;
let onSavedCallback = null;

let cropper = null;
let currentKey = null;
let sameForBoth = true;
let activeTab = 'grid';
let cropData = { grid: null, timeline: null };

// ---------------------------------------------------------------------
// Data loading / saving
// ---------------------------------------------------------------------

async function loadCrops(){
    if(cropsCache) return cropsCache;
    try {
        const res = await fetch(CROPS_FILE, { cache: 'no-store' });
        cropsCache = res.ok ? await res.json() : {};
    } catch(e){
        cropsCache = {};
    }
    return cropsCache;
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
        message: message || 'Update photo crop',
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

    cropsCache = updatedCrops;
    return res.json();
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
    imgEl.style.width = (nw * s) + 'px';
    imgEl.style.height = (nh * s) + 'px';
    imgEl.style.left = ((W - cropPxW * s) / 2 - crop.x * nw * s) + 'px';
    imgEl.style.top = ((H - cropPxH * s) / 2 - crop.y * nh * s) + 'px';

    return true;
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

.ct-same{
    display:flex;
    align-items:center;
    gap:8px;
    font-size:13px;
    color:var(--muted);
    margin-bottom:14px;
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

.ct-cropper-wrap{
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

.ct-actions{
    display:flex;
    justify-content:flex-end;
    gap:10px;
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

@media(max-width:900px){
.ct-edit-toggle{
    top:60px;
    left:14px;
    width:38px;
    height:38px;
    font-size:14px;
}
}
`;
    document.head.appendChild(style);
}

function injectMarkup(){
    const wrap = document.createElement('div');
    wrap.innerHTML = `
<button class="ct-edit-toggle" id="ctEditToggle" aria-label="Toggle photo editing" title="Edit photo crops">&#9998;</button>

<div class="ct-overlay" id="ctOverlay">
  <div class="ct-modal">
    <button class="ct-close" id="ctClose" aria-label="Close">&times;</button>
    <div class="ct-title" id="ctTitle">Edit Crop</div>

    <label class="ct-same">
      <input type="checkbox" id="ctSameToggle" checked>
      Use the same crop for both views
    </label>

    <div class="ct-tabs" id="ctTabs" style="display:none;">
      <button class="ct-tab active" data-target="grid" type="button">Grid View</button>
      <button class="ct-tab" data-target="timeline" type="button">Timeline View</button>
    </div>

    <div class="ct-cropper-wrap">
      <img id="ctImage" src="" alt="">
    </div>

    <div class="ct-actions">
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

function currentAspect(){
    if(sameForBoth) return NaN;
    return activeTab === 'grid' ? (4 / 5) : NaN;
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

function initCropper(){
    if(cropper){ cropper.destroy(); cropper = null; }
    const img = document.getElementById('ctImage');
    cropper = new Cropper(img, {
        aspectRatio: currentAspect(),
        viewMode: 1,
        autoCropArea: 0.9,
        background: false,
        ready(){
            const existingRect = sameForBoth ? (cropData.grid || cropData.timeline) : cropData[activeTab];
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
    const rect = captureCurrentRect();
    if(rect) cropData[activeTab] = rect;
    activeTab = tab;
    document.querySelectorAll('.ct-tab').forEach(b => b.classList.toggle('active', b.dataset.target === tab));
    initCropper();
}

function updateTabsVisibility(){
    document.getElementById('ctTabs').style.display = sameForBoth ? 'none' : 'flex';
}

async function openEditor(key, src){
    currentKey = key;

    const crops = await loadCrops();
    const existing = crops[key] || {};
    cropData = {
        grid: existing.grid || null,
        timeline: existing.timeline || null
    };
    sameForBoth = !(existing.grid && existing.timeline && !rectsEqual(existing.grid, existing.timeline));

    document.getElementById('ctSameToggle').checked = sameForBoth;
    document.getElementById('ctTitle').textContent = `Edit Crop — ${key}`;
    document.getElementById('ctStatus').textContent = '';
    activeTab = 'grid';
    document.querySelectorAll('.ct-tab').forEach(b => b.classList.toggle('active', b.dataset.target === 'grid'));
    updateTabsVisibility();

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
    if(!getToken()){ openTokenModal(); return; }

    const rect = captureCurrentRect();
    if(!rect) return;
    cropData[activeTab] = rect;

    let finalGrid, finalTimeline;
    if(sameForBoth){
        finalGrid = rect;
        finalTimeline = rect;
    } else {
        finalGrid = cropData.grid || rect;
        finalTimeline = cropData.timeline || rect;
    }

    const statusEl = document.getElementById('ctStatus');
    const saveBtn = document.getElementById('ctSaveBtn');
    statusEl.textContent = 'Saving…';
    saveBtn.disabled = true;

    try {
        const crops = await loadCrops();
        crops[currentKey] = { grid: finalGrid, timeline: finalTimeline };
        await saveCropsToGitHub(crops, `Update crop for ${currentKey}`);
        statusEl.textContent = 'Saved ✓ — reloading…';
        if(onSavedCallback) onSavedCallback(currentKey);
        setTimeout(() => location.reload(), 600);
    } catch(e){
        statusEl.textContent = 'Error: ' + e.message;
        saveBtn.disabled = false;
    }
}

async function handleReset(){
    if(!getToken()){ openTokenModal(); return; }

    const statusEl = document.getElementById('ctStatus');
    statusEl.textContent = 'Resetting…';

    try {
        const crops = await loadCrops();
        delete crops[currentKey];
        await saveCropsToGitHub(crops, `Reset crop for ${currentKey}`);
        statusEl.textContent = 'Reset ✓ — reloading…';
        if(onSavedCallback) onSavedCallback(currentKey);
        setTimeout(() => location.reload(), 600);
    } catch(e){
        statusEl.textContent = 'Error: ' + e.message;
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

    document.getElementById('ctClose').addEventListener('click', closeEditor);
    document.getElementById('ctOverlay').addEventListener('click', e => {
        if(e.target.id === 'ctOverlay') closeEditor();
    });

    document.getElementById('ctSameToggle').addEventListener('change', e => {
        const rect = captureCurrentRect();
        if(rect) cropData[activeTab] = rect;
        sameForBoth = e.target.checked;
        updateTabsVisibility();
        initCropper();
    });

    document.querySelectorAll('.ct-tab').forEach(btn => {
        btn.addEventListener('click', () => setActiveTab(btn.dataset.target));
    });

    document.getElementById('ctSaveBtn').addEventListener('click', handleSave);
    document.getElementById('ctResetBtn').addEventListener('click', handleReset);
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
}

function init(){
    injectStyles();
    injectMarkup();
    wireEvents();
}

window.CropTools = {
    init,
    loadCrops,
    applyCrop,
    isEditMode: () => editMode,
    onSaved: cb => { onSavedCallback = cb; },
    openEditor
};

})();
