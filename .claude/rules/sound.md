# Rule: Âm thanh (Sound)

Mọi âm thanh trong project **bắt buộc** đi qua singleton `Ply_SoundManager.Ins`.

- Script: `assets/7.Scripts/MyScript/ScriptTemplate/Ply_SoundManager.ts`
- Component gắn trên node `Manager/SoundManager` trong `PlayScene`. Mỗi scene chỉ có **một** instance (`Ply_Singleton` tự huỷ bản trùng).

## Bắt buộc

1. Gọi sound qua `Ply_SoundManager.Ins?.xxx(...)`. Luôn dùng `?.` vì `Ins` có thể là `null` trước `onLoad` hoặc sau khi node bị huỷ.
   ```ts
   import { Ply_SoundManager, FxType } from '<đường dẫn tương đối>/MyScript/ScriptTemplate/Ply_SoundManager';

   Ply_SoundManager.Ins?.playFx(FxType.Siuu);
   ```
2. Loại sound khai báo bằng enum `FxType`. Thêm sound mới thì sửa **cả 4 chỗ** trong `Ply_SoundManager.ts`:
   - thêm giá trị vào `enum FxType`,
   - tăng `FX_TYPE_COUNT`,
   - thêm field `SoundData` vào class `FxAudio`,
   - thêm mapping vào `FX_FIELDS`.

   Sau đó gán `AudioClip` cho field mới trong Inspector của node `SoundManager`.
3. Nhạc nền (BGM) gán vào `bgm1` trong Inspector, phát bằng `playBGM()` và dừng bằng `stopBGM()`.

## Cấm

- Tạo hoặc dùng `AudioSource` riêng trong script gameplay/UI để phát sound (`addComponent(AudioSource)`, `@property(AudioSource)`, `audioSource.play()`, `playOneShot`, ...). Chỉ `Ply_SoundManager` được tạo và điều khiển `AudioSource`.
- Dùng `audioEngine` hoặc các API phát âm thanh trực tiếp khác của Cocos.
- Viết thêm một sound manager khác, hoặc giữ reference tới sound manager qua `@property` (vd: `World.soundmanager`). Luôn truy cập qua `Ply_SoundManager.Ins`.
- Tự xử lý mute khi ẩn app hay khoá màn hình, hoặc tự nghe `audioChanged` / `window.volume` trong script khác. `Ply_SoundManager` đã tự lo phần này (yêu cầu của playable ad).

## Chọn hàm phát

| Tình huống | Hàm |
|---|---|
| Phát bình thường, phát lại từ đầu nếu đang phát | `playFx(type)` |
| Chồng âm, không cắt tiếng đang phát | `playFxOneShot(type, volumeScale?)` |
| Nhiều tiếng dồn dập (burst) | `playBurstFx(types, count, interval?, volumeScale?)` |
| Phát lần lượt, cái sau chờ cái trước xong | `playFxSequence(types)` / `stopFxSequence()` |
| Đang phát thì xếp hàng tối đa 1 lần | `playFxQueued(type)` |
| Lặp vô hạn | `playLoopFx(type)` / `stopFx(type)` |
| Cắt tiếng cũ trên kênh dùng chung rồi phát tiếng mới | `playFxCutoff(type, volumeScale?)` / `stopFxCutoff()` |
| Thua (dừng tiếng thua cũ rồi phát lại, tiếng `Cry`) | `playFail()` |
| Thắng | `playFx(FxType.Confetti)` |
| Mở store / kết thúc game | `stopAll()` |
| Người chơi tắt / bật tiếng | `mute()` / `muteFx()` / `unmute()` |
