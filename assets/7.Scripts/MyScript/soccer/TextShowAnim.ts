import { _decorator, Component, Enum, Tween, tween, UIOpacity, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

export enum TextAnimType {
    /** Bật nảy từ nhỏ lên rồi nhịp nhẹ liên tục (dùng cho YOU WIN). */
    PopBounce,
    /** Rơi "đập" từ to xuống + hiện dần rồi rung lắc (dùng cho YOU LOSE). */
    SlamShake,
}

/**
 * Animation khi node được bật (gắn lên node chữ Win / Lose).
 * Mỗi lần node active lại là chạy lại từ đầu.
 */
@ccclass('TextShowAnim')
export class TextShowAnim extends Component {

    @property({ type: Enum(TextAnimType), tooltip: 'Kiểu animation khi hiện' })
    type: TextAnimType = TextAnimType.PopBounce;

    @property({ tooltip: 'Thời gian hiện (giây)' })
    duration: number = 0.45;

    @property({ tooltip: 'Sau khi hiện xong có nhịp / rung tiếp không' })
    loop: boolean = true;

    private baseScale = new Vec3(1, 1, 1);
    private basePos = new Vec3();
    private opacity: UIOpacity | null = null;

    onLoad() {
        this.baseScale.set(this.node.scale);
        this.basePos.set(this.node.position);
        this.opacity = this.getComponent(UIOpacity) || this.addComponent(UIOpacity);
    }

    onEnable() {
        this.play();
    }

    onDisable() {
        this.stop();
        this.node.setScale(this.baseScale);
        this.node.setPosition(this.basePos);
        if (this.opacity) this.opacity.opacity = 255;
    }

    play() {
        this.stop();
        if (this.type === TextAnimType.PopBounce) this.playPop();
        else this.playSlam();
    }

    private stop() {
        Tween.stopAllByTarget(this.node);
        if (this.opacity) Tween.stopAllByTarget(this.opacity);
    }

    private scaled(k: number) {
        return new Vec3(this.baseScale.x * k, this.baseScale.y * k, this.baseScale.z);
    }

    private playPop() {
        const d = this.duration;
        this.node.setScale(this.scaled(0));
        if (this.opacity) this.opacity.opacity = 255;
        const t = tween(this.node)
            .to(d * 0.6, { scale: this.scaled(1.2) }, { easing: 'backOut' })
            .to(d * 0.4, { scale: this.scaled(1) }, { easing: 'sineOut' });
        if (this.loop) {
            t.call(() => {
                tween(this.node)
                    .to(0.5, { scale: this.scaled(1.06) }, { easing: 'sineInOut' })
                    .to(0.5, { scale: this.scaled(1) }, { easing: 'sineInOut' })
                    .union()
                    .repeatForever()
                    .start();
            });
        }
        t.start();
    }

    private playSlam() {
        const d = this.duration;
        const p = this.basePos;
        this.node.setScale(this.scaled(1.8));
        this.node.setPosition(p);
        if (this.opacity) {
            this.opacity.opacity = 0;
            tween(this.opacity).to(d * 0.5, { opacity: 255 }).start();
        }
        const t = tween(this.node)
            .to(d * 0.5, { scale: this.scaled(0.92) }, { easing: 'quadIn' })
            .to(d * 0.25, { scale: this.scaled(1) }, { easing: 'quadOut' });
        if (this.loop) {
            const shake = (dx: number, time: number) => ({ time, pos: new Vec3(p.x + dx, p.y, p.z) });
            const steps = [shake(-16, 0.05), shake(14, 0.06), shake(-10, 0.06), shake(6, 0.06), shake(0, 0.05)];
            for (const s of steps) t.to(s.time, { position: s.pos });
        }
        t.start();
    }
}
