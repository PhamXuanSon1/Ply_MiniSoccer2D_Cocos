'use strict';

/**
 * Chạy trong scene process. Panel / main.js gọi qua Editor.Message 'scene' 'execute-scene-script'.
 *
 * Khái niệm:
 *  - owner: node đang làm việc. Chọn node nhân vật (có CharacterSlot) hoặc 1 node con của nó
 *    thì owner = node nhân vật; chọn node khác thì owner = chính node đó.
 *  - card: 1 node con có Sprite của owner (1 trạng thái ảnh). Owner có Sprite thì có thêm thẻ "self".
 */

const ONION = '__cvt_onion';

/** Biệt danh để "Gán theo tên" khớp tên ảnh với node nhân vật (ngoài chính tên node). */
const ALIASES = {
    rol: ['ronaldo', 'cr7'],
    vin: ['vini', 'vinicius'],
    messi: ['leo'],
    yamal: ['lamine'],
};

function cc() { return require('cc'); }

function findByUuid(root, uuid) {
    if (!root || !uuid) return null;
    if (root.uuid === uuid) return root;
    for (const c of root.children) {
        const r = findByUuid(c, uuid);
        if (r) return r;
    }
    return null;
}

function walk(root, fn) {
    if (!root) return;
    fn(root);
    for (const c of root.children) walk(c, fn);
}

function loadFrame(uuid) {
    return new Promise((resolve) => {
        if (!uuid) return resolve(null);
        cc().assetManager.loadAny(uuid, (err, asset) => resolve(err ? null : asset));
    });
}

const isCharacter = (n) => !!(n && n.getComponent('CharacterSlot'));
const isVisual = (n) => n.name !== ONION && !!n.getComponent(cc().Sprite);

function ownerOf(node) {
    if (!node) return { owner: null, focus: null };
    if (isCharacter(node)) return { owner: node, focus: null };
    if (node.parent && isCharacter(node.parent) && isVisual(node)) return { owner: node.parent, focus: node.name };
    return { owner: node, focus: null };
}

function frameInfo(sp) {
    const f = sp && sp.spriteFrame;
    if (!f) return { sprite: '', rectW: 0, rectH: 0, trimmed: false };
    return {
        sprite: f._uuid,
        rectW: f.rect.width,
        rectH: f.rect.height,
        trimmed: f.rect.width < f.originalSize.width || f.rect.height < f.originalSize.height,
    };
}

function card(n) {
    const { Sprite } = cc();
    return {
        uuid: n.uuid,
        name: n.name,
        active: n.active,
        x: +n.position.x.toFixed(2),
        y: +n.position.y.toFixed(2),
        scale: +n.scale.x.toFixed(4),
        ...frameInfo(n.getComponent(Sprite)),
    };
}

/** Ép contentSize theo ảnh hiện tại (trường hợp vừa đổi ảnh / reimport trim). */
function fitContentSize(n) {
    const { Sprite, UITransform } = cc();
    const sp = n.getComponent(Sprite);
    const ut = n.getComponent(UITransform);
    if (!sp || !ut || !sp.spriteFrame || sp.sizeMode === Sprite.SizeMode.CUSTOM) return;
    const r = (sp.trim && sp.sizeMode === Sprite.SizeMode.TRIMMED) ? sp.spriteFrame.rect : sp.spriteFrame.originalSize;
    if (Math.abs(ut.width - r.width) > 0.5 || Math.abs(ut.height - r.height) > 0.5) ut.setContentSize(r.width, r.height);
}

/** contentSize + anchor của node nhân vật = khung phần hình nhìn thấy của ảnh đang bật (giống lúc chạy game). */
function syncHitArea(character) {
    const { UITransform } = cc();
    const ut = character.getComponent(UITransform);
    if (!ut) return null;
    const visuals = character.children.filter((c) => isVisual(c) && c.getComponent(UITransform));
    const target = visuals.find((c) => c.active) || character.getChildByName('Normal') || visuals[0];
    if (!target) return null;
    fitContentSize(target);
    const r = target.getComponent(UITransform).getBoundingBox();
    if (!(r.width > 0 && r.height > 0)) return null;
    const ax = -r.x / r.width, ay = -r.y / r.height;
    const changed = Math.abs(ut.width - r.width) > 0.5 || Math.abs(ut.height - r.height) > 0.5 ||
        Math.abs(ut.anchorX - ax) > 0.001 || Math.abs(ut.anchorY - ay) > 0.001;
    if (changed) {
        ut.setContentSize(r.width, r.height);
        ut.setAnchorPoint(ax, ay);
    }
    return { changed, name: character.name, size: [Math.round(r.width), Math.round(r.height)], from: target.name };
}

/** Bật trim + TRIMMED (+ anchor chân cho ảnh nhân vật) và cập nhật size. */
function prepareVisual(n, footAnchor) {
    const { Sprite, UITransform } = cc();
    const sp = n.getComponent(Sprite) || n.addComponent(Sprite);
    sp.trim = true;
    sp.sizeMode = Sprite.SizeMode.TRIMMED;
    const ut = n.getComponent(UITransform) || n.addComponent(UITransform);
    if (footAnchor && (ut.anchorX !== 0.5 || ut.anchorY !== 0)) ut.setAnchorPoint(0.5, 0);
    fitContentSize(n);
}

/** Chiều cao phần hình nhìn thấy (đã nhân scale). */
function visibleHeight(n) {
    const sp = n && n.getComponent(cc().Sprite);
    return sp && sp.spriteFrame ? sp.spriteFrame.rect.height * Math.abs(n.scale.y) : 0;
}

/** Scale các trạng thái để phần hình cao = Normal × tỉ lệ. ratios: { tênNode: 0.8 } (mặc định 1). */
function normalizeCharacter(owner, ratios) {
    const normal = owner.getChildByName('Normal');
    const hn = visibleHeight(normal);
    if (!(hn > 0)) return [];
    const done = [];
    for (const c of owner.children) {
        if (!isVisual(c) || c === normal) continue;
        const sp = c.getComponent(cc().Sprite);
        if (!sp.spriteFrame) continue;
        const ratio = (ratios && ratios[c.name]) || 1;
        const s = (hn * ratio) / sp.spriteFrame.rect.height;
        c.setScale(s, s, 1);
        done.push(c.name);
    }
    return done;
}

function removeOnion(root) {
    const ghosts = [];
    walk(root, (n) => { if (n.name === ONION) ghosts.push(n); });
    ghosts.forEach((g) => { g.removeFromParent(); g.destroy(); });
    return ghosts.length;
}

/** Món đúng của nhân vật: ưu tiên correctItem (kéo thả), không có thì tìm theo correctItemID cũ. */
function correctOf(owner) {
    const slot = owner.getComponent('CharacterSlot');
    if (!slot) return null;
    let it = slot.correctItem && slot.correctItem.isValid ? slot.correctItem : null;
    if (!it && slot.correctItemID) {
        walk(cc().director.getScene(), (n) => {
            const d = !it && n.getComponent('DraggableItem');
            if (d && String(d.itemID).toLowerCase() === slot.correctItemID.toLowerCase()) it = d;
        });
    }
    return it ? { uuid: it.node.uuid, name: it.node.name, itemID: it.itemID } : null;
}

module.exports = {
    load() {},
    unload() {
        try { removeOnion(cc().director.getScene()); } catch (e) { /* ignore */ }
    },
    methods: {
        /** Đọc owner + các thẻ ảnh cho node đang chọn. */
        read(selectedUuid) {
            const { director, Sprite } = cc();
            const { owner, focus } = ownerOf(findByUuid(director.getScene(), selectedUuid));
            if (!owner) return null;
            const normal = isCharacter(owner) ? owner.getChildByName('Normal') : null;
            return {
                owner: {
                    uuid: owner.uuid,
                    name: owner.name,
                    isCharacter: isCharacter(owner),
                    active: owner.active,
                    self: owner.getComponent(Sprite) ? card(owner) : null,
                    normalHeight: visibleHeight(normal),
                    correct: isCharacter(owner) ? correctOf(owner) : null,
                },
                focus,
                cards: owner.children.filter(isVisual).map(card),
            };
        },

        /** main.js gọi khi 1 node đổi: đồng bộ vùng chạm nhân vật. */
        syncNode(uuid) {
            const node = findByUuid(cc().director.getScene(), uuid);
            if (!node || node.name === ONION) return null;
            const { owner } = ownerOf(node);
            return isCharacter(owner) ? syncHitArea(owner) : null;
        },

        /** Sau khi đổi ảnh 1 thẻ: bật trim/TRIMMED, neo chân nếu là ảnh nhân vật, (tuỳ chọn) cân theo Normal. */
        prepare(uuid, opts) {
            const node = findByUuid(cc().director.getScene(), uuid);
            if (!node) return { ok: false, error: 'Không tìm thấy node' };
            const parentIsChar = isCharacter(node.parent);
            prepareVisual(node, parentIsChar);
            if (parentIsChar && opts && opts.normalize && node.name !== 'Normal') {
                normalizeCharacter(node.parent, { [node.name]: opts.ratio || 1 });
            }
            const hit = parentIsChar ? syncHitArea(node.parent) : (isCharacter(node) ? syncHitArea(node) : null);
            return { ok: true, hit, trimmed: frameInfo(node.getComponent(cc().Sprite)).trimmed };
        },

        /** Cập nhật lại size mọi ảnh của owner (sau khi reimport trim). */
        refresh(ownerUuid) {
            const owner = findByUuid(cc().director.getScene(), ownerUuid);
            if (!owner) return null;
            if (owner.getComponent(cc().Sprite)) fitContentSize(owner);
            owner.children.filter(isVisual).forEach(fitContentSize);
            return isCharacter(owner) ? syncHitArea(owner) : null;
        },

        /** Nút "Cân theo Normal" cho 1 nhân vật. */
        normalize(ownerUuid, ratios) {
            const owner = findByUuid(cc().director.getScene(), ownerUuid);
            if (!isCharacter(owner)) return { ok: false, error: 'Node này không phải nhân vật' };
            const done = normalizeCharacter(owner, ratios || {});
            return { ok: true, done, hit: syncHitArea(owner) };
        },

        /** Onion skin: hiện mờ ảnh Normal phía sau khi đang chỉnh trạng thái khác. Không lưu vào scene. */
        onion(ownerUuid, focusName, on) {
            const { director, Node, Sprite, UITransform, Color, CCObject } = cc();
            const scene = director.getScene();
            const owner = findByUuid(scene, ownerUuid);
            const normal = owner && isCharacter(owner) ? owner.getChildByName('Normal') : null;
            const want = !!(on && normal && focusName && focusName !== 'Normal');
            let ghost = null;
            const found = [];
            walk(scene, (n) => { if (n.name === ONION) found.push(n); });
            for (const n of found) {
                if (!ghost && n.parent === owner) ghost = n;
                else { n.removeFromParent(); n.destroy(); }
            }
            if (!want) {
                if (ghost) { ghost.removeFromParent(); ghost.destroy(); }
                return { onion: false };
            }
            const nsp = normal.getComponent(Sprite);
            const nut = normal.getComponent(UITransform);
            if (!ghost) {
                ghost = new Node(ONION);
                ghost._objFlags |= CCObject.Flags.DontSave | CCObject.Flags.HideInHierarchy | CCObject.Flags.LockedInEditor;
                ghost.layer = owner.layer;
                owner.addChild(ghost);
                ghost.setSiblingIndex(0);
                ghost.addComponent(UITransform);
                ghost.addComponent(Sprite);
            }
            const gsp = ghost.getComponent(Sprite);
            const gut = ghost.getComponent(UITransform);
            if (gsp.spriteFrame !== nsp.spriteFrame) gsp.spriteFrame = nsp.spriteFrame;
            if (!gsp.trim) gsp.trim = true;
            if (gsp.sizeMode !== nsp.sizeMode) gsp.sizeMode = nsp.sizeMode;
            if (gsp.color.a !== 90) gsp.color = new Color(255, 255, 255, 90);
            if (gut.anchorX !== nut.anchorX || gut.anchorY !== nut.anchorY) gut.setAnchorPoint(nut.anchorX, nut.anchorY);
            if (!ghost.position.equals(normal.position)) ghost.setPosition(normal.position);
            if (!ghost.scale.equals(normal.scale)) ghost.setScale(normal.scale);
            if (!ghost.active) ghost.active = true;
            return { onion: true };
        },

        removeOnion() {
            return removeOnion(cc().director.getScene());
        },

        /** Đặt món đúng cho nhân vật (itemUuid rỗng = bỏ chọn). */
        setCorrect(ownerUuid, itemUuid) {
            const scene = cc().director.getScene();
            const owner = findByUuid(scene, ownerUuid);
            const slot = owner && owner.getComponent('CharacterSlot');
            if (!slot) return { ok: false, error: 'Node này không phải nhân vật' };
            const itemNode = itemUuid ? findByUuid(scene, itemUuid) : null;
            const item = itemNode && itemNode.getComponent('DraggableItem');
            if (itemUuid && !item) return { ok: false, error: 'Không tìm thấy món đồ' };
            slot.correctItem = item || null;
            slot.correctItemID = item ? String(item.itemID) : '';
            return { ok: true, correct: correctOf(owner) };
        },

        /** Tất cả món đồ (DraggableItem) trong scene. */
        listItems() {
            const items = [];
            walk(cc().director.getScene(), (n) => {
                const it = n.name !== ONION && n.getComponent('DraggableItem');
                if (it) items.push({ ...card(n), itemID: it.itemID, correctFor: [] });
            });
            walk(cc().director.getScene(), (n) => {
                if (!isCharacter(n)) return;
                const c = correctOf(n);
                const hit = c && items.find((i) => i.uuid === c.uuid);
                if (hit) hit.correctFor.push(n.name);
            });
            return items;
        },

        /**
         * Đổi tên món đồ. syncId = true: đổi cả itemID và mọi chỗ dùng ID cũ
         * (đáp án đúng, danh sách ảnh nhân vật, tên node ảnh con của nhân vật).
         */
        renameItem(uuid, newName, syncId) {
            const scene = cc().director.getScene();
            const node = findByUuid(scene, uuid);
            const item = node && node.getComponent('DraggableItem');
            if (!item) return { ok: false, error: 'Không tìm thấy món đồ' };
            newName = String(newName || '').trim();
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(newName)) return { ok: false, error: 'Tên chỉ gồm chữ, số, _ và bắt đầu bằng chữ (vd Water, Shoe_2)' };
            const oldId = String(item.itemID);
            const lower = (s) => String(s).toLowerCase();
            const others = [];
            walk(scene, (n) => { const it = n !== node && n.getComponent('DraggableItem'); if (it) others.push(it); });
            if (syncId && others.some((it) => lower(it.itemID) === lower(newName))) return { ok: false, error: `Đã có món đồ khác dùng ID "${newName}"` };

            const changes = [`node ${node.name} → ${newName}`];
            node.name = newName;
            if (syncId && oldId !== newName) {
                item.itemID = newName;
                changes.push(`itemID ${oldId} → ${newName}`);
                walk(scene, (n) => {
                    const slot = n.getComponent('CharacterSlot');
                    if (!slot) return;
                    // correctItem là tham chiếu tới node nên tự đúng; chỉ cập nhật ID cũ (ẩn) cho đồng bộ
                    if (lower(slot.correctItemID) === lower(oldId)) slot.correctItemID = newName;
                    for (const v of slot.itemVisuals || []) if (lower(v.itemID) === lower(oldId)) v.itemID = newName;
                    const child = n.children.find((c) => c.name !== ONION && lower(c.name) === lower(oldId));
                    if (child) { child.name = newName; changes.push(`${n.name}/${oldId} → ${newName}`); }
                });
            }
            return { ok: true, oldId, newId: syncId ? newName : oldId, changes };
        },

        /**
         * "Gán theo tên" bước 1: so tên ảnh với nhân vật / món đồ trong scene.
         * frames: [{ base: 'messi_wc', uuid }]. Quy ước: <nhânvật>_<trạngthái>, item_<itemID>.
         */
        planByName(frames) {
            const { director } = cc();
            const byName = new Map(frames.map((f) => [f.base.toLowerCase(), f.uuid]));
            const used = new Set();
            const plan = [], missing = [];
            walk(director.getScene(), (n) => {
                if (n.name === ONION) return;
                if (isCharacter(n)) {
                    const key = n.name.toLowerCase();
                    const aliases = [key, ...(ALIASES[key] || [])];
                    for (const c of n.children.filter(isVisual)) {
                        const state = c.name.toLowerCase();
                        const hit = aliases.map((a) => `${a}_${state}`).find((k) => byName.has(k));
                        if (hit) { plan.push({ uuid: c.uuid, label: `${n.name}/${c.name}`, frame: byName.get(hit), file: hit, foot: true }); used.add(hit); }
                        else missing.push(`${n.name}/${c.name} (cần ${aliases[0]}_${state}${aliases[1] ? ' hoặc ' + aliases[1] + '_' + state : ''})`);
                    }
                }
                const item = n.getComponent('DraggableItem');
                if (item) {
                    const keys = [`item_${String(item.itemID).toLowerCase()}`, `item_${n.name.toLowerCase()}`];
                    const hit = keys.find((k) => byName.has(k));
                    if (hit) { plan.push({ uuid: n.uuid, label: `món ${n.name}`, frame: byName.get(hit), file: hit, foot: false }); used.add(hit); }
                    else missing.push(`món ${n.name} (cần ${keys[0]})`);
                }
            });
            const unused = frames.map((f) => f.base).filter((b) => !used.has(b.toLowerCase()));
            return { plan, missing, unused };
        },

        /** "Gán theo tên" bước 2: gán ảnh theo plan, (tuỳ chọn) cân theo Normal. */
        async applyPlan(plan, opts) {
            const { director, Sprite } = cc();
            const scene = director.getScene();
            const chars = new Set();
            const errors = [];
            for (const p of plan) {
                const node = findByUuid(scene, p.uuid);
                const frame = await loadFrame(p.frame);
                if (!node || !frame) { errors.push(p.label); continue; }
                (node.getComponent(Sprite) || node.addComponent(Sprite)).spriteFrame = frame;
                prepareVisual(node, p.foot);
                if (p.foot) chars.add(node.parent);
            }
            const hits = [];
            for (const ch of chars) {
                if (opts && opts.normalize) normalizeCharacter(ch, {});
                hits.push(syncHitArea(ch));
            }
            return { ok: true, count: plan.length - errors.length, errors, hits };
        },
    },
};
