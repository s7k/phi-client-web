# キャラクターグラフィック フォールバック・マッピング

キャラグラPNGが特定名で見つからない場合の**フォールバック**設計と、その根拠となるサーバ/クライアントの定義。マッピング実体: [`backend/data/chara_type_fallback.json`](../backend/data/chara_type_fallback.json)。[08 グラ保管](08-chara-graphics-storage.md)を補完。

## 1. 結論（ユーザー指摘の human / eraser / berserk の正体）

レガシーは**キャラタイプコード**でフォールバックグラを決める。これがユーザーの言う「human, eraser, berserk等の定義」。

- サーバ `phi_dm.h` の `CT_*`(Character Type)列挙が定義元。
- `#m57 O`(キャラ行)の末尾フィールド = `cd[].type`(=このコード)を送出。
- クライアント `Const.cpp` の `SKIP_CHARA_GRA[]`(正しくは `SKIN_CHARA_GRA[]`) が `コード → カテゴリ名` を対応づけ、`Index.txt` が `カテゴリ名 → 既定グラファイル`。

### 根拠コード
- `phi_dm.h:39`
  ```c
  #define CHRGRA(n) (cd[n].cg != NULL ? cd[n].cg
                    : (cd[n].ocg != NULL ? cd[n].ocg
                    : (n < MAX_NTTYS ? "human" : "")))
  ```
  グラ名解決: 明示グラ`cg`(setcg) → 初期グラ`ocg`(init_graphic[vf]) → **プレイヤーは"human"** / モンスターは""(→type別フォールバック)。
- `phi_dm.h` `CT_*` (タイプコード 0–7)。
- `phi_m57.c:444` で `#m57 O … CHRGRA(j) … (j<MAX_NTTYS ? (cg/ocg有? 0x40:0) : cd[j].type)` を送出。
- client `GraCache.cpp` `GetDefaultGraIndex(Default)`: `SKIN_CHARA_GRA[i].No == Default` を検索→既定グラ。未一致は index1(知的生物)。
- client `Const.cpp` `SKIN_CHARA_GRA[]` + skin `chara/Index.txt`。

## 2. 正規マッピング表

| code(hex) | Web key | カテゴリ(ja) | サーバ CT_ | 種別 | 旧Index.txt例 |
|-----------|---------|--------------|-----------|------|----------------|
| 0x00 | `human` | 人・銅像 | (hardcoded "human") | プレイヤー既定/銅像 | LANU_Swordman.bmp |
| 0x01 | `intelligent` | 知的生物 | CT_NORMAL | 既定(未一致時) | LANU_Oyaji.bmp |
| 0x02 | `beast` | 獣 | CT_BEAST | 獣 | LANU_WolfK.bmp |
| 0x03 | `berserk` | 狂戦士 | CT_BERSERKER | 狂戦士 | w_j_rakshasa.bmp |
| 0x04 | `magical` | 魔法生物 | CT_MAGICAL | 魔法生物 | LANU_GolemJ.bmp |
| 0x05 | `undead` | アンデッド | CT_UNDEAD | 不死 | t_skeltonr.bmp |
| 0x06 | `astral` | 精神体 | CT_ASTRAL | 幽霊/精神体 | t_ghost2.bmp |
| 0x07 | `eraser` | イレイザー | CT_ERASER | イレイザー | LANU_Slime.bmp |
| 0x40 | `setcg` | setcg使用キャラ | (player: cg/ocg有) | グラ設定済 | LANU_Swordman.bmp |
| 0x80 | `creature` | 生物 | (object) | オブジェクト:生物 | LANU_Oyaji.bmp |
| 0x81 | `board` | 看板 | (object) | オブジェクト:看板 | Defboardobj.bmp |
| 0x82 | `magic_effect` | 魔法エフェクト | (object) | オブジェクト:魔法 | Defmagicobj.bmp |
| 0x70 | `anim_object` | アニメオブジェ | (object) | オブジェクト:アニメ | LANU_Oyaji.bmp |
| 0x75 | `static_object` | アニメなしオブジェ | (object) | オブジェクト:静止 | Defboardobj.bmp |

- `code` は `#m57 O` 末尾フィールド([07] `map.chars[].default`、map_data.py `CharaData.default`)。
- 旧Index.txt例の bmp 名は**スキン依存の参考値**。Web版は使わない(§4)。

## 3. フォールバック解決順（Web版）

[`chara_type_fallback.json`](../backend/data/chara_type_fallback.json) `fallbackOrder` に準拠:

1. `#m57 O` の `gra_name`(=CHRGRA) で specific PNG を解決（[08] chara_graphics）。
2. 無ければ `code`(末尾type) → `key` → `chara_index[key]` で**カテゴリ既定グラPNG**。
3. `code` 未一致は `key=intelligent`(0x01) を既定（client `GetDefaultGraIndex` 準拠）。
4. それも無ければプレースホルダ（名前頭文字等）。

## 3.5 Web版独自フォールバック割当（本プロジェクト）

**既存クライアントとは別**の割当を採用。フォールバック元BMPは `legacy/graphics/chara/`(gitignore対象) に保管。これらをカラーキー(clTeal)で透過PNG化([06])し、`chara_index[key]` へシードする。

| Web key | カテゴリ(ja) | フォールバックグラ(webFallbackGra) | 備考 |
|---------|--------------|-----------------------------------|------|
| `human` | 人・銅像 | **t_Man** | プレイヤー既定。指定の`t_man`は実ファイル`t_Man.bmp`(大文字M) |
| `intelligent` | 知的生物 | **t_elf** | type未一致時の既定([09]§3手順3) |
| `beast` | 獣 | **t_dog** | |
| `berserk` | 狂戦士 | **t_fightery** | |
| `undead` | アンデッド | **t_ghost1** | 指定の`t_ghost`不在のため`t_ghost1`採用 |
| `eraser` | イレイザー | **tak_Bslime** | |
| `magical` / `astral` / `setcg` / `creature` / `board` / `magic_effect` / `anim_object` / `static_object` | (各) | 未指定(null) | 後日割当。未割当時は手順3で`intelligent`(t_elf)へ |

- 出典: ユーザー指定。`§2`の旧Index.txt例(LANU_*等)とは**異なる**(Web版は上記で上書き)。
- 元BMP寸法確認済: t_elf/t_dog/tak_Bslime/t_fightery いずれも 96×160。
- マッピング実体: [`chara_type_fallback.json`](../backend/data/chara_type_fallback.json) `webFallbackGra` / `webFallbackSource`。

### セットアップ手順(想定)
1. `legacy/graphics/chara/{t_Man,t_elf,t_dog,tak_Bslime,t_ghost1,t_fightery}.bmp` を透過PNG化([06] `--mode colorkey --key teal --lowercase`)。**`--lowercase`**で `t_Man.bmp→t_man.png` 等に小文字化。
2. アップロード/保存([08] chara_graphics)。`gra_key`=小文字正規化名(`t_man`等)で照合(case-insensitive)。
3. `chara_index` に各 Web key → 対応gra_name をシード(`human→t_Man`(=t_man),`beast→t_dog`,…)。

> グラ解決はcase-insensitive([08] §2)。`webFallbackGra`値(`t_Man`等)は小文字正規化して照合するため、物理PNG(`t_man.png`)と整合。

## 4. [08] との統合（chara_index の category 事前シード）

- [08] の `chara_index(key, gra_name)` を**フォールバック・カテゴリの保管にも流用**。`key` に本マッピングの Web key(`human`/`beast`/`berserk`/…) を採用。
- 初期セットアップで14カテゴリを `chara_index` に事前登録し、各カテゴリの既定グラ(gra_name=アップロード済PNG)を管理者が割当て。
- これにより「カテゴリ → 既定グラPNG」は**Web側でアップロードした透過PNGに紐付く**（旧スキンの bmp 名に依存しない）。
- `chara_type_fallback.json` は **code↔key↔ja の固定対応(不変)**。`chara_index` は **key→実グラ(可変・管理者設定)**。役割分離。

### スキーマ補足
[08] の `chara_index` で表現可能（追加テーブル不要）:
```sql
-- 例: フォールバックカテゴリの既定グラ
INSERT INTO chara_index(key, gra_name, …) VALUES
  ('berserk', '<アップロード済グラ名>', …),
  ('eraser',  '<アップロード済グラ名>', …), … ;
```
- 通常のキャラ別名(原文カテゴリ「狂戦士」等)も併存可。Web keyを正規キーとし、必要なら ja 別名も登録。

## 5. FE 連携（[07] map イベント）

- `map.chars[]` に `default`(code) を含める（[07] §6.2 拡張）。FEはグラ解決で §3 の順序を適用。
- マニフェスト([08] §7.3)に `chara_index`(category→gra) を含め、FEがカテゴリ既定を解決可能に。

## 6. 補足・注意

- `init_graphic[]`(サーバ `phi.dat` の F行, `vf`インデックス)はプレイヤーが登録時に選ぶ初期グラ群。これは**グラ名の供給源**であってカテゴリ表ではない。Web版で新規キャラ作成([05] §14)を実装する際の選択肢として別途取り込む（要 phi.dat F行調査。今回のサンプル phi.dat には F行なし）。
- 同梱サンプル `phi.dat` は :I(アイテム)/:M(魔法) のみ。`Berserker`/`Eraser` の :M 行は**魔法名**であり、本マッピングの CT_BERSERKER/CT_ERASER(キャラタイプ)とは別物。混同しないこと。
- 本マッピングは server CT_ 列挙と client SKIN_CHARA_GRA に基づき**安定**。サーバ改修で CT_ が増えた場合のみ追従。
