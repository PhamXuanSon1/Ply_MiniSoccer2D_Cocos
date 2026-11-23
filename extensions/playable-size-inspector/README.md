# Playable Size Inspector (`playable-size-inspector`)

Extension cho **Cocos Creator 3.8**: biết bản build playable nặng ở đâu và giảm nó ngay trong editor. Bật nén
**ảnh** (Texture Compress), nén / cắt **âm thanh**, nén mesh / giảm tam giác **model 3D** (Mesh Compress / Mesh
Simplify), tắt **module engine** không dùng (Feature Cropping). Mọi thay đổi đều hoàn tác được.

Mở: **Tools → Playable Size Inspector**. Lần đầu extension chạy trong một dự án, panel tự mở (một lần cho mỗi dự
án). Không có nút "Scan" phải nhớ: mở panel là tool tự phân tích bản build, ảnh / audio / model trong `assets/` và
module engine, rồi tự phân tích lại mỗi khi có bản build mới.

Thanh trên cùng:
- **1 Tổng quan › 2 Tìm chỗ nặng › 3 Tối ưu**: ba bước, đi từ trái sang phải.
- **Lịch sử**: các thay đổi tool đã ghi, hoàn tác từng lần.
- **Thư mục build**: bản build đang xét. Mặc định là thư mục của build task web vừa build gần nhất (không có thì
  bản build mới nhất trong `build/`). Gõ đường dẫn rồi Enter, hoặc chọn trong danh sách bên cạnh (hiện khi có từ 2
  bản build). Lựa chọn được nhớ riêng cho từng dự án.
- **Phân tích lại**: chỉ cần khi muốn quét ngay.

Phiên bản tool hiện ở góc phải thanh trạng thái.

| Bước | Để làm gì | Ghi vào dự án? |
|---|---|---|
| **1 Tổng quan** | Tổng dung lượng, phân bổ theo nhóm, so với lần build trước, bản xuất theo mạng, **Việc nên làm** | Không |
| **2 Tìm chỗ nặng** | Từng thứ trong thư mục build (**Build web-mobile**) và trong file gửi mạng (**HTML cuối**): nó là gì, từ asset nào, scene / prefab nào kéo vào | Không |
| **3 Tối ưu → Ảnh** | Bật / tắt Texture Compress, biết trước dung lượng sau nén | `userData.compressSettings` trong `.meta` |
| **3 Tối ưu → Âm thanh** | Nghe, nén sang MP3, cắt bớt | Thay file audio (giữ uuid) |
| **3 Tối ưu → Model 3D** | Mesh Compress / Mesh Simplify như Inspector → Model, xem trước 3D | `userData.meshCompress` / `meshSimplify` trong `.meta` (+ module meshopt) |
| **3 Tối ưu → Module engine** | Bật / tắt module tuỳ chọn, kèm bằng chứng có dùng hay không | `modules` trong `settings/v2/packages/engine.json` |

## Cài đặt

| Cần gì | Khi nào | Ghi chú |
|---|---|---|
| **Cocos Creator 3.8** | Luôn | Đã chạy 3.8.6, 3.8.8. (3.6 / 3.7 vẫn chạy, nhưng phần Mesh Compress / meshopt bị ẩn và tab Module engine chỉ đọc.) |
| **ffmpeg** | Chỉ cho tab **Âm thanh** (và phần audio của ước tính HTML cuối) | Tool tự tìm: `node_modules` của tool → `node_modules` của extension khác trong dự án (playable-ads-builder trước) hoặc cài global → `ffmpeg` trong PATH / chỗ cài phổ biến. Dự án có playable-ads-builder đã `npm install` thì không phải cài gì thêm. |
| **Node.js bản LTS** (kèm npm) | Chỉ khi chưa có ffmpeg, hoặc để chạy lệnh trong `cli/` | Để nút **Cài ffmpeg** chạy `npm install` (tải `ffmpeg-static` ~80 MB, cần mạng). Tải ở https://nodejs.org; `node -v` và `npm -v` in ra số phiên bản là đã có. |

1. Chép thư mục `playable-size-inspector` vào `extensions/` của dự án. Lấy qua git thì không có `node_modules`
   (nằm trong `.gitignore`); chép kèm `node_modules` từ máy cùng hệ điều hành đã cài thì chạy được ngay.
2. Mở dự án. Panel không tự mở thì **Extension Manager → Project → bật playable-size-inspector**, rồi
   **Tools → Playable Size Inspector**.
3. Làm theo thẻ **Thiết lập còn thiếu** ở Tổng quan. Tool tự kiểm tra khi mở panel rồi khoảng 10 giây một lần, làm
   xong mục nào mục đó tự biến mất:
   - chưa có ffmpeg, máy có Node.js → **Cài ffmpeg**;
   - chưa có ffmpeg, máy chưa có Node.js → **Tải Node.js**: cài bản LTS, thẻ tự đổi sang **Cài ffmpeg** khi tool
     thấy npm (không đổi thì tắt hẳn Cocos rồi mở lại);
   - chưa có preset Texture Compress, hoặc preset chưa chọn định dạng nào → **Mở Texture Compression**;
   - máy chưa có build task web (vừa clone dự án), build chưa đặt Name, hoặc chưa tick mạng nào → **Mở Build**
     (chỉ kiểm khi dự án dùng playable-ads-builder);
   - có model bật Encode mà module meshopt đang tắt (build sẽ lỗi 16352) → **Bật meshopt**.

Không có ffmpeg thì mọi phần khác vẫn dùng bình thường. Không muốn cài Node.js: cài FFmpeg vào PATH. `node_modules`
chép từ máy khác hệ điều hành (vd Windows sang macOS) không dùng được: xoá đi rồi bấm **Cài ffmpeg**. macOS chưa chạy
thử trên máy thật.

## 1. Tổng quan

Các thẻ từ trên xuống:

- **Thiết lập còn thiếu**: xem **Cài đặt**. Đủ hết thì thẻ ẩn.
- **Bản build web-mobile**: tổng dung lượng + số file, chênh lệch so với lần build trước, đường xu hướng qua các lần
  build (rê chuột lên một điểm để xem nhóm nào đổi nhiều nhất), thanh phân bổ theo nhóm (Dữ liệu scene/prefab,
  Engine, Ảnh, Model 3D, Âm thanh, Font, Script game, Khác). Bấm một nhóm là sang bước 2 lọc sẵn nhóm đó.
  - "So với lần build trước" là **bản build trước của cùng thư mục**, không phải lần phân tích trước: phân tích lại
    hay mở lại panel không làm mất mốc so sánh. Xu hướng giữ 30 lần build gần nhất cho mỗi thư mục.
  - Đây là thư mục build **chưa đóng gói**. Bản xuất cho mạng còn nén ảnh sang WebP, encode lại audio rồi zip tất
    cả, nên tỉ lệ giữa các nhóm khác đi: mã engine và JSON co lại nhiều, model và audio gần như giữ nguyên. Phần
    thật sự chiếm trong file gửi mạng xem ở Tìm chỗ nặng → **HTML cuối**.
- **Bản xuất theo mạng**: dung lượng file thật gửi cho từng mạng (html / zip / thư mục). Tool đọc Name và các mạng
  đã tick của build task rồi tìm file `<Mạng>_<Tên build>.html / .zip` (playable-ads-builder) hoặc file / thư mục
  của playable-ads-adapter. Báo mạng **Đã tick nhưng chưa có file**, file **cũ hơn bản build**, mạng **không tick lần
  này**, và chênh lệch so với lần xuất trước. Có nhiều thư mục xuất thì chọn trong danh sách; **Mở thư mục** mở nơi
  chứa file. **Bấm một mạng** là mở trang HTML cuối của đúng file đó.
- **Ảnh / Âm thanh / Model 3D / Module engine** (bấm là mở đúng tab Tối ưu): có bản build thì số **trong build** đứng
  trước và tô ok / cảnh báo theo số đó (vd "83/84 đã bật nén" chỉ đếm ảnh trong build); asset không vào build chỉ
  ghi một dòng phụ. Model 3D ghi số **nên xử lý** (cùng số trên tab) và mesh sau zip; Module engine ghi số module
  tuỳ chọn đang bật và số **không thấy dùng**. Khi playable-ads-builder encode lại audio lúc xuất, thẻ Âm thanh không
  tô cảnh báo "N/M là MP3" và ghi "Bản xuất encode lại ở N kbps".
- **Việc nên làm**: xem dưới.

**Tự phân tích khi build xong**: tool chờ bản build xong hẳn (có `src/settings.json` và thư mục đứng yên vài giây)
rồi mới quét; trong lúc build chỉ báo **Đang build...** và không ghi bản build dở vào xu hướng. Build bị huỷ / lỗi
giữa chừng (đứng yên khoảng 1 phút mà chưa có `settings.json`) thì báo bản build chưa xong. Bản build mới ở thư mục
**khác** chỉ được nhắc ở thanh trạng thái; muốn xem thì chọn nó ở ô **Thư mục build** (chưa từng tự chọn thư mục nào
thì mở panel / **Phân tích lại** tự chuyển sang bản mặc định).

**Banner bản build cũ**: có file trong `assets/` sửa sau lần build gần nhất (kể cả `.meta` tool vừa ghi) thì nhắc
build lại, kèm nút **Mở Build**.

### Việc nên làm

Chỉ gợi ý khi có bằng chứng cụ thể (file nào, node nào, bao nhiêu byte). Mỗi việc có nút đưa tới đúng chỗ sửa (vd mở
tab Tối ưu với đúng các ảnh / model đó đã tick), ghi **≈ tiết kiệm X** kèm một dòng nhỏ nói con số tính từ đâu, và
danh sách **xếp theo X**. X luôn là dung lượng giảm được **sau zip** (bản xuất zip mọi file, nên con số này gần với
phần chiếm trong file gửi mạng). Số đo được ghi "đo" / "mô phỏng", số suy ra từ tỉ lệ ghi "ước tính" kèm tỉ lệ.
Chưa có bản build thì gợi ý ảnh / audio chỉ tính file mà scene, prefab, `resources/` hay bundle thật sự dùng tới.

Gợi ý về asset và module:

| Gợi ý | ≈ tiết kiệm | Nút |
|---|---|---|
| Skybox mặc định của engine bị đóng gói (kể cả khi đã tắt Skybox mà ô Envmap vẫn trỏ tới nó) | cả phần skybox trong build | Chọn scene |
| Shader dựng sẵn nặng (vd `builtin-standard`), kèm thứ kéo nó vào: node dùng material mặc định, `.mtl` của dự án, material đi kèm FBX / GLB (chỉ nêu cái có trong build) | pack đó sau zip | Chọn scene / material / model |
| Ảnh bị đóng gói 2 lần: trong auto-atlas và ảnh gốc chưa nén | cả các ảnh gốc thừa | Chọn các ảnh này |
| Module engine bật mà không thấy dùng ở đâu (component trong scene / prefab, JSON của mọi bản build trong `build/`, model có skeleton / animation, script...) | file riêng của module trong build (wasm / js; Post Process: phần các effect, ước lượng). Profiler, Intersection 2D, Primitive, Mask, Skeletal Animation: phần mã engine đo trước trên 3.8.8 (≈ 0,8–3,6 KB). Module khác ghi "giảm mã engine" và xếp cuối | Tắt trong tool |
| Ảnh chưa bật nén | trong build × (1 − tỉ lệ sau nén): theo nén thử ở tab Ảnh, không thì theo các ảnh dự án đã nén, chưa có ảnh nào thì giả định còn 50% | Chọn các ảnh này |
| Ảnh ≥ 100 KB trong build | ½ phần còn lại sau khi bật nén (nếu giảm còn ½ số điểm ảnh) | Chọn các ảnh này |
| Audio nén thêm được: chưa MP3, stereo, bitrate cao hơn mức builder encode lại (không có builder thì 64 kbps), chỉ khi nén lại thật sự nhỏ đi | trong build − độ dài × bitrate đích; **bản xuất không đổi** khi builder encode lại (xem dưới) | Chọn các file này |
| Nhạc dài (≥ 20 giây và ≥ 100 KB) | phần cắt bớt nếu chỉ giữ 15 giây (builder encode lại thì tính theo bitrate của builder) | Mở trình cắt |
| Model chưa nén mesh (Quantize chưa bật; model có màu đỉnh: Encode chưa bật) | mesh sau zip × ⅔ (Recommended nhỏ đi 3–5 lần sau zip, lấy mức 3) | Chọn các model này |
| Model từ 3.000 tam giác mà Mesh Simplify chưa giảm | mesh sau zip (sau khi nén) × (1 − Target Ratio gợi ý) | Chọn các model này |

Kiểm tra chung trên bản build (`lib/build-checks.js`: chỉ đọc, chạy trên mọi dự án; thiếu dữ liệu thì bỏ qua và ghi
lý do). Có bản xuất không cũ hơn bản build thì con số là phần thật của file đó trong zip của bản xuất (ảnh đã sang
WebP, audio đã encode lại); không có thì zip thử file trong build.

| Gợi ý | ≈ tiết kiệm | Nút |
|---|---|---|
| Logo splash nhúng base64 trong `settings.json` (builder không đổi nó sang WebP) | đo: bỏ logo (Logo: None), hoặc nén lại PNG không mất điểm ảnh nếu nhỏ hơn | Mở Splash Setting |
| File trong build trùng nhau từng byte (khác uuid) | phần thừa | Chọn các ảnh này / Chọn file |
| Font chỉ dùng cho nhãn đang tắt (không script / animation / prefab nào bật lại được) hoặc nhãn dùng System Font | cả font sau zip | Chọn scene / prefab |
| Font nhiều glyph mà nhãn chỉ dùng ít ký tự (luôn giữ thêm ASCII cho chữ gán từ script) | ước tính theo dữ liệu glyph thật; không nêu khi giảm < 4 KB | Chọn font |
| Bản build Debug | ước tính 30% mã engine | Mở Build |
| Source Maps | đo | Mở Build |
| Mã vật lý / Spine đóng gói thêm asm.js dự phòng (Native Code Bundle Mode = Both), hoặc chỉ có asm.js | đo: cả bản asm.js; chỉ có asm.js thì ước tính 25% | Mở Build |
| MD5 Cache đang bật | đo | Mở Build |
| Nhiều file JSON import riêng lẻ (chưa Merge All JSON), hoặc nhiều AnimationClip `.cconb` nhỏ khi BIN Group tắt | mô phỏng | Mở Build |
| Mangle Engine Internal Properties đang tắt | ước tính 2,4% mã engine | Mở Build |
| Ảnh của bản xuất: WebP q > 77 / lossless / không nén | ước tính: q80 → q75 ≈ −14%, lossless → lossy 35%, không nén → lossy 50%; chưa xuất thì tính trên ảnh trong build × ½ | Mở Build |
| Audio của bản xuất > 48 kbps, hoặc builder tắt nén audio | phần audio của bản xuất × (1 − 48 / bitrate); tắt nén: phần vượt 64 kbps | Mở Build |
| PNG palette (Texture Compress PNG) trên ảnh jpg / ảnh không alpha khi builder đổi sang WebP | ước tính 30% (jpg) / 10% (ảnh đục) phần ảnh đó | Chọn các ảnh này |
| Skeleton Spine lưu dạng JSON | ước tính 15% phần JSON | Chọn skeleton |
| Model lưu tangent mà shader của material trong build không đọc | ước tính ½ × tỉ lệ byte tangent trong mesh | Chọn model |

Hai gợi ý chạm cùng một file không bị cộng hai lần (ảnh lớn tính trên phần còn lại sau khi bật nén, model nặng tính
trên mesh sau khi nén, nhạc dài tính trên file sau khi nén lại, font đã có gợi ý "nhãn đang tắt" thì không gợi ý cắt
font). Gợi ý của builder (chất lượng WebP, bitrate) và gợi ý
từng ảnh / từng audio thì chồng nhau một phần: làm cái này xong cái kia giảm ít hơn.

Khi playable-ads-builder encode lại **mọi** audio lúc xuất, đổi sang MP3 / mono / hạ bitrate trong `assets/` chỉ làm
nhỏ thư mục build: gợi ý "audio nén thêm được" ghi **bản xuất không đổi** (dòng nhỏ: chỉ giảm build web-mobile ≈ X) và
xếp cuối. Cách giảm thật là cắt nhạc dài, hoặc hạ Audio Bitrate của builder.

## 2. Tìm chỗ nặng

Hai trang cho cùng một bản build:

- **Build web-mobile**: dung lượng từng thứ trong thư mục build.
- **HTML cuối**: phần mỗi thứ chiếm trong file gửi mạng, cộng một dòng **Khung playable** (thư viện giải nén,
  launcher, SDK của mạng). Ô chọn bên cạnh để đổi file / mạng.
  - Có bản xuất không cũ hơn bản build: tool đọc thẳng file đó (giải nén phần nhúng bên trong, đúng từng byte).
  - Chưa xuất, hoặc bản xuất đã cũ: tool tự dùng **Ước tính từ bản build (mô phỏng builder)**, làm lại các bước
    của playable-ads-builder trên bản build (vài giây; ảnh dùng sharp của builder nên khớp từng byte, audio cần
    ffmpeg). Chỉ có khi dự án dùng playable-ads-builder.
  - Đang xem ước tính mà builder vừa xuất xong thì trang tự chuyển sang file thật (nếu bạn chưa tự chọn trong ô).
    File xuất tool không đọc được định dạng thì tự bỏ qua, chuyển sang bản xuất khác / ước tính và ghi lý do.

Vì sao hai trang khác nhau: playable-ads-builder nén `.png` / `.jpg` sang WebP, encode lại audio MP3 theo bitrate của
builder, gói mọi file vào zip rồi nhúng vào HTML. JS / JSON co 3–10 lần, ảnh co theo WebP, audio gần như không co, nên
thứ "nặng nhất" ở hai trang có thể rất khác nhau.

Mỗi trang có hai cách xem, luôn chọn sẵn mục nặng nhất:
- **Danh sách** (mặc định): từng thứ trong build (asset của dự án, shader / skybox dựng sẵn, mã engine...), nặng nhất
  trước. Mục là ảnh thì icon là ảnh thật thu nhỏ; dòng phụ màu vàng là lý do / cách giảm lấy từ Việc nên làm.
- **Từng file build**: đường dẫn kỹ thuật của từng file trong thư mục build.

Ô tìm lọc theo tên file hoặc asset nguồn; chip lọc theo nhóm (cùng màu với thanh phân bổ ở Tổng quan). Phím: ↑ ↓
chuyển dòng, Enter / nháy đúp chọn asset trong panel Assets.

Khung **Chi tiết**: **Xem trước**; khung nén ngay asset đó nếu là ảnh (**Nén ảnh này (Texture Compress)**) hoặc audio
(**Nén file này**); số liệu, nút **Chọn trong Assets** và lý do (kèm nút như Việc nên làm); **Được kéo vào build bởi**
(chuỗi scene / prefab); rồi **File trong build** (Danh sách) hoặc **Nguồn** / **Asset gộp trong file này** (Từng file
build).

File build được map về asset nguồn **theo uuid**, đọc được cả build bật MD5 Cache, build Debug và bundle riêng
(`resources`, bundle tự tạo); so sánh giữa hai lần build bỏ qua hậu tố hash nên không báo nhầm "file mới". File không
có asset nguồn được gọi đúng tên: mã engine, asset dựng sẵn của engine, cấu hình build, script game...

## 3. Tối ưu

Bốn tab Ảnh, Âm thanh, Model 3D, Module engine:
- Ảnh / Âm thanh / Model 3D có hàng chip lọc (chip **Nên xử lý** gom đúng các mục mà Việc nên làm nhắc tới; chip
  không có mục nào thì ẩn) và **Tick hết** (mọi mục đang hiện) / **Bỏ tick**; Module engine dùng công tắc từng dòng.
  Tab nào cũng có nút **?** mở hướng dẫn ngắn.
- Thanh thao tác nằm **trên** danh sách: đã chọn bao nhiêu, ước tính sau khi áp, và nút áp. Không tab nào tự tick sẵn.
- Khung **Chi tiết** bên phải cho mục đang chọn. Danh sách chỉ tự cuộn khi bạn đổi lựa chọn; số liệu nền đổi (bản build
  mới, nén thử xong) thì giữ nguyên chỗ đang xem.
- Mỗi lần ghi có một mục trong **Lịch sử**; ngay sau đó thanh trạng thái có nút **Hoàn tác**.

Con số dung lượng: tab Ảnh, Âm thanh, Module engine ghi **trong build** (byte trong thư mục build web-mobile, chưa zip,
cùng đơn vị với Tổng quan). Tab Model 3D ghi **≈ X sau zip** vì mesh chưa nén gần như không co khi zip còn mesh Encode
co rất nhiều, nên chỉ số sau zip mới phản ánh đúng phần trong file gửi mạng (số trong build xem ở tooltip / mục
**Số liệu**).

### Ảnh

1. Lọc: **Nên xử lý**, **Tất cả** (mặc định), **Chưa nén**, **Preset đã xoá** (ảnh trỏ tới preset không còn),
   **Nặng ≥ 100 KB**, **Không vào build** (nén cũng không đổi gì), **Số liệu cũ** (số nén thuộc preset khác / ảnh đã
   sửa sau lần nén: build lại để cập nhật).
2. Hai cách xem (nhớ theo máy):
   - **Lưới**: ảnh thu nhỏ thật trên nền caro, nặng nhất trước. Mỗi ô ghi **X trong build** (ảnh không vào build ghi
     **nguồn X**) và một nhãn nên làm gì: đóng gói 2 lần, chưa nén, ≈ −X% với preset, đã nén −X%, số liệu cũ...
   - **Thư mục**: cây thư mục với cột **Sau nén** / **Trong build** / **Nguồn**; tick được cả thư mục (⊞ / ⊟ mở / thu
     hết).
3. Tick ảnh → chọn **Preset** ở thanh nén → xem **sau nén ≈** → **Bật nén** (hoặc **Tắt nén**). Build lại là tool tự
   so trước / sau.

- Số ước tính tự tính sau khi tick, bằng đúng `sharp` của Cocos Editor nên trùng từng byte với Texture Compress thật.
  Cột **Sau nén** là số thật Cocos đã nén ở lần build trước; dấu ≈ là số ước tính theo preset đang chọn.
- Preset tạo trong **Project Settings → Texture Compress** (bấm ↻ nếu vừa tạo). Preset chưa chọn định dạng nào hiện
  **(chưa cấu hình định dạng)**: không được chọn sẵn, không nén thử, **Bật nén** / **Áp preset** bị khoá.
- Ghi qua asset-db, editor tự import lại. Một ảnh ghi lỗi không chặn các ảnh còn lại. Texture Compress chỉ chạy lúc
  build: dung lượng thật chỉ đổi sau khi build lại.
- Khung Chi tiết có **Nén ảnh này (Texture Compress)**: chọn preset → **Áp preset** / **Tắt nén** cho riêng ảnh đó.
- Phím: ← → ↑ ↓ chuyển ảnh · Space tick · Enter / nháy đúp chọn asset trong panel Assets.

### Âm thanh

- Mỗi dòng: ô tick, nút **▶** nghe ngay (phím **P**; phát file khác, rời bước này hay ẩn panel là dừng), tên + thư mục,
  thời lượng, dung lượng (**Trong build** khi có bản build, xếp nặng nhất trước; file không vào build ghi *không vào
  build* và xếp cuối), **Nhận xét**: chỉ ghi điều nên sửa (chưa MP3, stereo, bitrate cao, dài, trùng tên MP3), không có
  gì thì **ổn**. Stereo / bitrate cao chỉ là cảnh báo khi nén lại thật sự nhỏ đi, không thì chỉ là ghi chú.
- Lọc: **Trong build** (mặc định; chưa có bản build thì **Tất cả**), **Nên xử lý**, **Tất cả**, **Chưa MP3**, **Stereo**,
  **> N kbps** (N = bitrate builder encode lại, không có builder thì 64), **Dài**, **Không vào build**.
- Thẻ kiểu nén (thẻ đang chọn hiện thông số, thẻ khác xem trong tooltip):
  - **Chuẩn playable**: 64 kbps mono, khớp bitrate mặc định playable-ads-builder encode lại khi xuất;
  - **Nhỏ nhất**: 48 kbps mono 32 kHz (thấp hơn bitrate builder thì chỉ nhỏ hơn ở build web-mobile, bản xuất vẫn
    encode lại ở bitrate của builder);
  - **Giữ stereo**: 96 kbps stereo;
  - **Tùy chỉnh**: mở hàng **Bitrate** / **Tần số** / **Mono** / **Ghi đè MP3 trùng tên**.

  Thông số chỉ có **một bộ**: chọn thẻ là điền vào cả hàng Tùy chỉnh lẫn khung **Nén file này** ở khung Chi tiết; sửa ô
  ở bất kỳ chỗ nào thì thẻ thành **Tùy chỉnh**. Nén hàng loạt, **Nghe thử kết quả** và nút áp từng file đều dùng đúng bộ
  này (riêng đoạn cắt là của từng file). Lựa chọn được nhớ theo máy.
- **Nén N file**: file gốc bị **thay thế**, MP3 mới giữ uuid của file gốc nên scene / prefab không phải sửa; bản gốc
  được chép dự phòng (xem **Lịch sử**). MP3 nén lại (không cắt) mà không nhỏ hơn thì giữ nguyên file. Hộp xác nhận
  nhắc khi có file không vào build đang được tick.
- **Ghi đè MP3 trùng tên** (bật sẵn): chỉ có tác dụng khi đổi đuôi (wav → mp3) mà cạnh đó đã có MP3 cùng tên là asset
  khác. MP3 cũ bị xoá, reference tới nó sẽ hỏng; các dòng này được tô cảnh báo. Bỏ tick thì **Nén N file** bỏ qua các
  file đó. Nút áp từng file ở khung Chi tiết không theo ô này: gặp trùng tên thì luôn hỏi lại trước khi ghi đè.

**Khung Chi tiết: nghe, cắt rồi mới áp**
- Waveform + thanh tiến trình: bấm / kéo để tua; Space phát / dừng, ← → tua 0,1 s (Shift: 1 s), Home / End về đầu /
  cuối. Nghe **Gốc** hoặc **Kết quả** (bản encode thử); **Chỉ đoạn giữ** phát đúng đoạn sẽ giữ lại kèm fade.
- Cắt: kéo hai mốc vàng, gõ giây vào **Đầu** / **Cuối**, hoặc nhấn **[** / **]** khi đang nghe (**I** / **O** khi bộ gõ
  Telex biến [ ] thành ơ ư). **Fade in** / **Fade out** (ms): cắt ngang lúc còn tiếng thì nên có vài chục ms fade out.
- **Nén file này**: các ô là bộ thông số chung ở trên (cạnh tiêu đề ghi tên thẻ đang dùng). MP3 nguồn có bitrate thấp
  hơn mức đang chọn thì có dòng nhắc: nén lên cao hơn không hay hơn mà còn không nhỏ đi.
- **Nghe thử kết quả**: encode đúng thông số (kể cả đoạn cắt) vào `temp/playable-size-inspector/audio-preview/`, nghe và
  xem dung lượng trước → sau, chưa đụng tới `assets/`. Nút áp (**Chuyển sang MP3** / **Nén lại** / **Cắt + chuyển MP3** /
  **Cắt + nén lại**) ghi file thật, trùng byte với bản thử. Sửa thông số sau khi nghe thử thì phải nghe thử lại.

Phím: ↑ ↓ chuyển dòng · Space tick · P nghe nhanh · Enter / nháy đúp chọn asset trong panel Assets.

### Model 3D

Model nguồn (`.fbx`, `.gltf`, `.glb`) với các ô **Mesh Compress / Mesh Simplify** của Inspector → Model. Tên ô và tên
preset giữ tiếng Anh như Inspector.

Cách dùng: lọc **Trong build** → **Tick hết** hoặc tick từng model → chọn thẻ preset ở thanh trên (form ở khung Chi tiết
được điền sẵn, xem trước thấy ngay) → **Apply (N)** → chờ editor import xong → build lại.

- Lọc: **Trong build** (mặc định; chưa có bản build thì **Tất cả**), **Nên xử lý** (trong build mà chưa nén mesh, hoặc
  từ 3.000 tam giác mà chưa giảm, hoặc import lỗi), **Chưa nén**, **≥ 3.000 tam giác**, **Tất cả**. Model đang tick
  luôn hiện dù bộ lọc ẩn nó.
- Thẻ preset:
  - **Recommended**: Quantize + Encode, tắt Compress; Mesh Simplify riêng theo số tam giác cho model nặng (≥ 8.000 giữ
    0.3, ≥ 4.500 giữ 0.5, ≥ 3.000 giữ 0.7; ô Target Ratio hiện _tự động_), model nhẹ giữ nguyên. Sửa tay Mesh Simplify
    (tick / Target Ratio) là thôi mức riêng này;
  - **Compress only**: Quantize + Encode, không đụng Mesh Simplify;
  - **Quantize only**: chỉ Quantize, không cần meshopt, không đụng Mesh Simplify.

  Sửa tay form thì thẻ thành **Tùy chỉnh**. Đổi tập model đang tick thì thẻ preset được điền lại cho tập mới, còn bản
  sửa tay (Tùy chỉnh) bị bỏ.
- Mỗi dòng: số tam giác (tô vàng khi nhiều mà chưa giảm), scene / prefab kéo vào build, **≈ X sau zip**, trạng thái
  (**Quantize + Encode**, **Chưa nén**, **Giảm còn 30%**, **Màu đỉnh**, **Import lỗi**...). Rê chuột lên tên model để
  xem vì sao nó nằm trong Nên xử lý.

**Khung Chi tiết**: tên model → **Xem trước · Mesh Simplify** → form **Import Settings** (nút **Revert** / **Apply**) →
**Gợi ý**, **Số liệu**, **Được kéo vào build bởi**, **File trong build**, **Chọn trong Assets**.
- Form áp cho các model đang tick; chưa tick gì thì sửa ô nào là model đang chọn được tick luôn (Revert / Apply xong thì
  bỏ tick đó). Ô nào các model đang khác nhau thì checkbox gạch ngang, ô số hiện —: không sửa thì mỗi model giữ giá trị
  riêng, chỉ ô đã sửa mới được ghi.
- Sửa Target Ratio là tự bật Mesh Simplify; bật Mesh Simplify khi Target Ratio đang 1 thì đặt mức gợi ý; tick Quantize /
  Encode / Compress là bật luôn Mesh Compress. Error Rate chỉ sửa được khi tắt Auto Error Rate.
- **Apply** hỏi lại (liệt kê từng ô sẽ ghi) rồi ghi vào `.meta` qua asset-db, editor tự import lại; cả lượt là một mục
  Lịch sử (phải bật meshopt thì có thêm một mục **Bật meshopt** riêng). **Revert** bỏ các ô vừa sửa.

**Ba ô Mesh Compress**:
- **Quantize**: lưu đỉnh bằng định dạng ít bit hơn, GPU đọc thẳng, mesh nhỏ khoảng một nửa.
- **Encode**: mã hoá meshoptimizer để zip nén rất tốt (thường nhỏ 3–5 lần sau zip). Lúc load phải giải mã nên cần module
  **meshopt** (~5 KB). meshopt bị ẩn trong Feature Cropping và mặc định tắt: có model Encode mà meshopt tắt thì build lỗi
  **16352** (`decodeVertexBuffer is not a function`) và các model đó không hiện. Tool tự bật meshopt mỗi khi Apply có
  Encode; ô **Meshopt Module** (nhãn _dự án_) trong form bật / tắt nó ngay (ghi thẳng Project Settings, không chờ Apply,
  có mục Lịch sử riêng; tắt khi còn model Encode thì hỏi lại). Thiếu meshopt thì tab này và thẻ **Thiết lập còn thiếu**
  có nút **Bật meshopt**.
- **Compress** (zlib): thừa với playable vì bản xuất đã zip toàn bộ, còn tốn thời gian load; các preset đều tắt nó.

**Màu đỉnh và Import lỗi**: Quantize của Cocos 3.8 lỗi với mesh có màu đỉnh (vertex color): import sập
`Aborted(native code called abort())` và mesh đó không vào build. Tool nhận ra màu đỉnh từ file model, gắn badge
**Màu đỉnh** và khi Apply thì tự **bỏ Quantize cho riêng các model đó** (ghi rõ trong hộp xác nhận); Encode và Mesh
Simplify vẫn dùng, và với các model này Encode được tính là đã nén. Mesh Cocos import lỗi hiện badge **Import lỗi**, luôn
nằm trong Nên xử lý, có cảnh báo đỏ ở đầu tab.

**Xem trước · Mesh Simplify**: canvas chia đôi, trái là model gốc (_Original_), phải là bản giảm tam giác theo đúng
thiết lập sẽ có hiệu lực nếu bấm Apply (Mesh Simplify đang tắt thì xem theo Target Ratio đã đặt hoặc mức gợi ý, nhãn ghi
_đang tắt_); cập nhật ngay khi kéo Target Ratio. **Wireframe** để thấy tam giác giảm ra sao; **Texture** dán ảnh cùng tên
model (không nạp được thì dòng trạng thái dưới khung ghi lỗi). Kéo để xoay, chuột phải / Shift + kéo để dời, lăn để
zoom, nháy đúp để đặt lại. Tool giảm tam giác bằng chính meshoptimizer của editor trên dữ liệu gốc của model, nên rất sát
kết quả import nhưng không đảm bảo trùng từng tam giác.

Phím: ↑ ↓ chuyển dòng · Space tick · nháy đúp chọn model trong panel Assets.

### Module engine

Module tuỳ chọn của **Project Settings → Feature Cropping** mà tool nhận biết được: Post Process, Animation Graph,
Physics 2D / 3D, Spine, DragonBones, Particle 2D / 3D, Video, WebView, Tiled Map, Terrain, Rich Text, Profiler,
Intersection 2D, Primitive, Mask, Skeletal Animation. Module nền (2D, 3D, UI, Audio...) đổi trong Feature Cropping
(nút **Mở Feature Cropping**). Bỏ tick **Hiện cả module đang tắt** để chỉ xem module đang bật (và module đang tắt mà
thấy dùng).

Cách dùng: gạt công tắc module muốn tắt / bật (hoặc bấm **Chọn tắt module không dùng**) → **Áp dụng** → build lại.
Chưa ghi gì cho tới khi bấm Áp dụng; dòng đã đổi ghi *sẽ tắt* / *sẽ bật*, **Bỏ chọn** bỏ các thay đổi chưa áp. Nút **Tắt
trong tool** ở Việc nên làm cũng đưa tới đây với các module đó đã chọn sẵn.

- **Nhận xét**:
  - *không thấy dùng*: không có component trong scene / prefab, script hay file nào dùng tới, tắt được;
  - *đang dùng*: khung Chi tiết liệt kê từng chỗ (vd `PlayScene.scene: cc.BoxCollider`, `script X.ts: PhysicsSystem`);
  - *đang tắt nhưng scene / prefab dùng* (đỏ): component đó có trong bản build, sẽ lỗi khi chạy;
  - *đang tắt · chỉ asset không vào build dùng*: chỉ cần bật nếu đưa asset đó vào build;
  - *đang tắt · script có nhắc tới*: chỉ thấy chữ trong script, có thể là code không chạy tới.
- **X trong build**: phần riêng của module trong bản build (wasm / js của Spine, Box2D, Ammo...); Post Process là phần
  ước tính của các effect post-process trong pack internal (dấu ≈). Profiler, Intersection 2D, Primitive, Mask, Skeletal
  Animation hiện **≈ X mã engine** (phần mã engine bỏ được, byte sau zip đo trên engine 3.8.8). Để trống là chưa đo được
  trước: build lại sau khi tắt để biết giảm bao nhiêu.
- Module mà module khác đang bật cần tới thì không tắt được; Post Process chỉ bật được khi Render Pipeline là
  custom-pipeline.

Tool ghi đúng như Feature Cropping ghi (chỉ đổi phần module trong `engine.json`, các dòng khác giữ nguyên). Đang mở
Project Settings thì nên đóng lại để nó không ghi đè. Mã engine chỉ đổi sau khi build lại.

Phím: ↑ ↓ chuyển dòng · Space gạt công tắc.

## Lịch sử và hoàn tác

Nút **Lịch sử** trên cùng liệt kê các thay đổi tool đã ghi (50 lần gần nhất, lưu ở
`temp/playable-size-inspector/history.json`, không vào git), mỗi lần một nút **Hoàn tác**.

- **Ảnh / Model 3D**: lưu thiết lập trước / sau của từng asset; hoàn tác ghi lại thiết lập cũ vào `.meta` (editor import
  lại).
- **Âm thanh**: bản gốc (kèm `.meta`) được chép vào `temp/playable-size-inspector/audio-backup/<thời điểm>/`; hoàn tác chép
  ngược lại, đổi đuôi thì xoá MP3 mới và trả lại cả MP3 trùng tên đã bị ghi đè. Cuối cửa sổ Lịch sử ghi bản dự phòng
  chiếm bao nhiêu, kèm nút **Dọn bản cũ (giữ 5 lần gần nhất)** (còn ≤ 5 lần thì là **Dọn hết bản dự phòng**). Lần nào
  mất bản dự phòng thì hiện **Hết bản dự phòng** thay cho nút Hoàn tác.
- **Module engine** (kể cả **Bật meshopt** / **Tắt meshopt**): lưu cả cấu hình module trước / sau; hoàn tác trả về cấu
  hình cũ. Hoàn tác **Bật meshopt** khi còn model bật Encode thì cảnh báo trước (build sẽ lỗi 16352).
- Asset hay Feature Cropping đã bị đổi tiếp sau lần đó thì tool hỏi lại trước khi ghi đè.
- Một mục chỉ được đánh dấu đã hoàn tác khi khôi phục đủ; khôi phục được một phần (asset bị khoá, thiếu file...) thì mục
  vẫn còn nút Hoàn tác để thử lại.

Thay đổi làm bằng `cli/set-texture-compress.js` không vào Lịch sử.

## Terminal (`cli/`)

Chạy bằng Node.js, không cần mở Cocos, dùng chung logic với panel.

**Tự kiểm tra trên một dự án** (chỉ đọc): chạy toàn bộ phần phân tích (dự án + thiết lập, bản build, bản xuất theo mạng,
ảnh, âm thanh, model 3D, Việc nên làm, kiểm tra chung, module engine, lịch sử) và báo ổn / cảnh báo / lỗi; mã thoát 1 khi
có lỗi. Mọi lệnh ghi vào dự án bị chặn và tính là lỗi, nên chạy được trên dự án của người khác mà không cần chép tool vào
đó. Dòng đầu in phiên bản tool; dự án có bản tool khác trong `extensions/` thì báo để chép đè. Dự án phải được mở trong
Cocos ít nhất một lần (cần `library/`).

```bash
node extensions/playable-size-inspector/cli/selftest.js                    # dự án chứa tool
node extensions/playable-size-inspector/cli/selftest.js D:/Cocos/DuAnKhac  # dự án khác
node cli/selftest.js D:/Cocos/DuAnKhac --build build/web-mobile-001        # chọn bản build
```

`--build <thư mục>`: bản build cần xét (mặc định như panel). `--work-dir <thư mục>`: chỗ đặt file nháp (mặc định
`<dự án>/temp/playable-size-inspector`; selftest không cần). `--allow-write`: tắt chặn ghi (chỉ để gỡ lỗi).

**Bật / tắt Texture Compress hàng loạt** (ghi thẳng `.meta`; sau đó trong Cocos: panel Assets → chuột phải → Refresh):

```bash
node extensions/playable-size-inspector/cli/set-texture-compress.js assets/Sprites --preset SingleHTML
node extensions/playable-size-inspector/cli/set-texture-compress.js assets/Models --preset SingleHTML --force --dry-run
node extensions/playable-size-inspector/cli/set-texture-compress.js assets/Sprites --off
node extensions/playable-size-inspector/cli/set-texture-compress.js --list-presets
node cli/set-texture-compress.js --project D:/Cocos/DuAnKhac assets/UI --dry-run   # tool không nằm trong dự án đó
```

Không truyền `--preset` thì dùng preset đầu tiên đã có định dạng nén. Ảnh đang dùng preset khác bị bỏ qua; `--force` để
thay luôn. `--atlas`: áp cả auto-atlas (`*.pac`). `--off`: tắt nén. `--dry-run`: chỉ liệt kê, không ghi.

## Dùng cho dự án khác / máy khác

- Chép cả thư mục tool vào `extensions/` của dự án (hoặc cài global vào `~/.CocosCreator/extensions/` để mọi dự án dùng
  chung), rồi **Extension Manager → Project (hoặc Global) → bật playable-size-inspector**. Dự án đã có bản cũ thì chép đè
  (giữ `node_modules` nếu có). Tool không gắn cứng đường dẫn, tên dự án hay tên build; đường dẫn có dấu tiếng Việt, dấu
  cách, `#`, Build Path tuỳ chỉnh (lồng sâu hay ngoài dự án) đều chạy.
- **Máy vừa clone dự án**: `profiles/` (build task: Name, mạng đã tick, Build Path) không vào git, nên thẻ Thiết lập báo
  "Máy này chưa có build task web". Tool vẫn đọc cấu hình nén ảnh / audio mà playable-ads-builder lưu trong dự án
  (`settings/v2/packages/playable-ads-builder.json`) nên Việc nên làm vẫn tính đúng phần audio builder encode lại.
- **Công cụ xuất playable**: có **playable-ads-builder** thì đủ mọi phần. Với **playable-ads-adapter**, tool đọc được file
  nó xuất (`<Tên>_<Mạng>.html`, `single-file-3x.html`, thư mục `<Tên>_<Mạng>/` tính theo zip ước tính) nhưng không đọc
  cấu hình nén của adapter và không có **Ước tính từ bản build**. Không có cả hai thì chỉ phân tích thư mục build.
- Sau khi sửa code của tool: **Extension Manager → Project → playable-size-inspector → Reload**.

## Cấu trúc

```
main.js                     # message handler của panel (ghi meta, audio, model, module engine, lịch sử, hoàn tác)
package.json                # menu Tools, danh sách message, "editor": ">=3.6.0"
cli/selftest.js             # tự kiểm tra trên một dự án bất kỳ (chỉ đọc, chặn ghi)
cli/set-texture-compress.js # bật / tắt Texture Compress hàng loạt từ terminal
lib/build-scan.js           # quét bản build, map file build -> asset nguồn theo uuid
lib/build-folders.js        # tìm các bản build web, chọn bản mặc định
lib/build-checks.js         # kiểm tra chung trên bản build (Việc nên làm)
lib/insights.js             # Việc nên làm + dò file assets/ sửa sau lần build
lib/exports.js              # bản xuất theo mạng + cấu hình build task / playable-ads-builder
lib/html-export.js          # đọc file HTML / zip / thư mục đã xuất: từng file chiếm bao nhiêu
lib/html-sim.js, lib/html-sim-worker.js  # Ước tính từ bản build (mô phỏng playable-ads-builder)
lib/texture-compress.js     # preset, quét ảnh, ghi compressSettings
lib/estimate.js, lib/estimate-worker.js  # nén thử ảnh bằng sharp của Editor (tiến trình con)
lib/image-meta.js           # kích thước / alpha từ header ảnh
lib/audio.js                # probe / encode / cắt bằng ffmpeg, thay audio nguồn
lib/model-compress.js       # model 3D: quét, áp Mesh Compress / Simplify, meshopt, luật nên xử lý
lib/mesh-preview.js         # dữ liệu cho xem trước Mesh Simplify (hình học gốc, meshopt_simplify)
lib/engine-modules.js       # module engine: luật nhận biết, bằng chứng, cấu hình bật / tắt
lib/history.js              # lịch sử thay đổi, hoàn tác audio, dọn bản dự phòng
lib/setup-check.js          # Thiết lập còn thiếu
lib/toolchain.js            # tìm ffmpeg / npm, cài ffmpeg-static
lib/compat.js               # bản Creator và tính năng theo bản, extension trong dự án / global, thư mục tạm
lib/write-guard.js          # chặn ghi vào dự án khi chạy selftest
lib/asset-url.js, lib/fs-utils.js
panels/default/
  index.html / index.css / index.js  # khung 3 bước, Tổng quan, Lịch sử, khung Chi tiết dùng chung
  explore-tab.js            # Tìm chỗ nặng (Build web-mobile / HTML cuối)
  texture-tab.js            # Tối ưu → Ảnh
  audio-tab.js              # Tối ưu → Âm thanh
  audio-player.js           # waveform, tua, mốc cắt, fade, nghe Gốc / Kết quả
  model-tab.js              # Tối ưu → Model 3D
  mesh-viewer.js            # canvas WebGL so trước / sau Mesh Simplify
  engine-tab.js             # Tối ưu → Module engine
  preview.js                # xem trước ảnh / audio trong khung Chi tiết
  thumbs.js                 # ảnh thu nhỏ (lưới ảnh, icon danh sách), nạp khi lọt khung nhìn
```

`lib/` không phụ thuộc Editor nên chạy được bằng node thuần; `cli/` dùng lại chính các file này.
