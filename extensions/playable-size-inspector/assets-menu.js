'use strict';
/**
 * Menu chuột phải trong panel Assets: chuột phải một thư mục -> "Texture Compress" ->
 * chọn preset (hoặc "Tắt nén") -> áp cho mọi ảnh (sprite-frame / texture / auto-atlas)
 * bên dưới sau khi hỏi xác nhận. Chạy trong process của panel Assets nên chỉ dùng
 * bản đọc preset đồng bộ.
 */

const { readPresetsSync } = require('./lib/texture-compress');

const PACKAGE_NAME = 'playable-size-inspector';

exports.onAssetMenu = function onAssetMenu(assetInfo) {
  if (!assetInfo || !assetInfo.isDirectory) {
    return [];
  }

  const presets = readPresetsSync(Editor.Project.path);
  const send = (presetId, mode) => () => {
    Editor.Message.send(PACKAGE_NAME, 'texture-apply-from-menu', {
      uuid: assetInfo.uuid,
      url: assetInfo.url,
      presetId,
      mode,
      includeAtlas: true,
      force: true,
    });
  };

  const submenu = presets.map((preset) => ({ label: `Enable: ${preset.name}`, click: send(preset.id, 'enable') }));
  if (!submenu.length) {
    submenu.push({ label: '(no preset in Project Settings)', enabled: false });
  }
  submenu.push({ type: 'separator' });
  submenu.push({ label: 'Disable', click: send('', 'disable') });
  submenu.push({ type: 'separator' });
  submenu.push({ label: 'Open panel...', click: () => Editor.Message.send(PACKAGE_NAME, 'open-panel') });

  return [{ label: 'Texture Compress', submenu }];
};
