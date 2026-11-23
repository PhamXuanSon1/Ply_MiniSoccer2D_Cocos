import { _decorator, Camera, CCObject, Color, Component, EventMouse, EventTouch, input, Input, js, Node, Tween, tween, Vec2, Vec3 } from 'cc';
import type { Graphics } from 'cc';
import { EDITOR, PREVIEW } from 'cc/env';
import { FxType, Ply_SoundManager } from '../ScriptTemplate/Ply_SoundManager';
import { RonaldoKick } from './RonaldoKick';
const { ccclass, executeInEditMode, property } = _decorator;
const EDIT_MODE = EDITOR && !PREVIEW;
const TARGET_GROUP = { name: 'Target Area', id: 'target-area' };
const FULL_TURN = 2 * Math.PI;

function wrapAngle(angle: number) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Sút bóng kiểu ná cao su.
 *  - Nhấn: neo kéo tại quả bóng, vector kéo = điểm chạm - bóng.
 *  - Tay ở trên bóng: điểm rơi = đúng vị trí tay (tay tới đâu aim line tới đó).
 *  - Tay ở dưới bóng: kiểu ná, độ xa theo độ dài kéo dọc, trái/phải theo X của tay.
 *  - restrictToTargetArea: kẹp điểm rơi vào trong vùng Target Area.
 *  - Thả: bóng bay theo đúng đường parabol của Line, vừa bay vừa xoay và giảm scale 1 -> endScale.
 *
 * Gắn lên node Aim (cùng cha với Ball). Line là con của Aim, mỗi node con của Line là 1 chấm (vd ParticleSystem2D).
 * Đường bay bắt đầu theo hướng sút rồi uốn cong về điểm rơi T.
 */
@ccclass('SlingshotShooter')
@executeInEditMode(true)
export class SlingshotShooter extends Component {

    // ------------------------------------------------------------ tham chiếu
    @property({ type: Node, tooltip: 'Quả bóng (cùng cha với node này)' })
    ball: Node | null = null;

    @property({ type: Node, tooltip: 'Node chứa các chấm của đường ngắm (con của node này)' })
    line: Node | null = null;

    @property({ type: Node, tooltip: '(Tuỳ chọn) Node đánh dấu điểm rơi, được đặt tại cuối đường' })
    target: Node | null = null;

    @property({ type: Camera, tooltip: 'Camera render gameplay (UICam) để đổi toạ độ chạm sang world' })
    cam: Camera | null = null;

    @property({ type: RonaldoKick, tooltip: 'Animation sút tùy chọn trên node Ronaldo' })
    ronaldoKick: RonaldoKick | null = null;

    // ------------------------------------------------------------ lực kéo
    @property({ tooltip: 'Độ dài kéo theo chiều dọc (toạ độ local) ứng với lực tối đa' })
    maxDrag: number = 450;

    @property({ min: 1, tooltip: 'Khoảng cách tối thiểu từ tay tới bóng (toạ độ local) để bắt đầu ngắm' })
    minDrag: number = 24;

    @property({ tooltip: 'Lực tối thiểu (0..1) của cú sút sau khi vượt ngưỡng kéo' })
    minPower: number = 0.15;

    @property({ min: 0, step: 0.01, tooltip: 'Thời gian làm mượt góc ngắm trái/phải (giây). 0 = bám ngay.' })
    aimSmoothTime = 0.1;

    @property({ group: TARGET_GROUP })
    targetNear: Node | null = null;

    @property({ group: TARGET_GROUP })
    targetFarLeft: Node | null = null;

    @property({ group: TARGET_GROUP })
    targetFarRight: Node | null = null;

    @property({ group: TARGET_GROUP, tooltip: 'Màu của đường viền và phần tô trong Scene View' })
    targetGizmoColor = new Color(27, 217, 255, 230);

    @property({ group: TARGET_GROUP, visible(this: SlingshotShooter) { return !this.hasTargetHandles; }, min: 0, tooltip: 'Khoảng cách tại lực 0. Mép gần của gizmo tính theo Min Power.' })
    minDistance: number = 700;

    @property({ group: TARGET_GROUP, visible(this: SlingshotShooter) { return !this.hasTargetHandles; }, min: 0, tooltip: 'Khoảng cách bay khi lực tối đa' })
    maxDistance: number = 2100;

    @property({ group: TARGET_GROUP, visible(this: SlingshotShooter) { return !this.hasTargetHandles; }, range: [0, 180, 1], tooltip: 'Nửa độ rộng vùng ngắm, tính từ hướng trung tâm' })
    maxAngle: number = 45;

    @property({ group: TARGET_GROUP, visible(this: SlingshotShooter) { return !this.hasTargetHandles; }, range: [-180, 180, 1], tooltip: 'Hướng trung tâm: 0 = lên, số dương xoay sang phải' })
    aimAngle = 0;

    @property({ group: TARGET_GROUP, tooltip: 'Hiện vùng điểm rơi trong Scene View' })
    showTargetGizmo = true;

    @property({ group: TARGET_GROUP, tooltip: 'Chỉ cho phép sút khi hướng sút nằm trong vùng ngắm' })
    restrictToTargetArea = false;

    // ------------------------------------------------------------ dáng parabol
    @property({ tooltip: 'Điểm điều khiển theo X = T.x * bendX (nhỏ = bóng vọt thẳng lên rồi mới bẻ ngang)' })
    bendX: number = 0.15;

    @property({ tooltip: 'Điểm điều khiển theo Y = T.y * bendY (> 1 = vồng cao hơn điểm rơi)' })
    bendY: number = 1.6;

    @property({ tooltip: 'Chấm đầu tiên cách bóng (0..1 theo đường bay)' })
    dotStart: number = 0.06;

    // ------------------------------------------------------------ bay
    @property({ tooltip: 'Thời gian bay (giây)' })
    flightTime: number = 0.8;

    @property({ tooltip: 'Scale bóng khi tới điểm rơi (so với scale ban đầu)' })
    endScale: number = 0.4;

    @property({ tooltip: 'Tốc độ xoay khi bay (độ / giây, âm = theo chiều kim đồng hồ)' })
    spinSpeed: number = -720;

    @property({ tooltip: 'Tự đặt lại bóng sau N giây khi bay xong (-1 = không, chỉ sút 1 lần)' })
    autoResetDelay: number = -1;

    @property({ tooltip: 'Sút hụt: bóng tiếp tục bay ra xa và nhỏ dần cho tới khi replay' })
    missKeepFlying = true;

    @property({ min: 0, step: 0.1, visible(this: SlingshotShooter) { return this.missKeepFlying; }, tooltip: 'Tốc độ thu nhỏ khi sút hụt (càng lớn càng nhanh, scale nhân exp(-rate * dt))' })
    missShrinkRate = 1.5;

    // ------------------------------------------------------------ hint lúc mới vào
    @property({ type: Node, tooltip: 'Điểm rơi đầu trái của hint (con của node này)' })
    pointL: Node | null = null;

    @property({ type: Node, tooltip: 'Điểm rơi đầu phải của hint (con của node này)' })
    pointR: Node | null = null;

    @property({ type: Node, tooltip: 'Text "Drag to Shoot", tắt khi người chơi bắt đầu kéo' })
    hintText: Node | null = null;

    @property({ tooltip: 'Thời gian Line lắc từ PointL sang PointR (giây), chậm dần ở 2 đầu' })
    hintSwingTime: number = 0.9;

    // ------------------------------------------------------------ trạng thái
    private dragging = false;
    private flying = false;
    private missing = false;                  // sút hụt: bóng đang bay tiếp ra xa
    private missVelocity = new Vec3();        // vận tốc (local cha của bóng) khi bắt đầu hụt
    private missScale0 = 1;
    private flightTween: Tween<{ t: number }> | null = null;
    private shot = false;
    private pointerId: number | null = null;   // touch id, -1 = chuột
    private startLocal = new Vec2();
    private dragLocal = new Vec2();
    private aimDirection: number | null = null;
    private power = 0;
    private canShoot = false;
    private landLocal = new Vec3();           // điểm rơi (local Aim, gốc tại bóng)
    private ballStartPos = new Vec3();
    private ballStartScale = new Vec3(1, 1, 1);
    private ballStartAngle = 0;
    private hinting = false;
    private hintPhase = 0;
    private targetGizmo: Graphics | null = null;
    private targetGizmoState = '';

    onLoad() {
        if (EDIT_MODE) return;
        if (this.ball) {
            this.ballStartPos.set(this.ball.position);
            this.ballStartScale.set(this.ball.scale);
            this.ballStartAngle = this.ball.angle;
            this.node.setPosition(this.ball.position); // gốc đường ngắm ở bóng
        }
        this.showLine(false);
        this.startHint();
    }

    // ============================================================ hint
    /** Line lắc qua lại giữa PointL và PointR + hiện text, chờ người chơi kéo. */
    startHint() {
        if (!this.pointL || !this.pointR) { if (this.hintText) this.hintText.active = false; return; }
        this.hinting = true;
        this.hintPhase = 0;
        if (this.hintText) this.hintText.active = true;
        this.updateHint(0);
        this.showLine(true);
    }

    private stopHint() {
        if (!this.hinting) return;
        this.hinting = false;
        if (this.hintText) this.hintText.active = false;
        this.showLine(false);
    }

    private updateHint(dt: number) {
        this.hintPhase = (this.hintPhase + dt / Math.max(0.01, this.hintSwingTime)) % 2;
        const k = this.hintPhase <= 1 ? this.hintPhase : 2 - this.hintPhase; // ping-pong 0..1..0
        const s = k * k * (3 - 2 * k);                                        // chậm ở 2 đầu
        Vec3.lerp(this.landLocal, this.pointL!.position, this.pointR!.position, s);
        this.layoutLine();
    }

    onEnable() {
        if (EDIT_MODE) {
            this.updateTargetGizmo();
            return;
        }
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
    }

    onDisable() {
        if (EDIT_MODE) {
            this.clearTargetGizmo();
            return;
        }
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
        this.ronaldoKick?.cancel();
    }

    // ============================================================ input (touch + chuột)
    private onTouchStart(e: EventTouch) { this.begin(e.getID(), e.getLocation()); }
    private onTouchMove(e: EventTouch) { if (e.getID() === this.pointerId) this.move(e.getLocation()); }
    private onTouchEnd(e: EventTouch) {
        if (e.getID() === this.pointerId) this.end(e.getLocation());
    }
    private onTouchCancel(e: EventTouch) {
        if (e.getID() !== this.pointerId) return;
        this.dragging = false;
        this.pointerId = null;
        this.showLine(false);
        this.startHint();
    }

    private onMouseDown(e: EventMouse) { if (e.getButton() === EventMouse.BUTTON_LEFT) this.begin(-1, e.getLocation()); }
    private onMouseMove(e: EventMouse) { if (this.pointerId === -1) this.move(e.getLocation()); }
    private onMouseUp(e: EventMouse) {
        if (this.pointerId === -1 && e.getButton() === EventMouse.BUTTON_LEFT) this.end(e.getLocation());
    }

    private begin(id: number, screen: Vec2) {
        // Điện thoại có thể bắn cả touch lẫn mouse giả lập: chỉ nhận con trỏ đầu tiên
        if (this.dragging || this.flying || this.shot || this.pointerId !== null
            || this.ronaldoKick?.hasPendingShot) return;
        this.pointerId = id;
        this.dragging = true;
        this.stopHint();
        Ply_SoundManager.Ins?.playBGM();
        this.power = 0;
        this.canShoot = false;
        this.dragLocal.set(0, 0);
        this.aimDirection = null;
        if (this.ball) this.node.setPosition(this.ball.position); // gốc đường ngắm luôn ở bóng
        // Neo kéo tại quả bóng (không phải điểm chạm đầu tiên): vector kéo = điểm chạm - bóng
        if (this.ball) this.startLocal.set(this.ball.position.x, this.ball.position.y);
        else this.toLocal(screen, this.startLocal);
        this.move(screen, true);
    }

    private move(screen: Vec2, snapAim = false) {
        if (!this.dragging) return;
        this.toLocal(screen, this.dragLocal).subtract(this.startLocal);
        this.updateDragAim(0, snapAim);
    }

    private updateDragAim(dt: number, snapAim = false) {
        this.canShoot = false;
        const { x, y } = this.dragLocal;
        if (Math.hypot(x, y) < Math.max(1, this.minDrag)) {
            this.power = 0;
            this.aimDirection = null;
            this.showLine(false);
            return;
        }
        const area = this.getTargetArea();
        const halfAngle = area.sweep / 2;
        const center = area.start + halfAngle;
        const outerAt = (direction: number) => {
            const rel = wrapAngle(direction - center);
            const across = area.sweep > 0 ? Math.max(0, Math.min(1, rel / area.sweep + 0.5)) : 0.5;
            return area.left + (area.right - area.left) * across;
        };

        // Điểm rơi mong muốn (local Aim, gốc tại bóng)
        let tx = x, ty = y;
        if (y < 0) {
            // Tay dưới bóng (kiểu ná): độ xa theo độ dài kéo dọc, trái/phải vẫn theo X của tay
            const p = Math.min(1, Math.max(this.minPower, -y / Math.max(1, this.maxDrag)));
            const strength = this.minPower < 1 ? (p - this.minPower) / (1 - this.minPower) : 1;
            const d = area.inner + (outerAt(Math.atan2(x, -y)) - area.inner) * strength;
            tx = Math.max(-d, Math.min(d, x));
            ty = Math.sqrt(d * d - tx * tx);
        }
        // Tay trên bóng: điểm rơi = đúng vị trí tay (tay tới đâu aim line tới đó)

        let direction = Math.atan2(tx, ty);
        let distance = Math.hypot(tx, ty);
        if (this.restrictToTargetArea) {
            // Kẹp điểm rơi vào trong vùng ngắm (gizmo Target Area)
            const rel = Math.max(-halfAngle, Math.min(halfAngle, wrapAngle(direction - center)));
            direction = center + rel;
            distance = Math.max(area.inner, Math.min(outerAt(direction), distance));
        }
        const outer = outerAt(direction);
        const strength = outer > area.inner ? Math.max(0, Math.min(1, (distance - area.inner) / (outer - area.inner))) : 1;
        this.power = this.minPower + (1 - this.minPower) * strength;

        tx = Math.sin(direction) * distance;
        ty = Math.cos(direction) * distance;
        if (snapAim || this.aimDirection === null || this.aimSmoothTime <= 0) {
            this.landLocal.set(tx, ty, 0);
        } else {
            const blend = 1 - Math.exp(-dt / this.aimSmoothTime);
            this.landLocal.set(this.landLocal.x + (tx - this.landLocal.x) * blend, this.landLocal.y + (ty - this.landLocal.y) * blend, 0);
        }
        this.aimDirection = direction;
        this.canShoot = true;
        this.layoutLine();
        this.showLine(true);
    }

    private end(screen: Vec2) {
        if (!this.dragging) return;
        this.move(screen, true);
        this.dragging = false;
        this.pointerId = null;
        this.showLine(false);
        if (!this.canShoot || !this.ball?.parent) {
            this.startHint();
            return;
        }
        if (this.ronaldoKick?.play(() => this.launch())) return;
        this.launch();
    }

    // ============================================================ đường ngắm
    /** Điểm trên đường bay tại t (0..1), toạ độ local của node này (gốc tại bóng). */
    pointAt(t: number, out = new Vec3()): Vec3 {
        const T = this.landLocal;
        const u = 1 - t;
        // Điểm điều khiển đầu nằm trên hướng sút để bóng rời vị trí gốc theo đúng hướng đã ngắm.
        const straight = u * u * t + t * t * t;
        const bend = u * t * t;
        return out.set(
            T.x * (straight + bend * (1 + 2 * this.bendX)),
            T.y * (straight + bend * (1 + 2 * this.bendY)),
            0,
        );
    }

    private layoutLine() {
        const dots = this.line ? this.line.children : [];
        const n = dots.length;
        for (let i = 0; i < n; i++) {
            const t = this.dotStart + (1 - this.dotStart) * (n > 1 ? i / (n - 1) : 1);
            dots[i].setPosition(this.pointAt(t, _p));
        }
        if (this.target) this.target.setPosition(this.landLocal);
    }

    private showLine(on: boolean) {
        if (this.line) this.line.active = on;
        if (this.target) this.target.active = on;
    }

    // ============================================================ bay
    private launch() {
        const ball = this.ball;
        if (!ball || !ball.parent) return;
        this.flying = true;
        this.shot = true;

        const parent = ball.parent;
        const s0 = ball.scale.clone();
        const s1 = new Vec3(this.ballStartScale.x * this.endScale, this.ballStartScale.y * this.endScale, s0.z);
        const st = { t: 0 };
        Tween.stopAllByTarget(ball);
        this.flightTween = tween(st)
            .to(this.flightTime, { t: 1 }, {
                onUpdate: () => {
                    // local Aim -> world -> local cha của bóng
                    this.pointAt(st.t, _p);
                    Vec3.transformMat4(_w, _p, this.node.worldMatrix);
                    parent.inverseTransformPoint(_l, _w);
                    ball.setPosition(_l);
                    Vec3.lerp(_s, s0, s1, st.t);
                    ball.setScale(_s);
                },
            })
            .call(() => this.onLanded())
            .start();
        Ply_SoundManager.Ins?.playFx(FxType.KickBall);
    }

    update(dt: number) {
        if (EDIT_MODE) {
            this.updateTargetGizmo();
            return;
        }
        if (this.hinting) this.updateHint(dt);
        if (this.dragging) this.updateDragAim(dt);
        if ((this.flying || this.missing) && this.ball) this.ball.angle += this.spinSpeed * dt;
        if (this.missing) this.updateMissFlight(dt);
    }

    /** Sút hụt: bay tiếp theo hướng cuối đường bay, càng xa càng chậm và nhỏ dần. */
    private startMissFlight() {
        const ball = this.ball;
        if (!ball?.parent) return;
        const parent = ball.parent;
        const toParent = (t: number, out: Vec3) => {
            this.pointAt(t, _p);
            Vec3.transformMat4(_w, _p, this.node.worldMatrix);
            return parent.inverseTransformPoint(out, _w);
        };
        const a = toParent(0.95, new Vec3()), b = toParent(1, new Vec3());
        const dt = 0.05 * Math.max(0.01, this.flightTime);
        this.missVelocity.set((b.x - a.x) / dt, Math.abs(b.y - a.y) / dt, 0); // luôn bay ra xa (lên trên)
        this.missScale0 = Math.max(1e-4, ball.scale.x);
        this.missing = true;
    }

    private updateMissFlight(dt: number) {
        const ball = this.ball;
        if (!ball) { this.missing = false; return; }
        const k = Math.exp(-this.missShrinkRate * dt);
        ball.setScale(ball.scale.x * k, ball.scale.y * k, ball.scale.z);
        // phối cảnh: bóng càng nhỏ (càng xa) thì đi càng chậm
        const f = ball.scale.x / this.missScale0;
        const p = ball.position;
        ball.setPosition(p.x + this.missVelocity.x * f * dt, p.y + this.missVelocity.y * f * dt, p.z);
    }

    private onLanded() {
        if (!this.flying) return;
        this.flightTween = null;
        // Let an item claim the shot before scheduling the miss reset.
        this.node.emit('ball-landed', this.landLocal.clone(), this.power);
        if (!this.flying) return;
        this.flying = false;
        if (this.missKeepFlying) this.startMissFlight();
        if (this.autoResetDelay >= 0) this.scheduleOnce(this.resetAfterMiss, this.autoResetDelay);
    }

    private resetAfterMiss() {
        this.resetBall();
        this.node.emit('ball-reset-after-miss');
    }

    showStoreRetry() {
        this.shot = true;
        this.startHint();
    }

    /** Xác nhận cú sút trúng và ẩn bóng trong lúc chạy kết quả. */
    consumeImpact(): boolean {
        if (!this.flying || !this.ball) return false;
        this.flying = false;
        this.flightTween?.stop();
        this.flightTween = null;
        this.ball.active = false;
        return true;
    }

    /** Đặt bóng về chỗ cũ để sút lại. */
    resetBall() {
        this.unschedule(this.resetAfterMiss);
        this.flightTween?.stop();
        this.flightTween = null;
        const kick = this.ronaldoKick;
        if (kick?.hasPendingShot) kick.cancel();
        this.missing = false;
        const ball = this.ball;
        if (!ball) return;
        Tween.stopAllByTarget(ball);
        ball.setPosition(this.ballStartPos);
        ball.setScale(this.ballStartScale);
        ball.angle = this.ballStartAngle;
        ball.active = true;
        this.flying = false;
        this.shot = false;
        this.dragging = false;
        this.pointerId = null;
        this.showLine(false);
    }

    private get hasTargetHandles() {
        return this.targetNear?.parent === this.node && this.targetFarLeft?.parent === this.node
            && this.targetFarRight?.parent === this.node;
    }

    private getTargetArea() {
        if (this.hasTargetHandles) {
            const near = this.targetNear!.position;
            const left = this.targetFarLeft!.position;
            const right = this.targetFarRight!.position;
            const leftDistance = Math.hypot(left.x, left.y);
            const rightDistance = Math.hypot(right.x, right.y);
            const inner = Math.min(Math.hypot(near.x, near.y), leftDistance, rightDistance);
            const leftAngle = Math.atan2(left.x, left.y);
            const rightAngle = Math.atan2(right.x, right.y);
            const sweep = wrapAngle(rightAngle - leftAngle);
            if (sweep < 0) {
                return { start: rightAngle, sweep: -sweep, inner, left: rightDistance, right: leftDistance };
            }
            return { start: leftAngle, sweep, inner, left: leftDistance, right: rightDistance };
        }

        const halfAngle = Math.max(0, Math.min(180, this.maxAngle));
        const inner = this.minDistance + (this.maxDistance - this.minDistance) * Math.max(0, Math.min(1, this.minPower));
        return {
            start: (this.aimAngle - halfAngle) * Math.PI / 180,
            sweep: halfAngle * Math.PI / 90,
            inner,
            left: this.maxDistance,
            right: this.maxDistance,
        };
    }

    private updateTargetGizmo() {
        if (!this.showTargetGizmo || !this.ball) {
            this.clearTargetGizmo();
            return;
        }

        const origin = this.node.inverseTransformPoint(_gizmoOrigin, this.ball.worldPosition);
        const { start, sweep, inner, left, right } = this.getTargetArea();
        const handles = this.hasTargetHandles ? [this.targetNear!, this.targetFarLeft!, this.targetFarRight!] : [];
        const color = this.targetGizmoColor;
        const state = [origin.x, origin.y, origin.z, start, sweep, inner, left, right, this.node.layer,
            color.r, color.g, color.b, color.a, ...handles.flatMap(({ position }) => [position.x, position.y])].join(',');
        if (this.targetGizmo?.isValid && this.targetGizmoState === state) return;

        if (!this.targetGizmo?.isValid) {
            // Graphics can be excluded from the game's enabled engine modules.
            const graphicsType = js.getClassByName('cc.Graphics') as typeof Graphics | undefined;
            if (!graphicsType) return;
            const node = new Node('Target Area Gizmo');
            node._objFlags |= CCObject.Flags.DontSave | CCObject.Flags.EditorOnly | CCObject.Flags.HideInHierarchy;
            this.node.addChild(node);
            this.targetGizmo = node.addComponent(graphicsType);
        }

        const graphics = this.targetGizmo;
        this.targetGizmoState = state;
        graphics.node.layer = this.node.layer;
        graphics.node.setPosition(origin);
        graphics.clear();
        graphics.lineWidth = 8;
        graphics.fillColor = new Color(color.r, color.g, color.b, Math.round(color.a * 0.22));
        graphics.strokeColor = color;

        const segments = Math.max(1, Math.ceil(sweep / FULL_TURN * 60));
        graphics.moveTo(Math.sin(start) * left, Math.cos(start) * left);
        for (let i = 1; i <= segments; i++) {
            const across = i / segments;
            const angle = start + sweep * across;
            const outer = left + (right - left) * across;
            graphics.lineTo(Math.sin(angle) * outer, Math.cos(angle) * outer);
        }
        for (let i = segments; i >= 0; i--) {
            const angle = start + sweep * i / segments;
            graphics.lineTo(Math.sin(angle) * inner, Math.cos(angle) * inner);
        }
        graphics.close();
        graphics.fill();
        graphics.stroke();

        graphics.fillColor = color;
        for (const handle of handles) {
            graphics.circle(handle.position.x, handle.position.y, 27);
        }
        if (handles.length > 0) graphics.fill();
    }

    private clearTargetGizmo() {
        this.targetGizmo?.node.destroy();
        this.targetGizmo = null;
        this.targetGizmoState = '';
    }

    // ============================================================ toạ độ
    /** Toạ độ màn hình -> toạ độ local của node cha (cùng hệ với bóng). */
    private toLocal(screen: Vec2, out: Vec2): Vec2 {
        const parent = this.node.parent;
        if (!this.cam || !parent) return out.set(screen.x, screen.y);
        this.cam.screenToWorld(_sc.set(screen.x, screen.y, 0), _w);
        parent.inverseTransformPoint(_l, _w);
        return out.set(_l.x, _l.y);
    }
}

const _p = new Vec3();
const _w = new Vec3();
const _l = new Vec3();
const _s = new Vec3();
const _sc = new Vec3();
const _gizmoOrigin = new Vec3();
