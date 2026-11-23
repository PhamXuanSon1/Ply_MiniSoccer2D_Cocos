import { _decorator, Component, sp } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('RonaldoKick')
export class RonaldoKick extends Component {
    @property(sp.Skeleton)
    skeleton: sp.Skeleton | null = null;

    @property({ min: 0, tooltip: 'Số giây từ lúc bắt đầu kick đến lúc bóng bay' })
    launchDelay = 0.93;

    @property({ min: 0.1, step: 0.1, tooltip: 'Hệ số tốc độ phát kick. Launch Delay tính theo giây thực trong game.' })
    animationSpeed = 1.5;

    private pendingLaunch: (() => void) | null = null;
    private finishKick: (() => void) | null = null;

    get hasPendingShot() {
        return this.pendingLaunch !== null;
    }

    onEnable() {
        const skeleton = this.skeleton ?? this.getComponent(sp.Skeleton);
        if (skeleton?.enabledInHierarchy && skeleton.findAnimation('idle')
            && skeleton.getCurrent(0)?.animation?.name !== 'idle') {
            skeleton.setAnimation(0, 'idle', true);
        }
    }

    play(onLaunch: () => void): boolean {
        const skeleton = this.skeleton ?? this.getComponent(sp.Skeleton);
        if (!this.enabledInHierarchy || !skeleton?.enabledInHierarchy || !skeleton.findAnimation('kick')) return false;

        const entry = skeleton.setAnimation(0, 'kick', false);
        if (!entry) return false;
        entry.timeScale = Math.max(0.1, this.animationSpeed);

        const finishKick = () => {
            if (this.finishKick !== finishKick) return;
            this.finishKick = null;
            if (!skeleton.isValid) return;
            if (skeleton.findAnimation('idle')) {
                skeleton.setAnimation(0, 'idle', true);
            } else {
                skeleton.clearTrack(0);
                skeleton.setToSetupPose();
            }
        };
        this.finishKick = finishKick;
        skeleton.setTrackCompleteListener(entry, finishKick);

        this.pendingLaunch = onLaunch;
        this.scheduleOnce(this.launch, Math.max(0, this.launchDelay));
        return true;
    }

    cancel() {
        this.unschedule(this.launch);
        this.pendingLaunch = null;
        this.finishKick?.();
    }

    onDisable() {
        this.cancel();
    }

    private launch() {
        const onLaunch = this.pendingLaunch;
        this.pendingLaunch = null;
        onLaunch?.();
    }
}
