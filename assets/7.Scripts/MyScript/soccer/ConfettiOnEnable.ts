import { _decorator, Component, ParticleSystem } from 'cc';
const { ccclass, property } = _decorator;

/**
 * Bắn pháo hoa mỗi khi node được bật (vd endcard hiện): chạy lại từ đầu mọi ParticleSystem
 * trong node và các node con (vd ConfettiLeft.prefab). Có thể lặp lại.
 */
@ccclass('ConfettiOnEnable')
export class ConfettiOnEnable extends Component {

    @property({ tooltip: 'Chờ bao lâu sau khi bật mới bắn (giây)' })
    delay: number = 0.1;

    @property({ tooltip: 'Lặp lại sau mỗi N giây. 0 = chỉ bắn 1 lần' })
    repeatInterval: number = 0;

    onEnable() {
        this.stopParticles();
        this.scheduleOnce(this.shoot, this.delay);
        if (this.repeatInterval > 0) {
            this.schedule(this.shoot, this.repeatInterval, Number.MAX_SAFE_INTEGER, this.delay + this.repeatInterval);
        }
    }

    onDisable() {
        this.unscheduleAllCallbacks();
        this.stopParticles();
    }

    private shoot() {
        const systems = this.getComponentsInChildren(ParticleSystem);
        if (!systems.length) console.warn('ConfettiOnEnable: node không có ParticleSystem');
        for (const ps of systems) {
            ps.stop();
            ps.clear();
            ps.play();
        }
    }

    private stopParticles() {
        for (const ps of this.getComponentsInChildren(ParticleSystem)) {
            ps.stop();
            ps.clear();
        }
    }
}
