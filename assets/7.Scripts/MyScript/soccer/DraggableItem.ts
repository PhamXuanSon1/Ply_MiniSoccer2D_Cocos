import { _decorator, Component, EventTouch, Node, UITransform, v3, Vec2, Vec3 } from 'cc';
import { World } from '../../Manager/World';
import { gc } from '../../Tool/GameController';
import { soccer } from './SoccerContext';
const { ccclass, property, requireComponent } = _decorator;

/**
 * Món đồ kéo thả (port từ Unity DraggableItem).
 * Kéo theo ngón tay, thả lên nhân vật thì nhân vật nhận, thả trượt thì về chỗ cũ.
 */
@ccclass('DraggableItem')
@requireComponent(UITransform)
export class DraggableItem extends Component {

    @property({ tooltip: 'ID của vật phẩm (vd: WC, Euro, Bong, Steak)' })
    itemID: string = '';

    /** Tương đương bật/tắt Collider bên Unity. */
    interactable: boolean = false;

    private dragging = false;
    private originalPos = new Vec3();
    private offset = new Vec3();
    private tmp = new Vec3();

    onLoad() {
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    onDestroy() {
        this.node.off(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.off(Node.EventType.TOUCH_MOVE, this.onTouchMove, this);
        this.node.off(Node.EventType.TOUCH_END, this.onTouchEnd, this);
        this.node.off(Node.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    onDisable() {
        this.dragging = false;
    }

    private onTouchStart(e: EventTouch) {
        if (!this.interactable || (gc && gc.stopped)) return;
        const mgr = soccer.mgr;
        // Chỉ cho kéo khi món đồ đã bay tới vị trí target
        if (mgr && !mgr.isItemReady) return;

        this.dragging = true;
        this.originalPos.set(this.node.worldPosition);
        const p = this.touchToWorld(e);
        Vec3.subtract(this.offset, this.node.worldPosition, p);
        this.offset.z = 0;

        // Đưa món đồ lên trên cùng khi kéo (thay cho sortingOrder = 100)
        this.node.setSiblingIndex(this.node.parent!.children.length - 1);

        mgr?.onFirstItemDragged();
    }

    private onTouchMove(e: EventTouch) {
        if (!this.dragging) return;
        const p = this.touchToWorld(e);
        this.node.setWorldPosition(p.x + this.offset.x, p.y + this.offset.y, this.node.worldPosition.z);
    }

    private onTouchEnd(e: EventTouch) {
        if (!this.dragging) return;
        this.dragging = false;

        const p = this.touchToWorld(e);
        const point = new Vec2(p.x, p.y);
        let dropped = false;
        const mgr = soccer.mgr;
        if (mgr && this.interactable) {
            for (const slot of mgr.characterList) {
                if (slot && slot.containsWorldPoint(point)) {
                    dropped = slot.onItemDropped(this);
                    if (dropped) break;
                }
            }
        }

        // Không thả vào nhân vật phù hợp -> về vị trí ban đầu
        if (!dropped) this.node.setWorldPosition(this.originalPos);
    }

    /** Toạ độ chạm -> toạ độ world của UI camera. */
    private touchToWorld(e: EventTouch): Vec3 {
        const cam = World.ins?.ui?.uiCam;
        if (cam) {
            const loc = e.getLocation();
            return cam.screenToWorld(v3(loc.x, loc.y, 0), this.tmp);
        }
        const ui = e.getUILocation();
        return this.tmp.set(ui.x, ui.y, 0);
    }
}
