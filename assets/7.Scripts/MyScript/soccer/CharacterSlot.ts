import { _decorator, Component, Enum, Node, Tween, tween, UITransform, Vec2 } from 'cc';
import { FxType, Ply_SoundManager } from '../ScriptTemplate/Ply_SoundManager';
import { DraggableItem } from './DraggableItem';
import { soccer } from './SoccerContext';
const { ccclass, property, requireComponent } = _decorator;

/** Node con hiển thị nhân vật khi nhận 1 món đồ cụ thể + tiếng phản ứng. */
@ccclass('CharacterItemVisual')
export class CharacterItemVisual {
    @property({ tooltip: 'ID của món đồ (phải khớp DraggableItem.itemID)' })
    itemID: string = '';

    @property({ type: Node, tooltip: 'Node con hiển thị nhân vật khi cầm món đồ này' })
    visual: Node | null = null;

    @property({ type: Enum(FxType), tooltip: 'Âm thanh phát khi nhân vật nhận món đồ này' })
    fxType: FxType = FxType.Siuu;
}

/**
 * Nhân vật nhận đồ (port từ Unity CharacterSlot).
 * Gốc node = chân nhân vật; các node con là từng trạng thái ảnh (anchor 0.5,0, trim).
 * Vùng chạm / thả của node tự khớp với phần hình nhìn thấy của ảnh đang bật.
 */
@ccclass('CharacterSlot')
@requireComponent(UITransform)
export class CharacterSlot extends Component {

    @property({ type: Node, tooltip: 'Node con hiển thị lúc bình thường (chưa nhận đồ)' })
    normalVisual: Node | null = null;

    @property({ type: [CharacterItemVisual], tooltip: 'Node con ứng với từng món đồ' })
    itemVisuals: CharacterItemVisual[] = [];

    @property({ type: DraggableItem, tooltip: 'Kéo node món đồ ĐÚNG của nhân vật này (wc, steak, bong, euro...) vào đây' })
    correctItem: DraggableItem | null = null;

    /** Cách cũ (gõ itemID). Ẩn khỏi Inspector, chỉ dùng khi chưa kéo Correct Item. */
    @property({ visible: false })
    correctItemID: string = '';

    @property({ type: Node, tooltip: 'Điểm món đồ bay tới. Để trống = gốc node (chân nhân vật)' })
    flyTarget: Node | null = null;

    @property
    flyToCharacterDuration: number = 0.35;

    hasReceivedItem: boolean = false;
    isCorrectItemReceived: boolean = false;

    /** Tương đương bật/tắt Collider bên Unity: tắt thì không nhận thả / chạm. */
    private acceptInput: boolean = true;
    private uiTransform: UITransform | null = null;

    onLoad() {
        this.uiTransform = this.getComponent(UITransform);
        this.showVisual(this.normalVisual);
        this.node.on(Node.EventType.TOUCH_END, this.onTap, this);
    }

    onDestroy() {
        this.node.off(Node.EventType.TOUCH_END, this.onTap, this);
    }

    /** Điểm (toạ độ world) có nằm trong phần hình nhìn thấy của nhân vật không. */
    containsWorldPoint(point: Vec2): boolean {
        if (!this.acceptInput || !this.uiTransform) return false;
        return this.uiTransform.getBoundingBoxToWorld().contains(point);
    }

    /** Đặt lại trạng thái nhân vật và tuỳ chọn cho phép nhận đồ lại. */
    resetCharacter(enableInput: boolean = true) {
        this.hasReceivedItem = false;
        this.isCorrectItemReceived = false;
        this.showVisual(this.normalVisual);
        this.acceptInput = enableInput;
    }

    /** Chạm vào nhân vật = thả món đồ đang chờ vào nhân vật này. */
    private onTap() {
        if (!this.acceptInput || this.hasReceivedItem) return;
        const mgr = soccer.mgr;
        if (!mgr || !mgr.isItemReady) return;

        mgr.onFirstItemDragged();
        const item = mgr.getCurrentActiveItem();
        if (item) this.onItemDropped(item);
    }

    /** Nhận vật phẩm, xác định đúng/sai, cho món đồ bay vào nhân vật rồi đổi hình. */
    onItemDropped(item: DraggableItem): boolean {
        if (this.hasReceivedItem || !this.acceptInput || !item) return false;

        this.hasReceivedItem = true;
        this.isCorrectItemReceived = this.correctItem
            ? this.correctItem === item
            : !!this.correctItemID && this.correctItemID.toLowerCase() === item.itemID.toLowerCase();
        this.acceptInput = false;
        item.interactable = false;

        // Khoá món đồ hiện tại để không nhân vật khác nhận trùng trong lúc nó đang bay
        const mgr = soccer.mgr;
        if (mgr) mgr.isItemReady = false;

        const target = (this.flyTarget ?? this.node).worldPosition.clone();
        Tween.stopAllByTarget(item.node);
        tween(item.node)
            .to(this.flyToCharacterDuration, { worldPosition: target }, { easing: 'quadIn' })
            .call(() => {
                item.node.active = false;

                const entry = this.findVisual(item.itemID);
                if (entry && entry.visual) this.showVisual(entry.visual);

                Ply_SoundManager.Ins?.playFx(entry ? entry.fxType : FxType.Siuu);

                soccer.mgr?.onItemCompleted();
            })
            .start();

        return true;
    }

    private showVisual(target: Node | null) {
        if (this.normalVisual) this.normalVisual.active = this.normalVisual === target;
        for (const v of this.itemVisuals) {
            if (v.visual) v.visual.active = v.visual === target;
        }
        this.syncHitArea(target);
    }

    /**
     * Cho vùng chạm của node cha = khung phần hình nhìn thấy của ảnh đang bật
     * (ảnh dùng trim nên content size của node con chính là phần có pixel).
     */
    private syncHitArea(target: Node | null) {
        const ut = this.uiTransform;
        const childUt = target?.getComponent(UITransform);
        if (!ut || !childUt) return;
        const r = childUt.getBoundingBox(); // toạ độ trong node cha, đã tính scale/vị trí con
        if (r.width <= 0 || r.height <= 0) return;
        ut.setContentSize(r.width, r.height);
        ut.setAnchorPoint(-r.x / r.width, -r.y / r.height);
    }

    private findVisual(itemID: string): CharacterItemVisual | null {
        const id = itemID.toLowerCase();
        for (const v of this.itemVisuals) {
            if (v.itemID.toLowerCase() === id) return v;
        }
        return null;
    }
}
