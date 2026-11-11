'use strict';

const PKG = 'character-visual-tool';
const RATIOS = [1, 0.8, 0.6];
const SETTINGS_KEY = 'cvt-settings';

function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callScene = (method, ...args) => Editor.Message.request('scene', 'execute-scene-script', { name: PKG, method, args });

function loadSettings() {
    try { return Object.assign({ onion: true, autoFit: true, autoSave: false, folder: '', normalizeAll: true, syncId: true, autoName: true }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (e) { return { onion: true, autoFit: true, autoSave: false, folder: '', normalizeAll: true, syncId: true, autoName: true }; }
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

exports.template = `
<div class="cvt" tabindex="0">
    <div class="head">
        <div><b id="ownerName">(chọn 1 node trong Hierarchy)</b> <span class="sub" id="ownerKind"></span></div>
        <label class="chk" title="Bật / tắt node này"><input type="checkbox" id="ownerActive"> Bật</label>
    </div>
    <div class="line" id="correctRow">
        <span>✓ Món đúng:</span>
        <select id="correctSelect" class="nsel" title="Món đồ đưa cho nhân vật này thì tính là ĐÚNG"></select>
    </div>
    <div class="bar">
        <ui-checkbox id="optOnion" title="Hiện mờ ảnh Normal phía sau khi đang chỉnh trạng thái khác">Onion skin</ui-checkbox>
        <ui-checkbox id="optAutoFit" title="Đổi ảnh trạng thái nào thì tự cân chiều cao theo Normal">Tự cân khi đổi ảnh</ui-checkbox>
        <ui-checkbox id="optAutoSave" title="Tự lưu scene sau mỗi thay đổi">Tự lưu</ui-checkbox>
        <ui-button id="normalizeBtn" title="Scale mọi trạng thái để cao bằng Normal">⇕ Cân theo Normal</ui-button>
    </div>
    <div id="cards" class="cards"></div>
    <div class="sub" id="keysHint">Bấm thẻ → chỉnh trên Scene bằng W (kéo vị trí) / R (scale). Phím ←↑→↓ dịch 1px (Shift: 10px), lăn chuột trên ảnh để to/nhỏ 5%.</div>

    <details class="box" id="itemsBox" open>
        <summary><b>Món đồ</b> <span class="sub">(kéo ảnh vào để đổi · sửa tên rồi Enter)</span></summary>
        <ui-checkbox id="optSyncId" title="Đổi cả itemID và mọi chỗ dùng tên cũ: Item ID trong Item Visuals của nhân vật, tên node ảnh con">Đổi tên đồng bộ cả itemID / nhân vật</ui-checkbox>
        <div class="line">
            <ui-checkbox id="optAutoName" title="Kéo ảnh item_xxx vào món đồ thì tự đổi tên món thành Xxx">Tự đặt tên theo ảnh (item_xxx → Xxx)</ui-checkbox>
            <ui-button id="nameAllBtn" title="Đổi tên mọi món đồ theo ảnh item_xxx đang gán">Đặt tên theo ảnh cho tất cả</ui-button>
        </div>
        <div id="items" class="cards"></div>
    </details>

    <details class="box" id="byNameBox">
        <summary><b>Gán theo tên (đổi cả bộ ảnh)</b></summary>
        <div class="sub">Tên ảnh: <code>nhânvật_trạngthái</code> (vd messi_normal, messi_wc, ronaldo_bong) và <code>item_&lt;itemID&gt;</code> (vd item_wc).</div>
        <div class="line">
            <ui-input id="folder" placeholder="db://assets/... (thư mục ảnh)"></ui-input>
            <ui-button id="pickFolder" title="Lấy thư mục đang chọn ở panel Assets">Lấy thư mục đang chọn</ui-button>
        </div>
        <div class="line">
            <ui-checkbox id="optNormalizeAll">Cân theo Normal sau khi gán</ui-checkbox>
            <ui-button id="checkByName">Kiểm tra</ui-button>
            <ui-button id="runByName">▶ Gán theo tên</ui-button>
        </div>
        <div id="byNameReport" class="report"></div>
    </details>

    <div id="msg"></div>
</div>`;

exports.style = `
:host { display: flex; flex-direction: column; height: 100%; }
.cvt { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; box-sizing: border-box; outline: none;
       display: flex; flex-direction: column; gap: 8px; }
.cvt .head, .cvt .bar, .cvt .line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cvt .head { justify-content: space-between; }
.cvt .line ui-input { flex: 1; min-width: 160px; }
.cvt .sub { opacity: .6; font-size: 11px; }
.cvt code { background: #333; padding: 0 3px; border-radius: 3px; }
.cvt .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
.cvt .card { border: 2px solid #444; border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.cvt .card.focus { border-color: #2f8ae0; background: rgba(47,138,224,.08); }
.cvt .card .top { display: flex; justify-content: space-between; align-items: center; gap: 4px; }
.cvt .card .name { font-weight: bold; }
.cvt .card .eye { cursor: pointer; opacity: .5; user-select: none; }
.cvt .card .eye.on { opacity: 1; }
.cvt .thumb { height: 130px; display: flex; align-items: flex-end; justify-content: center; cursor: pointer;
              background: repeating-conic-gradient(#3a3a3a 0% 25%, #2e2e2e 0% 50%) 50% / 16px 16px; border-radius: 4px; }
.cvt .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; }
.cvt .thumb .empty { align-self: center; opacity: .5; }
.cvt .btns { display: flex; gap: 3px; flex-wrap: wrap; }
.cvt .btns ui-button { min-width: 0; padding: 0 6px; }
.cvt .btns ui-button.sel { outline: 1px solid #2f8ae0; }
.cvt .warn { color: #e0a030; font-size: 11px; }
.cvt .ok { color: #50c050; font-size: 11px; }
.cvt .chk { display: flex; gap: 4px; align-items: center; cursor: pointer; }
.cvt .nsel { background: #1e1e1e; color: #ddd; border: 1px solid #555; border-radius: 3px; padding: 2px 6px; min-width: 140px; }
.cvt .box { border: 1px solid #444; border-radius: 4px; padding: 6px; display: flex; flex-direction: column; gap: 6px; }
.cvt .report { font-size: 12px; white-space: pre-line; max-height: 200px; overflow-y: auto; }
.cvt #msg { min-height: 16px; font-size: 12px; white-space: pre-line; padding-bottom: 8px; }
`;

exports.$ = {
    root: '.cvt', ownerName: '#ownerName', ownerKind: '#ownerKind', ownerActive: '#ownerActive',
    optOnion: '#optOnion', optAutoFit: '#optAutoFit', optAutoSave: '#optAutoSave', normalizeBtn: '#normalizeBtn',
    cards: '#cards', folder: '#folder', pickFolder: '#pickFolder', optNormalizeAll: '#optNormalizeAll',
    checkByName: '#checkByName', runByName: '#runByName', byNameReport: '#byNameReport', msg: '#msg',
    items: '#items', optSyncId: '#optSyncId', optAutoName: '#optAutoName', nameAllBtn: '#nameAllBtn', correctRow: '#correctRow', correctSelect: '#correctSelect',
};

/** 'item_water_bottle' -> 'WaterBottle'; ảnh không theo quy ước item_ thì trả về ''. */
function nameFromImage(base) {
    const m = /^item_(.+)$/i.exec(base || '');
    if (!m) return '';
    const name = m[1].split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    return /^[A-Za-z]/.test(name) ? name : '';
}

async function imageBase(frameUuid) {
    if (!frameUuid) return '';
    try {
        const info = await Editor.Message.request('asset-db', 'query-asset-info', frameUuid);
        const m = info && /([^/]+)\.(png|jpe?g|webp)\/[^/]+$/i.exec(info.url);
        return m ? m[1] : '';
    } catch (e) { return ''; }
}

let st = null;        // dữ liệu đọc từ scene: { owner, focus, cards }
let settings = loadSettings();
const thumbCache = new Map();

exports.methods = {
    setMsg(text, color) {
        this.$.msg.textContent = text || '';
        this.$.msg.style.color = color || '';
    },
    hitText(hit) {
        return hit && hit.size ? `Vùng chạm ${hit.name}: ${hit.size[0]}x${hit.size[1]} (theo ảnh ${hit.from})` : '';
    },

    // ---------------------------------------------------------------- đọc / vẽ
    async read() {
        await this.renderItems();
        const uuid = Editor.Selection.getLastSelected('node');
        if (!uuid) return;
        const data = await callScene('read', uuid);
        if (!data) return;
        const ownerChanged = !st || st.owner.uuid !== data.owner.uuid;
        st = data;
        await this.render();
        await this.updateOnion(ownerChanged);
    },

    scheduleRead(delay = 150) {
        clearTimeout(this._readTimer);
        this._readTimer = setTimeout(() => this.read(), delay);
    },

    async thumbUrl(frameUuid) {
        if (!frameUuid) return '';
        const main = frameUuid.split('@')[0];
        if (thumbCache.has(main)) return thumbCache.get(main);
        let url = '';
        try {
            const info = await Editor.Message.request('asset-db', 'query-asset-info', main);
            if (info && info.file) url = encodeURI('file:///' + info.file.replace(/\\/g, '/')) + '?t=' + Date.now();
        } catch (e) { /* ignore */ }
        thumbCache.set(main, url);
        return url;
    },

    ratioOf(c) {
        const hn = st.owner.normalHeight;
        return hn > 0 && c.rectH > 0 ? (c.rectH * c.scale) / hn : 0;
    },

    async cardHtml(c, kind) {
        const url = await this.thumbUrl(c.sprite);
        const isFocus = st.focus === c.name && kind === 'child';
        const charChild = st.owner.isCharacter && kind === 'child';
        const ratio = charChild && c.name !== 'Normal' ? this.ratioOf(c) : 0;
        const ratioBtns = charChild && c.name !== 'Normal'
            ? RATIOS.map((r) => `<ui-button data-ratio="${r}" class="${Math.abs(ratio - r) < 0.01 ? 'sel' : ''}" title="Cao bằng ${r * 100}% Normal">${r * 100}%</ui-button>`).join('')
            : '';
        const tools = kind === 'child'
            ? `<ui-button data-act="reset" title="Scale 1, vị trí (0, 0)">↺</ui-button>${charChild && c.name !== 'Normal' ? '<ui-button data-act="copyNormal" title="Lấy scale + vị trí của Normal">⧉</ui-button>' : ''}`
            : '';
        return `
        <div class="card ${isFocus ? 'focus' : ''}" data-uuid="${c.uuid}" data-kind="${kind}" data-name="${esc(c.name)}">
            <div class="top">
                <span class="name">${kind === 'self' ? '(chính node) ' : ''}${esc(c.name)}</span>
                <span class="eye ${c.active ? 'on' : ''}" title="Bật / tắt node">${c.active ? '👁' : '◌'}</span>
            </div>
            <div class="thumb" title="Bấm để chọn & chỉnh trên Scene">${url ? `<img src="${url}">` : '<span class="empty">(chưa có ảnh)</span>'}</div>
            <ui-asset droppable="cc.SpriteFrame" value="${esc(c.sprite || '')}" title="Kéo ảnh từ Assets thả vào đây"></ui-asset>
            <div class="btns">${ratioBtns}${tools}</div>
            <div class="sub">x ${c.x} · y ${c.y} · scale ${c.scale}${ratio ? ` · ${Math.round(ratio * 100)}% Normal` : ''}</div>
            ${c.sprite && !c.trimmed ? '<div class="warn">Ảnh chưa trim — sẽ tự sửa khi kéo ảnh vào lại</div>' : ''}
        </div>`;
    },

    async render() {
        if (!st) return;
        const o = st.owner;
        this.$.ownerName.textContent = o.name;
        this.$.ownerKind.textContent = o.isCharacter ? '(nhân vật)' : (st.cards.length ? '' : '(không có node con có Sprite)');
        this._renderingOwner = true;
        this.$.ownerActive.checked = !!o.active;
        setTimeout(() => { this._renderingOwner = false; }, 0);
        this.$.normalizeBtn.style.display = o.isCharacter ? '' : 'none';
        this.$.correctRow.style.display = o.isCharacter ? '' : 'none';
        if (o.isCharacter) {
            // vẽ lại dropdown sẽ bắn 'change' -> bỏ qua trong lúc vẽ để không ghi nhầm món đúng
            this._renderingSelect = true;
            const opts = (this._items || []).map((it) => `<option value="${it.uuid}">${esc(it.name)}</option>`).join('');
            this.$.correctSelect.innerHTML = `<option value="">(chưa chọn)</option>${opts}`;
            this.$.correctSelect.value = o.correct ? o.correct.uuid : '';
            setTimeout(() => { this._renderingSelect = false; }, 0);
        }
        this.$.optOnion.style.display = o.isCharacter ? '' : 'none';
        this.$.optAutoFit.style.display = o.isCharacter ? '' : 'none';

        const parts = [];
        if (o.self) parts.push(await this.cardHtml(o.self, 'self'));
        for (const c of st.cards) parts.push(await this.cardHtml(c, 'child'));
        const scroll = this.$.root.scrollTop;
        this.$.cards.innerHTML = parts.join('');
        this.$.root.scrollTop = scroll;
        this.bindCards();
    },

    bindCards() {
        this.$.cards.querySelectorAll('.card').forEach((el) => {
            const uuid = el.dataset.uuid;
            const kind = el.dataset.kind;
            const name = el.dataset.name;
            el.querySelector('.thumb').addEventListener('click', () => this.focusCard(uuid, name, kind));
            el.querySelector('.thumb').addEventListener('wheel', (e) => {
                e.preventDefault();
                this.nudgeScale(uuid, e.deltaY < 0 ? 1.05 : 1 / 1.05);
            }, { passive: false });
            el.querySelector('.eye').addEventListener('click', () => this.toggleActive(uuid));
            el.querySelector('ui-asset').addEventListener('change', (e) => this.setFrame(uuid, e.target.value, kind));
            el.querySelectorAll('[data-ratio]').forEach((b) => b.addEventListener('confirm', () => this.setRatio(uuid, Number(b.dataset.ratio))));
            el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('confirm', () => {
                if (b.dataset.act === 'reset') this.resetCard(uuid);
                else this.copyFromNormal(uuid);
            }));
        });
    },

    // ---------------------------------------------------------------- set-property (có Undo, Inspector cập nhật)
    async compIndex(uuid, type) {
        const dump = await Editor.Message.request('scene', 'query-node', uuid);
        return dump ? dump.__comps__.findIndex((c) => c.type === type) : -1;
    },
    setProp(uuid, path, type, value) {
        return Editor.Message.request('scene', 'set-property', { uuid, path, dump: { type, value } });
    },
    cardByUuid(uuid) {
        if (!st) return null;
        if (st.owner.self && st.owner.self.uuid === uuid) return st.owner.self;
        return st.cards.find((c) => c.uuid === uuid) || null;
    },

    async changed(note, hit) {
        try { await Editor.Message.request('scene', 'snapshot'); } catch (e) { /* ignore */ }
        if (settings.autoSave) {
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => Editor.Message.request('scene', 'save-scene'), 600);
        }
        if (note !== undefined) this.setMsg([note, this.hitText(hit), settings.autoSave ? '' : 'Nhớ Ctrl+S.'].filter(Boolean).join('\n'), '#50c050');
        this.scheduleRead(50);
    },

    // ---------------------------------------------------------------- thao tác thẻ
    /** Bấm thẻ: chọn node đó trên Scene (dùng gizmo W/R) và với nhân vật thì chỉ bật trạng thái đó. */
    async focusCard(uuid, name, kind) {
        if (kind === 'child' && st.owner.isCharacter) {
            for (const c of st.cards) {
                const want = c.uuid === uuid;
                if (c.active !== want) await this.setProp(c.uuid, 'active', 'cc.Boolean', want);
            }
        }
        Editor.Selection.clear('node');
        Editor.Selection.select('node', uuid);
        this.$.root.focus();
        await this.changed(kind === 'child' && st.owner.isCharacter ? `Đang xem ${name}` : `Đã chọn ${name}`);
    },

    async toggleActive(uuid) {
        const c = this.cardByUuid(uuid);
        if (!c) return;
        await this.setProp(uuid, 'active', 'cc.Boolean', !c.active);
        await this.changed(`${c.active ? 'Đã tắt' : 'Đã bật'} ${c.name}`);
    },

    /** Ảnh chưa trim được thì đặt Trim Threshold = 64 và import lại. */
    async ensureTrim(frameUuid) {
        const [main, sub] = frameUuid.split('@');
        if (!sub) return false;
        const meta = await Editor.Message.request('asset-db', 'query-asset-meta', main);
        const ud = meta && meta.subMetas && meta.subMetas[sub] && meta.subMetas[sub].userData;
        if (!ud) return false;
        const untrimmed = ud.width >= ud.rawWidth && ud.height >= ud.rawHeight;
        if (!untrimmed || (ud.trimType === 'auto' && (ud.trimThreshold || 1) >= 64)) return false;
        ud.trimType = 'auto';
        ud.trimThreshold = 64;
        await Editor.Message.request('asset-db', 'save-asset-meta', main, JSON.stringify(meta));
        await sleep(300);
        thumbCache.delete(main);
        return true;
    },

    async setFrame(uuid, frameUuid, kind) {
        if (!frameUuid) return;
        const c = this.cardByUuid(uuid);
        const fixed = await this.ensureTrim(frameUuid);
        const idx = await this.compIndex(uuid, 'cc.Sprite');
        if (idx >= 0) await this.setProp(uuid, `__comps__.${idx}.spriteFrame`, 'cc.SpriteFrame', { uuid: frameUuid });
        const autoFit = settings.autoFit && kind === 'child' && st.owner.isCharacter;
        const res = await callScene('prepare', uuid, { normalize: autoFit, ratio: 1 });
        await this.changed(`Đã đổi ảnh ${c ? c.name : ''}${fixed ? ' (đã tự đặt Trim Threshold = 64)' : ''}${autoFit && c && c.name !== 'Normal' ? ', đã cân theo Normal' : ''}`, res && res.hit);
        if (kind === 'item' && settings.autoName) {
            const name = nameFromImage(await imageBase(frameUuid));
            const it = (this._items || []).find((x) => x.uuid === uuid);
            if (name && it && name !== it.name) await this.renameItem(uuid, name);
        }
    },

    async setRatio(uuid, ratio) {
        const c = this.cardByUuid(uuid);
        const hn = st.owner.normalHeight;
        if (!c || !(hn > 0) || !(c.rectH > 0)) return;
        const s = (hn * ratio) / c.rectH;
        await this.setProp(uuid, 'scale', 'cc.Vec3', { x: s, y: s, z: 1 });
        await this.changed(`${c.name}: cao ${ratio * 100}% Normal`);
    },

    async nudgeScale(uuid, factor) {
        const c = this.cardByUuid(uuid);
        if (!c) return;
        const s = +(c.scale * factor).toFixed(4);
        c.scale = s; // cập nhật tạm để lăn liên tục không bị đọc lại giá trị cũ
        await this.setProp(uuid, 'scale', 'cc.Vec3', { x: s, y: s, z: 1 });
        await this.changed();
    },

    async nudgePos(dx, dy) {
        if (!st || !st.focus) return;
        const c = st.cards.find((x) => x.name === st.focus);
        if (!c) return;
        c.x = +(c.x + dx).toFixed(2);
        c.y = +(c.y + dy).toFixed(2);
        await this.setProp(c.uuid, 'position', 'cc.Vec3', { x: c.x, y: c.y, z: 0 });
        await this.changed();
    },

    async resetCard(uuid) {
        const c = this.cardByUuid(uuid);
        await this.setProp(uuid, 'scale', 'cc.Vec3', { x: 1, y: 1, z: 1 });
        await this.setProp(uuid, 'position', 'cc.Vec3', { x: 0, y: 0, z: 0 });
        await this.changed(`${c ? c.name : ''}: về scale 1, vị trí (0, 0)`);
    },

    async copyFromNormal(uuid) {
        const n = st.cards.find((x) => x.name === 'Normal');
        const c = this.cardByUuid(uuid);
        if (!n || !c) return;
        await this.setProp(uuid, 'scale', 'cc.Vec3', { x: n.scale, y: n.scale, z: 1 });
        await this.setProp(uuid, 'position', 'cc.Vec3', { x: n.x, y: n.y, z: 0 });
        await this.changed(`${c.name}: lấy scale + vị trí của Normal`);
    },

    async normalizeOwner() {
        if (!st || !st.owner.isCharacter) return;
        const res = await callScene('normalize', st.owner.uuid, {});
        if (!res.ok) { this.setMsg(res.error, '#e05050'); return; }
        await this.changed(`Đã cân ${res.done.length} trạng thái theo Normal (${res.done.join(', ')})`, res.hit);
    },

    async updateOnion(force) {
        if (!st) return;
        const want = settings.onion && st.owner.isCharacter && st.focus && st.focus !== 'Normal';
        const key = want ? `${st.owner.uuid}|${st.focus}` : '';
        if (!force && key === this._onionKey && !want) return;
        this._onionKey = key;
        await callScene('onion', st.owner.uuid, st.focus, !!want);
    },

    // ---------------------------------------------------------------- món đồ
    async renderItems() {
        const items = await callScene('listItems');
        this._items = items || [];
        const html = [];
        for (const it of this._items) {
            const url = await this.thumbUrl(it.sprite);
            html.push(`
            <div class="card" data-uuid="${it.uuid}">
                <div class="top">
                    <ui-input class="itemName" value="${esc(it.name)}" title="Sửa tên rồi Enter"></ui-input>
                    <span class="eye ${it.active ? 'on' : ''}" title="Bật / tắt node">${it.active ? '👁' : '◌'}</span>
                </div>
                <div class="thumb" title="Bấm để chọn node trên Scene">${url ? `<img src="${url}">` : '<span class="empty">(chưa có ảnh)</span>'}</div>
                <ui-asset droppable="cc.SpriteFrame" value="${esc(it.sprite || '')}" title="Kéo ảnh từ Assets thả vào đây"></ui-asset>
                <div class="${it.correctFor.length ? 'ok' : 'sub'}">${it.correctFor.length ? '✓ Đúng cho: ' + esc(it.correctFor.join(', ')) : 'Chưa là món đúng của ai'}</div>
                <div class="sub">itemID: ${esc(it.itemID)}${it.name.toLowerCase() !== String(it.itemID).toLowerCase() ? ' (khác tên node)' : ''}</div>
                ${it.sprite && !it.trimmed ? '<div class="warn">Ảnh chưa trim — sẽ tự sửa khi kéo ảnh vào lại</div>' : ''}
            </div>`);
        }
        this.$.items.innerHTML = html.join('') || '<span class="sub">Scene không có món đồ (DraggableItem) nào.</span>';
        this.$.items.querySelectorAll('.card').forEach((el) => {
            const uuid = el.dataset.uuid;
            el.querySelector('.thumb').addEventListener('click', () => { Editor.Selection.clear('node'); Editor.Selection.select('node', uuid); });
            el.querySelector('.eye').addEventListener('click', async () => {
                const it = this._items.find((x) => x.uuid === uuid);
                await this.setProp(uuid, 'active', 'cc.Boolean', !it.active);
                await this.changed(`${it.active ? 'Đã tắt' : 'Đã bật'} ${it.name}`);
            });
            el.querySelector('ui-asset').addEventListener('change', (e) => this.setFrame(uuid, e.target.value, 'item'));
            el.querySelector('.itemName').addEventListener('confirm', (e) => this.renameItem(uuid, e.target.value));
        });
    },

    async nameAllFromImages() {
        const items = await callScene('listItems');
        this._items = items || [];
        const done = [], skipped = [];
        for (const it of this._items) {
            const name = nameFromImage(await imageBase(it.sprite));
            if (!name) { skipped.push(it.name); continue; }
            if (name === it.name) continue;
            const res = await callScene('renameItem', it.uuid, name, settings.syncId);
            if (!res.ok) { skipped.push(`${it.name} (${res.error})`); continue; }
            done.push(`${it.name} → ${name}`);
        }
        await this.changed([
            done.length ? `Đã đổi tên ${done.length} món: ${done.join(', ')}` : 'Không có món nào cần đổi tên.',
            skipped.length ? `Bỏ qua (ảnh không theo dạng item_xxx): ${skipped.join(', ')}` : '',
        ].filter(Boolean).join('\n'));
    },

    async renameItem(uuid, newName) {
        const it = (this._items || []).find((x) => x.uuid === uuid);
        if (!it || !newName || newName === it.name) return;
        const res = await callScene('renameItem', uuid, newName, settings.syncId);
        if (!res.ok) { this.setMsg(res.error, '#e05050'); await this.renderItems(); return; }
        await this.changed(['Đã đổi tên:', ...res.changes.map((c) => '  • ' + c)].join('\n'));
    },

    // ---------------------------------------------------------------- gán theo tên
    async listFrames(folder) {
        const f = folder.replace(/\/+$/, '');
        const list = await Editor.Message.request('asset-db', 'query-assets', { pattern: f + '/**', ccType: 'cc.SpriteFrame' });
        return list.map((a) => {
            const m = a.url.match(/([^/]+)\.(png|jpg|jpeg|webp)\/[^/]+$/i);
            return m ? { base: m[1], uuid: a.uuid } : null;
        }).filter(Boolean);
    },

    async byName(run) {
        const folder = (this.$.folder.value || '').trim();
        if (!folder.startsWith('db://')) { this.$.byNameReport.textContent = 'Chọn thư mục ảnh (db://assets/...) trước.'; return; }
        settings.folder = folder; saveSettings(settings);
        const frames = await this.listFrames(folder);
        if (!frames.length) { this.$.byNameReport.textContent = 'Thư mục không có ảnh nào.'; return; }
        const { plan, missing, unused } = await callScene('planByName', frames);
        const lines = [`Khớp ${plan.length} chỗ:`, ...plan.map((p) => `  ✓ ${p.label} ← ${p.file}`)];
        if (missing.length) lines.push(`Thiếu ${missing.length}:`, ...missing.map((m) => '  ✗ ' + m));
        if (unused.length) lines.push(`Ảnh không dùng: ${unused.join(', ')}`);
        if (!run) { this.$.byNameReport.textContent = lines.join('\n'); return; }
        if (!plan.length) { this.$.byNameReport.textContent = lines.join('\n'); return; }

        let fixed = 0;
        for (const p of plan) if (await this.ensureTrim(p.frame)) fixed++;
        const res = await callScene('applyPlan', plan, { normalize: settings.normalizeAll });
        lines.unshift(`Đã gán ${res.count} ảnh${fixed ? `, tự đặt Trim Threshold = 64 cho ${fixed} ảnh` : ''}${settings.normalizeAll ? ', đã cân theo Normal' : ''}.`
            + (res.errors.length ? ` Lỗi: ${res.errors.join(', ')}` : ''));
        this.$.byNameReport.textContent = lines.join('\n');
        thumbCache.clear();
        await this.changed('Đã gán theo tên.');
    },

    async pickFolder() {
        const sel = Editor.Selection.getSelected('asset');
        for (const uuid of sel) {
            const info = await Editor.Message.request('asset-db', 'query-asset-info', uuid);
            if (info && info.isDirectory) { this.$.folder.value = info.url; settings.folder = info.url; saveSettings(settings); return; }
        }
        this.$.byNameReport.textContent = 'Hãy chọn 1 thư mục trong panel Assets trước.';
    },
};

exports.ready = function () {
    settings = loadSettings();
    this.$.optOnion.value = settings.onion;
    this.$.optAutoFit.value = settings.autoFit;
    this.$.optAutoSave.value = settings.autoSave;
    this.$.optNormalizeAll.value = settings.normalizeAll;
    this.$.folder.value = settings.folder;

    const bindOpt = (el, key, after) => el.addEventListener('change', () => { settings[key] = !!el.value; saveSettings(settings); if (after) after(); });
    bindOpt(this.$.optOnion, 'onion', () => this.updateOnion(true));
    bindOpt(this.$.optAutoFit, 'autoFit');
    bindOpt(this.$.optAutoSave, 'autoSave');
    bindOpt(this.$.optNormalizeAll, 'normalizeAll');
    this.$.optSyncId.value = settings.syncId;
    bindOpt(this.$.optSyncId, 'syncId');
    this.$.optAutoName.value = settings.autoName;
    bindOpt(this.$.optAutoName, 'autoName');
    this.$.nameAllBtn.addEventListener('confirm', () => this.nameAllFromImages());
    this.$.folder.addEventListener('change', () => { settings.folder = this.$.folder.value; saveSettings(settings); });

    this.$.ownerActive.addEventListener('change', async () => {
        // vẽ lại panel cũng bắn 'change' -> chỉ ghi khi người dùng thật sự đổi giá trị
        // input gốc không bắn 'change' khi code gán .checked -> chỉ chạy khi người dùng bấm
        if (!st || this.$.ownerActive.checked === !!st.owner.active) return;
        await this.setProp(st.owner.uuid, 'active', 'cc.Boolean', this.$.ownerActive.checked);
        await this.changed(`${this.$.ownerActive.checked ? 'Đã bật' : 'Đã tắt'} ${st.owner.name}`);
    });
    this.$.normalizeBtn.addEventListener('confirm', () => this.normalizeOwner());
    this.$.correctSelect.addEventListener('change', async () => {
        if (this._renderingSelect || !st || !st.owner.isCharacter) return;
        const picked = this.$.correctSelect.value || '';
        const current = st.owner.correct ? st.owner.correct.uuid : '';
        if (picked === current) return;
        const res = await callScene('setCorrect', st.owner.uuid, this.$.correctSelect.value || '');
        if (!res.ok) { this.setMsg(res.error, '#e05050'); return; }
        await this.changed(res.correct ? `${st.owner.name}: món đúng = ${res.correct.name}` : `${st.owner.name}: bỏ chọn món đúng`);
    });
    this.$.pickFolder.addEventListener('confirm', () => this.pickFolder());
    this.$.checkByName.addEventListener('confirm', () => this.byName(false));
    this.$.runByName.addEventListener('confirm', () => this.byName(true));

    // phím tắt dịch vị trí trạng thái đang chọn
    this.$.root.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 10 : 1;
        const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        const d = map[e.key];
        if (!d || (e.target && e.target.tagName && /UI-(INPUT|NUM-INPUT)/.test(e.target.tagName))) return;
        e.preventDefault();
        this.nudgePos(d[0], d[1]);
    });

    this._onSelect = () => this.scheduleRead(30);
    this._onChange = (uuid) => {
        const isItem = (this._items || []).some((it) => it.uuid === uuid);
        if (isItem || (st && (uuid === st.owner.uuid || st.cards.some((c) => c.uuid === uuid)))) this.scheduleRead(200);
    };
    Editor.Message.addBroadcastListener('selection:select', this._onSelect);
    Editor.Message.addBroadcastListener('scene:change-node', this._onChange);
    st = null;
    // hỗ trợ debug từ DevTools của panel: window.__cvt.state()
    window.__cvt = { panel: this, state: () => st };
    this.read();
};

exports.close = function () {
    Editor.Message.removeBroadcastListener('selection:select', this._onSelect);
    Editor.Message.removeBroadcastListener('scene:change-node', this._onChange);
    callScene('removeOnion').catch(() => {});
};
