'use strict';

const PKG = 'character-visual-tool';
let timer = null;
const pending = new Set();

/**
 * Đổi spriteFrame / bật tắt node con trực tiếp trong Inspector cũng tự cập nhật
 * contentSize (vùng chạm) của node nhân vật, không cần mở panel.
 */
function onNodeChanged(uuid) {
    if (!uuid) return;
    pending.add(uuid);
    clearTimeout(timer);
    timer = setTimeout(async () => {
        const list = [...pending];
        pending.clear();
        let changed = false;
        for (const id of list) {
            try {
                const r = await Editor.Message.request('scene', 'execute-scene-script', { name: PKG, method: 'syncNode', args: [id] });
                if (r && r.changed) changed = true;
            } catch (e) { /* scene đang reload */ }
        }
        if (changed) {
            try { await Editor.Message.request('scene', 'snapshot'); } catch (e) { /* ignore */ }
        }
    }, 150);
}

exports.methods = {
    openPanel() {
        Editor.Panel.open(PKG);
    },
};

exports.load = function () {
    Editor.Message.addBroadcastListener('scene:change-node', onNodeChanged);
};

exports.unload = function () {
    Editor.Message.removeBroadcastListener('scene:change-node', onNodeChanged);
    clearTimeout(timer);
};
