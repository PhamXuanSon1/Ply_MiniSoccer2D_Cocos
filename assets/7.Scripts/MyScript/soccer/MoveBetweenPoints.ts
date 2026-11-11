import { _decorator, Component, Node, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Chạy đều từ A tới B rồi quay về A chạy tiếp, lặp vô hạn (port từ Unity MoveBetweenPoints).
 * Tính lại vị trí A/B mỗi frame để vẫn đúng khi UI.resize đổi scale gameplay.
 */
@ccclass('MoveBetweenPoints')
export class MoveBetweenPoints extends Component {

    @property({ type: Node, tooltip: 'Điểm xuất phát' })
    pointA: Node | null = null;

    @property({ type: Node, tooltip: 'Điểm đích' })
    pointB: Node | null = null;

    @property({ tooltip: 'Thời gian chạy từ A tới B (giây)' })
    duration: number = 2;

    private elapsed = 0;
    private tmp = new Vec3();

    onEnable() {
        this.elapsed = 0;
        if (!this.pointA || !this.pointB) console.warn('MoveBetweenPoints: chưa gán pointA / pointB');
    }

    update(dt: number) {
        if (!this.pointA || !this.pointB || this.duration <= 0) return;
        this.elapsed = (this.elapsed + dt) % this.duration;
        Vec3.lerp(this.tmp, this.pointA.worldPosition, this.pointB.worldPosition, this.elapsed / this.duration);
        this.node.setWorldPosition(this.tmp);
    }
}
