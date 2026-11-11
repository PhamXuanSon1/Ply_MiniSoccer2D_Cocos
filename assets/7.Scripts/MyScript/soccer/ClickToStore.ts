import { _decorator, Component, Node } from 'cc';
import { World } from '../../Manager/World';
const { ccclass } = _decorator;

/** Chạm vào node này thì mở store (Icon / Logo). */
@ccclass('ClickToStore')
export class ClickToStore extends Component {

    onLoad() {
        this.node.on(Node.EventType.TOUCH_END, this.onClick, this);
    }

    onDestroy() {
        this.node.off(Node.EventType.TOUCH_END, this.onClick, this);
    }

    private onClick() {
        World.ins?.ui?.openStore();
    }
}
