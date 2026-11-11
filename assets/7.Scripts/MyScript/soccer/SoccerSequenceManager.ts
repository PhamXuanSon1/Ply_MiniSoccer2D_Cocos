import { _decorator, Component, input, Input, Node, Tween, tween, Vec3 } from 'cc';
import { FxType, Ply_SoundManager } from '../ScriptTemplate/Ply_SoundManager';
import { World } from '../../Manager/World';
import { AppLovinAnalytics } from '../../Tool/AppLovinAnalytics';
import { DraggableItem } from './DraggableItem';
import { CharacterSlot } from './CharacterSlot';
import { ISoccerManager, soccer } from './SoccerContext';
const { ccclass, property } = _decorator;

/**
 * Điều phối màn chơi MiniSoccer (port từ Unity ItemSequenceManager).
 * 4 món đồ lần lượt bay từ SpawnPoint tới TargetPoint, người chơi kéo/chạm để đưa cho 4 nhân vật.
 * Đủ 4 món:
 *  - Đúng hết -> chữ Win + âm thắng -> sau endcardDelay ẩn gameplay, hiện endcard (chạm bất kỳ đâu mở store).
 *  - Có sai   -> chữ Lose + Cry -> sau endcardDelay reset, chơi lại từ món 1, từ đó chạm bất kỳ đâu mở store.
 */
@ccclass('SoccerSequenceManager')
export class SoccerSequenceManager extends Component implements ISoccerManager {

    static ins: SoccerSequenceManager | null = null;

    @property({ type: [DraggableItem], tooltip: '4 món đồ theo thứ tự xuất hiện' })
    itemList: DraggableItem[] = [];

    @property({ type: Node, tooltip: 'Vị trí xuất phát (ngoài màn hình)' })
    spawnPoint: Node | null = null;

    @property({ type: Node, tooltip: 'Vị trí món đồ dừng lại chờ người chơi' })
    targetPoint: Node | null = null;

    @property
    moveDuration: number = 0.8;

    @property
    delayBetweenItems: number = 0.3;

    @property({ type: [CharacterSlot], tooltip: '4 nhân vật' })
    characterList: CharacterSlot[] = [];

    @property({ type: Node, tooltip: 'Chữ YOU WIN' })
    winObject: Node | null = null;

    @property({ type: Node, tooltip: 'Chữ YOU LOSE' })
    loseObject: Node | null = null;

    @property({ tooltip: 'Chờ N giây sau món cuối rồi mới hiện Win / Lose' })
    resultTextDelay: number = 0.8;

    @property({ type: Node, tooltip: 'Node gameplay (tắt khi hiện endcard)' })
    gameplayObject: Node | null = null;

    @property({ type: Node, tooltip: 'Tắt khi người chơi chạm món đồ đầu tiên (VD: chữ Tap To Play)' })
    objectToHideOnFirstDrag: Node | null = null;

    @property({ tooltip: 'Chờ N giây sau chữ Win/Lose rồi mới chuyển endcard / chơi lại' })
    endcardDelay: number = 3;

    isWin: boolean = true;
    isFailedMode: boolean = false;
    isItemReady: boolean = false;

    private currentItemIndex = 0;
    private hasTrackedFirstClick = false;
    private hasDraggedFirstItem = false;
    private hintBaseScale = new Vec3(1, 1, 1);

    onLoad() {
        SoccerSequenceManager.ins = this;
        soccer.mgr = this;
        AppLovinAnalytics.startLoading();
    }

    onDestroy() {
        if (SoccerSequenceManager.ins === this) SoccerSequenceManager.ins = null;
        if (soccer.mgr === this) soccer.mgr = null;
        input.off(Input.EventType.TOUCH_START, this.onAnyTouch, this);
        input.off(Input.EventType.MOUSE_DOWN, this.onAnyTouch, this);
    }

    start() {
        AppLovinAnalytics.loaded();
        AppLovinAnalytics.displayed();

        for (const item of this.itemList) {
            if (item) item.node.active = false;
        }
        if (this.winObject) this.winObject.active = false;
        if (this.loseObject) this.loseObject.active = false;

        if (this.objectToHideOnFirstDrag) {
            this.hintBaseScale.set(this.objectToHideOnFirstDrag.scale);
            this.startHintPulse();
        }

        input.on(Input.EventType.TOUCH_START, this.onAnyTouch, this);
        input.on(Input.EventType.MOUSE_DOWN, this.onAnyTouch, this); // chuột trên desktop
        Ply_SoundManager.Ins?.playBGM();

        if (this.itemList.length > 0) this.spawnNextItem();
    }

    /** Lần chạm đầu: gửi analytics + đảm bảo nhạc nền chạy (trình duyệt chặn autoplay trước tương tác). */
    private onAnyTouch() {
        Ply_SoundManager.Ins?.playBGM();
        if (!this.hasTrackedFirstClick) this.trackFirstClick();
    }

    private trackFirstClick() {
        if (this.hasTrackedFirstClick) return;
        this.hasTrackedFirstClick = true;
        AppLovinAnalytics.challengeStarted();
    }

    /** Ẩn hướng dẫn khi người chơi bắt đầu thao tác với món đồ đầu tiên. */
    onFirstItemDragged() {
        if (this.hasDraggedFirstItem) return;
        this.hasDraggedFirstItem = true;
        if (this.objectToHideOnFirstDrag) this.objectToHideOnFirstDrag.active = false;
    }

    getCurrentActiveItem(): DraggableItem | null {
        if (this.currentItemIndex >= 0 && this.currentItemIndex < this.itemList.length) {
            return this.itemList[this.currentItemIndex];
        }
        return null;
    }

    openStore() {
        World.ins?.ui?.openStore();
    }

    /** Nhân vật gọi khi đã nhận xong 1 món đồ. */
    onItemCompleted() {
        this.currentItemIndex++;
        if (this.currentItemIndex === 1) this.trackFirstClick();

        if (this.currentItemIndex === 1) AppLovinAnalytics.challenge25();
        else if (this.currentItemIndex === 2) AppLovinAnalytics.challenge50();
        else if (this.currentItemIndex === 3) AppLovinAnalytics.challenge75();

        if (this.currentItemIndex < this.itemList.length) {
            this.scheduleOnce(() => this.spawnNextItem(), this.delayBetweenItems);
        } else {
            this.scheduleOnce(() => this.showResult(), this.resultTextDelay);
        }
    }

    private showResult() {
        this.isWin = this.characterList.every(c => !c || c.isCorrectItemReceived);

        if (this.isWin) {
            if (this.winObject) this.winObject.active = true;
            if (this.loseObject) this.loseObject.active = false;
            Ply_SoundManager.Ins?.playFx(FxType.Confetti);
            AppLovinAnalytics.challengeSolved();

            this.scheduleOnce(() => this.showEndcard(), this.endcardDelay);
        } else {
            if (this.loseObject) this.loseObject.active = true;
            if (this.winObject) this.winObject.active = false;
            Ply_SoundManager.Ins?.playFx(FxType.Cry);
            AppLovinAnalytics.challengeFailed();

            this.scheduleOnce(() => this.restartAfterLose(), this.endcardDelay);
        }
    }

    /** Thắng: ẩn gameplay, hiện endcard (UI.winCard), chạm bất kỳ đâu mở store. */
    private showEndcard() {
        if (this.gameplayObject) this.gameplayObject.active = false;
        // Âm thắng đã phát lúc hiện chữ Win nên không phát thêm
        World.ins?.ui?.onWin(null);
        this.showHint();
        AppLovinAnalytics.endcardShown();
    }

    /** Thua: reset nhân vật + món đồ, chơi lại từ món 1, từ đó chạm bất kỳ đâu mở store. */
    private restartAfterLose() {
        if (this.loseObject) this.loseObject.active = false;

        // Giống Unity: nhân vật về Normal và KHÔNG nhận đồ nữa
        for (const c of this.characterList) {
            if (c) c.resetCharacter(false);
        }

        this.showHint();

        this.currentItemIndex = 0;
        for (const item of this.itemList) {
            if (!item) continue;
            Tween.stopAllByTarget(item.node);
            item.interactable = false;
            item.node.active = false;
        }
        this.spawnNextItem();

        this.isFailedMode = true;
        World.ins?.ui?.onLoseRetry();
    }

    /** Đưa món đồ hiện tại từ SpawnPoint tới TargetPoint. */
    private spawnNextItem() {
        const item = this.getCurrentActiveItem();
        if (!item) return;

        const startPos = this.spawnPoint ? this.spawnPoint.worldPosition : item.node.worldPosition;
        const endPos = this.targetPoint ? this.targetPoint.worldPosition.clone() : item.node.worldPosition.clone();

        this.isItemReady = false;
        item.interactable = false;
        item.node.setWorldPosition(startPos);
        item.node.active = true;

        Tween.stopAllByTarget(item.node);
        tween(item.node)
            .to(this.moveDuration, { worldPosition: endPos }, { easing: 'backOut' })
            .call(() => {
                item.interactable = true;
                this.isItemReady = true;
            })
            .start();
    }

    private showHint() {
        if (!this.objectToHideOnFirstDrag) return;
        this.objectToHideOnFirstDrag.active = true;
        this.startHintPulse();
    }

    /** Thay cho anim TapToPlay bên Unity: scale 1 -> 0.9 -> 1 trong 1 giây, lặp vô hạn. */
    private startHintPulse() {
        const node = this.objectToHideOnFirstDrag;
        if (!node) return;
        Tween.stopAllByTarget(node);
        const base = this.hintBaseScale;
        node.setScale(base);
        tween(node)
            .to(0.5, { scale: new Vec3(base.x * 0.9, base.y * 0.9, base.z) })
            .to(0.5, { scale: base.clone() })
            .union()
            .repeatForever()
            .start();
    }
}
