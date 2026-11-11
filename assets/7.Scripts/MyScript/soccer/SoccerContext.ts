import type { DraggableItem } from './DraggableItem';
import type { CharacterSlot } from './CharacterSlot';

/**
 * Những gì CharacterSlot / DraggableItem cần từ SoccerSequenceManager.
 * Tách riêng để 2 script đó không import trực tiếp manager (tránh vòng import làm
 * decorator @property nhận type = undefined).
 */
export interface ISoccerManager {
    isItemReady: boolean;
    readonly characterList: CharacterSlot[];
    onFirstItemDragged(): void;
    getCurrentActiveItem(): DraggableItem | null;
    onItemCompleted(): void;
}

/** SoccerSequenceManager gán vào đây trong onLoad. */
export const soccer: { mgr: ISoccerManager | null } = { mgr: null };
