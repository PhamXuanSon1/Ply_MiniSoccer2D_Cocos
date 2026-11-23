import { _decorator, Component, Node, Sprite, SpriteFrame, Tween, tween, UIOpacity, UITransform, Vec3 } from 'cc';
import { World } from '../../Manager/World';
import { AppLovinAnalytics } from '../../Tool/AppLovinAnalytics';
import { FxType, Ply_SoundManager } from '../ScriptTemplate/Ply_SoundManager';
import { SlingshotShooter } from './SlingshotShooter';

const { ccclass, property } = _decorator;
const PATH = { name: 'Runner Path', id: 'runner-path' };
const TIMING = { name: 'Timing', id: 'interception-timing' };

@ccclass('ItemInterception')
export class ItemInterception extends Component {
    @property(SlingshotShooter)
    shooter: SlingshotShooter | null = null;

    @property({ type: UITransform, formerlySerializedAs: 'cup' })
    item: UITransform | null = null;

    @property({ type: Sprite, formerlySerializedAs: 'messi' })
    runner: Sprite | null = null;

    @property({ type: SpriteFrame, formerlySerializedAs: 'messiWithCup' })
    runnerWithItem: SpriteFrame | null = null;

    @property(Node)
    bubble: Node | null = null;

    @property({ type: Node, group: PATH, formerlySerializedAs: 'messiStart', tooltip: 'Điểm nhân vật xuất hiện' })
    runnerStart: Node | null = null;

    @property({ type: Node, group: PATH, tooltip: 'Điểm vật phẩm gặp tay nhân vật' })
    catchPoint: Node | null = null;

    @property({ type: Node, group: PATH, formerlySerializedAs: 'messiGrip', tooltip: 'Vị trí bắt vật phẩm trên sprite đang chạy' })
    catchGrip: Node | null = null;

    @property({ type: Node, group: PATH, formerlySerializedAs: 'messiEnd', tooltip: 'Điểm nhân vật chạy tới trước khi hiện endcard' })
    runnerEnd: Node | null = null;

    @property({ group: TIMING, min: 0, step: 0.05, formerlySerializedAs: 'messiStartDelay', tooltip: 'Thời gian chờ trước khi nhân vật xuất hiện' })
    runnerStartDelay = 0;

    @property({ group: TIMING, min: 0.05, step: 0.05, formerlySerializedAs: 'messiRunToCatchTime', tooltip: 'Thời gian chạy từ điểm xuất phát tới điểm bắt' })
    runToCatchTime = 0.75;

    @property({ group: TIMING, min: 0, step: 0.05, tooltip: 'Thời gian dừng ở điểm bắt để hiện bubble' })
    bubbleHoldTime = 1.5;

    @property({ group: TIMING, min: 0.05, step: 0.05, formerlySerializedAs: 'messiExitTime', tooltip: 'Thời gian chạy tiếp sau khi bubble tắt' })
    runOutTime = 0.95;

    @property({ group: TIMING, tooltip: 'Chạy ra với cùng tốc độ lúc chạy vào (bỏ qua Run Out Time) để chuyển động liền mạch' })
    matchRunSpeed = true;

    @property({ min: 0, tooltip: 'Nới rộng vùng trúng của item mỗi phía (toạ độ local của item) để dễ trúng hơn' })
    hitPadding = 120;

    @property(Node)
    gameplay: Node | null = null;

    @property(Node)
    resultDim: Node | null = null;

    @property({ type: Node, formerlySerializedAs: 'worldCupEndcard' })
    endcard: Node | null = null;

    @property({ type: Node, tooltip: 'Điểm nhận của Ronaldo cho nhánh thắng' })
    returnPoint: Node | null = null;

    @property({ type: [Node], tooltip: 'Các node aura bật trong lúc vật phẩm bay về' })
    returnEffects: Node[] = [];

    @property({ group: TIMING, min: 0, step: 0.05, tooltip: 'Thời gian hiện aura tại chỗ trước khi vật phẩm bay về' })
    auraHoldTime = 1;

    @property({ group: TIMING, min: 0.05, step: 0.05, tooltip: 'Thời gian vật phẩm bay về Ronaldo' })
    returnTime = 0.8;

    @property({ range: [0, 255, 1], tooltip: 'Độ đậm của lớp Dim sau endcard (0..255)' })
    dimOpacity = 230;

    @property({ tooltip: 'Cho sút lại sau lần hụt đầu tiên. Sau lần hụt thứ hai, chạm để mở Store.' })
    storeOnMissRetry = false;

    private sequence: Tween<{ elapsed: number }> | null = null;
    private resolved = false;
    private hasRetriedAfterMiss = false;
    private readonly landing = new Vec3();

    onEnable() {
        this.shooter?.node.on('ball-landed', this.checkImpact, this);
        if (this.storeOnMissRetry) {
            this.shooter?.node.on('ball-reset-after-miss', this.onMissRetry, this);
        }
    }

    onDisable() {
        this.shooter?.node.off('ball-landed', this.checkImpact, this);
        this.shooter?.node.off('ball-reset-after-miss', this.onMissRetry, this);
    }

    onDestroy() {
        this.sequence?.stop();
    }

    private onMissRetry() {
        if (!this.hasRetriedAfterMiss) {
            this.hasRetriedAfterMiss = true;
            this.shooter?.startHint();
            return;
        }
        this.shooter?.showStoreRetry();
        World.ins?.ui?.bindingToStore();
    }

    private checkImpact() {
        const { shooter, item, runner, runnerWithItem, runnerStart, catchPoint, catchGrip, runnerEnd } = this;
        const ball = shooter?.ball;
        if (this.resolved || !shooter || !ball?.activeInHierarchy
            || !item?.node.activeInHierarchy || !this.endcard) return;

        const { x, y } = item.node.inverseTransformPoint(this.landing, ball.worldPosition);
        const pad = Math.max(0, this.hitPadding);
        const left = -item.anchorX * item.width - pad;
        const bottom = -item.anchorY * item.height - pad;
        const width = item.width + pad * 2, height = item.height + pad * 2;
        if (x < left || x > left + width || y < bottom || y > bottom + height) return;

        if (this.returnPoint) {
            this.returnToRonaldo(shooter, item.node, this.returnPoint);
            return;
        }
        if (!runner || !runnerWithItem || !runnerStart || !catchPoint || !catchGrip || !runnerEnd) return;

        const actor = runner.node;
        const reaction = actor.parent;
        const reactions = reaction?.parent;
        const itemParent = item.node.parent;
        if (!reaction || !reactions || !itemParent || !shooter.consumeImpact()) return;

        this.resolved = true;
        const from = reaction.inverseTransformPoint(new Vec3(), runnerStart.worldPosition);
        const to = reaction.inverseTransformPoint(new Vec3(), runnerEnd.worldPosition);
        const receive = reaction.inverseTransformPoint(new Vec3(), catchPoint.worldPosition);
        // Align the grip marker with the catch point.
        const grip = reaction.inverseTransformPoint(new Vec3(), catchGrip.worldPosition);
        receive.subtract(grip.subtract(actor.position));

        const itemFrom = item.node.position.clone();
        const itemTo = itemParent.inverseTransformPoint(new Vec3(), catchPoint.worldPosition);
        const startDelay = Math.max(0, this.runnerStartDelay);
        const runTime = Math.max(0.05, this.runToCatchTime);
        const catchTime = startDelay + runTime;
        // Tốc độ đều: thời gian chạy ra tính theo quãng đường với cùng tốc độ lúc chạy vào
        const runSpeed = Vec3.distance(from, receive) / runTime;
        const exitTime = this.matchRunSpeed && runSpeed > 0
            ? Math.max(0.05, Vec3.distance(receive, to) / runSpeed)
            : Math.max(0.05, this.runOutTime);
        const clock = { elapsed: 0 };
        const position = new Vec3();

        for (const branch of reactions.children) branch.active = branch === reaction;
        actor.setPosition(from);
        actor.active = startDelay === 0;
        if (this.bubble) this.bubble.active = false;
        reactions.active = true;

        this.sequence = tween(clock)
            .to(catchTime, { elapsed: catchTime }, {
                easing: 'linear',
                onUpdate: () => {
                    item.node.setPosition(Vec3.lerp(position, itemFrom, itemTo, clock.elapsed / catchTime));
                    if (clock.elapsed < startDelay) return;
                    actor.active = true;
                    actor.setPosition(Vec3.lerp(position, from, receive, (clock.elapsed - startDelay) / runTime));
                },
            })
            .call(() => {
                actor.setPosition(receive);
                item.node.active = false;
                runner.spriteFrame = runnerWithItem;
                Ply_SoundManager.Ins?.playFx(FxType.ItemStolen);
                if (this.bubble) this.bubble.active = true;
            })
            .delay(Math.max(0, this.bubbleHoldTime))
            .call(() => {
                if (this.bubble) this.bubble.active = false;
            })
            .to(exitTime, { elapsed: catchTime + exitTime }, {
                easing: 'linear',
                onUpdate: () => {
                    actor.setPosition(Vec3.lerp(position, receive, to, (clock.elapsed - catchTime) / exitTime));
                },
            })
            .call(() => {
                actor.setPosition(to);
                this.sequence = null;
                this.showEndcard();
            })
            .start();
    }

    private returnToRonaldo(shooter: SlingshotShooter, item: Node, destination: Node) {
        const visual = item.parent;
        const parent = visual?.parent;
        if (!visual || !parent || !shooter.consumeImpact()) return;

        this.resolved = true;
        for (const effect of this.returnEffects) effect.active = true;
        // Move the item container so its authored aura travels with it.
        const from = visual.position.clone();
        const end = parent.inverseTransformPoint(new Vec3(), destination.worldPosition);
        const itemCenter = parent.inverseTransformPoint(new Vec3(), item.worldPosition);
        end.subtract(itemCenter.subtract(from));
        const duration = Math.max(0.05, this.returnTime);
        const clock = { elapsed: 0 };
        const position = new Vec3();
        this.sequence = tween(clock)
            .delay(Math.max(0, this.auraHoldTime))
            .to(duration, { elapsed: duration }, {
                easing: 'sineInOut',
                onUpdate: () => visual.setPosition(Vec3.lerp(position, from, end, clock.elapsed / duration)),
            })
            .call(() => {
                visual.setPosition(end);
                this.sequence = null;
                Ply_SoundManager.Ins?.playFx(FxType.ItemReceived);
                this.showEndcard(true);
            })
            .start();
    }

    private showEndcard(won = false) {
        if (this.bubble) this.bubble.active = false;
        if (this.gameplay) this.gameplay.active = false;
        if (this.resultDim) this.fadeIn(this.resultDim, this.dimOpacity);
        if (this.endcard) this.fadeIn(this.endcard, 255);
        World.ins?.ui?.bindingToStore();
        if (won) AppLovinAnalytics.challengeSolved();
        else AppLovinAnalytics.challengeFailed();
        AppLovinAnalytics.endcardShown();
    }

    private fadeIn(node: Node, opacity: number) {
        const fade = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
        fade.opacity = 0;
        node.active = true;
        tween(fade).to(0.25, { opacity }).start();
    }
}
