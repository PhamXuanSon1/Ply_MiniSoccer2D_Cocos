import { _decorator, Component, Node, Sprite, SpriteFrame, UITransform, Vec2 } from 'cc';
const { ccclass, property, requireComponent } = _decorator;

/** 1 trạng thái ảnh của nhân vật (ứng với 1 node con). */
@ccclass('CharacterSkin')
export class CharacterSkin {
    @property({ tooltip: 'Tên node con: Normal, WC, Steak, Bong, Euro' })
    nodeName: string = 'Normal';

    @property({ type: SpriteFrame, tooltip: 'Ảnh của trạng thái này. Kéo ảnh mới vào rồi bấm "Áp dụng"' })
    sprite: SpriteFrame | null = null;

    @property({ tooltip: 'Scale riêng của ảnh này (nhân thêm sau Fit Height)' })
    scale: number = 1;

    @property({ type: Vec2, tooltip: 'Lệch so với chân nhân vật (gốc node cha). (0,0) = chân đứng đúng gốc' })
    offset: Vec2 = new Vec2();
}

/**
 * Tool đổi ảnh nhân vật (dùng trong Editor, gắn trên node nhân vật cùng CharacterSlot).
 *
 * Cách dùng:
 *  1. Bấm "Đọc từ node con" để điền danh sách theo ảnh đang có.
 *  2. Kéo ảnh mới vào ô Sprite của trạng thái muốn đổi, chỉnh Scale / Offset nếu cần.
 *  3. Bấm "Áp dụng" rồi lưu scene.
 *
 * Vì sao chân không bị lệch: khi áp dụng, ảnh được bật trim (chỉ vẽ phần có pixel) và anchor (0.5, 0).
 * Phần trong suốt thừa ở đáy / hai bên ảnh bị bỏ, nên đáy phần hình nhìn thấy (bàn chân, mông nếu
 * ngồi...) luôn nằm đúng gốc node, bất kể ảnh to nhỏ hay tỉ lệ khác nhau.
 * Lưu ý: SpriteFrame phải để Trim Type = Auto (mặc định khi import).
 */
@ccclass('CharacterVisualTool')
@requireComponent(UITransform)
export class CharacterVisualTool extends Component {

    @property({ type: [CharacterSkin], tooltip: 'Danh sách trạng thái ảnh của nhân vật' })
    skins: CharacterSkin[] = [];

    @property({ tooltip: '> 0: tự scale để phần hình nhìn thấy cao đúng N px (giúp các ảnh to nhỏ khác nhau đều nhau). 0 = tắt' })
    fitHeight: number = 0;

    @property({ displayName: '⟲ Đọc từ node con', tooltip: 'Điền danh sách theo các node con đang có Sprite' })
    get readChildrenButton() { return false; }
    set readChildrenButton(v: boolean) { if (v) this.readFromChildren(); }

    @property({ displayName: '▶ Áp dụng', tooltip: 'Gán ảnh, bật trim, anchor chân (0.5, 0), scale, offset' })
    get applyButton() { return false; }
    set applyButton(v: boolean) { if (v) this.apply(); }

    /** Điền skins từ các node con hiện có. */
    readFromChildren() {
        const list: CharacterSkin[] = [];
        for (const child of this.node.children) {
            const sp = child.getComponent(Sprite);
            if (!sp) continue;
            const s = new CharacterSkin();
            s.nodeName = child.name;
            s.sprite = sp.spriteFrame;
            const base = this.fitScale(sp.spriteFrame);
            s.scale = base > 0 ? child.scale.x / base : child.scale.x;
            s.offset = new Vec2(child.position.x, child.position.y);
            list.push(s);
        }
        this.skins = list;
        console.log(`[CharacterVisualTool] ${this.node.name}: đọc ${list.length} trạng thái`);
    }

    /** Áp dụng ảnh + trim + anchor chân cho từng node con. */
    apply() {
        for (const skin of this.skins) {
            let child = this.node.getChildByName(skin.nodeName);
            if (!child) {
                child = new Node(skin.nodeName);
                child.layer = this.node.layer;
                this.node.addChild(child);
                child.active = false;
            }
            const sp = child.getComponent(Sprite) ?? child.addComponent(Sprite);
            if (skin.sprite) sp.spriteFrame = skin.sprite;
            sp.trim = true;
            sp.sizeMode = Sprite.SizeMode.TRIMMED;

            const ut = child.getComponent(UITransform)!;
            ut.setAnchorPoint(0.5, 0);

            const base = this.fitScale(sp.spriteFrame);
            const s = (base > 0 ? base : 1) * skin.scale;
            child.setScale(s, s, 1);
            child.setPosition(skin.offset.x, skin.offset.y, 0);
        }
        console.log(`[CharacterVisualTool] ${this.node.name}: đã áp dụng ${this.skins.length} trạng thái. Nhớ lưu scene.`);
    }

    /** Scale để phần hình nhìn thấy cao đúng fitHeight; 0 nếu tắt. */
    private fitScale(frame: SpriteFrame | null): number {
        if (this.fitHeight <= 0 || !frame || frame.rect.height <= 0) return 0;
        return this.fitHeight / frame.rect.height;
    }
}
